"use strict";
/**
 * Antigravity Codex Aurora Theme — Electron 主进程注入钩子 (CommonJS)
 *
 * 作用：
 * 1. 检查插件配置是否启用（默认启用，除非 ~/.gemini/config/config.json 显式禁用）；
 * 2. 在 Windows 11 下打通 BaseWindow（Acrylic 亚克力材质）+ curtainView + hubWcv 三层透明链路；
 * 3. 注册 `codex-theme:set-backdrop` IPC，随前端深/浅色切换及内置浏览器停靠标签实时同步窗口透明度；
 * 4. 监听所有 Hub 主窗口的 dom-ready / did-finish-load 事件，自动注入 codex-ui-theme.js。
 */
const fs = require("fs");
const path = require("path");
const os = require("os");

const winBackdropStates = new WeakMap();
const LIGHT_TITLEBAR_OVERLAY = { color: "#ebf2fa", symbolColor: "#334155", height: 30 };

function isOpaqueLightColor(color) {
  if (typeof color !== "string") return false;
  const trimmed = color.trim();
  if (/^#(?:0{8}|0{4})$/i.test(trimmed) || /^transparent$/i.test(trimmed)) {
    return false;
  }
  const hex6 = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(trimmed);
  if (hex6) {
    const r = parseInt(hex6[1], 16);
    const g = parseInt(hex6[2], 16);
    const b = parseInt(hex6[3], 16);
    return r >= 180 && g >= 180 && b >= 180;
  }
  const hex8 = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(trimmed);
  if (hex8) {
    // Electron setBackgroundColor 支持 #AARRGGBB（8 位 Hex），仅对非全透明浅色拦截
    const a = parseInt(hex8[1], 16);
    if (a === 0) return false;
    const r = parseInt(hex8[2], 16);
    const g = parseInt(hex8[3], 16);
    const b = parseInt(hex8[4], 16);
    return r >= 180 && g >= 180 && b >= 180;
  }
  return false;
}

function isPluginEnabled() {
  try {
    const cfgPath = path.join(os.homedir(), ".gemini", "config", "config.json");
    if (!fs.existsSync(cfgPath)) return true;
    const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
    if (cfg && cfg.plugins && cfg.plugins["codex-theme"] && cfg.plugins["codex-theme"].enabled === false) {
      return false;
    }
    return true;
  } catch {
    return true;
  }
}

function getRendererScript() {
  const candidates = [
    path.join(__dirname, "..", "renderer", "codex-ui-theme.js"),
    path.join(os.homedir(), ".gemini", "config", "plugins", "codex-theme", "renderer", "codex-ui-theme.js"),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      return fs.readFileSync(p, "utf8");
    }
  }
  return "";
}

function getAllCandidateWindows(electron) {
  const baseWins =
    typeof electron.BaseWindow?.getAllWindows === "function"
      ? electron.BaseWindow.getAllWindows()
      : [];
  const browserWins =
    typeof electron.BrowserWindow?.getAllWindows === "function"
      ? electron.BrowserWindow.getAllWindows()
      : [];
  const seen = new Set();
  const list = [];
  for (const w of [...baseWins, ...browserWins]) {
    if (!w || typeof w !== "object" || seen.has(w) || w.isDestroyed?.()) {
      continue;
    }
    seen.add(w);
    list.push(w);
  }
  return list;
}

function resolveHubWindow(electron, wc) {
  if (!wc) return null;
  for (const win of getAllCandidateWindows(electron)) {
    try {
      if (win.webContents === wc || win.webContents?.id === wc.id) {
        return win;
      }
      const kids = win.contentView?.children;
      if (Array.isArray(kids)) {
        for (const child of kids) {
          if (child?.webContents === wc || child?.webContents?.id === wc.id) {
            return win;
          }
        }
      }
    } catch {}
  }
  return null;
}

function findHubView(win, hubWc) {
  const kids = win?.contentView?.children;
  if (!Array.isArray(kids) || !hubWc) return null;
  for (const child of kids) {
    try {
      const cwc = child?.webContents;
      if (!cwc || cwc.isDestroyed?.()) continue;
      if (cwc === hubWc || (typeof cwc.id === "number" && cwc.id === hubWc.id)) {
        return child;
      }
    } catch {}
  }
  return null;
}

function findCurtainView(win, hubWc) {
  const kids = win?.contentView?.children;
  if (!Array.isArray(kids)) return null;
  for (const child of kids) {
    try {
      const cwc = child?.webContents;
      if (!cwc || cwc.isDestroyed?.() || cwc === hubWc) continue;
      const url = String(cwc.getURL?.() || "");
      if (url.startsWith("data:text/html")) {
        return child;
      }
    } catch {}
  }
  return null;
}

