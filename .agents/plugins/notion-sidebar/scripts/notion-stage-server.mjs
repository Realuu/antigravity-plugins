#!/usr/bin/env node
/**
 * Antigravity Notion Stage Server (127.0.0.1:45793)
 *
 * 作用：
 * 1. 基于标准 OAuth 2.1 + PKCE + Dynamic Client Registration (RFC 7591)
 *    直连官方 Notion Hosted MCP（https://mcp.notion.com/mcp）；
 * 2. 自动维护 Token 持久化与并发安全的 Refresh Token 刷新；
 * 3. 封装 MCP Streamable HTTP（JSON + SSE）客户端，向前端工作台提供高速 REST API；
 * 4. 托管 Codex 风格 Notion 工作台 Web App（/workbench）。
 */
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import http, { createServer } from 'node:http';
import https from 'node:https';
import { homedir } from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { fileURLToPath, URL } from 'node:url';
import zlib from 'node:zlib';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const HOST = '127.0.0.1';
const PORT = Number(process.env.AGY_NOTION_STAGE_PORT || 45793);
const ORIGIN = `http://${HOST}:${PORT}`;
const REDIRECT_URI = `${ORIGIN}/oauth/callback`;
const MCP_URL = 'https://mcp.notion.com/mcp';
const MCP_RESOURCE = 'https://mcp.notion.com';
const OAUTH_AUTH_SERVER_WELL_KNOWN = 'https://mcp.notion.com/.well-known/oauth-authorization-server';
const OAUTH_PROTECTED_RESOURCE_WELL_KNOWN = 'https://mcp.notion.com/.well-known/oauth-protected-resource';
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const SERVER_VERSION = '1.0.0';

function resolveAppDataDir() {
  const envDir = process.env.ANTIGRAVITY_APP_DATA_DIR?.trim();
  if (envDir) return envDir;
  return path.join(homedir(), '.gemini', 'antigravity');
}

const DATA_DIR = path.join(resolveAppDataDir(), 'sidecar_data', 'notion');
const OAUTH_STATE_FILE = path.join(DATA_DIR, 'oauth-state.json');
const PID_FILE = path.join(DATA_DIR, 'stage_server.json');
const WORKBENCH_HTML_PATH = path.join(__dirname, 'notion-workbench.html');
const ASSETS_DIR = path.resolve(__dirname, '..', 'assets');
const PROJECTS_CONFIG_DIR = path.join(homedir(), '.gemini', 'config', 'projects');
const DEFAULT_NOTION_PROJECT_ID = 'a8f4c2d1-6b3e-4e9a-8c5f-2b7e9d1a4c60';
const DEFAULT_NOTION_PROJECT_NAME = 'Notion';
const DEFAULT_NOTION_PROJECT_DIR = path.join(homedir(), 'Documents', 'Notion');

try {
  mkdirSync(DATA_DIR, { recursive: true });
} catch {}

function localPathToFileUri(localPath) {
  const norm = path.resolve(localPath).replace(/\\/g, '/');
  // Windows 盘符 C:/... -> file:///c%3A/...（与 Antigravity 现有 projects/*.json 格式完全一致）
  const winMatch = norm.match(/^([A-Za-z]):\/(.*)$/);
  if (winMatch) {
    const drive = winMatch[1].toLowerCase();
    const rest = winMatch[2]
      .split('/')
      .map((seg) => encodeURIComponent(seg))
      .join('/');
    return `file:///${drive}%3A/${rest}`;
  }
  const rest = norm
    .replace(/^\/+/, '')
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/');
  return `file:///${rest}`;
}

function listRegisteredAntigravityProjects() {
  const list = [];
  try {
    if (!existsSync(PROJECTS_CONFIG_DIR)) return list;
    for (const file of readdirSync(PROJECTS_CONFIG_DIR)) {
      if (!file.endsWith('.json')) continue;
      try {
        const obj = JSON.parse(readFileSync(path.join(PROJECTS_CONFIG_DIR, file), 'utf8'));
        if (!obj || !obj.id || !obj.name) continue;
        // 跳过纯 sidecar 内部项目
        if (obj.sidecar) continue;
        list.push({
          id: String(obj.id),
          name: String(obj.name),
          file,
        });
      } catch {}
    }
  } catch {}
  return list;
}

function ensureNotionAntigravityProject() {
  const existingList = listRegisteredAntigravityProjects();
  const matched = existingList.find(
    (p) => p.name.trim().toLowerCase() === DEFAULT_NOTION_PROJECT_NAME.toLowerCase()
  );
  if (matched) {
    return {
      id: matched.id,
      name: matched.name,
      dir: DEFAULT_NOTION_PROJECT_DIR,
      created: false,
      knownProjectNames: [...new Set(existingList.map((p) => p.name))],
    };
  }

  try {
    mkdirSync(DEFAULT_NOTION_PROJECT_DIR, { recursive: true });
    const readmePath = path.join(DEFAULT_NOTION_PROJECT_DIR, 'README.md');
    if (!existsSync(readmePath)) {
      writeFileSync(
        readmePath,
        '# Notion 笔记协作项目\n\n本目录用于承载在 Antigravity Notion 侧栏工作台中发起的笔记问答与协作会话，使知识问答与代码开发项目的会话记录保持分离。\n',
        'utf8'
      );
    }
    mkdirSync(PROJECTS_CONFIG_DIR, { recursive: true });
    const projFile = path.join(PROJECTS_CONFIG_DIR, `${DEFAULT_NOTION_PROJECT_ID}.json`);
    const projJson = {
      id: DEFAULT_NOTION_PROJECT_ID,
      name: DEFAULT_NOTION_PROJECT_NAME,
      projectResources: {
        resources: [
          {
            folderUri: localPathToFileUri(DEFAULT_NOTION_PROJECT_DIR),
          },
        ],
      },
      permissionGrants: {
        v2Migrated: true,
      },
      settings: {},
      isWorkspaceOnly: false,
    };
    writeFileSync(projFile, JSON.stringify(projJson), 'utf8');
    const refreshed = listRegisteredAntigravityProjects();
    return {
      id: DEFAULT_NOTION_PROJECT_ID,
      name: DEFAULT_NOTION_PROJECT_NAME,
      dir: DEFAULT_NOTION_PROJECT_DIR,
      created: true,
      knownProjectNames: [...new Set(refreshed.map((p) => p.name))],
    };
  } catch (err) {
    return {
      id: DEFAULT_NOTION_PROJECT_ID,
      name: DEFAULT_NOTION_PROJECT_NAME,
      dir: DEFAULT_NOTION_PROJECT_DIR,
      created: false,
      error: err?.message || String(err),
      knownProjectNames: [...new Set(existingList.map((p) => p.name))],
    };
  }
}

const initialNotionProject = ensureNotionAntigravityProject();

let cachedSqliteModule = undefined;
async function getSqliteModule() {
  if (cachedSqliteModule !== undefined) return cachedSqliteModule;
  try {
    cachedSqliteModule = await import('node:sqlite');
  } catch {
    cachedSqliteModule = null;
  }
  return cachedSqliteModule;
}

function loadPinnedConversationIds() {
  const candidates = [];
  if (process.env.APPDATA) {
    candidates.push(path.join(process.env.APPDATA, 'Antigravity', 'app_storage.json'));
  }
  candidates.push(
    path.join(homedir(), 'AppData', 'Roaming', 'Antigravity', 'app_storage.json'),
    path.join(homedir(), '.config', 'Antigravity', 'app_storage.json'),
    path.join(homedir(), 'Library', 'Application Support', 'Antigravity', 'app_storage.json')
  );
  for (const file of candidates) {
    try {
      if (!existsSync(file)) continue;
      const st = JSON.parse(readFileSync(file, 'utf8'));
      const raw = st?.pinned_conversations_order;
      const arr = typeof raw === 'string' ? JSON.parse(raw) : Array.isArray(raw) ? raw : [];
      if (Array.isArray(arr)) {
        return arr.map((x) => String(x || '').trim()).filter(Boolean);
      }
    } catch {}
  }
  return [];
}

