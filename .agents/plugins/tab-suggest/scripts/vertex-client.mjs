/**
 * Antigravity Tab Suggest — Google Cloud Vertex AI (DeepSeek V4.1 Flash) 客户端与凭证管理模块
 */
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { URL } from 'node:url';
import zlib from 'node:zlib';

export const SERVICE_VERSION = '1.0.0';
export const DEFAULT_MODEL = 'deepseek-ai/deepseek-v4.1-flash-maas';
export const DEFAULT_LOCATION = 'global';

const IS_WIN = process.platform === 'win32';
const IS_LINUX = process.platform === 'linux';

function resolveSharedDataDir() {
  const envDir = process.env.AGY_TAB_SUGGEST_DATA_DIR?.trim();
  if (envDir) return envDir;

  if (IS_LINUX && fs.existsSync('/mnt/c/Users')) {
    try {
      for (const entry of fs.readdirSync('/mnt/c/Users', { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        if (['Public', 'Default', 'Default User', 'All Users'].includes(entry.name)) continue;
        const winAgy = path.join('/mnt/c/Users', entry.name, 'AppData', 'Local', 'Programs', 'antigravity');
        const winGemini = path.join('/mnt/c/Users', entry.name, '.gemini', 'antigravity');
        if (fs.existsSync(winAgy) || fs.existsSync(winGemini)) {
          return path.join(winGemini, 'sidecar_data', 'tab-suggest');
        }
      }
    } catch {}
  }

  return path.join(os.homedir(), '.gemini', 'antigravity', 'sidecar_data', 'tab-suggest');
}

export const DATA_DIR = resolveSharedDataDir();
export const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
export const CREDENTIAL_FILE = path.join(DATA_DIR, 'vertex-credentials.json');
export const PID_FILE = path.join(DATA_DIR, 'service.json');

try {
  fs.mkdirSync(DATA_DIR, { recursive: true });
} catch {}

export function isPluginDisabledInGlobalConfig() {
  try {
    const cfgPath = path.join(os.homedir(), '.gemini', 'config', 'config.json');
    if (fs.existsSync(cfgPath)) {
      const parsed = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
      if (parsed?.plugins?.['tab-suggest']?.enabled === false) {
        return true;
      }
    }
  } catch {}
  return false;
}

export function loadConfig() {
  const defaults = {
    enabled: true,
    provider: 'vertex-maas',
    location: DEFAULT_LOCATION,
    projectId: '',
    model: DEFAULT_MODEL,
    openaiBaseUrl: 'https://api.deepseek.com/v1',
    openaiApiKey: '',
    openaiModel: 'deepseek-chat',
    updatedAt: '',
  };

  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      if (raw && typeof raw === 'object') {
        return {
          ...defaults,
          ...raw,
          location: String(raw.location || defaults.location).trim() || DEFAULT_LOCATION,
          model: String(raw.model || defaults.model).trim() || DEFAULT_MODEL,
        };
      }
    }
  } catch {}

  return defaults;
}

export function saveConfig(partial) {
  const current = loadConfig();
  const next = {
    ...current,
    ...partial,
    updatedAt: new Date().toISOString(),
  };
  next.location = String(next.location || DEFAULT_LOCATION).trim() || DEFAULT_LOCATION;
  next.model = String(next.model || DEFAULT_MODEL).trim() || DEFAULT_MODEL;
  next.projectId = String(next.projectId || '').trim();
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2), { encoding: 'utf8', mode: 0o600 });
  return next;
}

let cachedTokenState = {
  fingerprint: '',
  accessToken: '',
  expiresAtMs: 0,
  inflight: null,
};

export function invalidateTokenCache() {
  cachedTokenState = {
    fingerprint: '',
    accessToken: '',
    expiresAtMs: 0,
    inflight: null,
  };
}

