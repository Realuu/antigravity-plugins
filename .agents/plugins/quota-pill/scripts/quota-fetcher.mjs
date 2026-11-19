import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import https from 'node:https';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const IS_WIN = process.platform === 'win32';
const IS_LINUX = process.platform === 'linux';
const CACHE_TTL_MS = 20_000;
const LOCAL_SCAN_TTL_MS = 30_000;
const BRIDGE_PORT = 45790;

let cachedConnection = null;
let cachedRawStatus = null;
let cachedRawStatusAt = 0;
let cachedQuotaSummary = null;
let cachedQuotaSummaryAt = 0;
let cachedLocalStats = null;
let cachedLocalStatsAt = 0;

/**
 * 获取所有可能的语言服务器日志路径（同时兼容 Windows 与 WSL Linux 环境）
 */
function getCandidateLogPaths() {
  const paths = [];
  const home = os.homedir();

  if (IS_WIN) {
    paths.push(path.join(home, 'AppData', 'Roaming', 'Antigravity', 'logs', 'language_server.log'));
  } else if (IS_LINUX) {
    paths.push(path.join(home, '.gemini', 'antigravity', 'logs', 'language_server.log'));
    try {
      const mntUsers = '/mnt/c/Users';
      if (fs.existsSync(mntUsers)) {
        for (const entry of fs.readdirSync(mntUsers, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue;
          if (['Public', 'Default', 'Default User', 'All Users'].includes(entry.name)) continue;
          const winLog = path.join(
            mntUsers,
            entry.name,
            'AppData',
            'Roaming',
            'Antigravity',
            'logs',
            'language_server.log'
          );
          if (fs.existsSync(winLog)) {
            paths.push(winLog);
          }
        }
      }
    } catch {}
  }

  return paths;
}

/**
 * 获取所有可能的 Antigravity Brain 目录（支持本地与 WSL 双环境）
 */
export function getBrainDirs() {
  const home = os.homedir();
  const candidates = [
    path.join(home, '.gemini', 'antigravity', 'brain'),
    path.join(home, '.gemini', 'antigravity-ide', 'brain'),
    path.join(home, '.gemini', 'antigravity-cli', 'brain'),
  ];

  if (IS_WIN) {
    try {
      const wslStatePath = path.join(home, 'AppData', 'Roaming', 'Antigravity', 'wsl_state.json');
      if (fs.existsSync(wslStatePath)) {
        const parsed = JSON.parse(fs.readFileSync(wslStatePath, 'utf8'));
        const distro = String(parsed?.distro || '').trim();
        if (distro) {
          const uncHomeRoot = `\\\\wsl.localhost\\${distro}\\home`;
          if (fs.existsSync(uncHomeRoot)) {
            for (const u of fs.readdirSync(uncHomeRoot, { withFileTypes: true })) {
              if (u.isDirectory()) {
                candidates.push(path.join(uncHomeRoot, u.name, '.gemini', 'antigravity', 'brain'));
              }
            }
          }
        }
      }
    } catch {}
  }

  return candidates.filter((dir) => {
    try {
      return fs.existsSync(dir) && fs.statSync(dir).isDirectory();
    } catch {
      return false;
    }
  });
}

/**
 * 扫描最近 7 天及最近 5 小时本地 transcript.jsonl 真实 Token 消耗（带 30s 缓存）
 */
export function scanRecentLocalTokens(force = false) {
  const now = Date.now();
  if (!force && cachedLocalStats && now - cachedLocalStatsAt < LOCAL_SCAN_TTL_MS) {
    return cachedLocalStats;
  }

  const fiveHoursAgo = now - 5 * 3600 * 1000;
  const sevenDaysAgo = now - 7 * 24 * 3600 * 1000;

  let tokens5h = 0;
  let tokens7d = 0;
  let turns5h = 0;
  let turns7d = 0;

  for (const brainDir of getBrainDirs()) {
    let entries = [];
    try {
      entries = fs.readdirSync(brainDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const tPath = path.join(brainDir, entry.name, '.system_generated', 'logs', 'transcript.jsonl');
      let stat;
      try {
        stat = fs.statSync(tPath);
      } catch {
        continue;
      }
      if (stat.mtimeMs < sevenDaysAgo) continue;

      let content = '';
      try {
        content = fs.readFileSync(tPath, 'utf8');
      } catch {
        continue;
      }

      const lines = content.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;
        let step;
        try {
          step = JSON.parse(line);
        } catch {
          continue;
        }
        const ts = step.created_at ? Date.parse(step.created_at) : stat.mtimeMs;
        if (!Number.isFinite(ts) || ts < sevenDaysAgo) continue;

        if (step.type === 'USER_INPUT') {
          turns7d++;
          if (ts >= fiveHoursAgo) turns5h++;
        } else if (step.type === 'PLANNER_RESPONSE') {
          const inp = Number(step.input_tokens) || 0;
          const out = Number(step.output_tokens) || 0;
          const cache = Number(step.cache_read_tokens) || 0;
          const stepTotal = inp + out + cache;
          if (stepTotal > 0) {
            tokens7d += inp + out;
            if (ts >= fiveHoursAgo) tokens5h += inp + out;
          }
        }
      }
    }
  }

  cachedLocalStats = {
    tokens5h,
    tokens7d,
    turns5h,
    turns7d,
    scannedAt: new Date(now).toISOString(),
  };
  cachedLocalStatsAt = now;
  return cachedLocalStats;
}

/**
 * 从 language_server.log 解析候选 HTTP / HTTPS 端口列表（最新 HTTP 优先）
 */
function readCandidateEndpointsFromLog() {
  const httpList = [];
  const httpsList = [];
  for (const logPath of getCandidateLogPaths()) {
    try {
      if (!fs.existsSync(logPath)) continue;
      const text = fs.readFileSync(logPath, 'utf8');
      const regex = /listening on \w+ port at (\d+) for (HTTPS?)\b/gi;
      let match;
      while ((match = regex.exec(text)) !== null) {
        const port = Number(match[1]);
        const proto = String(match[2] || 'HTTP').toLowerCase();
        if (port > 0) {
          if (proto === 'https') {
            httpsList.push({ proto: 'https', host: '127.0.0.1', port });
          } else {
            httpList.push({ proto: 'http', host: '127.0.0.1', port });
          }
        }
      }
    } catch {}
  }

  const combined = [...httpList.reverse(), ...httpsList.reverse()];
  const seen = new Set();
  const deduped = [];
  for (const ep of combined) {
    const key = `${ep.proto}:${ep.port}`;
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(ep);
    }
  }
  return deduped;
}

