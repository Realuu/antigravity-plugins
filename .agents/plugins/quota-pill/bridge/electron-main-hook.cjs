"use strict";
/**
 * Antigravity Quota Pill — Electron 主进程桥接钩子 (CommonJS, 兼容 v2.34+ 内存令牌与 Windows/WSL 双模)
 *
 * 作用：
 * 1. 注册 Electron IPC 通道 `quota-pill:get-status`，从本地 Windows 模式或 WSL 模式运行的
 *    `language_server` 获取真实配额：
 *    - 优先直接读取主进程内 `dist/languageServer.js` / `dist/authBootstrap.js` 导出的
 *      `getLsCsrfToken()` / `getActiveLsCsrfToken()` 与 `getLsPort()`，按官方规范经
 *      `https://127.0.0.1:<port>` + `x-codeium-csrf-token` 请求 Connect RPC；
 *    - 兼容旧版客户端的 `spawnargs` / 进程表 / WSL `ps` 兜底扫描；
 *    - 服务不可用时以近 5 小时 / 7 天本地与 WSL `transcript.jsonl` Token 统计兜底；
 * 2. 在 127.0.0.1:45790 挂载轻量本地接口 `/api/quota` 与 `/health`（若被旧独立 sidecar 进程占用则通知其退让）；
 * 3. 监听所有主渲染窗口的 `dom-ready` / `did-finish-load` 事件，自动注入 `sidebar-quota.js`。
 */
const fs = require("fs");
const path = require("path");
const os = require("os");
const http = require("http");
const https = require("https");
const { execFile } = require("child_process");

const FIXED_PORT = 45790;
const HOOK_VERSION = "1.4.0";
const USER_DATA_DIR = path.join(os.homedir(), "AppData", "Roaming", "Antigravity");
const LS_LOG_PATH = path.join(USER_DATA_DIR, "logs", "language_server.log");
const WSL_STATE_PATH = path.join(USER_DATA_DIR, "wsl_state.json");
const WSL_EXE = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "wsl.exe");
const CACHE_TTL_MS = 20000;
const LOCAL_SCAN_TTL_MS = 30000;

let cachedConnection = null;
let cachedRawStatus = null;
let cachedRawStatusAt = 0;
let cachedQuotaSummary = null;
let cachedQuotaSummaryAt = 0;
let cachedLocalStats = null;
let cachedLocalStatsAt = 0;
let inflightPromise = null;
const cachedDistroHomes = new Map();

/**
 * 从 Electron 主进程 require.cache 中零开销提取原生 languageServer / authBootstrap / wsl 模块状态
 */
function readInProcessLanguageServerInfo() {
  let lsMod = null;
  let authMod = null;
  let wslMod = null;
  try {
    const cache = require.cache || {};
    for (const key of Object.keys(cache)) {
      const norm = key.replace(/\\/g, "/");
      if (!lsMod && norm.endsWith("/dist/languageServer.js")) {
        lsMod = cache[key] && cache[key].exports;
      } else if (!authMod && norm.endsWith("/dist/authBootstrap.js")) {
        authMod = cache[key] && cache[key].exports;
      } else if (!wslMod && norm.endsWith("/dist/wsl.js")) {
        wslMod = cache[key] && cache[key].exports;
      }
      if (lsMod && authMod && wslMod) break;
    }
  } catch {}

  let port = 0;
  let token = "";
  let baseUrl = "";
  let pid = 0;
  let activeDistro = "";

  try {
    if (wslMod && typeof wslMod.getActiveWslDistro === "function") {
      activeDistro = String(wslMod.getActiveWslDistro() || "").trim();
    }
  } catch {}

  if (!activeDistro) {
    try {
      if (fs.existsSync(WSL_STATE_PATH)) {
        const parsed = JSON.parse(fs.readFileSync(WSL_STATE_PATH, "utf8"));
        if (parsed && typeof parsed.distro === "string") {
          activeDistro = parsed.distro.trim();
        }
      }
    } catch {}
  }

  // 1. 优先使用 Antigravity v2.34+ 导出的内存认证接口（本地与 WSL 双模通用）
  try {
    if (lsMod) {
      if (typeof lsMod.getLsPort === "function") {
        port = Number(lsMod.getLsPort()) || 0;
      }
      if (typeof lsMod.getLsCsrfToken === "function") {
        token = String(lsMod.getLsCsrfToken() || "").trim();
      }
      if (typeof lsMod.getLsBaseUrl === "function") {
        baseUrl = String(lsMod.getLsBaseUrl() || "").trim();
      }
    }
  } catch {}

  try {
    if (authMod) {
      if (!port && typeof authMod.getActiveLsPort === "function") {
        port = Number(authMod.getActiveLsPort()) || 0;
      }
      if (!token && typeof authMod.getActiveLsCsrfToken === "function") {
        token = String(authMod.getActiveLsCsrfToken() || "").trim();
      }
      if (!baseUrl && typeof authMod.getActiveLsBaseUrl === "function") {
        baseUrl = String(authMod.getActiveLsBaseUrl() || "").trim();
      }
    }
  } catch {}

  // 2. 兼容旧版 Antigravity：从子进程 spawnargs 读取 --csrf_token
  try {
    if (lsMod && typeof lsMod.getLsProcess === "function") {
      const proc = lsMod.getLsProcess();
      if (proc) {
        pid = Number(proc.pid) || 0;
        if (!token) {
          const args = Array.isArray(proc.spawnargs) ? proc.spawnargs : [];
          for (let i = 0; i < args.length; i++) {
            const arg = String(args[i] || "");
            if (arg === "--csrf_token" && args[i + 1]) {
              token = String(args[i + 1]);
              break;
            }
            if (arg.startsWith("--csrf_token=")) {
              token = arg.slice("--csrf_token=".length);
              break;
            }
          }
        }
      }
    }
  } catch {}

  return { port, token, baseUrl, pid, activeDistro };
}