export function parseAndValidateGoogleCredentials(rawJsonInput) {
  const text = typeof rawJsonInput === 'string' ? rawJsonInput.trim() : JSON.stringify(rawJsonInput || {});
  if (!text) {
    throw new Error('JSON 凭证内容为空');
  }
  let obj;
  try {
    obj = JSON.parse(text);
  } catch (err) {
    throw new Error(`JSON 语法解析失败: ${err.message}`);
  }
  if (!obj || typeof obj !== 'object') {
    throw new Error('无效的 JSON 凭证对象');
  }

  if (obj.type === 'service_account') {
    if (!obj.client_email || !obj.private_key) {
      throw new Error('Service Account JSON 缺少 client_email 或 private_key 字段');
    }
    const normalizedKey = String(obj.private_key).replace(/\\n/g, '\n');
    try {
      const sign = crypto.createSign('RSA-SHA256');
      sign.update('agy-key-check');
      sign.sign(normalizedKey);
    } catch (keyErr) {
      throw new Error(`私钥格式校验失败: ${keyErr.message}`);
    }
    return {
      valid: true,
      credentialType: 'service_account',
      projectId: String(obj.project_id || '').trim(),
      clientEmail: String(obj.client_email || '').trim(),
      normalizedObj: {
        ...obj,
        private_key: normalizedKey,
      },
    };
  }

  if (obj.type === 'authorized_user') {
    if (!obj.client_id || !obj.client_secret || !obj.refresh_token) {
      throw new Error('Authorized User ADC JSON 缺少 client_id / client_secret / refresh_token');
    }
    return {
      valid: true,
      credentialType: 'authorized_user',
      projectId: String(obj.quota_project_id || obj.project_id || '').trim(),
      clientEmail: 'ADC Authorized User',
      normalizedObj: obj,
    };
  }

  throw new Error(`不支持的 Google 凭证类型 "${obj.type || 'unknown'}"，请提供 Service Account JSON 密钥文件`);
}

export function loadSavedCredentials() {
  try {
    if (!fs.existsSync(CREDENTIAL_FILE)) return null;
    const raw = fs.readFileSync(CREDENTIAL_FILE, 'utf8');
    return parseAndValidateGoogleCredentials(raw);
  } catch {
    return null;
  }
}

export function saveCredentialsJson(rawJsonText) {
  const checked = parseAndValidateGoogleCredentials(rawJsonText);
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CREDENTIAL_FILE, JSON.stringify(checked.normalizedObj, null, 2), {
    encoding: 'utf8',
    mode: 0o600,
  });
  invalidateTokenCache();

  if (checked.projectId) {
    saveConfig({ projectId: checked.projectId });
  }
  return checked;
}

export function clearSavedCredentials() {
  try {
    if (fs.existsSync(CREDENTIAL_FILE)) {
      fs.unlinkSync(CREDENTIAL_FILE);
    }
  } catch {}
  invalidateTokenCache();
}

export function getPublicStatus() {
  const cfg = loadConfig();
  const cred = loadSavedCredentials();
  const pluginEnabled = !isPluginDisabledInGlobalConfig();
  const effectiveProjectId = cfg.projectId || cred?.projectId || '';
  const hasCredentials =
    cfg.provider === 'openai-compatible'
      ? Boolean(cfg.openaiApiKey && cfg.openaiApiKey.trim())
      : Boolean(cred && cred.valid && effectiveProjectId);

  return {
    ok: true,
    version: SERVICE_VERSION,
    pluginEnabled,
    enabled: Boolean(cfg.enabled) && pluginEnabled,
    provider: cfg.provider || 'vertex-maas',
    location: cfg.location || DEFAULT_LOCATION,
    projectId: effectiveProjectId,
    model: cfg.model || DEFAULT_MODEL,
    hasCredentials,
    credentialType: cred?.credentialType || '',
    clientEmail: cred?.clientEmail || '',
    openaiBaseUrl: cfg.openaiBaseUrl || '',
    openaiModel: cfg.openaiModel || '',
    hasOpenaiKey: Boolean(cfg.openaiApiKey && cfg.openaiApiKey.trim()),
    dataDir: DATA_DIR,
    credentialFile: CREDENTIAL_FILE,
  };
}

let winProxyCache = { at: 0, url: '' };

