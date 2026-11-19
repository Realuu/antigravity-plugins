#!/usr/bin/env node
/**
 * Antigravity Cowart Stage Server (127.0.0.1:45791)
 *
 * 作用：
 * 1. 复用已安装 Cowart 插件（~/.gemini/config/plugins/cowart）的 MCP 产物与 tldraw Widget；
 * 2. 提供全屏/分栏宿主桥接（window.cowartMcp）、工具栏底部避让样式与磁盘画布变更感知；
 * 3. 提供 /api/projects、/api/canvas-mtime、/api/save-attachment 与 /api/cowart-tool 接口。
 */
import { execFileSync, spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import fsPromises from 'node:fs/promises';
import { createServer } from 'node:http';
import { syncBuiltinESMExports } from 'node:module';
import { homedir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL, URL } from 'node:url';

// Windows 受限/沙盒盘符下 uv_fs_realpath 可能抛出 EPERM，打入兜底补丁
const origRealpath = fsPromises.realpath;
fsPromises.realpath = async function patchedRealpath(targetPath, options) {
  try {
    return await origRealpath.call(this, targetPath, options);
  } catch (err) {
    if (err && (err.code === 'EPERM' || err.code === 'EACCES')) {
      return path.resolve(String(targetPath));
    }
    throw err;
  }
};
syncBuiltinESMExports();

const HOST = '127.0.0.1';
const PORT = Number(process.env.AGY_COWART_STAGE_PORT || 45791);
const MAX_BODY_BYTES = 50 * 1024 * 1024;

function resolveAppDataDir() {
  const envDir = process.env.ANTIGRAVITY_APP_DATA_DIR?.trim();
  if (envDir) return envDir;
  return path.join(homedir(), '.gemini', 'antigravity');
}

function resolveCowartPluginRoot() {
  const candidates = [
    process.env.COWART_PLUGIN_ROOT?.trim(),
    path.join(homedir(), '.gemini', 'config', 'plugins', 'cowart'),
    path.join(homedir(), '.codex', 'plugins', 'cowart'),
  ].filter(Boolean);
  for (const dir of candidates) {
    if (
      existsSync(path.join(dir, 'mcp', 'generated', 'cowart-widget.html')) &&
      existsSync(path.join(dir, 'scripts', 'start-mcp.mjs'))
    ) {
      return dir;
    }
  }
  return path.join(homedir(), '.gemini', 'config', 'plugins', 'cowart');
}

const APP_DATA_DIR = resolveAppDataDir();
const COWART_ROOT = resolveCowartPluginRoot();
const WIDGET_HTML_PATH = path.join(COWART_ROOT, 'mcp', 'generated', 'cowart-widget.html');
const START_MCP_SCRIPT = path.join(COWART_ROOT, 'scripts', 'start-mcp.mjs');
const LAUNCHER_LIB_PATH = path.join(COWART_ROOT, 'mcp', 'lib', 'project-launcher.mjs');
const LAST_TARGET_FILE = path.join(APP_DATA_DIR, 'sidecar_data', 'cowart', 'last_target.json');
const UPLOADS_DIR = path.join(APP_DATA_DIR, 'sidecar_data', 'cowart', 'uploads');
const PID_FILE = path.join(APP_DATA_DIR, 'sidecar_data', 'cowart', 'stage_server.json');
const LS_LOG_PATH = path.join(homedir(), 'AppData', 'Roaming', 'Antigravity', 'logs', 'language_server.log');

try {
  mkdirSync(path.dirname(LAST_TARGET_FILE), { recursive: true });
  mkdirSync(UPLOADS_DIR, { recursive: true });
} catch {}

let resolveLauncherTargetFn = null;
async function getLauncherTargetResolver() {
  if (resolveLauncherTargetFn) return resolveLauncherTargetFn;
  if (existsSync(LAUNCHER_LIB_PATH)) {
    const mod = await import(pathToFileURL(LAUNCHER_LIB_PATH).href);
    if (typeof mod.resolveLauncherTarget === 'function') {
      resolveLauncherTargetFn = mod.resolveLauncherTarget;
      return resolveLauncherTargetFn;
    }
  }
  resolveLauncherTargetFn = async (input = {}) => {
    const projectDir = input.projectDir
      ? path.resolve(input.projectDir)
      : path.join(homedir(), 'Documents', 'Cowart');
    const canvasDir = input.canvasDir
      ? path.resolve(input.canvasDir)
      : path.join(projectDir, 'canvas');
    mkdirSync(canvasDir, { recursive: true });
    return { projectDir, canvasDir };
  };
  return resolveLauncherTargetFn;
}

// --- 1. 常驻 Cowart MCP 子进程 ---
let mcpProc = null;
let mcpReadyPromise = null;
let nextRpcId = 100;
const pendingRpc = new Map();
let lastClientWriteAt = 0;

function ensureMcpProcess() {
  if (mcpProc && !mcpProc.killed && mcpReadyPromise) {
    return mcpReadyPromise;
  }
  if (!existsSync(START_MCP_SCRIPT)) {
    return Promise.reject(new Error(`未找到 Cowart MCP 启动脚本: ${START_MCP_SCRIPT}`));
  }

  mcpReadyPromise = new Promise((resolveReady, rejectReady) => {
    const child = spawn(process.execPath, [START_MCP_SCRIPT], {
      env: {
        ...process.env,
        COWART_PLUGIN_ROOT: COWART_ROOT,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    mcpProc = child;

    const rl = createInterface({ input: child.stdout, terminal: false });
    rl.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let msg;
      try {
        msg = JSON.parse(trimmed);
      } catch {
        return;
      }
      if (msg.id === 1) {
        child.stdin.write(
          `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`
        );
        resolveReady(child);
        return;
      }
      if (msg.id !== undefined && pendingRpc.has(msg.id)) {
        const entry = pendingRpc.get(msg.id);
        pendingRpc.delete(msg.id);
        clearTimeout(entry.timer);
        if (msg.error) {
          entry.reject(new Error(msg.error.message || 'MCP RPC Error'));
        } else {
          entry.resolve(msg.result);
        }
      }
    });

    child.on('error', (err) => {
      mcpProc = null;
      mcpReadyPromise = null;
      rejectReady(err);
    });

    child.on('exit', () => {
      mcpProc = null;
      mcpReadyPromise = null;
      for (const [, entry] of pendingRpc) {
        clearTimeout(entry.timer);
        entry.reject(new Error('Cowart MCP process exited unexpectedly.'));
      }
      pendingRpc.clear();
    });

    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'antigravity-cowart-stage', version: '1.0.0' },
        },
      })}\n`
    );
  });

  return mcpReadyPromise;
}

async function callMcpTool(name, args = {}, timeoutMs = 30000) {
  const child = await ensureMcpProcess();
  const id = ++nextRpcId;
  return new Promise((resolveRpc, rejectRpc) => {
    const timer = setTimeout(() => {
      pendingRpc.delete(id);
      rejectRpc(new Error(`Cowart MCP tool timeout: ${name}`));
    }, timeoutMs);

    pendingRpc.set(id, { resolve: resolveRpc, reject: rejectRpc, timer });
    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id,
        method: 'tools/call',
        params: {
          name,
          arguments: args || {},
        },
      })}\n`
    );
  });
}

