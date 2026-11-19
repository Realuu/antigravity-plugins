#!/usr/bin/env node
/**
 * Antigravity Codex Aurora Theme — 无冲突安装 / 卸载 / 状态检查工具
 *
 * 支持动作：
 *   node installer/install-theme.mjs install    # 同步插件 + 增量注入 app.asar (main/preload) + 热注入当前窗口
 *   node installer/install-theme.mjs uninstall  # 精确移除 app.asar 中的 codex-theme 钩子 + 还原当前窗口样式
 *   node installer/install-theme.mjs status     # 检查插件与 ASAR 注入状态
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PLUGIN_ROOT = path.resolve(__dirname, '..');

const GLOBAL_PLUGIN_DIR = path.join(os.homedir(), '.gemini', 'config', 'plugins', 'codex-theme');
const AGY_RESOURCES_DIR = path.join(
  os.homedir(),
  'AppData',
  'Local',
  'Programs',
  'antigravity',
  'resources'
);
const ASAR_PATH = path.join(AGY_RESOURCES_DIR, 'app.asar');
const START_MARKER = '/* __AGY_CODEX_THEME_START__ */';
const END_MARKER = '/* __AGY_CODEX_THEME_END__ */';

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
  return `\n${START_MARKER}\ntry { const { contextBridge, ipcRenderer } = require("electron"); contextBridge.exposeInMainWorld("__agyCodexThemeIPC", { setBackdropMode: (mode) => ipcRenderer.invoke("codex-theme:set-backdrop", String(mode || "")) }); } catch (_e) {}\n${END_MARKER}\n`;
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
      const tempOld = `${targetPath}.theme-old-${Date.now()}`;
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

function evaluateViaWebSocket(wsUrl, expression) {
  return new Promise((resolve) => {
    if (typeof WebSocket === 'undefined') {
      resolve({ ok: false, value: null });
      return;
    }
    const timer = setTimeout(() => resolve({ ok: false, value: null }), 3000);
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
    return { count: 0, hasBackdropIpc: false, reason: '未检测到运行中的 DevToolsActivePort 文件' };
  }

  try {
    const lines = fs.readFileSync(portFile, 'utf8').trim().split(/\r?\n/);
    const port = Number(lines[0]);
    if (!port || Number.isNaN(port)) {
      return { count: 0, hasBackdropIpc: false, reason: 'DevToolsActivePort 端口无效' };
    }

    const listResp = await fetch(`http://127.0.0.1:${port}/json/list`);
    if (!listResp.ok) {
      return { count: 0, hasBackdropIpc: false, reason: `无法访问调试目标列表 (${listResp.status})` };
    }
    const targets = await listResp.json();
    const pageTargets = targets.filter(
      (t) =>
        t.type === 'page' &&
        t.webSocketDebuggerUrl &&
        (t.url?.includes('127.0.0.1') || t.url?.includes('localhost') || t.title?.includes('Antigravity'))
    );

    if (pageTargets.length === 0) {
      return { count: 0, hasBackdropIpc: false, reason: '未找到主界面渲染目标' };
    }

    let count = 0;
    let hasBackdropIpc = false;
    for (const target of pageTargets) {
      const res = await evaluateViaWebSocket(target.webSocketDebuggerUrl, scriptExpression);
      if (res.ok) {
        count++;
        if (res.value === true) {
          hasBackdropIpc = true;
        }
      }
    }
    return { count, hasBackdropIpc };
  } catch (err) {
    return { count: 0, hasBackdropIpc: false, reason: err?.message || String(err) };
  }
}

async function runInstall() {
  console.log('=== [1/3] 同步插件到全局目录 ~/.gemini/config/plugins/codex-theme ===');
  copyDirSync(PLUGIN_ROOT, GLOBAL_PLUGIN_DIR);
  console.log('  -> 已同步至:', GLOBAL_PLUGIN_DIR);

  console.log('\n=== [2/3] 增量注入 Antigravity 启动桥接 (main.js + preload.js，保留现有插件) ===');
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
      console.log('  -> 提示: 更新 app.asar 失败（可关闭 Antigravity 后再重试）:', res.error);
    }
  }

  console.log('\n=== [3/3] 向当前运行中的 Antigravity 窗口热注入半透明冰蓝玻璃主题 ===');
  const rendererPath = path.join(PLUGIN_ROOT, 'renderer', 'codex-ui-theme.js');
  const scriptContent = fs.readFileSync(rendererPath, 'utf8');
  const hotExpr = `(() => { window.__AGY_CODEX_THEME_FORCE_RELOAD__ = true; window.__AGY_CODEX_THEME_LOCKED__ = false; ${scriptContent}; return typeof window.__agyCodexThemeIPC !== 'undefined'; })()`;
  const hotResult = await evaluateScriptInRunningWindows(hotExpr);
  if (hotResult.count > 0) {
    if (hotResult.hasBackdropIpc) {
      console.log(`  -> 已实时热更新 ${hotResult.count} 个活动窗口样式并激活原生窗口透明材质！`);
    } else {
      console.log(`  -> 已实时移除 ${hotResult.count} 个活动窗口的淡粉紫雾感并更新半透明样式；重启一次 Antigravity 后将激活底层窗口穿透透明材质。`);
    }
  } else {
    console.log(`  -> 热注入跳过 (${hotResult.reason})，重启 Antigravity 后将自动生效。`);
  }
}

async function runUninstall() {
  console.log('=== [1/2] 从 app.asar 中精确移除 codex-theme 启动与预加载钩子 ===');
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
      console.log('  -> 已移除 codex-theme 钩子（保留其他插件完整不变）');
    } else {
      console.log('  -> 移除失败（请关闭 Antigravity 后重试）:', res.error);
    }
  }

  console.log('\n=== [2/2] 还原当前运行窗口默认外观与不透明背板 ===');
  const cleanupRes = await evaluateScriptInRunningWindows(
    'try { window.__AGY_CODEX_THEME_CLEANUP__ && window.__AGY_CODEX_THEME_CLEANUP__(false); window.__AGY_CODEX_THEME_LOCKED__ = false; window.__AGY_CODEX_THEME_INSTALLED__ = false; } catch {}'
  );
  console.log(
    cleanupRes.count > 0
      ? `  -> 已还原 ${cleanupRes.count} 个活动窗口的默认外观。`
      : `  -> 跳过窗口清理 (${cleanupRes.reason})。`
  );
}

async function runStatus() {
  console.log('=== Antigravity Codex Aurora Theme 状态检查 ===');
  console.log('1. 工作区插件目录:', fs.existsSync(PLUGIN_ROOT) ? '已就绪' : '缺失');
  console.log('2. 全局插件目录:  ', fs.existsSync(GLOBAL_PLUGIN_DIR) ? '已安装' : '未安装');
  const patched = checkAsarPatched(ASAR_PATH);
  console.log('3. ASAR main.js:  ', patched.main ? '已注入启动钩子 (增量共存)' : '未注入');
  console.log('4. ASAR preload:  ', patched.preload ? '已注入透明背板 IPC 钩子 (增量共存)' : '未注入');
}

const action = (process.argv[2] || 'install').toLowerCase();
if (action === 'uninstall' || action === 'restore') {
  await runUninstall();
} else if (action === 'status') {
  await runStatus();
} else {
  await runInstall();
}