function extractWorkspaceFolderName(workspaceUrisRaw) {
  try {
    const arr = typeof workspaceUrisRaw === 'string' ? JSON.parse(workspaceUrisRaw) : workspaceUrisRaw;
    const first = Array.isArray(arr) && arr[0] ? decodeURIComponent(String(arr[0])) : '';
    if (!first) return '';
    const cleaned = first.replace(/^file:\/\/\/?/i, '').replace(/\/+$/, '');
    const segs = cleaned.split(/[\\/]/).filter(Boolean);
    return segs[segs.length - 1] || '';
  } catch {
    return '';
  }
}

function sanitizeConvoSummaryTitle(rawTitle, rawPreview) {
  const base = String(rawTitle || rawPreview || '')
    .replace(/\[Notion Page Context:\s*\{[\s\S]*?\}\]/g, '')
    .replace(/\[Cowart Workspace Context:\s*\{[\s\S]*?\}\]/g, '')
    .replace(/我当前选中的笔记片段：[\s\S]*$/g, '')
    .trim();
  const firstLine = base.split(/\r?\n/).find((l) => l.trim())?.trim() || '未命名会话';
  return firstLine.length > 72 ? `${firstLine.slice(0, 72)}…` : firstLine;
}

async function queryLocalAntigravityConversations({ q = '', limit = 60 } = {}) {
  const pinnedIds = loadPinnedConversationIds();
  const pinnedOrderMap = new Map(pinnedIds.map((id, idx) => [id, idx]));
  const projects = listRegisteredAntigravityProjects();
  const projectMap = new Map(projects.map((p) => [p.id, p.name]));

  const dbPath = path.join(resolveAppDataDir(), 'conversation_summaries.db');
  const sqlite = await getSqliteModule();
  if (!sqlite?.DatabaseSync || !existsSync(dbPath)) {
    return { pinned: [], recent: [] };
  }

  let db = null;
  try {
    db = new sqlite.DatabaseSync(dbPath, { open: true, readOnly: true });
    const recentRows = db
      .prepare(
        `SELECT conversation_id, title, preview, project_id, workspace_uris, last_modified_time
         FROM conversation_summaries
         WHERE nesting_depth = 0 AND parent_conversation_id = '' AND killed = 0
         ORDER BY last_modified_time DESC
         LIMIT 280`
      )
      .all();

    const byId = new Map();
    for (const r of recentRows) {
      if (r && r.conversation_id) byId.set(String(r.conversation_id), r);
    }

    const missingPinned = pinnedIds.filter((id) => !byId.has(id)).slice(0, 50);
    if (missingPinned.length > 0) {
      const placeholders = missingPinned.map(() => '?').join(',');
      const extraRows = db
        .prepare(
          `SELECT conversation_id, title, preview, project_id, workspace_uris, last_modified_time
           FROM conversation_summaries
           WHERE conversation_id IN (${placeholders}) AND killed = 0`
        )
        .all(...missingPinned);
      for (const r of extraRows) {
        if (r && r.conversation_id) byId.set(String(r.conversation_id), r);
      }
    }

    const keyword = String(q || '').trim().toLowerCase();
    const pinned = [];
    const recent = [];

    for (const [id, row] of byId.entries()) {
      const title = sanitizeConvoSummaryTitle(row.title, row.preview);
      const projectId = String(row.project_id || '');
      const projectName = projectMap.get(projectId) || extractWorkspaceFolderName(row.workspace_uris) || '';
      const isPinned = pinnedOrderMap.has(id);

      if (keyword) {
        const hay = `${title}\n${projectName}`.toLowerCase();
        if (!hay.includes(keyword)) continue;
      }

      const entry = {
        id,
        path: `/c/${id}`,
        title,
        projectId,
        projectName,
        pinned: isPinned,
        updatedAt: String(row.last_modified_time || ''),
      };

      if (isPinned) {
        pinned.push(entry);
      } else {
        recent.push(entry);
      }
    }

    pinned.sort((a, b) => (pinnedOrderMap.get(a.id) ?? 9999) - (pinnedOrderMap.get(b.id) ?? 9999));
    return {
      pinned,
      recent: recent.slice(0, limit),
    };
  } catch (err) {
    return { pinned: [], recent: [], warning: err?.message || String(err) };
  } finally {
    try {
      db?.close();
    } catch {}
  }
}

class AuthRequiredError extends Error {
  constructor(message = '需要先连接 Notion 账号') {
    super(message);
    this.name = 'AuthRequiredError';
    this.code = 'AUTH_REQUIRED';
  }
}

// --- 1. 状态持久化 ---
function loadPersistedState() {
  try {
    if (!existsSync(OAUTH_STATE_FILE)) return {};
    const parsed = JSON.parse(readFileSync(OAUTH_STATE_FILE, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function savePersistedState(next) {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(OAUTH_STATE_FILE, JSON.stringify(next, null, 2), { encoding: 'utf8', mode: 0o600 });
  } catch (err) {
    console.error('[notion-stage] 保存 oauth-state 失败:', err?.message || err);
  }
}

let persisted = loadPersistedState();
const pendingAuthFlows = new Map(); // state -> { codeVerifier, createdAt }
let oauthMetadataCache = null;
let oauthMetadataFetchedAt = 0;
let refreshPromise = null;

// MCP 会话状态
let mcpSessionId = '';
let mcpInitPromise = null;
let mcpToolMap = new Map(); // normalizedName -> exactToolName
let rpcSeq = 1;

// 轻量内存缓存（加速首页与面包屑匹配）
let homeCache = { at: 0, data: null };
const pageTitleUrlIndex = new Map(); // lowerTitle -> { id, url, title }

function resetMcpSession() {
  mcpSessionId = '';
  mcpInitPromise = null;
  mcpToolMap = new Map();
}

function invalidateHomeCache() {
  homeCache = { at: 0, data: null };
}

function indexPageRecord(item) {
  if (!item || !item.title || !item.url) return;
  const key = String(item.title).trim().toLowerCase();
  if (!key) return;
  const id = extractPageId(item.id || item.url);
  pageTitleUrlIndex.set(key, {
    id,
    url: item.url,
    title: item.title,
  });
}

// --- 2. 通用辅助函数 ---
function base64UrlEncode(buf) {
  return Buffer.from(buf)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function generatePkcePair() {
  const codeVerifier = base64UrlEncode(crypto.randomBytes(32));
  const codeChallenge = base64UrlEncode(crypto.createHash('sha256').update(codeVerifier).digest());
  return { codeVerifier, codeChallenge };
}

function extractPageId(input) {
  const str = String(input || '').trim();
  if (!str) return '';
  // UUID 格式（带连字符）
  const uuidMatch = str.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  if (uuidMatch) return uuidMatch[0].toLowerCase();
  // Notion 32 位无连字符 hex（常见于 URL 末尾或 /p/32hex）
  const hexMatches = str.match(/[0-9a-f]{32}/gi);
  if (hexMatches && hexMatches.length > 0) {
    const raw = hexMatches[hexMatches.length - 1].toLowerCase();
    return `${raw.slice(0, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}-${raw.slice(16, 20)}-${raw.slice(20)}`;
  }
  return str;
}

function toCompactId(uuid) {
  return String(uuid || '').replace(/-/g, '').toLowerCase();
}

function buildCanonicalNotionUrl(idOrUrl) {
  const str = String(idOrUrl || '').trim();
  if (/^https?:\/\/(www\.notion\.so|app\.notion\.com|[^/]+\.notion\.site)\//i.test(str)) {
    return str;
  }
  const id = extractPageId(str);
  if (/^[0-9a-f-]{36}$/i.test(id)) {
    return `https://www.notion.so/${toCompactId(id)}`;
  }
  return 'https://www.notion.so';
}

function looksLikeNotionUrl(text) {
  const s = String(text || '').trim();
  return /^https?:\/\/([^/]+\.)?(notion\.so|notion\.com|notion\.site)\//i.test(s);
}

// --- 2.5 自动兼容环境变量与 Windows 系统代理的原生 HTTPS 请求封装 ---
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
  if (process.platform !== 'win32') return '';
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
    const connectHeaders = {
      Host: `${targetHost}:${targetPort}`,
    };
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
        reject(new Error(`代理 CONNECT 隧道建立失败 (${res.statusCode})`));
        return;
      }
      resolve(socket);
    });
    req.on('timeout', () => {
      req.destroy(new Error('代理 CONNECT 超时'));
    });
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
    const timeoutMs = Number(options.timeoutMs || 30_000);
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
          isHttps
            ? tls.connect({ socket: tunnelSocket, servername: u.hostname })
            : tunnelSocket;
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
          const lowerHeaders = {};
          for (const [k, v] of Object.entries(res.headers || {})) {
            lowerHeaders[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : String(v ?? '');
          }
          const status = res.statusCode || 0;
          resolve({
            ok: status >= 200 && status < 300,
            status,
            headers: {
              get(name) {
                return lowerHeaders[String(name || '').toLowerCase()] ?? null;
              },
            },
            async buffer() {
              return rawBuf;
            },
            async text() {
              return rawBuf.toString('utf8');
            },
            async json() {
              return JSON.parse(rawBuf.toString('utf8'));
            },
          });
        });
        res.on('error', reject);
      });
      req.on('timeout', () => req.destroy(new Error(`请求超时 (${timeoutMs}ms)`)));
      req.on('error', reject);
      if (bodyBuf) req.write(bodyBuf);
      req.end();
    };

    if (proxyUrl && isHttps) {
      openConnectTunnel(proxyUrl, u.hostname, port, timeoutMs)
        .then((sock) => runWithSocket(sock))
        .catch(reject);
    } else {
      runWithSocket(null);
    }
  });
}