// --- 2. 发现本地活跃项目与画布目录 ---
function fileUriToLocalPath(uriStr) {
  if (typeof uriStr !== 'string') return '';
  let s = uriStr.trim();
  if (!s) return '';
  if (s.startsWith('file://')) {
    try {
      s = fileURLToPath(s);
    } catch {
      s = s.replace(/^file:\/\/\/?/, '');
    }
  }
  return path.normalize(s);
}

function discoverLsConnection() {
  if (process.env.ANTIGRAVITY_LS_ADDRESS && process.env.ANTIGRAVITY_CSRF_TOKEN) {
    return {
      addr: process.env.ANTIGRAVITY_LS_ADDRESS,
      token: process.env.ANTIGRAVITY_CSRF_TOKEN,
    };
  }
  try {
    let httpPort = '';
    if (existsSync(LS_LOG_PATH)) {
      const logHead = readFileSync(LS_LOG_PATH, 'utf8').slice(0, 8192);
      const matches = [...logHead.matchAll(/listening on random port at (\d+) for HTTP\b/g)];
      if (matches.length > 0) {
        httpPort = matches[matches.length - 1][1];
      }
    }
    const cmdOut = execFileSync(
      'powershell',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        "(Get-CimInstance Win32_Process -Filter \"Name = 'language_server.exe'\" | Select-Object -First 1 -ExpandProperty CommandLine)",
      ],
      { encoding: 'utf8', timeout: 4000, windowsHide: true }
    ).trim();
    const tokenMatch = cmdOut.match(/--csrf_token(?:=|\s+)([^\s"']+)/);
    if (httpPort && tokenMatch) {
      return {
        addr: `127.0.0.1:${httpPort}`,
        token: tokenMatch[1],
      };
    }
  } catch {}
  return null;
}

async function fetchWorkspaceProjectsFromLs() {
  const conn = discoverLsConnection();
  if (!conn) return [];
  try {
    const resp = await fetch(
      `http://${conn.addr}/exa.language_server_pb.LanguageServerService/GetAllCascadeTrajectories`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-codeium-csrf-token': conn.token,
        },
        body: JSON.stringify({ excludeSubtrajectories: true }),
      }
    );
    if (!resp.ok) return [];
    const data = await resp.json();
    const summaries = data?.trajectorySummaries || {};
    const projectMap = new Map();

    for (const item of Object.values(summaries)) {
      const uris = item?.workspaces?.map((w) => w.workspaceFolderAbsoluteUri).filter(Boolean) ||
        item?.metadata?.workspaceUris ||
        [];
      const modifiedAt = Date.parse(item?.lastModifiedTime || item?.createdTime || '') || 0;
      for (const uri of uris) {
        const localDir = fileUriToLocalPath(uri);
        if (!localDir) continue;
        try {
          if (!existsSync(localDir) || !statSync(localDir).isDirectory()) continue;
        } catch {
          continue;
        }
        const key = localDir.toLowerCase();
        const prev = projectMap.get(key);
        if (!prev || modifiedAt > prev.lastModifiedMs) {
          projectMap.set(key, {
            projectDir: localDir,
            lastModifiedMs: modifiedAt,
          });
        }
      }
    }
    return [...projectMap.values()];
  } catch {
    return [];
  }
}

