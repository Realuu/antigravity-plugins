#!/usr/bin/env node
/**
 * Antigravity Cowart Sidebar — 无冲突安装 / 卸载 / 状态检查工具
 *
 * 支持动作：
 *   node installer/install-cowart.mjs install    # 同步插件 + 增量注入 app.asar + 启动本地画布服务 + 热注入当前窗口
 *   node installer/install-cowart.mjs uninstall  # 移除 app.asar 钩子 + 停止后台服务 + 清理当前窗口
 *   node installer/install-cowart.mjs status     # 检查插件、服务与 ASAR 注入状态
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PLUGIN_ROOT = path.resolve(__dirname, '..');

const GLOBAL_PLUGIN_DIR = path.join(os.homedir(), '.gemini', 'config', 'plugins', 'cowart-sidebar');
const AGY_RESOURCES_DIR = path.join(
  os.homedir(),
  'AppData',
  'Local',
  'Programs',
  'antigravity',
  'resources'
);
const ASAR_PATH = path.join(AGY_RESOURCES_DIR, 'app.asar');
const PID_FILE = path.join(os.homedir(), '.gemini', 'antigravity', 'sidecar_data', 'cowart', 'stage_server.json');
const STAGE_URL = 'http://127.0.0.1:45791';

const START_MARKER = '/* __AGY_COWART_SIDEBAR_START__ */';
const END_MARKER = '/* __AGY_COWART_SIDEBAR_END__ */';

function copyDirSync(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

function readAsarArchive(asarFilePath) {
  const buf = fs.readFileSync(asarFilePath);
  const headerPayloadSize = buf.readUInt32LE(4);
  const headerStringSize = buf.readUInt32LE(12);
  const headerJson = buf.toString('utf8', 16, 16 + headerStringSize).replace(/\0+$/, '');
  const header = JSON.parse(headerJson);
  const baseOffset = 8 + headerPayloadSize;
  return { buf, header, baseOffset };
}

function buildPatchedAsarBuffer(asarFilePath, fileMutator) {
  const { buf, header, baseOffset } = readAsarArchive(asarFilePath);
  const chunks = [];
  let currentOffset = 0;

  function cloneTree(node, relPath = '') {
    if (node.files) {
      const outFiles = {};
      for (const [name, child] of Object.entries(node.files)) {
        outFiles[name] = cloneTree(child, relPath ? `${relPath}/${name}` : name);
      }
      return { files: outFiles };
    }
    if (node.unpacked) {
      return { ...node };
    }
    const origOffset = baseOffset + parseInt(node.offset, 10);
    let fileBuf = buf.subarray(origOffset, origOffset + node.size);
    const mutated = fileMutator(relPath, fileBuf);
    if (typeof mutated === 'string' || Buffer.isBuffer(mutated)) {
      fileBuf = Buffer.isBuffer(mutated) ? mutated : Buffer.from(mutated, 'utf8');
    }
    const newEntry = {
      size: fileBuf.length,
      offset: String(currentOffset),
    };
    chunks.push(fileBuf);
    currentOffset += fileBuf.length;
    return newEntry;
  }

  const newHeader = cloneTree(header);
  const headerStr = JSON.stringify(newHeader);
  const headerStrBuf = Buffer.from(headerStr, 'utf8');
  const alignPadding = (4 - (headerStrBuf.length % 4)) % 4;
  const alignedStrLen = headerStrBuf.length + alignPadding;

  const preamble = Buffer.alloc(16 + alignedStrLen);
  preamble.writeUInt32LE(4, 0);
  preamble.writeUInt32LE(alignedStrLen + 8, 4);
  preamble.writeUInt32LE(alignedStrLen + 4, 8);
  preamble.writeUInt32LE(headerStrBuf.length, 12);
  headerStrBuf.copy(preamble, 16);

  return Buffer.concat([preamble, ...chunks]);
}

function stripMarkedBlock(text) {
  const escapedStart = START_MARKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const escapedEnd = END_MARKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`\\n?${escapedStart}[\\s\\S]*?${escapedEnd}\\n?`, 'g');
  return text.replace(re, '');
}