function parseWindowsProxyServer(rawServer) {
  const s = String(rawServer || '').trim();
  if (!s) return '';
  if (s.includes('=')) {
    const map = {};
    for (const part of s.split(';')) {
      const idx = part.indexOf('=');
      if (idx > 0) {
        map[part.slice(0, idx).trim().toLowerCase()] = part.slice(idx + 1).trim();
      }
    }
    const picked = map.https || map.http || '';
    if (!picked) return '';
    return /^https?:\/\//i.test(picked) ? picked : `http://${picked}`;
  }
  if (/^socks/i.test(s)) return '';
  return /^https?:\/\//i.test(s) ? s : `http://${s}`;
}

function resolveHttpProxyUrl() {
  const envProxy =
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy ||
    process.env.ALL_PROXY ||
    process.env.all_proxy ||
    '';
  if (envProxy && /^https?:\/\//i.test(envProxy.trim())) {
    return envProxy.trim();
  }
  if (!IS_WIN) return '';

  const now = Date.now();
  if (now - winProxyCache.at < 30_000) {
    return winProxyCache.url;
  }

  let resolved = '';
  try {
    const enableOut = execFileSync(
      'reg',
      ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings', '/v', 'ProxyEnable'],
      { encoding: 'utf8', windowsHide: true, timeout: 1500 }
    );
    if (/0x1\b/i.test(enableOut)) {
      const srvOut = execFileSync(
        'reg',
        ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings', '/v', 'ProxyServer'],
        { encoding: 'utf8', windowsHide: true, timeout: 1500 }
      );
      const m = srvOut.match(/ProxyServer\s+REG_SZ\s+(.+)/i);
      if (m && m[1]) {
        resolved = parseWindowsProxyServer(m[1]);
      }
    }
  } catch {}

  winProxyCache = { at: now, url: resolved };
  return resolved;
}

function openConnectTunnel(proxyUrlStr, targetHost, targetPort, timeoutMs) {
  return new Promise((resolve, reject) => {
    const pu = new URL(proxyUrlStr);
    const proxyPort = Number(pu.port || (pu.protocol === 'https:' ? 443 : 80));
    const connectHeaders = { Host: `${targetHost}:${targetPort}` };
    if (pu.username || pu.password) {
      const auth = Buffer.from(
        `${decodeURIComponent(pu.username)}:${decodeURIComponent(pu.password)}`
      ).toString('base64');
      connectHeaders['Proxy-Authorization'] = `Basic ${auth}`;
    }

    const req = http.request({
      host: pu.hostname,
      port: proxyPort,
      method: 'CONNECT',
      path: `${targetHost}:${targetPort}`,
      headers: connectHeaders,
      timeout: timeoutMs,
    });
    req.on('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        reject(new Error(`代理隧道握手失败 (${res.statusCode})`));
        return;
      }
      resolve(socket);
    });
    req.on('timeout', () => req.destroy(new Error('代理隧道连接超时')));
    req.on('error', reject);
    req.end();
  });
}

function sendHttpsRequestOnce(targetUrl, options = {}, proxyUrl = '') {
  return new Promise((resolve, reject) => {
    const u = new URL(targetUrl);
    const isHttps = u.protocol === 'https:';
    const port = Number(u.port || (isHttps ? 443 : 80));
    const method = (options.method || 'GET').toUpperCase();
    const timeoutMs = Number(options.timeoutMs || 20_000);
    const bodyBuf =
      options.body === undefined || options.body === null
        ? null
        : Buffer.isBuffer(options.body)
          ? options.body
          : Buffer.from(String(options.body), 'utf8');

    const headers = { ...(options.headers || {}) };
    if (!Object.keys(headers).some((k) => k.toLowerCase() === 'host')) {
      headers.Host = u.host;
    }
    if (bodyBuf && !Object.keys(headers).some((k) => k.toLowerCase() === 'content-length')) {
      headers['Content-Length'] = String(bodyBuf.length);
    }

    const runWithSocket = (tunnelSocket) => {
      const transport = isHttps ? https : http;
      const reqOpts = {
        protocol: u.protocol,
        hostname: u.hostname,
        port,
        path: `${u.pathname}${u.search}`,
        method,
        headers,
        timeout: timeoutMs,
      };
      if (tunnelSocket) {
        reqOpts.createConnection = () =>
          isHttps ? tls.connect({ socket: tunnelSocket, servername: u.hostname }) : tunnelSocket;
      }

      const req = transport.request(reqOpts, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          let rawBuf = Buffer.concat(chunks);
          const enc = String(res.headers['content-encoding'] || '').toLowerCase();
          try {
            if (enc === 'gzip') rawBuf = zlib.gunzipSync(rawBuf);
            else if (enc === 'deflate') rawBuf = zlib.inflateSync(rawBuf);
            else if (enc === 'br') rawBuf = zlib.brotliDecompressSync(rawBuf);
          } catch {}
          const text = rawBuf.toString('utf8');
          const status = res.statusCode || 0;
          resolve({
            ok: status >= 200 && status < 300,
            status,
            text,
            json() {
              return JSON.parse(text);
            },
          });
        });
      });

      req.on('timeout', () => req.destroy(new Error(`请求超时 (${timeoutMs}ms)`)));
      req.on('error', reject);
      if (bodyBuf) req.write(bodyBuf);
      req.end();
    };

    if (proxyUrl && u.hostname !== '127.0.0.1' && u.hostname !== 'localhost') {
      openConnectTunnel(proxyUrl, u.hostname, port, Math.min(8000, timeoutMs))
        .then((socket) => runWithSocket(socket))
        .catch(reject);
    } else {
      runWithSocket(null);
    }
  });
}

