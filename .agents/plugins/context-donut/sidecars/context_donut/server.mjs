import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { resolveTranscriptPath, parseTranscriptUsage } from '../../scripts/transcript-parser.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SIDECAR_PORT = Number(process.env.PORT || process.env.ANTIGRAVITY_SIDECAR_PORT || 0);
const FIXED_MIRROR_PORT = 45789;

/**
 * 读取最新的上下文占用数据
 */
function getContextUsageData(requestedConversationId) {
  const targetCid =
    typeof requestedConversationId === 'string' && requestedConversationId.trim()
      ? requestedConversationId.trim()
      : null;

  if (targetCid) {
    const resolved = resolveTranscriptPath(targetCid, null);
    if (!resolved || !resolved.transcriptPath) {
      return parseTranscriptUsage(null, targetCid);
    }
    return parseTranscriptUsage(resolved.transcriptPath, resolved.conversationId);
  }

  // 未指定 conversationId 时，优先回退 Hook 写入的最新状态文件
  const scratchStatePath = path.join(
    os.homedir(),
    '.gemini',
    'antigravity',
    'scratch',
    'context-donut-state.json'
  );

  let fallbackCid = null;
  if (fs.existsSync(scratchStatePath)) {
    try {
      const state = JSON.parse(fs.readFileSync(scratchStatePath, 'utf8'));
      if (state && state.conversationId) {
        fallbackCid = state.conversationId;
      }
    } catch {
      // ignore
    }
  }

  const resolved = resolveTranscriptPath(fallbackCid, null);
  if (!resolved || !resolved.transcriptPath) {
    return parseTranscriptUsage(null, fallbackCid);
  }
  return parseTranscriptUsage(resolved.transcriptPath, resolved.conversationId);
}

/**
 * 检查当前插件是否在 ~/.gemini/config/config.json 中启用
 */
function isPluginEnabled() {
  try {
    const cfgPath = path.join(os.homedir(), '.gemini', 'config', 'config.json');
    if (!fs.existsSync(cfgPath)) return true;
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    if (cfg?.plugins?.['context-donut']?.enabled === false) {
      return false;
    }
    return true;
  } catch {
    return true;
  }
}

/**
 * 生成 Sidecar 辅助面板 HTML (Codex 风格甜甜圈实时监控台)
 */