function getMainHookSnippet() {
  const hookPath = path
    .join(GLOBAL_PLUGIN_DIR, 'bridge', 'electron-main-hook.cjs')
    .replace(/\\/g, '/');
  return `${START_MARKER}\ntry { require("${hookPath}"); } catch (_e) {}\n${END_MARKER}\n`;
}

function getPreloadHookSnippet() {
  return `\n${START_MARKER}\ntry { const { contextBridge, ipcRenderer } = require("electron"); contextBridge.exposeInMainWorld("__agyCowartSidebarIPC", { pickFolder: () => ipcRenderer.invoke("cowart-sidebar:pick-folder"), insertText: (text) => ipcRenderer.invoke("cowart-sidebar:insert-text", String(text || "")) }); } catch (_e) {}\n${END_MARKER}\n`;
}

function checkAsarPatched(asarFilePath) {
  if (!fs.existsSync(asarFilePath)) return { main: false, preload: false };
  try {
    const { buf, header, baseOffset } = readAsarArchive(asarFilePath);
    const readDistText = (name) => {
      const node = header?.files?.dist?.files?.[name];
      if (!node) return '';
      const off = baseOffset + parseInt(node.offset, 10);
      return buf.toString('utf8', off, off + node.size);
    };
    return {
      main: readDistText('main.js').includes(START_MARKER),
      preload: readDistText('preload.js').includes(START_MARKER),
    };
  } catch {
    return { main: false, preload: false };
  }
}

function writeAsarSafely(targetPath, patchedBuf) {
  try {
    fs.writeFileSync(targetPath, patchedBuf);
    return { ok: true, mode: 'direct' };
  } catch (writeErr) {
    try {
      const tempOld = `${targetPath}.cowart-old-${Date.now()}`;
      fs.renameSync(targetPath, tempOld);
      fs.writeFileSync(targetPath, patchedBuf);
      try {
        fs.unlinkSync(tempOld);
      } catch {}
      return { ok: true, mode: 'atomic-rename' };
    } catch (renameErr) {
      return { ok: false, error: renameErr?.message || writeErr?.message || 'write failed' };
    }
  }
}

async function probeStageHealth() {
  try {
    const resp = await fetch(`${STAGE_URL}/api/health`, { cache: 'no-store' });
    if (!resp.ok) return null;
    return await resp.json();
  } catch {
    return null;
  }
}

async function ensureStageDaemonStarted() {
  const existing = await probeStageHealth();
  if (existing && existing.ok) {
    return { started: true, reused: true, health: existing };
  }
  const serverScript = path.join(GLOBAL_PLUGIN_DIR, 'scripts', 'cowart-stage-server.mjs');
  let launchedViaWmi = false;
  if (process.platform === 'win32') {
    try {
      const cmdLine = `"${process.execPath}" "${serverScript}"`;
      const psScript = `Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = '${cmdLine.replace(/'/g, "''")}' } | Out-Null`;
      execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', psScript], {
        windowsHide: true,
        timeout: 5000,
      });
      launchedViaWmi = true;
    } catch {}
  }
  if (!launchedViaWmi) {
    const child = spawn(process.execPath, [serverScript], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: { ...process.env },
    });
    child.unref();
  }

  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 250));
    const h = await probeStageHealth();
    if (h && h.ok) {
      return { started: true, reused: false, health: h };
    }
  }
  return { started: false, reused: false, health: null };
}

function stopStageDaemon() {
  try {
    if (!fs.existsSync(PID_FILE)) return false;
    const info = JSON.parse(fs.readFileSync(PID_FILE, 'utf8'));
    if (info && info.pid) {
      process.kill(Number(info.pid));
      fs.rmSync(PID_FILE, { force: true });
      return true;
    }
  } catch {}
  return false;
}

function evaluateViaWebSocket(wsUrl, expression) {
  return new Promise((resolve) => {
    if (typeof WebSocket === 'undefined') {
      resolve({ ok: false, value: null });
      return;
    }
    const timer = setTimeout(() => resolve({ ok: false, value: null }), 4000);
    try {
      const ws = new WebSocket(wsUrl);
      ws.addEventListener('open', () => {
        ws.send(
          JSON.stringify({
            id: 1,
            method: 'Runtime.evaluate',
            params: {
              expression,
              returnByValue: true,
            },
          })
        );
      });
      ws.addEventListener('message', (ev) => {
        try {
          const msg = JSON.parse(String(ev.data));
          if (msg.id === 1) {
            clearTimeout(timer);
            ws.close();
            resolve({ ok: true, value: msg?.result?.result?.value ?? null });
          }
        } catch {}
      });
      ws.addEventListener('error', () => {
        clearTimeout(timer);
        resolve({ ok: false, value: null });
      });
    } catch {
      clearTimeout(timer);
      resolve({ ok: false, value: null });
    }
  });
}

