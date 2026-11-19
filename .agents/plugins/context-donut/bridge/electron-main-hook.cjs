"use strict";
/**
 * Antigravity Context Donut — Electron 主进程桥接钩子 (CommonJS, Windows + WSL 双模兼容)
 *
 * 作用：
 * 1. 注册 Electron IPC 通道 `context-donut:get-usage`，同时兼容 Windows 本地模式与 WSL 2 模式，
 *    自动定位当前活动发行版或本地的 `transcript.jsonl` 并解析最新 Token 统计；
 * 2. 若本地 45789 端口尚未被 Sidecar 监听，则在主进程内自动挂载轻量本地接口 `http://127.0.0.1:45789/api/context`；
 * 3. 监听所有 Hub 窗口的 `dom-ready` / `did-finish-load` 事件，自动向主渲染层注入 `composer-donut.js`。
 */
const fs = require("fs");
const path = require("path");
const os = require("os");
const http = require("http");

const FIXED_PORT = 45789;
const USER_DATA_DIR = path.join(os.homedir(), "AppData", "Roaming", "Antigravity");
const WSL_STATE_PATH = path.join(USER_DATA_DIR, "wsl_state.json");
const WSL_DISTROS_CACHE_PATH = path.resolve(__dirname, "..", ".wsl-distros.json");
const WSL_HOME_CACHE_TTL_MS = 60000;

const cachedDistroHomes = new Map(); // distro -> { homes: string[], updatedAt: number }

/**
 * 读取插件安装器写入的已知 WSL 2 发行版缓存
 */