function parseCmdLineInfo(pid, cmd) {
  const text = String(cmd || '');
  const tokenMatch = text.match(/--csrf_token(?:=|\s+)([^\s"'\0]+)/);
  if (!tokenMatch || !tokenMatch[1]) return null;
  const httpsMatch = text.match(/--https_server_port(?:=|\s+)(\d+)/);
  const httpMatch = text.match(/--(?:extension_server_port|server_port|http_port)(?:=|\s+)(\d+)/);
  return {
    pid: Number(pid) || 0,
    token: tokenMatch[1],
    httpsPort: httpsMatch ? Number(httpsMatch[1]) : 0,
    httpPort: httpMatch ? Number(httpMatch[1]) : 0,
    listenPorts: [],
  };
}

/**
 * 在 Linux / WSL 下通过 /proc 精确读取指定 PID 监听的本地 TCP 端口（零外部命令依赖）
 */
function readLinuxPidListeningPorts(pid) {
  const ports = [];
  if (!pid || !IS_LINUX) return ports;
  try {
    const fdDir = `/proc/${pid}/fd`;
    if (!fs.existsSync(fdDir)) return ports;
    const inodes = new Set();
    for (const fdName of fs.readdirSync(fdDir)) {
      try {
        const target = fs.readlinkSync(path.join(fdDir, fdName));
        const m = /^socket:\[(\d+)\]$/.exec(target);
        if (m) inodes.add(m[1]);
      } catch {}
    }
    if (inodes.size === 0) return ports;

    for (const netFile of ['/proc/net/tcp', '/proc/net/tcp6']) {
      try {
        if (!fs.existsSync(netFile)) continue;
        const lines = fs.readFileSync(netFile, 'utf8').split(/\r?\n/);
        for (let i = 1; i < lines.length; i++) {
          const cols = lines[i].trim().split(/\s+/);
          if (cols.length < 10) continue;
          const state = cols[3];
          const inode = cols[9];
          // 0A = TCP_LISTEN
          if (state !== '0A' || !inodes.has(inode)) continue;
          const localParts = cols[1].split(':');
          const hexPort = localParts[localParts.length - 1];
          const port = parseInt(hexPort, 16);
          if (port > 0 && !ports.includes(port)) {
            ports.push(port);
          }
        }
      } catch {}
    }
  } catch {}
  return ports.sort((a, b) => b - a);
}

/**
 * 在 Linux / WSL 下扫描运行中的 language_server 进程（优先纯 /proc 扫描，回退 ps）
 */
function readLinuxLanguageServerProcesses() {
  const results = [];
  try {
    if (fs.existsSync('/proc')) {
      for (const entry of fs.readdirSync('/proc')) {
        if (!/^\d+$/.test(entry)) continue;
        try {
          const raw = fs.readFileSync(`/proc/${entry}/cmdline`, 'utf8');
          if (!raw.includes('language_server') || !raw.includes('--csrf_token')) continue;
          // 跳过外层 sh -c 包装进程，避免重复，或一并去重处理
          const cmd = raw.replace(/\0+/g, ' ').trim();
          const info = parseCmdLineInfo(entry, cmd);
          if (info) {
            info.listenPorts = readLinuxPidListeningPorts(info.pid);
            results.push(info);
          }
        } catch {}
      }
    }
  } catch {}

  if (results.length === 0) {
    try {
      const out = execFileSync('ps', ['-eo', 'pid,args'], {
        encoding: 'utf8',
        timeout: 4000,
      });
      for (const line of out.split(/\r?\n/)) {
        if (!line.includes('language_server') || !line.includes('--csrf_token')) continue;
        const m = /^\s*(\d+)\s+(.*)$/.exec(line);
        if (!m) continue;
        const info = parseCmdLineInfo(m[1], m[2]);
        if (info) {
          info.listenPorts = readLinuxPidListeningPorts(info.pid);
          results.push(info);
        }
      }
    } catch {}
  }

  // 让真正持有监听 socket 的进程排在最前
  results.sort((a, b) => b.listenPorts.length - a.listenPorts.length);
  return results;
}

/**
 * 在 Windows 下查询运行中的 language_server.exe 或 WSL 模式下的 wsl.exe 宿主进程
 */
function readWindowsLanguageServerProcesses() {
  const results = [];
  try {
    const psScript =
      "Get-CimInstance Win32_Process -Filter \"Name = 'language_server.exe' OR Name = 'wsl.exe'\" | Select-Object ProcessId, Name, CommandLine | ConvertTo-Json -Compress";
    const out = execFileSync('powershell', ['-NoProfile', '-Command', psScript], {
      encoding: 'utf8',
      timeout: 5000,
    }).trim();
    if (out) {
      const parsed = JSON.parse(out);
      const list = Array.isArray(parsed) ? parsed : [parsed];
      for (const item of list) {
        const cmd = String(item?.CommandLine || '');
        if (!cmd.includes('--csrf_token')) continue;
        const info = parseCmdLineInfo(item.ProcessId, cmd);
        if (info) results.push(info);
      }
    }
  } catch {}

  if (results.length === 0) {
    try {
      const wslStatePath = path.join(os.homedir(), 'AppData', 'Roaming', 'Antigravity', 'wsl_state.json');
      const wslExe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'wsl.exe');
      if (fs.existsSync(wslStatePath) && fs.existsSync(wslExe)) {
        const distro = String(JSON.parse(fs.readFileSync(wslStatePath, 'utf8'))?.distro || '').trim();
        if (distro) {
          const out = execFileSync(wslExe, ['-d', distro, '--exec', 'ps', '-eo', 'pid,args'], {
            encoding: 'utf8',
            timeout: 4000,
          });
          for (const line of out.split(/\r?\n/)) {
            if (!line.includes('language_server') || !line.includes('--csrf_token')) continue;
            const m = /^\s*(\d+)\s+(.*)$/.exec(line);
            if (!m) continue;
            const info = parseCmdLineInfo(m[1], m[2]);
            if (info) results.push(info);
          }
        }
      }
    } catch {}
  }

  return results;
}

function readRunningLanguageServerProcesses() {
  if (IS_LINUX) return readLinuxLanguageServerProcesses();
  if (IS_WIN) return readWindowsLanguageServerProcesses();
  return [];
}

/**
 * 支持 HTTP 与本地自签 HTTPS (127.0.0.1) 的 Connect RPC 请求
 */
function requestLsRpc(endpoint, token, methodPath, bodyObj, timeoutMs) {
  return new Promise((resolve) => {
    const proto = endpoint.proto === 'https' ? 'https' : 'http';
    const host = endpoint.host || '127.0.0.1';
    const port = Number(endpoint.port);
    if (!port || !token) {
      resolve(null);
      return;
    }

    const payload = JSON.stringify(bodyObj || {});
    const lib = proto === 'https' ? https : http;
    const req = lib.request(
      {
        hostname: host,
        port,
        path: methodPath,
        method: 'POST',
        rejectUnauthorized: false,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          'X-Codeium-Csrf-Token': token,
          'Connect-Protocol-Version': '1',
        },
        timeout: timeoutMs,
      },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          resolve(null);
          return;
        }
        const chunks = [];
        res.on('data', (d) => chunks.push(d));
        res.on('end', () => {
          try {
            const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            resolve(parsed && typeof parsed === 'object' ? parsed : null);
          } catch {
            resolve(null);
          }
        });
      }
    );

    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
    req.on('error', () => {
      resolve(null);
    });
    req.write(payload);
    req.end();
  });
}

