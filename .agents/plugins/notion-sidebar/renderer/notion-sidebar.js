/**
 * Antigravity Notion Sidebar — 对齐 Codex UI 设计的独立 Notion 工作台与三态无缝对话容器
 *
 * 核心交互与视觉设计：
 * 1. 左侧栏独立 `Notion` 导航入口（位于 Cowart / 自动化正下方，与其它全屏舞台自动互斥）；
 * 2. 一体化纯白大圆角画布（消除多层嵌套边框与割裂缝隙，分栏态中间仅保留 1px 极细分割线与隐形调宽热区）；
 * 3. 同一个原生 Antigravity 对话容器（.agy-notion-main-col）支持三态零损耗流转：
 *    - `dock`（底部紧凑输入胶囊）：全宽沉浸阅读笔记，底部居中双层悬浮输入条（含 `-` 最小化、会话恢复胶囊、`⋮⋮` 拖动/选项菜单）；
 *    - `float`（页面内可拖拽悬浮对话小窗，复刻 Codex 图 2）：全宽阅读不挤压排版，原地展开白底大圆角悬浮对话窗
 *      （顶栏含 `-` 收起、`💬 会话标题 ▾` 切换/新建、`⋮⋮` 拖动以移动·点击查看选项，内部完整复用原生流式消息与输入框）；
 *    - `split`（右侧停靠分栏，复刻 Codex 图 1）：左栏展示 42px `[N] Notion` 品牌顶条，右栏等高对齐展示
 *      `[💬 会话标题 ×]` 胶囊标签 + `+` 新建 + `↙↗` 切回悬浮小窗 + `◫` 收起对话；
 * 4. 所有从 Notion 工作台发起的新对话自动归入专属 `Notion` 项目。
 */
