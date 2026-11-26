/**
 * Antigravity Task Timer — 每轮任务顶端总运行时长显示组件
 *
 * 自动挂载于 Antigravity 每轮对话任务顶端：
 * 1. 标准对话流模式下挂载在 `[data-testid="user-message"]` 内部吸顶容器末尾（向下滚动时随提问框吸顶常驻）；
 * 2. 气泡模式或无用户气泡场景下挂载在 `[data-testid="agent-response"]` 最顶端首行；
 * 3. 直接读取外层 Turn 组件的 React Fiber（`container.steps`、`isRunning`、`status`），按纯首尾挂钟差值计算；
 * 4. 运行期间按秒实时跳秒（`运行中 · Xs`），完成后定格展示总运行时长（`总耗时 Xs / Xm XXs`），悬停显示起止时刻与步数。
 */
(function installAntigravityTaskTimer() {
  if (window.__AGY_TASK_TIMER_LOCKED__ && !window.__AGY_TASK_TIMER_FORCE_RELOAD__) {
    return;
  }
  window.__AGY_TASK_TIMER_FORCE_RELOAD__ = false;
  window.__AGY_TASK_TIMER_LOCKED__ = true;

  const nativeQSA =
    typeof window.__AGY_NATIVE_QSA__ === 'function'
      ? window.__AGY_NATIVE_QSA__
      : document.querySelectorAll.bind(document);

  if (typeof window.__AGY_TASK_TIMER_CLEANUP__ === 'function') {
    try {
      window.__AGY_TASK_TIMER_CLEANUP__();
    } catch {}
  }

  const STYLE_ID = 'agy-task-timer-styles';
  document.getElementById(STYLE_ID)?.remove();
  nativeQSA('.agy-turn-duration-bar').forEach((el) => el.remove());

  window.__AGY_TASK_TIMER_INSTALLED__ = true;
  window.__AGY_TASK_TIMER_VERSION__ = '1.0.1';

  // 运行中单调时钟锚点、最后同源耗时与各会话跨机时钟偏移缓存（彻底免疫 SSH/远端时钟偏差）
  const liveTurnAnchorMap = new Map();
  const liveTurnDurationMap = new Map();
  const sessionSkewMap = new Map();

  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
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
    (document.head || document.documentElement).appendChild(style);
  }

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

  function getMaxRemoteStepMs(steps, fallbackMs) {
    let maxMs = fallbackMs;
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
        if (c > maxMs) maxMs = c;
      }
    }
    return maxMs;
  }

  function trimMap(map, maxSize) {
    if (map.size > maxSize) {
      const oldestKey = map.keys().next().value;
      if (oldestKey !== undefined) map.delete(oldestKey);
    }
  }

  function computeTurnTiming(meta) {
    if (!meta || !Array.isArray(meta.steps) || meta.steps.length === 0) return null;
    const steps = meta.steps;
    const userStep = steps.find((s) => s?.step?.case === 'userInput') || steps[0];
    const startMs = tsToMs(userStep?.metadata?.createdAt) || tsToMs(steps[0]?.metadata?.createdAt);
    if (startMs <= 0) return null;

    const sessionKey = meta.cascadeId || 'local';
    const turnKey = `${sessionKey}:${startMs}`;
    const active =
      Boolean(meta.isLatest) &&
      (Boolean(meta.isRunning) || (typeof meta.status === 'number' && meta.status !== 1 && meta.status !== 0));

    const agentSteps = steps.filter((s) => s?.step?.case !== 'userInput');
    const maxRemoteMs = getMaxRemoteStepMs(steps, startMs);
    const remoteElapsedMs = Math.max(0, maxRemoteMs - startMs);

    if (active) {
      const monoNow = typeof performance !== 'undefined' ? performance.now() : Date.now();
      const wallNow = Date.now();
      let anchor = liveTurnAnchorMap.get(turnKey);

      if (!anchor) {
        // 首次观测到活跃轮次：若本会话已标定跨机时钟偏移，则顺带补偿当前步内已流逝时间；
        // 否则直接以远端同源已耗时 remoteElapsedMs 为基准叠加本地单调时钟，避免 SSH 时钟快/慢导致 0s 或虚高
        let initialInStepMs = 0;
        if (sessionSkewMap.has(sessionKey)) {
          const estRemoteNow = wallNow - sessionSkewMap.get(sessionKey);
          const diff = estRemoteNow - maxRemoteMs;
          if (diff > 0 && diff < 3600000) {
            initialInStepMs = diff;
          }
        }
        const initialElapsed = remoteElapsedMs + initialInStepMs;
        anchor = {
          remoteMs: maxRemoteMs,
          monoMs: monoNow - initialInStepMs,
          lastDurationMs: initialElapsed,
        };
        trimMap(liveTurnAnchorMap, 200);
        liveTurnAnchorMap.set(turnKey, anchor);
      } else if (maxRemoteMs > anchor.remoteMs) {
        // 远端步骤时间戳推进时自动标定本会话时钟偏差，并与远端同源耗时对齐（保持单调不倒退）
        trimMap(sessionSkewMap, 100);
        sessionSkewMap.set(sessionKey, wallNow - maxRemoteMs);
        const syncedElapsed = Math.max(remoteElapsedMs, anchor.lastDurationMs);
        anchor.remoteMs = maxRemoteMs;
        anchor.monoMs = monoNow - (syncedElapsed - remoteElapsedMs);
        anchor.lastDurationMs = syncedElapsed;
      }

      const elapsedMs = Math.max(
        anchor.lastDurationMs,
        remoteElapsedMs,
        anchor.remoteMs - startMs + Math.max(0, monoNow - anchor.monoMs)
      );
      anchor.lastDurationMs = elapsedMs;

      trimMap(liveTurnDurationMap, 200);
      liveTurnDurationMap.set(turnKey, elapsedMs);

      const rawSkew = sessionSkewMap.has(sessionKey) ? sessionSkewMap.get(sessionKey) : 0;
      const displaySkew = Math.abs(rawSkew) > 5000 ? rawSkew : 0;
      return {
        active: true,
        startMs: startMs + displaySkew,
        endMs: startMs + displaySkew + elapsedMs,
        durationMs: elapsedMs,
        stepCount: Math.max(1, agentSteps.length),
      };
    }

    liveTurnAnchorMap.delete(turnKey);

    if (agentSteps.length === 0 && maxRemoteMs <= startMs) {
      return null;
    }

    let durationMs = remoteElapsedMs;
    const lastAgentStep = agentSteps[agentSteps.length - 1];
    const hasExplicitEnd =
      tsToMs(lastAgentStep?.metadata?.completedAt) > 0 ||
      tsToMs(lastAgentStep?.taskDetails?.movedToBackgroundAt) > 0;
    if (!hasExplicitEnd && liveTurnDurationMap.has(turnKey)) {
      durationMs = Math.max(durationMs, liveTurnDurationMap.get(turnKey));
    }

    const rawSkew = sessionSkewMap.has(sessionKey) ? sessionSkewMap.get(sessionKey) : 0;
    const displaySkew = Math.abs(rawSkew) > 5000 ? rawSkew : 0;
    return {
      active: false,
      startMs: startMs + displaySkew,
      endMs: startMs + displaySkew + durationMs,
      durationMs,
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

  function ensureTurnDurationBar(hostEl, mountPos, prepend) {
    if (!hostEl) return null;
    let bar = hostEl.querySelector(':scope > .agy-turn-duration-bar');
    if (!bar) {
      bar = document.createElement('div');
      bar.className = 'agy-turn-duration-bar';
      bar.setAttribute('data-owner', 'task-timer');
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
    } else if (bar.getAttribute('data-owner') !== 'task-timer') {
      bar.setAttribute('data-owner', 'task-timer');
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

    const userMsgEls = nativeQSA('[data-testid="user-message"]');
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

    const allAgentResps = nativeQSA('[data-testid="agent-response"]');
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

  let turnRafScheduled = false;
  let observer = null;
  let turnTickTimer = null;

  function start() {
    injectStyles();
    syncAllTurnTimers();

    if (typeof MutationObserver !== 'undefined' && document.body) {
      observer = new MutationObserver(() => {
        const userMsgs = nativeQSA('[data-testid="user-message"]');
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
      observer.observe(document.body, { childList: true, subtree: true });
    }

    turnTickTimer = setInterval(() => {
      syncAllTurnTimers();
    }, 500);
  }

  window.__AGY_TASK_TIMER_CLEANUP__ = () => {
    try {
      observer?.disconnect();
    } catch {}
    observer = null;
    if (turnTickTimer) {
      clearInterval(turnTickTimer);
      turnTickTimer = null;
    }
    liveTurnAnchorMap.clear();
    liveTurnDurationMap.clear();
    sessionSkewMap.clear();
    document.getElementById(STYLE_ID)?.remove();
    nativeQSA('.agy-turn-duration-bar').forEach((el) => el.remove());
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
})();