function isAllowedMediaHost(hostname) {
  const h = String(hostname || '').toLowerCase();
  return (
    h === 'prod-files-secure.s3.us-west-2.amazonaws.com' ||
    h.endsWith('.amazonaws.com') ||
    h === 'www.notion.so' ||
    h.endsWith('.notion.so') ||
    h.endsWith('.notion.site') ||
    h.endsWith('.notion-static.com') ||
    h === 'images.unsplash.com'
  );
}

async function fetchMediaWithRedirect(rawUrl, maxRedirects = 3) {
  let current = rawUrl;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const u = new URL(current);
    if ((u.protocol !== 'https:' && u.protocol !== 'http:') || !isAllowedMediaHost(u.hostname)) {
      throw new Error('不允许代理该媒体域名');
    }
    const resp = await notionFetch(current, {
      method: 'GET',
      headers: { Accept: 'image/*,*/*;q=0.8' },
      timeoutMs: 25_000,
    });
    const loc = resp.headers.get('location');
    if ([301, 302, 303, 307, 308].includes(resp.status) && loc) {
      current = new URL(loc, current).toString();
      continue;
    }
    return resp;
  }
  throw new Error('媒体重定向次数过多');
}

async function notionFetch(targetUrl, options = {}) {
  const proxyUrl = resolveHttpProxyUrl();
  if (proxyUrl) {
    try {
      return await sendHttpsRequestOnce(targetUrl, options, proxyUrl);
    } catch (err) {
      // 如果本地代理端口刚好关闭，自动回退直连重试一次
      if (err?.code === 'ECONNREFUSED' || err?.code === 'EHOSTUNREACH') {
        return await sendHttpsRequestOnce(targetUrl, options, '');
      }
      throw err;
    }
  }
  return await sendHttpsRequestOnce(targetUrl, options, '');
}

// --- 3. OAuth 2.1 + PKCE + Dynamic Client Registration ---
async function getOAuthMetadata() {
  const now = Date.now();
  if (oauthMetadataCache && now - oauthMetadataFetchedAt < 3600_000) {
    return oauthMetadataCache;
  }
  const fallback = {
    issuer: 'https://mcp.notion.com',
    authorization_endpoint: 'https://mcp.notion.com/authorize',
    token_endpoint: 'https://mcp.notion.com/token',
    registration_endpoint: 'https://mcp.notion.com/register',
    scopes_supported: ['default'],
    resource: MCP_RESOURCE,
  };
  try {
    const [authRes, prRes] = await Promise.all([
      notionFetch(OAUTH_AUTH_SERVER_WELL_KNOWN, { headers: { Accept: 'application/json' } }),
      notionFetch(OAUTH_PROTECTED_RESOURCE_WELL_KNOWN, { headers: { Accept: 'application/json' } }).catch(() => null),
    ]);
    const authMeta = authRes.ok ? await authRes.json() : {};
    const prMeta = prRes && prRes.ok ? await prRes.json() : {};
    oauthMetadataCache = {
      ...fallback,
      ...authMeta,
      resource: prMeta?.resource || fallback.resource,
    };
    oauthMetadataFetchedAt = now;
    return oauthMetadataCache;
  } catch {
    return oauthMetadataCache || fallback;
  }
}

async function ensureRegisteredClient(meta) {
  if (
    persisted.client &&
    persisted.client.client_id &&
    persisted.client.redirect_uri === REDIRECT_URI
  ) {
    return persisted.client;
  }

  const regResp = await notionFetch(meta.registration_endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      client_name: 'Antigravity Notion Workspace',
      redirect_uris: [REDIRECT_URI],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }),
  });

  const regText = await regResp.text();
  if (!regResp.ok) {
    throw new Error(`Notion OAuth 客户端注册失败 (${regResp.status}): ${regText.slice(0, 240)}`);
  }
  const data = JSON.parse(regText);
  if (!data || !data.client_id) {
    throw new Error('Notion OAuth 客户端注册未返回 client_id');
  }

  const client = {
    client_id: data.client_id,
    client_secret: data.client_secret || '',
    token_endpoint_auth_method: data.token_endpoint_auth_method || (data.client_secret ? 'client_secret_post' : 'none'),
    redirect_uri: REDIRECT_URI,
    registered_at: Date.now(),
  };
  persisted = { ...persisted, client };
  savePersistedState(persisted);
  return client;
}