export async function smartRequest(targetUrl, options = {}) {
  const proxyUrl = resolveHttpProxyUrl();
  if (proxyUrl) {
    try {
      return await sendHttpsRequestOnce(targetUrl, options, proxyUrl);
    } catch {
      return await sendHttpsRequestOnce(targetUrl, options, '');
    }
  }
  return await sendHttpsRequestOnce(targetUrl, options, '');
}

function base64UrlEncode(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(String(input), 'utf8');
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export async function getGoogleAccessToken(credInfo) {
  if (!credInfo || !credInfo.valid || !credInfo.normalizedObj) {
    throw new Error('尚未导入有效的 Google Cloud JSON 凭证');
  }
  const obj = credInfo.normalizedObj;
  const fp = crypto
    .createHash('sha1')
    .update(`${obj.type}:${obj.client_email || obj.client_id}:${(obj.private_key || obj.refresh_token || '').slice(-32)}`)
    .digest('hex');

  const nowMs = Date.now();
  if (
    cachedTokenState.fingerprint === fp &&
    cachedTokenState.accessToken &&
    nowMs < cachedTokenState.expiresAtMs - 5 * 60 * 1000
  ) {
    return cachedTokenState.accessToken;
  }

  if (cachedTokenState.fingerprint === fp && cachedTokenState.inflight) {
    return await cachedTokenState.inflight;
  }

  const fetchPromise = (async () => {
    const tokenUri = String(obj.token_uri || 'https://oauth2.googleapis.com/token').trim();
    let formBody = '';

    if (obj.type === 'service_account') {
      const nowSec = Math.floor(Date.now() / 1000);
      const header = {
        alg: 'RS256',
        typ: 'JWT',
        ...(obj.private_key_id ? { kid: String(obj.private_key_id) } : {}),
      };
      const payload = {
        iss: obj.client_email,
        sub: obj.client_email,
        scope: 'https://www.googleapis.com/auth/cloud-platform',
        aud: tokenUri,
        iat: nowSec - 10,
        exp: nowSec + 3500,
      };
      const unsigned = `${base64UrlEncode(JSON.stringify(header))}.${base64UrlEncode(JSON.stringify(payload))}`;
      const signer = crypto.createSign('RSA-SHA256');
      signer.update(unsigned);
      const signature = base64UrlEncode(signer.sign(obj.private_key));
      const jwt = `${unsigned}.${signature}`;

      formBody = new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: jwt,
      }).toString();
    } else {
      formBody = new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: obj.client_id,
        client_secret: obj.client_secret,
        refresh_token: obj.refresh_token,
      }).toString();
    }

    const resp = await smartRequest(tokenUri, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: formBody,
      timeoutMs: 12_000,
    });

    let data = null;
    try {
      data = resp.json();
    } catch {
      throw new Error(`OAuth2 Token 响应非 JSON (HTTP ${resp.status}): ${resp.text.slice(0, 180)}`);
    }

    if (!resp.ok || !data?.access_token) {
      const desc = data?.error_description || data?.error || resp.text.slice(0, 180);
      throw new Error(`Google OAuth2 鉴权失败 (HTTP ${resp.status}): ${desc}`);
    }

    const expiresInSec = Number(data.expires_in || 3599);
    cachedTokenState = {
      fingerprint: fp,
      accessToken: data.access_token,
      expiresAtMs: Date.now() + expiresInSec * 1000,
      inflight: null,
    };
    return data.access_token;
  })();

  cachedTokenState.fingerprint = fp;
  cachedTokenState.inflight = fetchPromise;

  try {
    return await fetchPromise;
  } catch (err) {
    cachedTokenState.inflight = null;
    throw err;
  }
}

