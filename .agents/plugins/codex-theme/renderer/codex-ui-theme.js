/**
 * Antigravity Codex Aurora Theme — 极光冰蓝（顶部实色 + 左侧半透明玻璃透底）主题渲染注入脚本
 *
 * 视觉设计与交互规范：
 * 1. 仅在浅色模式（body.theme-light 且非 dark/theme-dark）生效，深色模式严格保持原版外观；
 * 2. 顶部菜单栏（含右上角 titleBarOverlay）与右侧工作区外框采用实心不透明 Codex 极光冰蓝（#eaf2fa → #eff4f9）；
 * 3. 仅左侧任务栏 [role="navigation"] 保留清透半透明浅冰蓝玻璃层，打通底层 Windows Acrylic 亚克力材质真实透底；
 * 4. 右侧主对话区卡片与辅助面板保持实心纯白 #ffffff + 柔和冷蓝描边与悬浮阴影，提升层次感；
 * 5. 左侧“新建对话”按钮、会话项悬停/选中态与左下角 Quota Pill 按钮同步适配为清透毛玻璃白质感；
 * 6. 完整兼容内置浏览器 browser-hole 打洞机制与实时深/浅色模式切换。
 */
(function installAntigravityCodexTheme() {
  if (window.__AGY_CODEX_THEME_LOCKED__ && !window.__AGY_CODEX_THEME_FORCE_RELOAD__) {
    return;
  }
  window.__AGY_CODEX_THEME_FORCE_RELOAD__ = false;
  window.__AGY_CODEX_THEME_LOCKED__ = true;

  if (typeof window.__AGY_CODEX_THEME_CLEANUP__ === 'function') {
    try {
      window.__AGY_CODEX_THEME_CLEANUP__(true);
    } catch {}
  }

  document.getElementById('agy-codex-theme-styles')?.remove();

  window.__AGY_CODEX_THEME_INSTALLED__ = true;
  window.__AGY_CODEX_THEME_VERSION__ = '1.5.1';

  const STYLE_ID = 'agy-codex-theme-styles';
  const LIGHT_OVERLAY = { color: '#ebf2fa', symbolColor: '#334155' };
  const DEFAULT_LIGHT_OVERLAY = { color: '#f4f4f6', symbolColor: '#383A42' };
  const DEFAULT_DARK_OVERLAY = { color: '#131313', symbolColor: '#FAFAFA' };

  let lastAppliedMode = null;
  let themeObserver = null;
  let syncTimers = [];

  function isLightTheme() {
    try {
      const body = document.body;
      const root = document.documentElement;
      if (
        body?.classList.contains('theme-dark') ||
        body?.classList.contains('dark') ||
        root?.classList.contains('dark')
      ) {
        return false;
      }
      if (body?.classList.contains('theme-light')) {
        return true;
      }
      return getComputedStyle(root).colorScheme === 'light';
    } catch {
      return false;
    }
  }

  function applyTitleBarOverlay(options) {
    try {
      const api = window.electronNative;
      if (api && typeof api.setTitleBarOverlay === 'function') {
        void api.setTitleBarOverlay(options);
      }
    } catch {}
  }

  async function applyBackdropMode(mode) {
    try {
      const ipc = window.__agyCodexThemeIPC;
      if (ipc && typeof ipc.setBackdropMode === 'function') {
        await ipc.setBackdropMode(mode);
      }
    } catch {}
  }

  function syncTitleBarOverlay(force = false) {
    const light = isLightTheme();
    const mode = light ? 'light' : 'dark';
    if (!force && lastAppliedMode === mode) {
      return;
    }
    if (light) {
      lastAppliedMode = 'light';
      void (async () => {
        await applyBackdropMode('light-translucent');
        if (isLightTheme()) {
          applyTitleBarOverlay(LIGHT_OVERLAY);
        }
      })();
    } else if (lastAppliedMode === 'light' || force) {
      lastAppliedMode = 'dark';
      void (async () => {
        await applyBackdropMode('dark-opaque');
        if (!isLightTheme()) {
          applyTitleBarOverlay(DEFAULT_DARK_OVERLAY);
        }
      })();
    } else {
      lastAppliedMode = 'dark';
    }
  }

  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      /* 1. 浅色非打洞模式下打通外层透明通道，供左侧栏透出底层 Acrylic 材质（不改 --background） */
      html:has(body.theme-light:not(.dark):not(.theme-dark):not([data-has-browser-hole="true"])),
      body.theme-light:not(.dark):not(.theme-dark):not([data-has-browser-hole="true"]),
      body.theme-light:not(.dark):not(.theme-dark):not([data-has-browser-hole="true"]) #root,
      body.theme-light:not(.dark):not(.theme-dark):not([data-has-browser-hole="true"]) .agy-shell:not([data-has-browser-hole="true"]),
      body.theme-light:not(.dark):not(.theme-dark):not([data-has-browser-hole="true"]) .agy-inset-shell:not([data-has-browser-hole="true"]) {
        background-color: transparent !important;
        background-image: none !important;
      }

      /* 2. 浅色模式局部与左侧栏变量（--sidebar 保持实色 Hex，避免宿主 Z3b 因 alpha<1 回退为纯白 titleBarOverlay） */
      body.theme-light:not(.dark):not(.theme-dark) {
        --codex-topbar-aurora:
          radial-gradient(ellipse 75% 88px at 46% 0%, #dfedfc 0%, rgba(235, 242, 250, 0) 100%),
          linear-gradient(180deg, #e8f1fb 0%, #eff4f9 100%);
        --codex-sidebar-translucent:
          linear-gradient(180deg, rgba(238, 245, 254, 0.16) 0%, rgba(252, 253, 254, 0.00) 28px);
        --shell: #eff4f9 !important;
        --shell-canvas: #eff4f9 !important;
        --onyx-frame: #eff4f9 !important;
        --sidebar: #ebf2fa !important;
        --sidebar-muted: rgba(15, 23, 42, 0.04) !important;
        --sidebar-secondary: rgba(15, 23, 42, 0.055) !important;
        --onyx-selected: rgba(15, 23, 42, 0.058) !important;
      }

      /* 3. 顶部菜单栏：实心不透明 Codex 极光冰蓝渐变，与右上角 titleBarOverlay 无缝衔接 */
      body.theme-light:not(.dark):not(.theme-dark) [data-testid="title-menu-bar"]:not([data-has-browser-hole="true"]) {
        background-color: #ebf2fa !important;
        background-image: var(--codex-topbar-aurora) !important;
      }

      /* 4. 左侧任务栏：对齐 Codex 隐隐透色质感（单层 90% 清浅冷瓷白，仅顶缘 28px 柔和衔接顶栏，叠 Acrylic 呈现 #F0F4F9~#F3F6FA 隐约透底） */
      body.theme-light:not(.dark):not(.theme-dark) .agy-inset-shell [role="navigation"]:not([data-has-browser-hole="true"]) {
        --sidebar: transparent !important;
        background-color: rgba(252, 253, 254, 0.90) !important;
        background-image: var(--codex-sidebar-translucent) !important;
      }

      /* 4.1 清除左侧栏内部项目目录头与分组头的实心底色块，保持整条侧栏浑然一体无补丁色差 */
      body.theme-light:not(.dark):not(.theme-dark) .agy-inset-shell [role="navigation"] .bg-sidebar,
      body.theme-light:not(.dark):not(.theme-dark) .agy-inset-shell [role="navigation"] [data-sidebar-section-drop-id],
      body.theme-light:not(.dark):not(.theme-dark) .agy-inset-shell [role="navigation"] [data-testid="pinned-section-header"],
      body.theme-light:not(.dark):not(.theme-dark) .agy-inset-shell [role="navigation"] [data-testid="project-header"] {
        background-color: transparent !important;
        background-image: none !important;
      }

      body.theme-light:not(.dark):not(.theme-dark) .agy-inset-shell [role="navigation"] [data-sidebar-section-drop-id="main-section-header"] {
        background-color: rgba(252, 253, 254, 0.16) !important;
        backdrop-filter: blur(12px);
        -webkit-backdrop-filter: blur(12px);
      }

      /* 5. 左右 1px 分割线与右侧工作区外框：常规模式下保持实心不透明（不透出下方窗口） */
      body.theme-light:not(.dark):not(.theme-dark):not([data-has-browser-hole="true"]) .agy-inset-shell:not([data-has-browser-hole="true"]) [data-split-sash="true"] {
        background-color: #e6ebf1 !important;
        background-image: none !important;
      }

      body.theme-light:not(.dark):not(.theme-dark):not([data-has-browser-hole="true"]) .agy-inset-shell:not([data-has-browser-hole="true"]) .agy-sheet[data-sheet-inset]:not([data-has-browser-hole="true"]) {
        background-color: #eff4f9 !important;
        background-image: none !important;
      }

      body.theme-light:not(.dark):not(.theme-dark) .agy-inset-shell .agy-sheet[data-sheet-inset] [data-main-content-header]:not([data-has-browser-hole="true"]),
      body.theme-light:not(.dark):not(.theme-dark) .agy-inset-shell .agy-sheet[data-sheet-inset] [data-side-panel-strip]:not([data-has-browser-hole="true"]) {
        background-color: #eff4f9 !important;
        background-image: none !important;
      }

      /* 6. 右侧主对话卡片与辅助面板：保持实心纯白 #ffffff + 柔和冷蓝细描边与轻悬浮阴影 */
      body.theme-light:not(.dark):not(.theme-dark) .agy-inset-shell {
        --card-edge: rgba(15, 35, 68, 0.08);
        --card-radius: 14px;
        --sash-line: rgba(15, 35, 68, 0.08);
      }

      body.theme-light:not(.dark):not(.theme-dark) .agy-sheet[data-sheet-inset] [data-main-content-body]:not([data-has-browser-hole="true"]),
      body.theme-light:not(.dark):not(.theme-dark) .agy-inset-shell [data-side-panel-body]:not([data-has-browser-hole="true"]) {
        background-color: #ffffff !important;
        box-shadow: 0 2px 10px -2px rgba(15, 35, 68, 0.045), 0 1px 2px rgba(15, 35, 68, 0.025);
      }

      body.theme-light:not(.dark):not(.theme-dark) [data-testid="sidecar-iframe-slot"] {
        background-color: #ffffff !important;
      }

      /* 7. 左侧「+ 新建对话」按钮：清透纯白胶囊 + 柔和冷灰细边框 */
      body.theme-light:not(.dark):not(.theme-dark) [data-testid="new-conversation-button"] {
        background-color: rgba(255, 255, 255, 0.92) !important;
        border-color: rgba(15, 35, 68, 0.10) !important;
        box-shadow: 0 1px 2px rgba(15, 35, 68, 0.04);
        backdrop-filter: blur(8px);
        -webkit-backdrop-filter: blur(8px);
      }

      body.theme-light:not(.dark):not(.theme-dark) [data-testid="new-conversation-button"]:hover {
        background-color: rgba(241, 245, 250, 0.96) !important;
        border-color: rgba(15, 35, 68, 0.14) !important;
      }

      /* 8. 左侧导航项、项目目录头与会话列表悬停 / 选中态适配（对齐 Codex 浅雾灰胶囊 #eeeeef） */
      body.theme-light:not(.dark):not(.theme-dark) .agy-sidebar-row:hover {
        background-color: rgba(15, 23, 42, 0.038) !important;
        --row-bg: #f1f3f6 !important;
      }

      body.theme-light:not(.dark):not(.theme-dark) [data-testid="sidebar-navigation-items"] a:not([data-testid="new-conversation-button"]):hover,
      body.theme-light:not(.dark):not(.theme-dark) .agy-inset-shell [role="navigation"] [data-testid="project-header"]:hover {
        background-color: rgba(15, 23, 42, 0.038) !important;
      }

      body.theme-light:not(.dark):not(.theme-dark) .agy-sidebar-row[data-selected="true"] {
        background-color: rgba(15, 23, 42, 0.058) !important;
        box-shadow: inset 0 0 0 1px rgba(15, 23, 42, 0.035) !important;
        --row-bg: #eceef1 !important;
      }

      body.theme-light:not(.dark):not(.theme-dark) .agy-sidebar-row[data-selected="true"]:hover {
        background-color: rgba(15, 23, 42, 0.072) !important;
        --row-bg: #e9ecf0 !important;
      }

      /* 9. 顶栏菜单项与工具图标悬停态柔和冷蓝融底 */
      body.theme-light:not(.dark):not(.theme-dark) [data-testid="title-menu-bar-item"]:hover,
      body.theme-light:not(.dark):not(.theme-dark) [data-main-content-header] button:hover,
      body.theme-light:not(.dark):not(.theme-dark) [data-main-content-header] [data-testid="breadcrumb-segment"]:hover,
      body.theme-light:not(.dark):not(.theme-dark) .agy-inset-shell [role="navigation"] > div:first-child button:hover {
        background-color: rgba(15, 38, 74, 0.055) !important;
      }

      /* 10. 联动左下角 Quota Pill 按钮在浅冷瓷白侧栏中的清晰毛玻璃质感 */
      body.theme-light:not(.dark):not(.theme-dark) .agy-codex-quota-dock[data-theme="light"] .agy-codex-quota-btn {
        background: rgba(255, 255, 255, 0.92) !important;
        border-color: rgba(15, 35, 68, 0.10) !important;
        box-shadow: 0 1px 3px rgba(15, 35, 68, 0.05) !important;
      }

      body.theme-light:not(.dark):not(.theme-dark) .agy-codex-quota-dock[data-theme="light"] .agy-codex-quota-btn:hover,
      body.theme-light:not(.dark):not(.theme-dark) .agy-codex-quota-dock[data-theme="light"] .agy-codex-quota-btn.is-active {
        background: rgba(241, 245, 250, 0.96) !important;
        border-color: rgba(15, 35, 68, 0.14) !important;
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  function start() {
    injectStyles();
    syncTitleBarOverlay(true);

    // 防止启动初期宿主前端晚一步覆盖 titleBarOverlay 或背板色，做两次轻量延迟复核
    syncTimers.push(setTimeout(() => syncTitleBarOverlay(true), 300));
    syncTimers.push(setTimeout(() => syncTitleBarOverlay(true), 1200));

    if (typeof MutationObserver !== 'undefined') {
      themeObserver = new MutationObserver(() => {
        injectStyles();
        syncTitleBarOverlay(false);
      });
      if (document.documentElement) {
        themeObserver.observe(document.documentElement, {
          attributes: true,
          attributeFilter: ['class', 'style'],
        });
      }
      if (document.body) {
        themeObserver.observe(document.body, {
          attributes: true,
          attributeFilter: ['class', 'style', 'data-newux-theme', 'data-agy-theme'],
        });
      }
    }
  }

  window.__AGY_CODEX_THEME_CLEANUP__ = (isReload = false) => {
    try {
      themeObserver?.disconnect();
    } catch {}
    themeObserver = null;
    for (const t of syncTimers) {
      clearTimeout(t);
    }
    syncTimers = [];
    document.getElementById(STYLE_ID)?.remove();
    if (!isReload) {
      if (isLightTheme()) {
        applyTitleBarOverlay(DEFAULT_LIGHT_OVERLAY);
        applyBackdropMode('restore-light');
      } else {
        applyBackdropMode('dark-opaque');
      }
    }
    lastAppliedMode = null;
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
})();