async function startOAuthFlow() {
  const meta = await getOAuthMetadata();
  const client = await ensureRegisteredClient(meta);

  // 清理 15 分钟以上的过期 state
  const cutoff = Date.now() - 15 * 60_000;
  for (const [k, v] of pendingAuthFlows.entries()) {
    if (v.createdAt < cutoff) pendingAuthFlows.delete(k);
  }

  const state = crypto.randomBytes(24).toString('hex');
  const { codeVerifier, codeChallenge } = generatePkcePair();
  pendingAuthFlows.set(state, { codeVerifier, createdAt: Date.now() });

  const authUrl = new URL(meta.authorization_endpoint);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('client_id', client.client_id);
  authUrl.searchParams.set('redirect_uri', REDIRECT_URI);
  authUrl.searchParams.set('code_challenge', codeChallenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');
  authUrl.searchParams.set('state', state);
  authUrl.searchParams.set('scope', 'default');
  if (meta.resource) {
    authUrl.searchParams.set('resource', meta.resource);
  }

  return {
    ok: true,
    authUrl: authUrl.toString(),
    state,
  };
}

function applyTokenClientAuth(headers, params, client) {
  const method = client.token_endpoint_auth_method || (client.client_secret ? 'client_secret_post' : 'none');
  if (client.client_secret && method === 'client_secret_basic') {
    const basic = Buffer.from(`${client.client_id}:${client.client_secret}`).toString('base64');
    headers.Authorization = `Basic ${basic}`;
  } else {
    params.set('client_id', client.client_id);
    if (client.client_secret) {
      params.set('client_secret', client.client_secret);
    }
  }
}

async function exchangeCodeForTokens(code, state) {
  const pending = pendingAuthFlows.get(state);
  if (!pending) {
    throw new Error('授权状态已过期或无效，请回到 Antigravity 重新点击「连接 Notion」。');
  }
  pendingAuthFlows.delete(state);

  const meta = await getOAuthMetadata();
  const client = persisted.client;
  if (!client || !client.client_id) {
    throw new Error('缺少已注册的 OAuth 客户端信息，请重新发起连接。');
  }

  const headers = {
    'Content-Type': 'application/x-www-form-urlencoded',
    Accept: 'application/json',
  };
  const params = new URLSearchParams();
  params.set('grant_type', 'authorization_code');
  params.set('code', code);
  params.set('redirect_uri', REDIRECT_URI);
  params.set('code_verifier', pending.codeVerifier);
  if (meta.resource) {
    params.set('resource', meta.resource);
  }
  applyTokenClientAuth(headers, params, client);

  const resp = await notionFetch(meta.token_endpoint, {
    method: 'POST',
    headers,
    body: params.toString(),
  });
  const text = await resp.text();
  if (!resp.ok) {
    throw new Error(`换取访问令牌失败 (${resp.status}): ${text.slice(0, 260)}`);
  }
  const tok = JSON.parse(text);
  if (!tok || !tok.access_token) {
    throw new Error('Notion OAuth 未返回有效的 access_token');
  }

  const expiresIn = Number(tok.expires_in || 3600);
  const tokens = {
    access_token: tok.access_token,
    refresh_token: tok.refresh_token || '',
    token_type: tok.token_type || 'Bearer',
    scope: tok.scope || 'default',
    expires_at: Date.now() + Math.max(60, expiresIn) * 1000,
    updated_at: Date.now(),
  };

  persisted = { ...persisted, tokens };
  savePersistedState(persisted);
  resetMcpSession();
  invalidateHomeCache();

  // 立即拉取当前用户信息写入缓存
  try {
    const selfInfo = await callNotionTool('get-self', {});
    if (selfInfo && typeof selfInfo === 'object') {
      persisted = { ...persisted, self: selfInfo };
      savePersistedState(persisted);
    }
  } catch (err) {
    console.warn('[notion-stage] 登录后获取 self 信息失败:', err?.message || err);
  }

  return tokens;
}

async function refreshAccessToken() {
  if (refreshPromise) return refreshPromise;
  refreshPromise = (async () => {
    const tokens = persisted.tokens;
    const client = persisted.client;
    if (!tokens?.refresh_token || !client?.client_id) {
      clearTokensOnly();
      throw new AuthRequiredError('Notion 登录态已失效，请重新授权连接。');
    }

    const meta = await getOAuthMetadata();
    const headers = {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    };
    const params = new URLSearchParams();
    params.set('grant_type', 'refresh_token');
    params.set('refresh_token', tokens.refresh_token);
    if (meta.resource) {
      params.set('resource', meta.resource);
    }
    applyTokenClientAuth(headers, params, client);

    const resp = await notionFetch(meta.token_endpoint, {
      method: 'POST',
      headers,
      body: params.toString(),
    });
    const text = await resp.text();
    if (!resp.ok) {
      clearTokensOnly();
      throw new AuthRequiredError(`Notion 授权刷新失败 (${resp.status})，请重新连接。`);
    }
    const tok = JSON.parse(text);
    if (!tok || !tok.access_token) {
      clearTokensOnly();
      throw new AuthRequiredError('Notion 授权刷新未返回新令牌，请重新连接。');
    }
    const expiresIn = Number(tok.expires_in || 3600);
    const nextTokens = {
      access_token: tok.access_token,
      refresh_token: tok.refresh_token || tokens.refresh_token,
      token_type: tok.token_type || 'Bearer',
      scope: tok.scope || tokens.scope || 'default',
      expires_at: Date.now() + Math.max(60, expiresIn) * 1000,
      updated_at: Date.now(),
    };
    persisted = { ...persisted, tokens: nextTokens };
    savePersistedState(persisted);
    return nextTokens.access_token;
  })();

  try {
    return await refreshPromise;
  } finally {
    refreshPromise = null;
  }
}

function clearTokensOnly() {
  const { tokens: _t, self: _s, ...rest } = persisted;
  persisted = rest;
  savePersistedState(persisted);
  resetMcpSession();
  invalidateHomeCache();
}

async function getValidAccessToken(forceRefresh = false) {
  const tokens = persisted.tokens;
  if (!tokens || !tokens.access_token) {
    throw new AuthRequiredError('尚未连接 Notion 账号');
  }
  const nearExpiry = tokens.expires_at && Date.now() > Number(tokens.expires_at) - 120_000;
  if (forceRefresh || nearExpiry) {
    if (tokens.refresh_token) {
      return await refreshAccessToken();
    }
    if (forceRefresh) {
      clearTokensOnly();
      throw new AuthRequiredError('Notion 访问令牌已过期，请重新连接。');
    }
  }
  return tokens.access_token;
}

// --- 4. MCP Streamable HTTP 客户端 ---
function parseSseMessages(sseText) {
  const messages = [];
  const blocks = String(sseText || '').split(/\r?\n\r?\n/);
  for (const block of blocks) {
    const lines = block.split(/\r?\n/);
    const dataLines = [];
    for (const line of lines) {
      if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).trimStart());
      }
    }
    if (dataLines.length === 0) continue;
    const payload = dataLines.join('\n').trim();
    if (!payload || payload === '[DONE]') continue;
    try {
      messages.push(JSON.parse(payload));
    } catch {}
  }
  return messages;
}

async function sendMcpRaw(bodyObj, accessToken, includeSession = true) {
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    'MCP-Protocol-Version': '2025-03-26',
  };
  if (includeSession && mcpSessionId) {
    headers['Mcp-Session-Id'] = mcpSessionId;
  }

  const resp = await notionFetch(MCP_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify(bodyObj),
  });

  const sid = resp.headers.get('mcp-session-id');
  if (sid) mcpSessionId = sid;

  if (resp.status === 202 || resp.status === 204) {
    return { status: resp.status, data: null };
  }

  const contentType = (resp.headers.get('content-type') || '').toLowerCase();
  const rawText = await resp.text();

  if (!resp.ok) {
    const err = new Error(`Notion MCP HTTP ${resp.status}: ${rawText.slice(0, 260)}`);
    err.status = resp.status;
    throw err;
  }

  if (contentType.includes('text/event-stream')) {
    const msgs = parseSseMessages(rawText);
    const matched = bodyObj.id !== undefined
      ? msgs.find((m) => m && m.id === bodyObj.id) || msgs[msgs.length - 1]
      : msgs[msgs.length - 1];
    return { status: resp.status, data: matched || null };
  }

  if (!rawText.trim()) {
    return { status: resp.status, data: null };
  }
  return { status: resp.status, data: JSON.parse(rawText) };
}

function normalizeToolKey(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/^notion[-_]/, '')
    .replace(/_/g, '-');
}