let vertexReasoningEffortUnsupported = false;

export function buildVertexChatCompletionsUrl(projectId, location = DEFAULT_LOCATION) {
  const loc = String(location || DEFAULT_LOCATION).trim() || DEFAULT_LOCATION;
  const host = loc === 'global' ? 'aiplatform.googleapis.com' : `${loc}-aiplatform.googleapis.com`;
  return `https://${host}/v1/projects/${encodeURIComponent(projectId)}/locations/${encodeURIComponent(loc)}/endpoints/openapi/chat/completions`;
}

export function sanitizeSuggestion(rawContent) {
  if (!rawContent || typeof rawContent !== 'string') return '';
  let text = rawContent
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/```[\s\S]*?```/g, '')
    .trim();

  if (!text) return '';

  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('#'));

  if (lines.length === 0) return '';
  let picked = lines[0];

  picked = picked
    .replace(/^[-*•\d.)\s]+/, '')
    .replace(/^(下一步建议|下一条建议|建议输入|建议指令|推荐回复|推荐输入|用户回复|用户输入|Next prompt|Suggestion)\s*[:：]\s*/i, '')
    .trim();

  const quotePairs = [
    ['"', '"'],
    ["'", "'"],
    ['“', '”'],
    ['「', '」'],
    ['『', '』'],
    ['`', '`'],
  ];
  for (const [openQ, closeQ] of quotePairs) {
    if (picked.startsWith(openQ) && picked.endsWith(closeQ) && picked.length > openQ.length + closeQ.length) {
      picked = picked.slice(openQ.length, picked.length - closeQ.length).trim();
    }
  }

  if (!picked || /^(none|null|n\/a|无|无需回复|暂无建议)$/i.test(picked)) {
    return '';
  }

  if (picked.length > 96) {
    picked = picked.slice(0, 96).trim();
  }
  return picked;
}

const SYSTEM_PROMPT = `你是用户在 AI 编程助手（Antigravity）聊天输入框中的「下一句指令补全引擎」。
请站在【用户本人（第一人称“我”）】的视角，根据刚刚结束的对话上下文，预测用户看完 AI 最后一条回复后，最可能立即发送的【下一条简短指令】。

决策准则：
1. 若 AI 刚刚给出了技术方案/计划并询问确认（尚未编码）：直接生成确认并启动实现的指令（例如：确认方案，请按任务清单开始实现）。
2. 若 AI 提出了具体的澄清问题等待回答：生成最合理、最推进落地的一句确认或偏好选择。
3. 若 AI 刚刚完成了代码开发、修复或配置，但尚未执行完整验证/收尾：生成验证、测试或下一步迭代指令（例如：运行测试并验证实际效果是否有报错）。
4. 若 AI 汇报了报错或阻塞原因：生成继续深入排查修复或切换备选路径的指令。
5. 若整个功能已开发并验证完毕：可生成提交代码、补充文档或边缘场景自检等自然跟进指令。

输出格式铁律（极其重要）：
- 只输出【单行纯文本】，即用户将要直接放进输入框的那一句话（控制在 8～36 个汉字左右，保留必要的代码/命令英文词）。
- 严禁包含任何引号、序号、换行、Markdown 格式或“建议输入：”等解释性前缀！`;

