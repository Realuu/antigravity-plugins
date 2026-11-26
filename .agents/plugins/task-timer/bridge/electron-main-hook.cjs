"use strict";
/**
 * Antigravity Task Timer — Electron 主进程注入钩子 (CommonJS)
 *
 * 作用：
 * 1. 检查插件配置是否启用（默认启用，除非 ~/.gemini/config/config.json 显式禁用）；
 * 2. 监听所有 Hub 主窗口的 dom-ready / did-finish-load 事件，自动注入 renderer/task-timer.js；
 * 3. 纯渲染层读取 React Fiber 时间戳，零端口、零磁盘轮询，天然兼容 Windows 本地与 WSL 2 模式。
 */
const fs = require("fs");
const path = require("path");
const os = require("os");

function isPluginEnabled() {
  try {
    const cfgPath = path.join(os.homedir(), ".gemini", "config", "config.json");
    if (!fs.existsSync(cfgPath)) return true;
    const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
    if (cfg && cfg.plugins && cfg.plugins["task-timer"] && cfg.plugins["task-timer"].enabled === false) {
      return false;
    }
    return true;
  } catch {
    return true;
  }
}

function getRendererScript() {
  const candidates = [
    path.join(__dirname, "..", "renderer", "task-timer.js"),
    path.join(os.homedir(), ".gemini", "config", "plugins", "task-timer", "renderer", "task-timer.js"),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      return fs.readFileSync(p, "utf8");
    }
  }
  return "";
}

function installMainProcessHook() {
  if (global.__AGY_TASK_TIMER_MAIN_HOOK__) return;
  global.__AGY_TASK_TIMER_MAIN_HOOK__ = true;

  try {
    const electron = require("electron");
    if (!electron || !electron.app) return;

    const injectIntoWebContents = (wc) => {
      if (!wc || (wc.isDestroyed && wc.isDestroyed())) return;
      const tryInject = () => {
        if (!isPluginEnabled()) return;
        if (wc.isDestroyed && wc.isDestroyed()) return;
        const url = (wc.getURL && wc.getURL()) || "";
        if (
          !url.startsWith("http://127.0.0.1") &&
          !url.startsWith("https://127.0.0.1") &&
          !url.startsWith("http://localhost")
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
      setTimeout(tryInject, 1000);
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