function probeGetUserStatus(endpoint, token) {
  return requestLsRpc(
    endpoint,
    token,
    '/exa.language_server_pb.LanguageServerService/GetUserStatus',
    {
      metadata: {
        ideName: 'antigravity',
        extensionName: 'antigravity',
        locale: 'en',
      },
    },
    2500
  );
}

function probeRetrieveUserQuotaSummary(endpoint, token, forceRefresh = false) {
  return requestLsRpc(
    endpoint,
    token,
    '/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary',
    forceRefresh ? { forceRefresh: true } : {},
    forceRefresh ? 4000 : 2500
  );
}

function parseEnvAddress(rawAddr) {
  const s = String(rawAddr || '').trim();
  if (!s) return null;
  if (s.startsWith('http://') || s.startsWith('https://')) {
    try {
      const u = new URL(s);
      return {
        proto: u.protocol === 'https:' ? 'https' : 'http',
        host: u.hostname || '127.0.0.1',
        port: Number(u.port),
      };
    } catch {
      return null;
    }
  }
  const parts = s.split(':');
  const port = Number(parts[parts.length - 1]);
  const host = parts.slice(0, -1).join(':') || '127.0.0.1';
  return port > 0 ? { proto: 'http', host, port } : null;
}

/**
 * 自动发现并验证可用的 language_server 连接（兼容 Windows 本地与 WSL Linux 内部）
 */