async function ensureMcpSession(accessToken) {
  if (mcpSessionId && mcpToolMap.size > 0) return;
  if (mcpInitPromise) return mcpInitPromise;

  mcpInitPromise = (async () => {
    mcpSessionId = '';
    const initId = rpcSeq++;
    const initResp = await sendMcpRaw(
      {
        jsonrpc: '2.0',
        id: initId,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: {
            name: 'antigravity-notion-sidebar',
            version: SERVER_VERSION,
          },
        },
      },
      accessToken,
      false
    );
    if (initResp.data?.error) {
      throw new Error(initResp.data.error.message || 'MCP initialize 失败');
    }

    // 发送 notifications/initialized
    await sendMcpRaw(
      {
        jsonrpc: '2.0',
        method: 'notifications/initialized',
        params: {},
      },
      accessToken,
      true
    ).catch(() => {});

    // 拉取真实工具清单，兼容带/不带 notion- 前缀
    const listId = rpcSeq++;
    const listResp = await sendMcpRaw(
      {
        jsonrpc: '2.0',
        id: listId,
        method: 'tools/list',
        params: {},
      },
      accessToken,
      true
    );
    const tools = listResp.data?.result?.tools;
    const nextMap = new Map();
    if (Array.isArray(tools)) {
      for (const t of tools) {
        if (!t || !t.name) continue;
        nextMap.set(t.name.toLowerCase(), t.name);
        nextMap.set(normalizeToolKey(t.name), t.name);
      }
    }
    mcpToolMap = nextMap;
  })();

  try {
    await mcpInitPromise;
  } finally {
    mcpInitPromise = null;
  }
}

function resolveRemoteToolName(logicalName) {
  const exact = mcpToolMap.get(String(logicalName).toLowerCase());
  if (exact) return exact;
  const norm = mcpToolMap.get(normalizeToolKey(logicalName));
  if (norm) return norm;
  // 常见别名兜底
  const aliases = {
    'get-self': ['notion-get-self', 'get-self', 'notion_get_self'],
    'list-recent-pages': ['notion-list-recent-pages', 'list-recent-pages'],
    'list-private-pages': ['notion-list-private-pages', 'list-private-pages'],
    'list-shared-pages': ['notion-list-shared-pages', 'list-shared-pages'],
    'list-favorite-pages': ['notion-list-favorite-pages', 'list-favorite-pages'],
    search: ['notion-search', 'search'],
    fetch: ['notion-fetch', 'fetch'],
    'create-pages': ['notion-create-pages', 'create-pages'],
    'update-page': ['notion-update-page', 'update-page'],
    'query-data-sources': ['notion-query-data-sources', 'query-data-sources'],
    'get-comments': ['notion-get-comments', 'get-comments'],
    'get-file-download-urls': ['notion-get-file-download-urls', 'get-file-download-urls'],
  };
  const candidates = aliases[normalizeToolKey(logicalName)] || [];
  for (const c of candidates) {
    if (mcpToolMap.has(c.toLowerCase())) return mcpToolMap.get(c.toLowerCase());
  }
  return logicalName.startsWith('notion-') ? logicalName : `notion-${logicalName}`;
}

function unwrapMcpToolResult(rpcData) {
  if (!rpcData) return null;
  if (rpcData.error) {
    const err = new Error(rpcData.error.message || JSON.stringify(rpcData.error));
    err.rpcCode = rpcData.error.code;
    throw err;
  }
  const result = rpcData.result;
  if (!result) return null;

  const contentList = Array.isArray(result.content) ? result.content : [];
  const textParts = [];
  for (const item of contentList) {
    if (item && item.type === 'text' && typeof item.text === 'string') {
      textParts.push(item.text);
    }
  }
  const combined = textParts.join('\n').trim();

  if (result.isError) {
    throw new Error(combined || 'Notion MCP 工具执行失败');
  }

  if (result.structuredContent && typeof result.structuredContent === 'object') {
    return result.structuredContent;
  }
  if (!combined) return {};
  try {
    return JSON.parse(combined);
  } catch {
    return { text: combined };
  }
}

async function callNotionTool(logicalName, args = {}, retryCount = 0) {
  let token = await getValidAccessToken(false);
  try {
    await ensureMcpSession(token);
    const toolName = resolveRemoteToolName(logicalName);
    const reqId = rpcSeq++;
    const resp = await sendMcpRaw(
      {
        jsonrpc: '2.0',
        id: reqId,
        method: 'tools/call',
        params: {
          name: toolName,
          arguments: args,
        },
      },
      token,
      true
    );
    return unwrapMcpToolResult(resp.data);
  } catch (err) {
    // 401 -> 尝试刷新令牌重试一次
    if (err?.status === 401 && retryCount < 1) {
      token = await getValidAccessToken(true);
      resetMcpSession();
      return callNotionTool(logicalName, args, retryCount + 1);
    }
    // 404 / Session 过期 -> 重建 MCP 会话重试一次
    const msg = String(err?.message || '');
    if (
      retryCount < 1 &&
      (err?.status === 404 ||
        msg.toLowerCase().includes('session') ||
        msg.toLowerCase().includes('not initialized'))
    ) {
      resetMcpSession();
      return callNotionTool(logicalName, args, retryCount + 1);
    }
    throw err;
  }
}

// --- 5. Notion 页面数据解析与规范化 ---
function extractNotionIcon(rawIcon, rawText = '') {
  const fromVal = (val) => {
    if (!val) return null;
    if (typeof val === 'string') {
      const s = val.trim();
      return s || null;
    }
    if (typeof val === 'object') {
      if (typeof val.emoji === 'string' && val.emoji.trim()) return val.emoji.trim();
      if (val.type === 'external' && val.external?.url) return String(val.external.url).trim();
      if (val.type === 'file' && val.file?.url) return String(val.file.url).trim();
      if (val.type === 'custom_emoji' && val.custom_emoji?.url) return String(val.custom_emoji.url).trim();
      if (val.url) return String(val.url).trim();
      if (val.icon) return fromVal(val.icon);
    }
    return null;
  };

  const direct = fromVal(rawIcon);
  if (direct) return direct;

  // 兜底从 <iconMetadata>...</iconMetadata> 或 <page ... icon="..."> 提取
  const metaMatch = String(rawText || '').match(/<iconMetadata>\s*([\s\S]*?)\s*<\/iconMetadata>/i);
  if (metaMatch && metaMatch[1] && metaMatch[1].trim() !== 'null') {
    try {
      const parsed = fromVal(JSON.parse(metaMatch[1]));
      if (parsed) return parsed;
    } catch {}
  }
  const pageIconMatch = String(rawText || '').match(/<page\b[^>]*\bicon="([^"]+)"/i);
  if (pageIconMatch && pageIconMatch[1]) {
    return pageIconMatch[1].trim();
  }
  return null;
}

function cleanPageTitle(rawTitle, properties, iconStr) {
  const propTitle =
    (typeof properties?.title === 'string' && properties.title.trim()) ||
    (typeof properties?.Name === 'string' && properties.Name.trim()) ||
    '';
  let title = String(propTitle || rawTitle || '')
    .replace(/\\([\\*_~`])/g, '$1')
    .trim();
  if (!title) {
    const firstTitleVal = Object.values(properties || {}).find((v) => typeof v === 'string' && v.trim());
    title = firstTitleVal ? String(firstTitleVal).trim() : '无标题页面';
  }
  // 如果标题依然以相同的 emoji 开头且页面已单独展示 icon，去除重复前缀
  if (iconStr && !/^https?:\/\//i.test(iconStr) && !iconStr.startsWith('icons/') && title.startsWith(iconStr)) {
    const stripped = title.slice(iconStr.length).trim();
    if (stripped) title = stripped;
  }
  return title;
}

function normalizePageCard(item) {
  if (!item || typeof item !== 'object') return null;
  const url = item.url ? buildCanonicalNotionUrl(item.url) : buildCanonicalNotionUrl(item.id);
  const id = extractPageId(item.id || item.url);
  const icon = extractNotionIcon(item.icon, '');
  let title = String(item.title || '无标题页面').replace(/\\([\\*_~`])/g, '$1').trim() || '无标题页面';
  if (icon && !/^https?:\/\//i.test(icon) && !icon.startsWith('icons/') && title.startsWith(icon)) {
    const stripped = title.slice(icon.length).trim();
    if (stripped) title = stripped;
  }
  const card = {
    id,
    url,
    title,
    type: item.type || 'page',
    icon,
    timestamp: item.timestamp || item.last_edited_time || item.page_last_edited_at || '',
    path: item.path || '',
    highlight: item.highlight || '',
  };
  indexPageRecord(card);
  return card;
}

