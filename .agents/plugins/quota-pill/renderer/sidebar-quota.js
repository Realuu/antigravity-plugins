/**
 * Antigravity Quota Pill — 左下角 Codex 风格额度显示组件
 *
 * 视觉与交互设计：
 * 1. 界面左下角停靠 32x32 圆角方块图标按钮（上下双段非对称进度圆弧 + 中心圆角菱形），圆环外径占白色正方形净区域边长 90%，自动随浅色/深色主题切换；
 * 2. 上圆弧（108°）实时代表 Gemini 5 小时额度余量，下圆弧（204°）实时代表 Gemini 周额度余量，低额度时各自独立触发琥珀/红色预警；
 * 3. 鼠标悬停圆环上部/下部在右侧弹出黑色胶囊提示（分别展示 Gemini 5 小时 / 周额度余量并高亮对应圆弧），点击正方形区域展开/收起上方详细额度卡片；
 * 4. 优先通过 Electron IPC (`__agyQuotaPillIPC`) 获取数据，自动回退到本地桥接端口 `http://127.0.0.1:45790/api/quota`。
 */
(function installAntigravityQuotaPill() {
  if (window.__AGY_QUOTA_PILL_LOCKED__ && !window.__AGY_QUOTA_PILL_FORCE_RELOAD__) {
    return;
  }
  window.__AGY_QUOTA_PILL_FORCE_RELOAD__ = false;
  window.__AGY_QUOTA_PILL_LOCKED__ = true;

  const nativeQSA =
    typeof window.__AGY_NATIVE_QSA__ === 'function'
      ? window.__AGY_NATIVE_QSA__
      : document.querySelectorAll.bind(document);

  if (typeof window.__AGY_QUOTA_PILL_CLEANUP__ === 'function') {
    try {
      window.__AGY_QUOTA_PILL_CLEANUP__();
    } catch {}
  }

  document.getElementById('agy-codex-quota-dock')?.remove();
  document.getElementById('agy-codex-quota-hover-tip')?.remove();
  document.getElementById('agy-codex-quota-popover')?.remove();
  document.getElementById('agy-quota-pill-styles')?.remove();

  window.__AGY_QUOTA_PILL_INSTALLED__ = true;
  window.__AGY_QUOTA_PILL_VERSION__ = '1.4.0';

  const RING_CENTER = 15;
  const RING_RADIUS = 12.3;
  const RING_STROKE = 2.4;
  // 上圆弧：-144° 顺时针至 -36°（跨度 108°）
  const UPPER_ARC_D = 'M 5.05 7.77 A 12.3 12.3 0 0 1 24.95 7.77';
  const UPPER_ARC_LEN = RING_RADIUS * ((108 * Math.PI) / 180);
  // 下圆弧：-168° 逆时针绕底部至 -12°（跨度 204°）
  const LOWER_ARC_D = 'M 2.97 12.44 A 12.3 12.3 0 1 0 27.03 12.44';
  const LOWER_ARC_LEN = RING_RADIUS * ((204 * Math.PI) / 180);

  let latestQuotaData = null;
  let lastFetchAt = 0;
  let popoverPinned = false;
  let hoverZone = null;
  let latestTipTexts = {
    upper: 'Gemini 5 小时 · 正在获取',
    lower: 'Gemini 周额度 · 正在获取',
  };
  let pollTimer = null;
  let layoutRaf = false;

  function detectThemeMode() {
    try {
      const rootEl = document.documentElement;
      if (rootEl?.classList?.contains('dark') || document.body?.classList?.contains('dark')) {
        return 'dark';
      }
      const candidates = [
        document.body,
        document.documentElement,
        document.getElementById('root'),
        document.querySelector('#root > div'),
      ].filter(Boolean);
      for (const el of candidates) {
        const bg = getComputedStyle(el).backgroundColor || '';
        const m = bg.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([\d.]+))?/i);
        if (m) {
          const alpha = m[4] !== undefined ? Number(m[4]) : 1;
          if (alpha > 0.05) {
            const lum = 0.2126 * Number(m[1]) + 0.7152 * Number(m[2]) + 0.0722 * Number(m[3]);
            return lum >= 128 ? 'light' : 'dark';
          }
        }
      }
      const fg = getComputedStyle(document.body).color || '';
      const fm = fg.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
      if (fm) {
        const fgLum = 0.2126 * Number(fm[1]) + 0.7152 * Number(fm[2]) + 0.0722 * Number(fm[3]);
        return fgLum < 128 ? 'light' : 'dark';
      }
    } catch {}
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches
      ? 'light'
      : 'dark';
  }

  function injectStyles() {
    if (document.getElementById('agy-quota-pill-styles')) return;
    const style = document.createElement('style');
    style.id = 'agy-quota-pill-styles';
    style.textContent = `
      .agy-codex-quota-dock {
        position: fixed;
        left: 8px;
        bottom: 8px;
        z-index: 99990;
        user-select: none;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Microsoft YaHei", sans-serif;
        transition: left 0.16s ease, bottom 0.16s ease, opacity 0.16s ease;
      }
      .agy-codex-quota-btn {
        box-sizing: border-box;
        width: 32px;
        height: 32px;
        padding: 0;
        border-radius: 9px;
        border: 1px solid rgba(15, 23, 42, 0.08);
        background: #ffffff;
        color: #52525b;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        outline: none;
        box-shadow: 0 1px 3px rgba(15, 23, 42, 0.06);
        transition: background-color 0.15s ease, color 0.15s ease, border-color 0.15s ease, transform 0.12s ease;
      }
      .agy-codex-quota-btn:hover,
      .agy-codex-quota-btn.is-active {
        background: #f8fafc;
        color: #18181b;
        border-color: rgba(15, 23, 42, 0.14);
      }
      .agy-codex-quota-btn:active {
        transform: scale(0.96);
      }
      .agy-codex-quota-dock[data-theme="dark"] .agy-codex-quota-btn {
        background: rgba(39, 41, 49, 0.92);
        border-color: rgba(255, 255, 255, 0.1);
        color: #a1a1aa;
        box-shadow: 0 2px 6px rgba(0, 0, 0, 0.28);
      }
      .agy-codex-quota-dock[data-theme="dark"] .agy-codex-quota-btn:hover,
      .agy-codex-quota-dock[data-theme="dark"] .agy-codex-quota-btn.is-active {
        background: rgba(54, 57, 68, 0.98);
        color: #f4f4f5;
        border-color: rgba(255, 255, 255, 0.18);
      }
      .agy-codex-quota-svg {
        width: 30px;
        height: 30px;
        display: block;
      }
      .agy-codex-quota-track {
        stroke: currentColor;
        opacity: 0.22;
        transition: opacity 0.14s ease, stroke 0.14s ease;
      }
      .agy-codex-quota-progress {
        stroke: #52525b;
        opacity: 0.92;
        transition: opacity 0.14s ease, stroke 0.14s ease;
      }
      .agy-codex-quota-dock[data-theme="dark"] .agy-codex-quota-progress {
        stroke: #e4e4e7;
      }
      .agy-codex-quota-progress[data-level="warn"] {
        stroke: #d97706;
      }
      .agy-codex-quota-progress[data-level="danger"] {
        stroke: #dc2626;
      }
      .agy-codex-quota-dock[data-theme="dark"] .agy-codex-quota-progress[data-level="warn"] {
        stroke: #f59e0b;
      }
      .agy-codex-quota-dock[data-theme="dark"] .agy-codex-quota-progress[data-level="danger"] {
        stroke: #f87171;
      }
      .agy-codex-quota-diamond {
        fill: currentColor;
        opacity: 0.42;
        transition: opacity 0.14s ease;
      }

      /* 上下分区悬停高亮：聚焦当前半环，柔和弱化另一半环与菱形 */
      .agy-codex-quota-btn[data-hover-zone="upper"] .agy-codex-quota-progress[data-arc="upper"],
      .agy-codex-quota-btn[data-hover-zone="lower"] .agy-codex-quota-progress[data-arc="lower"] {
        opacity: 1;
      }
      .agy-codex-quota-btn[data-hover-zone="upper"] .agy-codex-quota-track[data-arc="upper"],
      .agy-codex-quota-btn[data-hover-zone="lower"] .agy-codex-quota-track[data-arc="lower"] {
        opacity: 0.26;
      }
      .agy-codex-quota-btn[data-hover-zone="upper"] .agy-codex-quota-progress[data-arc="lower"],
      .agy-codex-quota-btn[data-hover-zone="lower"] .agy-codex-quota-progress[data-arc="upper"] {
        opacity: 0.32;
      }
      .agy-codex-quota-btn[data-hover-zone="upper"] .agy-codex-quota-track[data-arc="lower"],
      .agy-codex-quota-btn[data-hover-zone="lower"] .agy-codex-quota-track[data-arc="upper"] {
        opacity: 0.13;
      }
      .agy-codex-quota-btn[data-hover-zone] .agy-codex-quota-diamond {
        opacity: 0.25;
      }

      /* 右侧黑色圆角胶囊悬停提示 */
      .agy-codex-quota-hover-tip {
        position: fixed;
        z-index: 99998;
        height: 30px;
        padding: 0 13px;
        border-radius: 999px;
        background: #0f0f11;
        color: #ffffff;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Microsoft YaHei", sans-serif;
        font-size: 12.5px;
        font-weight: 500;
        font-variant-numeric: tabular-nums;
        display: inline-flex;
        align-items: center;
        white-space: nowrap;
        pointer-events: none;
        box-shadow: 0 6px 18px rgba(0, 0, 0, 0.2);
        opacity: 0;
        transform: translateX(-3px);
        transition: opacity 0.12s ease, transform 0.12s ease;
      }
      .agy-codex-quota-hover-tip[data-theme="dark"] {
        background: #111216;
        border: 1px solid rgba(255, 255, 255, 0.13);
      }
      .agy-codex-quota-hover-tip.is-visible {
        opacity: 1;
        transform: translateX(0);
      }

      /* 弹出详情卡片：1:1 Codex 极简卡片质感 */
      .agy-codex-quota-popover {
        position: fixed;
        z-index: 99999;
        width: 286px;
        padding: 14px 16px;
        border-radius: 16px;
        background: #ffffff;
        color: #18181b;
        border: 1px solid rgba(15, 23, 42, 0.08);
        box-shadow: 0 12px 32px rgba(15, 23, 42, 0.1), 0 2px 8px rgba(15, 23, 42, 0.04);
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Microsoft YaHei", sans-serif;
        opacity: 0;
        transform: translateY(6px) scale(0.985);
        pointer-events: none;
        transition: opacity 0.15s ease, transform 0.15s ease;
      }
      .agy-codex-quota-popover[data-theme="dark"] {
        background: #1b1d24;
        color: #f4f4f5;
        border-color: rgba(255, 255, 255, 0.11);
        box-shadow: 0 14px 36px rgba(0, 0, 0, 0.48), 0 2px 8px rgba(0, 0, 0, 0.28);
      }
      .agy-codex-quota-popover.is-open {
        opacity: 1;
        transform: translateY(0) scale(1);
        pointer-events: auto;
      }
      .agy-quota-pop-list {
        display: flex;
        flex-direction: column;
      }
      .agy-quota-group {
        display: flex;
        flex-direction: column;
        gap: 9px;
      }
      .agy-quota-group-title {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        font-size: 12px;
        font-weight: 500;
        color: #71717a;
        line-height: 1.3;
      }
      .agy-codex-quota-popover[data-theme="dark"] .agy-quota-group-title {
        color: #a1a1aa;
      }
      .agy-quota-group-divider {
        height: 1px;
        background: rgba(15, 23, 42, 0.08);
        margin: 10px 0;
      }
      .agy-codex-quota-popover[data-theme="dark"] .agy-quota-group-divider {
        background: rgba(255, 255, 255, 0.1);
      }
      .agy-quota-pop-row {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 12px;
      }
      .agy-quota-pop-left {
        display: flex;
        flex-direction: column;
        gap: 2px;
        min-width: 0;
      }
      .agy-quota-pop-label {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        font-size: 13.5px;
        font-weight: 450;
        color: inherit;
        line-height: 1.35;
      }
      .agy-quota-active-dot {
        width: 5px;
        height: 5px;
        border-radius: 999px;
        background: #10b981;
        flex-shrink: 0;
      }
      .agy-quota-pop-sub {
        font-size: 11.5px;
        color: #71717a;
        line-height: 1.3;
      }
      .agy-codex-quota-popover[data-theme="dark"] .agy-quota-pop-sub {
        color: #a1a1aa;
      }
      .agy-quota-pop-value {
        font-size: 13.5px;
        font-weight: 500;
        font-variant-numeric: tabular-nums;
        white-space: nowrap;
        line-height: 1.35;
      }
      .agy-quota-pop-value[data-level="warn"] {
        color: #d97706;
      }
      .agy-quota-pop-value[data-level="danger"] {
        color: #dc2626;
      }
      .agy-codex-quota-popover[data-theme="dark"] .agy-quota-pop-value[data-level="warn"] {
        color: #fbbf24;
      }
      .agy-codex-quota-popover[data-theme="dark"] .agy-quota-pop-value[data-level="danger"] {
        color: #f87171;
      }
      button[data-agy-quota-shifted="true"] {
        width: auto !important;
        flex: 0 0 auto !important;
        flex-grow: 0 !important;
        align-self: flex-end !important;
        margin-left: auto !important;
        justify-content: flex-end !important;
        padding-left: 10px !important;
        padding-right: 8px !important;
      }
    `;
    document.head.appendChild(style);
  }

  function detectActiveModelLabel() {
    try {
      const footers = nativeQSA('.agy-composer-footer');
      for (const footerEl of footers) {
        const fiberKey = Object.keys(footerEl).find(
          (k) => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$')
        );
        if (!fiberKey) continue;
        let cur = footerEl[fiberKey];
        let depth = 0;
        while (cur && depth < 35) {
          const props = cur.memoizedProps;
          if (props && props.currentModelConfig && typeof props.currentModelConfig.label === 'string') {
            return props.currentModelConfig.label;
          }
          cur = cur.return;
          depth++;
        }
      }
      const modelBtn = document.querySelector('button[aria-label*="选择模型"], button[aria-label*="Select model"]');
      if (modelBtn && modelBtn.textContent) {
        return modelBtn.textContent.trim();
      }
    } catch {}
    return '';
  }

  function getLevelFromPct(pct) {
    if (typeof pct !== 'number' || !Number.isFinite(pct)) return '';
    if (pct <= 10) return 'danger';
    if (pct <= 30) return 'warn';
    return '';
  }

  function clearShiftedSettings(exceptBtn = null) {
    nativeQSA('[data-agy-quota-shifted]').forEach((el) => {
      if (el !== exceptBtn) {
        el.removeAttribute('data-agy-quota-shifted');
      }
    });
  }

  function computeDockPosition() {
    const vh = window.innerHeight || 700;
    const settingsBtn = [...nativeQSA('button')].find((b) => {
      const t = (b.innerText || '').trim();
      return t === '设置' || t === 'Settings';
    });

    if (settingsBtn && settingsBtn.parentElement) {
      const parentEl = settingsBtn.parentElement;
      const parentRect = parentEl.getBoundingClientRect();
      if (parentRect.width >= 120 && parentRect.left < 280 && parentRect.bottom > vh - 120) {
        clearShiftedSettings(settingsBtn);
        if (settingsBtn.getAttribute('data-agy-quota-shifted') !== 'true') {
          settingsBtn.setAttribute('data-agy-quota-shifted', 'true');
        }
        const btnRect = settingsBtn.getBoundingClientRect();
        if (btnRect.height > 0) {
          const padLeft = parseFloat(getComputedStyle(parentEl).paddingLeft) || 8;
          return {
            left: Math.max(6, Math.round(parentRect.left + padLeft)),
            bottom: Math.max(6, Math.round(vh - btnRect.bottom)),
          };
        }
      }
    }

    clearShiftedSettings(null);
    return { left: 12, bottom: 14 };
  }

  function updateDockPlacement() {
    const dock = document.getElementById('agy-codex-quota-dock');
    if (!dock) return;
    const theme = detectThemeMode();
    dock.setAttribute('data-theme', theme);
    const pop = document.getElementById('agy-codex-quota-popover');
    if (pop) pop.setAttribute('data-theme', theme);
    const tip = document.getElementById('agy-codex-quota-hover-tip');
    if (tip) tip.setAttribute('data-theme', theme);

    const pos = computeDockPosition();
    dock.style.left = `${pos.left}px`;
    dock.style.bottom = `${pos.bottom}px`;

    if (tip && tip.classList.contains('is-visible')) {
      positionHoverTip(tip, dock);
    }
    if (pop && pop.classList.contains('is-open')) {
      positionPopover(pop, dock);
    }
  }

  function getOrCreateHoverTip() {
    let tip = document.getElementById('agy-codex-quota-hover-tip');
    if (tip) return tip;

    tip = document.createElement('div');
    tip.id = 'agy-codex-quota-hover-tip';
    tip.className = 'agy-codex-quota-hover-tip no-focus-agent-input';
    tip.setAttribute('data-theme', detectThemeMode());
    tip.setAttribute('role', 'tooltip');
    document.body.appendChild(tip);
    return tip;
  }

  function positionHoverTip(tip, dock) {
    const rect = dock.getBoundingClientRect();
    const tipHeight = tip.offsetHeight || 30;
    const tipWidth = tip.offsetWidth || 160;
    let left = rect.right + 7;
    if (left + tipWidth > window.innerWidth - 10) {
      left = Math.max(10, window.innerWidth - tipWidth - 10);
    }
    const top = Math.round(rect.top + (rect.height - tipHeight) / 2);
    tip.style.left = `${Math.round(left)}px`;
    tip.style.top = `${Math.max(8, top)}px`;
  }

  function setHoverZone(zone) {
    const dock = document.getElementById('agy-codex-quota-dock');
    const btn = dock && dock.querySelector('.agy-codex-quota-btn');
    const pop = document.getElementById('agy-codex-quota-popover');

    if (zone && pop && pop.classList.contains('is-open')) {
      zone = null;
    }

    hoverZone = zone || null;
    if (btn) {
      if (hoverZone) {
        btn.setAttribute('data-hover-zone', hoverZone);
      } else {
        btn.removeAttribute('data-hover-zone');
      }
    }

    const tip = getOrCreateHoverTip();
    tip.setAttribute('data-theme', detectThemeMode());
    if (!hoverZone || !dock) {
      tip.classList.remove('is-visible');
      return;
    }

    tip.textContent = hoverZone === 'upper' ? latestTipTexts.upper : latestTipTexts.lower;
    positionHoverTip(tip, dock);
    tip.classList.add('is-visible');
  }

  function createDockButton() {
    let dock = document.getElementById('agy-codex-quota-dock');
    if (dock) return dock;

    dock = document.createElement('div');
    dock.id = 'agy-codex-quota-dock';
    dock.className = 'agy-codex-quota-dock no-focus-agent-input';
    dock.setAttribute('data-theme', detectThemeMode());

    dock.innerHTML = `
      <button type="button" class="agy-codex-quota-btn" data-testid="codex-quota-pill" aria-label="模型额度">
        <svg class="agy-codex-quota-svg" viewBox="0 0 30 30" aria-hidden="true">
          <path
            class="agy-codex-quota-track"
            data-arc="upper"
            d="${UPPER_ARC_D}"
            fill="none"
            stroke-width="${RING_STROKE}"
            stroke-linecap="round"
          ></path>
          <path
            class="agy-codex-quota-track"
            data-arc="lower"
            d="${LOWER_ARC_D}"
            fill="none"
            stroke-width="${RING_STROKE}"
            stroke-linecap="round"
          ></path>
          <path
            class="agy-codex-quota-progress"
            data-arc="upper"
            d="${UPPER_ARC_D}"
            fill="none"
            stroke-width="${RING_STROKE}"
            stroke-linecap="round"
            stroke-dasharray="${UPPER_ARC_LEN.toFixed(2)} ${UPPER_ARC_LEN.toFixed(2)}"
          ></path>
          <path
            class="agy-codex-quota-progress"
            data-arc="lower"
            d="${LOWER_ARC_D}"
            fill="none"
            stroke-width="${RING_STROKE}"
            stroke-linecap="round"
            stroke-dasharray="${LOWER_ARC_LEN.toFixed(2)} ${LOWER_ARC_LEN.toFixed(2)}"
          ></path>
          <rect
            class="agy-codex-quota-diamond"
            x="11"
            y="11"
            width="8"
            height="8"
            rx="1.9"
            transform="rotate(45 ${RING_CENTER} ${RING_CENTER})"
          ></rect>
        </svg>
      </button>
    `;

    const btn = dock.querySelector('.agy-codex-quota-btn');
    const handleHoverMove = (e) => {
      const pop = document.getElementById('agy-codex-quota-popover');
      if (pop && pop.classList.contains('is-open')) {
        setHoverZone(null);
        return;
      }
      const rect = btn.getBoundingClientRect();
      if (!rect.height) return;
      const relY = (e.clientY - rect.top) / rect.height;
      setHoverZone(relY < 0.48 ? 'upper' : 'lower');
    };

    btn.addEventListener('mouseenter', handleHoverMove);
    btn.addEventListener('mousemove', handleHoverMove);
    btn.addEventListener('mouseleave', () => {
      setHoverZone(null);
    });
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      setHoverZone(null);
      const pop = document.getElementById('agy-codex-quota-popover');
      if (pop && pop.classList.contains('is-open')) {
        hidePopoverImmediate();
      } else {
        openPopover(true);
      }
    });

    document.body.appendChild(dock);
    updateDockPlacement();
    return dock;
  }

  function getOrCreatePopover() {
    let pop = document.getElementById('agy-codex-quota-popover');
    if (pop) return pop;

    pop = document.createElement('div');
    pop.id = 'agy-codex-quota-popover';
    pop.className = 'agy-codex-quota-popover no-focus-agent-input';
    pop.setAttribute('data-theme', detectThemeMode());
    pop.innerHTML = `<div class="agy-quota-pop-list" data-role="list"></div>`;

    const onDocPointerDown = (e) => {
      if (!pop.classList.contains('is-open')) return;
      if (pop.contains(e.target) || e.target.closest('#agy-codex-quota-dock')) return;
      hidePopoverImmediate();
    };
    const onDocKeyDown = (e) => {
      if (e.key === 'Escape' && pop.classList.contains('is-open')) {
        hidePopoverImmediate();
      }
    };
    document.addEventListener('pointerdown', onDocPointerDown);
    document.addEventListener('keydown', onDocKeyDown);
    pop._cleanupDocListener = () => {
      document.removeEventListener('pointerdown', onDocPointerDown);
      document.removeEventListener('keydown', onDocKeyDown);
    };

    document.body.appendChild(pop);
    return pop;
  }

  function positionPopover(pop, dock) {
    const rect = dock.getBoundingClientRect();
    const popWidth = 286;
    const popHeight = pop.offsetHeight || 150;

    let left = rect.left;
    if (left + popWidth > window.innerWidth - 12) {
      left = window.innerWidth - popWidth - 12;
    }
    if (left < 10) left = 10;

    let top = rect.top - popHeight - 8;
    if (top < 12) {
      top = rect.bottom + 8;
    }

    pop.style.left = `${Math.round(left)}px`;
    pop.style.top = `${Math.round(top)}px`;
  }

  function normalizeGroupsFallback(data) {
    if (Array.isArray(data?.groups) && data.groups.length > 0) {
      return data.groups;
    }
    const items = Array.isArray(data?.items) ? data.items : [];
    if (items.length === 0) return [];
    return [
      {
        id: 'default',
        title: '模型额度',
        keywords: [],
        remainingPercent:
          typeof data?.primaryRemainingPercent === 'number' ? data.primaryRemainingPercent : 100,
        buckets: items.map((x) => ({
          id: x.id,
          label: x.label,
          remainingPercent: x.remainingPercent,
          valueText: x.valueText,
          resetText: x.resetText,
          resetTime: x.resetTime || null,
        })),
      },
    ];
  }

  function resolveActiveGroup(groups, activeModelLabel) {
    if (!Array.isArray(groups) || groups.length === 0) return null;
    if (activeModelLabel) {
      const lower = activeModelLabel.toLowerCase();
      const matched = groups.find(
        (g) =>
          Array.isArray(g.keywords) &&
          g.keywords.some((kw) => lower.includes(String(kw).toLowerCase()))
      );
      if (matched) return matched;
    }
    return groups[0];
  }

  function extractGeminiQuota(groups, data) {
    const geminiGroup =
      groups.find(
        (g) => g.id === 'gemini' || String(g.title || '').toLowerCase().includes('gemini')
      ) ||
      groups[0] ||
      null;
    const buckets = Array.isArray(geminiGroup?.buckets) ? geminiGroup.buckets : [];

    const bucket5h =
      buckets.find(
        (b) => b.window === '5h' || /5h|5\s*小时/i.test(`${b.id || ''} ${b.label || ''}`)
      ) ||
      buckets[0] ||
      null;
    const bucketWeekly =
      buckets.find(
        (b) => b.window === 'weekly' || /weekly|周|7\s*天/i.test(`${b.id || ''} ${b.label || ''}`)
      ) ||
      buckets[1] ||
      null;

    const fallbackPct =
      typeof data?.primaryRemainingPercent === 'number' ? data.primaryRemainingPercent : 100;
    const upperPct =
      typeof bucket5h?.remainingPercent === 'number' ? bucket5h.remainingPercent : fallbackPct;
    const lowerPct =
      typeof bucketWeekly?.remainingPercent === 'number' ? bucketWeekly.remainingPercent : upperPct;

    return {
      upperPct,
      lowerPct,
      upperTip:
        typeof bucket5h?.remainingPercent === 'number'
          ? `Gemini 5 小时 · 剩余 ${upperPct}%`
          : `Gemini 5 小时 · ${bucket5h?.valueText || '暂不可用'}`,
      lowerTip:
        typeof bucketWeekly?.remainingPercent === 'number'
          ? `Gemini 周额度 · 剩余 ${lowerPct}%`
          : `Gemini 周额度 · ${bucketWeekly?.valueText || '暂不可用'}`,
    };
  }

  function applyArcStroke(pathEl, pct, totalLen) {
    if (!pathEl) return;
    const clamped = Math.max(0, Math.min(100, Number(pct) || 0));
    if (clamped <= 0.5) {
      pathEl.style.opacity = '0';
      pathEl.setAttribute('stroke-dasharray', `0 ${totalLen.toFixed(2)}`);
    } else {
      pathEl.style.opacity = '';
      const len = (clamped / 100) * totalLen;
      pathEl.setAttribute('stroke-dasharray', `${len.toFixed(2)} ${totalLen.toFixed(2)}`);
    }
    const level = getLevelFromPct(clamped);
    if (level) {
      pathEl.setAttribute('data-level', level);
    } else {
      pathEl.removeAttribute('data-level');
    }
  }

  function renderUI(data) {
    injectStyles();
    const dock = createDockButton();
    const pop = getOrCreatePopover();

    if (data && data.pluginEnabled === false) {
      dock.style.display = 'none';
      setHoverZone(null);
      hidePopoverImmediate();
      return;
    }
    dock.style.display = 'block';

    const theme = detectThemeMode();
    dock.setAttribute('data-theme', theme);
    pop.setAttribute('data-theme', theme);
    const tip = document.getElementById('agy-codex-quota-hover-tip');
    if (tip) tip.setAttribute('data-theme', theme);

    const activeModelLabel = detectActiveModelLabel();
    const groups = normalizeGroupsFallback(data);
    const activeGroup = resolveActiveGroup(groups, activeModelLabel);
    const gemini = extractGeminiQuota(groups, data);

    latestTipTexts = {
      upper: gemini.upperTip,
      lower: gemini.lowerTip,
    };

    const sig = JSON.stringify({
      theme,
      upperPct: gemini.upperPct,
      lowerPct: gemini.lowerPct,
      upperTip: gemini.upperTip,
      lowerTip: gemini.lowerTip,
      activeGroupId: activeGroup?.id || '',
      groups: groups.map((g) => ({
        id: g.id,
        title: g.title,
        remainingPercent: g.remainingPercent,
        buckets: (g.buckets || []).map((b) => ({
          id: b.id,
          label: b.label,
          valueText: b.valueText,
          resetText: b.resetText,
          remainingPercent: b.remainingPercent,
        })),
      })),
    });

    if (dock._lastRenderSig === sig) {
      return;
    }
    dock._lastRenderSig = sig;

    const upperPath = dock.querySelector('.agy-codex-quota-progress[data-arc="upper"]');
    const lowerPath = dock.querySelector('.agy-codex-quota-progress[data-arc="lower"]');
    applyArcStroke(upperPath, gemini.upperPct, UPPER_ARC_LEN);
    applyArcStroke(lowerPath, gemini.lowerPct, LOWER_ARC_LEN);

    if (tip && hoverZone && tip.classList.contains('is-visible')) {
      tip.textContent = hoverZone === 'upper' ? latestTipTexts.upper : latestTipTexts.lower;
      positionHoverTip(tip, dock);
    }

    const listEl = pop.querySelector('[data-role="list"]');
    if (listEl) {
      listEl.innerHTML = '';
      if (groups.length === 0) {
        const row = document.createElement('div');
        row.className = 'agy-quota-pop-row';
        const left = document.createElement('div');
        left.className = 'agy-quota-pop-left';
        const label = document.createElement('span');
        label.className = 'agy-quota-pop-label';
        label.textContent = '暂无可用配额数据';
        left.appendChild(label);
        const val = document.createElement('span');
        val.className = 'agy-quota-pop-value';
        val.textContent = '—';
        row.appendChild(left);
        row.appendChild(val);
        listEl.appendChild(row);
      } else {
        const orderedGroups =
          activeGroup && groups.length > 1
            ? [activeGroup, ...groups.filter((g) => g !== activeGroup)]
            : groups;

        orderedGroups.forEach((group, gIdx) => {
          if (gIdx > 0) {
            const divider = document.createElement('div');
            divider.className = 'agy-quota-group-divider';
            listEl.appendChild(divider);
          }

          const groupEl = document.createElement('div');
          groupEl.className = 'agy-quota-group';

          if (orderedGroups.length > 1) {
            const titleEl = document.createElement('div');
            titleEl.className = 'agy-quota-group-title';
            if (group === activeGroup) {
              const dot = document.createElement('span');
              dot.className = 'agy-quota-active-dot';
              dot.title = activeModelLabel ? `当前模型：${activeModelLabel}` : '当前使用模型组';
              titleEl.appendChild(dot);
            }
            titleEl.appendChild(document.createTextNode(group.title || '模型额度'));
            groupEl.appendChild(titleEl);
          }

          const buckets = Array.isArray(group.buckets) ? group.buckets : [];
          for (const bucket of buckets) {
            const row = document.createElement('div');
            row.className = 'agy-quota-pop-row';

            const left = document.createElement('div');
            left.className = 'agy-quota-pop-left';

            const label = document.createElement('span');
            label.className = 'agy-quota-pop-label';
            label.textContent = bucket.label || '模型额度';
            left.appendChild(label);

            if (bucket.resetText) {
              const sub = document.createElement('span');
              sub.className = 'agy-quota-pop-sub';
              sub.textContent = bucket.resetText;
              left.appendChild(sub);
            }

            const val = document.createElement('span');
            val.className = 'agy-quota-pop-value';
            const itemLevel = getLevelFromPct(bucket.remainingPercent);
            if (itemLevel) {
              val.setAttribute('data-level', itemLevel);
            }
            val.textContent = bucket.valueText || '—';

            row.appendChild(left);
            row.appendChild(val);
            groupEl.appendChild(row);
          }

          listEl.appendChild(groupEl);
        });
      }
    }

    if (pop.classList.contains('is-open')) {
      positionPopover(pop, dock);
    }
  }

  async function fetchQuotaStatus(force = false) {
    let ipcResult = null;
    try {
      if (window.__agyQuotaPillIPC && typeof window.__agyQuotaPillIPC.getQuota === 'function') {
        const res = await window.__agyQuotaPillIPC.getQuota(Boolean(force));
        if (res && typeof res === 'object') {
          if (res.ok) return res;
          ipcResult = res;
        }
      }
    } catch {}

    try {
      const q = force ? '?refresh=1' : '';
      const resp = await fetch(`http://127.0.0.1:45790/api/quota${q}`, {
        method: 'GET',
        cache: 'no-store',
      });
      if (resp.ok) {
        const data = await resp.json();
        if (data && data.ok) return data;
        if (!ipcResult) ipcResult = data;
      }
    } catch {}
    return ipcResult;
  }

  async function refreshQuota(force = false) {
    const data = await fetchQuotaStatus(force);
    if (data) {
      latestQuotaData = data;
      lastFetchAt = Date.now();
      renderUI(data);
    } else if (!latestQuotaData) {
      renderUI({
        ok: false,
        planLabel: '本地服务未连接',
        primaryRemainingPercent: 100,
        groups: [
          {
            id: 'offline',
            title: '配额状态',
            keywords: [],
            remainingPercent: 100,
            buckets: [
              {
                id: 'offline',
                label: '配额状态',
                remainingPercent: null,
                valueText: '暂不可用',
                resetText: '请确认本地桥接服务已启动',
              },
            ],
          },
        ],
      });
    }
  }

  function openPopover(pin = true) {
    setHoverZone(null);
    if (pin) popoverPinned = true;

    const dock = createDockButton();
    const pop = getOrCreatePopover();
    updateDockPlacement();
    positionPopover(pop, dock);
    pop.classList.add('is-open');

    const btn = dock.querySelector('.agy-codex-quota-btn');
    if (btn) btn.classList.add('is-active');

    if (pin || Date.now() - lastFetchAt > 15_000) {
      void refreshQuota(pin);
    }
  }

  function hidePopoverImmediate() {
    popoverPinned = false;
    const pop = document.getElementById('agy-codex-quota-popover');
    if (pop) pop.classList.remove('is-open');
    const btn = document.querySelector('#agy-codex-quota-dock .agy-codex-quota-btn');
    if (btn) btn.classList.remove('is-active');
  }

  const onResize = () => {
    if (layoutRaf) return;
    layoutRaf = true;
    requestAnimationFrame(() => {
      layoutRaf = false;
      updateDockPlacement();
    });
  };

  const observer = new MutationObserver(() => {
    if (layoutRaf) return;
    layoutRaf = true;
    requestAnimationFrame(() => {
      layoutRaf = false;
      updateDockPlacement();
      if (latestQuotaData) {
        renderUI(latestQuotaData);
      }
    });
  });

  function start() {
    injectStyles();
    createDockButton();
    void refreshQuota(false);
    window.addEventListener('resize', onResize);
    if (document.body) {
      observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['class', 'style', 'data-theme'],
      });
    }
    pollTimer = setInterval(() => {
      void refreshQuota(false);
    }, 45_000);
  }

  window.__AGY_QUOTA_PILL_CLEANUP__ = () => {
    try {
      observer.disconnect();
    } catch {}
    window.removeEventListener('resize', onResize);
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    const pop = document.getElementById('agy-codex-quota-popover');
    if (pop) {
      pop._cleanupDocListener?.();
      pop.remove();
    }
    document.getElementById('agy-codex-quota-hover-tip')?.remove();
    document.getElementById('agy-codex-quota-dock')?.remove();
    document.getElementById('agy-quota-pill-styles')?.remove();
    clearShiftedSettings(null);
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