export async function discoverLanguageServer(force = false) {
  if (!force && cachedConnection) {
    return cachedConnection;
  }

  if (process.env.ANTIGRAVITY_LS_ADDRESS && process.env.ANTIGRAVITY_CSRF_TOKEN) {
    const ep = parseEnvAddress(process.env.ANTIGRAVITY_LS_ADDRESS);
    if (ep) {
      const altEp = { ...ep, proto: ep.proto === 'http' ? 'https' : 'http' };
      const data =
        (await probeGetUserStatus(ep, process.env.ANTIGRAVITY_CSRF_TOKEN)) ||
        (await probeGetUserStatus(altEp, process.env.ANTIGRAVITY_CSRF_TOKEN));
      if (data) {
        cachedConnection = {
          endpoint: ep,
          token: process.env.ANTIGRAVITY_CSRF_TOKEN,
          pid: 0,
        };
        cachedRawStatus = data;
        cachedRawStatusAt = Date.now();
        return cachedConnection;
      }
    }
  }

  const logEndpoints = readCandidateEndpointsFromLog();
  const procs = readRunningLanguageServerProcesses();

  const candidateEndpoints = [];
  // Linux 下 /proc/<pid>/fd 精确拿到的监听端口最可靠，优先放入（同时测 HTTP 与 HTTPS）
  for (const p of procs) {
    for (const lp of p.listenPorts || []) {
      candidateEndpoints.push({ proto: 'http', host: '127.0.0.1', port: lp });
      candidateEndpoints.push({ proto: 'https', host: '127.0.0.1', port: lp });
    }
    if (p.httpPort > 0) {
      candidateEndpoints.push({ proto: 'http', host: '127.0.0.1', port: p.httpPort });
    }
    if (p.httpsPort > 0) {
      candidateEndpoints.push({ proto: 'https', host: '127.0.0.1', port: p.httpsPort });
    }
  }
  candidateEndpoints.push(...logEndpoints);

  const seen = new Set();
  const uniqueEndpoints = [];
  for (const ep of candidateEndpoints) {
    const key = `${ep.proto}:${ep.port}`;
    if (ep.port > 0 && !seen.has(key)) {
      seen.add(key);
      uniqueEndpoints.push(ep);
    }
  }

  for (const proc of procs) {
    for (const ep of uniqueEndpoints) {
      const data = await probeGetUserStatus(ep, proc.token);
      if (data) {
        cachedConnection = { endpoint: ep, token: proc.token, pid: proc.pid };
        cachedRawStatus = data;
        cachedRawStatusAt = Date.now();
        return cachedConnection;
      }
    }
  }

  cachedConnection = null;
  return null;
}

/**
 * 拉取原始 GetUserStatus 响应
 */
export async function fetchRawUserStatus(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && cachedRawStatus && now - cachedRawStatusAt < CACHE_TTL_MS) {
    return cachedRawStatus;
  }

  if (cachedConnection) {
    const data = await probeGetUserStatus(cachedConnection.endpoint, cachedConnection.token);
    if (data) {
      cachedRawStatus = data;
      cachedRawStatusAt = now;
      return data;
    }
    cachedConnection = null;
  }

  const conn = await discoverLanguageServer(true);
  if (!conn) return null;
  if (cachedRawStatus && Date.now() - cachedRawStatusAt < 3000) {
    return cachedRawStatus;
  }
  const data = await probeGetUserStatus(conn.endpoint, conn.token);
  if (data) {
    cachedRawStatus = data;
    cachedRawStatusAt = Date.now();
  }
  return data;
}

/**
 * 拉取原生 RetrieveUserQuotaSummary 响应（含各模型组的 5 小时与周限额明细）
 */
