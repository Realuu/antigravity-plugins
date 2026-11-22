"use strict";
/**
 * Antigravity Tab Suggest — Electron 主进程桥接钩子 (CommonJS)
 *
 * 作用：
 * 1. 检查插件启用状态（兼容 Windows 本地与活动 WSL 发行版配置）；
 * 2. 自动保活本地智能补全服务（`127.0.0.1:45794`）；
 * 3. 注册 IPC 通道：`tab-suggest:insert-text`（向当前聚焦的 Lexical 编辑器精准写入补全文本）；
 * 4. 向所有 Antigravity Hub 主界面窗口自动注入 `renderer/composer-ghost.js`（跳过各插件本地服务端口）。
 */
const fs = require("fs");
const path = require("path");
const os = require("os");
const http = require("http");
const { spawn } = require("child_process");

const SERVICE_HOST = "127.0.0.1";
const SERVICE_PORT = 45794;
const IGNORED_PLUGIN_PORTS = new Set([
  "45789",
  "45790",
  "45791",
  "45792",
  "45793",
  "45794",
  "43217",
]);

function isPluginEnabled() {
  try {
    const cfgPath = path.join(os.homedir(), ".gemini", "config", "config.json");
    if (!fs.existsSync(cfgPath)) return true;
    const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
    if (
      cfg &&
      cfg.plugins &&
      cfg.plugins["tab-suggest"] &&
      cfg.plugins["tab-suggest"].enabled === false
    ) {
      return false;
    }
    return true;
  } catch {
    return true;
  }
}

function resolveServiceScript() {
  const candidates = [
    path.join(__dirname, "..", "scripts", "suggest-service.mjs"),
    path.join(
      os.homedir(),
      ".gemini",
      "config",
      "plugins",
      "tab-suggest",
      "scripts",
      "suggest-service.mjs"
    ),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return "";
}

function getRendererScript() {
  const candidates = [
    path.join(__dirname, "..", "renderer", "composer-ghost.js"),
    path.join(
      os.homedir(),
      ".gemini",
      "config",
      "plugins",
      "tab-suggest",
      "renderer",
      "composer-ghost.js"
    ),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      return fs.readFileSync(p, "utf8");
    }
  }
  return "";
}

function probeServiceAlive() {
  return new Promise((resolve) => {
    const req = http.get(
      { host: SERVICE_HOST, port: SERVICE_PORT, path: "/api/health", timeout: 700 },
      (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      }
    );
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      try {
        req.destroy();
      } catch {}
      resolve(false);
    });
  });
}

let serviceStarting = false;
async function ensureSuggestServiceRunning() {
  if (!isPluginEnabled() || serviceStarting) return;
  const alive = await probeServiceAlive();
  if (alive) return;

  const scriptPath = resolveServiceScript();
  if (!scriptPath) return;

  serviceStarting = true;
  try {
    const nodeExe =
      process.execPath && !path.basename(process.execPath).toLowerCase().includes("antigravity")
        ? process.execPath
        : "node";
    const child = spawn(nodeExe, [scriptPath, "serve"], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: { ...process.env },
    });
    child.unref();
  } catch {}

  setTimeout(() => {
    serviceStarting = false;
  }, 2000);
}

function isHubMainPageUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== "string") return false;
  try {
    const u = new URL(rawUrl);
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    if (u.hostname !== "127.0.0.1" && u.hostname !== "localhost") return false;
    if (IGNORED_PLUGIN_PORTS.has(String(u.port || ""))) return false;
    return true;
  } catch {
    return false;
  }
}

function installMainProcessHook() {
  if (global.__AGY_TAB_SUGGEST_MAIN_HOOK__) return;
  global.__AGY_TAB_SUGGEST_MAIN_HOOK__ = true;

  try {
    const electron = require("electron");
    if (!electron || !electron.app) return;

    void ensureSuggestServiceRunning();

    if (electron.ipcMain) {
      try {
        electron.ipcMain.handle("tab-suggest:insert-text", async (event, text) => {
          const str = typeof text === "string" ? text : String(text || "");
          if (!str) return { ok: false };
          try {
            event.sender.focus();
            await event.sender.insertText(str);
            return { ok: true };
          } catch (err) {
            return { ok: false, error: err?.message || String(err) };
          }
        });
      } catch {}
    }

    const injectIntoWebContents = (wc) => {
      if (!wc || (wc.isDestroyed && wc.isDestroyed())) return;
      const tryInject = () => {
        if (!isPluginEnabled()) return;
        if (wc.isDestroyed && wc.isDestroyed()) return;
        const url = (wc.getURL && wc.getURL()) || "";
        if (!isHubMainPageUrl(url)) return;

        void ensureSuggestServiceRunning();
        const code = getRendererScript();
        if (code) {
          wc.executeJavaScript(code).catch(() => {});
        }
      };
      wc.on("dom-ready", tryInject);
      wc.on("did-finish-load", tryInject);
      setTimeout(tryInject, 950);
    };

    electron.app.on("web-contents-created", (_event, wc) => {
      injectIntoWebContents(wc);
    });

    electron.app.whenReady().then(() => {
      void ensureSuggestServiceRunning();
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