async function evaluateScriptInRunningWindows(scriptExpression) {
  const portFile = path.join(os.homedir(), 'AppData', 'Roaming', 'Antigravity', 'DevToolsActivePort');
  if (!fs.existsSync(portFile)) {
    return { count: 0, results: [], reason: '未检测到运行中的 DevToolsActivePort 文件' };
  }

  try {
    const lines = fs.readFileSync(portFile, 'utf8').trim().split(/\r?\n/);
    const port = Number(lines[0]);
    if (!port || Number.isNaN(port)) {
      return { count: 0, results: [], reason: 'DevToolsActivePort 端口无效' };
    }

    const listResp = await fetch(`http://127.0.0.1:${port}/json/list`);
    if (!listResp.ok) {
      return { count: 0, results: [], reason: `无法访问调试目标列表 (${listResp.status})` };
    }
    const targets = await listResp.json();
    const pageTargets = targets.filter(
      (t) =>
        t.type === 'page' &&
        t.webSocketDebuggerUrl &&
        (t.url?.includes('127.0.0.1') || t.url?.includes('localhost') || t.title?.includes('Antigravity')) &&
        !t.url?.includes(':45791') &&
        !t.url?.includes(':45792') &&
        !t.url?.includes(':45793')
    );

    if (pageTargets.length === 0) {
      return { count: 0, results: [], reason: '未找到主界面渲染目标' };
    }

    let count = 0;
    const results = [];
    for (const target of pageTargets) {
      const res = await evaluateViaWebSocket(target.webSocketDebuggerUrl, scriptExpression);
      if (res.ok) {
        count++;
        results.push(res.value);
      }
    }
    return { count, results };
  } catch (err) {
    return { count: 0, results: [], reason: err?.message || String(err) };
  }
}

async function runInstall() {
  console.log('=== [1/4] 同步插件到全局目录 ~/.gemini/config/plugins/cowart-sidebar ===');
  copyDirSync(PLUGIN_ROOT, GLOBAL_PLUGIN_DIR);
  console.log('  -> 已同步至:', GLOBAL_PLUGIN_DIR);

  console.log('\n=== [2/4] 增量注入 Antigravity 启动桥接 (main.js + preload.js，保留现有插件) ===');
  if (!fs.existsSync(ASAR_PATH)) {
    console.log('  -> 未找到 app.asar:', ASAR_PATH);
  } else {
    const patchedBuf = buildPatchedAsarBuffer(ASAR_PATH, (relPath, fileBuf) => {
      if (relPath === 'dist/main.js') {
        const cleanText = stripMarkedBlock(fileBuf.toString('utf8'));
        return getMainHookSnippet() + cleanText;
      }
      if (relPath === 'dist/preload.js') {
        const cleanText = stripMarkedBlock(fileBuf.toString('utf8'));
        return cleanText + getPreloadHookSnippet();
      }
      return null;
    });
    const res = writeAsarSafely(ASAR_PATH, patchedBuf);
    if (res.ok) {
      console.log(`  -> 已无冲突增量更新 app.asar (${res.mode}，下次重启自动生效)`);
    } else {
      console.log('  -> 提示: 更新 app.asar 失败（可关闭 Antigravity 后重试）:', res.error);
    }
  }

  console.log('\n=== [3/4] 启动并校验 Cowart Stage Server (127.0.0.1:45791) ===');
  const daemonRes = await ensureStageDaemonStarted();
  if (daemonRes.started) {
    console.log(
      `  -> Stage Server 已就绪 (${daemonRes.reused ? '复用现有进程' : '新启动后台进程'}，PID=${daemonRes.health?.pid})`
    );
  } else {
    console.log('  -> 警告: Stage Server 启动超时，请手动检查 ~/.gemini/config/plugins/cowart-sidebar/scripts/cowart-stage-server.mjs');
  }

  console.log('\n=== [4/4] 向当前运行中的 Antigravity 窗口热注入 Cowart 侧栏入口 ===');
  const rendererPath = path.join(PLUGIN_ROOT, 'renderer', 'cowart-sidebar.js');
  const scriptContent = fs.readFileSync(rendererPath, 'utf8');
  const hotExpr = `(() => { window.__AGY_COWART_SIDEBAR_FORCE_RELOAD__ = true; window.__AGY_COWART_SIDEBAR_LOCKED__ = false; ${scriptContent}; const nav = document.getElementById('agy-cowart-nav-item'); return { mounted: Boolean(nav), prevText: nav?.previousElementSibling?.innerText?.trim() || '', nextText: nav?.nextElementSibling?.innerText?.trim() || '' }; })()`;
  const hotResult = await evaluateScriptInRunningWindows(hotExpr);
  if (hotResult.count > 0) {
    console.log(`  -> 已实时热注入 ${hotResult.count} 个活动窗口:`, JSON.stringify(hotResult.results));
  } else {
    console.log(`  -> 热注入跳过 (${hotResult.reason})，重启 Antigravity 后将自动生效。`);
  }
}