function hasParkedViewsBehindCurtain(win, curtainView) {
  const kids = win?.contentView?.children;
  if (!Array.isArray(kids) || !curtainView) return false;
  return kids.indexOf(curtainView) > 0;
}

function ensureWindowState(win, curtainView, hubView) {
  let state = winBackdropStates.get(win);
  if (!state) {
    const origWinSetBg =
      typeof win.setBackgroundColor === "function" ? win.setBackgroundColor.bind(win) : null;
    const origWinSetTitleBarOverlay =
      typeof win.setTitleBarOverlay === "function" ? win.setTitleBarOverlay.bind(win) : null;
    state = {
      mode: "none",
      origWinSetBg,
      origWinSetTitleBarOverlay,
      hubView: null,
      origHubSetBg: null,
      curtainView: null,
      origCurtainSetBg: null,
      curtainCssKey: undefined,
      curtainCssText: "",
      hookedCurtainWc: null,
      hookedWindowEvents: false,
      reconcileChain: Promise.resolve(),
    };
    winBackdropStates.set(win, state);

    if (origWinSetBg) {
      win.setBackgroundColor = (color) => {
        if (state.mode === "light-translucent" && isPluginEnabled() && isOpaqueLightColor(color)) {
          return;
        }
        return origWinSetBg(color);
      };
    }

    if (origWinSetTitleBarOverlay) {
      win.setTitleBarOverlay = (options) => {
        if (state.mode === "light-translucent" && isPluginEnabled()) {
          return origWinSetTitleBarOverlay({
            color: LIGHT_TITLEBAR_OVERLAY.color,
            symbolColor: LIGHT_TITLEBAR_OVERLAY.symbolColor,
            height: options?.height || LIGHT_TITLEBAR_OVERLAY.height,
          });
        }
        return origWinSetTitleBarOverlay(options);
      };
    }
  }

  if (hubView && state.hubView !== hubView) {
    state.hubView = hubView;
    const origHubSetBg =
      typeof hubView.setBackgroundColor === "function"
        ? hubView.setBackgroundColor.bind(hubView)
        : null;
    state.origHubSetBg = origHubSetBg;

    if (origHubSetBg) {
      // 拦截新版 Antigravity setHubSurfaceTransparent(win, false) / setHubCurtainColor 将 hubWcv 重置为实色 #FAFAFA
      hubView.setBackgroundColor = (color) => {
        if (state.mode === "light-translucent" && isPluginEnabled() && isOpaqueLightColor(color)) {
          return;
        }
        return origHubSetBg(color);
      };
    }
  }

  if (curtainView && state.curtainView !== curtainView) {
    state.curtainView = curtainView;
    const origCurtainSetBg =
      typeof curtainView.setBackgroundColor === "function"
        ? curtainView.setBackgroundColor.bind(curtainView)
        : null;
    state.origCurtainSetBg = origCurtainSetBg;

    if (origCurtainSetBg) {
      curtainView.setBackgroundColor = (color) => {
        if (state.mode === "light-translucent" && isPluginEnabled() && isOpaqueLightColor(color)) {
          return;
        }
        return origCurtainSetBg(color);
      };
    }
  }

  return state;
}

function queueCurtainCssUpdate(state, targetCss) {
  const curtain = state.curtainView;
  const cwc = curtain?.webContents;
  if (!cwc || cwc.isDestroyed?.()) return;

  state.reconcileChain = state.reconcileChain.then(async () => {
    if (cwc.isDestroyed?.()) return;
    if (!targetCss) {
      if (state.curtainCssKey) {
        const oldKey = state.curtainCssKey;
        state.curtainCssKey = undefined;
        state.curtainCssText = "";
        await cwc.removeInsertedCSS(oldKey).catch(() => {});
      }
      return;
    }

    if (state.curtainCssText === targetCss && state.curtainCssKey) {
      return;
    }

    const oldKey = state.curtainCssKey;
    const newKey = await cwc.insertCSS(targetCss, { cssOrigin: "user" }).catch(() => undefined);
    if (typeof newKey === "string" && newKey) {
      state.curtainCssKey = newKey;
      state.curtainCssText = targetCss;
      if (oldKey && oldKey !== newKey) {
        await cwc.removeInsertedCSS(oldKey).catch(() => {});
      }
    }
  });
}

function syncCurtainLayer(win, state) {
  const curtain = state.curtainView;
  if (!curtain || curtain.webContents?.isDestroyed?.()) return;
  if (state.mode !== "light-translucent") return;

  state.origCurtainSetBg?.("#00000000");
  const hasParked = hasParkedViewsBehindCurtain(win, curtain);
  if (hasParked) {
    curtain.setVisible?.(true);
    queueCurtainCssUpdate(
      state,
      "html, body { background: linear-gradient(90deg, transparent 0px, transparent 256px, #ffffff 256px) !important; }"
    );
  } else {
    curtain.setVisible?.(false);
    queueCurtainCssUpdate(state, "html, body { background: transparent !important; }");
  }
}

