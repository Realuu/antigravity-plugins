/**
 * Antigravity Tab Suggest — 纯净输入框内联幽灵灰字补全渲染层（无底部按钮、无尾标）
 *
 * 管理与凭证配置入口位于右上角「插件 -> Tab 智能补全 (Tab Suggest)」Sidecar 面板。
 */
(function installAntigravityTabSuggest() {
  if (window.__AGY_TAB_SUGGEST_LOCKED__ && !window.__AGY_TAB_SUGGEST_FORCE_RELOAD__) {
    return;
  }
  window.__AGY_TAB_SUGGEST_FORCE_RELOAD__ = false;
  window.__AGY_TAB_SUGGEST_LOCKED__ = true;

  if (typeof window.__AGY_TAB_SUGGEST_CLEANUP__ === 'function') {
    try {
      window.__AGY_TAB_SUGGEST_CLEANUP__();
    } catch {}
  }

  const API_BASE = 'http://127.0.0.1:45794';
  const STYLE_ID = 'agy-tab-suggest-styles';

  const qsa = (selector, root = document) => {
    if (root === document && typeof window.__AGY_NATIVE_QSA__ === 'function') {
      return Array.from(window.__AGY_NATIVE_QSA__(selector));
    }
    return Array.from(root.querySelectorAll(selector));
  };

  // 彻底清理可能残留的旧版底部按钮与旧浮窗
  document.getElementById('agy-tab-suggest-popover')?.remove();
  document.getElementById(STYLE_ID)?.remove();
  qsa('.agy-tab-suggest-wrapper').forEach((el) => el.remove());
  qsa('.agy-tab-ghost-overlay').forEach((el) => el.remove());
  qsa('[data-agy-ghost-showing]').forEach((el) => el.removeAttribute('data-agy-ghost-showing'));

  window.__AGY_TAB_SUGGEST_INSTALLED__ = true;
  window.__AGY_TAB_SUGGEST_VERSION__ = '1.1.1';

  let serviceEnabled = true;
  let pluginEnabled = true;

  const suggestionCache = new Map(); // conversationId -> { status, suggestion, turnSignature }
  const consumedTurnSigs = new Set();
  const lastRunningByConvo = new Map();

  let fastPollTimer = null;
  let fastPollTicks = 0;
  let isComposingIME = false;

  // 作废指定会话当前缓存的未接受建议，防止发新消息后输入框变空时旧建议“诈尸”闪烁
  function invalidateCachedSuggestionForConvo(conversationId) {
    if (!conversationId) return;
    const cur = suggestionCache.get(conversationId);
    if (cur && cur.turnSignature) {
      consumedTurnSigs.add(cur.turnSignature);
      if (cur.status === 'ready') {
        apiPost('/api/feedback', {
          conversationId,
          turnSignature: cur.turnSignature,
          action: 'dismissed',
        }).catch(() => {});
      }
    }
    if (cur && cur.status !== 'generating') {
      suggestionCache.set(conversationId, { ...cur, status: 'dismissed', suggestion: '' });
    }
  }

  // 实时判断指定会话/输入框是否正处于任务运行态（Fiber 状态 + 底部停止按钮双重检测）
  function isComposerCurrentlyRunning(footerEl, conversationId) {
    if (conversationId && lastRunningByConvo.get(conversationId) === true) {
      return true;
    }
    const msgNodes = qsa('[data-testid="user-message"], [data-testid="agent-response"]');
    for (let i = msgNodes.length - 1; i >= 0; i--) {
      const info = extractTurnRunStateFromFiber(msgNodes[i]);
      if (info && info.isLatest) {
        if (!conversationId || info.cascadeId === conversationId) {
          if (info.cascadeId) {
            lastRunningByConvo.set(info.cascadeId, info.active);
          }
          if (info.active) return true;
        }
        break;
      }
    }
    if (footerEl) {
      const btns = footerEl.querySelectorAll('button');
      for (const b of btns) {
        const label = `${b.getAttribute('aria-label') || ''} ${b.getAttribute('title') || ''} ${b.getAttribute('data-testid') || ''}`.toLowerCase();
        if (/\b(stop|cancel)\b|停止|取消/.test(label)) {
          return true;
        }
      }
    }
    return false;
  }

  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      /* 仅当幽灵补全实际展示时，隐藏编辑器同级原生 placeholder */
      [data-agy-ghost-showing="true"] > :not([contenteditable="true"]):not(.agy-tab-ghost-overlay):not(textarea) {
        opacity: 0 !important;
        visibility: hidden !important;
      }

      .agy-tab-ghost-overlay {
        position: absolute;
        left: 0;
        top: 0;
        right: 12px;
        pointer-events: none;
        user-select: none;
        display: none;
        align-items: center;
        white-space: nowrap;
        overflow: hidden;
        z-index: 8;
        box-sizing: border-box;
      }
      .agy-tab-ghost-overlay[data-visible="true"] {
        display: flex;
      }
      .agy-tab-ghost-text {
        color: rgba(100, 116, 139, 0.68);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        letter-spacing: 0.005em;
      }
      body.dark .agy-tab-ghost-text,
      body.theme-dark .agy-tab-ghost-text,
      html.dark body .agy-tab-ghost-text {
        color: rgba(148, 163, 184, 0.58);
      }
    `;
    document.head.appendChild(style);
  }

  function extractComposerMetaFromFiber(domNode) {
    if (!domNode) return { conversationId: null };
    const fiberKey = Object.keys(domNode).find(
      (k) => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$')
    );
    if (!fiberKey) return { conversationId: null };

    let cur = domNode[fiberKey];
    let depth = 0;
    while (cur && depth < 36) {
      const props = cur.memoizedProps;
      if (props && typeof props === 'object') {
        if (typeof props.cascadeId === 'string' && props.cascadeId.length > 8) {
          return { conversationId: props.cascadeId };
        }
        if (typeof props.conversationId === 'string' && props.conversationId.length > 8) {
          return { conversationId: props.conversationId };
        }
      }
      cur = cur.return;
      depth++;
    }
    return { conversationId: null };
  }

  function extractTurnRunStateFromFiber(domNode) {
    if (!domNode) return null;
    const fiberKey = Object.keys(domNode).find(
      (k) => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$')
    );
    if (!fiberKey) return null;

    let cur = domNode[fiberKey];
    let depth = 0;
    while (cur && depth < 32) {
      const props = cur.memoizedProps;
      if (props && typeof props === 'object' && props.container && Array.isArray(props.container.steps)) {
        if (typeof props.isRunning === 'boolean' || typeof props.status === 'number') {
          const active =
            Boolean(props.container.isLatest) &&
            (Boolean(props.isRunning) ||
              (typeof props.status === 'number' && props.status !== 1 && props.status !== 0));
          return {
            cascadeId: typeof props.cascadeId === 'string' ? props.cascadeId : null,
            isLatest: Boolean(props.container.isLatest),
            active,
          };
        }
      }
      cur = cur.return;
      depth++;
    }
    return null;
  }

  function findEditorForFooter(footerEl) {
    let cur = footerEl?.parentElement;
    let depth = 0;
    while (cur && depth < 8) {
      const ed =
        cur.querySelector('[data-lexical-editor="true"][contenteditable="true"]') ||
        cur.querySelector('[contenteditable="true"][role="textbox"]') ||
        cur.querySelector('textarea');
      if (ed) return ed;
      cur = cur.parentElement;
      depth++;
    }
    return null;
  }

  function isEditorCompletelyEmpty(editor) {
    if (!editor || isComposingIME) return false;
    if (editor.tagName === 'TEXTAREA' || editor.tagName === 'INPUT') {
      return String(editor.value || '').length === 0;
    }
    const raw = String(editor.textContent || '').replace(/[\u200B\r\n]/g, '');
    return raw.length === 0;
  }

  async function apiGet(pathname) {
    try {
      const resp = await fetch(`${API_BASE}${pathname}`, { method: 'GET', cache: 'no-store' });
      if (resp.ok) return await resp.json();
    } catch {}
    return null;
  }

  async function apiPost(pathname, payload) {
    const resp = await fetch(`${API_BASE}${pathname}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload || {}),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      throw new Error(data?.error || `HTTP ${resp.status}`);
    }
    return data;
  }

  function startFastPoll() {
    if (fastPollTimer) clearInterval(fastPollTimer);
    fastPollTicks = 0;
    fastPollTimer = setInterval(() => {
      fastPollTicks++;
      void syncAllComposers(true);
      if (fastPollTicks >= 18) {
        clearInterval(fastPollTimer);
        fastPollTimer = null;
      }
    }, 450);
  }

  async function triggerForConversation(conversationId) {
    if (!conversationId) return;
    try {
      await apiPost('/api/trigger', { conversationId, force: false });
      startFastPoll();
    } catch {}
  }

  async function writeSuggestionToEditor(editor, text) {
    if (!editor || !text) return false;
    editor.focus();
    await new Promise((r) => setTimeout(r, 20));

    if (editor.tagName === 'TEXTAREA' || editor.tagName === 'INPUT') {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
      if (setter) setter.call(editor, text);
      else editor.value = text;
      editor.dispatchEvent(new Event('input', { bubbles: true }));
      editor.setSelectionRange?.(text.length, text.length);
      return true;
    }

    const ipcInsert =
      window.__agyTabSuggestIPC?.insertText ||
      window.__agyCowartSidebarIPC?.insertText ||
      window.__agyNotionSidebarIPC?.insertText;

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
      if (String(editor.textContent || '').trim().length > 0) {
        return true;
      }
    } catch {}

    try {
      document.execCommand('insertText', false, text);
      return true;
    } catch {
      return false;
    }
  }

  function ensureGhostOverlay(editor) {
    const host = editor?.parentElement;
    if (!host) return null;
    const hostPos = window.getComputedStyle(host).position;
    if (hostPos === 'static') {
      host.style.position = 'relative';
    }

    let overlay = host.querySelector(':scope > .agy-tab-ghost-overlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.className = 'agy-tab-ghost-overlay no-focus-agent-input notranslate';
      overlay.setAttribute('translate', 'no');
      overlay.setAttribute('data-find-ignore', 'true');
      overlay.innerHTML = `<span class="agy-tab-ghost-text notranslate" translate="no"></span>`;
      host.appendChild(overlay);
    }
    return overlay;
  }

  function syncOverlayTypography(editor, overlay) {
    const host = editor.parentElement;
    if (!host || !overlay) return;
    const cs = window.getComputedStyle(editor);
    const firstBlock = editor.querySelector('p, div') || editor;
    const hostRect = host.getBoundingClientRect();
    const blockRect = firstBlock.getBoundingClientRect();
    const blockCs = window.getComputedStyle(firstBlock);

    let leftPx = Math.max(0, blockRect.left - hostRect.left + (parseFloat(blockCs.paddingLeft) || 0));
    let topPx = Math.max(0, blockRect.top - hostRect.top + (parseFloat(blockCs.paddingTop) || 0));
    if (!Number.isFinite(leftPx) || hostRect.width === 0) {
      leftPx = parseFloat(cs.paddingLeft) || 12;
      topPx = parseFloat(cs.paddingTop) || 8;
    }

    const lineHeight = cs.lineHeight && cs.lineHeight !== 'normal' ? cs.lineHeight : '22px';
    overlay.style.left = `${Math.round(leftPx)}px`;
    overlay.style.top = `${Math.round(topPx)}px`;
    overlay.style.height = lineHeight;
    overlay.style.lineHeight = lineHeight;
    overlay.style.fontSize = cs.fontSize || '14px';
    overlay.style.fontFamily = cs.fontFamily || 'inherit';
  }

  function hideGhostOnEditor(editor) {
    const host = editor?.parentElement;
    if (!host) return;
    host.removeAttribute('data-agy-ghost-showing');
    const overlay = host.querySelector(':scope > .agy-tab-ghost-overlay');
    if (overlay) {
      overlay.setAttribute('data-visible', 'false');
      overlay._boundSuggestion = '';
      overlay._boundConvoId = '';
      overlay._boundTurnSig = '';
    }
  }

  function renderGhostForComposer(editor, conversationId, stateObj, footerEl = null) {
    if (!editor) return;
    const canShow =
      serviceEnabled &&
      pluginEnabled !== false &&
      conversationId &&
      stateObj &&
      stateObj.status === 'ready' &&
      stateObj.suggestion &&
      !consumedTurnSigs.has(stateObj.turnSignature) &&
      !isComposerCurrentlyRunning(footerEl, conversationId) &&
      isEditorCompletelyEmpty(editor);

    if (!canShow) {
      hideGhostOnEditor(editor);
      return;
    }

    const overlay = ensureGhostOverlay(editor);
    if (!overlay) return;
    syncOverlayTypography(editor, overlay);

    const textEl = overlay.querySelector('.agy-tab-ghost-text');
    if (textEl && textEl.textContent !== stateObj.suggestion) {
      textEl.textContent = stateObj.suggestion;
    }
    overlay._boundSuggestion = stateObj.suggestion;
    overlay._boundConvoId = conversationId;
    overlay._boundTurnSig = stateObj.turnSignature || '';
    overlay.setAttribute('data-visible', 'true');
    editor.parentElement?.setAttribute('data-agy-ghost-showing', 'true');
  }

  async function acceptVisibleSuggestion(editor, overlay) {
    const text = overlay?._boundSuggestion || '';
    const cid = overlay?._boundConvoId || '';
    const sig = overlay?._boundTurnSig || '';
    if (!text || !editor) return false;

    if (sig) consumedTurnSigs.add(sig);
    if (cid && suggestionCache.has(cid)) {
      suggestionCache.set(cid, { ...suggestionCache.get(cid), status: 'accepted', suggestion: '' });
    }
    hideGhostOnEditor(editor);

    if (cid) {
      apiPost('/api/feedback', { conversationId: cid, turnSignature: sig, action: 'accepted' }).catch(() => {});
    }
    return await writeSuggestionToEditor(editor, text);
  }

  function dismissVisibleSuggestion(editor, overlay) {
    const cid = overlay?._boundConvoId || '';
    const sig = overlay?._boundTurnSig || '';
    if (sig) consumedTurnSigs.add(sig);
    if (cid && suggestionCache.has(cid)) {
      suggestionCache.set(cid, { ...suggestionCache.get(cid), status: 'dismissed', suggestion: '' });
    }
    hideGhostOnEditor(editor);
    if (cid) {
      apiPost('/api/feedback', { conversationId: cid, turnSignature: sig, action: 'dismissed' }).catch(() => {});
    }
  }

  function findActiveVisibleGhostTarget() {
    const overlays = qsa('.agy-tab-ghost-overlay[data-visible="true"]');
    for (const ov of overlays) {
      if (ov.offsetParent === null) continue;
      const host = ov.parentElement;
      const ed =
        host?.querySelector('[data-lexical-editor="true"][contenteditable="true"]') ||
        host?.querySelector('[contenteditable="true"][role="textbox"]') ||
        host?.querySelector('textarea');
      if (ed && isEditorCompletelyEmpty(ed) && ov._boundSuggestion) {
        return { editor: ed, overlay: ov };
      }
    }
    return null;
  }

  function onGlobalKeyDown(e) {
    if (e.isComposing || e.keyCode === 229 || isComposingIME) return;

    // 当用户在输入框有草稿并按下 Enter 发送新消息时，立即永久作废上一轮未接受的旧建议
    if (e.key === 'Enter' && !e.shiftKey) {
      const ed = e.target?.closest?.('[contenteditable="true"], textarea');
      if (ed && !isEditorCompletelyEmpty(ed)) {
        for (const f of qsa('.agy-composer-footer')) {
          if (findEditorForFooter(f) === ed) {
            const { conversationId } = extractComposerMetaFromFiber(f);
            invalidateCachedSuggestionForConvo(conversationId);
            hideGhostOnEditor(ed);
            break;
          }
        }
      }
    }

    const target = findActiveVisibleGhostTarget();
    if (!target) return;

    const activeEl = document.activeElement;
    const isFocusedInOtherInput =
      activeEl &&
      activeEl !== target.editor &&
      !target.editor.contains(activeEl) &&
      (activeEl.tagName === 'INPUT' ||
        activeEl.tagName === 'TEXTAREA' ||
        activeEl.tagName === 'SELECT' ||
        activeEl.isContentEditable);

    if (isFocusedInOtherInput) return;

    if (e.key === 'Tab' && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
      e.preventDefault();
      e.stopPropagation();
      void acceptVisibleSuggestion(target.editor, target.overlay);
      return;
    }

    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      dismissVisibleSuggestion(target.editor, target.overlay);
    }
  }

  function onGlobalInputOrCompose(e) {
    if (e.type === 'compositionstart') {
      isComposingIME = true;
    } else if (e.type === 'compositionend') {
      isComposingIME = false;
    }
    const ed = e.target?.closest?.('[contenteditable="true"], textarea');
    if (ed) {
      if (isComposingIME || !isEditorCompletelyEmpty(ed)) {
        hideGhostOnEditor(ed);
      } else {
        const footers = qsa('.agy-composer-footer');
        for (const f of footers) {
          if (findEditorForFooter(f) === ed) {
            const { conversationId } = extractComposerMetaFromFiber(f);
            renderGhostForComposer(ed, conversationId, suggestionCache.get(conversationId || ''), f);
            break;
          }
        }
      }
    }
  }

  function onGlobalClickSubmit(e) {
    const btn = e.target?.closest?.('.agy-composer-footer button');
    if (!btn) return;
    const footerEl = btn.closest('.agy-composer-footer');
    const ed = findEditorForFooter(footerEl);
    if (ed && !isEditorCompletelyEmpty(ed)) {
      const { conversationId } = extractComposerMetaFromFiber(footerEl);
      invalidateCachedSuggestionForConvo(conversationId);
      hideGhostOnEditor(ed);
    }
  }

  function detectTurnCompletionAndTrigger() {
    const msgNodes = qsa('[data-testid="user-message"], [data-testid="agent-response"]');
    let latestState = null;
    for (let i = msgNodes.length - 1; i >= 0; i--) {
      const info = extractTurnRunStateFromFiber(msgNodes[i]);
      if (info && info.cascadeId && info.isLatest) {
        latestState = info;
        break;
      }
    }
    if (!latestState) return;

    const cid = latestState.cascadeId;
    const prevActive = lastRunningByConvo.get(cid);
    lastRunningByConvo.set(cid, latestState.active);

    if (latestState.active) {
      invalidateCachedSuggestionForConvo(cid);
      const footers = qsa('.agy-composer-footer');
      for (const f of footers) {
        const meta = extractComposerMetaFromFiber(f);
        if (meta.conversationId === cid) {
          hideGhostOnEditor(findEditorForFooter(f));
        }
      }
    } else if (prevActive === true && latestState.active === false) {
      void triggerForConversation(cid);
    }
  }

  async function syncAllComposers(fetchRemote = true) {
    injectStyles();
    const footers = qsa('.agy-composer-footer');
    if (footers.length === 0) return;

    for (const footerEl of footers) {
      const { conversationId } = extractComposerMetaFromFiber(footerEl);
      const editor = findEditorForFooter(footerEl);

      if (fetchRemote && conversationId) {
        const res = await apiGet(`/api/suggestion?conversationId=${encodeURIComponent(conversationId)}`);
        if (res && res.ok) {
          serviceEnabled = Boolean(res.enabled);
          if (res.pluginEnabled !== undefined) pluginEnabled = Boolean(res.pluginEnabled);
          if (res.state) {
            suggestionCache.set(conversationId, res.state);
          }
        }
      } else if (fetchRemote && !conversationId) {
        const st = await apiGet('/api/status');
        if (st && st.ok) {
          serviceEnabled = Boolean(st.enabled);
          pluginEnabled = st.pluginEnabled !== false;
        }
      }

      const cached = conversationId ? suggestionCache.get(conversationId) : null;
      renderGhostForComposer(editor, conversationId, cached, footerEl);
    }
  }

  let pollTimer = null;
  let runWatchTimer = null;
  let rafPending = false;

  const observer = new MutationObserver(() => {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      void syncAllComposers(false);
    });
  });

  function start() {
    injectStyles();
    window.addEventListener('keydown', onGlobalKeyDown, true);
    window.addEventListener('click', onGlobalClickSubmit, true);
    window.addEventListener('input', onGlobalInputOrCompose, true);
    window.addEventListener('compositionstart', onGlobalInputOrCompose, true);
    window.addEventListener('compositionend', onGlobalInputOrCompose, true);

    void apiGet('/api/status').then((st) => {
      if (st && st.ok) {
        serviceEnabled = Boolean(st.enabled);
        pluginEnabled = st.pluginEnabled !== false;
      }
      void syncAllComposers(true);
    });

    if (document.body) {
      observer.observe(document.body, { childList: true, subtree: true });
    }
    pollTimer = setInterval(() => {
      void syncAllComposers(true);
    }, 1800);
    runWatchTimer = setInterval(() => {
      detectTurnCompletionAndTrigger();
    }, 600);
  }

  window.__AGY_TAB_SUGGEST_CLEANUP__ = () => {
    try {
      observer.disconnect();
    } catch {}
    if (pollTimer) clearInterval(pollTimer);
    if (runWatchTimer) clearInterval(runWatchTimer);
    if (fastPollTimer) clearInterval(fastPollTimer);

    window.removeEventListener('keydown', onGlobalKeyDown, true);
    window.removeEventListener('click', onGlobalClickSubmit, true);
    window.removeEventListener('input', onGlobalInputOrCompose, true);
    window.removeEventListener('compositionstart', onGlobalInputOrCompose, true);
    window.removeEventListener('compositionend', onGlobalInputOrCompose, true);

    document.getElementById('agy-tab-suggest-popover')?.remove();
    document.getElementById(STYLE_ID)?.remove();
    qsa('[data-agy-ghost-showing]').forEach((el) => el.removeAttribute('data-agy-ghost-showing'));
    qsa('.agy-tab-ghost-overlay').forEach((el) => el.remove());
    qsa('.agy-tab-suggest-wrapper').forEach((el) => el.remove());
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