/**
 * 解析指定 WSL 发行版的用户主目录 Windows UNC 路径（如 \\wsl.localhost\Ubuntu\home\real）
 */
function getWslDistroHomeUncDirs(distro) {
  if (!distro || process.platform !== "win32") return [];
  if (cachedDistroHomes.has(distro)) {
    return cachedDistroHomes.get(distro);
  }
  const uncRoots = [`\\\\wsl.localhost\\${distro}`, `\\\\wsl$\\${distro}`];
  const homes = [];
  for (const root of uncRoots) {
    try {
      const homeBase = path.join(root, "home");
      if (fs.existsSync(homeBase)) {
        const entries = fs.readdirSync(homeBase, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory()) {
            homes.push(path.join(homeBase, entry.name));
          }
        }
        if (homes.length > 0) break;
      }
    } catch {}
  }
  if (homes.length > 0) {
    cachedDistroHomes.set(distro, homes);
  }
  return homes;
}

function isConfigExplicitlyDisabled(cfgPath) {
  try {
    if (!fs.existsSync(cfgPath)) return false;
    const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
    return Boolean(
      cfg && cfg.plugins && cfg.plugins["quota-pill"] && cfg.plugins["quota-pill"].enabled === false
    );
  } catch {
    return false;
  }
}

function isPluginEnabled() {
  const winCfg = path.join(os.homedir(), ".gemini", "config", "config.json");
  if (isConfigExplicitlyDisabled(winCfg)) return false;

  const { activeDistro } = readInProcessLanguageServerInfo();
  if (activeDistro) {
    for (const wslHome of getWslDistroHomeUncDirs(activeDistro)) {
      const wslCfg = path.join(wslHome, ".gemini", "config", "config.json");
      if (isConfigExplicitlyDisabled(wslCfg)) return false;
    }
  }
  return true;
}

function getBrainDirs() {
  const home = os.homedir();
  const candidates = [
    path.join(home, ".gemini", "antigravity", "brain"),
    path.join(home, ".gemini", "antigravity-ide", "brain"),
    path.join(home, ".gemini", "antigravity-cli", "brain"),
  ];

  const { activeDistro } = readInProcessLanguageServerInfo();
  if (activeDistro) {
    for (const wslHome of getWslDistroHomeUncDirs(activeDistro)) {
      candidates.push(
        path.join(wslHome, ".gemini", "antigravity", "brain"),
        path.join(wslHome, ".gemini", "antigravity-ide", "brain")
      );
    }
  }

  return candidates.filter((d) => {
    try {
      return fs.existsSync(d) && fs.statSync(d).isDirectory();
    } catch {
      return false;
    }
  });
}

