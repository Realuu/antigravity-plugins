/**
 * Antigravity Context Donut — Codex 风格对话框底部 SVG 甜甜圈组件
 *
 * 自动挂载于 Antigravity 聊天输入框底部工具栏 `.agy-composer-footer` 右侧操作区（发送/麦克风按钮左侧）。
 * 支持：
 * 1. 从当前 Composer 节点的 React Fiber 自动提取精确的 `cascadeId` / `conversationId` 与模型名称；
 * 2. 双通道获取实时 Token 数据（优先通过 Electron IPC 直接读取本地 `transcript.jsonl`，回退到本地 Sidecar 45789 端口）；
 * 3. Codex 风格动态 SVG 圆环进度（绿/琥珀/红三段式语义告警）与等宽数字百分比；
 * 4. 悬停或点击展开 Codex 风格详情浮窗（支持 512k / 1M 上限一键切换、显示输入/缓存/输出明细、一键复制 `/compact`）。
 */
(function installAntigravityContextDonut() {
  // 幂等防重入锁：防止后台驻留的旧版 Sidecar 守护进程周期性重复执行本脚本导致 DOM 与浮窗被销毁重建而闪烁跳动
  if (window.__AGY_CONTEXT_DONUT_LOCKED__ && !window.__AGY_CONTEXT_DONUT_FORCE_RELOAD__) {
    return;
  }
  window.__AGY_CONTEXT_DONUT_FORCE_RELOAD__ = false;
  window.__AGY_CONTEXT_DONUT_LOCKED__ = true;

  // 保存原生 querySelectorAll，并屏蔽旧版残留闭包对 '.agy-composer-footer' 的轮询，彻底阻断旧定时器覆盖界面
  if (!window.__AGY_NATIVE_QSA__) {
    window.__AGY_NATIVE_QSA__ = document.querySelectorAll.bind(document);
    document.querySelectorAll = function (selector) {
      if (selector === '.agy-composer-footer') {
        return [];
      }
      return window.__AGY_NATIVE_QSA__(selector);
    };
  }

  // 若存在上一版热注入实例，先执行一次完整清理（销毁旧定时器、Observer、旧按钮闭包、浮窗及此前测试的底部性能栏 DOM）
  if (typeof window.__AGY_CONTEXT_DONUT_CLEANUP__ === 'function') {
    try {
      window.__AGY_CONTEXT_DONUT_CLEANUP__();
    } catch {}
  }
  document.getElementById('agy-codex-donut-popover')?.remove();
  document.getElementById('agy-context-donut-styles')?.remove();
  window.__AGY_NATIVE_QSA__('.agy-codex-donut-wrapper').forEach((el) => el.remove());
  window.__AGY_NATIVE_QSA__('.agy-composer-perf-bar').forEach((el) => el.remove());
  window.__AGY_NATIVE_QSA__('.agy-turn-duration-bar').forEach((el) => el.remove());

  try {
    localStorage.removeItem('agy_context_donut_perf_v1');
    localStorage.removeItem('agy_context_donut_perf_v2');
    delete window.__AGY_CONTEXT_DONUT_SEED__;
  } catch {}

  window.__AGY_CONTEXT_DONUT_INSTALLED__ = true;
  window.__AGY_CONTEXT_DONUT_VERSION__ = '1.8.0';

  const STORAGE_KEY_LIMIT = 'agy_context_donut_limit';
  const STORAGE_KEY_SCHEMA = 'agy_context_donut_limit_schema';
  const LIMIT_SCHEMA_VERSION = '512k_1m_v1';
  const DEFAULT_LIMIT = 512000; // 默认按 512k 计算
  const LIMITS = [
    { label: '512k', value: 512000 },
    { label: '1M', value: 1000000 },
  ];

  const RING_RADIUS = 6;
  const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS; // ~37.699

  function getCurrentLimit() {
    const stored = Number(localStorage.getItem(STORAGE_KEY_LIMIT) || DEFAULT_LIMIT);
    if (LIMITS.some((l) => l.value === stored)) {
      return stored;
    }
    return DEFAULT_LIMIT;
  }

  function setCurrentLimit(val) {
    const num = Number(val);
    if (LIMITS.some((l) => l.value === num)) {
      localStorage.setItem(STORAGE_KEY_LIMIT, String(num));
      localStorage.setItem(STORAGE_KEY_SCHEMA, LIMIT_SCHEMA_VERSION);
      return num;
    }
    return getCurrentLimit();
  }

  // 档位体系升级为 512k / 1M 或存储值不在有效档位内时，自动重置为默认 512k
  if (
    localStorage.getItem(STORAGE_KEY_SCHEMA) !== LIMIT_SCHEMA_VERSION ||
    !LIMITS.some((l) => l.value === Number(localStorage.getItem(STORAGE_KEY_LIMIT)))
  ) {
    localStorage.setItem(STORAGE_KEY_LIMIT, String(DEFAULT_LIMIT));
    localStorage.setItem(STORAGE_KEY_SCHEMA, LIMIT_SCHEMA_VERSION);
  }

  let latestUsageCache = new Map(); // conversationId -> usage object
  let activePopoverFooter = null;
  let popoverPinned = false;
  let hoverHideTimer = null;

  // 注入 Codex 风格甜甜圈与浮窗样式
  function injectStyles() {
    if (document.getElementById('agy-context-donut-styles')) return;
    const style = document.createElement('style');
    style.id = 'agy-context-donut-styles';
    style.textContent = `
      .agy-codex-donut-wrapper {
        position: relative;
        display: inline-flex;
        align-items: center;
        margin-right: 2px;
        user-select: none;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Inter, sans-serif;
      }
      .agy-codex-donut-btn {
        display: inline-flex;
        align-items: center;
        gap: 5px;
        height: 26px;
        padding: 0 7px;
        border-radius: 8px;
        border: 1px solid transparent;
        background: transparent;
        color: var(--muted-foreground, #9ca3af);
        font-size: 11.5px;
        font-weight: 500;
        font-variant-numeric: tabular-nums;
        cursor: pointer;
        transition: background-color 0.15s ease, color 0.15s ease, border-color 0.15s ease;
        outline: none;
      }
      .agy-codex-donut-btn:hover,
      .agy-codex-donut-btn.is-active {
        background: var(--secondary, rgba(255, 255, 255, 0.08));
        color: var(--foreground, #f3f4f6);
      }
      .agy-codex-donut-btn[data-level="warn"] {
        color: #f59e0b;
      }
      .agy-codex-donut-btn[data-level="danger"] {
        color: #ef4444;
      }
      .agy-codex-donut-svg {
        width: 15px;
        height: 15px;
        transform: rotate(-90deg);
        flex-shrink: 0;
      }
      .agy-codex-donut-track {
        stroke: currentColor;
        opacity: 0.22;
      }
      .agy-codex-donut-arc-cache {
        stroke: #10b981;
        transition: stroke-dashoffset 0.35s cubic-bezier(0.22, 1, 0.36, 1), stroke 0.2s ease;
      }
      .agy-codex-donut-arc-fresh {
        stroke: #38bdf8;
        transition: stroke-dasharray 0.35s cubic-bezier(0.22, 1, 0.36, 1), stroke-dashoffset 0.35s cubic-bezier(0.22, 1, 0.36, 1);
      }
      .agy-codex-donut-btn[data-level="warn"] .agy-codex-donut-arc-cache {
        stroke: #f59e0b;
      }
      .agy-codex-donut-btn[data-level="danger"] .agy-codex-donut-arc-cache {
        stroke: #ef4444;
      }
      .agy-codex-donut-popover {
        position: fixed;
        z-index: 99999;
        width: 296px;
        padding: 12px 14px;
        border-radius: 12px;
        background: var(--popover, var(--card, #181a20));
        color: var(--popover-foreground, var(--foreground, #f3f4f6));
        border: 1px solid var(--border, rgba(255, 255, 255, 0.12));
        box-shadow: 0 12px 32px rgba(0, 0, 0, 0.38), 0 2px 6px rgba(0, 0, 0, 0.2);
        font-size: 12px;
        line-height: 1.45;
        opacity: 0;
        transform: translateY(4px) scale(0.98);
        pointer-events: none;
        transition: opacity 0.14s ease, transform 0.14s ease;
      }
      .agy-codex-donut-popover.is-open {
        opacity: 1;
        transform: translateY(0) scale(1);
        pointer-events: auto;
      }
      .agy-donut-pop-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-bottom: 6px;
      }
      .agy-donut-pop-title {
        font-size: 11px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: var(--muted-foreground, #9ca3af);
      }
      .agy-donut-pop-pct {
        font-size: 13px;
        font-weight: 700;
        font-variant-numeric: tabular-nums;
      }
      .agy-donut-pop-summary {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        margin-bottom: 8px;
        font-variant-numeric: tabular-nums;
      }
      .agy-donut-pop-used {
        font-size: 13px;
        font-weight: 600;
      }
      .agy-donut-pop-model {
        font-size: 11px;
        color: var(--muted-foreground, #9ca3af);
        max-width: 130px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .agy-donut-pop-bar {
        display: flex;
        height: 6px;
        width: 100%;
        border-radius: 999px;
        background: var(--muted, rgba(255, 255, 255, 0.08));
        overflow: hidden;
        margin-bottom: 10px;
      }
      .agy-donut-pop-seg-cache {
        height: 100%;
        background: #10b981;
        transition: width 0.3s ease;
      }
      .agy-donut-pop-seg-input {
        height: 100%;
        background: #38bdf8;
        transition: width 0.3s ease;
      }
      .agy-donut-pop-seg-output {
        height: 100%;
        background: #a855f7;
        transition: width 0.3s ease;
      }
      .agy-donut-pop-grid {
        display: grid;
        grid-template-columns: auto 1fr auto;
        align-items: center;
        gap: 5px 8px;
        margin-bottom: 10px;
        font-size: 11.5px;
      }
      .agy-donut-swatch {
        width: 7px;
        height: 7px;
        border-radius: 999px;
      }
      .agy-donut-row-label {
        color: var(--muted-foreground, #9ca3af);
      }
      .agy-donut-row-val {
        text-align: right;
        font-weight: 500;
        font-variant-numeric: tabular-nums;
      }
      .agy-donut-pop-controls {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding-top: 8px;
        border-top: 1px solid var(--border, rgba(255, 255, 255, 0.1));
        gap: 6px;
      }
      .agy-donut-limit-switch {
        display: inline-flex;
        background: var(--muted, rgba(255, 255, 255, 0.06));
        padding: 2px;
        border-radius: 7px;
        gap: 2px;
      }
      .agy-donut-limit-opt {
        border: none;
        background: transparent;
        color: var(--muted-foreground, #9ca3af);
        font-size: 10.5px;
        font-weight: 600;
        padding: 2px 6px;
        border-radius: 5px;
        cursor: pointer;
        transition: all 0.12s ease;
      }
      .agy-donut-limit-opt:hover {
        color: var(--foreground, #f3f4f6);
      }
      .agy-donut-limit-opt.is-selected {
        background: var(--card, #262934);
        color: var(--foreground, #f3f4f6);
        box-shadow: 0 1px 2px rgba(0, 0, 0, 0.25);
      }
      .agy-donut-compact-btn {
        border: 1px solid var(--border, rgba(255, 255, 255, 0.14));
        background: transparent;
        color: var(--foreground, #f3f4f6);
        font-size: 10.5px;
        font-weight: 500;
        padding: 3px 8px;
        border-radius: 6px;
        cursor: pointer;
        transition: background-color 0.15s ease;
      }
      .agy-donut-compact-btn:hover {
        background: var(--secondary, rgba(255, 255, 255, 0.1));
      }

      /* 每轮任务顶端总运行时长显示 */
      @keyframes agyTurnPulse {
        0%, 100% {
          opacity: 1;
          transform: scale(1);
        }
        50% {
          opacity: 0.38;
          transform: scale(0.82);
        }
      }
      .agy-turn-duration-bar {
        display: flex;
        align-items: center;
        padding: 6px 8px 2px 8px;
        user-select: none;
        pointer-events: auto;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Microsoft YaHei", sans-serif;
      }
      .agy-turn-duration-bar[data-mount-pos="agent-top"] {
        padding: 2px 8px 6px 8px;
      }
      .agy-turn-duration-pill {
        display: inline-flex;
        align-items: center;
        gap: 5px;
        height: 22px;
        padding: 0 8px;
        border-radius: 999px;
        font-size: 11.5px;
        font-weight: 500;
        line-height: 1;
        font-variant-numeric: tabular-nums;
        letter-spacing: 0.01em;
        color: #475569;
        background: rgba(15, 23, 42, 0.042);
        border: 1px solid rgba(15, 23, 42, 0.075);
        transition: color 0.15s ease, background-color 0.15s ease, border-color 0.15s ease;
      }
      body.dark .agy-turn-duration-pill,
      body.theme-dark .agy-turn-duration-pill,
      html.dark body .agy-turn-duration-pill {
        color: #94a3b8;
        background: rgba(255, 255, 255, 0.055);
        border: 1px solid rgba(255, 255, 255, 0.09);
      }
      .agy-turn-duration-pill[data-running="true"] {
        color: #2563eb;
        background: rgba(37, 99, 235, 0.075);
        border-color: rgba(37, 99, 235, 0.18);
      }
      body.dark .agy-turn-duration-pill[data-running="true"],
      body.theme-dark .agy-turn-duration-pill[data-running="true"],
      html.dark body .agy-turn-duration-pill[data-running="true"] {
        color: #38bdf8;
        background: rgba(56, 189, 248, 0.11);
        border-color: rgba(56, 189, 248, 0.24);
      }
      .agy-turn-duration-dot {
        width: 6px;
        height: 6px;
        border-radius: 999px;
        background: currentColor;
        flex-shrink: 0;
        animation: agyTurnPulse 1.4s ease-in-out infinite;
      }
      .agy-turn-duration-pill[data-running="false"] .agy-turn-duration-dot {
        display: none;
      }
      .agy-turn-duration-icon {
        width: 12.5px;
        height: 12.5px;
        flex-shrink: 0;
        display: block;
      }
      .agy-turn-duration-pill[data-running="true"] .agy-turn-duration-icon {
        display: none;
      }
    `;
    document.head.appendChild(style);
  }

  // 从 DOM 节点的 React Fiber 向上查找当前 Composer 的 cascadeId / conversationId 与模型配置
  function extractComposerMetaFromFiber(domNode) {
    if (!domNode) return { conversationId: null, modelLabel: null };
    const fiberKey = Object.keys(domNode).find(
      (k) => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$')
    );
    if (!fiberKey) return { conversationId: null, modelLabel: null };

    let cur = domNode[fiberKey];
    let conversationId = null;
    let modelLabel = null;
    let depth = 0;

    while (cur && depth < 35) {
      const props = cur.memoizedProps;
      if (props && typeof props === 'object') {
        if (!conversationId) {
          if (typeof props.cascadeId === 'string' && props.cascadeId.length > 8) {
            conversationId = props.cascadeId;
          } else if (typeof props.conversationId === 'string' && props.conversationId.length > 8) {
            conversationId = props.conversationId;
          }
        }
        if (!modelLabel && props.currentModelConfig && typeof props.currentModelConfig.label === 'string') {
          modelLabel = props.currentModelConfig.label;
        }
      }
      if (conversationId && modelLabel) break;
      cur = cur.return;
      depth++;
    }

    return { conversationId, modelLabel };
  }

  function formatCompact(n) {
    const num = Number(n || 0);
    if (num >= 1e6) {
      const v = (num / 1e6).toFixed(num % 1e6 === 0 ? 0 : 1);
      return (v.endsWith('.0') ? v.slice(0, -2) : v) + 'M';
    }
    if (num >= 1e3) {
      const v = (num / 1e3).toFixed(num >= 1e5 ? 0 : 1);
      return (v.endsWith('.0') ? v.slice(0, -2) : v) + 'k';
    }
    return String(num);
  }

  function formatExact(n) {
    return Number(n || 0).toLocaleString();
  }

  // 获取会话的上下文占用数据（优先 Electron IPC，次选本地 Sidecar 45789 端口）
  async function fetchContextUsage(conversationId) {
    try {
      if (
        window.__agyContextDonutIPC &&
        typeof window.__agyContextDonutIPC.getUsage === 'function'
      ) {
        const res = await window.__agyContextDonutIPC.getUsage(conversationId || '');
        if (res && typeof res === 'object') {
          return res;
        }
      }
    } catch {
      // 回退到 HTTP Sidecar
    }

    try {
      const q = conversationId ? `?conversationId=${encodeURIComponent(conversationId)}` : '';
      const resp = await fetch(`http://127.0.0.1:45789/api/context${q}`, {
        method: 'GET',
        cache: 'no-store',
      });
      if (resp.ok) {
        return await resp.json();
      }
    } catch {
      // ignore
    }

    return null;
  }

  // 创建全局共享的悬停/点击详情浮窗
  function getOrCreatePopover() {
    let pop = document.getElementById('agy-codex-donut-popover');
    if (pop) return pop;

    pop = document.createElement('div');
    pop.id = 'agy-codex-donut-popover';
    pop.className = 'agy-codex-donut-popover no-focus-agent-input';
    pop.innerHTML = `
      <div class="agy-donut-pop-header">
        <span class="agy-donut-pop-title">上下文窗口</span>
        <span class="agy-donut-pop-pct" data-role="pct">0.0%</span>
      </div>
      <div class="agy-donut-pop-summary">
        <span class="agy-donut-pop-used" data-role="used-summary">0 / 512k tokens</span>
        <span class="agy-donut-pop-model" data-role="model">Gemini</span>
      </div>
      <div class="agy-donut-pop-bar">
        <div class="agy-donut-pop-seg-cache" data-role="bar-cache" style="width: 0%"></div>
        <div class="agy-donut-pop-seg-input" data-role="bar-input" style="width: 0%"></div>
        <div class="agy-donut-pop-seg-output" data-role="bar-output" style="width: 0%"></div>
      </div>
      <div class="agy-donut-pop-grid">
        <span class="agy-donut-swatch" style="background: #10b981"></span>
        <span class="agy-donut-row-label">缓存命中</span>
        <span class="agy-donut-row-val" data-role="val-cache">0 (0%)</span>

        <span class="agy-donut-swatch" style="background: #38bdf8"></span>
        <span class="agy-donut-row-label">本轮新增输入</span>
        <span class="agy-donut-row-val" data-role="val-input">0</span>

        <span class="agy-donut-swatch" style="background: #a855f7"></span>
        <span class="agy-donut-row-label">模型输出</span>
        <span class="agy-donut-row-val" data-role="val-output">0</span>
      </div>
      <div class="agy-donut-pop-controls">
        <div class="agy-donut-limit-switch" data-role="limit-switch">
          ${LIMITS.map(
            (l) =>
              `<button type="button" class="agy-donut-limit-opt" data-limit="${l.value}">${l.label}</button>`
          ).join('')}
        </div>
        <button type="button" class="agy-donut-compact-btn" data-role="compact-btn" title="复制 /compact 压缩上下文">/compact</button>
      </div>
    `;

    pop.addEventListener('mouseenter', () => {
      if (hoverHideTimer) {
        clearTimeout(hoverHideTimer);
        hoverHideTimer = null;
      }
    });

    pop.addEventListener('mouseleave', () => {
      if (!popoverPinned) {
        scheduleHidePopover();
      }
    });

    // 切换 512k / 1M 上限
    pop.querySelector('[data-role="limit-switch"]').addEventListener('click', (e) => {
      e.stopPropagation();
      const btn = e.target.closest('.agy-donut-limit-opt');
      if (!btn) return;
      const nextLimit = Number(btn.getAttribute('data-limit'));
      if (nextLimit > 0) {
        setCurrentLimit(nextLimit);
        void refreshAllFooters(false);
        if (activePopoverFooter) {
          updatePopoverContent(activePopoverFooter, true);
        }
      }
    });

    // 点击 /compact 按钮：复制并提示
    pop.querySelector('[data-role="compact-btn"]').addEventListener('click', (e) => {
      e.stopPropagation();
      const btn = e.currentTarget;
      navigator.clipboard?.writeText('/compact').catch(() => {});
      btn.textContent = '已复制 /compact';
      setTimeout(() => {
        btn.textContent = '/compact';
      }, 1400);
    });

    const onDocPointerDown = (e) => {
      if (!pop.classList.contains('is-open')) return;
      if (pop.contains(e.target) || e.target.closest('.agy-codex-donut-wrapper')) return;
      hidePopoverImmediate();
    };
    document.addEventListener('pointerdown', onDocPointerDown);
    pop._cleanupDocListener = () => document.removeEventListener('pointerdown', onDocPointerDown);

    document.body.appendChild(pop);
    return pop;
  }

  function updatePopoverContent(footerEl, forceUpdate = false) {
    const pop = getOrCreatePopover();
    const { conversationId, modelLabel } = extractComposerMetaFromFiber(footerEl);
    const cacheKey = conversationId || '__home__';
    const data = latestUsageCache.get(cacheKey) || {
      totalTokens: 0,
      inputTokens: 0,
      cacheReadTokens: 0,
      outputTokens: 0,
      cumulativeOutputTokens: 0,
      cacheHitRate: 0,
      modelName: modelLabel || 'Gemini',
    };

    const currentLimit = getCurrentLimit();
    const total = Number(data.totalTokens || 0);
    const cache = Number(data.cacheReadTokens || 0);
    const input = Number(data.inputTokens || 0);
    const output = Number(data.outputTokens || 0);
    const cumOut = Number(data.cumulativeOutputTokens || 0);
    const hitRate = Number(data.cacheHitRate || 0);
    const modelText = modelLabel || data.modelName || 'Gemini';

    // 数据指纹比对：若数据与上限完全未变，跳过 DOM 写入，避免任何重绘或闪烁
    const sig = `${cacheKey}:${total}:${cache}:${input}:${output}:${cumOut}:${hitRate}:${currentLimit}:${modelText}`;
    if (!forceUpdate && pop._lastRenderSig === sig) {
      return;
    }
    pop._lastRenderSig = sig;

    const pct = Math.min(100, (total / currentLimit) * 100);

    pop.querySelector('[data-role="pct"]').textContent = `${pct.toFixed(1)}%`;
    pop.querySelector('[data-role="used-summary"]').textContent = `${formatCompact(total)} / ${formatCompact(currentLimit)} tokens`;
    pop.querySelector('[data-role="model"]').textContent = modelText;

    pop.querySelector('[data-role="bar-cache"]').style.width = `${Math.min(100, (cache / currentLimit) * 100).toFixed(2)}%`;
    pop.querySelector('[data-role="bar-input"]').style.width = `${Math.min(100, (input / currentLimit) * 100).toFixed(2)}%`;
    pop.querySelector('[data-role="bar-output"]').style.width = `${Math.min(100, (output / currentLimit) * 100).toFixed(2)}%`;

    pop.querySelector('[data-role="val-cache"]').textContent = `${formatExact(cache)} (${hitRate}%)`;
    pop.querySelector('[data-role="val-input"]').textContent = formatExact(input);
    pop.querySelector('[data-role="val-output"]').textContent =
      cumOut > output
        ? `${formatExact(output)} (累计 ${formatCompact(cumOut)})`
        : formatExact(output);

    pop.querySelectorAll('.agy-donut-limit-opt').forEach((btn) => {
      btn.classList.toggle('is-selected', Number(btn.getAttribute('data-limit')) === currentLimit);
    });
  }

  function showPopoverForFooter(footerEl, pin = false) {
    if (hoverHideTimer) {
      clearTimeout(hoverHideTimer);
      hoverHideTimer = null;
    }
    activePopoverFooter = footerEl;
    if (pin) popoverPinned = true;

    const pop = getOrCreatePopover();
    updatePopoverContent(footerEl, true);

    const wrapper = footerEl.querySelector('.agy-codex-donut-wrapper');
    if (!wrapper) return;

    const rect = wrapper.getBoundingClientRect();
    const popWidth = 296;
    const popHeight = pop.offsetHeight || 210;

    let left = rect.right - popWidth;
    if (left < 12) left = 12;
    if (left + popWidth > window.innerWidth - 12) {
      left = window.innerWidth - popWidth - 12;
    }

    let top = rect.top - popHeight - 8;
    if (top < 12) {
      top = rect.bottom + 8;
    }

    pop.style.left = `${Math.round(left)}px`;
    pop.style.top = `${Math.round(top)}px`;
    pop.classList.add('is-open');

    const btn = wrapper.querySelector('.agy-codex-donut-btn');
    if (btn) btn.classList.add('is-active');
  }

  function scheduleHidePopover() {
    if (hoverHideTimer) clearTimeout(hoverHideTimer);
    hoverHideTimer = setTimeout(() => {
      if (!popoverPinned) {
        hidePopoverImmediate();
      }
    }, 180);
  }

  function hidePopoverImmediate() {
    popoverPinned = false;
    const pop = document.getElementById('agy-codex-donut-popover');
    if (pop) pop.classList.remove('is-open');
    window.__AGY_NATIVE_QSA__('.agy-codex-donut-btn.is-active').forEach((b) => {
      b.classList.remove('is-active');
    });
    activePopoverFooter = null;
  }

  // 在单个 `.agy-composer-footer` 中确保挂载 SVG 甜甜圈节点
  function ensureDonutMounted(footerEl) {
    if (!footerEl || !(footerEl instanceof HTMLElement)) return null;

    const rightContainer = footerEl.lastElementChild || footerEl;
    let wrapper = footerEl.querySelector('.agy-codex-donut-wrapper');

    if (!wrapper) {
      wrapper = document.createElement('div');
      wrapper.className = 'agy-codex-donut-wrapper no-focus-agent-input';
      wrapper.innerHTML = `
        <button type="button" class="agy-codex-donut-btn" data-testid="codex-context-donut" aria-label="上下文占用">
          <svg class="agy-codex-donut-svg" viewBox="0 0 16 16" aria-hidden="true">
            <circle class="agy-codex-donut-track" cx="8" cy="8" r="${RING_RADIUS}" fill="none" stroke-width="2.1"></circle>
            <circle class="agy-codex-donut-arc-cache" cx="8" cy="8" r="${RING_RADIUS}" fill="none" stroke-width="2.1" stroke-linecap="round" stroke-dasharray="${RING_CIRCUMFERENCE}" stroke-dashoffset="${RING_CIRCUMFERENCE}"></circle>
            <circle class="agy-codex-donut-arc-fresh" cx="8" cy="8" r="${RING_RADIUS}" fill="none" stroke-width="2.1" stroke-linecap="round" stroke-dasharray="0 ${RING_CIRCUMFERENCE}" stroke-dashoffset="0"></circle>
          </svg>
          <span class="agy-codex-donut-label">0%</span>
        </button>
      `;

      const btn = wrapper.querySelector('.agy-codex-donut-btn');
      btn.addEventListener('mouseenter', () => {
        showPopoverForFooter(footerEl, false);
      });
      btn.addEventListener('mouseleave', () => {
        if (!popoverPinned) {
          scheduleHidePopover();
        }
      });
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (popoverPinned && activePopoverFooter === footerEl) {
          hidePopoverImmediate();
        } else {
          showPopoverForFooter(footerEl, true);
        }
      });

      if (rightContainer.lastElementChild) {
        rightContainer.insertBefore(wrapper, rightContainer.lastElementChild);
      } else {
        rightContainer.appendChild(wrapper);
      }
    }

    return wrapper;
  }

  // 根据最新数据更新单个底部工具栏上的甜甜圈视图
  function renderFooterDonut(footerEl, data) {
    const wrapper = ensureDonutMounted(footerEl);
    if (!wrapper) return;

    if (data && data.pluginEnabled === false) {
      wrapper.style.display = 'none';
      return;
    }
    wrapper.style.display = 'inline-flex';

    const currentLimit = getCurrentLimit();
    const total = Number(data?.totalTokens || 0);
    const cache = Number(data?.cacheReadTokens || 0);
    const fresh = Math.max(0, total - cache);

    // 指纹比对：若该 footer 的圆环数值未变，不重复操作 SVG 属性
    const ringSig = `${total}:${cache}:${currentLimit}`;
    if (wrapper._lastRingSig !== ringSig) {
      wrapper._lastRingSig = ringSig;

      const usedFrac = Math.min(1, total / currentLimit);
      const cacheFrac = Math.min(1, cache / currentLimit);
      const freshFrac = Math.min(1 - cacheFrac, fresh / currentLimit);
      const pctInt = total > 0 && usedFrac * 100 < 1 ? '<1' : String(Math.round(usedFrac * 100));

      const btn = wrapper.querySelector('.agy-codex-donut-btn');
      const arcCache = wrapper.querySelector('.agy-codex-donut-arc-cache');
      const arcFresh = wrapper.querySelector('.agy-codex-donut-arc-fresh');
      const label = wrapper.querySelector('.agy-codex-donut-label');

      if (btn) {
        if (usedFrac >= 0.85) {
          btn.setAttribute('data-level', 'danger');
        } else if (usedFrac >= 0.6) {
          btn.setAttribute('data-level', 'warn');
        } else {
          btn.removeAttribute('data-level');
        }
      }

      if (arcCache) {
        arcCache.setAttribute('stroke-dasharray', `${RING_CIRCUMFERENCE}`);
        arcCache.setAttribute(
          'stroke-dashoffset',
          `${(RING_CIRCUMFERENCE * (1 - usedFrac)).toFixed(2)}`
        );
      }

      if (arcFresh) {
        const freshLen = freshFrac * RING_CIRCUMFERENCE;
        const cacheLen = cacheFrac * RING_CIRCUMFERENCE;
        arcFresh.setAttribute('stroke-dasharray', `${freshLen.toFixed(2)} ${RING_CIRCUMFERENCE}`);
        arcFresh.setAttribute('stroke-dashoffset', `${(-cacheLen).toFixed(2)}`);
      }

      if (label) {
        label.textContent = `${pctInt}%`;
      }
    }

    if (activePopoverFooter === footerEl) {
      updatePopoverContent(footerEl, false);
    }
  }

  // 扫描页面上所有 `.agy-composer-footer` 并刷新数据
  async function refreshAllFooters(fetchRemote = true) {
    injectStyles();
    const footers = window.__AGY_NATIVE_QSA__('.agy-composer-footer');
    if (footers.length === 0) return;

    for (const footerEl of footers) {
      const { conversationId, modelLabel } = extractComposerMetaFromFiber(footerEl);
      const cacheKey = conversationId || '__home__';

      if (!conversationId) {
        // 新建会话首页（尚未发送第一条消息），直接显示 0%
        const zeroData = {
          conversationId: null,
          modelName: modelLabel || 'Gemini',
          totalTokens: 0,
          inputTokens: 0,
          cacheReadTokens: 0,
          outputTokens: 0,
          cumulativeOutputTokens: 0,
          cacheHitRate: 0,
          pluginEnabled: true,
        };
        latestUsageCache.set(cacheKey, zeroData);
        renderFooterDonut(footerEl, zeroData);
        continue;
      }

      if (fetchRemote) {
        const usage = await fetchContextUsage(conversationId);
        if (usage) {
          if (modelLabel) usage.modelName = modelLabel;
          latestUsageCache.set(cacheKey, usage);
        }
      }

      const cached = latestUsageCache.get(cacheKey);
      renderFooterDonut(footerEl, cached);
    }
  }

  // 每轮任务顶端总运行时长缓存与渲染逻辑
  const liveTurnEndMap = new Map();

  function tsToMs(ts) {
    if (!ts) return 0;
    if (typeof ts === 'number') return Number.isFinite(ts) ? ts : 0;
    if (typeof ts === 'string') {
      const parsed = Date.parse(ts);
      return Number.isFinite(parsed) ? parsed : 0;
    }
    if (ts instanceof Date) {
      const t = ts.getTime();
      return Number.isFinite(t) ? t : 0;
    }
    if (typeof ts === 'object' && ts.seconds !== undefined) {
      const sec = Number(ts.seconds);
      if (!Number.isFinite(sec) || sec <= 0) return 0;
      const nanos = Number(ts.nanos || 0);
      return sec * 1000 + (Number.isFinite(nanos) ? nanos / 1e6 : 0);
    }
    return 0;
  }

  function durationProtoToMs(dur) {
    if (!dur || typeof dur !== 'object') return 0;
    const sec = Number(dur.seconds || 0);
    const nanos = Number(dur.nanos || 0);
    const total = (Number.isFinite(sec) ? sec : 0) * 1000 + (Number.isFinite(nanos) ? nanos / 1e6 : 0);
    return total > 0 ? total : 0;
  }

  function extractTurnMetaFromFiber(domNode) {
    if (!domNode) return null;
    const fiberKey = Object.keys(domNode).find(
      (k) => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$')
    );
    if (!fiberKey) return null;

    let cur = domNode[fiberKey];
    let depth = 0;
    let fallbackMeta = null;

    while (cur && depth < 32) {
      const props = cur.memoizedProps;
      if (props && typeof props === 'object' && props.container && Array.isArray(props.container.steps)) {
        const meta = {
          container: props.container,
          steps: props.container.steps,
          isLatest: Boolean(props.container.isLatest),
          isRunning: Boolean(props.isRunning),
          status: props.status,
          cascadeId: typeof props.cascadeId === 'string' ? props.cascadeId : null,
        };
        if (typeof props.isRunning === 'boolean' || typeof props.status === 'number') {
          return meta;
        }
        if (!fallbackMeta) {
          fallbackMeta = meta;
        }
      }
      cur = cur.return;
      depth++;
    }

    return fallbackMeta;
  }

  function computeTurnTiming(meta) {
    if (!meta || !Array.isArray(meta.steps) || meta.steps.length === 0) return null;
    const steps = meta.steps;
    const userStep = steps.find((s) => s?.step?.case === 'userInput') || steps[0];
    const startMs = tsToMs(userStep?.metadata?.createdAt) || tsToMs(steps[0]?.metadata?.createdAt);
    if (startMs <= 0) return null;

    const turnKey = `${meta.cascadeId || 'local'}:${startMs}`;
    const active =
      Boolean(meta.isLatest) &&
      (Boolean(meta.isRunning) || (typeof meta.status === 'number' && meta.status !== 1 && meta.status !== 0));

    const agentSteps = steps.filter((s) => s?.step?.case !== 'userInput');

    if (active) {
      const now = Date.now();
      if (liveTurnEndMap.size > 200) {
        const oldestKey = liveTurnEndMap.keys().next().value;
        if (oldestKey !== undefined) liveTurnEndMap.delete(oldestKey);
      }
      liveTurnEndMap.set(turnKey, now);
      return {
        active: true,
        startMs,
        endMs: now,
        durationMs: Math.max(0, now - startMs),
        stepCount: Math.max(1, agentSteps.length),
      };
    }

    let maxEndMs = startMs;
    for (const s of steps) {
      if (!s) continue;
      const candidates = [
        tsToMs(s?.taskDetails?.movedToBackgroundAt),
        tsToMs(s?.metadata?.completedAt),
        tsToMs(s?.metadata?.lastModifiedAt),
        tsToMs(s?.metadata?.viewableAt),
        tsToMs(s?.metadata?.createdAt),
      ];
      if (s?.step?.case === 'plannerResponse' && s?.step?.value?.thinkingDuration) {
        const created = tsToMs(s?.metadata?.createdAt);
        const thinkMs = durationProtoToMs(s.step.value.thinkingDuration);
        if (created > 0 && thinkMs > 0) {
          candidates.push(created + thinkMs);
        }
      }
      for (const c of candidates) {
        if (c > maxEndMs) maxEndMs = c;
      }
    }

    if (agentSteps.length === 0 && maxEndMs <= startMs) {
      return null;
    }

    const lastAgentStep = agentSteps[agentSteps.length - 1];
    const hasExplicitEnd =
      tsToMs(lastAgentStep?.metadata?.completedAt) > 0 ||
      tsToMs(lastAgentStep?.taskDetails?.movedToBackgroundAt) > 0;
    if (!hasExplicitEnd && liveTurnEndMap.has(turnKey)) {
      maxEndMs = Math.max(maxEndMs, liveTurnEndMap.get(turnKey));
    }

    return {
      active: false,
      startMs,
      endMs: maxEndMs,
      durationMs: Math.max(0, maxEndMs - startMs),
      stepCount: agentSteps.length,
    };
  }

  function formatTurnDuration(ms, isRunning) {
    const safeMs = Math.max(0, Number(ms || 0));
    if (isRunning) {
      const sec = Math.floor(safeMs / 1000);
      if (sec < 60) return `运行中 · ${sec}s`;
      if (sec < 3600) {
        const m = Math.floor(sec / 60);
        const s = String(sec % 60).padStart(2, '0');
        return `运行中 · ${m}m ${s}s`;
      }
      const h = Math.floor(sec / 3600);
      const m = String(Math.floor((sec % 3600) / 60)).padStart(2, '0');
      const s = String(sec % 60).padStart(2, '0');
      return `运行中 · ${h}h ${m}m ${s}s`;
    }

    if (safeMs < 1000) return '总耗时 <1s';
    if (safeMs < 60000) {
      const v = (safeMs / 1000).toFixed(1);
      return `总耗时 ${v.endsWith('.0') ? v.slice(0, -2) : v}s`;
    }
    const sec = Math.round(safeMs / 1000);
    if (sec < 3600) {
      const m = Math.floor(sec / 60);
      const s = String(sec % 60).padStart(2, '0');
      return `总耗时 ${m}m ${s}s`;
    }
    const h = Math.floor(sec / 3600);
    const m = String(Math.floor((sec % 3600) / 60)).padStart(2, '0');
    const s = String(sec % 60).padStart(2, '0');
    return `总耗时 ${h}h ${m}m ${s}s`;
  }

  function formatClockTime(ms) {
    try {
      return new Date(ms).toLocaleTimeString('zh-CN', { hour12: false });
    } catch {
      return '';
    }
  }

  function isTurnTimerDisabledByPlugin() {
    for (const usage of latestUsageCache.values()) {
      if (usage && usage.pluginEnabled === false) return true;
    }
    return false;
  }

  function ensureTurnDurationBar(hostEl, mountPos, prepend) {
    if (!hostEl) return null;
    let bar = hostEl.querySelector(':scope > .agy-turn-duration-bar');
    if (!bar) {
      bar = document.createElement('div');
      bar.className = 'agy-turn-duration-bar';
      bar.setAttribute('data-no-scroll-jump', 'true');
      bar.setAttribute('data-find-ignore', 'true');
      bar.setAttribute('data-screenshot-volatile', 'true');
      bar.innerHTML = `
        <span class="agy-turn-duration-pill" data-running="false">
          <span class="agy-turn-duration-dot" aria-hidden="true"></span>
          <svg class="agy-turn-duration-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <circle cx="8" cy="8" r="6"></circle>
            <path d="M8 4.8V8l2.2 1.4"></path>
          </svg>
          <span class="agy-turn-duration-text"></span>
        </span>
      `;
      if (prepend && hostEl.firstChild) {
        hostEl.insertBefore(bar, hostEl.firstChild);
      } else {
        hostEl.appendChild(bar);
      }
    }
    if (bar.getAttribute('data-mount-pos') !== mountPos) {
      bar.setAttribute('data-mount-pos', mountPos);
    }
    return bar;
  }

  function applyTurnTimingToBar(bar, timing) {
    if (!bar) return;
    if (!timing) {
      bar.style.display = 'none';
      return;
    }
    bar.style.display = 'flex';
    const labelText = formatTurnDuration(timing.durationMs, timing.active);
    const startStr = formatClockTime(timing.startMs);
    const endStr = timing.active ? '进行中' : formatClockTime(timing.endMs);
    const tooltipText = `开始 ${startStr} · ${timing.active ? '当前进行中' : `结束 ${endStr}`} · ${timing.stepCount} 步`;
    const sig = `${timing.active}:${labelText}:${tooltipText}`;
    if (bar._lastSig === sig) return;
    bar._lastSig = sig;

    const pill = bar.querySelector('.agy-turn-duration-pill');
    const textEl = bar.querySelector('.agy-turn-duration-text');
    if (pill) {
      pill.setAttribute('data-running', timing.active ? 'true' : 'false');
      pill.setAttribute('title', tooltipText);
    }
    if (textEl) {
      textEl.textContent = labelText;
    }
  }

  function syncAllTurnTimers() {
    injectStyles();
    if (isTurnTimerDisabledByPlugin()) {
      window.__AGY_NATIVE_QSA__('.agy-turn-duration-bar').forEach((el) => {
        el.style.display = 'none';
      });
      return;
    }

    const userMsgEls = window.__AGY_NATIVE_QSA__('[data-testid="user-message"]');
    const handledAgentResponses = new Set();

    for (const userMsgEl of userMsgEls) {
      const meta = extractTurnMetaFromFiber(userMsgEl);
      const timing = meta ? computeTurnTiming(meta) : null;
      const turnRoot = userMsgEl.parentElement;
      const agentResp = turnRoot?.querySelector(':scope > [data-testid="agent-response"]');
      if (agentResp) handledAgentResponses.add(agentResp);

      const isBubbleMode = Boolean(userMsgEl.querySelector('[data-testid="user-input-step"].items-end'));
      let hostEl = null;
      let mountPos = 'sticky';
      let prepend = false;

      if (isBubbleMode && agentResp) {
        hostEl = agentResp;
        mountPos = 'agent-top';
        prepend = true;
      } else {
        hostEl = userMsgEl.querySelector('.md-sticky-message-bleed') || userMsgEl.firstElementChild || userMsgEl;
        mountPos = 'sticky';
        prepend = false;
      }

      if (!timing) {
        const existingBar = hostEl?.querySelector(':scope > .agy-turn-duration-bar');
        if (existingBar) existingBar.style.display = 'none';
        continue;
      }

      const bar = ensureTurnDurationBar(hostEl, mountPos, prepend);
      applyTurnTimingToBar(bar, timing);
    }

    const allAgentResps = window.__AGY_NATIVE_QSA__('[data-testid="agent-response"]');
    for (const agentResp of allAgentResps) {
      if (handledAgentResponses.has(agentResp)) continue;
      const turnRoot = agentResp.parentElement;
      if (turnRoot?.querySelector(':scope > [data-testid="user-message"]')) continue;

      const meta = extractTurnMetaFromFiber(agentResp);
      const timing = meta ? computeTurnTiming(meta) : null;
      if (!timing) {
        const existingBar = agentResp.querySelector(':scope > .agy-turn-duration-bar');
        if (existingBar) existingBar.style.display = 'none';
        continue;
      }

      const bar = ensureTurnDurationBar(agentResp, 'agent-top', true);
      applyTurnTimingToBar(bar, timing);
    }
  }

  // 使用 MutationObserver 监听会话切换或新对话框渲染，立即挂载甜甜圈与任务计时条
  let rafScheduled = false;
  let turnRafScheduled = false;
  const observer = new MutationObserver(() => {
    const footers = window.__AGY_NATIVE_QSA__('.agy-composer-footer');
    let needsMount = false;
    for (const f of footers) {
      if (!f.querySelector('.agy-codex-donut-wrapper')) {
        needsMount = true;
        break;
      }
    }
    if (needsMount && !rafScheduled) {
      rafScheduled = true;
      requestAnimationFrame(() => {
        rafScheduled = false;
        void refreshAllFooters(true);
      });
    }

    const userMsgs = window.__AGY_NATIVE_QSA__('[data-testid="user-message"]');
    let needsTurnMount = false;
    for (const um of userMsgs) {
      const turnRoot = um.parentElement;
      const inTurn =
        um.querySelector('.agy-turn-duration-bar') ||
        turnRoot?.querySelector(':scope > [data-testid="agent-response"] > .agy-turn-duration-bar');
      if (!inTurn) {
        needsTurnMount = true;
        break;
      }
    }
    if (needsTurnMount && !turnRafScheduled) {
      turnRafScheduled = true;
      requestAnimationFrame(() => {
        turnRafScheduled = false;
        syncAllTurnTimers();
      });
    }
  });

  let pollTimer = null;
  let turnTickTimer = null;

  function start() {
    injectStyles();
    void refreshAllFooters(true);
    syncAllTurnTimers();
    if (document.body) {
      observer.observe(document.body, { childList: true, subtree: true });
    }
    pollTimer = setInterval(() => {
      void refreshAllFooters(true);
    }, 2000);
    turnTickTimer = setInterval(() => {
      syncAllTurnTimers();
    }, 500);
  }

  window.__AGY_CONTEXT_DONUT_CLEANUP__ = () => {
    try {
      observer.disconnect();
    } catch {}
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    if (turnTickTimer) {
      clearInterval(turnTickTimer);
      turnTickTimer = null;
    }
    if (hoverHideTimer) {
      clearTimeout(hoverHideTimer);
      hoverHideTimer = null;
    }
    const pop = document.getElementById('agy-codex-donut-popover');
    if (pop) {
      pop._cleanupDocListener?.();
      pop.remove();
    }
    document.getElementById('agy-context-donut-styles')?.remove();
    window.__AGY_NATIVE_QSA__('.agy-codex-donut-wrapper').forEach((el) => el.remove());
    window.__AGY_NATIVE_QSA__('.agy-composer-perf-bar').forEach((el) => el.remove());
    window.__AGY_NATIVE_QSA__('.agy-turn-duration-bar').forEach((el) => el.remove());
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