function readLastTarget() {
  try {
    if (!existsSync(LAST_TARGET_FILE)) return null;
    const raw = JSON.parse(readFileSync(LAST_TARGET_FILE, 'utf8'));
    if (raw && (raw.projectDir || raw.canvasDir)) return raw;
  } catch {}
  return null;
}

function writeLastTarget(target) {
  try {
    mkdirSync(path.dirname(LAST_TARGET_FILE), { recursive: true });
    writeFileSync(
      LAST_TARGET_FILE,
      JSON.stringify(
        {
          projectDir: target.projectDir,
          canvasDir: target.canvasDir,
          updatedAt: new Date().toISOString(),
        },
        null,
        2
      ),
      'utf8'
    );
  } catch {}
}

function hasCanvasPages(canvasDir) {
  try {
    const pagesDir = path.join(canvasDir, 'pages');
    return existsSync(pagesDir) && readdirSync(pagesDir).length > 0;
  } catch {
    return false;
  }
}

async function listAvailableProjects() {
  const resolveTarget = await getLauncherTargetResolver();
  const globalTarget = await resolveTarget({});
  const lsProjects = await fetchWorkspaceProjectsFromLs();
  const lastTarget = readLastTarget();

  const seen = new Map();
  const addEntry = (projectDir, canvasDir, opts = {}) => {
    if (!projectDir) return;
    const normProj = path.resolve(projectDir);
    const normCanvas = canvasDir ? path.resolve(canvasDir) : path.join(normProj, 'canvas');
    const key = normProj.toLowerCase();
    const existing = seen.get(key);
    const hasCanvas = hasCanvasPages(normCanvas);
    if (!existing) {
      seen.set(key, {
        name: opts.isGlobal ? '全局画布 (Documents/Cowart)' : path.basename(normProj) || normProj,
        projectDir: normProj,
        canvasDir: normCanvas,
        isGlobal: Boolean(opts.isGlobal),
        hasCanvas,
        lastModifiedMs: opts.lastModifiedMs || 0,
      });
    } else {
      if (opts.isGlobal) existing.isGlobal = true;
      if (opts.lastModifiedMs && opts.lastModifiedMs > existing.lastModifiedMs) {
        existing.lastModifiedMs = opts.lastModifiedMs;
      }
    }
  };

  for (const p of lsProjects) {
    addEntry(p.projectDir, path.join(p.projectDir, 'canvas'), { lastModifiedMs: p.lastModifiedMs });
  }

  if (lastTarget?.projectDir && existsSync(lastTarget.projectDir)) {
    const isGlobal =
      path.resolve(lastTarget.projectDir).toLowerCase() ===
      path.resolve(globalTarget.projectDir).toLowerCase();
    addEntry(lastTarget.projectDir, lastTarget.canvasDir, { isGlobal });
  }

  addEntry(globalTarget.projectDir, globalTarget.canvasDir, { isGlobal: true });

  const list = [...seen.values()];
  list.sort((a, b) => {
    if (a.isGlobal !== b.isGlobal) return a.isGlobal ? 1 : -1;
    if (a.hasCanvas !== b.hasCanvas) return a.hasCanvas ? -1 : 1;
    return b.lastModifiedMs - a.lastModifiedMs;
  });

  return {
    projects: list,
    globalTarget,
    lastTarget,
  };
}