function parseBreadcrumbs(rawText, rawPath) {
  const crumbs = [];
  const ancestorBlockMatch = String(rawText || '').match(/<ancestor-path>([\s\S]*?)<\/ancestor-path>/i);
  if (ancestorBlockMatch && ancestorBlockMatch[1].trim()) {
    const inner = ancestorBlockMatch[1];
    const tagRe = /<(?:ancestor|page|database)\b[^>]*url="([^"]+)"[^>]*>([\s\S]*?)<\/(?:ancestor|page|database)>/gi;
    let m;
    while ((m = tagRe.exec(inner)) !== null) {
      const url = m[1].trim();
      const title = m[2].replace(/<[^>]+>/g, '').trim();
      if (title) {
        crumbs.push({ title, url, id: extractPageId(url) });
      }
    }
  }
  if (crumbs.length === 0 && rawPath) {
    const parts = String(rawPath)
      .split(/\s*\/\s*/)
      .map((s) => s.trim())
      .filter(Boolean);
    for (const title of parts) {
      const indexed = pageTitleUrlIndex.get(title.toLowerCase());
      crumbs.push({
        title,
        url: indexed?.url || '',
        id: indexed?.id || '',
      });
    }
  }
  return crumbs;
}

function parseFetchedPage(raw, requestedId) {
  if (!raw || typeof raw !== 'object') {
    throw new Error('未能获取页面数据');
  }
  const text = String(raw.text || '');
  const id = extractPageId(raw.url || requestedId);
  const url = buildCanonicalNotionUrl(raw.url || id);

  let properties = {};
  const propMatch = text.match(/<properties>\s*([\s\S]*?)\s*<\/properties>/i);
  if (propMatch && propMatch[1]) {
    try {
      properties = JSON.parse(propMatch[1]);
    } catch {}
  }

  const icon = extractNotionIcon(raw.icon, text);
  const title = cleanPageTitle(raw.title, properties, icon);

  let markdown = '';
  const contentMatch = text.match(/<content>([\s\S]*?)<\/content>/i);
  if (contentMatch) {
    markdown = contentMatch[1].replace(/^\r?\n/, '').replace(/\r?\n$/, '');
  } else {
    markdown = text;
  }

  // 解析数据表 source（如果打开的是数据库页面）
  const dataSources = [];
  const dsRe = /<data-source\b[^>]*url="([^"]+)"[^>]*>([\s\S]*?)<\/data-source>/gi;
  let dsm;
  while ((dsm = dsRe.exec(text)) !== null) {
    dataSources.push({ url: dsm[1], preview: dsm[2].trim() });
  }

  const references = raw.references && typeof raw.references === 'object' ? raw.references : {};
  const breadcrumbs = parseBreadcrumbs(text, raw.path || '');

  // 建立标题索引，便于子页面面包屑跳转
  indexPageRecord({ id, url, title });
  const childPageRe = /<(?:page|database)\b[^>]*url="([^"]+)"[^>]*>([\s\S]*?)<\/(?:page|database)>/gi;
  let cm;
  while ((cm = childPageRe.exec(markdown)) !== null) {
    const childUrl = cm[1].trim();
    const childTitle = cm[2].replace(/<[^>]+>/g, '').trim();
    if (childTitle && childUrl) {
      indexPageRecord({ id: extractPageId(childUrl), url: childUrl, title: childTitle });
    }
  }

  return {
    id,
    url,
    title,
    type: raw.metadata?.type || (dataSources.length > 0 ? 'database' : 'page'),
    icon,
    cover: raw.cover ?? null,
    fullWidth: Boolean(raw.full_width),
    lastEditedAt: raw.page_last_edited_at || '',
    path: raw.path || '',
    breadcrumbs,
    properties,
    markdown,
    references,
    dataSources,
    truncated: Boolean(raw.truncated),
  };
}

// --- 6. HTTP 请求与路由处理 ---
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('请求体过大'));
        try { req.destroy(); } catch {}
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('无效的 JSON 请求体'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(body);
}

function sendHtml(res, status, html) {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(html);
}