function scanRecentLocalTokens(force) {
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
      const tPath = path.join(brainDir, entry.name, ".system_generated", "logs", "transcript.jsonl");
      let stat;
      try {
        stat = fs.statSync(tPath);
      } catch {
        continue;
      }
      if (stat.mtimeMs < sevenDaysAgo) continue;

      let content = "";
      try {
        content = fs.readFileSync(tPath, "utf8");
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

        if (step.type === "USER_INPUT") {
          turns7d++;
          if (ts >= fiveHoursAgo) turns5h++;
        } else if (step.type === "PLANNER_RESPONSE") {
          const inp = Number(step.input_tokens) || 0;
          const out = Number(step.output_tokens) || 0;
          const cache = Number(step.cache_read_tokens) || 0;
          if (inp + out + cache > 0) {
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
 * 从 language_server.log 解析候选 HTTP / HTTPS 端口列表（最新排最前）
 */
function readCandidateEndpointsFromLog() {
  const httpsEndpoints = [];
  const httpEndpoints = [];
  const logPaths = [LS_LOG_PATH];
  try {
    const electron = require("electron");
    if (electron && electron.app && typeof electron.app.getPath === "function") {
      const appLogPath = path.join(electron.app.getPath("logs"), "language_server.log");
      if (appLogPath && !logPaths.includes(appLogPath)) {
        logPaths.unshift(appLogPath);
      }
    }
  } catch {}

  for (const logFile of logPaths) {
    if (!fs.existsSync(logFile)) continue;
    try {
      const text = fs.readFileSync(logFile, "utf8");
      const regex = /listening on \w+ port at (\d+) for (HTTPS?)\b/gi;
      let match;
      while ((match = regex.exec(text)) !== null) {
        const port = Number(match[1]);
        const proto = String(match[2] || "HTTPS").toLowerCase();
        if (port > 0) {
          if (proto === "https") {
            httpsEndpoints.push({ port, proto: "https", host: "127.0.0.1" });
          } else {
            httpEndpoints.push({ port, proto: "http", host: "127.0.0.1" });
          }
        }
      }
    } catch {}
  }

  const combined = [...httpsEndpoints.reverse(), ...httpEndpoints.reverse()];
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

function parseProcessCmdForCsrf(pid, cmd) {
  const tokenMatch = String(cmd || "").match(/--csrf_token(?:=|\s+)([^\s"']+)/);
  if (!tokenMatch || !tokenMatch[1]) return null;
  const httpsMatch = cmd.match(/--https_server_port(?:=|\s+)(\d+)/);
  const httpMatch = cmd.match(/--(?:extension_server_port|server_port|http_port)(?:=|\s+)(\d+)/);
  return {
    pid: Number(pid) || 0,
    token: tokenMatch[1],
    httpsPort: httpsMatch ? Number(httpsMatch[1]) : 0,
    httpPort: httpMatch ? Number(httpMatch[1]) : 0,
  };
}

function readWslDistroLanguageServerProcesses(distro) {
  return new Promise((resolve) => {
    if (!distro || !fs.existsSync(WSL_EXE)) {
      resolve([]);
      return;
    }
    execFile(
      WSL_EXE,
      ["-d", distro, "--exec", "ps", "-eo", "pid,args"],
      { encoding: "utf8", timeout: 4000 },
      (err, stdout) => {
        if (err || !stdout) {
          resolve([]);
          return;
        }
        const results = [];
        for (const line of stdout.split(/\r?\n/)) {
          if (!line.includes("language_server") || !line.includes("--csrf_token")) continue;
          const m = /^\s*(\d+)\s+(.*)$/.exec(line);
          if (!m) continue;
          const parsed = parseProcessCmdForCsrf(m[1], m[2]);
          if (parsed) results.push(parsed);
        }
        resolve(results);
      }
    );
  });
}

function readRunningLanguageServerProcesses(activeDistro) {
  return new Promise((resolve) => {
    const psScript =
      "Get-CimInstance Win32_Process -Filter \"Name = 'language_server.exe' OR Name = 'wsl.exe'\" | Select-Object ProcessId, Name, CommandLine | ConvertTo-Json -Compress";
    execFile(
      "powershell",
      ["-NoProfile", "-Command", psScript],
      { encoding: "utf8", timeout: 5000 },
      async (err, stdout) => {
        const results = [];
        if (!err && stdout) {
          try {
            const parsed = JSON.parse(stdout.trim());
            const list = Array.isArray(parsed) ? parsed : [parsed];
            for (const item of list) {
              const cmd = String((item && item.CommandLine) || "");
              if (!cmd.includes("--csrf_token")) continue;
              const info = parseProcessCmdForCsrf(item.ProcessId, cmd);
              if (info) results.push(info);
            }
          } catch {}
        }
        if (results.length === 0 && activeDistro) {
          const wslProcs = await readWslDistroLanguageServerProcesses(activeDistro);
          results.push(...wslProcs);
        }
        resolve(results);
      }
    );
  });
}

/**
 * 支持 HTTPS（本地 127.0.0.1 自签证书，无 Origin 头，禁用 keep-alive 复用）与 HTTP 的 Connect RPC 调用
 */
function requestLsRpc(endpoint, token, methodPath, bodyObj, timeoutMs) {
  return new Promise((resolve) => {
    const proto = endpoint.proto === "https" ? "https" : "http";
    const host = endpoint.host || "127.0.0.1";
    const port = Number(endpoint.port);
    if (!port || !token) {
      resolve(null);
      return;
    }

    const payload = JSON.stringify(bodyObj || {});
    const lib = proto === "https" ? https : http;
    const req = lib.request(
      {
        hostname: host,
        port,
        path: methodPath,
        method: "POST",
        agent: false,
        ...(proto === "https" ? { rejectUnauthorized: false } : {}),
        headers: {
          "content-type": "application/json",
          "content-length": String(Buffer.byteLength(payload)),
          "x-codeium-csrf-token": token,
          "connect-protocol-version": "1",
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
        res.on("data", (d) => chunks.push(d));
        res.on("end", () => {
          try {
            const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            resolve(parsed && typeof parsed === "object" ? parsed : null);
          } catch {
            resolve(null);
          }
        });
      }
    );

    req.on("timeout", () => {
      req.destroy();
      resolve(null);
    });
    req.on("error", () => {
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
    "/exa.language_server_pb.LanguageServerService/GetUserStatus",
    {
      metadata: {
        ideName: "antigravity",
        extensionName: "antigravity",
        locale: "en",
      },
    },
    2500
  );
}

function probeRetrieveUserQuotaSummary(endpoint, token, forceRefresh) {
  return requestLsRpc(
    endpoint,
    token,
    "/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary",
    forceRefresh ? { forceRefresh: true } : {},
    forceRefresh ? 4000 : 2500
  );
}

function parseEnvAddress(rawAddr) {
  const s = String(rawAddr || "").trim();
  if (!s) return null;
  if (s.startsWith("http://") || s.startsWith("https://")) {
    try {
      const u = new URL(s);
      return {
        proto: u.protocol === "https:" ? "https" : "http",
        host: u.hostname || "127.0.0.1",
        port: Number(u.port),
      };
    } catch {
      return null;
    }
  }
  const parts = s.split(":");
  const port = Number(parts[parts.length - 1]);
  const host = parts.slice(0, -1).join(":") || "127.0.0.1";
  return port > 0 ? { proto: "https", host, port } : null;
}

/**
 * 检查主进程内活动端口/令牌是否已更新（应对 LS 重启或冷启动完成）
 */
function invalidateStaleCachedConnection() {
  if (!cachedConnection) return;
  const inProc = readInProcessLanguageServerInfo();
  if (inProc.token && cachedConnection.token !== inProc.token) {
    cachedConnection = null;
    cachedQuotaSummary = null;
    cachedQuotaSummaryAt = 0;
    cachedRawStatus = null;
    cachedRawStatusAt = 0;
    return;
  }
  if (inProc.port > 0 && cachedConnection.lsPort && cachedConnection.lsPort !== inProc.port) {
    cachedConnection = null;
    cachedQuotaSummary = null;
    cachedQuotaSummaryAt = 0;
    cachedRawStatus = null;
    cachedRawStatusAt = 0;
  }
}

async function discoverLanguageServer(force) {
  invalidateStaleCachedConnection();
  if (!force && cachedConnection) return cachedConnection;

  // 0. 环境变量直连覆盖
  if (process.env.ANTIGRAVITY_LS_ADDRESS && process.env.ANTIGRAVITY_CSRF_TOKEN) {
    const ep = parseEnvAddress(process.env.ANTIGRAVITY_LS_ADDRESS);
    if (ep) {
      const altEp = { ...ep, proto: ep.proto === "https" ? "http" : "https" };
      for (const candidate of [ep, altEp]) {
        const data = await probeGetUserStatus(candidate, process.env.ANTIGRAVITY_CSRF_TOKEN);
        if (data) {
          cachedConnection = {
            endpoint: candidate,
            token: process.env.ANTIGRAVITY_CSRF_TOKEN,
            pid: 0,
            lsPort: candidate.port,
          };
          cachedRawStatus = data;
          cachedRawStatusAt = Date.now();
          return cachedConnection;
        }
      }
    }
  }

  // 1. Electron 主进程内存零开销直连（v2.34+ 原生 authBootstrap/languageServer 导出，支持本地与 WSL 双模）
  const inProc = readInProcessLanguageServerInfo();
  const logEndpoints = readCandidateEndpointsFromLog();

  if (inProc.token) {
    const fastEndpoints = [];
    if (inProc.baseUrl) {
      const parsedBase = parseEnvAddress(inProc.baseUrl);
      if (parsedBase) fastEndpoints.push(parsedBase);
    }
    if (inProc.port > 0) {
      // 官方规范：getLsPort() 即为 HTTPS 服务端口，优先直连 HTTPS，再兼容 HTTP 端口
      fastEndpoints.push({ proto: "https", host: "127.0.0.1", port: inProc.port });
      fastEndpoints.push({ proto: "http", host: "127.0.0.1", port: inProc.port });
      fastEndpoints.push({ proto: "http", host: "127.0.0.1", port: inProc.port + 1 });
    }
    for (const ep of logEndpoints) {
      fastEndpoints.push(ep);
    }

    const seen = new Set();
    for (const ep of fastEndpoints) {
      const key = `${ep.proto}:${ep.port}`;
      if (!ep.port || seen.has(key)) continue;
      seen.add(key);
      const summary = await probeRetrieveUserQuotaSummary(ep, inProc.token, false);
      if (summary) {
        cachedConnection = {
          endpoint: { proto: ep.proto, host: ep.host || "127.0.0.1", port: ep.port },
          token: inProc.token,
          pid: inProc.pid,
          lsPort: inProc.port || ep.port,
        };
        cachedQuotaSummary = summary;
        cachedQuotaSummaryAt = Date.now();
        return cachedConnection;
      }
      const data = await probeGetUserStatus(ep, inProc.token);
      if (data) {
        cachedConnection = {
          endpoint: { proto: ep.proto, host: ep.host || "127.0.0.1", port: ep.port },
          token: inProc.token,
          pid: inProc.pid,
          lsPort: inProc.port || ep.port,
        };
        cachedRawStatus = data;
        cachedRawStatusAt = Date.now();
        return cachedConnection;
      }
    }
  }

  // 2. 旧版客户端兼容：进程表 + WSL 回退探测
  const procs = await readRunningLanguageServerProcesses(inProc.activeDistro);
  const candidateEndpoints = [...logEndpoints];
  for (const p of procs) {
    if (p.httpsPort > 0) {
      candidateEndpoints.push({ proto: "https", host: "127.0.0.1", port: p.httpsPort });
    }
    if (p.httpPort > 0) {
      candidateEndpoints.push({ proto: "http", host: "127.0.0.1", port: p.httpPort });
    }
  }

  const seenKeys = new Set();
  const uniqueEndpoints = [];
  for (const ep of candidateEndpoints) {
    const key = `${ep.proto}:${ep.port}`;
    if (ep.port > 0 && !seenKeys.has(key)) {
      seenKeys.add(key);
      uniqueEndpoints.push({ proto: ep.proto, host: "127.0.0.1", port: ep.port });
    }
  }

  for (const proc of procs) {
    for (const ep of uniqueEndpoints) {
      const data = await probeGetUserStatus(ep, proc.token);
      if (data) {
        cachedConnection = { endpoint: ep, token: proc.token, pid: proc.pid, lsPort: ep.port };
        cachedRawStatus = data;
        cachedRawStatusAt = Date.now();
        return cachedConnection;
      }
    }
  }

  cachedConnection = null;
  return null;
}

async function fetchRawUserStatus(forceRefresh) {
  invalidateStaleCachedConnection();
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

async function fetchRawQuotaSummary(forceRefresh) {
  invalidateStaleCachedConnection();
  const now = Date.now();
  if (!forceRefresh && cachedQuotaSummary && now - cachedQuotaSummaryAt < CACHE_TTL_MS) {
    return cachedQuotaSummary;
  }

  if (cachedConnection) {
    const data = await probeRetrieveUserQuotaSummary(
      cachedConnection.endpoint,
      cachedConnection.token,
      Boolean(forceRefresh)
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
  if (!forceRefresh && cachedQuotaSummary && Date.now() - cachedQuotaSummaryAt < 3000) {
    return cachedQuotaSummary;
  }
  const data = await probeRetrieveUserQuotaSummary(conn.endpoint, conn.token, Boolean(forceRefresh));
  if (data) {
    cachedQuotaSummary = data;
    cachedQuotaSummaryAt = Date.now();
  }
  return data;
}

function formatResetCountdown(resetTimeIso) {
  if (!resetTimeIso) return { text: "", remainingSec: null, isLongCooldown: false };
  const targetMs = typeof resetTimeIso === "number" ? resetTimeIso : Date.parse(resetTimeIso);
  if (!Number.isFinite(targetMs)) return { text: "", remainingSec: null, isLongCooldown: false };

  const diffMs = targetMs - Date.now();
  if (diffMs <= 0) {
    return { text: "即将刷新", remainingSec: 0, isLongCooldown: false };
  }

  const totalSec = Math.ceil(diffMs / 1000);
  const totalMin = Math.ceil(diffMs / 60000);
  const days = Math.floor(totalMin / (24 * 60));
  const hours = Math.floor((totalMin % (24 * 60)) / 60);
  const mins = totalMin % 60;
  const isLongCooldown = diffMs > 6 * 3600 * 1000;

  let text = "";
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
  const tierName = String((userStatus.userTier && userStatus.userTier.name) || "").trim();
  const planName = String((userStatus.planStatus && userStatus.planStatus.planInfo && userStatus.planStatus.planInfo.planName) || "").trim();
  const teamsTier = String((userStatus.planStatus && userStatus.planStatus.planInfo && userStatus.planStatus.planInfo.teamsTier) || "").trim();
  const raw = tierName || planName || teamsTier;
  if (!raw) return "套餐内用量";
  if (/ultra/i.test(raw)) return "Google AI Ultra";
  if (/pro/i.test(raw) && !/free/i.test(raw)) return "Google AI Pro";
  if (/free/i.test(raw)) return "免费套餐";
  return raw;
}

function classifyModelFamily(label, modelId) {
  const text = `${label || ""} ${modelId || ""}`.toLowerCase();
  if (text.includes("claude") || text.includes("sonnet") || text.includes("opus") || text.includes("haiku")) {
    return { key: "claude", title: "Claude 模型池", order: 2 };
  }
  if (text.includes("gpt") || text.includes("o3") || text.includes("o4") || text.includes("oss")) {
    return { key: "third-party", title: "第三方模型池", order: 3 };
  }
  if (text.includes("flash")) {
    return { key: "gemini-flash", title: "Gemini Flash 额度", order: 2 };
  }
  if (text.includes("gemini") || text.includes("pro") || text.includes("orchestrator") || text.includes("carbon") || text.includes("argon") || text.includes("hydrogen") || text.includes("neon")) {
    return { key: "gemini-pro", title: "Gemini 额度", order: 1 };
  }
  return { key: `other:${label || modelId}`, title: label || "模型额度", order: 5 };
}

function classifySummaryGroup(displayName, description) {
  const text = `${displayName || ""} ${description || ""}`.toLowerCase();
  if (text.includes("gemini")) {
    return {
      id: "gemini",
      title: "Gemini",
      keywords: ["gemini", "orchestrator", "carbon", "argon", "hydrogen", "neon", "flash"],
      order: 1,
    };
  }
  if (text.includes("claude") || text.includes("gpt") || text.includes("3p")) {
    return {
      id: "claude-gpt",
      title: "Claude / GPT",
      keywords: ["claude", "opus", "sonnet", "haiku", "gpt", "oss", "o3", "o4"],
      order: 2,
    };
  }
  const slug =
    String(displayName || "model-quota")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "model-quota";
  return {
    id: slug,
    title: displayName || "模型额度",
    keywords: [],
    order: 3,
  };
}

function parseSummaryBucket(b) {
  if (!b || typeof b !== "object") return null;

  const rawHint = `${b.bucketId || ""} ${b.displayName || ""}`.toLowerCase();
  let windowType = String(b.window || "").trim().toLowerCase();
  let label = String(b.displayName || "").trim() || "额度上限";
  let order = 3;

  if (windowType === "5h" || /5h|five.?hour/.test(rawHint)) {
    windowType = "5h";
    label = "5 小时限额";
    order = 1;
  } else if (windowType === "weekly" || /week/.test(rawHint)) {
    windowType = "weekly";
    label = "每周限额";
    order = 2;
  } else if (!windowType) {
    windowType = "other";
  }

  const resetTime = b.resetTime || "";
  const resetMs = resetTime ? Date.parse(resetTime) : NaN;
  const hasValidFutureReset = Number.isFinite(resetMs) && resetMs > Date.now();

  let fraction;
  if (typeof b.remainingFraction === "number" && Number.isFinite(b.remainingFraction)) {
    fraction = Math.max(0, Math.min(1, b.remainingFraction));
  } else if (b.disabled === true || hasValidFutureReset) {
    fraction = 0;
  } else {
    return null;
  }

  const pct = Math.round(fraction * 100);
  const cd = fraction < 0.9995 && resetTime ? formatResetCountdown(resetTime) : { text: "" };

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

function normalizeFromQuotaSummary(summaryResp, localStats, enabled) {
  const resp = (summaryResp && summaryResp.response) || summaryResp || null;
  if (!resp || typeof resp !== "object") return null;

  let rawGroups = Array.isArray(resp.groups) ? resp.groups : [];
  if (rawGroups.length === 0 && Array.isArray(resp.buckets) && resp.buckets.length > 0) {
    rawGroups = [
      {
        displayName: "模型额度",
        description: "",
        buckets: resp.buckets,
      },
    ];
  }
  if (rawGroups.length === 0) return null;

  const groups = [];
  for (const g of rawGroups) {
    const rawBuckets = Array.isArray(g && g.buckets) ? g.buckets : [];
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
    pluginEnabled: enabled,
    source: "quota_summary",
    planLabel: "套餐内用量",
    primaryRemainingPercent: groups[0].remainingPercent,
    groups: groups.map(({ order: _order, ...rest }) => rest),
    items,
    localStats: localStats || null,
    updatedAt: new Date().toISOString(),
  };
}

function normalizeQuotaStatus(rawResp, localStats) {
  const enabled = isPluginEnabled();
  const userStatus = (rawResp && rawResp.userStatus) || rawResp || null;
  if (!userStatus || typeof userStatus !== "object") {
    const fallbackItems = [
      {
        id: "local-5h",
        window: "5h",
        label: "近 5 小时消耗",
        remainingPercent: null,
        valueText: `${((localStats && localStats.tokens5h) || 0).toLocaleString()} tokens`,
        resetText: `已记录 ${(localStats && localStats.turns5h) || 0} 轮对话`,
        isFallback: true,
        models: [],
      },
      {
        id: "local-7d",
        window: "weekly",
        label: "近 7 天消耗",
        remainingPercent: null,
        valueText: `${((localStats && localStats.tokens7d) || 0).toLocaleString()} tokens`,
        resetText: "未连接本地配额服务",
        isFallback: true,
        models: [],
      },
    ];
    return {
      ok: false,
      pluginEnabled: enabled,
      source: "local-fallback",
      planLabel: "本地统计",
      primaryRemainingPercent: 100,
      groups: [
        {
          id: "local-fallback",
          title: "本地统计",
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
  const configs =
    userStatus.cascadeModelConfigData && Array.isArray(userStatus.cascadeModelConfigData.clientModelConfigs)
      ? userStatus.cascadeModelConfigData.clientModelConfigs
      : [];

  const familyBuckets = new Map();
  for (const cfg of configs) {
    const quotaInfo = cfg && cfg.quotaInfo;
    if (!quotaInfo || typeof quotaInfo !== "object") continue;

    const resetTime = quotaInfo.resetTime || "";
    const resetMs = resetTime ? Date.parse(resetTime) : NaN;
    const hasValidFutureReset = Number.isFinite(resetMs) && resetMs > Date.now();

    let fraction;
    if (typeof quotaInfo.remainingFraction === "number") {
      fraction = Math.max(0, Math.min(1, quotaInfo.remainingFraction));
    } else if (quotaInfo.resetTime && hasValidFutureReset) {
      fraction = 0;
    } else {
      continue;
    }

    const modelLabel = String(cfg.label || "");
    const modelId = String((cfg.modelOrAlias && cfg.modelOrAlias.model) || cfg.modelId || "");
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
    const cd = pct < 100 ? formatResetCountdown(p.resetTime) : { text: "", isLongCooldown: false };

    let label = p.title;
    const hasGeminiPro = p.keys.includes("gemini-pro");
    const hasGeminiFlash = p.keys.includes("gemini-flash");
    const hasClaude = p.keys.includes("claude");
    const hasThirdParty = p.keys.includes("third-party");

    if (mergedPools.length === 1) {
      label = cd.isLongCooldown ? "每周限额" : "5 小时用量上限";
    } else if (hasGeminiPro && hasGeminiFlash && !hasClaude) {
      label = cd.isLongCooldown ? "Gemini 每周限额" : "Gemini 5 小时用量上限";
    } else if (hasClaude && hasThirdParty && !hasGeminiPro) {
      label = cd.isLongCooldown ? "Claude / 第三方限额" : "Claude / 第三方额度";
    } else if (hasGeminiPro && !hasGeminiFlash && !hasClaude) {
      label = cd.isLongCooldown ? "Gemini Pro 每周限额" : "Gemini Pro 额度";
    }

    items.push({
      id: p.keys.join("+"),
      label,
      remainingPercent: pct,
      valueText: `剩余 ${pct}%`,
      resetText: cd.text,
      resetTime: p.resetTime || null,
      isLongCooldown: cd.isLongCooldown,
      models: p.models,
    });
  }

  if (typeof planStatus.weeklyQuotaRemainingPercent === "number") {
    const wpct = Math.max(0, Math.min(100, Math.round(planStatus.weeklyQuotaRemainingPercent)));
    const resetIso = planStatus.weeklyQuotaResetAtUnix
      ? Number(planStatus.weeklyQuotaResetAtUnix) * 1000
      : null;
    const cd = wpct < 100 && resetIso ? formatResetCountdown(resetIso) : { text: "" };
    items.push({
      id: "weekly-quota",
      label: "每周限额",
      remainingPercent: wpct,
      valueText: `剩余 ${wpct}%`,
      resetText: cd.text,
      resetTime: resetIso ? new Date(resetIso).toISOString() : null,
      models: [],
    });
  }

  if (typeof planStatus.dailyQuotaRemainingPercent === "number") {
    const dpct = Math.max(0, Math.min(100, Math.round(planStatus.dailyQuotaRemainingPercent)));
    const resetIso = planStatus.dailyQuotaResetAtUnix
      ? Number(planStatus.dailyQuotaResetAtUnix) * 1000
      : null;
    const cd = dpct < 100 && resetIso ? formatResetCountdown(resetIso) : { text: "" };
    items.push({
      id: "daily-quota",
      label: "每日限额",
      remainingPercent: dpct,
      valueText: `剩余 ${dpct}%`,
      resetText: cd.text,
      resetTime: resetIso ? new Date(resetIso).toISOString() : null,
      models: [],
    });
  }

  if (items.length === 0) {
    const monthly = Number((planStatus.planInfo && planStatus.planInfo.monthlyPromptCredits) || 0);
    const available = Number(planStatus.availablePromptCredits);
    if (monthly > 0 && Number.isFinite(available)) {
      const pct = Math.max(0, Math.min(100, Math.round((available / monthly) * 100)));
      items.push({
        id: "prompt-credits",
        label: "月度提示词额度",
        remainingPercent: pct,
        valueText: `剩余 ${pct}%`,
        resetText: `${available.toLocaleString()} / ${monthly.toLocaleString()}`,
        models: [],
      });
    } else {
      items.push({
        id: "local-5h",
        label: "近 5 小时消耗",
        remainingPercent: 100,
        valueText: `${((localStats && localStats.tokens5h) || 0).toLocaleString()} tokens`,
        resetText: `近 7 天 ${((localStats && localStats.tokens7d) || 0).toLocaleString()} tokens`,
        models: [],
      });
    }
  }

  const numericPcts = items
    .map((x) => x.remainingPercent)
    .filter((v) => typeof v === "number" && Number.isFinite(v));
  const primaryRemainingPercent = numericPcts.length > 0 ? numericPcts[0] : 100;

  return {
    ok: true,
    pluginEnabled: enabled,
    source: "language_server",
    planLabel,
    primaryRemainingPercent,
    groups: [
      {
        id: "legacy-status",
        title: "模型额度",
        keywords: [],
        remainingPercent: primaryRemainingPercent,
        buckets: items.map((x) => ({
          id: x.id,
          window: x.isLongCooldown ? "weekly" : "5h",
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

async function getQuotaStatus(forceRefresh) {
  if (!forceRefresh && inflightPromise) {
    return inflightPromise;
  }
  const task = (async () => {
    const enabled = isPluginEnabled();
    const localStats = scanRecentLocalTokens(Boolean(forceRefresh));
    const summaryRaw = await fetchRawQuotaSummary(Boolean(forceRefresh));
    const normalizedSummary = normalizeFromQuotaSummary(summaryRaw, localStats, enabled);
    if (normalizedSummary) {
      const { activeDistro } = readInProcessLanguageServerInfo();
      if (activeDistro) normalizedSummary.wslDistro = activeDistro;
      return normalizedSummary;
    }
    const raw = await fetchRawUserStatus(Boolean(forceRefresh));
    const statusObj = normalizeQuotaStatus(raw, localStats);
    const { activeDistro } = readInProcessLanguageServerInfo();
    if (activeDistro) statusObj.wslDistro = activeDistro;
    return statusObj;
  })();
  inflightPromise = task;
  try {
    return await task;
  } finally {
    if (inflightPromise === task) inflightPromise = null;
  }
}

function getRendererScript() {
  const candidates = [
    path.join(__dirname, "..", "renderer", "sidebar-quota.js"),
    path.join(os.homedir(), ".gemini", "config", "plugins", "quota-pill", "renderer", "sidebar-quota.js"),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      return fs.readFileSync(p, "utf8");
    }
  }
  return "";
}

function requestLocalHttpJson(port, reqPath, timeoutMs) {
  return new Promise((resolve) => {
    const req = http.get(
      { hostname: "127.0.0.1", port, path: reqPath, timeout: timeoutMs || 800 },
      (res) => {
        const chunks = [];
        res.on("data", (d) => chunks.push(d));
        res.on("end", () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
          } catch {
            resolve(null);
          }
        });
      }
    );
    req.on("timeout", () => {
      req.destroy();
      resolve(null);
    });
    req.on("error", () => resolve(null));
  });
}

function startLocalQuotaServer() {
  let retriedTakeover = false;
  const createAndListen = () => {
    try {
      const server = http.createServer(async (req, res) => {
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
        if (req.method === "OPTIONS") {
          res.writeHead(204);
          res.end();
          return;
        }
        const u = new URL(req.url || "/", "http://127.0.0.1");
        if (u.pathname === "/api/quota") {
          const refresh = u.searchParams.get("refresh") === "1";
          if (refresh) {
            cachedConnection = null;
          }
          const data = await getQuotaStatus(refresh);
          res.writeHead(200, {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "no-store",
          });
          res.end(JSON.stringify(data));
          return;
        }
        if (u.pathname === "/health") {
          const inProc = readInProcessLanguageServerInfo();
          res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
          res.end(
            JSON.stringify({
              status: "ok",
              plugin: "quota-pill",
              version: HOOK_VERSION,
              host: "electron-main",
              pid: process.pid,
              lsPort: inProc.port || 0,
              hasCsrfToken: Boolean(inProc.token),
              wslDistro: inProc.activeDistro || "",
            })
          );
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(
          JSON.stringify({
            status: "ok",
            plugin: "quota-pill",
            version: HOOK_VERSION,
            host: "electron-main",
          })
        );
      });
      server.on("error", async (err) => {
        if (err && err.code === "EADDRINUSE" && !retriedTakeover) {
          retriedTakeover = true;
          // 若 45790 被旧版脱离主进程的独立 server.mjs 占用，则通知其退出并由主进程接管
          const info = await requestLocalHttpJson(FIXED_PORT, "/health", 800);
          if (info && info.plugin === "quota-pill" && info.host !== "electron-main") {
            await requestLocalHttpJson(FIXED_PORT, "/api/shutdown", 800);
            setTimeout(createAndListen, 250);
          }
        }
      });
      server.listen(FIXED_PORT, "127.0.0.1");
    } catch {}
  };
  createAndListen();
}

function installMainProcessHook() {
  if (global.__AGY_QUOTA_PILL_MAIN_HOOK__) return;
  global.__AGY_QUOTA_PILL_MAIN_HOOK__ = true;

  startLocalQuotaServer();

  try {
    const electron = require("electron");
    if (!electron || !electron.app) return;

    if (electron.ipcMain) {
      try {
        electron.ipcMain.handle("quota-pill:get-status", (_event, force) => {
          return getQuotaStatus(Boolean(force));
        });
      } catch {}
    }

    const injectIntoWebContents = (wc) => {
      if (!wc || (wc.isDestroyed && wc.isDestroyed())) return;
      const tryInject = () => {
        if (wc.isDestroyed && wc.isDestroyed()) return;
        const url = (wc.getURL && wc.getURL()) || "";
        if (
          !url.startsWith("http://127.0.0.1") &&
          !url.startsWith("https://127.0.0.1") &&
          !url.startsWith("http://localhost") &&
          !url.startsWith("https://localhost")
        ) {
          return;
        }
        const code = getRendererScript();
        if (code) {
          wc.executeJavaScript(code).catch(() => {});
        }
      };
      wc.on("dom-ready", tryInject);
      wc.on("did-finish-load", tryInject);
      setTimeout(tryInject, 1300);
    };

    electron.app.on("web-contents-created", (_event, wc) => {
      injectIntoWebContents(wc);
    });

    electron.app.whenReady().then(() => {
      const all =
        (electron.webContents &&
          electron.webContents.getAllWebContents &&
          electron.webContents.getAllWebContents()) ||
        [];
      for (const wc of all) {
        injectIntoWebContents(wc);
      }
    });
  } catch {}
}

installMainProcessHook();