export async function fetchRawQuotaSummary(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && cachedQuotaSummary && now - cachedQuotaSummaryAt < CACHE_TTL_MS) {
    return cachedQuotaSummary;
  }

  if (cachedConnection) {
    const data = await probeRetrieveUserQuotaSummary(
      cachedConnection.endpoint,
      cachedConnection.token,
      forceRefresh
    );
    if (data) {
      cachedQuotaSummary = data;
      cachedQuotaSummaryAt = Date.now();
      return data;
    }
    cachedConnection = null;
  }

  const conn = await discoverLanguageServer(true);
  if (!conn) return null;
  const data = await probeRetrieveUserQuotaSummary(conn.endpoint, conn.token, forceRefresh);
  if (data) {
    cachedQuotaSummary = data;
    cachedQuotaSummaryAt = Date.now();
  }
  return data;
}

/**
 * 当在 WSL 沙盒或无进程权限环境直接连不上 language_server 时，尝试向 Windows 主进程 45790 桥接请求
 */
async function tryFetchFromHostBridge(forceRefresh = false) {
  if (String(process.env.AGY_QUOTA_DISABLE_BRIDGE_FALLBACK || '') === '1') {
    return null;
  }
  try {
    const url = `http://127.0.0.1:${BRIDGE_PORT}/api/quota${forceRefresh ? '?refresh=1' : ''}`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(2000) });
    if (!resp.ok) return null;
    const data = await resp.json();
    if (data && data.ok) {
      return data;
    }
  } catch {}
  return null;
}

/**
 * 格式化中文倒计时文案
 */
export function formatResetCountdown(resetTimeIso) {
  if (!resetTimeIso) return { text: '', remainingSec: null, isLongCooldown: false };
  const targetMs = typeof resetTimeIso === 'number' ? resetTimeIso : Date.parse(resetTimeIso);
  if (!Number.isFinite(targetMs)) return { text: '', remainingSec: null, isLongCooldown: false };

  const diffMs = targetMs - Date.now();
  if (diffMs <= 0) {
    return { text: '即将刷新', remainingSec: 0, isLongCooldown: false };
  }

  const totalSec = Math.ceil(diffMs / 1000);
  const totalMin = Math.ceil(diffMs / 60_000);
  const days = Math.floor(totalMin / (24 * 60));
  const hours = Math.floor((totalMin % (24 * 60)) / 60);
  const mins = totalMin % 60;
  const isLongCooldown = diffMs > 6 * 3600 * 1000;

  let text = '';
  if (days > 0) {
    text = hours > 0 ? `${days}天${hours}小时后重置` : `${days}天后重置`;
  } else if (hours > 0) {
    text = mins > 0 ? `${hours}小时${mins}分后重置` : `${hours}小时后重置`;
  } else {
    text = `${Math.max(1, mins)}分钟后重置`;
  }

  return { text, remainingSec: totalSec, isLongCooldown };
}

function resolvePlanLabel(userStatus) {
  const tierName = String(userStatus?.userTier?.name || '').trim();
  const planName = String(userStatus?.planStatus?.planInfo?.planName || '').trim();
  const teamsTier = String(userStatus?.planStatus?.planInfo?.teamsTier || '').trim();

  const raw = tierName || planName || teamsTier;
  if (!raw) return '套餐内用量';
  if (/ultra/i.test(raw)) return 'Google AI Ultra';
  if (/pro/i.test(raw) && !/free/i.test(raw)) return 'Google AI Pro';
  if (/free/i.test(raw)) return '免费套餐';
  return raw;
}

function classifyModelFamily(label, modelId) {
  const text = `${label || ''} ${modelId || ''}`.toLowerCase();
  if (text.includes('claude') || text.includes('sonnet') || text.includes('opus') || text.includes('haiku')) {
    return { key: 'claude', title: 'Claude 模型池', order: 2 };
  }
  if (text.includes('gpt') || text.includes('o3') || text.includes('o4') || text.includes('oss')) {
    return { key: 'third-party', title: '第三方模型池', order: 3 };
  }
  if (text.includes('flash')) {
    return { key: 'gemini-flash', title: 'Gemini Flash 额度', order: 2 };
  }
  if (text.includes('gemini') || text.includes('pro') || text.includes('orchestrator') || text.includes('carbon') || text.includes('argon') || text.includes('hydrogen')) {
    return { key: 'gemini-pro', title: 'Gemini 额度', order: 1 };
  }
  return { key: `other:${label || modelId}`, title: label || '模型额度', order: 5 };
}