(function installAntigravityNotionSidebar() {
  if (window.__AGY_NOTION_SIDEBAR_LOCKED__ && !window.__AGY_NOTION_SIDEBAR_FORCE_RELOAD__) {
    return;
  }
  window.__AGY_NOTION_SIDEBAR_FORCE_RELOAD__ = false;
  window.__AGY_NOTION_SIDEBAR_LOCKED__ = true;

  if (typeof window.__AGY_NOTION_SIDEBAR_CLEANUP__ === 'function') {
    try {
      window.__AGY_NOTION_SIDEBAR_CLEANUP__(true);
    } catch {}
  }

  const STAGE_BASE = 'http://127.0.0.1:45793';
  const STYLE_ID = 'agy-notion-sidebar-styles';
  const NAV_ID = 'agy-notion-nav-item';
  const STAGE_ID = 'agy-notion-stage';
  const RESIZER_ID = 'agy-notion-resizer';
  const CHROME_ID = 'agy-notion-chat-chrome';
  const FLOAT_RESIZERS_ID = 'agy-notion-float-resizers';
  const FALLBACK_TOGGLE_ID = 'agy-notion-fallback-toggle';
  const GRIP_TOOLTIP_ID = 'agy-notion-grip-tooltip';
  const STORAGE_CHAT_WIDTH = 'agy_notion_split_chat_width';
  const STORAGE_FLOAT_SIZE = 'agy_notion_float_size';
  const STORAGE_LAST_NOTION_CONVO = 'agy_notion_last_convo_path';
  const STORAGE_PAGE_CONVOS = 'agy_notion_page_convos';
  const STORAGE_OPEN_TABS = 'agy_notion_open_tabs';
  const STORAGE_ACTIVE_TAB = 'agy_notion_active_tab_key';
  const STORAGE_INJECTED_PAGES = 'agy_notion_convo_injected_pages';
  const DRAFT_TAB_KEY = '__draft__';
  const DEFAULT_FLOAT_SIZE = { width: 440, height: 560 };

  function loadJsonObjectStorage(key, fallback) {
    try {
      const raw = JSON.parse(localStorage.getItem(key) || 'null');
      if (raw && typeof raw === 'object') return raw;
    } catch {}
    return fallback;
  }

  function loadSavedPageConvos() {
    const obj = loadJsonObjectStorage(STORAGE_PAGE_CONVOS, {});
    return Array.isArray(obj) ? {} : obj;
  }

  function loadSavedOpenTabs() {
    try {
      const arr = JSON.parse(localStorage.getItem(STORAGE_OPEN_TABS) || '[]');
      if (Array.isArray(arr)) {
        return arr
          .filter((t) => t && typeof t.key === 'string' && typeof t.path === 'string')
          .slice(0, 20);
      }
    } catch {}
    return [];
  }

  function loadSavedInjectedPages() {
    const obj = loadJsonObjectStorage(STORAGE_INJECTED_PAGES, {});
    return Array.isArray(obj) ? {} : obj;
  }

  function loadSavedFloatSize() {
    try {
      const raw = JSON.parse(localStorage.getItem(STORAGE_FLOAT_SIZE) || 'null');
      if (raw && Number.isFinite(raw.width) && Number.isFinite(raw.height)) {
        return {
          width: Math.min(960, Math.max(340, Math.round(raw.width))),
          height: Math.min(920, Math.max(300, Math.round(raw.height))),
        };
      }
    } catch {}
    return { ...DEFAULT_FLOAT_SIZE };
  }

  const NOTION_NAV_SVG = `<svg class="agy-notion-nav-svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <rect x="3" y="3" width="18" height="18" rx="3.8"></rect>
    <path d="M8.5 16.5V7.7L15.4 16.3V7.5"></path>
  </svg>`;

  const BUBBLE_ICON_SVG = `<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M13.5 7.8a5.3 5.3 0 0 1-5.5 5.2 5.7 5.7 0 0 1-2.4-.5L2.5 13.5l.9-2.8A5.1 5.1 0 0 1 2.5 7.8 5.3 5.3 0 0 1 8 2.5a5.3 5.3 0 0 1 5.5 5.3Z"></path>
  </svg>`;

  const CHEVRON_DOWN_SVG = `<svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <polyline points="4 6 8 10 12 6"></polyline>
  </svg>`;

  const MINUS_SVG = `<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true">
    <line x1="3.5" y1="8" x2="12.5" y2="8"></line>
  </svg>`;

  const GRIP_DOTS_SVG = `<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
    <circle cx="5.5" cy="4.2" r="1.15"></circle>
    <circle cx="10.5" cy="4.2" r="1.15"></circle>
    <circle cx="5.5" cy="8" r="1.15"></circle>
    <circle cx="10.5" cy="8" r="1.15"></circle>
    <circle cx="5.5" cy="11.8" r="1.15"></circle>
    <circle cx="10.5" cy="11.8" r="1.15"></circle>
  </svg>`;

  const PLUS_SVG = `<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" aria-hidden="true">
    <line x1="8" y1="3.3" x2="8" y2="12.7"></line>
    <line x1="3.3" y1="8" x2="12.7" y2="8"></line>
  </svg>`;

  // 对角向内收缩/切换悬浮小窗图标（复刻 Codex 图 1 顶栏 ↙↗ 按钮）
  const UNDOCK_FLOAT_SVG = `<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <polyline points="10 2.8 10 6 13.2 6"></polyline>
    <line x1="13.5" y1="2.5" x2="10" y2="6"></line>
    <polyline points="6 13.2 6 10 2.8 10"></polyline>
    <line x1="2.5" y1="13.5" x2="6" y2="10"></line>
  </svg>`;

  // 右侧边栏收起/展开图标（复刻 Codex ◫ 按钮）
  const SIDEBAR_PANE_SVG = `<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <rect x="2" y="2.5" width="12" height="11" rx="2"></rect>
    <line x1="10" y1="2.5" x2="10" y2="13.5"></line>
  </svg>`;

  const QUICK_PROMPTS = [
    { label: '总结这篇笔记的核心要点', prompt: '请结合当前打开的 Notion 笔记，帮我提炼核心要点和关键结论。' },
    { label: '解释当前代码 / 概念细节', prompt: '请详细解释这篇 Notion 笔记中的关键概念和代码逻辑，并举一个直觉例子。' },
    { label: '帮我润色并直接补充到笔记', prompt: '请帮我优化和补充这篇 Notion 笔记的结构与细节，并通过 Notion 工具直接更新到当前页面。' },
    { label: '从笔记中整理待办清单', prompt: '请基于这篇 Notion 笔记整理出可执行的下一步待办事项（To-do 清单）。' },
  ];

  const state = {
    active: false,
    layout: 'dock', // 'dock' | 'float' | 'split'
    currentView: 'loading', // 'loading' | 'auth' | 'home' | 'all' | 'page'
    currentPage: null, // { id, title, url, path, icon }
    notionProject: {
      id: 'a8f4c2d1-6b3e-4e9a-8c5f-2b7e9d1a4c60',
      name: 'Notion',
      dir: '',
      knownProjectNames: [],
      loaded: false,
    },
    hasActiveNotionChat: false,
    notionConvoTrackingArmed: false,
    restoringConvo: false,
    lastNotionConvoPath: localStorage.getItem(STORAGE_LAST_NOTION_CONVO) || '',
    pageConvoMap: loadSavedPageConvos(),
    openTabs: loadSavedOpenTabs(),
    activeTabKey: localStorage.getItem(STORAGE_ACTIVE_TAB) || '',
    convoInjectedPageMap: loadSavedInjectedPages(),
    convoPickerOpen: false,
    convoPickerFilter: '',
    convoCatalog: { pinned: [], recent: [], loadedAt: 0 },
    injectingNativeSend: false,
    bypassNativeIntercept: false,
    lastSubmittedPrompt: '',
    liveConvoTitle: '',
    selectedQuote: '',
    dockMinimized: false,
    homeDockExpanded: false,
    dockOffset: { x: 0, y: 0 },
    floatSize: loadSavedFloatSize(),
    quickMenuOpen: false,
    modelMenuOpen: false,
    dockGripMenuOpen: false,
    chromeMenuMode: '', // '' | 'title' | 'grip'
    selectedModelLabel: '',
    selectedModelOption: null,
    submitting: false,
    isProgrammaticNav: false,
    chatWidth: Math.min(640, Math.max(320, Number(localStorage.getItem(STORAGE_CHAT_WIDTH) || 410))),
  };

  let layoutObserver = null;
  let themeObserver = null;
  let windowResizeHandler = null;
  let navClickHandler = null;
  let auxToggleClickHandler = null;
  let nativeKeydownHandler = null;
  let nativeSendClickHandler = null;
  let messageHandler = null;
  let docPointerHandler = null;
  let stageActivateHandler = null;
  let observerRaf = false;
  let lastRenderedTabsSig = '';

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

  function escapeHtml(s) {
    return String(s ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      /* 1. 左侧栏 Notion 独立入口 */
      #${NAV_ID} {
        box-sizing: border-box;
        border: none !important;
        margin: 0;
        text-decoration: none;
        outline: none !important;
      }
      #${NAV_ID}[data-active="true"] {
        background-color: rgba(15, 23, 42, 0.068) !important;
        color: #0f172a !important;
        box-shadow: inset 0 0 0 1px rgba(15, 23, 42, 0.045);
        font-weight: 500;
      }
      body.theme-dark #${NAV_ID}[data-active="true"],
      body.dark #${NAV_ID}[data-active="true"] {
        background-color: rgba(255, 255, 255, 0.1) !important;
        color: #f8fafc !important;
        box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.08);
      }
      .agy-notion-nav-svg {
        width: 16px;
        height: 16px;
        flex-shrink: 0;
        display: block;
      }

      /* 激活 Notion 模式时弱化其余侧栏高亮 */
      body[data-agy-notion-active="true"] [data-testid="sidebar-navigation-items"] a:not(#${NAV_ID}),
      body[data-agy-notion-active="true"] .agy-sidebar-row[data-selected="true"] {
        background-color: transparent !important;
        box-shadow: none !important;
      }

      /* 拖拽期间禁止 iframe 吞掉鼠标事件 */
      body.agy-notion-dragging .agy-notion-iframe {
        pointer-events: none !important;
      }

      /* 自动注入上下文发送瞬间隐藏编辑器内原始元数据，防止 0.1s 闪烁 */
      body[data-agy-notion-submitting="true"] .agy-notion-main-col [data-lexical-editor="true"],
      body[data-agy-notion-submitting="true"] .agy-notion-main-col [contenteditable="true"][role="textbox"] {
        color: transparent !important;
        caret-color: transparent !important;
      }

      /* 对话气泡内折叠式「引用页面」卡片 */
      .agy-notion-ctx-fold {
        margin-top: 2px;
        border-radius: 8px;
        border: 1px solid rgba(15, 23, 42, 0.085);
        background: rgba(15, 23, 42, 0.032);
        font-size: 12px;
        color: #475569;
        overflow: hidden;
        max-width: 100%;
        user-select: none;
      }
      body.theme-dark .agy-notion-ctx-fold,
      body.dark .agy-notion-ctx-fold {
        background: rgba(255, 255, 255, 0.055);
        border-color: rgba(255, 255, 255, 0.11);
        color: #cbd5e1;
      }
      .agy-notion-ctx-summary {
        list-style: none;
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 4px 9px;
        cursor: pointer;
        font-weight: 500;
        line-height: 1.4;
        outline: none;
        transition: background-color 0.12s ease, color 0.12s ease;
      }
      .agy-notion-ctx-summary::-webkit-details-marker {
        display: none;
      }
      .agy-notion-ctx-summary:hover {
        background: rgba(15, 23, 42, 0.045);
        color: #0f172a;
      }
      body.theme-dark .agy-notion-ctx-summary:hover,
      body.dark .agy-notion-ctx-summary:hover {
        background: rgba(255, 255, 255, 0.07);
        color: #f8fafc;
      }
      .agy-notion-ctx-arrow {
        font-size: 10px;
        line-height: 1;
        color: #94a3b8;
        transition: transform 0.15s ease;
        flex-shrink: 0;
      }
      .agy-notion-ctx-fold[open] .agy-notion-ctx-arrow {
        transform: rotate(90deg);
      }
      .agy-notion-ctx-summary-title {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        min-width: 0;
        flex: 1 1 auto;
      }
      .agy-notion-ctx-body {
        padding: 6px 10px 8px;
        border-top: 1px solid rgba(15, 23, 42, 0.065);
        display: flex;
        flex-direction: column;
        gap: 4px;
        font-size: 11.5px;
        line-height: 1.5;
        color: #64748b;
        user-select: text;
        word-break: break-all;
      }
      body.theme-dark .agy-notion-ctx-body,
      body.dark .agy-notion-ctx-body {
        border-top-color: rgba(255, 255, 255, 0.08);
        color: #94a3b8;
      }
      .agy-notion-ctx-row {
        display: flex;
        align-items: baseline;
        gap: 6px;
      }
      .agy-notion-ctx-label {
        flex-shrink: 0;
        color: #94a3b8;
      }
      .agy-notion-ctx-link {
        color: #2383e2;
        text-decoration: none;
        cursor: pointer;
        word-break: break-word;
      }
      .agy-notion-ctx-link:hover {
        text-decoration: underline;
      }
      .agy-notion-ctx-quote {
        margin-top: 2px;
        padding: 4px 8px;
        border-left: 2px solid rgba(35, 131, 226, 0.5);
        background: rgba(35, 131, 226, 0.05);
        border-radius: 0 5px 5px 0;
        color: inherit;
        white-space: pre-wrap;
        word-break: break-word;
      }

      /* 2. 一体化无框纯白工作区画布（复刻 Codex 图 1 & 图 2） */
      body[data-agy-notion-active="true"] .agy-notion-sheet-row {
        display: flex !important;
        flex-direction: row !important;
        align-items: stretch !important;
        min-width: 0 !important;
        min-height: 0 !important;
        position: relative !important;
        background: #ffffff !important;
        border-radius: 14px !important;
        border: 1px solid rgba(15, 35, 68, 0.075) !important;
        box-shadow: 0 2px 10px -2px rgba(15, 35, 68, 0.045), 0 1px 2px rgba(15, 35, 68, 0.025) !important;
        overflow: hidden !important;
      }
      body.theme-dark[data-agy-notion-active="true"] .agy-notion-sheet-row,
      body.dark[data-agy-notion-active="true"] .agy-notion-sheet-row {
        background: #191919 !important;
        border-color: rgba(255, 255, 255, 0.09) !important;
        box-shadow: none !important;
      }

      /* 3. Notion 舞台容器（融入统一纯白画布，无内嵌重复边框） */
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
        border: none !important;
        border-radius: 0 !important;
        box-shadow: none !important;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Microsoft YaHei", sans-serif;
      }
      body.theme-dark #${STAGE_ID},
      body.dark #${STAGE_ID} {
        background: #191919;
      }
      body[data-agy-notion-active="true"] #${STAGE_ID} {
        display: flex;
      }
      body[data-agy-notion-active="true"][data-agy-notion-layout="split"] #${STAGE_ID} {
        flex: 1 1 0% !important;
        min-width: 360px !important;
      }

      .agy-notion-iframe {
        width: 100%;
        height: 100%;
        border: none;
        display: block;
        background: transparent;
      }

      /* 隐藏原生辅助面板，且在 Notion 激活时收敛原生对话顶栏与右上角散落按钮（保留 DOM 挂载以同步标题） */
      body[data-agy-notion-active="true"] [data-side-panel-body],
      body[data-agy-notion-active="true"] [data-side-panel-strip],
      body[data-agy-notion-active="true"] [data-testid="toggle-maximize-pane"],
      body[data-agy-notion-active="true"] [data-testid="right-cluster-fade"],
      body[data-agy-notion-active="true"] [data-testid="toggle-aux-sidebar"],
      body[data-agy-notion-active="true"] [data-testid="mobile-toggle-aux-sidebar"] {
        display: none !important;
      }
      body[data-agy-notion-active="true"] .agy-notion-main-col [data-main-content-header] {
        height: 0 !important;
        min-height: 0 !important;
        max-height: 0 !important;
        padding: 0 !important;
        margin: 0 !important;
        border: none !important;
        overflow: hidden !important;
        opacity: 0 !important;
        pointer-events: none !important;
      }
      body[data-agy-notion-active="true"] .agy-notion-main-col [data-main-content-body] {
        flex: 1 1 0% !important;
        min-height: 0 !important;
      }

      /* 4A. 形态一：dock（紧凑胶囊态）—— 原生聊天列移至屏幕外保活 */
      body[data-agy-notion-active="true"][data-agy-notion-layout="dock"] .agy-notion-main-col {
        position: fixed !important;
        right: -9999px !important;
        top: 0 !important;
        width: 420px !important;
        height: 640px !important;
        opacity: 0 !important;
        pointer-events: none !important;
        overflow: hidden !important;
      }

      /* 4B. 形态二：float（页面内可拖拽 + 八向自由缩放悬浮对话小窗，复刻 Codex 图 2） */
      body[data-agy-notion-active="true"][data-agy-notion-layout="float"] .agy-notion-main-col {
        position: fixed !important;
        left: calc(var(--agy-stage-cx, 52vw) + var(--agy-dock-x, 0px)) !important;
        bottom: calc(18px - var(--agy-dock-y, 0px)) !important;
        top: auto !important;
        right: auto !important;
        transform: translateX(-50%) !important;
        width: min(var(--agy-float-w, 440px), calc(100vw - 28px)) !important;
        height: min(var(--agy-float-h, 560px), calc(100vh - 28px)) !important;
        min-width: 340px !important;
        max-width: calc(100vw - 28px) !important;
        min-height: 300px !important;
        max-height: calc(100vh - 28px) !important;
        flex: none !important;
        display: flex !important;
        flex-direction: column !important;
        background: #ffffff !important;
        border-radius: 22px !important;
        border: 1px solid rgba(15, 23, 42, 0.085) !important;
        box-shadow: 0 24px 64px -12px rgba(15, 23, 42, 0.20), 0 4px 16px rgba(15, 23, 42, 0.06) !important;
        z-index: 68 !important;
        overflow: hidden !important;
        opacity: 1 !important;
        pointer-events: auto !important;
      }
      body.theme-dark[data-agy-notion-active="true"][data-agy-notion-layout="float"] .agy-notion-main-col,
      body.dark[data-agy-notion-active="true"][data-agy-notion-layout="float"] .agy-notion-main-col {
        background: #1f2025 !important;
        border-color: rgba(255, 255, 255, 0.12) !important;
        box-shadow: 0 26px 68px -12px rgba(0, 0, 0, 0.65) !important;
      }

      /* Float 悬浮窗八向边缘/圆角缩放手柄层 */
      #${FLOAT_RESIZERS_ID} {
        display: none;
        position: absolute;
        inset: 0;
        pointer-events: none;
        z-index: 92;
      }
      body[data-agy-notion-active="true"][data-agy-notion-layout="float"] #${FLOAT_RESIZERS_ID} {
        display: block;
      }
      .agy-notion-fresize {
        position: absolute;
        pointer-events: auto;
        user-select: none;
        touch-action: none;
      }
      .agy-notion-fresize[data-dir="n"] { top: 0; left: 15px; right: 15px; height: 6px; cursor: ns-resize; }
      .agy-notion-fresize[data-dir="s"] { bottom: 0; left: 15px; right: 15px; height: 7px; cursor: ns-resize; }
      .agy-notion-fresize[data-dir="w"] { left: 0; top: 15px; bottom: 15px; width: 7px; cursor: ew-resize; }
      .agy-notion-fresize[data-dir="e"] { right: 0; top: 15px; bottom: 15px; width: 6px; cursor: ew-resize; }
      .agy-notion-fresize[data-dir="nw"] { top: 0; left: 0; width: 15px; height: 15px; cursor: nwse-resize; }
      .agy-notion-fresize[data-dir="ne"] { top: 0; right: 0; width: 15px; height: 15px; cursor: nesw-resize; }
      .agy-notion-fresize[data-dir="sw"] { bottom: 0; left: 0; width: 16px; height: 16px; cursor: nesw-resize; }
      .agy-notion-fresize[data-dir="se"] {
        bottom: 0;
        right: 0;
        width: 18px;
        height: 18px;
        cursor: nwse-resize;
      }
      .agy-notion-fresize[data-dir="se"]::after {
        content: "";
        position: absolute;
        right: 6px;
        bottom: 6px;
        width: 7px;
        height: 7px;
        border-right: 1.6px solid rgba(100, 116, 139, 0.34);
        border-bottom: 1.6px solid rgba(100, 116, 139, 0.34);
        border-bottom-right-radius: 3px;
        transition: border-color 0.14s ease;
      }
      .agy-notion-fresize[data-dir="se"]:hover::after {
        border-color: rgba(35, 131, 226, 0.8);
      }

      /* 4C. 形态三：split（右侧停靠分栏，复刻 Codex 图 1：1px 极细分割线 + 零布局宽度隐形调宽热区） */
      #${RESIZER_ID} {
        display: none;
        width: 0;
        flex: 0 0 0px;
        position: relative;
        z-index: 38;
        user-select: none;
      }
      #${RESIZER_ID}::before {
        content: "";
        position: absolute;
        top: 0;
        bottom: 0;
        left: -5px;
        width: 10px;
        cursor: col-resize;
      }
      #${RESIZER_ID}::after {
        content: "";
        position: absolute;
        top: 0;
        bottom: 0;
        left: -1px;
        width: 2px;
        background: transparent;
        transition: background-color 0.15s ease;
        pointer-events: none;
      }
      #${RESIZER_ID}:hover::after,
      #${RESIZER_ID}.is-dragging::after {
        background: rgba(35, 131, 226, 0.55);
      }
      body[data-agy-notion-active="true"][data-agy-notion-layout="split"] #${RESIZER_ID} {
        display: block;
      }
      body[data-agy-notion-active="true"][data-agy-notion-layout="split"] .agy-notion-main-col {
        position: relative !important;
        flex: 0 0 var(--agy-notion-chat-width, 410px) !important;
        width: var(--agy-notion-chat-width, 410px) !important;
        min-width: 320px !important;
        max-width: 640px !important;
        height: 100% !important;
        display: flex !important;
        flex-direction: column !important;
        background: #ffffff !important;
        border: none !important;
        border-left: 1px solid rgba(15, 23, 42, 0.08) !important;
        border-radius: 0 !important;
        box-shadow: none !important;
        overflow: hidden !important;
        opacity: 1 !important;
        pointer-events: auto !important;
      }
      body.theme-dark[data-agy-notion-active="true"][data-agy-notion-layout="split"] .agy-notion-main-col,
      body.dark[data-agy-notion-active="true"][data-agy-notion-layout="split"] .agy-notion-main-col {
        background: #191919 !important;
        border-left-color: rgba(255, 255, 255, 0.09) !important;
      }

      /* 5. Codex 对话窗口专属顶栏 #agy-notion-chat-chrome（随 float / split 自动变形） */
      #${CHROME_ID} {
        display: none;
        flex-direction: column;
        flex-shrink: 0;
        background: inherit;
        position: relative;
        z-index: 25;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Microsoft YaHei", sans-serif;
      }
      body[data-agy-notion-active="true"][data-agy-notion-layout="float"] #${CHROME_ID},
      body[data-agy-notion-active="true"][data-agy-notion-layout="split"] #${CHROME_ID} {
        display: flex;
      }

      /* 5A. Float 悬浮小窗顶条（40px 高：左 - ，中 💬 标题 ▾，右 ⋮⋮） */
      .agy-notion-chrome-float-bar {
        display: none;
        height: 40px;
        padding: 0 12px;
        align-items: center;
        justify-content: space-between;
        gap: 6px;
        user-select: none;
        cursor: grab;
      }
      .agy-notion-chrome-float-bar:active {
        cursor: grabbing;
      }
      body[data-agy-notion-active="true"][data-agy-notion-layout="float"] .agy-notion-chrome-float-bar {
        display: flex;
      }
      .agy-notion-float-left {
        display: flex;
        align-items: center;
        gap: 4px;
        min-width: 0;
        flex: 1 1 0%;
      }
      .agy-notion-chrome-icon-btn {
        width: 26px;
        height: 26px;
        border: none;
        border-radius: 7px;
        background: transparent;
        color: #64748b;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        flex-shrink: 0;
        transition: background-color 0.12s ease, color 0.12s ease;
      }
      .agy-notion-chrome-icon-btn:hover {
        background: rgba(15, 23, 42, 0.06);
        color: #0f172a;
      }
      body.theme-dark .agy-notion-chrome-icon-btn,
      body.dark .agy-notion-chrome-icon-btn {
        color: #94a3b8;
      }
      body.theme-dark .agy-notion-chrome-icon-btn:hover,
      body.dark .agy-notion-chrome-icon-btn:hover {
        background: rgba(255, 255, 255, 0.09);
        color: #f8fafc;
      }
      .agy-notion-float-title-btn {
        height: 26px;
        max-width: 290px;
        padding: 0 8px;
        border: none;
        border-radius: 7px;
        background: transparent;
        color: #1e293b;
        font-size: 12.5px;
        font-weight: 500;
        display: inline-flex;
        align-items: center;
        gap: 6px;
        cursor: pointer;
        min-width: 0;
        transition: background-color 0.12s ease;
      }
      .agy-notion-float-title-btn:hover {
        background: rgba(15, 23, 42, 0.055);
      }
      body.theme-dark .agy-notion-float-title-btn,
      body.dark .agy-notion-float-title-btn {
        color: #e2e8f0;
      }
      body.theme-dark .agy-notion-float-title-btn:hover,
      body.dark .agy-notion-float-title-btn:hover {
        background: rgba(255, 255, 255, 0.08);
      }
      .agy-notion-title-ellipsis {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        min-width: 0;
      }

      /* 5B. Split 右侧分栏顶条（42px 等高对齐左栏 .brand-strip，底部通栏 1px 细线） */
      .agy-notion-chrome-split-bar {
        display: none;
        height: 42px;
        padding: 0 10px;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        border-bottom: 1px solid rgba(15, 23, 42, 0.08);
        user-select: none;
      }
      body.theme-dark .agy-notion-chrome-split-bar,
      body.dark .agy-notion-chrome-split-bar {
        border-bottom-color: rgba(255, 255, 255, 0.09);
      }
      body[data-agy-notion-active="true"][data-agy-notion-layout="split"] .agy-notion-chrome-split-bar {
        display: flex;
      }
      .agy-notion-split-tabs {
        display: flex;
        align-items: center;
        gap: 4px;
        min-width: 0;
        flex: 1 1 0%;
        overflow: hidden;
      }
      .agy-notion-tab-scroll {
        display: flex;
        align-items: center;
        gap: 4px;
        min-width: 0;
        flex: 0 1 auto;
        overflow-x: auto;
        overflow-y: hidden;
        scrollbar-width: none;
      }
      .agy-notion-tab-scroll::-webkit-scrollbar {
        display: none;
      }
      .agy-notion-split-tab {
        height: 28px;
        max-width: 175px;
        padding: 0 6px 0 10px;
        border-radius: 999px;
        border: 1px solid transparent;
        background: transparent;
        color: #64748b;
        font-size: 12.5px;
        font-weight: 450;
        display: inline-flex;
        align-items: center;
        gap: 6px;
        min-width: 0;
        flex-shrink: 0;
        cursor: pointer;
        transition: background-color 0.12s ease, border-color 0.12s ease, color 0.12s ease;
      }
      .agy-notion-split-tab:hover {
        background: rgba(15, 23, 42, 0.045);
        color: #1e293b;
      }
      .agy-notion-split-tab.is-active {
        max-width: 215px;
        border-color: rgba(15, 23, 42, 0.12);
        background: #ffffff;
        color: #0f172a;
        font-weight: 550;
        box-shadow: 0 1px 2px rgba(15, 23, 42, 0.035);
      }
      body.theme-dark .agy-notion-split-tab,
      body.dark .agy-notion-split-tab {
        color: #94a3b8;
      }
      body.theme-dark .agy-notion-split-tab:hover,
      body.dark .agy-notion-split-tab:hover {
        background: rgba(255, 255, 255, 0.06);
        color: #e2e8f0;
      }
      body.theme-dark .agy-notion-split-tab.is-active,
      body.dark .agy-notion-split-tab.is-active {
        background: rgba(255, 255, 255, 0.09);
        border-color: rgba(255, 255, 255, 0.14);
        color: #f8fafc;
        box-shadow: none;
      }

      /* 「＋」添加/切换左侧会话浮层面板 */
      .agy-notion-convo-picker {
        position: absolute;
        top: 40px;
        left: 10px;
        width: min(326px, calc(100% - 20px));
        border-radius: 14px;
        background: #ffffff;
        border: 1px solid rgba(15, 23, 42, 0.1);
        box-shadow: 0 18px 42px -10px rgba(15, 23, 42, 0.24), 0 2px 8px rgba(15, 23, 42, 0.06);
        padding: 6px;
        display: none;
        flex-direction: column;
        gap: 5px;
        z-index: 88;
      }
      .agy-notion-convo-picker.is-open {
        display: flex;
      }
      body.theme-dark .agy-notion-convo-picker,
      body.dark .agy-notion-convo-picker {
        background: #23242c;
        border-color: rgba(255, 255, 255, 0.13);
        box-shadow: 0 20px 46px -10px rgba(0, 0, 0, 0.65);
      }
      .agy-notion-picker-search {
        width: 100%;
        height: 31px;
        padding: 0 10px;
        border-radius: 8px;
        border: 1px solid rgba(15, 23, 42, 0.1);
        background: #f8fafc;
        color: #0f172a;
        font-size: 12.5px;
        outline: none;
      }
      .agy-notion-picker-search:focus {
        border-color: rgba(35, 131, 226, 0.5);
        background: #ffffff;
      }
      body.theme-dark .agy-notion-picker-search,
      body.dark .agy-notion-picker-search {
        background: rgba(255, 255, 255, 0.06);
        border-color: rgba(255, 255, 255, 0.12);
        color: #f1f5f9;
      }
      .agy-notion-picker-list {
        max-height: 310px;
        overflow-y: auto;
        display: flex;
        flex-direction: column;
        gap: 1px;
        padding-right: 2px;
      }
      .agy-notion-picker-section {
        padding: 6px 8px 3px;
        font-size: 11px;
        font-weight: 600;
        color: #94a3b8;
        user-select: none;
      }
      .agy-notion-picker-row {
        width: 100%;
        border: none;
        background: transparent;
        border-radius: 8px;
        padding: 7px 9px;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        font-size: 12.5px;
        color: #1e293b;
        cursor: pointer;
        text-align: left;
      }
      .agy-notion-picker-row:hover {
        background: rgba(15, 23, 42, 0.055);
      }
      .agy-notion-picker-row.is-new {
        font-weight: 550;
        color: #2383e2;
        border-bottom: 1px solid rgba(15, 23, 42, 0.06);
        border-radius: 8px 8px 0 0;
        margin-bottom: 2px;
      }
      body.theme-dark .agy-notion-picker-row,
      body.dark .agy-notion-picker-row {
        color: #e2e8f0;
      }
      body.theme-dark .agy-notion-picker-row:hover,
      body.dark .agy-notion-picker-row:hover {
        background: rgba(255, 255, 255, 0.08);
      }
      body.theme-dark .agy-notion-picker-row.is-new,
      body.dark .agy-notion-picker-row.is-new {
        color: #60a5fa;
        border-bottom-color: rgba(255, 255, 255, 0.08);
      }
      .agy-notion-picker-title {
        flex: 1;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .agy-notion-picker-meta {
        flex-shrink: 0;
        font-size: 11px;
        color: #94a3b8;
        max-width: 92px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .agy-notion-tab-close {
        width: 18px;
        height: 18px;
        border: none;
        border-radius: 999px;
        background: transparent;
        color: #64748b;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        font-size: 13px;
        line-height: 1;
        cursor: pointer;
        flex-shrink: 0;
        padding: 0;
      }
      .agy-notion-tab-close:hover {
        background: rgba(15, 23, 42, 0.08);
        color: #0f172a;
      }
      body.theme-dark .agy-notion-tab-close:hover,
      body.dark .agy-notion-tab-close:hover {
        background: rgba(255, 255, 255, 0.12);
        color: #ffffff;
      }
      .agy-notion-split-actions {
        display: flex;
        align-items: center;
        gap: 2px;
        flex-shrink: 0;
      }

      /* Chrome 下拉菜单（用于 Float 标题下拉与 ⋮⋮ 选项菜单） */
      .agy-notion-chrome-menu {
        position: absolute;
        top: 38px;
        min-width: 188px;
        border-radius: 12px;
        background: #ffffff;
        border: 1px solid rgba(15, 23, 42, 0.1);
        box-shadow: 0 14px 34px -8px rgba(15, 23, 42, 0.22), 0 2px 6px rgba(15, 23, 42, 0.06);
        padding: 5px;
        display: none;
        z-index: 80;
      }
      .agy-notion-chrome-menu.is-open {
        display: block;
      }
      .agy-notion-chrome-menu.align-left {
        left: 34px;
      }
      .agy-notion-chrome-menu.align-right {
        right: 10px;
      }
      body.theme-dark .agy-notion-chrome-menu,
      body.dark .agy-notion-chrome-menu {
        background: #25262e;
        border-color: rgba(255, 255, 255, 0.13);
        box-shadow: 0 16px 38px -8px rgba(0, 0, 0, 0.6);
      }
      .agy-notion-menu-item {
        width: 100%;
        border: none;
        background: transparent;
        border-radius: 8px;
        padding: 7px 10px;
        display: flex;
        align-items: center;
        gap: 8px;
        font-size: 12.5px;
        color: #1e293b;
        cursor: pointer;
        text-align: left;
      }
      .agy-notion-menu-item:hover {
        background: rgba(15, 23, 42, 0.055);
      }
      body.theme-dark .agy-notion-menu-item,
      body.dark .agy-notion-menu-item {
        color: #e2e8f0;
      }
      body.theme-dark .agy-notion-menu-item:hover,
      body.dark .agy-notion-menu-item:hover {
        background: rgba(255, 255, 255, 0.08);
      }

      /* Float/Split 模式下的笔记划选引用条 */
      .agy-notion-chrome-quote {
        display: none;
        align-items: center;
        gap: 8px;
        margin: 4px 12px 6px;
        padding: 5px 10px;
        border-radius: 10px;
        background: rgba(35, 131, 226, 0.07);
        border: 1px solid rgba(35, 131, 226, 0.22);
        font-size: 12px;
        color: #1e293b;
      }
      .agy-notion-chrome-quote.is-visible {
        display: flex;
      }
      body.theme-dark .agy-notion-chrome-quote,
      body.dark .agy-notion-chrome-quote {
        background: rgba(59, 142, 234, 0.14);
        border-color: rgba(96, 165, 250, 0.3);
        color: #e2e8f0;
      }
      .agy-notion-chrome-quote-text {
        flex: 1;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .agy-notion-chrome-quote-insert {
        border: none;
        border-radius: 6px;
        background: #2383e2;
        color: #ffffff;
        font-size: 11.5px;
        padding: 2px 8px;
        cursor: pointer;
        flex-shrink: 0;
      }
      .agy-notion-chrome-quote-insert:hover {
        background: #1b6fc4;
      }

      /* 6. 全宽态右上角 ◫ 侧栏切换按钮（复刻 Codex 图 2 右上角） */
      #${FALLBACK_TOGGLE_ID} {
        position: absolute;
        top: 9px;
        right: 12px;
        width: 28px;
        height: 28px;
        border-radius: 7px;
        border: none;
        background: transparent;
        color: #57606a;
        display: none;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        z-index: 48;
        transition: background-color 0.12s ease, color 0.12s ease;
      }
      #${FALLBACK_TOGGLE_ID}:hover {
        background: rgba(15, 23, 42, 0.06);
        color: #0f172a;
      }
      body.theme-dark #${FALLBACK_TOGGLE_ID},
      body.dark #${FALLBACK_TOGGLE_ID} {
        color: #94a3b8;
      }
      body.theme-dark #${FALLBACK_TOGGLE_ID}:hover,
      body.dark #${FALLBACK_TOGGLE_ID}:hover {
        background: rgba(255, 255, 255, 0.09);
        color: #ffffff;
      }
      body[data-agy-notion-active="true"][data-agy-notion-layout="dock"] #${FALLBACK_TOGGLE_ID},
      body[data-agy-notion-active="true"][data-agy-notion-layout="float"] #${FALLBACK_TOGGLE_ID} {
        display: inline-flex;
      }

      /* 7. 全局悬浮深黑提示气泡（复刻图 2「拖动以移动 · 点击查看选项」，不受任何容器 overflow 裁剪） */
      #${GRIP_TOOLTIP_ID} {
        position: fixed;
        left: 0;
        top: 0;
        transform: translate(-50%, -100%);
        padding: 5px 11px;
        border-radius: 8px;
        background: #18181b;
        color: #ffffff;
        font-size: 12px;
        font-weight: 500;
        letter-spacing: 0.01em;
        white-space: nowrap;
        box-shadow: 0 8px 22px rgba(0, 0, 0, 0.24);
        pointer-events: none;
        opacity: 0;
        transition: opacity 0.12s ease;
        z-index: 9999;
      }
      #${GRIP_TOOLTIP_ID}.is-visible {
        opacity: 1;
      }

      .agy-notion-mini-btn {
        height: 26px;
        padding: 0 11px;
        border-radius: 999px;
        border: 1px solid rgba(15, 35, 68, 0.12);
        background: #ffffff;
        color: #334155;
        font-size: 12px;
        cursor: pointer;
        transition: background-color 0.14s ease, border-color 0.14s ease;
      }
      .agy-notion-mini-btn:hover {
        background: #f1f5f9;
        border-color: rgba(15, 35, 68, 0.22);
      }

      /* 8. 笔记下方 Codex 风格紧凑悬浮提问胶囊（仅在 dock 态且打开具体笔记页时浮现） */
      .agy-notion-floating-dock {
        position: absolute;
        left: 50%;
        bottom: 20px;
        transform: translate3d(calc(-50% + var(--dock-x, 0px)), var(--dock-y, 0px), 0);
        width: min(460px, calc(100% - 48px));
        z-index: 32;
        display: none;
        flex-direction: column;
        align-items: center;
        gap: 8px;
        pointer-events: none;
      }
      .agy-notion-floating-dock.is-visible {
        display: flex;
      }
      body[data-agy-notion-layout="float"] .agy-notion-floating-dock,
      body[data-agy-notion-layout="split"] .agy-notion-floating-dock {
        display: none !important;
      }

      /* 选中文字引用条 */
      .agy-notion-quote-chip {
        pointer-events: auto;
        max-width: 100%;
        display: none;
        align-items: center;
        gap: 8px;
        padding: 5px 11px;
        border-radius: 999px;
        background: rgba(255, 255, 255, 0.97);
        border: 1px solid rgba(35, 131, 226, 0.28);
        box-shadow: 0 6px 18px -6px rgba(15, 23, 42, 0.14);
        font-size: 12px;
        color: #1e293b;
      }
      .agy-notion-quote-chip.is-visible {
        display: inline-flex;
      }
      body.theme-dark .agy-notion-quote-chip,
      body.dark .agy-notion-quote-chip {
        background: rgba(34, 35, 42, 0.96);
        border-color: rgba(96, 165, 250, 0.35);
        color: #e2e8f0;
      }
      .agy-notion-quote-text {
        max-width: 340px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .agy-notion-quote-clear {
        border: none;
        background: transparent;
        color: #64748b;
        cursor: pointer;
        font-size: 14px;
        line-height: 1;
        padding: 0 2px;
      }

      /* 悬浮提问主体卡片（双层结构：顶部 - / 会话恢复 / ⋮⋮ + 底部输入行） */
      .agy-notion-dock-card {
        pointer-events: auto;
        width: 100%;
        border-radius: 22px;
        background: rgba(255, 255, 255, 0.97);
        backdrop-filter: blur(18px);
        -webkit-backdrop-filter: blur(18px);
        border: 1px solid rgba(15, 23, 42, 0.08);
        box-shadow: 0 16px 40px -10px rgba(15, 23, 42, 0.16), 0 2px 8px rgba(15, 23, 42, 0.05);
        overflow: visible;
        position: relative;
        transition: box-shadow 0.18s ease, border-color 0.18s ease;
      }
      .agy-notion-dock-card:focus-within {
        border-color: rgba(15, 23, 42, 0.16);
        box-shadow: 0 20px 46px -10px rgba(15, 23, 42, 0.2);
      }
      body.theme-dark .agy-notion-dock-card,
      body.dark .agy-notion-dock-card {
        background: rgba(30, 31, 36, 0.96);
        border-color: rgba(255, 255, 255, 0.11);
        box-shadow: 0 18px 44px -10px rgba(0, 0, 0, 0.55);
      }

      .agy-notion-dock-header {
        height: 34px;
        padding: 0 12px;
        display: flex;
        align-items: center;
        justify-content: space-between;
        border-bottom: 1px solid rgba(15, 23, 42, 0.055);
        user-select: none;
        cursor: grab;
        position: relative;
      }
      .agy-notion-dock-header:active {
        cursor: grabbing;
      }
      body.theme-dark .agy-notion-dock-header,
      body.dark .agy-notion-dock-header {
        border-bottom-color: rgba(255, 255, 255, 0.08);
      }
      .agy-notion-dock-header-left {
        display: flex;
        align-items: center;
        gap: 4px;
        min-width: 0;
        flex: 1 1 0%;
      }
      .agy-notion-dock-min-btn,
      .agy-notion-dock-grip-btn {
        width: 24px;
        height: 24px;
        border: none;
        border-radius: 6px;
        background: transparent;
        color: #64748b;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        flex-shrink: 0;
      }
      .agy-notion-dock-min-btn:hover,
      .agy-notion-dock-grip-btn:hover {
        background: rgba(15, 23, 42, 0.06);
        color: #0f172a;
      }
      body.theme-dark .agy-notion-dock-min-btn:hover,
      body.dark .agy-notion-dock-min-btn:hover,
      body.theme-dark .agy-notion-dock-grip-btn:hover,
      body.dark .agy-notion-dock-grip-btn:hover {
        background: rgba(255, 255, 255, 0.09);
        color: #f8fafc;
      }
      .agy-notion-dock-resume-btn {
        display: none;
        align-items: center;
        gap: 5px;
        height: 24px;
        max-width: 280px;
        padding: 0 8px;
        border: none;
        border-radius: 6px;
        background: transparent;
        color: #334155;
        font-size: 12px;
        font-weight: 500;
        cursor: pointer;
        min-width: 0;
      }
      .agy-notion-dock-resume-btn.is-visible {
        display: inline-flex;
      }
      .agy-notion-dock-resume-btn:hover {
        background: rgba(15, 23, 42, 0.055);
        color: #0f172a;
      }
      body.theme-dark .agy-notion-dock-resume-btn,
      body.dark .agy-notion-dock-resume-btn {
        color: #cbd5e1;
      }

      .agy-notion-dock-grip-menu {
        position: absolute;
        right: 8px;
        bottom: calc(100% + 8px);
        min-width: 184px;
        border-radius: 12px;
        background: #ffffff;
        border: 1px solid rgba(15, 23, 42, 0.1);
        box-shadow: 0 14px 32px -8px rgba(15, 23, 42, 0.22);
        padding: 5px;
        display: none;
        z-index: 70;
      }
      .agy-notion-dock-grip-menu.is-open {
        display: block;
      }
      body.theme-dark .agy-notion-dock-grip-menu,
      body.dark .agy-notion-dock-grip-menu {
        background: #23242b;
        border-color: rgba(255, 255, 255, 0.12);
      }

      .agy-notion-composer-row {
        display: flex;
        align-items: flex-end;
        gap: 6px;
        padding: 8px 10px 9px 10px;
        position: relative;
      }
      .agy-notion-plus-wrap {
        position: relative;
        flex-shrink: 0;
      }
      .agy-notion-plus-btn {
        width: 32px;
        height: 32px;
        border-radius: 999px;
        border: none;
        background: transparent;
        color: #475569;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        transition: background-color 0.14s ease, color 0.14s ease;
      }
      .agy-notion-plus-btn:hover {
        background: rgba(15, 23, 42, 0.06);
        color: #0f172a;
      }
      body.theme-dark .agy-notion-plus-btn,
      body.dark .agy-notion-plus-btn {
        color: #cbd5e1;
      }
      body.theme-dark .agy-notion-plus-btn:hover,
      body.dark .agy-notion-plus-btn:hover {
        background: rgba(255, 255, 255, 0.09);
        color: #ffffff;
      }

      .agy-notion-quick-menu {
        position: absolute;
        left: 0;
        bottom: calc(100% + 10px);
        width: 240px;
        border-radius: 14px;
        background: #ffffff;
        border: 1px solid rgba(15, 23, 42, 0.1);
        box-shadow: 0 14px 32px -8px rgba(15, 23, 42, 0.22);
        padding: 6px;
        display: none;
        z-index: 60;
      }
      .agy-notion-quick-menu.is-open {
        display: block;
      }
      body.theme-dark .agy-notion-quick-menu,
      body.dark .agy-notion-quick-menu {
        background: #23242b;
        border-color: rgba(255, 255, 255, 0.12);
      }
      .agy-notion-quick-item {
        width: 100%;
        border: none;
        background: transparent;
        border-radius: 8px;
        padding: 8px 10px;
        text-align: left;
        font-size: 12.5px;
        color: #1e293b;
        cursor: pointer;
      }
      .agy-notion-quick-item:hover {
        background: rgba(15, 23, 42, 0.055);
      }
      body.theme-dark .agy-notion-quick-item,
      body.dark .agy-notion-quick-item {
        color: #e2e8f0;
      }
      body.theme-dark .agy-notion-quick-item:hover,
      body.dark .agy-notion-quick-item:hover {
        background: rgba(255, 255, 255, 0.08);
      }

      .agy-notion-input {
        flex: 1;
        min-width: 0;
        border: none;
        outline: none;
        resize: none;
        background: transparent;
        color: #0f172a;
        font-size: 14px;
        line-height: 22px;
        padding: 5px 4px;
        max-height: 96px;
        font-family: inherit;
      }
      .agy-notion-input::placeholder {
        color: #94a3b8;
      }
      body.theme-dark .agy-notion-input,
      body.dark .agy-notion-input {
        color: #f8fafc;
      }

      /* 模型选择按钮与上浮菜单 */
      .agy-notion-model-wrap {
        position: relative;
        flex-shrink: 0;
      }
      .agy-notion-model-btn {
        height: 30px;
        max-width: 144px;
        padding: 0 9px;
        border-radius: 999px;
        border: none;
        background: transparent;
        color: #64748b;
        font-size: 11.5px;
        display: inline-flex;
        align-items: center;
        gap: 4px;
        cursor: pointer;
      }
      .agy-notion-model-btn:hover {
        background: rgba(15, 23, 42, 0.055);
        color: #0f172a;
      }
      body.theme-dark .agy-notion-model-btn,
      body.dark .agy-notion-model-btn {
        color: #94a3b8;
      }
      body.theme-dark .agy-notion-model-btn:hover,
      body.dark .agy-notion-model-btn:hover {
        background: rgba(255, 255, 255, 0.08);
        color: #f8fafc;
      }
      .agy-notion-model-label {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .agy-notion-model-menu {
        position: absolute;
        right: 0;
        bottom: calc(100% + 10px);
        width: 280px;
        max-height: 320px;
        overflow-y: auto;
        border-radius: 14px;
        background: #ffffff;
        border: 1px solid rgba(15, 23, 42, 0.1);
        box-shadow: 0 14px 36px -8px rgba(15, 23, 42, 0.24);
        padding: 6px;
        display: none;
        z-index: 65;
      }
      .agy-notion-model-menu.is-open {
        display: block;
      }
      body.theme-dark .agy-notion-model-menu,
      body.dark .agy-notion-model-menu {
        background: #23242b;
        border-color: rgba(255, 255, 255, 0.12);
        color: #e2e8f0;
      }
      .agy-notion-model-group {
        padding: 6px 8px;
        border-radius: 8px;
        display: flex;
        flex-direction: column;
        gap: 6px;
      }
      .agy-notion-model-group-name {
        font-size: 12px;
        font-weight: 500;
        display: inline-flex;
        align-items: center;
        gap: 5px;
      }
      .agy-notion-model-efforts {
        display: flex;
        flex-wrap: wrap;
        gap: 4px;
      }
      .agy-notion-effort-pill {
        border: 1px solid rgba(15, 23, 42, 0.12);
        background: transparent;
        color: inherit;
        border-radius: 6px;
        padding: 2px 7px;
        font-size: 11px;
        cursor: pointer;
      }
      .agy-notion-effort-pill.is-selected {
        background: #0f172a;
        color: #ffffff;
        border-color: #0f172a;
      }
      body.theme-dark .agy-notion-effort-pill.is-selected,
      body.dark .agy-notion-effort-pill.is-selected {
        background: #f8fafc;
        color: #0f172a;
      }
      .agy-notion-model-row {
        width: 100%;
        border: none;
        background: transparent;
        color: inherit;
        border-radius: 8px;
        padding: 7px 8px;
        display: flex;
        align-items: center;
        justify-content: space-between;
        font-size: 12px;
        cursor: pointer;
        text-align: left;
      }
      .agy-notion-model-row:hover,
      .agy-notion-model-row.is-selected {
        background: rgba(15, 23, 42, 0.06);
      }
      body.theme-dark .agy-notion-model-row:hover,
      body.dark .agy-notion-model-row:hover,
      body.theme-dark .agy-notion-model-row.is-selected,
      body.dark .agy-notion-model-row.is-selected {
        background: rgba(255, 255, 255, 0.09);
      }

      .agy-notion-send-btn {
        width: 32px;
        height: 32px;
        border-radius: 999px;
        border: none;
        background: #18181b;
        color: #ffffff;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        flex-shrink: 0;
        transition: background-color 0.15s ease, opacity 0.15s ease, transform 0.12s ease;
      }
      .agy-notion-send-btn:active:not(:disabled) {
        transform: scale(0.95);
      }
      .agy-notion-send-btn:disabled {
        background: #9ca3af;
        opacity: 0.48;
        cursor: default;
      }
      body.theme-dark .agy-notion-send-btn:not(:disabled),
      body.dark .agy-notion-send-btn:not(:disabled) {
        background: #f8fafc;
        color: #0f172a;
      }

      /* 最小化收起后的右下角纯白圆形对话气泡按钮（复刻 Codex 截图） */
      .agy-notion-dock-restore {
        pointer-events: auto;
        position: absolute;
        right: 24px;
        bottom: 24px;
        width: 44px;
        height: 44px;
        padding: 0;
        border-radius: 50%;
        border: 1px solid rgba(15, 23, 42, 0.085);
        background: #ffffff;
        color: #4b5563;
        display: none;
        align-items: center;
        justify-content: center;
        box-shadow: 0 4px 14px rgba(15, 23, 42, 0.08), 0 1px 3px rgba(15, 23, 42, 0.04);
        cursor: pointer;
        z-index: 36;
        transition: transform 0.14s ease, box-shadow 0.14s ease, color 0.14s ease, border-color 0.14s ease;
      }
      .agy-notion-dock-restore:hover {
        color: #111827;
        border-color: rgba(15, 23, 42, 0.15);
        box-shadow: 0 8px 22px rgba(15, 23, 42, 0.12), 0 2px 5px rgba(15, 23, 42, 0.05);
        transform: translateY(-1px);
      }
      .agy-notion-dock-restore:active {
        transform: scale(0.96);
      }
      .agy-notion-dock-restore.is-visible {
        display: inline-flex;
      }
      body[data-agy-notion-layout="float"] .agy-notion-dock-restore,
      body[data-agy-notion-layout="split"] .agy-notion-dock-restore {
        display: none !important;
      }
      body.theme-dark .agy-notion-dock-restore,
      body.dark .agy-notion-dock-restore {
        background: #25262e;
        border-color: rgba(255, 255, 255, 0.13);
        color: #cbd5e1;
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45);
      }
      body.theme-dark .agy-notion-dock-restore:hover,
      body.dark .agy-notion-dock-restore:hover {
        color: #ffffff;
        border-color: rgba(255, 255, 255, 0.22);
      }

      /* 加载报错兜底条 */
      .agy-notion-error-banner {
        position: absolute;
        inset: 0;
        display: none;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 10px;
        background: rgba(255, 255, 255, 0.96);
        color: #334155;
        z-index: 25;
        padding: 24px;
        text-align: center;
      }
      body.theme-dark .agy-notion-error-banner,
      body.dark .agy-notion-error-banner {
        background: rgba(25, 25, 25, 0.96);
        color: #e2e8f0;
      }
      .agy-notion-error-banner.is-visible {
        display: flex;
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  // --- 全局深黑提示气泡（用于 ⋮⋮ 手柄悬停显示「拖动以移动 · 点击查看选项」） ---
  function ensureGripTooltip() {
    let tip = document.getElementById(GRIP_TOOLTIP_ID);
    if (!tip) {
      tip = document.createElement('div');
      tip.id = GRIP_TOOLTIP_ID;
      tip.setAttribute('data-code', 'true');
      tip.textContent = '拖动以移动 · 点击查看选项';
      document.body.appendChild(tip);
    }
    return tip;
  }

  function showGripTooltipAbove(anchorEl) {
    if (!anchorEl) return;
    const tip = ensureGripTooltip();
    const r = anchorEl.getBoundingClientRect();
    tip.style.left = `${Math.round(r.left + r.width / 2)}px`;
    tip.style.top = `${Math.max(36, Math.round(r.top - 8))}px`;
    tip.classList.add('is-visible');
  }

  function hideGripTooltip() {
    document.getElementById(GRIP_TOOLTIP_ID)?.classList.remove('is-visible');
  }

  function bindGripHoverTooltip(btnEl) {
    if (!btnEl) return;
    btnEl.addEventListener('pointerenter', () => showGripTooltipAbove(btnEl));
    btnEl.addEventListener('pointerleave', () => hideGripTooltip());
    btnEl.addEventListener('pointerdown', () => hideGripTooltip());
  }

  // --- 左侧边栏入口挂载 ---
  function findSidebarAnchorElement() {
    const cowartEl = document.getElementById('agy-cowart-nav-item');
    if (cowartEl && cowartEl.parentElement) return cowartEl;

    const navContainer = document.querySelector('[data-testid="sidebar-navigation-items"]');
    if (!navContainer) return null;
    const candidates = [...navContainer.querySelectorAll('a, button')].filter((el) => el.id !== NAV_ID);
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

  function resolveSidebarNavClass(anchorEl) {
    const navContainer = anchorEl?.parentElement;
    const sibling = navContainer
      ? [...navContainer.querySelectorAll('a, button')].find(
          (el) =>
            el.id !== NAV_ID &&
            el.id !== 'agy-cowart-nav-item' &&
            (el.getAttribute('href') === '/customizations' || (el.className || '').includes('agy-button'))
        )
      : null;
    const raw = String(sibling?.className || anchorEl?.className || '').trim();
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
    const anchorEl = findSidebarAnchorElement();
    if (!anchorEl || !anchorEl.parentElement) return null;

    let navItem = document.getElementById(NAV_ID);
    const targetClass = resolveSidebarNavClass(anchorEl);
    if (!navItem) {
      navItem = document.createElement('button');
      navItem.type = 'button';
      navItem.id = NAV_ID;
      navItem.className = targetClass;
      navItem.setAttribute('data-testid', 'sidebar-notion-button');
      navItem.setAttribute('data-code', 'true');
      navItem.innerHTML = `<span class="shrink-0 flex items-center">${NOTION_NAV_SVG}</span><span class="truncate">Notion</span>`;
      navItem.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        void openNotionView();
      });
    } else if (navItem.className !== targetClass) {
      navItem.className = targetClass;
    }

    if (anchorEl.nextElementSibling !== navItem) {
      anchorEl.insertAdjacentElement('afterend', navItem);
    }
    navItem.setAttribute('data-active', state.active ? 'true' : 'false');
    return navItem;
  }

  function findMainWorkspaceNodes() {
    const body = document.querySelector('[data-main-content-body]');
    if (!body) return null;

    let mainCol = body.parentElement;
    while (mainCol && mainCol.parentElement) {
      const parent = mainCol.parentElement;
      const cls = String(parent.className || '');
      if (parent.classList?.contains('agy-sheet') || cls.includes('flex-row') || parent.children.length >= 1) {
        if (
          parent.matches?.('.agy-sheet[data-sheet-inset]') ||
          parent.closest?.('.agy-sheet[data-sheet-inset]')
        ) {
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

  // --- 提取当前对话标题（实时同步原生会话标题与最新提问摘要） ---
  function extractLiveConversationTitle() {
    if (isBlankNewConversationView()) {
      return '新对话';
    }

    const ignored = new Set([
      '/',
      '•',
      '·',
      '⋮',
      'more_vert',
      'more_horiz',
      'dock_to_left',
      'dock_to_right',
      'open_in_full',
      'close_fullscreen',
      'share',
      'ios_share',
      'add',
      'close',
      'notion',
      String(state.notionProject?.name || 'Notion').toLowerCase(),
      ...(state.notionProject?.knownProjectNames || []).map((n) => String(n).toLowerCase()),
    ]);

    // 1. 优先匹配侧栏中当前路由对应的活跃会话项标题
    const curPath = window.location.pathname || '';
    if (curPath.startsWith('/c/')) {
      const sideLink = document.querySelector(`a[href="${curPath}"]`);
      const sideText = (sideLink?.innerText || sideLink?.textContent || '').trim().split(/\r?\n/)[0]?.trim();
      if (sideText && !ignored.has(sideText.toLowerCase())) {
        return sideText;
      }
    }

    // 2. 从隐藏保活的原生对话顶栏 [data-main-content-header] 读取标题段
    const header = document.querySelector('.agy-notion-main-col [data-main-content-header]');
    if (header) {
      const candidates = [...header.querySelectorAll('span, div, h1, h2, a, button')];
      const parts = [];
      for (const el of candidates) {
        if (el.children.length > 0) continue;
        if (el.classList?.contains('google-symbols') || el.classList?.contains('material-icons')) continue;
        const txt = (el.textContent || '').trim();
        if (!txt || txt.length < 2) continue;
        if (ignored.has(txt.toLowerCase())) continue;
        parts.push(txt);
      }
      if (parts.length > 0) {
        return parts[parts.length - 1];
      }
    }

    // 3. 兜底使用本轮最新提问摘要
    if (state.lastSubmittedPrompt) {
      const shortPrompt = state.lastSubmittedPrompt.replace(/\s+/g, ' ').trim();
      return shortPrompt.length > 18 ? `${shortPrompt.slice(0, 18)}…` : shortPrompt;
    }

    return state.currentPage?.title ? `关于「${state.currentPage.title}」` : 'Notion 对话';
  }

  // --- 计算悬浮对话小窗水平基准中心与防溢出偏移 ---
  function clampOffsetForLayout(offset, targetLayout) {
    const stage = document.getElementById(STAGE_ID);
    const stageRect = stage?.getBoundingClientRect();
    const vw = window.innerWidth || 1280;
    const vh = window.innerHeight || 800;

    if (targetLayout === 'float') {
      const cardW = Math.min(state.floatSize?.width || 440, vw - 28);
      const cardH = Math.min(state.floatSize?.height || 560, vh - 28);
      const cx = stageRect && stageRect.width > 0 ? stageRect.left + stageRect.width / 2 : vw * 0.52;
      const minX = 12 + cardW / 2 - cx;
      const maxX = vw - 12 - cardW / 2 - cx;
      const maxY = 10;
      const minY = Math.min(maxY, -(vh - cardH - 30));
      const clampedX = Math.min(Math.max(minX, maxX), Math.max(Math.min(minX, maxX), offset.x));
      const clampedY = Math.min(maxY, Math.max(minY, offset.y));
      return {
        x: Math.round(clampedX * 2) / 2,
        y: Math.round(clampedY),
      };
    }

    const halfRange = stageRect && stageRect.width > 0 ? Math.max(80, stageRect.width / 2 - 220) : 280;
    const minY = -(vh - 160);
    return {
      x: Math.round(Math.min(halfRange, Math.max(-halfRange, offset.x))),
      y: Math.round(Math.min(10, Math.max(minY, offset.y))),
    };
  }

  function syncFloatGeometry() {
    if (!state.active) return;
    const stage = document.getElementById(STAGE_ID);
    const rect = stage?.getBoundingClientRect();
    if (rect && rect.width > 0) {
      const cx = Math.round(rect.left + rect.width / 2);
      document.body.style.setProperty('--agy-stage-cx', `${cx}px`);
    }
    document.body.style.setProperty('--agy-float-w', `${state.floatSize.width}px`);
    document.body.style.setProperty('--agy-float-h', `${state.floatSize.height}px`);

    const clamped = clampOffsetForLayout(state.dockOffset, state.layout === 'float' ? 'float' : 'dock');
    state.dockOffset = clamped;
    document.body.style.setProperty('--agy-dock-x', `${clamped.x}px`);
    document.body.style.setProperty('--agy-dock-y', `${clamped.y}px`);

    const dock = stage?.querySelector('[data-role="floating-dock"]');
    if (dock) {
      dock.style.setProperty('--dock-x', `${clamped.x}px`);
      dock.style.setProperty('--dock-y', `${clamped.y}px`);
    }
  }

  function resetDockOffset() {
    state.dockOffset = { x: 0, y: 0 };
    syncFloatGeometry();
  }

  function resetFloatWindowGeometry() {
    state.floatSize = { ...DEFAULT_FLOAT_SIZE };
    state.dockOffset = { x: 0, y: 0 };
    try {
      localStorage.removeItem(STORAGE_FLOAT_SIZE);
    } catch {}
    syncFloatGeometry();
    window.dispatchEvent(new Event('resize'));
  }

  // --- 悬浮对话小窗八向自由缩放绑定（对边精准固定锚点，零偏移抖动） ---
  function ensureFloatResizersMounted(mainCol) {
    if (!mainCol) return null;
    let wrap = document.getElementById(FLOAT_RESIZERS_ID);
    if (!wrap) {
      wrap = document.createElement('div');
      wrap.id = FLOAT_RESIZERS_ID;
      wrap.className = 'no-focus-agent-input';
      wrap.setAttribute('data-code', 'true');
      wrap.innerHTML = ['n', 's', 'e', 'w', 'nw', 'ne', 'sw', 'se']
        .map((dir) => `<div class="agy-notion-fresize" data-dir="${dir}"></div>`)
        .join('');
      bindFloatResizeEvents(wrap);
    }
    if (wrap.parentElement !== mainCol) {
      mainCol.appendChild(wrap);
    }
    return wrap;
  }

  function bindFloatResizeEvents(wrap) {
    wrap.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || state.layout !== 'float') return;
      const handle = e.target.closest('.agy-notion-fresize');
      if (!handle) return;
      const dir = handle.getAttribute('data-dir') || '';
      if (!dir) return;

      const mainCol = document.querySelector('.agy-notion-main-col');
      if (!mainCol) return;

      e.preventDefault();
      e.stopPropagation();
      closeAllPopovers();

      const startRect = mainCol.getBoundingClientRect();
      const startW = startRect.width;
      const startH = startRect.height;
      const startLeft = startRect.left;
      const startRight = startRect.right;
      const startTop = startRect.top;
      const startBottom = startRect.bottom;
      const startClientX = e.clientX;
      const startClientY = e.clientY;

      const vw = window.innerWidth || 1280;
      const vh = window.innerHeight || 800;
      const stageRect = document.getElementById(STAGE_ID)?.getBoundingClientRect();
      const stageCx =
        stageRect && stageRect.width > 0 ? Math.round(stageRect.left + stageRect.width / 2) : Math.round(vw * 0.52);
      document.body.style.setProperty('--agy-stage-cx', `${stageCx}px`);

      const origX = startLeft + startW / 2 - stageCx;
      const origY = 18 - (vh - startBottom);

      document.body.classList.add('agy-notion-dragging');

      const onMove = (ev) => {
        const dx = ev.clientX - startClientX;
        const dy = ev.clientY - startClientY;

        let nextW = startW;
        let nextH = startH;

        if (dir.includes('e')) {
          const maxAllowedW = Math.min(960, vw - 12 - startLeft);
          nextW = Math.max(340, Math.min(maxAllowedW, startW + dx));
        } else if (dir.includes('w')) {
          const maxAllowedW = Math.min(960, startRight - 12);
          nextW = Math.max(340, Math.min(maxAllowedW, startW - dx));
        }

        if (dir.includes('n')) {
          const maxAllowedH = Math.min(920, startBottom - 12);
          nextH = Math.max(300, Math.min(maxAllowedH, startH - dy));
        } else if (dir.includes('s')) {
          const maxAllowedH = Math.min(920, vh - 8 - startTop);
          nextH = Math.max(300, Math.min(maxAllowedH, startH + dy));
        }

        const roundedW = Math.round(nextW);
        const roundedH = Math.round(nextH);
        const appliedDW = roundedW - startW;
        const appliedDH = roundedH - startH;

        let nextX = origX;
        let nextY = origY;
        if (dir.includes('e')) nextX = origX + appliedDW / 2;
        else if (dir.includes('w')) nextX = origX - appliedDW / 2;
        if (dir.includes('s')) nextY = origY + appliedDH;

        state.floatSize = { width: roundedW, height: roundedH };
        state.dockOffset = { x: Math.round(nextX * 2) / 2, y: Math.round(nextY) };

        document.body.style.setProperty('--agy-float-w', `${roundedW}px`);
        document.body.style.setProperty('--agy-float-h', `${roundedH}px`);
        document.body.style.setProperty('--agy-dock-x', `${state.dockOffset.x}px`);
        document.body.style.setProperty('--agy-dock-y', `${state.dockOffset.y}px`);
      };

      const onUp = () => {
        document.body.classList.remove('agy-notion-dragging');
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        try {
          localStorage.setItem(STORAGE_FLOAT_SIZE, JSON.stringify(state.floatSize));
        } catch {}
        window.dispatchEvent(new Event('resize'));
      };

      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    });
  }

  // --- 拖拽绑定工具（同时区分点击与拖动，兼容 dock 与 float 顶条） ---
  function bindDraggableBar(barEl, options = {}) {
    if (!barEl) return;
    const { ignoreSelector = '', onClickWithoutDrag = null } = options;

    barEl.addEventListener('dblclick', (e) => {
      if (ignoreSelector && e.target.closest(ignoreSelector)) return;
      resetDockOffset();
    });

    barEl.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      if (ignoreSelector && e.target.closest(ignoreSelector)) return;

      const clickedGripBtn = e.target.closest('[data-role="grip-trigger"]');
      e.preventDefault();
      hideGripTooltip();

      const startX = e.clientX;
      const startY = e.clientY;
      const origX = state.dockOffset.x;
      const origY = state.dockOffset.y;
      let moved = false;

      document.body.classList.add('agy-notion-dragging');

      const onMove = (ev) => {
        const dx = ev.clientX - startX;
        const dy = ev.clientY - startY;
        if (!moved && Math.hypot(dx, dy) >= 4) {
          moved = true;
          closeAllPopovers();
        }
        if (!moved) return;

        state.dockOffset = clampOffsetForLayout(
          { x: origX + dx, y: origY + dy },
          state.layout === 'float' ? 'float' : 'dock'
        );
        document.body.style.setProperty('--agy-dock-x', `${state.dockOffset.x}px`);
        document.body.style.setProperty('--agy-dock-y', `${state.dockOffset.y}px`);
        const dock = document.getElementById(STAGE_ID)?.querySelector('[data-role="floating-dock"]');
        if (dock) {
          dock.style.setProperty('--dock-x', `${state.dockOffset.x}px`);
          dock.style.setProperty('--dock-y', `${state.dockOffset.y}px`);
        }
      };

      const onUp = (ev) => {
        document.body.classList.remove('agy-notion-dragging');
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        if (!moved && clickedGripBtn && typeof onClickWithoutDrag === 'function') {
          onClickWithoutDrag(ev, clickedGripBtn);
        }
      };

      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    });
  }

  // --- 构建并挂载对话窗口顶栏 #agy-notion-chat-chrome ---
  function ensureChatChromeMounted(mainCol) {
    if (!mainCol) return null;
    let chrome = document.getElementById(CHROME_ID);
    if (!chrome) {
      chrome = document.createElement('div');
      chrome.id = CHROME_ID;
      chrome.className = 'no-focus-agent-input';
      chrome.setAttribute('data-code', 'true');
      chrome.innerHTML = `
        <!-- 形态 B：Float 悬浮对话小窗顶栏（复刻 Codex 图 2） -->
        <div class="agy-notion-chrome-float-bar" data-role="chrome-float-bar">
          <div class="agy-notion-float-left">
            <button type="button" class="agy-notion-chrome-icon-btn" data-role="float-min-btn" title="收起为底部提问条">
              ${MINUS_SVG}
            </button>
            <button type="button" class="agy-notion-float-title-btn" data-role="float-title-btn" title="会话操作">
              ${BUBBLE_ICON_SVG}
              <span class="agy-notion-title-ellipsis" data-role="float-title-text">新对话</span>
              ${CHEVRON_DOWN_SVG}
            </button>
          </div>
          <button type="button" class="agy-notion-chrome-icon-btn" data-role="grip-trigger" aria-label="拖动以移动或点击查看选项">
            ${GRIP_DOTS_SVG}
          </button>
        </div>

        <!-- 形态 C：Split 右侧停靠分栏顶栏（多标签并列胶囊栏 + 「＋」添加左侧会话 + 切悬浮窗 + 收起） -->
        <div class="agy-notion-chrome-split-bar" data-role="chrome-split-bar">
          <div class="agy-notion-split-tabs">
            <div class="agy-notion-tab-scroll" data-role="split-tab-strip"></div>
            <button type="button" class="agy-notion-chrome-icon-btn" data-role="split-new-btn" title="新建对话或从左侧选择添加会话">
              ${PLUS_SVG}
            </button>
          </div>
          <div class="agy-notion-split-actions">
            <button type="button" class="agy-notion-chrome-icon-btn" data-role="split-to-float-btn" title="切换为悬浮对话小窗">
              ${UNDOCK_FLOAT_SVG}
            </button>
            <button type="button" class="agy-notion-chrome-icon-btn" data-role="split-collapse-btn" title="收起对话栏">
              ${SIDEBAR_PANE_SVG}
            </button>
          </div>
        </div>

        <!-- 「＋」选择添加左侧会话 / 新建对话浮层面板 -->
        <div class="agy-notion-convo-picker" data-role="convo-picker">
          <input type="text" class="agy-notion-picker-search" data-role="picker-search" placeholder="搜索置顶对话或历史会话..." autocomplete="off" />
          <div class="agy-notion-picker-list" data-role="picker-list"></div>
        </div>

        <!-- Float 顶栏弹出菜单 -->
        <div class="agy-notion-chrome-menu" data-role="chrome-menu"></div>

        <!-- 笔记划选片段快捷带入条 -->
        <div class="agy-notion-chrome-quote" data-role="chrome-quote-bar">
          <span style="color:#2383e2;font-weight:600;flex-shrink:0;">引用</span>
          <span class="agy-notion-chrome-quote-text" data-role="chrome-quote-text"></span>
          <button type="button" class="agy-notion-chrome-quote-insert" data-role="chrome-quote-insert">带入输入</button>
          <button type="button" class="agy-notion-quote-clear" data-role="chrome-quote-clear" title="清除引用">×</button>
        </div>
      `;
      bindChatChromeEvents(chrome);
    }

    if (mainCol.firstElementChild !== chrome) {
      mainCol.insertBefore(chrome, mainCol.firstChild);
    }
    ensureFloatResizersMounted(mainCol);
    return chrome;
  }

  // --- 多标签页状态管理与「＋」左侧会话选择浮层 ---
  function persistOpenTabs() {
    try {
      localStorage.setItem(STORAGE_OPEN_TABS, JSON.stringify(state.openTabs.slice(0, 20)));
      if (state.activeTabKey) {
        localStorage.setItem(STORAGE_ACTIVE_TAB, state.activeTabKey);
      } else {
        localStorage.removeItem(STORAGE_ACTIVE_TAB);
      }
    } catch {}
  }

  function isGenericConvoTitle(t) {
    const s = String(t || '').trim();
    return !s || s === '新对话' || s === 'Notion 对话' || s === '继续对话' || s === '继续 Notion 对话';
  }

  function upsertOpenTab(tabInfo, makeActive = true) {
    if (!tabInfo || !tabInfo.key) return;
    const { key, path, title, pinned = false } = tabInfo;

    if (key !== DRAFT_TAB_KEY) {
      const existing = state.openTabs.find((t) => t.key === key);
      if (existing) {
        if (title && (!isGenericConvoTitle(title) || isGenericConvoTitle(existing.title))) {
          existing.title = title;
        }
        if (pinned) existing.pinned = true;
      } else {
        // 若当前激活的是空白新对话草稿标签，升级该草稿标签为刚落地的真实会话标签
        const draftIdx = state.openTabs.findIndex((t) => t.key === DRAFT_TAB_KEY);
        if (draftIdx !== -1 && state.activeTabKey === DRAFT_TAB_KEY) {
          state.openTabs[draftIdx] = {
            key,
            path: path || key,
            title: title || '新对话',
            pinned: Boolean(pinned),
          };
        } else {
          state.openTabs.push({
            key,
            path: path || key,
            title: title || '会话',
            pinned: Boolean(pinned),
          });
        }
      }
    } else {
      const draft = state.openTabs.find((t) => t.key === DRAFT_TAB_KEY);
      if (!draft) {
        state.openTabs.push({ key: DRAFT_TAB_KEY, path: '/', title: '新对话', pinned: false });
      }
    }

    if (makeActive) {
      state.activeTabKey = key;
    }
    persistOpenTabs();
  }

  async function selectConversationIntoPane(item, targetMode = state.layout) {
    if (!item || !isValidConvoPath(item.path)) return;
    const mode = targetMode === 'float' ? 'float' : 'split';
    upsertOpenTab(
      {
        key: item.path,
        path: item.path,
        title: item.title || '会话',
        pinned: Boolean(item.pinned),
      },
      true
    );
    closeConvoPicker();
    renderChromeDropdownMenu('');
    if (state.layout !== mode) {
      setNotionLayout(mode);
    }
    recordActiveNotionConvo(item.path, state.currentPage?.id || '');
    await navigateToSavedNotionConvo(item.path);
    syncChatChromeUI();
    setTimeout(() => findMainComposerEditor()?.focus(), 80);
  }

  async function removeOpenTabByKey(tabKey) {
    const idx = state.openTabs.findIndex((t) => t.key === tabKey);
    if (idx === -1) return;
    const wasActive = state.activeTabKey === tabKey;
    state.openTabs.splice(idx, 1);

    if (tabKey !== DRAFT_TAB_KEY) {
      for (const [pid, cPath] of Object.entries(state.pageConvoMap)) {
        if (cPath === tabKey) delete state.pageConvoMap[pid];
      }
      try {
        localStorage.setItem(STORAGE_PAGE_CONVOS, JSON.stringify(state.pageConvoMap));
      } catch {}

      if (state.lastNotionConvoPath === tabKey) {
        const fallbackSaved = [...state.openTabs].reverse().find((t) => isValidConvoPath(t.path));
        state.lastNotionConvoPath = fallbackSaved ? fallbackSaved.path : '';
        try {
          if (state.lastNotionConvoPath) {
            localStorage.setItem(STORAGE_LAST_NOTION_CONVO, state.lastNotionConvoPath);
          } else {
            localStorage.removeItem(STORAGE_LAST_NOTION_CONVO);
          }
        } catch {}
      }
    }

    if (wasActive) {
      if (state.openTabs.length > 0) {
        const nextTab = state.openTabs[Math.min(idx, state.openTabs.length - 1)];
        state.activeTabKey = nextTab.key;
        persistOpenTabs();
        if (nextTab.key === DRAFT_TAB_KEY) {
          await startNewNotionConversation(state.layout, { keepExistingDraft: true });
        } else {
          await selectConversationIntoPane(nextTab, state.layout);
        }
        return;
      }
      persistOpenTabs();
      await startNewNotionConversation(state.layout, { clearCurrentBinding: true });
      return;
    }

    persistOpenTabs();
    syncChatChromeUI();
  }

  function closeConvoPicker() {
    state.convoPickerOpen = false;
    const chrome = document.getElementById(CHROME_ID);
    chrome?.querySelector('[data-role="convo-picker"]')?.classList.remove('is-open');
  }

  function collectDomFallbackConversations() {
    const out = [];
    const seen = new Set();
    for (const a of document.querySelectorAll('a[href^="/c/"]')) {
      const href = a.getAttribute('href') || '';
      if (!isValidConvoPath(href) || seen.has(href)) continue;
      seen.add(href);
      const title = (a.innerText || a.textContent || '').trim().split(/\r?\n/)[0]?.trim();
      if (!title) continue;
      out.push({
        id: href.slice(3),
        path: href,
        title,
        projectName: '',
        pinned: false,
      });
    }
    return out;
  }

  async function refreshConvoCatalog() {
    try {
      const resp = await fetch(`${STAGE_BASE}/api/conversations?limit=80`, { cache: 'no-store' });
      const data = await resp.json();
      if (data && data.ok) {
        const pinned = Array.isArray(data.pinned) ? data.pinned : [];
        const recent = Array.isArray(data.recent) ? data.recent : [];
        const knownPaths = new Set([...pinned, ...recent].map((c) => c.path));
        for (const domItem of collectDomFallbackConversations()) {
          if (!knownPaths.has(domItem.path)) {
            recent.unshift(domItem);
            knownPaths.add(domItem.path);
          }
        }
        state.convoCatalog = { pinned, recent, loadedAt: Date.now() };
        if (state.convoPickerOpen) renderConvoPickerList();
        return;
      }
    } catch {}
    state.convoCatalog = { pinned: [], recent: collectDomFallbackConversations(), loadedAt: Date.now() };
    if (state.convoPickerOpen) renderConvoPickerList();
  }

  function renderConvoPickerList() {
    const chrome = document.getElementById(CHROME_ID);
    const listEl = chrome?.querySelector('[data-role="picker-list"]');
    if (!listEl) return;

    const kw = String(state.convoPickerFilter || '').trim().toLowerCase();
    const openKeySet = new Set(state.openTabs.map((t) => t.key));
    const matchFn = (item) => {
      if (!kw) return true;
      return `${item.title || ''}\n${item.projectName || ''}`.toLowerCase().includes(kw);
    };

    const pinnedList = (state.convoCatalog.pinned || []).filter(matchFn);
    const recentList = (state.convoCatalog.recent || []).filter(matchFn);

    listEl.innerHTML = '';

    // 首行固定：新建空白对话（专属 Notion 项目）
    const newRow = document.createElement('button');
    newRow.type = 'button';
    newRow.className = 'agy-notion-picker-row is-new';
    newRow.innerHTML = `<span class="agy-notion-picker-title">＋ 新建空白对话（Notion 项目）</span>`;
    newRow.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      closeConvoPicker();
      void startNewNotionConversation(state.layout === 'float' ? 'float' : 'split');
    });
    listEl.appendChild(newRow);

    // Float 模式下额外展示已打开的标签页便于切换
    if (state.layout === 'float' && state.openTabs.length > 1 && !kw) {
      const sec = document.createElement('div');
      sec.className = 'agy-notion-picker-section';
      sec.textContent = '已添加的标签页';
      listEl.appendChild(sec);
      for (const tab of state.openTabs) {
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'agy-notion-picker-row';
        const isCur = tab.key === state.activeTabKey;
        row.innerHTML = `
          <span class="agy-notion-picker-title">${isCur ? '● ' : ''}${escapeHtml(tab.title)}</span>
          <span class="agy-notion-picker-meta">${isCur ? '当前' : '切换'}</span>
        `;
        row.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          closeConvoPicker();
          if (tab.key === DRAFT_TAB_KEY) {
            void startNewNotionConversation('float', { keepExistingDraft: true });
          } else {
            void selectConversationIntoPane(tab, 'float');
          }
        });
        listEl.appendChild(row);
      }
    }

    const appendGroup = (headerText, arr, isPinGroup = false) => {
      if (!arr.length) return;
      const sec = document.createElement('div');
      sec.className = 'agy-notion-picker-section';
      sec.textContent = headerText;
      listEl.appendChild(sec);

      for (const item of arr) {
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'agy-notion-picker-row';
        const added = openKeySet.has(item.path);
        const badgeText = added ? '已添加 ✓' : item.projectName || '';
        row.innerHTML = `
          <span class="agy-notion-picker-title">${isPinGroup ? '📌 ' : ''}${escapeHtml(item.title)}</span>
          ${badgeText ? `<span class="agy-notion-picker-meta">${escapeHtml(badgeText)}</span>` : ''}
        `;
        row.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          void selectConversationIntoPane(item, state.layout === 'float' ? 'float' : 'split');
        });
        listEl.appendChild(row);
      }
    };

    appendGroup('置顶对话', pinnedList, true);
    appendGroup('最近会话', recentList, false);

    if (!pinnedList.length && !recentList.length) {
      const empty = document.createElement('div');
      empty.style.cssText = 'padding:14px 10px;text-align:center;font-size:12px;color:#94a3b8;';
      empty.textContent = state.convoCatalog.loadedAt ? '未找到匹配的会话' : '正在加载左侧会话列表...';
      listEl.appendChild(empty);
    }
  }

  function toggleConvoPicker(anchorLeftPx = 10) {
    const chrome = document.getElementById(CHROME_ID);
    const picker = chrome?.querySelector('[data-role="convo-picker"]');
    const searchInput = chrome?.querySelector('[data-role="picker-search"]');
    if (!picker) return;

    if (state.convoPickerOpen) {
      closeConvoPicker();
      return;
    }

    renderChromeDropdownMenu('');
    state.convoPickerOpen = true;
    state.convoPickerFilter = '';
    if (searchInput) searchInput.value = '';
    picker.style.left = `${Math.max(8, Math.min(anchorLeftPx, 120))}px`;
    picker.classList.add('is-open');
    renderConvoPickerList();
    void refreshConvoCatalog();
    setTimeout(() => searchInput?.focus(), 30);
  }

  function renderChromeDropdownMenu(mode) {
    const chrome = document.getElementById(CHROME_ID);
    const menu = chrome?.querySelector('[data-role="chrome-menu"]');
    if (!menu) return;

    if (!mode || state.chromeMenuMode === mode) {
      state.chromeMenuMode = '';
      menu.classList.remove('is-open', 'align-left', 'align-right');
      return;
    }

    closeConvoPicker();
    state.chromeMenuMode = mode;
    menu.classList.remove('align-left', 'align-right');
    menu.classList.add(mode === 'title' ? 'align-left' : 'align-right');

    const items =
      mode === 'title'
        ? [
            { label: '＋ 添加左侧会话 / 新建对话', action: () => toggleConvoPicker(12) },
            { label: '◫ 停靠到右侧分栏', action: () => setNotionLayout('split') },
            { label: '↻ 刷新左侧当前笔记', action: () => sendRefreshToIframe() },
          ]
        : [
            { label: '◫ 停靠到右侧分栏', action: () => setNotionLayout('split') },
            { label: '＋ 添加左侧会话 / 新建对话', action: () => toggleConvoPicker(12) },
            { label: '↺ 重置位置与默认大小', action: () => resetFloatWindowGeometry() },
            {
              label: '－ 最小化收起',
              action: () => {
                state.dockMinimized = true;
                state.homeDockExpanded = false;
                setNotionLayout('dock');
              },
            },
          ];

    menu.innerHTML = '';
    for (const item of items) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'agy-notion-menu-item';
      btn.textContent = item.label;
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        renderChromeDropdownMenu('');
        item.action();
      });
      menu.appendChild(btn);
    }
    menu.classList.add('is-open');
  }

  function bindChatChromeEvents(chrome) {
    const floatBar = chrome.querySelector('[data-role="chrome-float-bar"]');
    const floatMinBtn = chrome.querySelector('[data-role="float-min-btn"]');
    const floatTitleBtn = chrome.querySelector('[data-role="float-title-btn"]');
    const floatGripBtn = floatBar?.querySelector('[data-role="grip-trigger"]');

    const splitTabStrip = chrome.querySelector('[data-role="split-tab-strip"]');
    const splitNewBtn = chrome.querySelector('[data-role="split-new-btn"]');
    const splitToFloatBtn = chrome.querySelector('[data-role="split-to-float-btn"]');
    const splitCollapseBtn = chrome.querySelector('[data-role="split-collapse-btn"]');
    const pickerEl = chrome.querySelector('[data-role="convo-picker"]');
    const pickerSearch = chrome.querySelector('[data-role="picker-search"]');

    const quoteInsertBtn = chrome.querySelector('[data-role="chrome-quote-insert"]');
    const quoteClearBtn = chrome.querySelector('[data-role="chrome-quote-clear"]');

    bindGripHoverTooltip(floatGripBtn);

    bindDraggableBar(floatBar, {
      ignoreSelector: '[data-role="float-min-btn"], [data-role="float-title-btn"]',
      onClickWithoutDrag: () => {
        renderChromeDropdownMenu('grip');
      },
    });

    splitTabStrip?.addEventListener(
      'wheel',
      (e) => {
        if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
          e.preventDefault();
          splitTabStrip.scrollLeft += e.deltaY;
        }
      },
      { passive: false }
    );

    splitTabStrip?.addEventListener('click', (e) => {
      const closeBtn = e.target.closest('[data-close-tab]');
      if (closeBtn) {
        e.preventDefault();
        e.stopPropagation();
        const key = closeBtn.getAttribute('data-close-tab');
        if (key) void removeOpenTabByKey(key);
        return;
      }
      const tabEl = e.target.closest('[data-tab-key]');
      if (tabEl) {
        e.preventDefault();
        e.stopPropagation();
        const key = tabEl.getAttribute('data-tab-key');
        const hit = state.openTabs.find((t) => t.key === key);
        if (!hit) return;
        if (hit.key === DRAFT_TAB_KEY) {
          state.activeTabKey = DRAFT_TAB_KEY;
          persistOpenTabs();
          void startNewNotionConversation('split', { keepExistingDraft: true });
        } else {
          void selectConversationIntoPane(hit, 'split');
        }
      }
    });

    pickerEl?.addEventListener('pointerdown', (e) => e.stopPropagation());
    pickerSearch?.addEventListener('input', () => {
      state.convoPickerFilter = pickerSearch.value || '';
      renderConvoPickerList();
    });
    pickerSearch?.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        closeConvoPicker();
      }
    });

    floatMinBtn?.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      state.dockMinimized = true;
      state.homeDockExpanded = false;
      closeAllPopovers();
      setNotionLayout('dock');
    });

    floatTitleBtn?.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      toggleConvoPicker(12);
    });

    splitNewBtn?.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const chromeRect = chrome.getBoundingClientRect();
      const btnRect = splitNewBtn.getBoundingClientRect();
      const relLeft = Math.max(8, Math.round(btnRect.left - chromeRect.left - 40));
      toggleConvoPicker(relLeft);
    });

    splitToFloatBtn?.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      setNotionLayout('float');
    });

    splitCollapseBtn?.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      setNotionLayout('dock');
    });

    quoteClearBtn?.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      state.selectedQuote = '';
      updateDockUI();
      syncChatChromeUI();
    });

    quoteInsertBtn?.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!state.selectedQuote) return;
      const editor = findMainComposerEditor() || (await ensureFreshNewConversationEditor(2500));
      if (!editor) return;
      const quoteBlock = `> ${state.selectedQuote.replace(/\n/g, '\n> ')}\n\n`;
      await writeTextIntoEditor(editor, quoteBlock);
      state.selectedQuote = '';
      updateDockUI();
      syncChatChromeUI();
      editor.focus();
    });
  }

  function syncChatChromeUI() {
    const chrome = document.getElementById(CHROME_ID);
    if (!chrome) return;

    const curPath = window.location.pathname || '';
    const title = extractLiveConversationTitle();
    state.liveConvoTitle = title;

    if (state.active && state.notionConvoTrackingArmed && isValidConvoPath(curPath)) {
      upsertOpenTab({ key: curPath, path: curPath, title }, true);
    } else if (state.active && isBlankNewConversationView()) {
      if (state.openTabs.length === 0 || state.activeTabKey === DRAFT_TAB_KEY || !state.activeTabKey) {
        upsertOpenTab({ key: DRAFT_TAB_KEY, path: '/', title: '新对话' }, true);
      }
    } else if (state.openTabs.length === 0) {
      upsertOpenTab({ key: DRAFT_TAB_KEY, path: '/', title: '新对话' }, true);
    }

    if (!state.activeTabKey && state.openTabs.length > 0) {
      state.activeTabKey = state.openTabs[state.openTabs.length - 1].key;
    }

    const activeTab = state.openTabs.find((t) => t.key === state.activeTabKey);
    const displayTitle = activeTab?.title && !isGenericConvoTitle(activeTab.title) ? activeTab.title : title;

    const floatTitleEl = chrome.querySelector('[data-role="float-title-text"]');
    if (floatTitleEl) floatTitleEl.textContent = displayTitle;

    const splitTabStrip = chrome.querySelector('[data-role="split-tab-strip"]');
    if (splitTabStrip) {
      const sig = JSON.stringify({
        active: state.activeTabKey,
        tabs: state.openTabs.map((t) => [t.key, t.title]),
      });
      if (sig !== lastRenderedTabsSig) {
        lastRenderedTabsSig = sig;
        splitTabStrip.innerHTML = state.openTabs
          .map((t) => {
            const isAct = t.key === state.activeTabKey;
            return `
              <div class="agy-notion-split-tab ${isAct ? 'is-active' : ''}" data-tab-key="${escapeHtml(t.key)}" title="${escapeHtml(t.title)}">
                ${BUBBLE_ICON_SVG}
                <span class="agy-notion-title-ellipsis">${escapeHtml(t.title)}</span>
                <button type="button" class="agy-notion-tab-close" data-close-tab="${escapeHtml(t.key)}" title="从右侧栏移除此会话标签">×</button>
              </div>
            `;
          })
          .join('');
      }
    }

    const quoteBar = chrome.querySelector('[data-role="chrome-quote-bar"]');
    const quoteText = chrome.querySelector('[data-role="chrome-quote-text"]');
    const showQuoteInChrome = Boolean(
      state.active &&
        (state.layout === 'float' || state.layout === 'split') &&
        state.currentView === 'page' &&
        state.selectedQuote
    );
    if (quoteBar && quoteText) {
      quoteBar.classList.toggle('is-visible', showQuoteInChrome);
      quoteText.textContent = state.selectedQuote || '';
    }
  }

  function ensureStageContainers() {
    const nodes = findMainWorkspaceNodes();
    if (!nodes) return null;
    const { sheetRow, mainCol } = nodes;

    sheetRow.classList.add('agy-notion-sheet-row');
    mainCol.classList.add('agy-notion-main-col');

    let stage = document.getElementById(STAGE_ID);
    if (!stage) {
      stage = document.createElement('section');
      stage.id = STAGE_ID;
      stage.setAttribute('data-code', 'true');
      stage.innerHTML = `
        <iframe class="agy-notion-iframe" data-role="iframe" title="Notion 工作台"></iframe>

        <div class="agy-notion-error-banner" data-role="error-banner">
          <div style="font-weight:600;font-size:14px;">Notion 工作台服务未就绪</div>
          <div style="font-size:12px;opacity:0.78;" data-role="error-text">请检查本地服务 127.0.0.1:45793 是否正常启动。</div>
          <button type="button" class="agy-notion-mini-btn" data-role="retry-btn">重试加载</button>
        </div>

        <div class="agy-notion-floating-dock no-focus-agent-input" data-role="floating-dock" data-code="true">
          <div class="agy-notion-quote-chip" data-role="quote-chip">
            <span style="color:#2383e2;font-weight:600;">引用</span>
            <span class="agy-notion-quote-text" data-role="quote-text"></span>
            <button type="button" class="agy-notion-quote-clear" data-role="quote-clear" title="清除引用">×</button>
          </div>

          <div class="agy-notion-dock-card" data-role="dock-card">
            <div class="agy-notion-dock-header" data-role="dock-drag-handle">
              <div class="agy-notion-dock-header-left">
                <button type="button" class="agy-notion-dock-min-btn" data-role="dock-min-btn" title="最小化提问框">
                  ${MINUS_SVG}
                </button>
                <button type="button" class="agy-notion-dock-resume-btn" data-role="dock-resume-btn" title="展开当前悬浮对话窗">
                  ${BUBBLE_ICON_SVG}
                  <span class="agy-notion-title-ellipsis" data-role="dock-resume-text">继续对话</span>
                  ${CHEVRON_DOWN_SVG}
                </button>
              </div>
              <button type="button" class="agy-notion-dock-grip-btn" data-role="grip-trigger" aria-label="拖动以移动或点击查看选项">
                ${GRIP_DOTS_SVG}
              </button>
              <div class="agy-notion-dock-grip-menu" data-role="dock-grip-menu"></div>
            </div>

            <div class="agy-notion-composer-row">
              <div class="agy-notion-plus-wrap" data-role="quick-wrap">
                <button type="button" class="agy-notion-plus-btn" data-role="plus-btn" title="快捷提问模板">
                  ${PLUS_SVG}
                </button>
                <div class="agy-notion-quick-menu" data-role="quick-menu"></div>
              </div>

              <textarea class="agy-notion-input" rows="1" placeholder="随心输入" data-role="prompt-input"></textarea>

              <div class="agy-notion-model-wrap" data-role="model-wrap">
                <button type="button" class="agy-notion-model-btn" data-role="model-btn" aria-expanded="false" title="切换模型">
                  <span class="agy-notion-model-label" data-role="model-label">模型</span>
                  ${CHEVRON_DOWN_SVG}
                </button>
                <div class="agy-notion-model-menu" data-role="model-menu"></div>
              </div>

              <button type="button" class="agy-notion-send-btn" data-role="send-btn" title="提问并展开悬浮对话小窗" disabled>
                <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">
                  <line x1="8" y1="12.5" x2="8" y2="3.5"></line>
                  <polyline points="4.2 7.2 8 3.4 11.8 7.2"></polyline>
                </svg>
              </button>
            </div>
          </div>
        </div>

        <button type="button" class="agy-notion-dock-restore no-focus-agent-input" data-role="dock-restore-btn" title="打开对话提问框" data-code="true">
          <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"></path>
          </svg>
        </button>
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

    // 清理旧版残留节点
    document.getElementById('agy-notion-split-chat-bar')?.remove();

    let fallbackToggle = document.getElementById(FALLBACK_TOGGLE_ID);
    if (!fallbackToggle) {
      fallbackToggle = document.createElement('button');
      fallbackToggle.type = 'button';
      fallbackToggle.id = FALLBACK_TOGGLE_ID;
      fallbackToggle.setAttribute('data-code', 'true');
      fallbackToggle.innerHTML = SIDEBAR_PANE_SVG;
      fallbackToggle.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        void openChatPaneInMode(state.layout === 'split' ? 'dock' : 'split');
      });
    }

    if (stage.parentElement !== sheetRow) {
      sheetRow.insertBefore(stage, mainCol);
    }
    if (resizer.parentElement !== sheetRow) {
      sheetRow.insertBefore(resizer, mainCol);
    }
    if (fallbackToggle.parentElement !== sheetRow) {
      sheetRow.appendChild(fallbackToggle);
    }

    ensureChatChromeMounted(mainCol);
    mainCol.style.setProperty('--agy-notion-chat-width', `${state.chatWidth}px`);
    updateDockUI();
    syncChatChromeUI();
    syncNativeToggleButtonState();
    return { sheetRow, mainCol, stage, resizer, fallbackToggle };
  }

  function syncNativeToggleButtonState() {
    const fallbackBtn = document.getElementById(FALLBACK_TOGGLE_ID);
    if (fallbackBtn) {
      fallbackBtn.title =
        state.layout === 'float' ? '停靠到右侧分栏' : state.layout === 'split' ? '收起对话栏' : '打开右侧对话栏';
    }
  }

  function bindResizerEvents(resizer) {
    resizer.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      resizer.classList.add('is-dragging');
      document.body.classList.add('agy-notion-dragging');
      const startX = e.clientX;
      const startW = state.chatWidth;

      const onMove = (ev) => {
        const delta = startX - ev.clientX;
        const nextW = Math.min(640, Math.max(320, startW + delta));
        state.chatWidth = nextW;
        const mainCol = document.querySelector('.agy-notion-main-col');
        if (mainCol) {
          mainCol.style.setProperty('--agy-notion-chat-width', `${nextW}px`);
        }
      };

      const onUp = () => {
        resizer.classList.remove('is-dragging');
        document.body.classList.remove('agy-notion-dragging');
        localStorage.setItem(STORAGE_CHAT_WIDTH, String(state.chatWidth));
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
      };

      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    });
  }

  // --- 复用 Antigravity 原生模型选择器桥接 ---
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
      '模型';
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

  function closeQuickMenu() {
    state.quickMenuOpen = false;
    document.getElementById(STAGE_ID)?.querySelector('[data-role="quick-menu"]')?.classList.remove('is-open');
  }

  function closeDockGripMenu() {
    state.dockGripMenuOpen = false;
    document.getElementById(STAGE_ID)?.querySelector('[data-role="dock-grip-menu"]')?.classList.remove('is-open');
  }

  function closeAllPopovers() {
    closeQuickMenu();
    closeModelMenu();
    closeDockGripMenu();
    closeConvoPicker();
    renderChromeDropdownMenu('');
    hideGripTooltip();
  }

  function renderDockGripMenu() {
    const stage = document.getElementById(STAGE_ID);
    const menu = stage?.querySelector('[data-role="dock-grip-menu"]');
    if (!menu) return;

    const items = [
      { label: '💬 展开悬浮对话窗', action: () => void openChatPaneInMode('float') },
      { label: '◫ 停靠到右侧分栏', action: () => void openChatPaneInMode('split') },
      { label: '＋ 新建 Notion 对话', action: () => void startNewNotionConversation('float') },
      { label: '↺ 重置默认位置', action: () => resetDockOffset() },
    ];

    menu.innerHTML = '';
    for (const item of items) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'agy-notion-menu-item';
      btn.textContent = item.label;
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        closeDockGripMenu();
        item.action();
      });
      menu.appendChild(btn);
    }
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
      empty.style.cssText = 'padding:12px 10px;font-size:12px;color:#64748b;text-align:center;';
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
          entry = { type: 'group', baseName, options: [] };
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
      setTimeout(() => syncModelButtonLabel(), 120);
    };

    for (const item of groups) {
      if (item.type === 'group' && item.options.length > 1) {
        const row = document.createElement('div');
        row.className = 'agy-notion-model-group';
        const nameEl = document.createElement('span');
        nameEl.className = 'agy-notion-model-group-name';
        nameEl.textContent = item.baseName;
        const effortsEl = document.createElement('div');
        effortsEl.className = 'agy-notion-model-efforts';
        for (const sub of item.options) {
          const pill = document.createElement('button');
          pill.type = 'button';
          pill.className = 'agy-notion-effort-pill';
          if (isSameModelOption(bridge.selectedModel, sub.opt)) pill.classList.add('is-selected');
          pill.textContent = sub.shortEffort;
          pill.disabled = Boolean(sub.opt.disabled);
          pill.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            selectOption(sub.opt);
          });
          effortsEl.appendChild(pill);
        }
        row.appendChild(nameEl);
        row.appendChild(effortsEl);
        menu.appendChild(row);
      } else {
        const opt = item.type === 'group' ? item.options[0].opt : item.opt;
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'agy-notion-model-row';
        const isSel = isSameModelOption(bridge.selectedModel, opt);
        if (isSel) row.classList.add('is-selected');
        row.disabled = Boolean(opt.disabled);
        row.innerHTML = `<span>${escapeHtml(opt.label)}</span><span>${isSel ? '✓' : ''}</span>`;
        row.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          selectOption(opt);
        });
        menu.appendChild(row);
      }
    }
  }

  function updateDockUI() {
    const stage = document.getElementById(STAGE_ID);
    if (!stage) return;
    const dock = stage.querySelector('[data-role="floating-dock"]');
    const restoreBtn = stage.querySelector('[data-role="dock-restore-btn"]');
    const quoteChip = stage.querySelector('[data-role="quote-chip"]');
    const quoteText = stage.querySelector('[data-role="quote-text"]');
    const resumeBtn = stage.querySelector('[data-role="dock-resume-btn"]');
    const resumeText = stage.querySelector('[data-role="dock-resume-text"]');

    const isBrowsingReady = Boolean(
      state.active &&
        state.layout === 'dock' &&
        state.currentView !== 'loading' &&
        state.currentView !== 'auth'
    );
    const isPageView = Boolean(state.currentView === 'page' && state.currentPage);
    const shouldShowDock = Boolean(
      isBrowsingReady && (isPageView ? !state.dockMinimized : state.homeDockExpanded)
    );
    const shouldShowRestoreFab = Boolean(isBrowsingReady && !shouldShowDock);

    if (dock) {
      dock.classList.toggle('is-visible', shouldShowDock);
      dock.style.setProperty('--dock-x', `${state.dockOffset.x}px`);
      dock.style.setProperty('--dock-y', `${state.dockOffset.y}px`);
    }

    const savedPath = getPreferredNotionConvoPath();
    const canResumeChat = Boolean(
      (state.hasActiveNotionChat && state.notionConvoTrackingArmed && !isBlankNewConversationView()) || savedPath
    );
    let convoTitle = '继续对话';
    if (savedPath && window.location.pathname !== savedPath) {
      const linkEl = document.querySelector(`a[href="${savedPath}"]`);
      convoTitle =
        (linkEl?.innerText || linkEl?.textContent || '').trim().split(/\r?\n/)[0]?.trim() || '继续 Notion 对话';
    } else {
      convoTitle = extractLiveConversationTitle();
    }
    if (resumeBtn && resumeText) {
      resumeBtn.classList.toggle('is-visible', canResumeChat);
      resumeText.textContent = convoTitle;
    }
    if (restoreBtn) {
      restoreBtn.classList.toggle('is-visible', shouldShowRestoreFab);
      restoreBtn.title = canResumeChat
        ? `恢复对话：${convoTitle}`
        : isPageView
          ? '展开笔记提问框'
          : '打开 Notion 提问框';
    }

    if (quoteChip && quoteText) {
      const hasQ = Boolean(state.selectedQuote && isPageView && shouldShowDock);
      quoteChip.classList.toggle('is-visible', hasQ);
      quoteText.textContent = state.selectedQuote || '';
    }
  }

  function bindStageEvents(stage) {
    const retryBtn = stage.querySelector('[data-role="retry-btn"]');
    const dragHandle = stage.querySelector('[data-role="dock-drag-handle"]');
    const minBtn = stage.querySelector('[data-role="dock-min-btn"]');
    const resumeBtn = stage.querySelector('[data-role="dock-resume-btn"]');
    const gripBtn = dragHandle?.querySelector('[data-role="grip-trigger"]');
    const gripMenu = stage.querySelector('[data-role="dock-grip-menu"]');
    const restoreBtn = stage.querySelector('[data-role="dock-restore-btn"]');
    const quoteClear = stage.querySelector('[data-role="quote-clear"]');
    const plusBtn = stage.querySelector('[data-role="plus-btn"]');
    const quickMenu = stage.querySelector('[data-role="quick-menu"]');
    const promptInput = stage.querySelector('[data-role="prompt-input"]');
    const modelBtn = stage.querySelector('[data-role="model-btn"]');
    const modelMenu = stage.querySelector('[data-role="model-menu"]');
    const sendBtn = stage.querySelector('[data-role="send-btn"]');

    retryBtn.addEventListener('click', () => loadWorkbenchIntoIframe(true));

    bindGripHoverTooltip(gripBtn);

    bindDraggableBar(dragHandle, {
      ignoreSelector: '[data-role="dock-min-btn"], [data-role="dock-resume-btn"], [data-role="dock-grip-menu"]',
      onClickWithoutDrag: () => {
        closeQuickMenu();
        closeModelMenu();
        state.dockGripMenuOpen = !state.dockGripMenuOpen;
        if (state.dockGripMenuOpen) {
          renderDockGripMenu();
          gripMenu?.classList.add('is-open');
        } else {
          closeDockGripMenu();
        }
      },
    });

    minBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      state.dockMinimized = true;
      state.homeDockExpanded = false;
      closeAllPopovers();
      updateDockUI();
    });

    resumeBtn?.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      closeAllPopovers();
      void openChatPaneInMode('float');
    });

    restoreBtn.addEventListener('click', () => {
      state.dockMinimized = false;
      state.homeDockExpanded = true;
      if (
        (state.hasActiveNotionChat && state.notionConvoTrackingArmed && !isBlankNewConversationView()) ||
        getPreferredNotionConvoPath()
      ) {
        void openChatPaneInMode('float');
        return;
      }
      updateDockUI();
      setTimeout(() => promptInput?.focus(), 40);
    });

    quoteClear.addEventListener('click', () => {
      state.selectedQuote = '';
      updateDockUI();
    });

    // 快捷提问模板菜单
    quickMenu.innerHTML = '';
    for (const item of QUICK_PROMPTS) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'agy-notion-quick-item';
      btn.textContent = item.label;
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        closeQuickMenu();
        promptInput.value = item.prompt;
        syncInputUi();
        promptInput.focus();
      });
      quickMenu.appendChild(btn);
    }
    plusBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      closeModelMenu();
      closeDockGripMenu();
      state.quickMenuOpen = !state.quickMenuOpen;
      quickMenu.classList.toggle('is-open', state.quickMenuOpen);
    });

    // 模型切换菜单
    modelBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      closeQuickMenu();
      closeDockGripMenu();
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
        modelMenu.classList.add('is-open');
        modelBtn.setAttribute('aria-expanded', 'true');
      } else {
        closeModelMenu();
      }
    });
    modelMenu.addEventListener('pointerdown', (e) => e.stopPropagation());

    const syncInputUi = () => {
      promptInput.style.height = 'auto';
      promptInput.style.height = `${Math.min(96, Math.max(24, promptInput.scrollHeight))}px`;
      sendBtn.disabled = promptInput.value.trim().length === 0 || state.submitting;
    };
    promptInput.addEventListener('input', syncInputUi);
    promptInput.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        closeAllPopovers();
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

  function syncIframeHostState() {
    const iframe = document.getElementById(STAGE_ID)?.querySelector('[data-role="iframe"]');
    if (!iframe || !iframe.contentWindow) return;
    try {
      iframe.contentWindow.postMessage(
        {
          type: 'AGY_NOTION_HOST_STATE',
          theme: isDarkTheme() ? 'dark' : 'light',
          layout: state.layout === 'split' ? 'split' : 'fullscreen',
        },
        '*'
      );
    } catch {}
  }

  function sendRefreshToIframe() {
    const iframe = document.getElementById(STAGE_ID)?.querySelector('[data-role="iframe"]');
    if (!iframe || !iframe.contentWindow) return;
    try {
      iframe.contentWindow.postMessage({ type: 'AGY_NOTION_REFRESH_PAGE' }, '*');
    } catch {}
  }

  function loadWorkbenchIntoIframe(forceReload = false) {
    const stage = document.getElementById(STAGE_ID);
    if (!stage) return;
    const iframe = stage.querySelector('[data-role="iframe"]');
    const errorBanner = stage.querySelector('[data-role="error-banner"]');
    const errorText = stage.querySelector('[data-role="error-text"]');
    if (!iframe) return;

    if (!forceReload && iframe.getAttribute('src')) {
      syncIframeHostState();
      return;
    }

    const url = new URL(`${STAGE_BASE}/workbench`);
    url.searchParams.set('layout', state.layout === 'split' ? 'split' : 'fullscreen');
    url.searchParams.set('theme', isDarkTheme() ? 'dark' : 'light');

    fetch(`${STAGE_BASE}/api/health`, { cache: 'no-store' })
      .then((r) => r.json())
      .then((h) => {
        if (!h || !h.ok) throw new Error('Notion Stage Server 响应异常');
        errorBanner?.classList.remove('is-visible');
        iframe.setAttribute('src', url.toString());
      })
      .catch((err) => {
        if (errorText) errorText.textContent = err?.message || String(err);
        errorBanner?.classList.add('is-visible');
      });
  }

  function setNotionLayout(nextLayout) {
    const normalized =
      nextLayout === 'split' ? 'split' : nextLayout === 'float' ? 'float' : 'dock';
    state.layout = normalized;
    document.body.setAttribute('data-agy-notion-layout', state.layout);

    closeAllPopovers();
    if (state.layout === 'dock') {
      syncModelButtonLabel();
    }

    requestAnimationFrame(() => {
      syncFloatGeometry();
      updateDockUI();
      syncChatChromeUI();
      syncNativeToggleButtonState();
      syncIframeHostState();
      window.dispatchEvent(new Event('resize'));
    });
  }

  function isValidConvoPath(p) {
    return typeof p === 'string' && /^\/c\/[A-Za-z0-9_-]+$/.test(p);
  }

  function recordActiveNotionConvo(convoPath, pageId = state.currentPage?.id || '') {
    if (!isValidConvoPath(convoPath)) return;
    state.lastNotionConvoPath = convoPath;
    state.hasActiveNotionChat = true;
    state.notionConvoTrackingArmed = true;
    try {
      localStorage.setItem(STORAGE_LAST_NOTION_CONVO, convoPath);
    } catch {}

    if (pageId) {
      state.pageConvoMap[pageId] = convoPath;
      const keys = Object.keys(state.pageConvoMap);
      if (keys.length > 60) {
        delete state.pageConvoMap[keys[0]];
      }
      try {
        localStorage.setItem(STORAGE_PAGE_CONVOS, JSON.stringify(state.pageConvoMap));
      } catch {}
    }
  }

  function getPreferredNotionConvoPath(pageId = state.currentPage?.id || '') {
    if (state.activeTabKey === DRAFT_TAB_KEY) {
      return '';
    }
    if (isValidConvoPath(state.activeTabKey)) {
      return state.activeTabKey;
    }
    if (pageId && isValidConvoPath(state.pageConvoMap[pageId])) {
      return state.pageConvoMap[pageId];
    }
    if (isValidConvoPath(state.lastNotionConvoPath)) {
      return state.lastNotionConvoPath;
    }
    return '';
  }

  async function navigateToSavedNotionConvo(convoPath) {
    if (!isValidConvoPath(convoPath)) return false;
    if (window.location.pathname === convoPath) {
      state.hasActiveNotionChat = true;
      state.notionConvoTrackingArmed = true;
      syncChatChromeUI();
      updateDockUI();
      return true;
    }

    state.isProgrammaticNav = true;
    state.restoringConvo = true;
    try {
      const sideLink = document.querySelector(`a[href="${convoPath}"]`);
      if (sideLink) {
        sideLink.click();
      } else {
        window.history.pushState({}, '', convoPath);
        window.dispatchEvent(new PopStateEvent('popstate'));
      }
      await new Promise((r) => setTimeout(r, 150));
      state.hasActiveNotionChat = true;
      state.notionConvoTrackingArmed = true;
      sanitizeNotionUserMessageBubbles();
      syncChatChromeUI();
      updateDockUI();
      return true;
    } finally {
      state.restoringConvo = false;
      setTimeout(() => {
        state.isProgrammaticNav = false;
      }, 360);
    }
  }

  async function openChatPaneInMode(targetMode) {
    setNotionLayout(targetMode);
    if (targetMode === 'float' || targetMode === 'split') {
      const savedPath = getPreferredNotionConvoPath();
      if (savedPath && !state.notionConvoTrackingArmed) {
        await navigateToSavedNotionConvo(savedPath);
        setTimeout(() => findMainComposerEditor()?.focus(), 60);
      } else if (!state.hasActiveNotionChat || (!state.notionConvoTrackingArmed && !isBlankNewConversationView())) {
        state.hasActiveNotionChat = true;
        state.notionConvoTrackingArmed = true;
        await ensureFreshNewConversationEditor(2600, { forceReset: !isBlankNewConversationView() });
        syncChatChromeUI();
      } else {
        setTimeout(() => findMainComposerEditor()?.focus(), 60);
      }
    }
  }

  async function startNewNotionConversation(targetMode = state.layout, opts = {}) {
    const { clearCurrentBinding = false, keepExistingDraft = false } = opts || {};
    const mode = targetMode === 'split' ? 'split' : 'float';
    if (clearCurrentBinding) {
      state.lastNotionConvoPath = '';
      try {
        localStorage.removeItem(STORAGE_LAST_NOTION_CONVO);
      } catch {}
      if (state.currentPage?.id && state.pageConvoMap[state.currentPage.id]) {
        delete state.pageConvoMap[state.currentPage.id];
        try {
          localStorage.setItem(STORAGE_PAGE_CONVOS, JSON.stringify(state.pageConvoMap));
        } catch {}
      }
    }
    upsertOpenTab({ key: DRAFT_TAB_KEY, path: '/', title: '新对话', pinned: false }, true);
    state.lastSubmittedPrompt = '';
    state.hasActiveNotionChat = true;
    state.notionConvoTrackingArmed = true;
    setNotionLayout(mode);
    const ed = await ensureFreshNewConversationEditor(3000, {
      forceReset: !keepExistingDraft || !isBlankNewConversationView(),
    });
    syncChatChromeUI();
    ed?.focus();
  }

  function deactivateOtherStages() {
    try {
      window.dispatchEvent(new CustomEvent('agy:stage-activate', { detail: { source: 'notion' } }));
    } catch {}
    if (document.body.getAttribute('data-agy-cowart-active') === 'true') {
      document.body.removeAttribute('data-agy-cowart-active');
      document.body.removeAttribute('data-agy-cowart-layout');
      document.getElementById('agy-cowart-nav-item')?.setAttribute('data-active', 'false');
    }
  }

  async function openNotionView() {
    deactivateOtherStages();
    injectStyles();
    ensureSidebarNavItem();
    ensureStageContainers();

    state.active = true;
    document.body.setAttribute('data-agy-notion-active', 'true');

    // 若从外部聊天 A 切回 Notion，优先恢复当前笔记或最近一次 Notion 专属会话，避免悬浮窗显示外部聊天 A
    const preferredConvo = getPreferredNotionConvoPath();
    if (preferredConvo) {
      await navigateToSavedNotionConvo(preferredConvo);
    } else if (window.location.pathname.startsWith('/c/') && !state.notionConvoTrackingArmed) {
      state.hasActiveNotionChat = false;
      if (state.layout === 'float' || state.layout === 'split') {
        state.notionConvoTrackingArmed = true;
        state.hasActiveNotionChat = true;
        await ensureFreshNewConversationEditor(2400, { forceReset: true });
      }
    }

    setNotionLayout(state.layout || 'dock');
    document.getElementById(NAV_ID)?.setAttribute('data-active', 'true');

    if (!document.querySelector('[data-testid="model-selector-trigger"]') && !findMainComposerEditor()) {
      triggerProgrammaticNewChat();
      setTimeout(() => {
        if (state.active) syncModelButtonLabel();
      }, 300);
    } else {
      syncModelButtonLabel();
    }

    loadWorkbenchIntoIframe(false);
    void refreshNotionProjectTarget();
    updateDockUI();
    syncChatChromeUI();
  }

  function closeNotionView() {
    if (!state.active) return;
    if (state.notionConvoTrackingArmed && isValidConvoPath(window.location.pathname)) {
      recordActiveNotionConvo(window.location.pathname, state.currentPage?.id || '');
    }
    state.active = false;
    state.notionConvoTrackingArmed = false;
    closeAllPopovers();
    document.body.removeAttribute('data-agy-notion-active');
    document.body.removeAttribute('data-agy-notion-layout');
    document.getElementById(NAV_ID)?.setAttribute('data-active', 'false');
    syncNativeToggleButtonState();
    window.dispatchEvent(new Event('resize'));
  }

  // --- 与原生 Antigravity 对话输入框及专属 Notion 项目切换桥接 ---
  async function refreshNotionProjectTarget(force = false) {
    if (state.notionProject.loaded && !force) return state.notionProject;
    try {
      const resp = await fetch(`${STAGE_BASE}/api/project-target`, { cache: 'no-store' });
      const data = await resp.json();
      if (data && data.ok) {
        state.notionProject = {
          id: data.projectId || state.notionProject.id,
          name: data.projectName || 'Notion',
          dir: data.projectDir || '',
          knownProjectNames: Array.isArray(data.knownProjectNames) ? data.knownProjectNames : [],
          loaded: true,
        };
      }
    } catch {}
    return state.notionProject;
  }

  function isBlankNewConversationView() {
    const p = window.location.pathname || '';
    if (p !== '/' && p !== '') return false;
    if (document.querySelector('[data-testid="conversation-view"]')) return false;
    if (document.querySelector('[data-testid="user-message"]')) return false;
    return Boolean(findMainComposerEditor());
  }

  async function navigateToNewChatWithProject(projectId) {
    const targetUrl = projectId ? `/?project=${encodeURIComponent(projectId)}` : '/';
    state.isProgrammaticNav = true;
    try {
      window.history.pushState({}, '', targetUrl);
      window.dispatchEvent(new PopStateEvent('popstate'));

      // 等待路由器完成 popstate 重渲染，避免同步误判未切页而点击 href="/" 洗掉 ?project=
      await new Promise((r) => setTimeout(r, 150));

      if (!isBlankNewConversationView()) {
        const newBtn =
          document.querySelector('[data-testid="new-conversation-button"]') ||
          document.querySelector('[data-testid="sidebar-navigation-items"] a[href="/"]') ||
          document.querySelector('a[href="/"]');
        if (newBtn) newBtn.click();
        if (projectId) {
          await new Promise((r) => setTimeout(r, 80));
          try {
            const cur = new URL(window.location.href);
            if (cur.pathname === '/' && cur.searchParams.get('project') !== projectId) {
              cur.searchParams.set('project', projectId);
              window.history.replaceState({}, '', cur.pathname + cur.search);
              window.dispatchEvent(new PopStateEvent('popstate'));
            }
          } catch {}
        }
      }
    } finally {
      setTimeout(() => {
        state.isProgrammaticNav = false;
      }, 450);
    }
    return true;
  }

  function triggerProgrammaticNewChat() {
    void navigateToNewChatWithProject(state.notionProject?.id || '');
    return true;
  }

  function clickElementSafely(el) {
    if (!el) return;
    try {
      el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 }));
      el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));
      el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, button: 0 }));
    } catch {}
    try {
      el.click();
    } catch {}
  }

  function setNativeInputValue(inputEl, text) {
    if (!inputEl) return;
    inputEl.focus();
    const proto = inputEl.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(inputEl, text);
    else inputEl.value = text;
    inputEl.dispatchEvent(new Event('input', { bubbles: true }));
    inputEl.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function getTriggerProjectLabel(triggerBtn) {
    if (!triggerBtn) return '';
    return (triggerBtn.innerText || triggerBtn.textContent || '').trim().replace(/\s+/g, ' ');
  }

  async function waitForProjectSelectorTrigger(mainCol, timeoutMs = 1800) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const btn =
        mainCol?.querySelector('[data-testid="project-selector-trigger"]') ||
        document.querySelector('[data-testid="project-selector-trigger"]');
      if (btn && btn.isConnected) return btn;
      await new Promise((r) => setTimeout(r, 45));
    }
    return null;
  }

  function findMatchedProjectItemInDom(targetName) {
    const want = String(targetName || 'Notion').trim().toLowerCase();
    const byAttr = [...document.querySelectorAll('[data-testid="project-selector-item"]')].find((el) => {
      const pName = (el.getAttribute('data-project-name') || '').trim().toLowerCase();
      return pName === want;
    });
    if (byAttr) return byAttr;

    const scopes = [
      ...document.querySelectorAll(
        '[data-testid="project-selector-list"], [role="menu"], [role="listbox"], [data-radix-popper-content-wrapper]'
      ),
    ];
    for (const scope of scopes) {
      if (scope.closest(`#${STAGE_ID}`)) continue;
      const items = [...scope.querySelectorAll('[data-testid="project-selector-item"], [role="menuitem"], [role="option"], button')];
      const hit = items.find((el) => {
        const firstLine = (el.innerText || el.textContent || '').trim().split(/\r?\n/)[0]?.trim() || '';
        return firstLine.toLowerCase() === want;
      });
      if (hit) return hit;
    }
    return null;
  }

  async function ensureComposerProjectIsNotion() {
    const proj = await refreshNotionProjectTarget();
    const targetName = String(proj?.name || 'Notion').trim();
    const targetLower = targetName.toLowerCase();
    const targetId = String(proj?.id || '').trim();
    const mainCol = document.querySelector('.agy-notion-main-col');
    if (!mainCol) return false;

    const triggerBtn = await waitForProjectSelectorTrigger(mainCol, 1800);
    if (!triggerBtn) return false;

    if (getTriggerProjectLabel(triggerBtn).toLowerCase() === targetLower) {
      return true;
    }

    if (targetId) {
      try {
        const cur = new URL(window.location.href);
        if (cur.pathname === '/' && cur.searchParams.get('project') !== targetId) {
          cur.searchParams.set('project', targetId);
          window.history.replaceState({}, '', cur.pathname + cur.search);
          window.dispatchEvent(new PopStateEvent('popstate'));
          await new Promise((r) => setTimeout(r, 150));
          const latestBtn = mainCol.querySelector('[data-testid="project-selector-trigger"]') || triggerBtn;
          if (getTriggerProjectLabel(latestBtn).toLowerCase() === targetLower) {
            return true;
          }
        }
      } catch {}
    }

    state.isProgrammaticNav = true;
    try {
      const btnToClick = mainCol.querySelector('[data-testid="project-selector-trigger"]') || triggerBtn;
      clickElementSafely(btnToClick);

      let picked = false;
      let searchTyped = false;
      const deadline = Date.now() + 1600;

      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 55));

        const matched = findMatchedProjectItemInDom(targetName);
        if (matched) {
          clickElementSafely(matched);
          picked = true;
          break;
        }

        if (!searchTyped) {
          const searchInput = document.querySelector('input[data-testid="project-selector-search"]');
          if (searchInput) {
            setNativeInputValue(searchInput, targetName);
            searchTyped = true;
            await new Promise((r) => setTimeout(r, 70));
            const matchedAfterSearch = findMatchedProjectItemInDom(targetName);
            if (matchedAfterSearch) {
              clickElementSafely(matchedAfterSearch);
              picked = true;
              break;
            }
          }
        }
      }

      if (!picked) {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
        return false;
      }

      const verifyDeadline = Date.now() + 900;
      while (Date.now() < verifyDeadline) {
        await new Promise((r) => setTimeout(r, 60));
        const afterBtn = mainCol.querySelector('[data-testid="project-selector-trigger"]') || triggerBtn;
        if (getTriggerProjectLabel(afterBtn).toLowerCase() === targetLower) {
          return true;
        }
      }
      return false;
    } finally {
      setTimeout(() => {
        state.isProgrammaticNav = false;
      }, 300);
    }
  }

  function findMainComposerEditor() {
    const mainCol = document.querySelector('.agy-notion-main-col') || document;
    return (
      mainCol.querySelector('[data-lexical-editor="true"][contenteditable="true"]') ||
      mainCol.querySelector('[contenteditable="true"][role="textbox"]') ||
      mainCol.querySelector('textarea:not(.agy-notion-input)')
    );
  }

  async function ensureFreshNewConversationEditor(timeoutMs = 3000, options = {}) {
    const { forceReset = false } = options || {};
    const proj = await refreshNotionProjectTarget();

    if (forceReset || !isBlankNewConversationView()) {
      await navigateToNewChatWithProject(proj?.id || '');
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        if (isBlankNewConversationView()) {
          await new Promise((r) => setTimeout(r, 90));
          break;
        }
        await new Promise((r) => setTimeout(r, 50));
      }
    }

    await ensureComposerProjectIsNotion();

    const startEd = Date.now();
    while (Date.now() - startEd < Math.min(1800, timeoutMs)) {
      const ed = findMainComposerEditor();
      if (ed && ed.isConnected) return ed;
      await new Promise((r) => setTimeout(r, 50));
    }
    return findMainComposerEditor();
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
        editor?.closest('.agy-notion-main-col') ||
        document.querySelector('.agy-notion-main-col') ||
        document;
    }

    const btns = [...container.querySelectorAll('button')];
    for (const b of btns) {
      if (b.disabled) continue;
      if (b.closest(`#${CHROME_ID}`)) continue;
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

    try {
      if (editor.tagName === 'TEXTAREA' || editor.tagName === 'INPUT') {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
        if (setter) setter.call(editor, text);
        else editor.value = text;
        editor.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      }
      document.execCommand('selectAll', false, null);
      document.execCommand('delete', false, null);
    } catch {}

    const ipcInsert =
      window.__agyNotionSidebarIPC?.insertText || window.__agyCowartSidebarIPC?.insertText;
    if (typeof ipcInsert === 'function') {
      try {
        const res = await ipcInsert(text);
        if (res && res.ok) return true;
      } catch {}
    }

    try {
      const dt = new DataTransfer();
      dt.setData('text/plain', text);
      const pasteEvt = new ClipboardEvent('paste', {
        clipboardData: dt,
        bubbles: true,
        cancelable: true,
      });
      editor.dispatchEvent(pasteEvt);
      if ((editor.textContent || '').trim().length > 0) return true;
    } catch {}

    try {
      document.execCommand('insertText', false, text);
      return true;
    } catch {
      return false;
    }
  }

  // --- 智能按需页面上下文记忆与右侧原生输入框无损注入 ---
  function markPageContextInjected(convoPath, pageId) {
    if (!isValidConvoPath(convoPath) || !pageId) return;
    state.convoInjectedPageMap[convoPath] = pageId;
    const keys = Object.keys(state.convoInjectedPageMap);
    if (keys.length > 80) {
      delete state.convoInjectedPageMap[keys[0]];
    }
    try {
      localStorage.setItem(STORAGE_INJECTED_PAGES, JSON.stringify(state.convoInjectedPageMap));
    } catch {}
  }

  function shouldInjectCurrentPageContext(convoKey) {
    if (!state.active) return false;
    if (state.selectedQuote) return true;
    if (state.currentView === 'page' && state.currentPage?.id) {
      if (!convoKey || convoKey === DRAFT_TAB_KEY) return true;
      return state.convoInjectedPageMap[convoKey] !== state.currentPage.id;
    }
    return false;
  }

  function buildCurrentNotionContextBlock() {
    if (!state.currentPage && !state.selectedQuote) return '';
    const ctxPayload = {};
    if (state.currentPage) {
      ctxPayload.title = state.currentPage.title;
      ctxPayload.pageId = state.currentPage.id;
      ctxPayload.url = state.currentPage.url;
      ctxPayload.path = state.currentPage.path || '';
    }
    if (state.selectedQuote) {
      ctxPayload.selectedQuote = state.selectedQuote;
    }
    return `[Notion Page Context: ${JSON.stringify(ctxPayload)}]`;
  }

  function isNativeAutocompletePopupOpen() {
    const selectors =
      '[role="listbox"], [data-lexical-typeahead-menu], #typeahead-menu, .lexical-typeahead-menu, [data-testid*="mention-menu"], [data-testid*="slash-menu"], [data-testid*="command-menu"]';
    for (const el of document.querySelectorAll(selectors)) {
      if (el.closest(`#${STAGE_ID}`) || el.closest(`#${CHROME_ID}`)) continue;
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) return true;
    }
    return false;
  }

  async function appendSuffixToEditorEnd(editor, suffix) {
    editor.focus();
    try {
      if (editor.tagName === 'TEXTAREA' || editor.tagName === 'INPUT') {
        const nextVal = `${editor.value || ''}${suffix}`;
        const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
        if (setter) setter.call(editor, nextVal);
        else editor.value = nextVal;
        editor.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      }
      const sel = window.getSelection();
      if (sel) {
        const range = document.createRange();
        range.selectNodeContents(editor);
        range.collapse(false);
        sel.removeAllRanges();
        sel.addRange(range);
      }
    } catch {}

    await new Promise((r) => setTimeout(r, 20));

    const ipcInsert =
      window.__agyNotionSidebarIPC?.insertText || window.__agyCowartSidebarIPC?.insertText;
    if (typeof ipcInsert === 'function') {
      try {
        const res = await ipcInsert(suffix);
        if (res && res.ok) return true;
      } catch {}
    }

    try {
      const dt = new DataTransfer();
      dt.setData('text/plain', suffix);
      const pasteEvt = new ClipboardEvent('paste', {
        clipboardData: dt,
        bubbles: true,
        cancelable: true,
      });
      editor.dispatchEvent(pasteEvt);
      if ((editor.textContent || '').includes('[Notion Page Context:')) return true;
    } catch {}

    try {
      document.execCommand('insertText', false, suffix);
      return true;
    } catch {
      return false;
    }
  }

  function watchAndBindNewConversation(submittedPageId) {
    void (async () => {
      const deadline = Date.now() + 5500;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 120));
        if (!state.notionConvoTrackingArmed) break;
        if (isValidConvoPath(window.location.pathname)) {
          const landedPath = window.location.pathname;
          recordActiveNotionConvo(landedPath, submittedPageId);
          if (submittedPageId) {
            markPageContextInjected(landedPath, submittedPageId);
          }
          upsertOpenTab({ key: landedPath, path: landedPath, title: extractLiveConversationTitle() }, true);
          sanitizeNotionUserMessageBubbles();
          syncChatChromeUI();
          updateDockUI();
          break;
        }
      }
    })();
  }

  async function interceptAndSubmitNativeComposer(editor) {
    if (state.injectingNativeSend || !editor) return;
    const rawText = (editor.innerText || editor.textContent || editor.value || '').trim();
    if (!rawText) return;

    const curPath = window.location.pathname || '';
    const convoKey = isValidConvoPath(curPath) ? curPath : DRAFT_TAB_KEY;
    const pageIdAtSend = state.currentView === 'page' ? state.currentPage?.id || '' : '';
    const ctxBlock = buildCurrentNotionContextBlock();

    state.injectingNativeSend = true;
    state.lastSubmittedPrompt = rawText.replace(/\[Notion Page Context:[\s\S]*?\]/g, '').trim();
    state.hasActiveNotionChat = true;
    state.notionConvoTrackingArmed = true;

    try {
      if (ctxBlock && !rawText.includes('[Notion Page Context:')) {
        document.body.setAttribute('data-agy-notion-submitting', 'true');
        await appendSuffixToEditorEnd(editor, `\n\n${ctxBlock}`);
        await new Promise((r) => setTimeout(r, 70));
      }

      if (isValidConvoPath(curPath) && pageIdAtSend) {
        markPageContextInjected(curPath, pageIdAtSend);
      }
      if (state.selectedQuote) {
        state.selectedQuote = '';
        updateDockUI();
        syncChatChromeUI();
      }

      state.bypassNativeIntercept = true;
      try {
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
      } finally {
        state.bypassNativeIntercept = false;
      }

      if (convoKey === DRAFT_TAB_KEY) {
        watchAndBindNewConversation(pageIdAtSend);
      }

      setTimeout(() => {
        document.body.removeAttribute('data-agy-notion-submitting');
        sanitizeNotionUserMessageBubbles();
        syncChatChromeUI();
      }, 85);
      setTimeout(() => {
        sanitizeNotionUserMessageBubbles();
        syncChatChromeUI();
      }, 420);
    } finally {
      state.injectingNativeSend = false;
      setTimeout(() => document.body.removeAttribute('data-agy-notion-submitting'), 260);
    }
  }

  async function submitToAntigravityChat(rawPrompt, options = {}) {
    const { forceNewConversation = true, targetLayout = 'float' } = options || {};
    const cleanPrompt = String(rawPrompt || '').trim();
    if (!cleanPrompt || state.submitting) return false;
    state.submitting = true;

    try {
      if (!state.active) await openNotionView();
      const submittedPageId = state.currentView === 'page' ? state.currentPage?.id || '' : '';
      state.lastSubmittedPrompt = cleanPrompt;
      state.hasActiveNotionChat = true;
      state.notionConvoTrackingArmed = true;
      if (forceNewConversation) {
        upsertOpenTab({ key: DRAFT_TAB_KEY, path: '/', title: '新对话', pinned: false }, true);
      }
      setNotionLayout(targetLayout === 'split' ? 'split' : 'float');
      syncChatChromeUI();

      let editor = null;
      if (forceNewConversation) {
        editor = await ensureFreshNewConversationEditor(3000, { forceReset: true });
      } else {
        editor = findMainComposerEditor() || (await ensureFreshNewConversationEditor(2500));
      }
      if (!editor) return false;

      if (isBlankNewConversationView()) {
        const switched = await ensureComposerProjectIsNotion();
        if (!switched) {
          console.warn('[Antigravity NotionSidebar] 自动切换至 Notion 项目未成功，重试一次');
          await ensureComposerProjectIsNotion();
        }
        editor = findMainComposerEditor() || editor;
        if (!editor) return false;
      }

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

      const curPath = window.location.pathname || '';
      const convoKey = !forceNewConversation && isValidConvoPath(curPath) ? curPath : DRAFT_TAB_KEY;
      const parts = [cleanPrompt];
      if (shouldInjectCurrentPageContext(convoKey)) {
        const ctxBlock = buildCurrentNotionContextBlock();
        if (ctxBlock) parts.push(ctxBlock);
      }
      const finalMessage = parts.join('\n\n');

      document.body.setAttribute('data-agy-notion-submitting', 'true');
      const ok = await writeTextIntoEditor(editor, finalMessage);
      if (!ok) {
        document.body.removeAttribute('data-agy-notion-submitting');
        return false;
      }

      await new Promise((r) => setTimeout(r, 110));

      state.bypassNativeIntercept = true;
      try {
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
      } finally {
        state.bypassNativeIntercept = false;
      }

      if (convoKey !== DRAFT_TAB_KEY && submittedPageId) {
        markPageContextInjected(convoKey, submittedPageId);
      } else {
        watchAndBindNewConversation(submittedPageId);
      }

      setTimeout(() => {
        document.body.removeAttribute('data-agy-notion-submitting');
        sanitizeNotionUserMessageBubbles();
        syncChatChromeUI();
      }, 90);
      setTimeout(() => {
        sanitizeNotionUserMessageBubbles();
        syncChatChromeUI();
      }, 420);
      return true;
    } finally {
      state.submitting = false;
      setTimeout(() => document.body.removeAttribute('data-agy-notion-submitting'), 260);
    }
  }

  async function handleFloatingSubmit() {
    const stage = document.getElementById(STAGE_ID);
    if (!stage) return;
    const promptInput = stage.querySelector('[data-role="prompt-input"]');
    const sendBtn = stage.querySelector('[data-role="send-btn"]');
    if (!promptInput) return;

    const text = promptInput.value.trim();
    if (!text) return;
    if (sendBtn) sendBtn.disabled = true;

    // 默认原地展开为「可拖拽悬浮对话小窗」（Codex 图 2）
    const submitted = await submitToAntigravityChat(text, {
      forceNewConversation: true,
      targetLayout: 'float',
    });
    if (submitted) {
      promptInput.value = '';
      promptInput.style.height = 'auto';
      state.selectedQuote = '';
      updateDockUI();
      syncChatChromeUI();
    } else if (sendBtn) {
      sendBtn.disabled = false;
    }
  }

  // --- 将消息气泡中的 [Notion Page Context: {...}]（含被自动拆分为 <a> 链接的节点）收起为可展开折叠卡片 ---
  const NOTION_QUOTE_BLOCK_RE = /(?:\r?\n)*我当前选中的笔记片段：\r?\n((?:>[^\r\n]*(?:\r?\n|$))+)/;
  const NOTION_QUOTE_LINE_RE = /^我当前选中的笔记片段：\s*$/;

  function extractCleanNodeText(rootEl) {
    let out = '';
    const walk = (n) => {
      if (!n) return;
      if (n.nodeType === Node.TEXT_NODE) {
        out += n.nodeValue || '';
        return;
      }
      if (n.nodeType === Node.ELEMENT_NODE) {
        const el = n;
        if (el.classList?.contains('agy-notion-ctx-fold')) return;
        const tag = (el.tagName || '').toLowerCase();
        if (el.classList?.contains('google-symbols') || el.classList?.contains('material-icons') || tag === 'svg') {
          return;
        }
        if (tag === 'a' && el.getAttribute('href')) {
          out += el.getAttribute('href');
          return;
        }
        for (const ch of el.childNodes) walk(ch);
      }
    };
    walk(rootEl);
    return out;
  }

  function parseNotionContextMetadata(cleanTxt) {
    let meta = null;
    const markerIdx = cleanTxt.indexOf('[Notion Page Context:');
    if (markerIdx !== -1) {
      const braceStart = cleanTxt.indexOf('{', markerIdx);
      const closeBracket = cleanTxt.indexOf('}]', braceStart);
      if (braceStart !== -1 && closeBracket !== -1) {
        const jsonStr = cleanTxt.slice(braceStart, closeBracket + 1);
        try {
          meta = JSON.parse(jsonStr);
          if (meta && typeof meta.url === 'string') {
            meta.url = meta.url.replace(/[\u2197\s]+$/g, '');
          }
        } catch {
          const getField = (k) => {
            const m = jsonStr.match(new RegExp(`"${k}"\\s*:\\s*"([^"]*)"`));
            return m ? m[1] : '';
          };
          meta = {
            title: getField('title') || 'Notion 页面',
            pageId: getField('pageId'),
            url: getField('url'),
            path: getField('path'),
            selectedQuote: getField('selectedQuote'),
          };
        }
      }
    }

    const legacyQuoteM = cleanTxt.match(NOTION_QUOTE_BLOCK_RE);
    if (legacyQuoteM) {
      const qTxt = legacyQuoteM[1]
        .split(/\r?\n/)
        .map((l) => l.replace(/^>\s?/, ''))
        .join('\n')
        .trim();
      if (!meta) meta = { title: '当前笔记引用' };
      if (qTxt && !meta.selectedQuote) meta.selectedQuote = qTxt;
    }
    return meta;
  }

  function hideContextNodesInContainer(containerEl) {
    let inCtxSpan = false;
    let mutated = false;

    for (const node of [...containerEl.childNodes]) {
      if (!inCtxSpan) {
        if (node.nodeType === Node.TEXT_NODE) {
          let val = node.nodeValue || '';
          const nextQuote = val.replace(/(?:\r?\n)*我当前选中的笔记片段：\r?\n(?:>[^\r\n]*(?:\r?\n|$))+/g, '');
          if (nextQuote !== val) {
            val = nextQuote;
            mutated = true;
          }
          const startMatch = val.match(/(?:\r?\n)*\[Notion Page Context:/);
          if (startMatch && startMatch.index !== undefined) {
            const prefix = val.slice(0, startMatch.index).replace(/\s+$/, '');
            const rest = val.slice(startMatch.index);
            const endPos = rest.indexOf('}]');
            if (endPos !== -1) {
              const suffix = rest.slice(endPos + 2).replace(/^\s+/, '');
              node.nodeValue = suffix ? `${prefix}\n${suffix}` : prefix;
            } else {
              node.nodeValue = prefix;
              inCtxSpan = true;
            }
            mutated = true;
          } else if (mutated) {
            node.nodeValue = val.replace(/\s+$/, '');
          }
        } else if (node.nodeType === Node.ELEMENT_NODE) {
          const elTxt = node.textContent || '';
          if (elTxt.includes('[Notion Page Context:') || elTxt.includes('我当前选中的笔记片段：')) {
            if (hideContextNodesInContainer(node)) {
              mutated = true;
            }
          }
        }
      } else {
        // 处于跨节点 [Notion Page Context: ... <a>url</a> ... }] 区间内，隐藏中间节点但不从 DOM 删除
        mutated = true;
        if (node.nodeType === Node.ELEMENT_NODE) {
          node.style.display = 'none';
          if ((node.textContent || '').includes('}]')) {
            inCtxSpan = false;
          }
        } else if (node.nodeType === Node.TEXT_NODE) {
          const val = node.nodeValue || '';
          const endPos = val.indexOf('}]');
          if (endPos !== -1) {
            node.nodeValue = val.slice(endPos + 2).replace(/^\r?\n/, '');
            inCtxSpan = false;
          } else {
            node.nodeValue = '';
          }
        }
      }
    }
    return mutated;
  }

  function mountCollapsibleContextCard(contentEl, meta) {
    if (!meta) return;
    const bubbleEl = contentEl.closest('[data-testid="user-message-bubble"]') || contentEl.parentElement;
    if (!bubbleEl || bubbleEl.querySelector('.agy-notion-ctx-fold')) return;

    const fold = document.createElement('details');
    fold.className = 'agy-notion-ctx-fold no-focus-agent-input';
    fold.setAttribute('data-code', 'true');

    const pageTitle = meta.title || 'Notion 页面';
    const summaryLabel = meta.selectedQuote
      ? `引用页面：${pageTitle}（含选中片段）`
      : `引用页面：${pageTitle}`;

    const rowsHtml = [];
    rowsHtml.push(`
      <div class="agy-notion-ctx-row">
        <span class="agy-notion-ctx-label">页面</span>
        <a class="agy-notion-ctx-link" data-role="ctx-open-page">${escapeHtml(pageTitle)}</a>
      </div>
    `);
    if (meta.path) {
      rowsHtml.push(`
        <div class="agy-notion-ctx-row">
          <span class="agy-notion-ctx-label">路径</span>
          <span>${escapeHtml(meta.path)}</span>
        </div>
      `);
    }
    if (meta.pageId) {
      rowsHtml.push(`
        <div class="agy-notion-ctx-row">
          <span class="agy-notion-ctx-label">ID</span>
          <span style="font-family:Consolas,monospace;font-size:11px;">${escapeHtml(meta.pageId)}</span>
        </div>
      `);
    }
    if (meta.selectedQuote) {
      rowsHtml.push(`<div class="agy-notion-ctx-quote">${escapeHtml(meta.selectedQuote)}</div>`);
    }

    fold.innerHTML = `
      <summary class="agy-notion-ctx-summary" title="点击展开或收起引用的 Notion 页面详情">
        <span class="agy-notion-ctx-arrow">▸</span>
        <span style="display:inline-flex;align-items:center;opacity:0.8;">${NOTION_NAV_SVG.replace(/16/g, '13')}</span>
        <span class="agy-notion-ctx-summary-title">${escapeHtml(summaryLabel)}</span>
      </summary>
      <div class="agy-notion-ctx-body">
        ${rowsHtml.join('')}
      </div>
    `;

    fold.addEventListener('click', (e) => {
      e.stopPropagation();
    });

    fold.querySelector('[data-role="ctx-open-page"]')?.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const iframe = document.getElementById(STAGE_ID)?.querySelector('[data-role="iframe"]');
      if (state.active && meta.pageId && iframe?.contentWindow) {
        iframe.contentWindow.postMessage({ type: 'AGY_NOTION_OPEN_PAGE', pageId: meta.pageId }, '*');
      } else if (meta.url) {
        openExternalSafely(meta.url);
      }
    });

    bubbleEl.appendChild(fold);
  }

  function sanitizeNotionUserMessageBubbles() {
    const bubbles = document.querySelectorAll('[data-testid="user-message-content"]');
    for (const contentEl of bubbles) {
      if (contentEl.dataset.agyNotionCleaned === '1') {
        if (contentEl.scrollHeight <= contentEl.clientHeight + 4 && contentEl.style.maskImage) {
          contentEl.style.maskImage = 'none';
          contentEl.style.webkitMaskImage = 'none';
        }
        continue;
      }

      const rawFullTxt = contentEl.textContent || '';
      if (!rawFullTxt.includes('[Notion Page Context:') && !rawFullTxt.includes('我当前选中的笔记片段：')) {
        continue;
      }

      const cleanTxt = extractCleanNodeText(contentEl);
      const meta = parseNotionContextMetadata(cleanTxt);
      const quotable = contentEl.querySelector('[data-quotable="true"]') || contentEl;
      let mutated = hideContextNodesInContainer(quotable);

      // 兼容列表模式下清空后的 <p> 段落隐藏（只设 display:none，不删除 React 节点）
      const paragraphs = quotable.querySelectorAll('p');
      let hideQuoteLines = false;
      for (const p of paragraphs) {
        const pTxt = (p.textContent || '').trim();
        if (NOTION_QUOTE_LINE_RE.test(pTxt)) {
          p.style.display = 'none';
          hideQuoteLines = true;
          mutated = true;
          const prev = p.previousElementSibling;
          if (prev && prev.tagName === 'P' && !(prev.textContent || '').trim() && !prev.querySelector('bdi, img')) {
            prev.style.display = 'none';
          }
          continue;
        }
        if (hideQuoteLines) {
          if (pTxt.startsWith('>')) {
            p.style.display = 'none';
            mutated = true;
            continue;
          }
          hideQuoteLines = false;
        }
        if (!pTxt && !p.querySelector('br, bdi, img')) {
          p.style.display = 'none';
          mutated = true;
          const prev = p.previousElementSibling;
          if (prev && prev.tagName === 'P' && !(prev.textContent || '').trim() && !prev.querySelector('bdi, img')) {
            prev.style.display = 'none';
          }
        }
      }

      if (mutated) {
        contentEl.dataset.agyNotionCleaned = '1';
        mountCollapsibleContextCard(contentEl, meta);
        requestAnimationFrame(() => {
          if (contentEl.scrollHeight <= contentEl.clientHeight + 4) {
            contentEl.style.maskImage = 'none';
            contentEl.style.webkitMaskImage = 'none';
            contentEl.style.cursor = 'auto';
            contentEl.removeAttribute('tabindex');
          }
        });
      }
    }
  }

  function openExternalSafely(url) {
    if (!url) return;
    if (window.__agyNotionSidebarIPC && typeof window.__agyNotionSidebarIPC.openExternal === 'function') {
      void window.__agyNotionSidebarIPC.openExternal(url);
      return;
    }
    try {
      window.open(url, '_blank', 'noopener,noreferrer');
    } catch {}
  }

  function setupListeners() {
    navClickHandler = (e) => {
      if (state.isProgrammaticNav || !state.active) return;
      const target = e.target;
      if (!(target instanceof Element)) return;
      if (target.closest(`#${NAV_ID}`) || target.closest(`#${CHROME_ID}`)) return;

      const clickedNav = target.closest(
        '[data-testid="sidebar-navigation-items"] a, [data-testid="sidebar-navigation-items"] button, .agy-sidebar-row, [data-testid="new-conversation-button"]'
      );
      if (clickedNav) {
        closeNotionView();
      }
    };
    document.addEventListener('click', navClickHandler, true);

    auxToggleClickHandler = (e) => {
      if (!state.active) return;
      const target = e.target;
      if (!(target instanceof Element)) return;
      const toggleBtn = target.closest(
        '[data-testid="toggle-aux-sidebar"], [data-testid="mobile-toggle-aux-sidebar"]'
      );
      if (!toggleBtn) return;
      e.preventDefault();
      e.stopPropagation();
      if (typeof e.stopImmediatePropagation === 'function') {
        e.stopImmediatePropagation();
      }
      void openChatPaneInMode(state.layout === 'split' ? 'dock' : 'split');
    };
    document.addEventListener('click', auxToggleClickHandler, true);

    // 监听右侧分栏 / 悬浮小窗内原生输入框提交，按需智能附带当前左侧打开的 Notion 页面信息
    nativeKeydownHandler = (e) => {
      if (!state.active || state.bypassNativeIntercept || state.injectingNativeSend || state.submitting) return;
      if (state.layout !== 'split' && state.layout !== 'float') return;
      if (e.key !== 'Enter' || e.shiftKey || e.isComposing || e.keyCode === 229) return;

      const target = e.target;
      if (!(target instanceof Element)) return;
      if (target.closest(`#${STAGE_ID}`) || target.closest(`#${CHROME_ID}`)) return;
      const editor = target.closest(
        '.agy-notion-main-col [data-lexical-editor="true"], .agy-notion-main-col [contenteditable="true"][role="textbox"], .agy-notion-main-col textarea'
      );
      if (!editor) return;
      if (isNativeAutocompletePopupOpen()) return;

      const sendBtn = findComposerSendButton(editor);
      if (!sendBtn || sendBtn.disabled) return;

      const curPath = window.location.pathname || '';
      const convoKey = isValidConvoPath(curPath) ? curPath : DRAFT_TAB_KEY;
      const editorTxt = (editor.innerText || editor.textContent || editor.value || '').trim();
      if (!editorTxt) return;

      state.hasActiveNotionChat = true;
      state.notionConvoTrackingArmed = true;

      if (!shouldInjectCurrentPageContext(convoKey) || editorTxt.includes('[Notion Page Context:')) {
        if (convoKey === DRAFT_TAB_KEY) {
          watchAndBindNewConversation(state.currentView === 'page' ? state.currentPage?.id || '' : '');
        }
        return;
      }

      e.preventDefault();
      e.stopPropagation();
      if (typeof e.stopImmediatePropagation === 'function') {
        e.stopImmediatePropagation();
      }
      void interceptAndSubmitNativeComposer(editor);
    };
    document.addEventListener('keydown', nativeKeydownHandler, true);

    nativeSendClickHandler = (e) => {
      if (!state.active || state.bypassNativeIntercept || state.injectingNativeSend || state.submitting) return;
      if (state.layout !== 'split' && state.layout !== 'float') return;

      const target = e.target;
      if (!(target instanceof Element)) return;
      if (target.closest(`#${STAGE_ID}`) || target.closest(`#${CHROME_ID}`)) return;
      const sendBtn = target.closest('.agy-notion-main-col [data-testid="send-button"], .agy-notion-main-col .agy-send-button');
      if (!sendBtn || sendBtn.disabled) return;

      const editor = findMainComposerEditor();
      if (!editor) return;
      const editorTxt = (editor.innerText || editor.textContent || editor.value || '').trim();
      if (!editorTxt) return;

      const curPath = window.location.pathname || '';
      const convoKey = isValidConvoPath(curPath) ? curPath : DRAFT_TAB_KEY;
      state.hasActiveNotionChat = true;
      state.notionConvoTrackingArmed = true;

      if (!shouldInjectCurrentPageContext(convoKey) || editorTxt.includes('[Notion Page Context:')) {
        if (convoKey === DRAFT_TAB_KEY) {
          watchAndBindNewConversation(state.currentView === 'page' ? state.currentPage?.id || '' : '');
        }
        return;
      }

      e.preventDefault();
      e.stopPropagation();
      if (typeof e.stopImmediatePropagation === 'function') {
        e.stopImmediatePropagation();
      }
      void interceptAndSubmitNativeComposer(editor);
    };
    document.addEventListener('click', nativeSendClickHandler, true);

    stageActivateHandler = (e) => {
      const src = e?.detail?.source;
      if (src && src !== 'notion' && state.active) {
        closeNotionView();
      }
    };
    window.addEventListener('agy:stage-activate', stageActivateHandler);

    windowResizeHandler = () => {
      if (state.active) syncFloatGeometry();
    };
    window.addEventListener('resize', windowResizeHandler);

    docPointerHandler = (e) => {
      const target = e.target;
      if (!(target instanceof Element)) return;
      const stage = document.getElementById(STAGE_ID);
      if (stage) {
        if (state.quickMenuOpen) {
          const qw = stage.querySelector('[data-role="quick-wrap"]');
          if (qw && !qw.contains(target)) closeQuickMenu();
        }
        if (state.modelMenuOpen) {
          const mw = stage.querySelector('[data-role="model-wrap"]');
          if (mw && !mw.contains(target)) closeModelMenu();
        }
        if (state.dockGripMenuOpen) {
          const dh = stage.querySelector('[data-role="dock-drag-handle"]');
          if (dh && !dh.contains(target)) closeDockGripMenu();
        }
      }
      if (state.chromeMenuMode || state.convoPickerOpen) {
        const chrome = document.getElementById(CHROME_ID);
        if (chrome && !chrome.contains(target)) {
          renderChromeDropdownMenu('');
          closeConvoPicker();
        }
      }
    };
    document.addEventListener('pointerdown', docPointerHandler);

    messageHandler = (event) => {
      const data = event.data;
      if (!data || typeof data !== 'object') return;
      if (data.type === 'AGY_NOTION_PAGE_CHANGE') {
        state.currentView = data.view || 'home';
        state.currentPage = data.page || null;
        if (state.currentView !== 'page') {
          state.selectedQuote = '';
          state.homeDockExpanded = false;
        }
        updateDockUI();
        syncChatChromeUI();
      } else if (data.type === 'AGY_NOTION_SELECTION_CHANGE') {
        state.selectedQuote = String(data.text || '').trim();
        updateDockUI();
        syncChatChromeUI();
      } else if (data.type === 'AGY_NOTION_TOGGLE_SPLIT') {
        void openChatPaneInMode(state.layout === 'split' ? 'dock' : 'split');
      } else if (data.type === 'AGY_NOTION_OPEN_EXTERNAL' && data.url) {
        openExternalSafely(data.url);
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
        sanitizeNotionUserMessageBubbles();
        if (state.active) {
          ensureStageContainers();
          if (
            state.notionConvoTrackingArmed &&
            !state.restoringConvo &&
            !state.isProgrammaticNav &&
            isValidConvoPath(window.location.pathname || '')
          ) {
            recordActiveNotionConvo(window.location.pathname, state.currentPage?.id || '');
          }
          syncFloatGeometry();
          syncModelButtonLabel();
          updateDockUI();
          syncChatChromeUI();
          syncNativeToggleButtonState();
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
    sanitizeNotionUserMessageBubbles();
    setupListeners();
  }

  window.__AGY_NOTION_SIDEBAR_CLOSE__ = closeNotionView;
  window.__AGY_NOTION_SIDEBAR_CLEANUP__ = (isReload = false) => {
    try {
      layoutObserver?.disconnect();
      themeObserver?.disconnect();
    } catch {}
    layoutObserver = null;
    themeObserver = null;

    if (navClickHandler) document.removeEventListener('click', navClickHandler, true);
    if (auxToggleClickHandler) document.removeEventListener('click', auxToggleClickHandler, true);
    if (nativeKeydownHandler) document.removeEventListener('keydown', nativeKeydownHandler, true);
    if (nativeSendClickHandler) document.removeEventListener('click', nativeSendClickHandler, true);
    if (docPointerHandler) document.removeEventListener('pointerdown', docPointerHandler);
    if (messageHandler) window.removeEventListener('message', messageHandler);
    if (stageActivateHandler) window.removeEventListener('agy:stage-activate', stageActivateHandler);
    if (windowResizeHandler) window.removeEventListener('resize', windowResizeHandler);

    document.body.classList.remove('agy-notion-dragging');
    document.body.removeAttribute('data-agy-notion-submitting');
    document.body.removeAttribute('data-agy-notion-active');
    document.body.removeAttribute('data-agy-notion-layout');
    document.body.style.removeProperty('--agy-stage-cx');
    document.body.style.removeProperty('--agy-dock-x');
    document.body.style.removeProperty('--agy-dock-y');
    document.body.style.removeProperty('--agy-float-w');
    document.body.style.removeProperty('--agy-float-h');

    document.querySelector('.agy-notion-sheet-row')?.classList.remove('agy-notion-sheet-row');
    document.querySelector('.agy-notion-main-col')?.classList.remove('agy-notion-main-col');

    document.getElementById(NAV_ID)?.remove();
    document.getElementById(STAGE_ID)?.remove();
    document.getElementById(RESIZER_ID)?.remove();
    document.getElementById(CHROME_ID)?.remove();
    document.getElementById(FLOAT_RESIZERS_ID)?.remove();
    document.getElementById('agy-notion-split-chat-bar')?.remove();
    document.getElementById(FALLBACK_TOGGLE_ID)?.remove();
    document.getElementById(GRIP_TOOLTIP_ID)?.remove();
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