function renderOAuthResultPage(ok, title, detail) {
  const accent = ok ? '#10b981' : '#ef4444';
  const icon = ok ? '✓' : '!';
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>${title} - Antigravity Notion</title>
<style>
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
    font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;
    background:#f7f8fa; color:#0f172a; }
  .card { width:min(420px,90vw); background:#fff; border:1px solid rgba(15,23,42,.08); border-radius:20px;
    padding:32px 28px; text-align:center; box-shadow:0 18px 45px -16px rgba(15,23,42,.12); }
  .badge { width:52px; height:52px; margin:0 auto 16px; border-radius:999px; display:flex;
    align-items:center; justify-content:center; font-size:24px; font-weight:700; color:#fff; background:${accent}; }
  h1 { margin:0 0 8px; font-size:19px; font-weight:650; }
  p { margin:0; font-size:13.5px; line-height:1.6; color:#475569; word-break:break-word; }
  .hint { margin-top:18px; font-size:12px; color:#94a3b8; }
</style>
</head>
<body>
  <div class="card">
    <div class="badge">${icon}</div>
    <h1>${title}</h1>
    <p>${detail}</p>
    <div class="hint">${ok ? '你现在可以关闭此浏览器标签页，返回 Antigravity 即可自动刷新。' : '请关闭此页面并在 Antigravity 中重试连接。'}</div>
  </div>
  ${ok ? '<script>setTimeout(() => { try { window.close(); } catch {} }, 1600);</script>' : ''}
</body>
</html>`;
}

async function handleApiRequest(req, res, urlObj) {
  const pathname = urlObj.pathname;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end();
    return;
  }

  // 1. 静态工作台页面与本地静态资源（KaTeX 样式、脚本与离线数学字体）
  if (req.method === 'GET' && (pathname === '/' || pathname === '/workbench')) {
    if (!existsSync(WORKBENCH_HTML_PATH)) {
      sendHtml(res, 500, '<h1>未找到 notion-workbench.html</h1>');
      return;
    }
    const html = readFileSync(WORKBENCH_HTML_PATH, 'utf8');
    sendHtml(res, 200, html);
    return;
  }

  if (req.method === 'GET' && pathname.startsWith('/assets/')) {
    const rel = decodeURIComponent(pathname.slice('/assets/'.length));
    const targetFile = path.resolve(ASSETS_DIR, rel);
    if (!targetFile.startsWith(ASSETS_DIR + path.sep) || !existsSync(targetFile)) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('not found');
      return;
    }
    const ext = path.extname(targetFile).toLowerCase();
    const mimeMap = {
      '.css': 'text/css; charset=utf-8',
      '.js': 'application/javascript; charset=utf-8',
      '.mjs': 'application/javascript; charset=utf-8',
      '.woff2': 'font/woff2',
      '.woff': 'font/woff',
      '.ttf': 'font/ttf',
      '.svg': 'image/svg+xml',
      '.png': 'image/png',
    };
    const buf = readFileSync(targetFile);
    res.writeHead(200, {
      'Content-Type': mimeMap[ext] || 'application/octet-stream',
      'Cache-Control': 'public, max-age=86400',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(buf);
    return;
  }

  // 2. 健康检查
  if (req.method === 'GET' && pathname === '/api/health') {
    sendJson(res, 200, {
      ok: true,
      pid: process.pid,
      port: PORT,
      version: SERVER_VERSION,
      connected: Boolean(persisted.tokens?.access_token),
      workspaceName: persisted.self?.workspace?.name || '',
      notionProject: {
        id: initialNotionProject.id,
        name: initialNotionProject.name,
        dir: initialNotionProject.dir,
      },
    });
    return;
  }

  // 2.1 获取专属 Notion 项目配置与已知项目名称列表（供前端精准切换）
  if (req.method === 'GET' && pathname === '/api/project-target') {
    const info = ensureNotionAntigravityProject();
    sendJson(res, 200, {
      ok: true,
      projectId: info.id,
      projectName: info.name,
      projectDir: info.dir,
      knownProjectNames: info.knownProjectNames || [],
    });
    return;
  }

  // 2.2 获取本地全量 Antigravity 会话列表（含置顶对话顺序与项目名映射，供右栏「＋」添加会话使用）
  if (req.method === 'GET' && pathname === '/api/conversations') {
    const q = (urlObj.searchParams.get('q') || '').trim();
    const limit = Math.min(120, Math.max(10, Number(urlObj.searchParams.get('limit') || 60)));
    const data = await queryLocalAntigravityConversations({ q, limit });
    sendJson(res, 200, { ok: true, ...data });
    return;
  }

  // 2.5 Notion 签名媒体图片本地代理（自动走系统代理，防止 S3/CDN 裂图）
  if (req.method === 'GET' && pathname === '/api/media') {
    const target = (urlObj.searchParams.get('url') || '').trim();
    if (!target) {
      res.writeHead(400);
      res.end('missing url');
      return;
    }
    try {
      const mResp = await fetchMediaWithRedirect(target);
      const buf = await mResp.buffer();
      const ct = mResp.headers.get('content-type') || 'application/octet-stream';
      res.writeHead(mResp.ok ? 200 : mResp.status || 502, {
        'Content-Type': ct,
        'Cache-Control': 'private, max-age=240',
      });
      res.end(buf);
    } catch (err) {
      res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(err?.message || 'media proxy failed');
    }
    return;
  }

  // 3. OAuth 回调
  if (req.method === 'GET' && pathname === '/oauth/callback') {
    const errParam = urlObj.searchParams.get('error');
    const errDesc = urlObj.searchParams.get('error_description');
    if (errParam) {
      sendHtml(
        res,
        400,
        renderOAuthResultPage(false, 'Notion 授权未完成', `${errParam}${errDesc ? `: ${errDesc}` : ''}`)
      );
      return;
    }
    const code = urlObj.searchParams.get('code') || '';
    const state = urlObj.searchParams.get('state') || '';
    if (!code || !state) {
      sendHtml(res, 400, renderOAuthResultPage(false, '缺少授权参数', '回调 URL 中缺少 code 或 state。'));
      return;
    }
    try {
      await exchangeCodeForTokens(code, state);
      const wsName = persisted.self?.workspace?.name || 'Notion 工作区';
      sendHtml(
        res,
        200,
        renderOAuthResultPage(true, 'Notion 已成功连接', `已授权访问「${wsName}」，Antigravity 面板会自动加载你的笔记。`)
      );
    } catch (err) {
      sendHtml(
        res,
        500,
        renderOAuthResultPage(false, '连接失败', String(err?.message || err))
      );
    }
    return;
  }

  // 4. 鉴权状态 / 启动登录 / 登出
  if (req.method === 'GET' && pathname === '/api/auth/status') {
    const hasToken = Boolean(persisted.tokens?.access_token);
    if (!hasToken) {
      sendJson(res, 200, {
        ok: true,
        connected: false,
        workspace: null,
        user: null,
        authPending: pendingAuthFlows.size > 0,
      });
      return;
    }

    let selfData = persisted.self || null;
    if (!selfData || urlObj.searchParams.get('verify') === '1') {
      try {
        selfData = await callNotionTool('get-self', {});
        if (selfData && typeof selfData === 'object') {
          persisted = { ...persisted, self: selfData };
          savePersistedState(persisted);
        }
      } catch (err) {
        if (err instanceof AuthRequiredError) {
          sendJson(res, 200, {
            ok: true,
            connected: false,
            workspace: null,
            user: null,
            reason: err.message,
          });
          return;
        }
        // 网络抖动时先回落缓存
        if (!selfData) {
          sendJson(res, 200, {
            ok: true,
            connected: true,
            workspace: null,
            user: null,
            warning: err?.message || String(err),
          });
          return;
        }
      }
    }

    sendJson(res, 200, {
      ok: true,
      connected: true,
      workspace: selfData?.workspace || null,
      user: selfData?.user || null,
    });
    return;
  }

  if (req.method === 'POST' && pathname === '/api/auth/start') {
    const result = await startOAuthFlow();
    sendJson(res, 200, result);
    return;
  }

  if (req.method === 'POST' && pathname === '/api/auth/logout') {
    clearTokensOnly();
    sendJson(res, 200, { ok: true });
    return;
  }

  // 以下路由需要已登录 Notion
  if (req.method === 'GET' && pathname === '/api/home') {
    const force = urlObj.searchParams.get('refresh') === '1';
    if (!force && homeCache.data && Date.now() - homeCache.at < 30_000) {
      sendJson(res, 200, { ok: true, cached: true, ...homeCache.data });
      return;
    }

    const [selfRes, recentRes, privateRes, favRes] = await Promise.all([
      callNotionTool('get-self', {}),
      callNotionTool('list-recent-pages', { limit: 18 }),
      callNotionTool('list-private-pages', { limit: 18 }).catch(() => ({ results: [] })),
      callNotionTool('list-favorite-pages', { limit: 12 }).catch(() => ({ results: [] })),
    ]);

    if (selfRes && typeof selfRes === 'object') {
      persisted = { ...persisted, self: selfRes };
      savePersistedState(persisted);
    }

    const data = {
      workspace: selfRes?.workspace || persisted.self?.workspace || { name: 'Notion' },
      user: selfRes?.user || persisted.self?.user || { name: '' },
      recentPages: (recentRes?.results || []).map(normalizePageCard).filter(Boolean),
      recentNextCursor: recentRes?.nextCursor || '',
      privatePages: (privateRes?.results || []).map(normalizePageCard).filter(Boolean),
      favoritePages: (favRes?.results || []).map(normalizePageCard).filter(Boolean),
    };
    homeCache = { at: Date.now(), data };
    sendJson(res, 200, { ok: true, cached: false, ...data });
    return;
  }

  if (req.method === 'GET' && pathname === '/api/pages/all') {
    const tab = (urlObj.searchParams.get('tab') || 'recent').toLowerCase();
    const cursor = urlObj.searchParams.get('cursor') || '';
    const limit = Math.min(100, Math.max(1, Number(urlObj.searchParams.get('limit') || 36)));
    const toolMap = {
      recent: 'list-recent-pages',
      private: 'list-private-pages',
      shared: 'list-shared-pages',
      favorite: 'list-favorite-pages',
    };
    const tool = toolMap[tab] || 'list-recent-pages';
    const args = { limit };
    if (cursor) args.cursor = cursor;
    const raw = await callNotionTool(tool, args);
    sendJson(res, 200, {
      ok: true,
      tab,
      results: (raw?.results || []).map(normalizePageCard).filter(Boolean),
      nextCursor: raw?.nextCursor || '',
    });
    return;
  }

  if (req.method === 'GET' && pathname === '/api/search') {
    const q = (urlObj.searchParams.get('q') || '').trim();
    const pageSize = Math.min(30, Math.max(1, Number(urlObj.searchParams.get('limit') || 15)));
    if (!q) {
      sendJson(res, 200, { ok: true, results: [] });
      return;
    }

    // 如果用户直接粘贴了 Notion 链接或 32 位 Page ID，直接 fetch 解析作为第一条直达结果
    if (looksLikeNotionUrl(q) || /^[0-9a-f]{32}$/i.test(q) || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(q)) {
      try {
        const fetched = await callNotionTool('fetch', { id: q });
        const page = parseFetchedPage(fetched, q);
        sendJson(res, 200, {
          ok: true,
          directPage: true,
          results: [
            {
              id: page.id,
              url: page.url,
              title: page.title,
              type: page.type,
              icon: page.icon,
              path: page.path,
              timestamp: page.lastEditedAt,
              highlight: '直接打开该 Notion 页面链接',
            },
          ],
        });
        return;
      } catch {
        // 回落到普通关键词搜索
      }
    }

    const raw = await callNotionTool('search', {
      query: q,
      page_size: pageSize,
    });
    sendJson(res, 200, {
      ok: true,
      directPage: false,
      results: (raw?.results || []).map(normalizePageCard).filter(Boolean),
    });
    return;
  }

  if (req.method === 'GET' && pathname === '/api/page') {
    const idParam = (urlObj.searchParams.get('id') || '').trim();
    if (!idParam) {
      sendJson(res, 400, { ok: false, error: '缺少页面 id 参数' });
      return;
    }
    const raw = await callNotionTool('fetch', {
      id: idParam,
      include_file_urls: true,
    });
    const page = parseFetchedPage(raw, idParam);

    // 若正文中存在尚未解析的 notion-file-block:// 引用，自动补调 get-file-download-urls
    const fileBlockRefs = [...new Set(String(page.markdown || '').match(/notion-file-block:\/\/[^\s"'<>)]+/g) || [])];
    const missingRefs = fileBlockRefs.filter((r) => !page.references[r]);
    if (missingRefs.length > 0) {
      try {
        const dlRes = await callNotionTool('get-file-download-urls', {
          references: missingRefs.slice(0, 25),
        });
        if (Array.isArray(dlRes?.files)) {
          for (const f of dlRes.files) {
            if (f && f.reference && (f.url || f.download_url)) {
              page.references[f.reference] = f.url || f.download_url;
            }
          }
        }
      } catch {}
    }

    // 生成本地代理图片映射，保障代理网络下图片 100% 正常显示
    const proxiedReferences = {};
    for (const [refKey, signedUrl] of Object.entries(page.references || {})) {
      if (typeof signedUrl === 'string' && /^https?:\/\//i.test(signedUrl)) {
        proxiedReferences[refKey] = `/api/media?url=${encodeURIComponent(signedUrl)}`;
      }
    }

    // 若是数据库且带有 collection:// 数据源，额外尝试查询前 25 条记录供展示
    let databaseRows = [];
    if (page.dataSources.length > 0) {
      try {
        const qRes = await callNotionTool('query-data-sources', {
          data_source_urls: [page.dataSources[0].url],
          page_size: 25,
        });
        if (Array.isArray(qRes?.results)) {
          databaseRows = qRes.results.map(normalizePageCard).filter(Boolean);
        }
      } catch {}
    }

    sendJson(res, 200, {
      ok: true,
      page: {
        ...page,
        proxiedReferences,
        databaseRows,
      },
    });
    return;
  }

  if (req.method === 'POST' && pathname === '/api/page/create') {
    const body = await readJsonBody(req);
    const title = String(body.title || '').trim() || '无标题笔记';
    const content = typeof body.content === 'string' ? body.content : '';
    const parentPageId = String(body.parentPageId || '').trim();
    const icon = typeof body.icon === 'string' && body.icon.trim() ? body.icon.trim() : undefined;

    const pageSpec = {
      properties: { title },
    };
    if (content) pageSpec.content = content;
    if (icon) pageSpec.icon = icon;

    const createArgs = {
      allow_async: false,
      pages: [pageSpec],
    };
    if (parentPageId) {
      createArgs.parent = {
        type: 'page_id',
        page_id: extractPageId(parentPageId),
      };
    } else {
      createArgs.creation_mode = 'draft';
    }

    const raw = await callNotionTool('create-pages', createArgs);
    invalidateHomeCache();

    // 提取新建页面的 id 与 url
    let createdPage = null;
    if (Array.isArray(raw?.pages) && raw.pages[0]) {
      createdPage = raw.pages[0];
    } else if (Array.isArray(raw?.results) && raw.results[0]) {
      createdPage = raw.results[0];
    } else if (raw && (raw.id || raw.url)) {
      createdPage = raw;
    } else if (raw?.text) {
      const urlMatch = String(raw.text).match(/https?:\/\/(?:www\.notion\.so|app\.notion\.com)[^\s"<>]+/i);
      if (urlMatch) {
        createdPage = { url: urlMatch[0], id: extractPageId(urlMatch[0]), title };
      }
    }

    sendJson(res, 200, {
      ok: true,
      page: createdPage
        ? {
            id: extractPageId(createdPage.id || createdPage.url),
            url: buildCanonicalNotionUrl(createdPage.url || createdPage.id),
            title,
          }
        : null,
      raw,
    });
    return;
  }

  if (req.method === 'POST' && pathname === '/api/page/update') {
    const body = await readJsonBody(req);
    const pageId = extractPageId(body.pageId || body.id || '');
    const action = String(body.action || '').trim();
    if (!pageId) {
      sendJson(res, 400, { ok: false, error: '缺少 pageId' });
      return;
    }

    let updateArgs = null;
    if (action === 'update_title') {
      const nextTitle = String(body.title || '').trim() || '无标题笔记';
      updateArgs = {
        page_id: pageId,
        command: 'update_properties',
        allow_async: false,
        properties: { title: nextTitle },
      };
      if (typeof body.icon === 'string' && body.icon.trim()) {
        updateArgs.icon = body.icon.trim();
      }
    } else if (action === 'update_icon') {
      updateArgs = {
        page_id: pageId,
        command: 'update_properties',
        allow_async: false,
        icon: String(body.icon || 'none').trim(),
      };
    } else if (action === 'insert_block') {
      const content = String(body.content ?? '');
      if (!content.trim()) {
        sendJson(res, 400, { ok: false, error: '插入内容不能为空' });
        return;
      }
      updateArgs = {
        page_id: pageId,
        command: 'insert_content',
        allow_async: false,
        content,
        position: { type: body.position === 'start' ? 'start' : 'end' },
      };
    } else if (action === 'update_content') {
      const oldStr = String(body.oldStr ?? '');
      const newStr = String(body.newStr ?? '');
      if (!oldStr) {
        sendJson(res, 400, { ok: false, error: '缺少 oldStr' });
        return;
      }
      updateArgs = {
        page_id: pageId,
        command: 'update_content',
        allow_async: false,
        content_updates: [{ old_str: oldStr, new_str: newStr }],
      };
    } else if (action === 'replace_content') {
      const newStr = String(body.newStr ?? '');
      updateArgs = {
        page_id: pageId,
        command: 'replace_content',
        allow_async: false,
        new_str: newStr,
      };
    } else {
      sendJson(res, 400, { ok: false, error: `不支持的更新操作: ${action}` });
      return;
    }

    const raw = await callNotionTool('update-page', updateArgs);
    invalidateHomeCache();
    sendJson(res, 200, { ok: true, result: raw });
    return;
  }

  sendJson(res, 404, { ok: false, error: `Not Found: ${pathname}` });
}

const server = createServer(async (req, res) => {
  try {
    const urlObj = new URL(req.url || '/', ORIGIN);
    await handleApiRequest(req, res, urlObj);
  } catch (err) {
    if (err instanceof AuthRequiredError || err?.code === 'AUTH_REQUIRED') {
      sendJson(res, 401, {
        ok: false,
        code: 'AUTH_REQUIRED',
        error: err.message || '需要先连接 Notion 账号',
      });
      return;
    }
    sendJson(res, 500, {
      ok: false,
      error: err?.message || String(err),
    });
  }
});

server.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    process.exit(0);
  }
  console.error('[notion-stage] 服务监听失败:', err?.message || err);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  try {
    writeFileSync(
      PID_FILE,
      JSON.stringify({ pid: process.pid, port: PORT, startedAt: new Date().toISOString() }, null, 2),
      'utf8'
    );
  } catch {}
});