export async function generateNextSuggestionFromMessages(contextSummaryText, overrideCfg = null) {
  const cfg = overrideCfg ? { ...loadConfig(), ...overrideCfg } : loadConfig();
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: contextSummaryText },
  ];

  const startMs = Date.now();

  if (cfg.provider === 'openai-compatible') {
    const apiKey = String(cfg.openaiApiKey || '').trim();
    const baseUrl = String(cfg.openaiBaseUrl || 'https://api.deepseek.com/v1').replace(/\/+$/, '');
    const model = String(cfg.openaiModel || 'deepseek-chat').trim();
    if (!apiKey) {
      throw new Error('尚未填写 OpenAI 兼容 API Key');
    }
    const endpoint = baseUrl.endsWith('/chat/completions') ? baseUrl : `${baseUrl}/chat/completions`;
    const resp = await smartRequest(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model, messages, max_tokens: 256, temperature: 0.3 }),
      timeoutMs: 16_000,
    });
    let body = null;
    try {
      body = resp.json();
    } catch {
      throw new Error(`接口返回非 JSON (HTTP ${resp.status}): ${resp.text.slice(0, 160)}`);
    }
    if (!resp.ok) {
      throw new Error(body?.error?.message || `请求失败 (HTTP ${resp.status}): ${resp.text.slice(0, 160)}`);
    }
    const rawMsg = body?.choices?.[0]?.message?.content || '';
    return {
      suggestion: sanitizeSuggestion(rawMsg),
      rawContent: rawMsg,
      latencyMs: Date.now() - startMs,
      endpoint,
      model,
      projectId: '',
    };
  }

  const cred = overrideCfg?.rawCredentialJson
    ? parseAndValidateGoogleCredentials(overrideCfg.rawCredentialJson)
    : loadSavedCredentials();
  if (!cred || !cred.valid) {
    throw new Error('尚未导入 Google Cloud Service Account JSON 凭证');
  }

  const projectId = String(cfg.projectId || cred.projectId || '').trim();
  if (!projectId) {
    throw new Error('未识别到 GCP Project ID，请在凭证或设置中填写 Project ID');
  }

  const location = String(cfg.location || DEFAULT_LOCATION).trim() || DEFAULT_LOCATION;
  const model = String(cfg.model || DEFAULT_MODEL).trim() || DEFAULT_MODEL;
  const endpoint = buildVertexChatCompletionsUrl(projectId, location);
  const accessToken = await getGoogleAccessToken(cred);

  const reqHeaders = {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
  if (cred.credentialType === 'authorized_user') {
    reqHeaders['x-goog-user-project'] = projectId;
  }

  const isDeepSeekV4 = /deepseek-v4/i.test(model);
  const sendCompletion = async (includeLowReasoning) => {
    const payload = {
      model,
      messages,
      max_tokens: 320,
      temperature: 0.3,
    };
    if (includeLowReasoning) {
      payload.reasoning_effort = 'low';
    }
    return await smartRequest(endpoint, {
      method: 'POST',
      headers: reqHeaders,
      body: JSON.stringify(payload),
      timeoutMs: 18_000,
    });
  };

  let resp = await sendCompletion(isDeepSeekV4 && !vertexReasoningEffortUnsupported);
  if (!resp.ok && resp.status === 400 && isDeepSeekV4 && !vertexReasoningEffortUnsupported) {
    vertexReasoningEffortUnsupported = true;
    resp = await sendCompletion(false);
  }

  let body = null;
  try {
    body = resp.json();
  } catch {
    throw new Error(`Vertex AI 返回非 JSON (HTTP ${resp.status}): ${resp.text.slice(0, 200)}`);
  }

  if (!resp.ok) {
    const errMsg =
      body?.error?.message ||
      (Array.isArray(body) && body[0]?.error?.message) ||
      resp.text.slice(0, 220);
    throw new Error(`Vertex AI 调用失败 (HTTP ${resp.status}): ${errMsg}`);
  }

  const msgObj = body?.choices?.[0]?.message || {};
  const rawContent = typeof msgObj.content === 'string' ? msgObj.content : '';

  return {
    suggestion: sanitizeSuggestion(rawContent),
    rawContent,
    latencyMs: Date.now() - startMs,
    endpoint,
    model,
    projectId,
  };
}
