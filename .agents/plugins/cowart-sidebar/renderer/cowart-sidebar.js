/**
 * Antigravity Cowart Sidebar — 左侧任务栏入口 + 全屏/分栏画布 + 底部悬浮提问胶囊
 *
 * 交互规范：
 * 1. 在左侧导航「自动化」正下方、「自定义配置」上方注入独立 `Cowart` 导航项；
 * 2. 点击打开 Cowart 画布（默认优先打开当前活跃项目 canvas，找不到时回退全局 Documents/Cowart）；
 * 3. 默认进入全屏画布 + 底部紧凑悬浮提问胶囊（自动把画布内中间工具栏上移避让 62px）；
 * 4. 在下方提问胶囊发送问题、或在画布内点击「按标注修改 / 生成」触发 followUp 时：
 *    自动切换为「左侧主画布 + 右侧窄聊天栏」同屏分栏并提交给右侧原生 Antigravity 会话；
 * 5. 右上角支持切换项目目录与一键折叠/展开右侧聊天分栏。
 */
(function installAntigravityCowartSidebar() {
  if (window.__AGY_COWART_SIDEBAR_LOCKED__ && !window.__AGY_COWART_SIDEBAR_FORCE_RELOAD__) {
    return;
  }
  window.__AGY_COWART_SIDEBAR_FORCE_RELOAD__ = false;
  window.__AGY_COWART_SIDEBAR_LOCKED__ = true;

  const nativeQSA =
    typeof window.__AGY_NATIVE_QSA__ === 'function'
      ? window.__AGY_NATIVE_QSA__
      : document.querySelectorAll.bind(document);

  if (typeof window.__AGY_COWART_SIDEBAR_CLEANUP__ === 'function') {
    try {
      window.__AGY_COWART_SIDEBAR_CLEANUP__(true);
    } catch {}
  }

  const STAGE_BASE = 'http://127.0.0.1:45791';
  const STYLE_ID = 'agy-cowart-sidebar-styles';
  const NAV_ID = 'agy-cowart-nav-item';
  const STAGE_ID = 'agy-cowart-stage';
  const RESIZER_ID = 'agy-cowart-resizer';
  const SPLIT_BAR_ID = 'agy-cowart-split-chat-bar';
  const STORAGE_CHAT_WIDTH = 'agy_cowart_split_chat_width';
  const STORAGE_LAST_PROJECT = 'agy_cowart_last_project_dir';

  const COWART_SVG = `<svg class="agy-cowart-nav-svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <rect x="3" y="4" width="18" height="16" rx="2.5"></rect>
    <circle cx="8.5" cy="9.5" r="1.4"></circle>
    <path d="M21 15.5l-4.5-4.5a1.6 1.6 0 0 0-2.25 0L7 18.25"></path>
  </svg>`;

  const state = {
    active: false,
    layout: 'fullscreen', // 'fullscreen' | 'split'
    projects: [],
    currentTarget: null, // { name, projectDir, canvasDir, isGlobal }
    attachments: [], // { fileName, filePath, previewUrl }
    submitting: false,
    isProgrammaticNav: false,
    projectMenuOpen: false,
    modelMenuOpen: false,
    selectedModelLabel: '',
    selectedModelOption: null,
    chatWidth: Math.min(620, Math.max(320, Number(localStorage.getItem(STORAGE_CHAT_WIDTH) || 400))),
  };

  let layoutObserver = null;
  let themeObserver = null;
  let navClickHandler = null;
  let messageHandler = null;
  let docPointerHandler = null;
  let stageActivateHandler = null;
  let observerRaf = false;

  function isDarkTheme() {
    try {
      const b = document.body;
      const r = document.documentElement;
      return Boolean(
        b?.classList.contains('theme-dark') ||
          b?.classList.contains('dark') ||
          r?.classList.contains('dark')
      );
    } catch {
      return false;
    }
  }

  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      /* 1. 左侧栏 Cowart 独立入口（复用原生 sidebar nav button 布局与留白，保证像素级对齐） */
      #${NAV_ID} {
        box-sizing: border-box;
        border: none !important;
        margin: 0;
        text-decoration: none;
        outline: none !important;
      }
      #${NAV_ID}[data-active="true"] {
        background-color: rgba(15, 23, 42, 0.062) !important;
        color: #0f172a !important;
        box-shadow: inset 0 0 0 1px rgba(15, 23, 42, 0.04);
        font-weight: 500;
      }
      body.theme-dark #${NAV_ID}[data-active="true"],
      body.dark #${NAV_ID}[data-active="true"] {
        background-color: rgba(255, 255, 255, 0.1) !important;
        color: #f8fafc !important;
        box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.08);
      }
      .agy-cowart-nav-svg {
        width: 16px;
        height: 16px;
        flex-shrink: 0;
        display: block;
      }

      /* 激活 Cowart 模式时弱化左侧其余历史会话高亮，保证焦点唯一 */
      body[data-agy-cowart-active="true"] [data-testid="sidebar-navigation-items"] a:not(#${NAV_ID}),
      body[data-agy-cowart-active="true"] .agy-sidebar-row[data-selected="true"] {
        background-color: transparent !important;
        box-shadow: none !important;
      }

      /* 2. 主工作区父行布局适配 */
      .agy-cowart-sheet-row {
        display: flex !important;
        flex-direction: row !important;
        align-items: stretch !important;
        min-width: 0 !important;
        min-height: 0 !important;
      }

      /* 3. Cowart 舞台容器（全屏 / 分栏左侧主视图） */
      #${STAGE_ID} {
        position: relative;
        flex: 1 1 0%;
        min-width: 0;
        min-height: 0;
        height: 100%;
        display: none;
        flex-direction: column;
        overflow: hidden;
        background: #ffffff;
        border-radius: 14px;
        border: 1px solid rgba(15, 35, 68, 0.08);
        box-shadow: 0 2px 10px -2px rgba(15, 35, 68, 0.045), 0 1px 2px rgba(15, 35, 68, 0.025);
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Microsoft YaHei", sans-serif;
      }
      body.theme-dark #${STAGE_ID},
      body.dark #${STAGE_ID} {
        background: #14151a;
        border-color: rgba(255, 255, 255, 0.09);
        box-shadow: none;
      }
      body[data-agy-cowart-active="true"] #${STAGE_ID} {
        display: flex;
      }

      /* 全屏模式：右侧原生聊天列移至屏幕外保活（不销毁 React/Lexical 实例），原生辅助栏隐藏 */
      body[data-agy-cowart-active="true"][data-agy-cowart-layout="fullscreen"] .agy-cowart-main-col {
        position: fixed !important;
        right: -9999px !important;
        top: 0 !important;
        width: 400px !important;
        height: 680px !important;
        opacity: 0 !important;
        pointer-events: none !important;
        overflow: hidden !important;
      }
      body[data-agy-cowart-active="true"] [data-side-panel-body],
      body[data-agy-cowart-active="true"] [data-side-panel-strip] {
        display: none !important;
      }

      /* 分栏模式：左侧主画布 + 中间拖拽条 + 右侧窄聊天栏 */
      body[data-agy-cowart-active="true"][data-agy-cowart-layout="split"] #${STAGE_ID} {
        flex: 1 1 0% !important;
        min-width: 360px !important;
      }
      #${RESIZER_ID} {
        display: none;
        width: 8px;
        flex: 0 0 8px;
        cursor: col-resize;
        align-items: center;
        justify-content: center;
        user-select: none;
        position: relative;
      }
      #${RESIZER_ID}::after {
        content: "";
        width: 2px;
        height: 36px;
        border-radius: 999px;
        background: rgba(15, 35, 68, 0.14);
        transition: background-color 0.15s ease, height 0.15s ease;
      }
      #${RESIZER_ID}:hover::after,
      #${RESIZER_ID}.is-dragging::after {
        background: #2563eb;
        height: 56px;
      }
      body.theme-dark #${RESIZER_ID}::after,
      body.dark #${RESIZER_ID}::after {
        background: rgba(255, 255, 255, 0.16);
      }
      body[data-agy-cowart-active="true"][data-agy-cowart-layout="split"] #${RESIZER_ID} {
        display: flex;
      }
      body[data-agy-cowart-active="true"][data-agy-cowart-layout="split"] .agy-cowart-main-col {
        flex: 0 0 var(--agy-cowart-chat-width, 400px) !important;
        width: var(--agy-cowart-chat-width, 400px) !important;
        min-width: 320px !important;
        max-width: 620px !important;
        display: flex !important;
        flex-direction: column !important;
      }

      /* 右侧分栏顶部快捷操作条 */
      #${SPLIT_BAR_ID} {
        display: none;
        align-items: center;
        justify-content: space-between;
        padding: 6px 12px;
        border-bottom: 1px solid rgba(15, 35, 68, 0.08);
        background: rgba(248, 250, 253, 0.85);
        font-size: 12px;
        color: #475569;
        flex-shrink: 0;
        gap: 8px;
      }
      body.theme-dark #${SPLIT_BAR_ID},
      body.dark #${SPLIT_BAR_ID} {
        background: #1b1d24;
        border-bottom-color: rgba(255, 255, 255, 0.08);
        color: #cbd5e1;
      }
      body[data-agy-cowart-active="true"][data-agy-cowart-layout="split"] #${SPLIT_BAR_ID} {
        display: flex;
      }
      .agy-cowart-split-title {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        font-weight: 560;
        font-size: 12.5px;
      }
      .agy-cowart-split-dot {
        width: 6px;
        height: 6px;
        border-radius: 999px;
        background: #10b981;
      }
      .agy-cowart-split-actions {
        display: inline-flex;
        align-items: center;
        gap: 6px;
      }
      .agy-cowart-mini-btn {
        height: 26px;
        padding: 0 9px;
        border-radius: 7px;
        border: 1px solid rgba(15, 35, 68, 0.1);
        background: #ffffff;
        color: #1e293b;
        font-size: 11.5px;
        font-weight: 500;
        cursor: pointer;
        display: inline-flex;
        align-items: center;
        gap: 4px;
        transition: background-color 0.14s ease, border-color 0.14s ease;
      }
      .agy-cowart-mini-btn:hover {
        background: #f1f5f9;
        border-color: rgba(15, 35, 68, 0.16);
      }
      body.theme-dark .agy-cowart-mini-btn,
      body.dark .agy-cowart-mini-btn {
        background: #262934;
        border-color: rgba(255, 255, 255, 0.12);
        color: #f1f5f9;
      }
      body.theme-dark .agy-cowart-mini-btn:hover,
      body.dark .agy-cowart-mini-btn:hover {
        background: #313543;
      }

      /* 4. iframe 画布主体 */
      .agy-cowart-iframe {
        width: 100%;
        height: 100%;
        border: 0;
        display: block;
        flex: 1 1 auto;
        background: transparent;
      }

      /* 5. 画布右上角悬浮控制条（项目切换 + 分栏按钮） */
      .agy-cowart-top-controls {
        position: absolute;
        top: 10px;
        right: 12px;
        z-index: 30;
        display: flex;
        align-items: center;
        gap: 6px;
      }
      .agy-cowart-top-pill {
        height: 30px;
        padding: 0 10px;
        border-radius: 8px;
        border: 1px solid rgba(15, 23, 42, 0.08);
        background: rgba(255, 255, 255, 0.92);
        backdrop-filter: blur(10px);
        -webkit-backdrop-filter: blur(10px);
        color: #334155;
        font-size: 12px;
        font-weight: 500;
        display: inline-flex;
        align-items: center;
        gap: 6px;
        cursor: pointer;
        box-shadow: 0 2px 8px rgba(15, 23, 42, 0.06);
        transition: background-color 0.14s ease, border-color 0.14s ease;
      }
      .agy-cowart-top-pill:hover {
        background: #f8fafc;
        border-color: rgba(15, 23, 42, 0.14);
      }
      .agy-cowart-top-icon-btn {
        width: 30px;
        height: 30px;
        padding: 0;
        justify-content: center;
      }
      body.theme-dark .agy-cowart-top-pill,
      body.dark .agy-cowart-top-pill {
        background: rgba(30, 32, 40, 0.9);
        border-color: rgba(255, 255, 255, 0.12);
        color: #e2e8f0;
      }
      body.theme-dark .agy-cowart-top-pill:hover,
      body.dark .agy-cowart-top-pill:hover {
        background: rgba(45, 48, 60, 0.95);
      }
      .agy-cowart-proj-name {
        max-width: 170px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      /* 项目下拉菜单 */
      .agy-cowart-proj-menu {
        position: absolute;
        top: 36px;
        right: 36px;
        width: 280px;
        max-height: 320px;
        overflow-y: auto;
        padding: 6px;
        border-radius: 12px;
        background: #ffffff;
        border: 1px solid rgba(15, 23, 42, 0.1);
        box-shadow: 0 12px 30px rgba(15, 23, 42, 0.12), 0 2px 6px rgba(15, 23, 42, 0.05);
        display: none;
        flex-direction: column;
        gap: 2px;
        z-index: 40;
      }
      .agy-cowart-proj-menu.is-open {
        display: flex;
      }
      body.theme-dark .agy-cowart-proj-menu,
      body.dark .agy-cowart-proj-menu {
        background: #1f222a;
        border-color: rgba(255, 255, 255, 0.12);
        color: #f1f5f9;
      }
      .agy-cowart-proj-item {
        width: 100%;
        border: none;
        background: transparent;
        border-radius: 8px;
        padding: 7px 9px;
        text-align: left;
        cursor: pointer;
        display: flex;
        flex-direction: column;
        gap: 2px;
        color: inherit;
      }
      .agy-cowart-proj-item:hover {
        background: rgba(15, 23, 42, 0.05);
      }
      body.theme-dark .agy-cowart-proj-item:hover,
      body.dark .agy-cowart-proj-item:hover {
        background: rgba(255, 255, 255, 0.08);
      }
      .agy-cowart-proj-item.is-selected {
        background: rgba(37, 99, 235, 0.08);
      }
      .agy-cowart-proj-item-title {
        font-size: 12.5px;
        font-weight: 550;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 6px;
      }
      .agy-cowart-proj-badge {
        font-size: 10px;
        padding: 1px 5px;
        border-radius: 999px;
        background: rgba(16, 185, 129, 0.12);
        color: #059669;
        font-weight: 500;
      }
      .agy-cowart-proj-item-sub {
        font-size: 10.5px;
        color: #64748b;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .agy-cowart-proj-divider {
        height: 1px;
        margin: 4px 2px;
        background: rgba(15, 23, 42, 0.08);
      }
      body.theme-dark .agy-cowart-proj-divider,
      body.dark .agy-cowart-proj-divider {
        background: rgba(255, 255, 255, 0.08);
      }

      /* 6. 底部居中紧凑悬浮提问胶囊 */
      .agy-cowart-floating-dock {
        position: absolute;
        left: 50%;
        bottom: 14px;
        transform: translateX(-50%);
        z-index: 25;
        width: min(580px, calc(100% - 190px));
        min-width: 340px;
        display: flex;
        flex-direction: column;
        gap: 6px;
        pointer-events: auto;
      }
      body[data-agy-cowart-layout="split"] .agy-cowart-floating-dock {
        display: none !important;
      }
      .agy-cowart-attach-row {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
        padding: 0 4px;
      }
      .agy-cowart-attach-row:empty {
        display: none;
      }
      .agy-cowart-attach-chip {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        height: 28px;
        padding: 2px 8px 2px 3px;
        border-radius: 999px;
        background: rgba(255, 255, 255, 0.96);
        border: 1px solid rgba(15, 23, 42, 0.1);
        box-shadow: 0 2px 8px rgba(15, 23, 42, 0.08);
        font-size: 11px;
        color: #334155;
      }
      .agy-cowart-attach-thumb {
        width: 22px;
        height: 22px;
        border-radius: 999px;
        object-fit: cover;
      }
      .agy-cowart-attach-del {
        border: none;
        background: transparent;
        color: #64748b;
        cursor: pointer;
        padding: 0 2px;
        font-size: 13px;
        line-height: 1;
      }
      .agy-cowart-composer-pill {
        display: flex;
        align-items: center;
        gap: 8px;
        min-height: 46px;
        padding: 6px 8px 6px 10px;
        border-radius: 999px;
        background: rgba(255, 255, 255, 0.96);
        border: 1px solid rgba(15, 23, 42, 0.1);
        box-shadow: 0 8px 28px rgba(15, 23, 42, 0.09), 0 1px 4px rgba(15, 23, 42, 0.04);
        backdrop-filter: blur(12px);
        -webkit-backdrop-filter: blur(12px);
        transition: border-color 0.15s ease, box-shadow 0.15s ease;
      }
      .agy-cowart-composer-pill:focus-within {
        border-color: rgba(15, 23, 42, 0.22);
        box-shadow: 0 10px 32px rgba(15, 23, 42, 0.12), 0 2px 6px rgba(15, 23, 42, 0.05);
      }
      body.theme-dark .agy-cowart-composer-pill,
      body.dark .agy-cowart-composer-pill {
        background: rgba(30, 32, 40, 0.95);
        border-color: rgba(255, 255, 255, 0.14);
        box-shadow: 0 10px 32px rgba(0, 0, 0, 0.42);
      }
      .agy-cowart-plus-btn {
        width: 30px;
        height: 30px;
        border-radius: 999px;
        border: none;
        background: transparent;
        color: #475569;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        flex-shrink: 0;
        transition: background-color 0.14s ease, color 0.14s ease;
      }
      .agy-cowart-plus-btn:hover {
        background: rgba(15, 23, 42, 0.06);
        color: #0f172a;
      }
      body.theme-dark .agy-cowart-plus-btn,
      body.dark .agy-cowart-plus-btn {
        color: #94a3b8;
      }
      body.theme-dark .agy-cowart-plus-btn:hover,
      body.dark .agy-cowart-plus-btn:hover {
        background: rgba(255, 255, 255, 0.08);
        color: #f8fafc;
      }
      #${STAGE_ID} textarea.agy-cowart-input,
      #${STAGE_ID} textarea.agy-cowart-input:focus,
      #${STAGE_ID} textarea.agy-cowart-input:focus-visible,
      .agy-cowart-input,
      .agy-cowart-input:focus,
      .agy-cowart-input:focus-visible {
        border: none !important;
        outline: none !important;
        outline-style: none !important;
        outline-width: 0 !important;
        outline-color: transparent !important;
        box-shadow: none !important;
        --tw-ring-shadow: 0 0 #0000 !important;
        --tw-ring-offset-shadow: 0 0 #0000 !important;
      }
      .agy-cowart-input {
        flex: 1 1 auto;
        min-width: 0;
        max-height: 96px;
        resize: none;
        background: transparent;
        color: #0f172a;
        font-size: 13.5px;
        line-height: 20px;
        padding: 4px 2px;
        font-family: inherit;
        overflow-y: auto;
      }
      .agy-cowart-input::placeholder {
        color: #94a3b8;
      }
      body.theme-dark .agy-cowart-input,
      body.dark .agy-cowart-input {
        color: #f8fafc;
      }
      .agy-cowart-model-wrap {
        position: relative;
        flex-shrink: 0;
        display: inline-flex;
        align-items: center;
      }
      .agy-cowart-model-btn {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        height: 28px;
        max-width: 175px;
        padding: 0 9px;
        border-radius: 999px;
        border: 1px solid transparent;
        background: rgba(15, 23, 42, 0.045);
        color: #475569;
        font-size: 12px;
        font-weight: 500;
        cursor: pointer;
        white-space: nowrap;
        transition: background-color 0.14s ease, color 0.14s ease, border-color 0.14s ease;
      }
      .agy-cowart-model-btn:hover,
      .agy-cowart-model-btn[aria-expanded="true"] {
        background: rgba(15, 23, 42, 0.085);
        color: #0f172a;
      }
      .agy-cowart-model-label {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .agy-cowart-model-chevron {
        flex-shrink: 0;
        opacity: 0.72;
        transition: transform 0.15s ease;
      }
      .agy-cowart-model-btn[aria-expanded="true"] .agy-cowart-model-chevron {
        transform: rotate(180deg);
      }
      body.theme-dark .agy-cowart-model-btn,
      body.dark .agy-cowart-model-btn {
        background: rgba(255, 255, 255, 0.075);
        color: #cbd5e1;
      }
      body.theme-dark .agy-cowart-model-btn:hover,
      body.dark .agy-cowart-model-btn:hover,
      body.theme-dark .agy-cowart-model-btn[aria-expanded="true"],
      body.dark .agy-cowart-model-btn[aria-expanded="true"] {
        background: rgba(255, 255, 255, 0.14);
        color: #f8fafc;
      }
      .agy-cowart-model-menu {
        position: absolute;
        bottom: calc(100% + 10px);
        right: -4px;
        width: 320px;
        max-height: 360px;
        overflow-y: auto;
        padding: 6px;
        border-radius: 14px;
        background: rgba(255, 255, 255, 0.98);
        border: 1px solid rgba(15, 23, 42, 0.1);
        box-shadow: 0 14px 36px rgba(15, 23, 42, 0.16), 0 2px 8px rgba(15, 23, 42, 0.06);
        backdrop-filter: blur(16px);
        -webkit-backdrop-filter: blur(16px);
        display: none;
        flex-direction: column;
        gap: 2px;
        z-index: 40;
        color: #0f172a;
      }
      .agy-cowart-model-menu.is-open {
        display: flex;
      }
      body.theme-dark .agy-cowart-model-menu,
      body.dark .agy-cowart-model-menu {
        background: rgba(30, 32, 40, 0.98);
        border-color: rgba(255, 255, 255, 0.14);
        box-shadow: 0 14px 36px rgba(0, 0, 0, 0.5);
        color: #f8fafc;
      }
      .agy-cowart-model-group {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        padding: 6px 8px;
        border-radius: 9px;
        transition: background-color 0.12s ease;
      }
      .agy-cowart-model-group:hover {
        background: rgba(15, 23, 42, 0.04);
      }
      body.theme-dark .agy-cowart-model-group:hover,
      body.dark .agy-cowart-model-group:hover {
        background: rgba(255, 255, 255, 0.05);
      }
      .agy-cowart-model-group-name {
        display: inline-flex;
        align-items: center;
        gap: 5px;
        font-size: 12.5px;
        font-weight: 500;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .agy-cowart-model-efforts {
        display: inline-flex;
        align-items: center;
        gap: 3px;
        flex-shrink: 0;
      }
      .agy-cowart-effort-pill {
        height: 22px;
        padding: 0 6px;
        border-radius: 6px;
        border: 1px solid rgba(15, 23, 42, 0.1);
        background: transparent;
        color: #475569;
        font-size: 11px;
        font-weight: 500;
        cursor: pointer;
        transition: background-color 0.12s ease, color 0.12s ease, border-color 0.12s ease;
      }
      .agy-cowart-effort-pill:hover:not(:disabled) {
        background: rgba(15, 23, 42, 0.07);
        color: #0f172a;
      }
      .agy-cowart-effort-pill.is-selected {
        background: #0f172a;
        border-color: #0f172a;
        color: #ffffff;
      }
      .agy-cowart-effort-pill:disabled {
        opacity: 0.35;
        cursor: not-allowed;
      }
      body.theme-dark .agy-cowart-effort-pill,
      body.dark .agy-cowart-effort-pill {
        border-color: rgba(255, 255, 255, 0.14);
        color: #cbd5e1;
      }
      body.theme-dark .agy-cowart-effort-pill:hover:not(:disabled),
      body.dark .agy-cowart-effort-pill:hover:not(:disabled) {
        background: rgba(255, 255, 255, 0.1);
        color: #f8fafc;
      }
      body.theme-dark .agy-cowart-effort-pill.is-selected,
      body.dark .agy-cowart-effort-pill.is-selected {
        background: #f8fafc;
        border-color: #f8fafc;
        color: #0f172a;
      }
      .agy-cowart-model-row {
        width: 100%;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        padding: 7px 8px;
        border: none;
        border-radius: 9px;
        background: transparent;
        color: inherit;
        font-size: 12.5px;
        font-weight: 500;
        cursor: pointer;
        text-align: left;
        transition: background-color 0.12s ease;
      }
      .agy-cowart-model-row:hover:not(:disabled) {
        background: rgba(15, 23, 42, 0.055);
      }
      .agy-cowart-model-row.is-selected {
        background: rgba(15, 23, 42, 0.065);
      }
      .agy-cowart-model-row:disabled {
        opacity: 0.4;
        cursor: not-allowed;
      }
      body.theme-dark .agy-cowart-model-row:hover:not(:disabled),
      body.dark .agy-cowart-model-row:hover:not(:disabled) {
        background: rgba(255, 255, 255, 0.08);
      }
      body.theme-dark .agy-cowart-model-row.is-selected,
      body.dark .agy-cowart-model-row.is-selected {
        background: rgba(255, 255, 255, 0.1);
      }
      .agy-cowart-model-tag {
        font-size: 10px;
        padding: 1px 5px;
        border-radius: 999px;
        background: rgba(37, 99, 235, 0.1);
        color: #2563eb;
        font-weight: 600;
        flex-shrink: 0;
      }
      body.theme-dark .agy-cowart-model-tag,
      body.dark .agy-cowart-model-tag {
        background: rgba(96, 165, 250, 0.18);
        color: #93c5fd;
      }
      .agy-cowart-model-empty {
        padding: 12px 10px;
        font-size: 12px;
        color: #64748b;
        text-align: center;
      }
      .agy-cowart-send-btn {
        width: 32px;
        height: 32px;
        border-radius: 999px;
        border: none;
        background: #0f172a;
        color: #ffffff;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        flex-shrink: 0;
        transition: opacity 0.15s ease, transform 0.12s ease;
      }
      .agy-cowart-send-btn:hover:not(:disabled) {
        opacity: 0.88;
      }
      .agy-cowart-send-btn:active:not(:disabled) {
        transform: scale(0.95);
      }
      .agy-cowart-send-btn:disabled {
        opacity: 0.35;
        cursor: default;
      }
      body.theme-dark .agy-cowart-send-btn,
      body.dark .agy-cowart-send-btn {
        background: #f8fafc;
        color: #0f172a;
      }

      /* 加载报错兜底提示条 */
      .agy-cowart-error-banner {
        position: absolute;
        inset: 0;
        display: none;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 10px;
        background: rgba(255, 255, 255, 0.96);
        color: #334155;
        z-index: 20;
        padding: 24px;
        text-align: center;
      }
      body.theme-dark .agy-cowart-error-banner,
      body.dark .agy-cowart-error-banner {
        background: rgba(20, 21, 26, 0.96);
        color: #e2e8f0;
      }
      .agy-cowart-error-banner.is-visible {
        display: flex;
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  function findAutomationNavElement() {
    const navContainer = document.querySelector('[data-testid="sidebar-navigation-items"]');
    if (!navContainer) return null;
    const candidates = [...navContainer.querySelectorAll('a, button')].filter(
      (el) => el.id !== NAV_ID
    );
    for (const el of candidates) {
      const text = (el.innerText || el.textContent || '').trim();
      const href = el.getAttribute('href') || '';
      if (
        text === '自动化' ||
        text === 'Automations' ||
        text.includes('自动化') ||
        href.toLowerCase().includes('automation')
      ) {
        return el;
      }
    }
    return candidates[1] || candidates[0] || null;
  }

  const DEFAULT_NAV_CLASS =
    'agy-button agy-button-custom inline-flex items-center font-medium transition-colors select-none outline-none cursor-pointer disabled:opacity-50 flex-grow w-full justify-start select-none font-normal h-8 min-w-0 gap-1.5 px-2 py-1 rounded-lg bg-transparent text-secondary-foreground hover:bg-sidebar-muted hover:text-foreground';

  function resolveSidebarNavClass(autoEl) {
    const navContainer = autoEl?.parentElement;
    const sibling = navContainer
      ? [...navContainer.querySelectorAll('a, button')].find(
          (el) =>
            el.id !== NAV_ID &&
            el !== autoEl &&
            (el.getAttribute('href') === '/customizations' || (el.className || '').includes('agy-button'))
        )
      : null;
    const raw = String(sibling?.className || autoEl?.className || '').trim();
    if (!raw) return DEFAULT_NAV_CLASS;

    const tokens = raw.split(/\s+/).filter((cls) => {
      if (!cls) return false;
      if (cls === 'bg-sidebar-accent' || cls === '!bg-sidebar-accent') return false;
      if (cls === 'text-sidebar-accent-foreground' || cls === 'text-foreground') return false;
      return true;
    });
    if (!tokens.includes('bg-transparent')) tokens.push('bg-transparent');
    if (!tokens.includes('text-secondary-foreground')) tokens.push('text-secondary-foreground');
    return tokens.join(' ');
  }

  function ensureSidebarNavItem() {
    const autoEl = findAutomationNavElement();
    if (!autoEl || !autoEl.parentElement) return null;

    let navItem = document.getElementById(NAV_ID);
    const targetClass = resolveSidebarNavClass(autoEl);
    if (!navItem) {
      navItem = document.createElement('button');
      navItem.type = 'button';
      navItem.id = NAV_ID;
      navItem.className = targetClass;
      navItem.setAttribute('data-testid', 'sidebar-cowart-button');
      navItem.setAttribute('data-code', 'true');
      navItem.innerHTML = `<span class="shrink-0 flex items-center">${COWART_SVG}</span><span class="truncate">Cowart</span>`;

      navItem.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        void openCowartView();
      });
    } else if (navItem.className !== targetClass) {
      navItem.className = targetClass;
    }

    if (autoEl.nextElementSibling !== navItem) {
      autoEl.insertAdjacentElement('afterend', navItem);
    }
    navItem.setAttribute('data-active', state.active ? 'true' : 'false');
    return navItem;
  }

  function findMainWorkspaceNodes() {
    const body = document.querySelector('[data-main-content-body]');
    if (!body) return null;

    let mainCol = body.parentElement;
    // 向上找到直接作为 sheet 行子元素的列容器（包含 main-content-header 与 main-content-body）
    while (mainCol && mainCol.parentElement) {
      const parent = mainCol.parentElement;
      const cls = String(parent.className || '');
      if (parent.classList?.contains('agy-sheet') || cls.includes('flex-row') || parent.children.length >= 1) {
        // 如果父元素再外层是 .agy-sheet，说明 mainCol 就是主工作区列
        if (
          parent.matches?.('.agy-sheet[data-sheet-inset]') ||
          parent.closest?.('.agy-sheet[data-sheet-inset]')
        ) {
          // 确认 mainCol 包含 [data-main-content-header] 或高度接近视口
          if (mainCol.querySelector('[data-main-content-header]') || mainCol.getBoundingClientRect().height > 200) {
            return { sheetRow: parent, mainCol };
          }
        }
      }
      mainCol = mainCol.parentElement;
    }

    const fallbackCol = body.parentElement;
    if (fallbackCol && fallbackCol.parentElement) {
      return { sheetRow: fallbackCol.parentElement, mainCol: fallbackCol };
    }
    return null;
  }

  function ensureStageContainers() {
    const nodes = findMainWorkspaceNodes();
    if (!nodes) return null;
    const { sheetRow, mainCol } = nodes;

    sheetRow.classList.add('agy-cowart-sheet-row');
    mainCol.classList.add('agy-cowart-main-col');

    let stage = document.getElementById(STAGE_ID);
    if (!stage) {
      stage = document.createElement('section');
      stage.id = STAGE_ID;
      stage.setAttribute('data-code', 'true');
      stage.innerHTML = `
        <div class="agy-cowart-top-controls" data-code="true">
          <button type="button" class="agy-cowart-top-pill" data-role="project-btn" title="切换画布工作区目录">
            <span>📁</span>
            <span class="agy-cowart-proj-name" data-role="project-name">加载项目...</span>
            <span>▾</span>
          </button>
          <button type="button" class="agy-cowart-top-pill agy-cowart-top-icon-btn" data-role="split-toggle-btn" title="展开/收起右侧对话分栏">
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round">
              <rect x="2" y="2.5" width="12" height="11" rx="2"></rect>
              <line x1="10" y1="2.5" x2="10" y2="13.5"></line>
            </svg>
          </button>
          <div class="agy-cowart-proj-menu" data-role="project-menu"></div>
        </div>

        <iframe class="agy-cowart-iframe" data-role="iframe" title="Cowart 无限画布"></iframe>

        <div class="agy-cowart-error-banner" data-role="error-banner">
          <div style="font-weight:600;font-size:14px;">Cowart 画布服务未就绪</div>
          <div style="font-size:12px;opacity:0.78;" data-role="error-text">请检查本地画布服务 127.0.0.1:45791 是否正常启动。</div>
          <button type="button" class="agy-cowart-mini-btn" data-role="retry-btn">重试加载画布</button>
        </div>

        <div class="agy-cowart-floating-dock no-focus-agent-input" data-code="true">
          <div class="agy-cowart-attach-row" data-role="attach-row"></div>
          <div class="agy-cowart-composer-pill">
            <input type="file" accept="image/*" multiple style="display:none" data-role="file-input" />
            <button type="button" class="agy-cowart-plus-btn" data-role="plus-btn" title="添加参考图片">
              <svg width="17" height="17" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round">
                <line x1="8" y1="3.2" x2="8" y2="12.8"></line>
                <line x1="3.2" y1="8" x2="12.8" y2="8"></line>
              </svg>
            </button>
            <textarea class="agy-cowart-input" rows="1" placeholder="和 Antigravity 一起工作" data-role="prompt-input"></textarea>
            <div class="agy-cowart-model-wrap" data-role="model-wrap">
              <button type="button" class="agy-cowart-model-btn" data-role="model-btn" aria-expanded="false" title="切换模型">
                <span class="agy-cowart-model-label" data-role="model-label">选择模型</span>
                <svg class="agy-cowart-model-chevron" width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <polyline points="4 6 8 10 12 6"></polyline>
                </svg>
              </button>
              <div class="agy-cowart-model-menu" data-role="model-menu"></div>
            </div>
            <button type="button" class="agy-cowart-send-btn" data-role="send-btn" title="发送并开启右侧对话分栏" disabled>
              <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                <line x1="8" y1="12.5" x2="8" y2="3.5"></line>
                <polyline points="4.2 7.2 8 3.4 11.8 7.2"></polyline>
              </svg>
            </button>
          </div>
        </div>
      `;

      bindStageEvents(stage);
    }

    let resizer = document.getElementById(RESIZER_ID);
    if (!resizer) {
      resizer = document.createElement('div');
      resizer.id = RESIZER_ID;
      resizer.setAttribute('data-code', 'true');
      bindResizerEvents(resizer);
    }

    let splitBar = document.getElementById(SPLIT_BAR_ID);
    if (!splitBar) {
      splitBar = document.createElement('div');
      splitBar.id = SPLIT_BAR_ID;
      splitBar.setAttribute('data-code', 'true');
      splitBar.innerHTML = `
        <span class="agy-cowart-split-title">
          <span class="agy-cowart-split-dot"></span>
          <span>Cowart 协作对话</span>
        </span>
        <div class="agy-cowart-split-actions">
          <button type="button" class="agy-cowart-mini-btn" data-role="split-new-chat" title="开启新对话并保持左侧画布打开">+ 新对话</button>
          <button type="button" class="agy-cowart-mini-btn" data-role="split-collapse" title="收起右侧对话，恢复全屏画布">收起对话</button>
        </div>
      `;
      splitBar.querySelector('[data-role="split-new-chat"]').addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        triggerProgrammaticNewChat();
      });
      splitBar.querySelector('[data-role="split-collapse"]').addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        setCowartLayout('fullscreen');
      });
    }

    if (stage.parentElement !== sheetRow) {
      sheetRow.insertBefore(stage, mainCol);
    }
    if (resizer.parentElement !== sheetRow) {
      sheetRow.insertBefore(resizer, mainCol);
    }
    if (splitBar.parentElement !== mainCol) {
      mainCol.insertBefore(splitBar, mainCol.firstChild);
    }

    mainCol.style.setProperty('--agy-cowart-chat-width', `${state.chatWidth}px`);
    return { sheetRow, mainCol, stage, resizer, splitBar };
  }

  function bindResizerEvents(resizer) {
    resizer.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      resizer.classList.add('is-dragging');
      const startX = e.clientX;
      const startW = state.chatWidth;

      const onMove = (ev) => {
        const delta = startX - ev.clientX;
        const nextW = Math.min(620, Math.max(320, startW + delta));
        state.chatWidth = nextW;
        const mainCol = document.querySelector('.agy-cowart-main-col');
        if (mainCol) {
          mainCol.style.setProperty('--agy-cowart-chat-width', `${nextW}px`);
        }
      };

      const onUp = () => {
        resizer.classList.remove('is-dragging');
        localStorage.setItem(STORAGE_CHAT_WIDTH, String(state.chatWidth));
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
      };

      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    });
  }

  function getNativeModelBridge() {
    const triggerEl = document.querySelector('[data-testid="model-selector-trigger"]');
    if (!triggerEl) return null;

    const fiberKey = Object.keys(triggerEl).find(
      (k) => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$')
    );
    if (!fiberKey) return null;

    let cur = triggerEl[fiberKey];
    for (let depth = 0; depth < 28 && cur; depth += 1, cur = cur.return) {
      const p = cur.memoizedProps;
      if (p && typeof p.setSelectedModel === 'function' && Array.isArray(p.modelOptions) && p.modelOptions.length > 0) {
        return {
          triggerEl,
          selectedModel: p.selectedModel || null,
          modelOptions: p.modelOptions,
          customModels: Array.isArray(p.customModels) ? p.customModels : [],
          setSelectedModel: p.setSelectedModel,
        };
      }
    }
    return null;
  }

  function isSameModelOption(a, b) {
    if (!a || !b) return false;
    if (a.value !== undefined && b.value !== undefined && a.value === b.value) return true;
    if (a.modelId && b.modelId && a.modelId === b.modelId) return true;
    return Boolean(a.label && b.label && a.label === b.label);
  }

  function syncModelButtonLabel(overrideLabel) {
    const stage = document.getElementById(STAGE_ID);
    if (!stage) return;
    const modelBtn = stage.querySelector('[data-role="model-btn"]');
    const modelLabel = stage.querySelector('[data-role="model-label"]');
    if (!modelBtn || !modelLabel) return;

    const bridge = getNativeModelBridge();
    const labelText =
      overrideLabel ||
      bridge?.selectedModel?.label ||
      (bridge?.triggerEl?.textContent || '').trim() ||
      state.selectedModelLabel ||
      '选择模型';

    state.selectedModelLabel = labelText;
    modelLabel.textContent = labelText;
    modelBtn.title = `当前模型：${labelText}`;
    modelBtn.setAttribute('aria-expanded', state.modelMenuOpen ? 'true' : 'false');
  }

  function closeModelMenu() {
    state.modelMenuOpen = false;
    const stage = document.getElementById(STAGE_ID);
    if (!stage) return;
    stage.querySelector('[data-role="model-menu"]')?.classList.remove('is-open');
    stage.querySelector('[data-role="model-btn"]')?.setAttribute('aria-expanded', 'false');
  }

  function renderModelMenu() {
    const stage = document.getElementById(STAGE_ID);
    if (!stage) return;
    const menu = stage.querySelector('[data-role="model-menu"]');
    if (!menu) return;

    const bridge = getNativeModelBridge();
    menu.innerHTML = '';

    if (!bridge || !Array.isArray(bridge.modelOptions) || bridge.modelOptions.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'agy-cowart-model-empty';
      empty.textContent = '正在同步可用模型列表...';
      menu.appendChild(empty);
      return;
    }

    const combined = [...bridge.modelOptions, ...bridge.customModels];
    const groups = [];
    const groupByName = new Map();
    const effortRegex = /^(.+?)\s*\((Low|Medium|High|XHigh)\)$/i;
    const shortEffortMap = { low: 'Low', medium: 'Med', high: 'High', xhigh: 'XHigh' };

    for (const opt of combined) {
      if (!opt || !opt.label) continue;
      const m = String(opt.label).match(effortRegex);
      if (m) {
        const baseName = m[1].trim();
        const effortRaw = m[2].toLowerCase();
        let entry = groupByName.get(baseName);
        if (!entry) {
          entry = { type: 'group', baseName, tagTitle: opt.tagTitle || '', options: [] };
          groupByName.set(baseName, entry);
          groups.push(entry);
        }
        entry.options.push({ opt, shortEffort: shortEffortMap[effortRaw] || m[2] });
      } else {
        groups.push({ type: 'single', opt });
      }
    }

    const selectOption = (opt) => {
      if (!opt || opt.disabled) return;
      state.selectedModelOption = opt;
      try {
        bridge.setSelectedModel(opt);
      } catch {}
      syncModelButtonLabel(opt.label);
      closeModelMenu();
      setTimeout(() => syncModelButtonLabel(), 70);
      setTimeout(() => syncModelButtonLabel(), 200);
    };

    for (const item of groups) {
      if (item.type === 'group' && item.options.length > 1) {
        const row = document.createElement('div');
        row.className = 'agy-cowart-model-group';

        const nameWrap = document.createElement('span');
        nameWrap.className = 'agy-cowart-model-group-name';
        const titleSpan = document.createElement('span');
        titleSpan.textContent = item.baseName;
        nameWrap.appendChild(titleSpan);
        if (item.tagTitle) {
          const badge = document.createElement('span');
          badge.className = 'agy-cowart-model-tag';
          badge.textContent = item.tagTitle;
          nameWrap.appendChild(badge);
        }

        const effortsWrap = document.createElement('div');
        effortsWrap.className = 'agy-cowart-model-efforts';
        for (const sub of item.options) {
          const pill = document.createElement('button');
          pill.type = 'button';
          pill.className = 'agy-cowart-effort-pill';
          if (isSameModelOption(bridge.selectedModel, sub.opt)) {
            pill.classList.add('is-selected');
          }
          pill.textContent = sub.shortEffort;
          pill.title = sub.opt.label;
          pill.disabled = Boolean(sub.opt.disabled);
          pill.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            selectOption(sub.opt);
          });
          effortsWrap.appendChild(pill);
        }

        row.appendChild(nameWrap);
        row.appendChild(effortsWrap);
        menu.appendChild(row);
      } else {
        const opt = item.type === 'group' ? item.options[0].opt : item.opt;
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'agy-cowart-model-row';
        const isSelected = isSameModelOption(bridge.selectedModel, opt);
        if (isSelected) row.classList.add('is-selected');
        row.disabled = Boolean(opt.disabled);

        const left = document.createElement('span');
        left.className = 'agy-cowart-model-group-name';
        const nameSpan = document.createElement('span');
        nameSpan.textContent = opt.label;
        left.appendChild(nameSpan);
        if (opt.tagTitle) {
          const badge = document.createElement('span');
          badge.className = 'agy-cowart-model-tag';
          badge.textContent = opt.tagTitle;
          left.appendChild(badge);
        }

        const right = document.createElement('span');
        right.textContent = isSelected ? '✓' : '';
        right.style.fontSize = '12px';

        row.appendChild(left);
        row.appendChild(right);
        row.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          selectOption(opt);
        });
        menu.appendChild(row);
      }
    }
  }

  function bindStageEvents(stage) {
    const projectBtn = stage.querySelector('[data-role="project-btn"]');
    const projectMenu = stage.querySelector('[data-role="project-menu"]');
    const splitToggleBtn = stage.querySelector('[data-role="split-toggle-btn"]');
    const retryBtn = stage.querySelector('[data-role="retry-btn"]');
    const plusBtn = stage.querySelector('[data-role="plus-btn"]');
    const fileInput = stage.querySelector('[data-role="file-input"]');
    const promptInput = stage.querySelector('[data-role="prompt-input"]');
    const modelBtn = stage.querySelector('[data-role="model-btn"]');
    const modelMenu = stage.querySelector('[data-role="model-menu"]');
    const sendBtn = stage.querySelector('[data-role="send-btn"]');

    projectBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      closeModelMenu();
      state.projectMenuOpen = !state.projectMenuOpen;
      projectMenu.classList.toggle('is-open', state.projectMenuOpen);
      if (state.projectMenuOpen) {
        void refreshProjectList().then(() => renderProjectMenu());
      }
    });

    modelBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      state.projectMenuOpen = false;
      projectMenu.classList.remove('is-open');

      state.modelMenuOpen = !state.modelMenuOpen;
      if (state.modelMenuOpen) {
        if (!getNativeModelBridge() && !findMainComposerEditor()) {
          triggerProgrammaticNewChat();
          setTimeout(() => {
            if (state.modelMenuOpen) {
              renderModelMenu();
              syncModelButtonLabel();
            }
          }, 260);
        }
        renderModelMenu();
        modelMenu?.classList.add('is-open');
        modelBtn.setAttribute('aria-expanded', 'true');
      } else {
        closeModelMenu();
      }
    });

    modelMenu?.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
    });

    splitToggleBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      setCowartLayout(state.layout === 'fullscreen' ? 'split' : 'fullscreen');
    });

    retryBtn.addEventListener('click', () => {
      loadCanvasIntoIframe(true);
    });

    plusBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      fileInput.click();
    });

    fileInput.addEventListener('change', async () => {
      const files = [...(fileInput.files || [])];
      for (const f of files) {
        await handleAttachmentFile(f);
      }
      fileInput.value = '';
    });

    const syncInputUi = () => {
      promptInput.style.height = 'auto';
      promptInput.style.height = `${Math.min(96, Math.max(24, promptInput.scrollHeight))}px`;
      const hasContent = promptInput.value.trim().length > 0 || state.attachments.length > 0;
      sendBtn.disabled = !hasContent || state.submitting;
    };

    promptInput.addEventListener('input', syncInputUi);

    promptInput.addEventListener('paste', async (e) => {
      const items = [...(e.clipboardData?.items || [])];
      const imgItems = items.filter((it) => it.type && it.type.startsWith('image/'));
      if (imgItems.length === 0) return;
      e.preventDefault();
      for (const item of imgItems) {
        const file = item.getAsFile();
        if (file) await handleAttachmentFile(file);
      }
      syncInputUi();
    });

    promptInput.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && state.modelMenuOpen) {
        e.preventDefault();
        closeModelMenu();
        return;
      }
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        void handleFloatingSubmit();
      }
    });

    sendBtn.addEventListener('click', (e) => {
      e.preventDefault();
      void handleFloatingSubmit();
    });

    syncModelButtonLabel();
  }

  async function handleAttachmentFile(file) {
    try {
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ''));
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
      const resp = await fetch(`${STAGE_BASE}/api/save-attachment`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fileName: file.name || 'image.png',
          dataUrl,
          projectDir: state.currentTarget?.projectDir || '',
        }),
      });
      const res = await resp.json();
      if (res && res.ok && res.filePath) {
        state.attachments.push({
          fileName: res.fileName || file.name || 'image.png',
          filePath: res.filePath,
          previewUrl: dataUrl,
        });
        renderAttachments();
      }
    } catch {}
  }

  function renderAttachments() {
    const stage = document.getElementById(STAGE_ID);
    if (!stage) return;
    const row = stage.querySelector('[data-role="attach-row"]');
    const promptInput = stage.querySelector('[data-role="prompt-input"]');
    const sendBtn = stage.querySelector('[data-role="send-btn"]');
    if (!row) return;

    row.innerHTML = '';
    state.attachments.forEach((att, idx) => {
      const chip = document.createElement('div');
      chip.className = 'agy-cowart-attach-chip';
      chip.innerHTML = `
        <img class="agy-cowart-attach-thumb" src="${att.previewUrl}" alt="" />
        <span style="max-width:110px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${att.fileName}</span>
        <button type="button" class="agy-cowart-attach-del" title="移除">×</button>
      `;
      chip.querySelector('.agy-cowart-attach-del').addEventListener('click', () => {
        state.attachments.splice(idx, 1);
        renderAttachments();
      });
      row.appendChild(chip);
    });

    if (sendBtn && promptInput) {
      sendBtn.disabled =
        (promptInput.value.trim().length === 0 && state.attachments.length === 0) || state.submitting;
    }
  }

  function detectActiveWorkspaceHint() {
    // 1. 尝试从当前 Composer 底部/顶部项目标识、或左侧选中项目标题提取名称
    const selectedRow = document.querySelector('.agy-sidebar-row[data-selected="true"]');
    if (selectedRow) {
      let cur = selectedRow.parentElement;
      for (let i = 0; i < 6 && cur; i++) {
        const header = cur.querySelector('[data-testid="project-header"]');
        if (header && header.textContent) {
          const name = header.textContent.trim();
          if (name) return name;
        }
        cur = cur.parentElement;
      }
    }

    const composerWsBtn = document.querySelector(
      '[data-main-content-body] button[aria-haspopup], .agy-composer-header button'
    );
    if (composerWsBtn && composerWsBtn.textContent) {
      const txt = composerWsBtn.textContent.trim();
      if (txt && txt.length < 60) return txt;
    }
    return '';
  }

  async function refreshProjectList() {
    try {
      const resp = await fetch(`${STAGE_BASE}/api/projects`, { cache: 'no-store' });
      if (!resp.ok) return false;
      const data = await resp.json();
      if (data && data.ok && Array.isArray(data.projects)) {
        state.projects = data.projects;
        return true;
      }
    } catch {}
    return false;
  }

  function pickDefaultTarget() {
    const projects = state.projects || [];
    if (projects.length === 0) return null;

    const hint = detectActiveWorkspaceHint().toLowerCase();
    if (hint) {
      const hinted = projects.find(
        (p) => !p.isGlobal && (p.name.toLowerCase() === hint || hint.includes(p.name.toLowerCase()))
      );
      if (hinted) return hinted;
    }

    const storedDir = localStorage.getItem(STORAGE_LAST_PROJECT) || '';
    if (storedDir) {
      const stored = projects.find(
        (p) => p.projectDir.toLowerCase() === storedDir.toLowerCase()
      );
      if (stored) return stored;
    }

    // 优先选最近活跃且已有 canvas 的本地项目；其次任意活跃本地项目；最后全局 Documents/Cowart
    const localWithCanvas = projects.find((p) => !p.isGlobal && p.hasCanvas);
    if (localWithCanvas) return localWithCanvas;

    const anyLocal = projects.find((p) => !p.isGlobal);
    if (anyLocal) return anyLocal;

    return projects.find((p) => p.isGlobal) || projects[0];
  }

  function renderProjectMenu() {
    const stage = document.getElementById(STAGE_ID);
    if (!stage) return;
    const menu = stage.querySelector('[data-role="project-menu"]');
    const nameLabel = stage.querySelector('[data-role="project-name"]');
    if (!menu) return;

    if (nameLabel && state.currentTarget) {
      nameLabel.textContent = state.currentTarget.name;
      nameLabel.title = state.currentTarget.canvasDir || state.currentTarget.projectDir;
    }

    menu.innerHTML = '';
    for (const proj of state.projects) {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'agy-cowart-proj-item';
      const isSelected =
        state.currentTarget &&
        state.currentTarget.projectDir.toLowerCase() === proj.projectDir.toLowerCase();
      if (isSelected) item.classList.add('is-selected');

      const badge = proj.isGlobal
        ? '<span class="agy-cowart-proj-badge">全局</span>'
        : proj.hasCanvas
        ? '<span class="agy-cowart-proj-badge">已有画布</span>'
        : '';

      item.innerHTML = `
        <span class="agy-cowart-proj-item-title">
          <span>${proj.isGlobal ? '🌐 ' : '📁 '}${proj.name}</span>
          ${badge}
        </span>
        <span class="agy-cowart-proj-item-sub" title="${proj.canvasDir}">${proj.projectDir}</span>
      `;
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        state.projectMenuOpen = false;
        menu.classList.remove('is-open');
        selectProjectTarget(proj);
      });
      menu.appendChild(item);
    }

    const divider = document.createElement('div');
    divider.className = 'agy-cowart-proj-divider';
    menu.appendChild(divider);

    const pickBtn = document.createElement('button');
    pickBtn.type = 'button';
    pickBtn.className = 'agy-cowart-proj-item';
    pickBtn.innerHTML = `
      <span class="agy-cowart-proj-item-title"><span>➕ 选择其他项目文件夹...</span></span>
      <span class="agy-cowart-proj-item-sub">打开任意本地目录的 canvas 画布</span>
    `;
    pickBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      state.projectMenuOpen = false;
      menu.classList.remove('is-open');
      let chosenPath = '';
      try {
        if (window.__agyCowartSidebarIPC && typeof window.__agyCowartSidebarIPC.pickFolder === 'function') {
          const res = await window.__agyCowartSidebarIPC.pickFolder();
          if (res && !res.canceled && res.path) chosenPath = res.path;
        } else {
          const typed = window.prompt('请输入项目文件夹绝对路径：', state.currentTarget?.projectDir || '');
          if (typed && typed.trim()) chosenPath = typed.trim();
        }
      } catch {}
      if (chosenPath) {
        const parts = chosenPath.replace(/[\\/]+$/, '').split(/[\\/]/);
        const name = parts[parts.length - 1] || chosenPath;
        const sep = chosenPath.includes('\\') ? '\\' : '/';
        const customProj = {
          name,
          projectDir: chosenPath,
          canvasDir: `${chosenPath.replace(/[\\/]+$/, '')}${sep}canvas`,
          isGlobal: false,
          hasCanvas: false,
        };
        selectProjectTarget(customProj);
      }
    });
    menu.appendChild(pickBtn);
  }

  function selectProjectTarget(proj) {
    if (!proj) return;
    state.currentTarget = proj;
    localStorage.setItem(STORAGE_LAST_PROJECT, proj.projectDir);
    renderProjectMenu();
    loadCanvasIntoIframe(true);
  }

  function syncIframeHostState() {
    const stage = document.getElementById(STAGE_ID);
    const iframe = stage?.querySelector('[data-role="iframe"]');
    const themeMode = isDarkTheme() ? 'dark' : 'light';
    if (iframe && iframe.contentWindow) {
      iframe.contentWindow.postMessage(
        {
          type: 'AGY_COWART_HOST_STATE',
          layoutMode: state.layout,
          themeMode,
        },
        '*'
      );
    }
  }

  function loadCanvasIntoIframe(forceReload = false) {
    const stage = document.getElementById(STAGE_ID);
    if (!stage) return;
    const iframe = stage.querySelector('[data-role="iframe"]');
    const errorBanner = stage.querySelector('[data-role="error-banner"]');
    const errorText = stage.querySelector('[data-role="error-text"]');
    if (!iframe) return;

    const target = state.currentTarget;
    const url = new URL(`${STAGE_BASE}/canvas`);
    if (target?.projectDir) url.searchParams.set('projectDir', target.projectDir);
    if (target?.canvasDir) url.searchParams.set('canvasDir', target.canvasDir);
    url.searchParams.set('layout', state.layout);
    url.searchParams.set('theme', isDarkTheme() ? 'dark' : 'light');

    const nextSrc = url.toString();
    const sameTarget =
      iframe.dataset.projectDir === (target?.projectDir || '') &&
      iframe.dataset.canvasDir === (target?.canvasDir || '');

    if (!forceReload && sameTarget && iframe.getAttribute('src')) {
      syncIframeHostState();
      return;
    }

    fetch(`${STAGE_BASE}/api/health`, { cache: 'no-store' })
      .then((r) => r.json())
      .then((h) => {
        if (!h || !h.ok || !h.cowartInstalled) {
          throw new Error(
            h && !h.cowartInstalled
              ? '未在 ~/.gemini/config/plugins/cowart 找到已安装的 Cowart 插件产物。'
              : 'Cowart 服务响应异常'
          );
        }
        errorBanner?.classList.remove('is-visible');
        iframe.dataset.projectDir = target?.projectDir || '';
        iframe.dataset.canvasDir = target?.canvasDir || '';
        iframe.setAttribute('src', nextSrc);
      })
      .catch((err) => {
        if (errorText) errorText.textContent = err?.message || String(err);
        errorBanner?.classList.add('is-visible');
      });
  }

  function setCowartLayout(nextLayout) {
    state.layout = nextLayout === 'split' ? 'split' : 'fullscreen';
    document.body.setAttribute('data-agy-cowart-layout', state.layout);

    if (state.layout === 'split') {
      closeModelMenu();
    } else {
      syncModelButtonLabel();
    }

    const stage = document.getElementById(STAGE_ID);
    const toggleBtn = stage?.querySelector('[data-role="split-toggle-btn"]');
    if (toggleBtn) {
      toggleBtn.title =
        state.layout === 'fullscreen' ? '展开右侧对话分栏' : '收起右侧对话，回到全屏画布';
    }
    syncIframeHostState();
    window.dispatchEvent(new Event('resize'));
  }

  async function openCowartView() {
    try {
      window.dispatchEvent(new CustomEvent('agy:stage-activate', { detail: { source: 'cowart' } }));
    } catch {}
    injectStyles();
    ensureSidebarNavItem();
    ensureStageContainers();

    state.active = true;
    document.body.setAttribute('data-agy-cowart-active', 'true');
    setCowartLayout(state.layout || 'fullscreen');
    document.getElementById(NAV_ID)?.setAttribute('data-active', 'true');

    if (!document.querySelector('[data-testid="model-selector-trigger"]') && !findMainComposerEditor()) {
      triggerProgrammaticNewChat();
      setTimeout(() => {
        if (state.active) {
          syncModelButtonLabel();
          if (state.modelMenuOpen) renderModelMenu();
        }
      }, 240);
      setTimeout(() => {
        if (state.active) {
          syncModelButtonLabel();
          if (state.modelMenuOpen) renderModelMenu();
        }
      }, 650);
    } else {
      syncModelButtonLabel();
    }

    if (!state.currentTarget) {
      await refreshProjectList();
      state.currentTarget = pickDefaultTarget();
      renderProjectMenu();
    } else {
      void refreshProjectList().then(() => renderProjectMenu());
    }

    loadCanvasIntoIframe(false);
  }

  function closeCowartView() {
    if (!state.active) return;
    state.active = false;
    state.projectMenuOpen = false;
    closeModelMenu();
    document.getElementById(STAGE_ID)?.querySelector('[data-role="project-menu"]')?.classList.remove('is-open');
    document.body.removeAttribute('data-agy-cowart-active');
    document.body.removeAttribute('data-agy-cowart-layout');
    document.getElementById(NAV_ID)?.setAttribute('data-active', 'false');
    window.dispatchEvent(new Event('resize'));
  }

  function isBlankNewConversationView() {
    const path = window.location.pathname || '';
    if (path !== '/' && path !== '') return false;
    if (document.querySelector('[data-testid="conversation-view"]')) return false;
    if (document.querySelector('[data-testid="user-message"]')) return false;
    return Boolean(findMainComposerEditor());
  }

  function triggerProgrammaticNewChat() {
    const newBtn =
      document.querySelector('[data-testid="new-conversation-button"]') ||
      document.querySelector('[data-testid="sidebar-navigation-items"] a[href="/"]') ||
      document.querySelector('a[href="/"]');
    state.isProgrammaticNav = true;
    try {
      if (newBtn) {
        newBtn.click();
      } else {
        window.history.pushState({}, '', '/');
        window.dispatchEvent(new PopStateEvent('popstate'));
      }
    } finally {
      setTimeout(() => {
        state.isProgrammaticNav = false;
      }, 350);
    }
    return true;
  }

  function findMainComposerEditor() {
    const mainCol = document.querySelector('.agy-cowart-main-col') || document;
    return (
      mainCol.querySelector('[data-lexical-editor="true"][contenteditable="true"]') ||
      mainCol.querySelector('[contenteditable="true"][role="textbox"]') ||
      mainCol.querySelector('textarea')
    );
  }

  async function ensureFreshNewConversationEditor(timeoutMs = 3000) {
    if (isBlankNewConversationView()) {
      return findMainComposerEditor();
    }
    triggerProgrammaticNewChat();
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (isBlankNewConversationView()) {
        await new Promise((r) => setTimeout(r, 60));
        const ed = findMainComposerEditor();
        if (ed && ed.isConnected) return ed;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    return null;
  }

  async function waitForMainComposerEditor(timeoutMs = 1800) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const ed = findMainComposerEditor();
      if (ed) return ed;
      await new Promise((r) => setTimeout(r, 60));
    }
    return null;
  }

  function findComposerSendButton(editor) {
    let container = null;
    let cur = editor;
    for (let i = 0; i < 6 && cur; i += 1, cur = cur.parentElement) {
      if (cur.querySelector && cur.querySelector('[data-testid="model-selector-trigger"]')) {
        container = cur;
        break;
      }
    }
    if (!container) {
      container =
        editor?.closest('.agy-cowart-main-col') ||
        document.querySelector('.agy-cowart-main-col') ||
        document;
    }

    const btns = [...container.querySelectorAll('button')];
    for (const b of btns) {
      if (b.disabled) continue;
      const tid = (b.getAttribute('data-testid') || '').toLowerCase();
      const aria = (b.getAttribute('aria-label') || b.title || '').toLowerCase();
      if ((tid.includes('send') || tid.includes('submit')) && !tid.includes('cancel') && !tid.includes('voice')) {
        return b;
      }
      if (
        (aria.includes('send') || aria.includes('submit') || aria.includes('发送') || aria.includes('提交')) &&
        !aria.includes('cancel') &&
        !aria.includes('取消') &&
        !aria.includes('voice') &&
        !aria.includes('语音')
      ) {
        return b;
      }
    }
    return null;
  }

  async function writeTextIntoEditor(editor, text) {
    editor.focus();
    await new Promise((r) => setTimeout(r, 40));

    // 清空残留草稿
    try {
      if (editor.tagName === 'TEXTAREA' || editor.tagName === 'INPUT') {
        const setter = Object.getOwnPropertyDescriptor(
          window.HTMLTextAreaElement.prototype,
          'value'
        )?.set;
        if (setter) setter.call(editor, text);
        else editor.value = text;
        editor.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      }

      document.execCommand('selectAll', false, null);
      document.execCommand('delete', false, null);
    } catch {}

    // 优先使用 Electron 原生 webContents.insertText（对 Lexical 最稳健）
    try {
      if (
        window.__agyCowartSidebarIPC &&
        typeof window.__agyCowartSidebarIPC.insertText === 'function'
      ) {
        const res = await window.__agyCowartSidebarIPC.insertText(text);
        if (res && res.ok) return true;
      }
    } catch {}

    // 次选：合成 ClipboardEvent paste 供 Lexical 接管
    try {
      const dt = new DataTransfer();
      dt.setData('text/plain', text);
      const pasteEvt = new ClipboardEvent('paste', {
        clipboardData: dt,
        bubbles: true,
        cancelable: true,
      });
      editor.dispatchEvent(pasteEvt);
      if ((editor.textContent || '').trim().length > 0) {
        return true;
      }
    } catch {}

    // 兜底：execCommand
    try {
      document.execCommand('insertText', false, text);
      return true;
    } catch {
      return false;
    }
  }

  async function submitToAntigravityChat(rawPrompt, attachments = [], options = {}) {
    const { forceNewConversation = false } = options || {};
    const cleanPrompt = String(rawPrompt || '').trim();
    if (!cleanPrompt && attachments.length === 0) return false;
    if (state.submitting) return false;
    state.submitting = true;

    try {
      // 1. 先切到「左主画布 + 右侧窄聊天栏」分栏同屏
      if (!state.active) {
        await openCowartView();
      }
      setCowartLayout('split');

      // 2. 底部悬浮提问胶囊等触发场景强制新建空白会话；已在分栏协作中时沿用当前右侧编辑器
      let editor = null;
      if (forceNewConversation) {
        editor = await ensureFreshNewConversationEditor(3000);
      } else {
        editor = findMainComposerEditor();
        if (!editor) {
          editor = await ensureFreshNewConversationEditor(2500);
        }
      }
      if (!editor) {
        return false;
      }

      // 若新建会话后原生模型状态未与胶囊所选模型一致，兜底重设一次模型
      if (forceNewConversation && state.selectedModelOption) {
        const bridge = getNativeModelBridge();
        if (bridge && !isSameModelOption(bridge.selectedModel, state.selectedModelOption)) {
          const allOpts = [...bridge.modelOptions, ...bridge.customModels];
          const matched = allOpts.find((o) => isSameModelOption(o, state.selectedModelOption));
          if (matched && !matched.disabled) {
            try {
              bridge.setSelectedModel(matched);
              await new Promise((r) => setTimeout(r, 60));
            } catch {}
          }
        }
      }

      // 3. 拼装带工作区路径与附件引用的消息文本
      const parts = [];
      if (cleanPrompt) parts.push(cleanPrompt);
      if (attachments.length > 0) {
        parts.push(
          '参考图片文件：\n' + attachments.map((a) => `- ${a.filePath}`).join('\n')
        );
      }
      if (!cleanPrompt.includes('[Cowart Workspace Context:') && state.currentTarget) {
        parts.push(
          `[Cowart Workspace Context: ${JSON.stringify({
            projectDir: state.currentTarget.projectDir,
            canvasDir: state.currentTarget.canvasDir,
          })}]`
        );
      }
      const finalMessage = parts.join('\n\n');

      // 4. 注入编辑器并触发发送
      const ok = await writeTextIntoEditor(editor, finalMessage);
      if (!ok) return false;

      await new Promise((r) => setTimeout(r, 110));

      const sendBtn = findComposerSendButton(editor);
      if (sendBtn && !sendBtn.disabled) {
        sendBtn.click();
      } else {
        editor.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'Enter',
            code: 'Enter',
            keyCode: 13,
            which: 13,
            bubbles: true,
            cancelable: true,
          })
        );
      }
      return true;
    } finally {
      state.submitting = false;
    }
  }

  async function handleFloatingSubmit() {
    const stage = document.getElementById(STAGE_ID);
    if (!stage) return;
    const promptInput = stage.querySelector('[data-role="prompt-input"]');
    const sendBtn = stage.querySelector('[data-role="send-btn"]');
    if (!promptInput) return;

    const text = promptInput.value.trim();
    if (!text && state.attachments.length === 0) return;

    const atts = [...state.attachments];
    if (sendBtn) sendBtn.disabled = true;

    const submitted = await submitToAntigravityChat(text, atts, { forceNewConversation: true });
    if (submitted) {
      promptInput.value = '';
      promptInput.style.height = 'auto';
      state.attachments = [];
      renderAttachments();
    } else if (sendBtn) {
      sendBtn.disabled = false;
    }
  }

  function setupListeners() {
    navClickHandler = (e) => {
      if (state.isProgrammaticNav || !state.active) return;
      const target = e.target;
      if (!(target instanceof Element)) return;
      if (target.closest(`#${NAV_ID}`)) return;

      const clickedNav = target.closest(
        '[data-testid="sidebar-navigation-items"] a, [data-testid="sidebar-navigation-items"] button, .agy-sidebar-row, [data-testid="new-conversation-button"]'
      );
      if (clickedNav) {
        closeCowartView();
      }
    };
    document.addEventListener('click', navClickHandler, true);

    stageActivateHandler = (e) => {
      const src = e?.detail?.source;
      if (src && src !== 'cowart' && state.active) {
        closeCowartView();
      }
    };
    window.addEventListener('agy:stage-activate', stageActivateHandler);

    docPointerHandler = (e) => {
      const stage = document.getElementById(STAGE_ID);
      if (!stage) return;
      if (state.projectMenuOpen) {
        const controls = stage.querySelector('.agy-cowart-top-controls');
        if (controls && !controls.contains(e.target)) {
          state.projectMenuOpen = false;
          stage.querySelector('[data-role="project-menu"]')?.classList.remove('is-open');
        }
      }
      if (state.modelMenuOpen) {
        const modelWrap = stage.querySelector('[data-role="model-wrap"]');
        if (modelWrap && !modelWrap.contains(e.target)) {
          closeModelMenu();
        }
      }
    };
    document.addEventListener('pointerdown', docPointerHandler);

    messageHandler = (event) => {
      const data = event.data;
      if (!data || typeof data !== 'object') return;
      if (data.type === 'AGY_COWART_FOLLOW_UP' && data.prompt) {
        void submitToAntigravityChat(data.prompt, [], {
          forceNewConversation: state.layout !== 'split',
        });
      }
    };
    window.addEventListener('message', messageHandler);

    layoutObserver = new MutationObserver(() => {
      if (observerRaf) return;
      observerRaf = true;
      requestAnimationFrame(() => {
        observerRaf = false;
        injectStyles();
        ensureSidebarNavItem();
        if (state.active) {
          ensureStageContainers();
          syncModelButtonLabel();
        }
      });
    });
    if (document.body) {
      layoutObserver.observe(document.body, { childList: true, subtree: true });
    }

    themeObserver = new MutationObserver(() => {
      if (state.active) syncIframeHostState();
    });
    if (document.body) {
      themeObserver.observe(document.body, {
        attributes: true,
        attributeFilter: ['class', 'style'],
      });
    }
  }

  function start() {
    injectStyles();
    ensureSidebarNavItem();
    setupListeners();
  }

  window.__AGY_COWART_SIDEBAR_CLEANUP__ = (isReload = false) => {
    try {
      layoutObserver?.disconnect();
      themeObserver?.disconnect();
    } catch {}
    layoutObserver = null;
    themeObserver = null;

    if (navClickHandler) document.removeEventListener('click', navClickHandler, true);
    if (docPointerHandler) document.removeEventListener('pointerdown', docPointerHandler);
    if (messageHandler) window.removeEventListener('message', messageHandler);
    if (stageActivateHandler) window.removeEventListener('agy:stage-activate', stageActivateHandler);

    document.body.removeAttribute('data-agy-cowart-active');
    document.body.removeAttribute('data-agy-cowart-layout');
    document.querySelector('.agy-cowart-sheet-row')?.classList.remove('agy-cowart-sheet-row');
    document.querySelector('.agy-cowart-main-col')?.classList.remove('agy-cowart-main-col');

    document.getElementById(NAV_ID)?.remove();
    document.getElementById(STAGE_ID)?.remove();
    document.getElementById(RESIZER_ID)?.remove();
    document.getElementById(SPLIT_BAR_ID)?.remove();
    document.getElementById(STYLE_ID)?.remove();
    if (!isReload) {
      window.dispatchEvent(new Event('resize'));
    }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
})();