function computeCanvasMtime(canvasDir) {
  let maxMtime = 0;
  try {
    const pagesDir = path.join(canvasDir, 'pages');
    if (!existsSync(pagesDir)) return 0;
    const manifestPath = path.join(pagesDir, 'manifest.json');
    if (existsSync(manifestPath)) {
      maxMtime = Math.max(maxMtime, statSync(manifestPath).mtimeMs || 0);
    }
    for (const entry of readdirSync(pagesDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const pageJson = path.join(pagesDir, entry.name, 'cowart-canvas.json');
      if (existsSync(pageJson)) {
        maxMtime = Math.max(maxMtime, statSync(pageJson).mtimeMs || 0);
      }
    }
  } catch {}
  return Math.round(maxMtime);
}

// --- 3. 构建注入脚本与样式 ---
function buildStageBridgeScript({ target, layoutMode, themeMode }) {
  const safeConfig = JSON.stringify({
    projectDir: target.projectDir,
    canvasDir: target.canvasDir,
    layoutMode: layoutMode === 'split' ? 'split' : 'fullscreen',
    themeMode: themeMode === 'dark' ? 'dark' : 'light',
    initialMtime: computeCanvasMtime(target.canvasDir),
  }).replace(/</g, '\\u003c');

  return `<style id="cowartStageHostStyles">
  /* 全屏态：将底部中间创作工具栏上移，避开宿主悬浮提问框，同时保留左下角缩放控件原位 */
  html[data-agy-host-layout="fullscreen"] .cowart-canvas .tlui-layout__bottom .tlui-main-toolbar {
    margin-bottom: 62px !important;
    transition: margin-bottom 0.18s cubic-bezier(0.22, 1, 0.36, 1);
  }
  html[data-agy-host-layout="split"] .cowart-canvas .tlui-layout__bottom .tlui-main-toolbar {
    margin-bottom: 0px !important;
    transition: margin-bottom 0.18s cubic-bezier(0.22, 1, 0.36, 1);
  }
  /* 隐藏内部全屏切换按钮（由外层宿主右上角控制，避免重复） */
  .tlui-layout__top__right [title*="退出全屏"],
  .tlui-layout__top__right [aria-label*="Exit fullscreen"] {
    display: none !important;
  }
</style>
<script id="cowartStageBridge">
(() => {
  "use strict";
  const cfg = ${safeConfig};
  document.documentElement.setAttribute("data-agy-host-layout", cfg.layoutMode);
  document.documentElement.setAttribute("data-agy-host-theme", cfg.themeMode);

  const toolOutput = {
    projectDir: cfg.projectDir,
    canvasDir: cfg.canvasDir,
    globalWorkspace: false
  };

  window.openai = Object.assign(window.openai || {}, {
    toolOutput,
    displayMode: "fullscreen",
    availableDisplayModes: ["fullscreen"],
    theme: cfg.themeMode,
    hostCapabilities: { message: { image: false } }
  });

  function extractPrompt(message) {
    if (typeof message === "string") return message;
    if (message?.prompt) return String(message.prompt);
    if (typeof message?.content === "string") return message.content;
    if (Array.isArray(message?.content)) {
      const textItem = message.content.find((item) => item?.type === "text" && item?.text);
      if (textItem) return String(textItem.text);
    }
    return "";
  }

  let knownMtime = Number(cfg.initialMtime || 0);
  let lastOwnSaveAt = 0;

  window.cowartMcp = {
    callServerTool: async (request, options = {}) => {
      const toolName = String(request?.name || "");
      if (
        toolName === "save_cowart_canvas_state" ||
        toolName === "save_cowart_selection_state" ||
        toolName === "save_cowart_view_state"
      ) {
        lastOwnSaveAt = Date.now();
      }
      const response = await window.fetch("/api/cowart-tool", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: toolName,
          arguments: {
            projectDir: window.openai?.toolOutput?.projectDir,
            canvasDir: window.openai?.toolOutput?.canvasDir,
            ...(request?.arguments || {})
          }
        }),
        signal: options?.signal
      });
      if (!response.ok) {
        const errText = await response.text().catch(() => response.statusText);
        throw new Error("Cowart tool call failed: " + errText);
      }
      const data = await response.json();
      if (
        toolName === "save_cowart_canvas_state" ||
        toolName === "insert_cowart_image" ||
        toolName === "insert_cowart_html_draft"
      ) {
        lastOwnSaveAt = Date.now();
        setTimeout(async () => {
          try {
            const r = await window.fetch("/api/canvas-mtime?canvasDir=" + encodeURIComponent(toolOutput.canvasDir));
            const j = await r.json();
            if (j && typeof j.mtimeMs === "number") knownMtime = Math.max(knownMtime, j.mtimeMs);
          } catch {}
        }, 400);
      }
      return data;
    },

    sendFollowUpMessage: async (message) => {
      const prompt = extractPrompt(message);
      if (!prompt) throw new Error("Missing follow-up prompt.");
      if (window.parent && window.parent !== window) {
        window.parent.postMessage({
          type: "AGY_COWART_FOLLOW_UP",
          prompt,
          projectDir: window.openai?.toolOutput?.projectDir || cfg.projectDir,
          canvasDir: window.openai?.toolOutput?.canvasDir || cfg.canvasDir
        }, "*");
        return { ok: true, forwardedToHost: true };
      }
      throw new Error("未检测到 Antigravity 宿主窗口");
    },

    getHostCapabilities: () => ({ message: { image: false } }),
    updateModelContext: async () => ({}),
    requestDisplayMode: async () => ({ mode: "fullscreen" }),
    notifyResize: () => {}
  };

  window.addEventListener("message", (event) => {
    const data = event.data;
    if (!data || typeof data !== "object") return;
    if (data.type === "AGY_COWART_HOST_STATE") {
      if (data.layoutMode === "fullscreen" || data.layoutMode === "split") {
        document.documentElement.setAttribute("data-agy-host-layout", data.layoutMode);
      }
      if (data.themeMode === "light" || data.themeMode === "dark") {
        document.documentElement.setAttribute("data-agy-host-theme", data.themeMode);
        window.openai.theme = data.themeMode;
        window.dispatchEvent(new CustomEvent("openai:set_globals", {
          detail: { globals: { theme: data.themeMode } }
        }));
      }
    }
  });

  // 轻量检测磁盘画布文件变化（Agent 调用 MCP 生图/改图/写 HTML 后自动同步画布）
  let isInteracting = false;
  window.addEventListener("pointerdown", () => { isInteracting = true; }, true);
  window.addEventListener("pointerup", () => { isInteracting = false; }, true);

  setInterval(async () => {
    if (document.hidden || isInteracting) return;
    if (Date.now() - lastOwnSaveAt < 2500) return;
    try {
      const resp = await window.fetch("/api/canvas-mtime?canvasDir=" + encodeURIComponent(toolOutput.canvasDir), {
        cache: "no-store"
      });
      if (!resp.ok) return;
      const info = await resp.json();
      if (
        info &&
        typeof info.mtimeMs === "number" &&
        info.mtimeMs > knownMtime &&
        (!info.lastClientWriteAt || Date.now() - info.lastClientWriteAt > 2000)
      ) {
        knownMtime = info.mtimeMs;
        // 避免打断用户正在输入的文本框
        const activeTag = document.activeElement?.tagName;
        if (activeTag === "INPUT" || activeTag === "TEXTAREA" || document.activeElement?.isContentEditable) {
          return;
        }
        window.location.reload();
      }
    } catch {}
  }, 2500);

  window.dispatchEvent(new CustomEvent("openai:set_globals", {
    detail: { globals: window.openai }
  }));
  window.__sidecarReady = true;
})();
</script>`;
}

// --- 4. HTTP 服务 ---
function readJsonBody(req) {
  return new Promise((resolveBody, rejectBody) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        rejectBody(new Error('Payload Too Large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) {
        resolveBody({});
        return;
      }
      try {
        resolveBody(JSON.parse(raw));
      } catch (err) {
        rejectBody(err);
      }
    });
    req.on('error', rejectBody);
  });
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(payload));
}