function readKnownWslDistrosFile() {
  try {
    if (!fs.existsSync(WSL_DISTROS_CACHE_PATH)) return [];
    const parsed = JSON.parse(fs.readFileSync(WSL_DISTROS_CACHE_PATH, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * 从 Electron 主进程 require.cache 或 wsl_state.json 获取当前激活的 WSL 发行版信息
 */
function readActiveWslInfo() {
  let activeDistro = "";
  try {
    const cache = require.cache || {};
    for (const key of Object.keys(cache)) {
      const norm = key.replace(/\\/g, "/");
      if (norm.endsWith("/dist/wsl.js")) {
        const wslMod = cache[key] && cache[key].exports;
        if (wslMod && typeof wslMod.getActiveWslDistro === "function") {
          activeDistro = String(wslMod.getActiveWslDistro() || "").trim();
        }
        break;
      }
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

  const knownTargets = readKnownWslDistrosFile();
  const distroOrder = [];
  if (activeDistro) {
    distroOrder.push(activeDistro);
  }
  for (const item of knownTargets) {
    const name = String((item && item.name) || "").trim();
    if (name && !distroOrder.includes(name)) {
      distroOrder.push(name);
    }
  }

  return { activeDistro, knownTargets, distroOrder };
}

/**
 * 解析指定 WSL 发行版的用户主目录 Windows UNC 路径（如 \\wsl.localhost\Ubuntu\home\real）
 */
function getWslDistroHomeUncDirs(distro, knownTargets) {
  if (!distro || process.platform !== "win32") return [];
  const now = Date.now();
  const cached = cachedDistroHomes.get(distro);
  if (cached && now - cached.updatedAt < WSL_HOME_CACHE_TTL_MS) {
    return cached.homes;
  }

  const homes = [];
  const seen = new Set();
  const pushHome = (p) => {
    if (!p) return;
    const norm = p.toLowerCase();
    if (!seen.has(norm)) {
      seen.add(norm);
      homes.push(p);
    }
  };

  if (Array.isArray(knownTargets)) {
    for (const item of knownTargets) {
      if (item && item.name === distro && item.uncHome) {
        try {
          if (fs.existsSync(item.uncHome)) {
            pushHome(item.uncHome);
          }
        } catch {}
      }
    }
  }

  const uncRoots = [`\\\\wsl.localhost\\${distro}`, `\\\\wsl$\\${distro}`];
  for (const root of uncRoots) {
    let foundAnyUnderRoot = false;
    try {
      const homeBase = path.join(root, "home");
      if (fs.existsSync(homeBase)) {
        const entries = fs.readdirSync(homeBase, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory()) {
            pushHome(path.join(homeBase, entry.name));
            foundAnyUnderRoot = true;
          }
        }
      }
    } catch {}

    try {
      const rootGemini = path.join(root, "root", ".gemini");
      if (fs.existsSync(rootGemini)) {
        pushHome(path.join(root, "root"));
        foundAnyUnderRoot = true;
      }
    } catch {}

    if (foundAnyUnderRoot) break;
  }

  cachedDistroHomes.set(distro, { homes, updatedAt: now });
  return homes;
}

function isConfigExplicitlyDisabled(cfgPath) {
  try {
    if (!fs.existsSync(cfgPath)) return false;
    const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
    return Boolean(
      cfg && cfg.plugins && cfg.plugins["context-donut"] && cfg.plugins["context-donut"].enabled === false
    );
  } catch {
    return false;
  }
}

function isPluginEnabled() {
  const winCfg = path.join(os.homedir(), ".gemini", "config", "config.json");
  if (isConfigExplicitlyDisabled(winCfg)) return false;

  const { activeDistro, knownTargets } = readActiveWslInfo();
  if (activeDistro) {
    for (const wslHome of getWslDistroHomeUncDirs(activeDistro, knownTargets)) {
      const wslCfg = path.join(wslHome, ".gemini", "config", "config.json");
      if (isConfigExplicitlyDisabled(wslCfg)) return false;
    }
  }
  return true;
}

function getBrainDirs() {
  const home = os.homedir();
  const localCandidates = [
    path.join(home, ".gemini", "antigravity", "brain"),
    path.join(home, ".gemini", "antigravity-ide", "brain"),
    path.join(home, ".gemini", "antigravity-cli", "brain"),
  ];

  const { activeDistro, knownTargets, distroOrder } = readActiveWslInfo();
  const activeWslCandidates = [];
  const otherWslCandidates = [];

  for (const distro of distroOrder) {
    const bucket = distro === activeDistro ? activeWslCandidates : otherWslCandidates;
    for (const wslHome of getWslDistroHomeUncDirs(distro, knownTargets)) {
      bucket.push(
        path.join(wslHome, ".gemini", "antigravity", "brain"),
        path.join(wslHome, ".gemini", "antigravity-ide", "brain"),
        path.join(wslHome, ".gemini", "antigravity-cli", "brain")
      );
    }
  }

  // 当检测到处于活动 WSL 模式时，优先检索当前 WSL 发行版日志目录
  const orderedCandidates = activeDistro
    ? [...activeWslCandidates, ...localCandidates, ...otherWslCandidates]
    : [...localCandidates, ...otherWslCandidates];

  const seen = new Set();
  const result = [];
  for (const dir of orderedCandidates) {
    const key = dir.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) {
        result.push(dir);
      }
    } catch {}
  }
  return result;
}

function resolveTranscript(conversationId) {
  const brainDirs = getBrainDirs();
  const targetCid = typeof conversationId === "string" ? conversationId.trim() : "";

  if (targetCid) {
    for (const dir of brainDirs) {
      const p = path.join(dir, targetCid, ".system_generated", "logs", "transcript.jsonl");
      if (fs.existsSync(p)) {
        return { conversationId: targetCid, transcriptPath: p };
      }
    }
    // 明确指定了 conversationId 但日志尚未生成时，直接返回 null，严禁串台回退其他旧会话
    return null;
  }

  let latest = null;
  let latestMtime = 0;
  for (const dir of brainDirs) {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const p = path.join(dir, entry.name, ".system_generated", "logs", "transcript.jsonl");
      try {
        const st = fs.statSync(p);
        if (st.mtimeMs > latestMtime) {
          latestMtime = st.mtimeMs;
          latest = { conversationId: entry.name, transcriptPath: p };
        }
      } catch {}
    }
  }
  return latest;
}

function parseTranscriptFast(conversationId) {
  const resolved = resolveTranscript(conversationId);
  const empty = {
    conversationId: conversationId || null,
    modelName: "Gemini",
    inputTokens: 0,
    cacheReadTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cumulativeOutputTokens: 0,
    cacheHitRate: 0,
    turnCount: 0,
    plannerStepCount: 0,
    pluginEnabled: isPluginEnabled(),
  };
  if (!resolved || !resolved.transcriptPath || !fs.existsSync(resolved.transcriptPath)) {
    return empty;
  }
  try {
    const content = fs.readFileSync(resolved.transcriptPath, "utf8");
    const lines = content.split(/\r?\n/);
    let latestPlanner = null;
    let modelName = "Gemini";
    let turnCount = 0;
    let plannerStepCount = 0;
    let cumulativeOutputTokens = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      let step;
      try {
        step = JSON.parse(line);
      } catch {
        continue;
      }
      if (step.type === "USER_INPUT") {
        turnCount++;
        if (typeof step.content === "string") {
          const m = step.content.match(/changed setting `Model Selection` from .*? to ([^\n.]+)/);
          if (m && m[1]) modelName = m[1].trim();
        }
      } else if (step.type === "PLANNER_RESPONSE" || step.token_usage) {
        const u = step.token_usage && typeof step.token_usage === "object" ? step.token_usage : step;
        const inp = Number(u.input_tokens) || 0;
        const cache = Number(u.cache_read_tokens) || 0;
        const out = Number(u.output_tokens) || 0;
        const tot = inp + cache + out;
        if (u.model && typeof u.model === "string") {
          modelName = u.model;
        }
        if (tot > 0) {
          plannerStepCount++;
          cumulativeOutputTokens += out;
          latestPlanner = { inp, cache, out, tot };
        }
      }
    }

    const inputTokens = latestPlanner ? latestPlanner.inp : 0;
    const cacheReadTokens = latestPlanner ? latestPlanner.cache : 0;
    const outputTokens = latestPlanner ? latestPlanner.out : 0;
    const promptTokens = inputTokens + cacheReadTokens;
    const totalTokens = promptTokens + outputTokens;
    const cacheHitRate =
      promptTokens > 0 ? Math.round((cacheReadTokens / promptTokens) * 1000) / 10 : 0;

    return {
      conversationId: resolved.conversationId,
      modelName,
      inputTokens,
      cacheReadTokens,
      outputTokens,
      totalTokens,
      cumulativeOutputTokens,
      cacheHitRate,
      turnCount,
      plannerStepCount,
      pluginEnabled: isPluginEnabled(),
    };
  } catch {
    return empty;
  }
}

function getComposerDonutScript() {
  const candidates = [
    path.join(__dirname, "..", "renderer", "composer-donut.js"),
    path.join(os.homedir(), ".gemini", "config", "plugins", "context-donut", "renderer", "composer-donut.js"),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      return fs.readFileSync(p, "utf8");
    }
  }
  return "";
}