function applyBackdropToWindow(electron, win, hubWc, mode) {
  if (process.platform !== "win32") {
    return { ok: false, reason: "non-win32" };
  }
  if (!win || win.isDestroyed?.()) {
    return { ok: false, reason: "window-destroyed" };
  }

  const resolvedHubWc = hubWc || win.webContents;
  const hubView = findHubView(win, resolvedHubWc);
  const curtainView = findCurtainView(win, resolvedHubWc);
  const state = ensureWindowState(win, curtainView, hubView);

  if (mode === "light-translucent" && isPluginEnabled()) {
    state.mode = "light-translucent";
    try {
      state.origWinSetBg?.("#00000000");
    } catch {}
    try {
      state.origHubSetBg?.("#00000000");
    } catch {}
    try {
      win.setBackgroundMaterial?.("acrylic");
    } catch {
      try {
        win.setBackgroundMaterial?.("mica");
      } catch {}
    }
    try {
      state.origWinSetTitleBarOverlay?.(LIGHT_TITLEBAR_OVERLAY);
    } catch {}

    if (curtainView) {
      syncCurtainLayer(win, state);
      const cwc = curtainView.webContents;
      if (cwc && state.hookedCurtainWc !== cwc) {
        state.hookedCurtainWc = cwc;
        cwc.on?.("did-finish-load", () => {
          state.curtainCssKey = undefined;
          state.curtainCssText = "";
          if (state.mode === "light-translucent") {
            syncCurtainLayer(win, state);
          }
        });
      }
    }

    if (!state.hookedWindowEvents) {
      state.hookedWindowEvents = true;
      const onWinEvent = () => {
        if (!win.isDestroyed?.() && state.mode === "light-translucent") {
          const cur = findCurtainView(win, resolvedHubWc);
          const hub = findHubView(win, resolvedHubWc);
          const hubChanged = Boolean(hub && state.hubView !== hub);
          ensureWindowState(win, cur, hub);
          if (hubChanged) {
            try {
              state.origHubSetBg?.("#00000000");
            } catch {}
          }
          syncCurtainLayer(win, state);
        }
      };
      win.on?.("focus", onWinEvent);
      win.on?.("resize", onWinEvent);
    }

    return { ok: true, mode: "light-translucent", hubViewBound: Boolean(state.hubView) };
  }

  const normalizedMode = mode === "restore-light" ? "restore-light" : "dark-opaque";
  const fallbackBg = normalizedMode === "dark-opaque" ? "#131313" : "#FAFAFA";
  state.mode = normalizedMode;

  if (state.curtainView) {
    queueCurtainCssUpdate(state, "");
    try {
      state.curtainView.setVisible?.(true);
    } catch {}
    try {
      state.origCurtainSetBg?.(fallbackBg);
    } catch {}
  }

  try {
    state.origHubSetBg?.(fallbackBg);
  } catch {}
  try {
    win.setBackgroundMaterial?.("none");
  } catch {}
  try {
    state.origWinSetBg?.(fallbackBg);
  } catch {}

  return { ok: true, mode: normalizedMode };
}

function installMainProcessHook() {
  if (global.__AGY_CODEX_THEME_MAIN_HOOK__) return;
  global.__AGY_CODEX_THEME_MAIN_HOOK__ = true;

  try {
    const electron = require("electron");
    if (!electron || !electron.app) return;

    if (electron.ipcMain) {
      try {
        electron.ipcMain.handle("codex-theme:set-backdrop", async (event, mode) => {
          const win = resolveHubWindow(electron, event.sender);
          if (!win) return { ok: false, reason: "hub-window-not-found" };
          return applyBackdropToWindow(electron, win, event.sender, String(mode || ""));
        });
      } catch {}
    }

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
        wc.executeJavaScript(
          "(() => { try { const b = document.body; const r = document.documentElement; if (b && (b.classList.contains('theme-dark') || b.classList.contains('dark') || r.classList.contains('dark'))) return false; if (b && b.classList.contains('theme-light')) return true; return getComputedStyle(r).colorScheme === 'light'; } catch { return false; } })()"
        )
          .then((isLight) => {
            if (!isLight) return;
            const win = resolveHubWindow(electron, wc);
            if (win) {
              applyBackdropToWindow(electron, win, wc, "light-translucent");
            }
          })
          .catch(() => {});
      };
      wc.on("dom-ready", tryInject);
      wc.on("did-finish-load", tryInject);
      setTimeout(tryInject, 800);
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