let cachedWidgetHtml = null;
function getBaseWidgetHtml() {
  if (!cachedWidgetHtml) {
    if (!existsSync(WIDGET_HTML_PATH)) {
      throw new Error(`未找到 Cowart 画布文件: ${WIDGET_HTML_PATH}`);
    }
    cachedWidgetHtml = readFileSync(WIDGET_HTML_PATH, 'utf8');
  }
  return cachedWidgetHtml;
}

const server = createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  const method = (req.method || 'GET').toUpperCase();
  if (method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const urlObj = new URL(req.url || '/', `http://${HOST}:${PORT}`);
  const pathname = urlObj.pathname;

  try {
    if (method === 'GET' && pathname === '/api/health') {
      sendJson(res, 200, {
        ok: true,
        host: HOST,
        port: PORT,
        pid: process.pid,
        cowartInstalled: existsSync(WIDGET_HTML_PATH) && existsSync(START_MCP_SCRIPT),
        cowartRoot: COWART_ROOT,
      });
      return;
    }

    if (method === 'GET' && pathname === '/api/projects') {
      const info = await listAvailableProjects();
      sendJson(res, 200, { ok: true, ...info });
      return;
    }

    if (method === 'GET' && pathname === '/api/canvas-mtime') {
      const canvasDir = urlObj.searchParams.get('canvasDir')?.trim() || '';
      const mtimeMs = canvasDir ? computeCanvasMtime(canvasDir) : 0;
      sendJson(res, 200, { ok: true, mtimeMs, lastClientWriteAt });
      return;
    }

    if (method === 'POST' && pathname === '/api/save-attachment') {
      const body = await readJsonBody(req);
      const dataUrl = typeof body.dataUrl === 'string' ? body.dataUrl : '';
      const m = dataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
      if (!m) {
        sendJson(res, 400, { ok: false, error: 'Invalid image dataUrl' });
        return;
      }
      const extMap = {
        'image/png': 'png',
        'image/jpeg': 'jpg',
        'image/webp': 'webp',
        'image/gif': 'gif',
        'image/svg+xml': 'svg',
      };
      const ext = extMap[m[1].toLowerCase()] || 'png';
      const safeBase = String(body.fileName || 'cowart-ref')
        .replace(/\.[^.]+$/, '')
        .replace(/[^a-zA-Z0-9_-]+/g, '-')
        .slice(0, 40) || 'cowart-ref';
      const fileName = `${safeBase}-${Date.now()}.${ext}`;
      const targetPath = path.join(UPLOADS_DIR, fileName);
      mkdirSync(UPLOADS_DIR, { recursive: true });
      writeFileSync(targetPath, Buffer.from(m[2], 'base64'));
      sendJson(res, 200, { ok: true, filePath: targetPath, fileName });
      return;
    }

    if (method === 'POST' && pathname === '/api/cowart-tool') {
      const body = await readJsonBody(req);
      const toolName = typeof body.name === 'string' ? body.name.trim() : '';
      if (!toolName) {
        sendJson(res, 400, { error: 'Missing tool name' });
        return;
      }
      if (
        toolName === 'save_cowart_canvas_state' ||
        toolName === 'save_cowart_selection_state' ||
        toolName === 'save_cowart_view_state' ||
        toolName === 'insert_cowart_image' ||
        toolName === 'insert_cowart_html_draft'
      ) {
        lastClientWriteAt = Date.now();
      }
      const result = await callMcpTool(toolName, body.arguments || {});
      sendJson(res, 200, result ?? {});
      return;
    }

    if (method === 'GET' && (pathname === '/' || pathname === '/canvas')) {
      const resolveTarget = await getLauncherTargetResolver();
      const reqProjectDir = urlObj.searchParams.get('projectDir')?.trim() || undefined;
      const reqCanvasDir = urlObj.searchParams.get('canvasDir')?.trim() || undefined;
      const layoutMode = urlObj.searchParams.get('layout') === 'split' ? 'split' : 'fullscreen';
      const themeMode = urlObj.searchParams.get('theme') === 'dark' ? 'dark' : 'light';

      let target;
      try {
        target = await resolveTarget({ projectDir: reqProjectDir, canvasDir: reqCanvasDir });
      } catch {
        target = await resolveTarget({});
      }
      writeLastTarget(target);

      const bridgeHtml = buildStageBridgeScript({ target, layoutMode, themeMode });
      const baseHtml = getBaseWidgetHtml();
      const finalHtml = baseHtml.replace('</head>', () => `${bridgeHtml}\n</head>`);

      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end(finalHtml);
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
  } catch (err) {
    sendJson(res, 500, {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

server.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    process.exit(0);
  }
  console.error('[Cowart Stage Server] Listen error:', err);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  try {
    mkdirSync(path.dirname(PID_FILE), { recursive: true });
    writeFileSync(
      PID_FILE,
      JSON.stringify({ host: HOST, port: PORT, pid: process.pid, startedAt: new Date().toISOString() }, null, 2),
      'utf8'
    );
  } catch {}
  ensureMcpProcess().catch((err) => {
    console.error('[Cowart Stage Server] Initial MCP warmup failed:', err);
  });
});

function cleanup() {
  try {
    rmSync(PID_FILE, { force: true });
  } catch {}
  if (mcpProc && !mcpProc.killed) {
    try {
      mcpProc.kill();
    } catch {}
  }
  process.exit(0);
}

process.once('SIGINT', cleanup);
process.once('SIGTERM', cleanup);