async function runUninstall() {
  console.log('=== [1/3] 从 app.asar 中精确移除 cowart-sidebar 启动与预加载钩子 ===');
  if (fs.existsSync(ASAR_PATH)) {
    const patchedBuf = buildPatchedAsarBuffer(ASAR_PATH, (relPath, fileBuf) => {
      if (relPath === 'dist/main.js' || relPath === 'dist/preload.js') {
        const text = fileBuf.toString('utf8');
        if (!text.includes(START_MARKER)) return null;
        return stripMarkedBlock(text);
      }
      return null;
    });
    const res = writeAsarSafely(ASAR_PATH, patchedBuf);
    if (res.ok) {
      console.log('  -> 已移除 cowart-sidebar 钩子（保留其他插件完整不变）');
    } else {
      console.log('  -> 移除失败（请关闭 Antigravity 后重试）:', res.error);
    }
  }

  console.log('\n=== [2/3] 停止本地 Cowart Stage Server ===');
  const stopped = stopStageDaemon();
  console.log(stopped ? '  -> 已停止 Stage Server 后台进程。' : '  -> 未检测到运行中的后台记录。');

  console.log('\n=== [3/3] 清理当前运行窗口的 Cowart 侧栏与画布 DOM ===');
  const cleanupRes = await evaluateScriptInRunningWindows(
    'try { window.__AGY_COWART_SIDEBAR_CLEANUP__ && window.__AGY_COWART_SIDEBAR_CLEANUP__(false); window.__AGY_COWART_SIDEBAR_LOCKED__ = false; window.__AGY_COWART_SIDEBAR_INSTALLED__ = false; } catch {}'
  );
  console.log(
    cleanupRes.count > 0
      ? `  -> 已清理 ${cleanupRes.count} 个活动窗口。`
      : `  -> 跳过窗口清理 (${cleanupRes.reason})。`
  );
}

async function runStatus() {
  console.log('=== Antigravity Cowart Sidebar 状态检查 ===');
  console.log('1. 工作区插件目录:', fs.existsSync(PLUGIN_ROOT) ? '已就绪' : '缺失');
  console.log('2. 全局插件目录:  ', fs.existsSync(GLOBAL_PLUGIN_DIR) ? '已安装' : '未安装');
  const patched = checkAsarPatched(ASAR_PATH);
  console.log('3. ASAR main.js:  ', patched.main ? '已注入启动钩子 (增量共存)' : '未注入');
  console.log('4. ASAR preload:  ', patched.preload ? '已注入 IPC 钩子 (增量共存)' : '未注入');
  const health = await probeStageHealth();
  console.log('5. Stage Server:  ', health?.ok ? `运行中 (PID=${health.pid}, Cowart=${health.cowartInstalled})` : '未运行');
}

const action = (process.argv[2] || 'install').toLowerCase();
if (action === 'uninstall' || action === 'restore') {
  await runUninstall();
} else if (action === 'status') {
  await runStatus();
} else {
  await runInstall();
}