function classifySummaryGroup(displayName, description) {
  const text = `${displayName || ''} ${description || ''}`.toLowerCase();
  if (text.includes('gemini')) {
    return {
      id: 'gemini',
      title: 'Gemini',
      keywords: ['gemini', 'orchestrator', 'carbon', 'argon', 'hydrogen', 'flash'],
      order: 1,
    };
  }
  if (text.includes('claude') || text.includes('gpt') || text.includes('3p')) {
    return {
      id: 'claude-gpt',
      title: 'Claude / GPT',
      keywords: ['claude', 'opus', 'sonnet', 'haiku', 'gpt', 'oss', 'o3', 'o4'],
      order: 2,
    };
  }
  const slug =
    String(displayName || 'model-quota')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'model-quota';
  return {
    id: slug,
    title: displayName || '模型额度',
    keywords: [],
    order: 3,
  };
}

function parseSummaryBucket(b) {
  if (!b || typeof b !== 'object') return null;

  const rawHint = `${b.bucketId || ''} ${b.displayName || ''}`.toLowerCase();
  let windowType = String(b.window || '').trim().toLowerCase();
  let label = String(b.displayName || '').trim() || '额度上限';
  let order = 3;

  if (windowType === '5h' || /5h|five.?hour/.test(rawHint)) {
    windowType = '5h';
    label = '5 小时限额';
    order = 1;
  } else if (windowType === 'weekly' || /week/.test(rawHint)) {
    windowType = 'weekly';
    label = '每周限额';
    order = 2;
  } else if (!windowType) {
    windowType = 'other';
  }

  const resetTime = b.resetTime || '';
  const resetMs = resetTime ? Date.parse(resetTime) : NaN;
  const hasValidFutureReset = Number.isFinite(resetMs) && resetMs > Date.now();

  let fraction;
  if (typeof b.remainingFraction === 'number' && Number.isFinite(b.remainingFraction)) {
    fraction = Math.max(0, Math.min(1, b.remainingFraction));
  } else if (b.disabled === true || hasValidFutureReset) {
    fraction = 0;
  } else {
    return null;
  }

  const pct = Math.round(fraction * 100);
  const cd = fraction < 0.9995 && resetTime ? formatResetCountdown(resetTime) : { text: '' };

  return {
    id: String(b.bucketId || `${windowType}-${order}`),
    window: windowType,
    label,
    order,
    remainingPercent: pct,
    valueText: `剩余 ${pct}%`,
    resetText: cd.text,
    resetTime: resetTime || null,
  };
}

/**
 * 将 RetrieveUserQuotaSummary 原始返回标准化为统一结构（同时包含 groups 与兼容 items）
 */
export function normalizeFromQuotaSummary(summaryResp, localStats) {
  const resp = summaryResp?.response || summaryResp || null;
  if (!resp || typeof resp !== 'object') return null;

  let rawGroups = Array.isArray(resp.groups) ? resp.groups : [];
  if (rawGroups.length === 0 && Array.isArray(resp.buckets) && resp.buckets.length > 0) {
    rawGroups = [
      {
        displayName: '模型额度',
        description: '',
        buckets: resp.buckets,
      },
    ];
  }
  if (rawGroups.length === 0) return null;

  const groups = [];
  for (const g of rawGroups) {
    const rawBuckets = Array.isArray(g?.buckets) ? g.buckets : [];
    const parsedBuckets = rawBuckets
      .map(parseSummaryBucket)
      .filter(Boolean)
      .sort((a, b) => a.order - b.order);
    if (parsedBuckets.length === 0) continue;

    const meta = classifySummaryGroup(g.displayName, g.description);
    const minPct = Math.min(...parsedBuckets.map((x) => x.remainingPercent));

    groups.push({
      id: meta.id,
      title: meta.title,
      order: meta.order,
      keywords: meta.keywords,
      remainingPercent: minPct,
      buckets: parsedBuckets.map(({ order: _order, ...rest }) => rest),
    });
  }

  if (groups.length === 0) return null;
  groups.sort((a, b) => a.order - b.order);

  const items = [];
  for (const g of groups) {
    for (const b of g.buckets) {
      items.push({
        id: `${g.id}:${b.id}`,
        label: groups.length > 1 ? `${g.title} ${b.label}` : b.label,
        remainingPercent: b.remainingPercent,
        valueText: b.valueText,
        resetText: b.resetText,
        resetTime: b.resetTime,
        window: b.window,
        models: g.keywords,
      });
    }
  }

  return {
    ok: true,
    source: 'quota_summary',
    planLabel: '套餐内用量',
    primaryRemainingPercent: groups[0].remainingPercent,
    groups: groups.map(({ order: _order, ...rest }) => rest),
    items,
    localStats: localStats || null,
    updatedAt: new Date().toISOString(),
  };
}

/**
 * 将 GetUserStatus 原始返回标准化为左下角 UI 与浮窗所需结构（兜底兼容）
 */