function startLocalContextServer() {
  try {
    const server = http.createServer((req, res) => {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
      if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
      }
      const u = new URL(req.url || "/", "http://127.0.0.1");
      if (u.pathname === "/api/context") {
        const cid = u.searchParams.get("conversationId") || "";
        const data = parseTranscriptFast(cid);
        res.writeHead(200, {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store",
        });
        res.end(JSON.stringify(data));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
    });
    server.on("error", () => {});
    server.listen(FIXED_PORT, "127.0.0.1");
  } catch {}
}

function installMainProcessHook() {
  if (global.__AGY_CONTEXT_DONUT_MAIN_HOOK__) return;
  global.__AGY_CONTEXT_DONUT_MAIN_HOOK__ = true;

  startLocalContextServer();

  try {
    const electron = require("electron");
    if (!electron || !electron.app) return;

    if (electron.ipcMain) {
      try {
        electron.ipcMain.handle("context-donut:get-usage", (_event, cid) => {
          return parseTranscriptFast(cid);
        });
      } catch {}
    }

    const injectIntoWebContents = (wc) => {
      if (!wc || wc.isDestroyed?.()) return;
      const tryInject = () => {
        if (wc.isDestroyed?.()) return;
        const url = wc.getURL?.() || "";
        if (!url.startsWith("http://127.0.0.1") && !url.startsWith("https://127.0.0.1") && !url.startsWith("http://localhost")) {
          return;
        }
        const code = getComposerDonutScript();
        if (code) {
          wc.executeJavaScript(code).catch(() => {});
        }
      };
      wc.on("dom-ready", tryInject);
      wc.on("did-finish-load", tryInject);
      setTimeout(tryInject, 1200);
    };

    electron.app.on("web-contents-created", (_event, wc) => {
      injectIntoWebContents(wc);
    });

    electron.app.whenReady().then(() => {
      const all = electron.webContents?.getAllWebContents?.() || [];
      for (const wc of all) {
        injectIntoWebContents(wc);
      }
    });
  } catch {}
}

installMainProcessHook();