function renderDashboardHtml() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Context Donut 上下文监控</title>
  <style>
    :root {
      --bg: #0f1117;
      --card: #161922;
      --card-hover: #1c202c;
      --border: #262b38;
      --fg: #f3f4f6;
      --muted: #9ca3af;
      --emerald: #10b981;
      --cyan: #38bdf8;
      --amber: #f59e0b;
      --rose: #ef4444;
      --purple: #a855f7;
    }
    @media (prefers-color-scheme: light) {
      :root {
        --bg: #f8fafc;
        --card: #ffffff;
        --card-hover: #f1f5f9;
        --border: #e2e8f0;
        --fg: #0f172a;
        --muted: #64748b;
      }
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Inter, sans-serif;
      background: var(--bg);
      color: var(--fg);
      padding: 16px;
      line-height: 1.5;
    }
    .container {
      max-width: 520px;
      margin: 0 auto;
      display: flex;
      flex-direction: column;
      gap: 14px;
    }
    .card {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 14px;
      padding: 16px;
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.12);
    }
    .header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 12px;
    }
    .title-group {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .title {
      font-size: 14px;
      font-weight: 600;
      letter-spacing: 0.01em;
    }
    .badge {
      font-size: 11px;
      padding: 2px 8px;
      border-radius: 999px;
      background: rgba(16, 185, 129, 0.15);
      color: var(--emerald);
      font-weight: 600;
    }
    .limit-Read {
      display: flex;
      gap: 4px;
      background: var(--bg);
      padding: 3px;
      border-radius: 8px;
      border: 1px solid var(--border);
    }
    .limit-btn {
      border: none;
      background: transparent;
      color: var(--muted);
      font-size: 11px;
      font-weight: 600;
      padding: 3px 8px;
      border-radius: 6px;
      cursor: pointer;
      transition: all 0.15s;
    }
    .limit-btn.active {
      background: var(--card);
      color: var(--fg);
      box-shadow: 0 1px 3px rgba(0,0,0,0.2);
    }
    .hero {
      display: flex;
      align-items: center;
      gap: 20px;
      padding: 8px 0;
    }
    .donut-wrap {
      position: relative;
      width: 116px;
      height: 116px;
      flex-shrink: 0;
    }
    .donut-center {
      position: absolute;
      inset: 0;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      text-align: center;
    }
    .donut-pct {
      font-size: 22px;
      font-weight: 700;
      font-variant-numeric: tabular-nums;
    }
    .donut-sub {
      font-size: 10px;
      color: var(--muted);
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    .metrics {
      flex: 1;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .metric-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      font-size: 12px;
    }
    .metric-label {
      display: flex;
      align-items: center;
      gap: 6px;
      color: var(--muted);
    }
    .dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
    }
    .metric-val {
      font-weight: 600;
      font-variant-numeric: tabular-nums;
    }
    .bar-track {
      height: 6px;
      width: 100%;
      background: var(--bg);
      border-radius: 999px;
      overflow: hidden;
      display: flex;
      margin-top: 12px;
    }
    .bar-seg {
      height: 100%;
      transition: width 0.35s ease;
    }
    .history-chart {
      display: flex;
      align-items: flex-end;
      gap: 4px;
      height: 72px;
      padding-top: 12px;
    }
    .history-bar {
      flex: 1;
      min-width: 6px;
      background: rgba(56, 189, 248, 0.25);
      border-top: 2px solid var(--cyan);
      border-radius: 3px 3px 0 0;
      transition: height 0.25s ease;
      position: relative;
    }
    .history-bar:hover {
      background: rgba(16, 185, 129, 0.45);
      border-top-color: var(--emerald);
    }
    .footer-meta {
      display: flex;
      justify-content: space-between;
      font-size: 11px;
      color: var(--muted);
      margin-top: 8px;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="card">
      <div class="header">
        <div class="title-group">
          <span class="title">上下文窗口</span>
          <span class="badge" id="model-badge">Gemini</span>
        </div>
        <div class="limit-Read" id="limit-group">
          <button class="limit-btn active" data-limit="512000">512k</button>
          <button class="limit-btn" data-limit="1000000">1M</button>
        </div>
      </div>

      <div class="hero">
        <div class="donut-wrap">
          <svg viewBox="0 0 100 100" width="116" height="116" style="transform: rotate(-90deg)">
            <circle cx="50" cy="50" r="40" fill="none" stroke="var(--border)" stroke-width="10" />
            <circle id="arc-cache" cx="50" cy="50" r="40" fill="none" stroke="var(--emerald)" stroke-width="10" stroke-dasharray="0 251.3" stroke-linecap="round" style="transition: all 0.35s ease" />
            <circle id="arc-input" cx="50" cy="50" r="40" fill="none" stroke="var(--cyan)" stroke-width="10" stroke-dasharray="0 251.3" stroke-dashoffset="0" stroke-linecap="round" style="transition: all 0.35s ease" />
          </svg>
          <div class="donut-center">
            <span class="donut-pct" id="pct-text">0%</span>
            <span class="donut-sub" id="used-short">0 / 512k</span>
          </div>
        </div>

        <div class="metrics">
          <div class="metric-row">
            <span class="metric-label"><span class="dot" style="background:var(--emerald)"></span>缓存命中</span>
            <span class="metric-val" id="val-cache">0</span>
          </div>
          <div class="metric-row">
            <span class="metric-label"><span class="dot" style="background:var(--cyan)"></span>本轮新增输入</span>
            <span class="metric-val" id="val-input">0</span>
          </div>
          <div class="metric-row">
            <span class="metric-label"><span class="dot" style="background:var(--purple)"></span>模型输出</span>
            <span class="metric-val" id="val-output">0</span>
          </div>
        </div>
      </div>

      <div class="bar-track">
        <div class="bar-seg" id="seg-cache" style="width:0%; background:var(--emerald)"></div>
        <div class="bar-seg" id="seg-input" style="width:0%; background:var(--cyan)"></div>
        <div class="bar-seg" id="seg-output" style="width:0%; background:var(--purple)"></div>
      </div>

      <div class="footer-meta">
        <span id="cache-rate">缓存命中率: 0%</span>
        <span id="step-info">轮数: 0 · 步数: 0</span>
      </div>
    </div>

    <div class="card">
      <div class="header" style="margin-bottom:4px">
        <span class="title">每步上下文增长趋势 (最近 30 步)</span>
        <span style="font-size:11px;color:var(--muted)" id="cum-output">累计输出: 0</span>
      </div>
      <div class="history-chart" id="history-chart"></div>
      <div class="footer-meta">
        <span id="cid-label">会话 ID: --</span>
        <span id="updated-label">实时同步中</span>
      </div>
    </div>
  </div>

  <script>
    const CIRC = 2 * Math.PI * 40;
    const STORAGE_KEY_LIMIT = 'agy_context_donut_limit';
    const STORAGE_KEY_SCHEMA = 'agy_context_donut_limit_schema';
    const LIMIT_SCHEMA_VERSION = '512k_1m_v1';
    const VALID_LIMITS = [512000, 1000000];
    let maxLimit = Number(localStorage.getItem(STORAGE_KEY_LIMIT) || 512000);
    if (
      localStorage.getItem(STORAGE_KEY_SCHEMA) !== LIMIT_SCHEMA_VERSION ||
      !VALID_LIMITS.includes(maxLimit)
    ) {
      maxLimit = 512000;
      localStorage.setItem(STORAGE_KEY_LIMIT, String(maxLimit));
      localStorage.setItem(STORAGE_KEY_SCHEMA, LIMIT_SCHEMA_VERSION);
    }
    let lastData = null;

    function fmtNum(n) {
      return Number(n || 0).toLocaleString();
    }
    function fmtCompact(n) {
      n = Number(n || 0);
      if (n >= 1e6) return (n / 1e6).toFixed(n % 1e6 === 0 ? 0 : 1) + 'M';
      if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e5 ? 0 : 1) + 'k';
      return String(n);
    }

    function updateLimitButtons() {
      document.querySelectorAll('.limit-btn').forEach(btn => {
        btn.classList.toggle('active', Number(btn.dataset.limit) === maxLimit);
      });
    }

    document.getElementById('limit-group').addEventListener('click', (e) => {
      const btn = e.target.closest('.limit-btn');
      if (!btn) return;
      maxLimit = Number(btn.dataset.limit);
      localStorage.setItem(STORAGE_KEY_LIMIT, String(maxLimit));
      localStorage.setItem(STORAGE_KEY_SCHEMA, LIMIT_SCHEMA_VERSION);
      updateLimitButtons();
      if (lastData) render(lastData);
    });

    function render(data) {
      lastData = data;
      const total = data.totalTokens || 0;
      const cache = data.cacheReadTokens || 0;
      const input = data.inputTokens || 0;
      const output = data.outputTokens || 0;
      const pct = Math.min(100, (total / maxLimit) * 100);

      document.getElementById('model-badge').textContent = data.modelName || 'Gemini';
      document.getElementById('pct-text').textContent = pct.toFixed(1) + '%';
      document.getElementById('used-short').textContent = fmtCompact(total) + ' / ' + fmtCompact(maxLimit);

      document.getElementById('val-cache').textContent = fmtNum(cache);
      document.getElementById('val-input').textContent = fmtNum(input);
      document.getElementById('val-output').textContent = fmtNum(output);

      const cacheFrac = Math.min(1, cache / maxLimit);
      const inputFrac = Math.min(1 - cacheFrac, (input + output) / maxLimit);

      const arcCache = document.getElementById('arc-cache');
      const arcInput = document.getElementById('arc-input');
      arcCache.setAttribute('stroke-dasharray', \`\${cacheFrac * CIRC} \${CIRC}\`);
      arcInput.setAttribute('stroke-dasharray', \`\${inputFrac * CIRC} \${CIRC}\`);
      arcInput.setAttribute('stroke-dashoffset', String(-cacheFrac * CIRC));

      if (pct >= 85) {
        arcCache.setAttribute('stroke', 'var(--rose)');
      } else if (pct >= 65) {
        arcCache.setAttribute('stroke', 'var(--amber)');
      } else {
        arcCache.setAttribute('stroke', 'var(--emerald)');
      }

      document.getElementById('seg-cache').style.width = (cache / maxLimit * 100).toFixed(2) + '%';
      document.getElementById('seg-input').style.width = (input / maxLimit * 100).toFixed(2) + '%';
      document.getElementById('seg-output').style.width = (output / maxLimit * 100).toFixed(2) + '%';

      document.getElementById('cache-rate').textContent = '缓存命中率: ' + (data.cacheHitRate || 0) + '%';
      document.getElementById('step-info').textContent = \`对话轮数: \${data.turnCount || 0} · 模型步数: \${data.plannerStepCount || 0}\`;
      document.getElementById('cum-output').textContent = '累计生成: ' + fmtCompact(data.cumulativeOutputTokens || 0) + ' tokens';
      document.getElementById('cid-label').textContent = '会话: ' + (data.conversationId ? data.conversationId.slice(0, 8) + '…' : '--');

      const history = data.history || [];
      const chart = document.getElementById('history-chart');
      const peak = Math.max(maxLimit * 0.25, ...history.map(h => h.totalTokens || 0), 1);
      chart.innerHTML = history.map(h => {
        const hPct = Math.max(8, Math.min(100, (h.totalTokens / peak) * 100));
        return \`<div class="history-bar" style="height:\${hPct}%" title="Step #\${h.stepIndex}: \${fmtNum(h.totalTokens)} tokens"></div>\`;
      }).join('');
    }

    async function poll() {
      try {
        const res = await fetch('/api/context');
        const data = await res.json();
        render(data);
      } catch (e) {}
    }

    updateLimitButtons();
    poll();
    setInterval(poll, 2000);
  </script>
</body>
</html>`;
}

function handleRequest(req, res) {
  // 允许来自 Antigravity 主窗口渲染层的跨域访问
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const urlObj = new URL(req.url || '/', 'http://127.0.0.1');

  if (urlObj.pathname === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', enabled: isPluginEnabled() }));
    return;
  }

  if (urlObj.pathname === '/api/context') {
    const cid = urlObj.searchParams.get('conversationId') || undefined;
    const usage = getContextUsageData(cid);
    usage.pluginEnabled = isPluginEnabled();
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(JSON.stringify(usage));
    return;
  }

  if (urlObj.pathname === '/composer-donut.js') {
    const scriptPath = path.join(__dirname, '..', '..', 'renderer', 'composer-donut.js');
    if (fs.existsSync(scriptPath)) {
      res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' });
      res.end(fs.readFileSync(scriptPath, 'utf8'));
      return;
    }
  }

  // 默认返回 Sidecar 仪表盘 UI
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(renderDashboardHtml());
}

// 1. 启动 Antigravity Sidecar 主端口服务
const mainServer = http.createServer(handleRequest);
mainServer.listen(SIDECAR_PORT, '127.0.0.1', () => {
  const addr = mainServer.address();
  const actualPort = typeof addr === 'object' && addr ? addr.port : SIDECAR_PORT;
  console.log(`[Context Donut Sidecar] listening on http://127.0.0.1:${actualPort}`);
});

// 2. 同时在固定本地端口 45789 启动镜像服务，方便对话框底部组件随时零配置拉取最新数据
if (SIDECAR_PORT !== FIXED_MIRROR_PORT) {
  const mirrorServer = http.createServer(handleRequest);
  mirrorServer.on('error', () => {
    // 若端口已被占用则静默忽略
  });
  mirrorServer.listen(FIXED_MIRROR_PORT, '127.0.0.1');
}

/**
 * 解析运行中的 Antigravity DevToolsActivePort 文件路径（兼容 Windows 与 WSL Linux 环境）
 */
function resolveDevToolsPortFile() {
  if (process.platform === 'win32') {
    const winPortFile = path.join(os.homedir(), 'AppData', 'Roaming', 'Antigravity', 'DevToolsActivePort');
    return fs.existsSync(winPortFile) ? winPortFile : null;
  }
  if (process.platform === 'linux' && fs.existsSync('/mnt/c/Users')) {
    try {
      for (const entry of fs.readdirSync('/mnt/c/Users', { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        if (['Public', 'Default', 'Default User', 'All Users'].includes(entry.name)) continue;
        const candidate = path.join(
          '/mnt/c/Users',
          entry.name,
          'AppData',
          'Roaming',
          'Antigravity',
          'DevToolsActivePort'
        );
        if (fs.existsSync(candidate)) {
          return candidate;
        }
      }
    } catch {}
  }
  return null;
}

// 3. 常驻自动守护：即使未来 Antigravity 客户端升级覆盖了 app.asar，Sidecar 随客户端启动时也会自动检测并挂载底部甜甜圈
async function ensureDonutInjectedInRunningWindows() {
  if (!isPluginEnabled()) return;
  const portFile = resolveDevToolsPortFile();
  if (!portFile) return;

  try {
    const lines = fs.readFileSync(portFile, 'utf8').trim().split(/\r?\n/);
    const port = Number(lines[0]);
    if (!port || isNaN(port)) return;

    const listResp = await fetch(`http://127.0.0.1:${port}/json/list`);
    if (!listResp.ok) return;
    const targets = await listResp.json();
    const pageTargets = targets.filter(
      (t) =>
        t.type === 'page' &&
        t.webSocketDebuggerUrl &&
        (t.url?.includes('127.0.0.1') || t.url?.includes('localhost') || t.title?.includes('Antigravity'))
    );
    if (pageTargets.length === 0) return;

    const scriptPath = path.join(__dirname, '..', '..', 'renderer', 'composer-donut.js');
    if (!fs.existsSync(scriptPath)) return;
    const code = fs.readFileSync(scriptPath, 'utf8');
    // 仅在窗口尚未挂载甜甜圈时自动注入，避免重复打断用户操作或引起闪烁
    const checkAndInjectExpr = `if (!window.__AGY_CONTEXT_DONUT_INSTALLED__) { ${code} }`;

    for (const target of pageTargets) {
      await new Promise((resolve) => {
        if (typeof WebSocket === 'undefined') return resolve(false);
        const timer = setTimeout(() => resolve(false), 2000);
        try {
          const ws = new WebSocket(target.webSocketDebuggerUrl);
          ws.addEventListener('open', () => {
            ws.send(
              JSON.stringify({
                id: 1,
                method: 'Runtime.evaluate',
                params: { expression: checkAndInjectExpr, returnByValue: true },
              })
            );
          });
          ws.addEventListener('message', () => {
            clearTimeout(timer);
            ws.close();
            resolve(true);
          });
          ws.addEventListener('error', () => {
            clearTimeout(timer);
            resolve(false);
          });
        } catch {
          clearTimeout(timer);
          resolve(false);
        }
      });
    }
  } catch {}
}

setTimeout(ensureDonutInjectedInRunningWindows, 1500);
setInterval(ensureDonutInjectedInRunningWindows, 8000);