export function normalizeQuotaStatus(rawResp, localStats) {
  const userStatus = rawResp?.userStatus || rawResp || null;
  if (!userStatus || typeof userStatus !== 'object') {
    const fallbackItems = [
      {
        id: 'local-5h',
        window: '5h',
        label: '近 5 小时消耗',
        remainingPercent: null,
        valueText: `${(localStats?.tokens5h || 0).toLocaleString()} tokens`,
        resetText: `已记录 ${localStats?.turns5h || 0} 轮对话`,
        isFallback: true,
      },
      {
        id: 'local-7d',
        window: 'weekly',
        label: '近 7 天消耗',
        remainingPercent: null,
        valueText: `${(localStats?.tokens7d || 0).toLocaleString()} tokens`,
        resetText: '未连接本地配额服务',
        isFallback: true,
      },
    ];
    return {
      ok: false,
      source: 'local-fallback',
      planLabel: '本地统计',
      primaryRemainingPercent: 100,
      groups: [
        {
          id: 'local-fallback',
          title: '本地统计',
          keywords: [],
          remainingPercent: 100,
          buckets: fallbackItems,
        },
      ],
      items: fallbackItems,
      localStats: localStats || null,
      updatedAt: new Date().toISOString(),
    };
  }

  const planLabel = resolvePlanLabel(userStatus);
  const planStatus = userStatus.planStatus || {};
  const configs = Array.isArray(userStatus?.cascadeModelConfigData?.clientModelConfigs)
    ? userStatus.cascadeModelConfigData.clientModelConfigs
    : [];

  const familyBuckets = new Map();
  for (const cfg of configs) {
    const quotaInfo = cfg?.quotaInfo;
    if (!quotaInfo || typeof quotaInfo !== 'object') continue;

    const resetTime = quotaInfo.resetTime || '';
    const resetMs = resetTime ? Date.parse(resetTime) : NaN;
    const hasValidFutureReset = Number.isFinite(resetMs) && resetMs > Date.now();

    let fraction;
    if (typeof quotaInfo.remainingFraction === 'number') {
      fraction = Math.max(0, Math.min(1, quotaInfo.remainingFraction));
    } else if (quotaInfo.resetTime && hasValidFutureReset) {
      fraction = 0;
    } else {
      continue;
    }

    const modelLabel = String(cfg.label || '');
    const modelId = String(cfg.modelOrAlias?.model || cfg.modelId || '');
    const family = classifyModelFamily(modelLabel, modelId);

    const existing = familyBuckets.get(family.key);
    if (!existing) {
      familyBuckets.set(family.key, {
        key: family.key,
        title: family.title,
        order: family.order,
        fraction,
        resetTime,
        models: modelLabel ? [modelLabel] : [],
      });
    } else {
      if (modelLabel && !existing.models.includes(modelLabel)) {
        existing.models.push(modelLabel);
      }
      if (fraction < existing.fraction) {
        existing.fraction = fraction;
        existing.resetTime = resetTime || existing.resetTime;
      } else if (!existing.resetTime && resetTime) {
        existing.resetTime = resetTime;
      }
    }
  }

  const mergedPools = [];
  for (const b of [...familyBuckets.values()].sort((a, b) => a.order - b.order)) {
    const bucketSig = `${b.fraction.toFixed(4)}|${b.resetTime}`;
    const samePool = mergedPools.find((p) => p.bucketSig === bucketSig);
    if (samePool) {
      samePool.keys.push(b.key);
      for (const m of b.models) {
        if (!samePool.models.includes(m)) samePool.models.push(m);
      }
    } else {
      mergedPools.push({
        bucketSig,
        keys: [b.key],
        title: b.title,
        order: b.order,
        fraction: b.fraction,
        resetTime: b.resetTime,
        models: [...b.models],
      });
    }
  }

  const items = [];
  for (const p of mergedPools) {
    const pct = Math.round(p.fraction * 100);
    const cd = pct < 100 ? formatResetCountdown(p.resetTime) : { text: '', isLongCooldown: false };

    let label = p.title;
    const hasGeminiPro = p.keys.includes('gemini-pro');
    const hasGeminiFlash = p.keys.includes('gemini-flash');
    const hasClaude = p.keys.includes('claude');
    const hasThirdParty = p.keys.includes('third-party');

    if (mergedPools.length === 1) {
      label = cd.isLongCooldown ? '每周限额' : '5 小时用量上限';
    } else if (hasGeminiPro && hasGeminiFlash && !hasClaude) {
      label = cd.isLongCooldown ? 'Gemini 每周限额' : 'Gemini 5 小时用量上限';
    } else if (hasClaude && hasThirdParty && !hasGeminiPro) {
      label = cd.isLongCooldown ? 'Claude / 第三方限额' : 'Claude / 第三方额度';
    } else if (hasGeminiPro && !hasGeminiFlash && !hasClaude) {
      label = cd.isLongCooldown ? 'Gemini Pro 每周限额' : 'Gemini Pro 额度';
    }

    items.push({
      id: p.keys.join('+'),
      label,
      remainingPercent: pct,
      valueText: `剩余 ${pct}%`,
      resetText: cd.text,
      resetTime: p.resetTime || null,
      isLongCooldown: cd.isLongCooldown,
      models: p.models,
    });
  }

  if (typeof planStatus.weeklyQuotaRemainingPercent === 'number') {
    const wpct = Math.max(0, Math.min(100, Math.round(planStatus.weeklyQuotaRemainingPercent)));
    const resetIso = planStatus.weeklyQuotaResetAtUnix
      ? Number(planStatus.weeklyQuotaResetAtUnix) * 1000
      : null;
    const cd = wpct < 100 && resetIso ? formatResetCountdown(resetIso) : { text: '' };
    items.push({
      id: 'weekly-quota',
      label: '每周限额',
      remainingPercent: wpct,
      valueText: `剩余 ${wpct}%`,
      resetText: cd.text,
      resetTime: resetIso ? new Date(resetIso).toISOString() : null,
      models: [],
    });
  }

  if (typeof planStatus.dailyQuotaRemainingPercent === 'number') {
    const dpct = Math.max(0, Math.min(100, Math.round(planStatus.dailyQuotaRemainingPercent)));
    const resetIso = planStatus.dailyQuotaResetAtUnix
      ? Number(planStatus.dailyQuotaResetAtUnix) * 1000
      : null;
    const cd = dpct < 100 && resetIso ? formatResetCountdown(resetIso) : { text: '' };
    items.push({
      id: 'daily-quota',
      label: '每日限额',
      remainingPercent: dpct,
      valueText: `剩余 ${dpct}%`,
      resetText: cd.text,
      resetTime: resetIso ? new Date(resetIso).toISOString() : null,
      models: [],
    });
  }

  if (items.length === 0) {
    const monthly = Number(planStatus?.planInfo?.monthlyPromptCredits || 0);
    const available = Number(planStatus?.availablePromptCredits);
    if (monthly > 0 && Number.isFinite(available)) {
      const pct = Math.max(0, Math.min(100, Math.round((available / monthly) * 100)));
      items.push({
        id: 'prompt-credits',
        label: '月度提示词额度',
        remainingPercent: pct,
        valueText: `剩余 ${pct}%`,
        resetText: `${available.toLocaleString()} / ${monthly.toLocaleString()}`,
        models: [],
      });
    } else {
      items.push({
        id: 'local-5h',
        label: '近 5 小时消耗',
        remainingPercent: 100,
        valueText: `${(localStats?.tokens5h || 0).toLocaleString()} tokens`,
        resetText: `近 7 天 ${(localStats?.tokens7d || 0).toLocaleString()} tokens`,
        models: [],
      });
    }
  }

  const numericPcts = items
    .map((x) => x.remainingPercent)
    .filter((v) => typeof v === 'number' && Number.isFinite(v));
  const primaryRemainingPercent = numericPcts.length > 0 ? numericPcts[0] : 100;

  return {
    ok: true,
    source: 'language_server',
    planLabel,
    primaryRemainingPercent,
    groups: [
      {
        id: 'legacy-status',
        title: '模型额度',
        keywords: [],
        remainingPercent: primaryRemainingPercent,
        buckets: items.map((x) => ({
          id: x.id,
          window: x.isLongCooldown ? 'weekly' : '5h',
          label: x.label,
          remainingPercent: x.remainingPercent,
          valueText: x.valueText,
          resetText: x.resetText,
          resetTime: x.resetTime || null,
        })),
      },
    ],
    items,
    localStats: localStats || null,
    updatedAt: new Date().toISOString(),
  };
}

/**
 * 获取完整标准化配额状态（优先 RetrieveUserQuotaSummary，回退 GetUserStatus / 45790 桥接 / 本地统计）
 */
export async function getQuotaStatus(forceRefresh = false) {
  const localStats = scanRecentLocalTokens(forceRefresh);

  const summaryRaw = await fetchRawQuotaSummary(forceRefresh);
  const normalizedSummary = normalizeFromQuotaSummary(summaryRaw, localStats);
  if (normalizedSummary) {
    return normalizedSummary;
  }

  const raw = await fetchRawUserStatus(forceRefresh);
  if (raw) {
    return normalizeQuotaStatus(raw, localStats);
  }

  const bridgeData = await tryFetchFromHostBridge(forceRefresh);
  if (bridgeData) {
    return bridgeData;
  }

  return normalizeQuotaStatus(null, localStats);
}

// 支持 CLI 直接执行输出 JSON
const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  const force = process.argv.includes('--refresh');
  getQuotaStatus(force).then((res) => {
    console.log(JSON.stringify(res, null, 2));
  });
}
