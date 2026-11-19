"use strict";
/**
 * Antigravity Cowart Sidebar — Electron 主进程注入钩子 (CommonJS)
 *
 * 作用：
 * 1. 检查插件启用状态（~/.gemini/config/config.json）；
 * 2. 自动保活本地 Cowart Stage Server（127.0.0.1:45791）；
 * 3. 注册 IPC 通道：`cowart-sidebar:pick-folder` 与 `cowart-sidebar:insert-text`；
 * 4. 仅向 Antigravity Hub 主界面窗口自动注入 `renderer/cowart-sidebar.js`（跳过插件自身端口）。
 */
const fs = require("fs");
const path = require("path");
const os = require("os");
const http = require("http");
const { spawn } = require("child_process");

const STAGE_HOST = "127.0.0.1";
const STAGE_PORT = 45791;
const IGNORED_PLUGIN_PORTS = new Set(["45789", "45790", "45791", "45792", "45793", "43217"]);

function isPluginEnabled() {
  try {
    const cfgPath = path.join(os.homedir(), ".gemini", "config", "config.json");
    if (!fs.existsSync(cfgPath)) return true;
    const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
    if (cfg && cfg.plugins && cfg.plugins["cowart-sidebar"] && cfg.plugins["cowart-sidebar"].enabled === false) {
      return false;
    }
    return true;
  } catch {
    return true;
  }
}

function resolveStageServerScript() {
  const candidates = [
    path.join(__dirname, "..", "scripts", "cowart-stage-server.mjs"),
    path.join(os.homedir(), ".gemini", "config", "plugins", "cowart-sidebar", "scripts", "cowart-stage-server.mjs"),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return "";
}

function getRendererScript() {
  const candidates = [
    path.join(__dirname, "..", "renderer", "cowart-sidebar.js"),
    path.join(os.homedir(), ".gemini", "config", "plugins", "cowart-sidebar", "renderer", "cowart-sidebar.js"),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      return fs.readFileSync(p, "utf8");
    }
  }
  return "";
}

function probeStageServer() {
  return new Promise((resolve) => {
    const req = http.get(
      { host: STAGE_HOST, port: STAGE_PORT, path: "/api/health", timeout: 800 },
      (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      }
    );
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      try { req.destroy(); } catch {}
      resolve(false);
    });
  });
}

let stageStarting = false;
async function ensureStageServerRunning() {
  if (!isPluginEnabled() || stageStarting) return;
  const alive = await probeStageServer();
  if (alive) return;

  const scriptPath = resolveStageServerScript();
  if (!scriptPath) return;

  stageStarting = true;
  try {
    const nodeExe =
      process.execPath && !path.basename(process.execPath).toLowerCase().includes("antigravity")
        ? process.execPath
        : "node";
    const child = spawn(nodeExe, [scriptPath], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: { ...process.env },
    });
    child.unref();
  } catch {}
  setTimeout(() => {
    stageStarting = false;
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
  if (global.__AGY_COWART_SIDEBAR_MAIN_HOOK__) return;
  global.__AGY_COWART_SIDEBAR_MAIN_HOOK__ = true;

  try {
    const electron = require("electron");
    if (!electron || !electron.app) return;

    void ensureStageServerRunning();

    if (electron.ipcMain) {
      try {
        electron.ipcMain.handle("cowart-sidebar:pick-folder", async (event) => {
          const win = electron.BrowserWindow?.fromWebContents?.(event.sender) || null;
          const res = await electron.dialog.showOpenDialog(win || undefined, {
            title: "选择 Cowart 项目文件夹",
            properties: ["openDirectory", "createDirectory"],
          });
          if (res.canceled || !Array.isArray(res.filePaths) || res.filePaths.length === 0) {
            return { canceled: true, path: "" };
          }
          return { canceled: false, path: res.filePaths[0] };
        });
      } catch {}

      try {
        electron.ipcMain.handle("cowart-sidebar:insert-text", async (event, text) => {
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

        void ensureStageServerRunning();
        const code = getRendererScript();
        if (code) {
          wc.executeJavaScript(code).catch(() => {});
        }
      };
      wc.on("dom-ready", tryInject);
      wc.on("did-finish-load", tryInject);
      setTimeout(tryInject, 900);
    };

    electron.app.on("web-contents-created", (_event, wc) => {
      injectIntoWebContents(wc);
    });

    electron.app.whenReady().then(() => {
      void ensureStageServerRunning();
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
