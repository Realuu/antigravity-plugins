#!/usr/bin/env node
/**
 * Antigravity Task Timer — 无冲突增量安装 / 卸载 / 状态检查工具
 *
 * 支持三种动作（可在 Windows 或 WSL Linux 环境内直接执行）：
 *   node installer/install-task-timer.mjs install    # 同步全局插件目录 + 增量注入 app.asar (main.js) + 热注入当前窗口
 *   node installer/install-task-timer.mjs uninstall  # 精确移除 app.asar 中的 task-timer 钩子 + 清理当前窗口计时条
 *   node installer/install-task-timer.mjs status     # 检查插件与 ASAR 增量注入状态
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PLUGIN_ROOT = path.resolve(__dirname, '..');

const IS_WIN = process.platform === 'win32';
const IS_LINUX = process.platform === 'linux';
const START_MARKER = '/* __AGY_TASK_TIMER_START__ */';
const END_MARKER = '/* __AGY_TASK_TIMER_END__ */';

/**
 * 定位 Windows 宿主侧用户目录、全局插件目录与 Antigravity app.asar 路径（同时支持从 Windows 或 WSL Linux 执行）
 */
function resolveWindowsHostPaths() {
  if (IS_WIN) {
    const winHome = os.homedir();
    const globalPluginDir = path.join(winHome, '.gemini', 'config', 'plugins', 'task-timer');
    const hookWinPosixPath = path
      .join(globalPluginDir, 'bridge', 'electron-main-hook.cjs')
      .replace(/\\/g, '/');
    return {
      winHome,
      globalPluginDir,
      hookWinPosixPath,
      asarPath: path.join(winHome, 'AppData', 'Local', 'Programs', 'antigravity', 'resources', 'app.asar'),
      devToolsPortPath: path.join(winHome, 'AppData', 'Roaming', 'Antigravity', 'DevToolsActivePort'),
    };
  }

  if (IS_LINUX && fs.existsSync('/mnt/c/Users')) {
    try {
      for (const entry of fs.readdirSync('/mnt/c/Users', { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        if (['Public', 'Default', 'Default User', 'All Users'].includes(entry.name)) continue;
        const candidateHome = path.join('/mnt/c/Users', entry.name);
        const candidateAsar = path.join(
          candidateHome,
          'AppData',
          'Local',
          'Programs',
          'antigravity',
          'resources',
          'app.asar'
        );
        if (fs.existsSync(candidateAsar)) {
          const globalPluginDir = path.join(candidateHome, '.gemini', 'config', 'plugins', 'task-timer');
          const hookWinPosixPath = `C:/Users/${entry.name}/.gemini/config/plugins/task-timer/bridge/electron-main-hook.cjs`;
          return {
            winHome: candidateHome,
            globalPluginDir,
            hookWinPosixPath,
            asarPath: candidateAsar,
            devToolsPortPath: path.join(candidateHome, 'AppData', 'Roaming', 'Antigravity', 'DevToolsActivePort'),
          };
        }
      }
    } catch {}
  }

  return null;
}

function copyDirSync(src, dest) {
  if (path.resolve(src) === path.resolve(dest)) return;
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

function getMainHookSnippet(hookWinPosixPath) {
  return `${START_MARKER}\ntry { require("${hookWinPosixPath}"); } catch (_e) {}\n${END_MARKER}\n`;
}

function checkAsarPatched(asarFilePath) {
  if (!asarFilePath || !fs.existsSync(asarFilePath)) return false;
  try {
    const { buf, header, baseOffset } = readAsarArchive(asarFilePath);
    const node = header?.files?.dist?.files?.['main.js'];
    if (!node) return false;
    const off = baseOffset + parseInt(node.offset, 10);
    return buf.toString('utf8', off, off + node.size).includes(START_MARKER);
  } catch {
    return false;
  }
}

function writeAsarSafely(targetPath, patchedBuf) {
  try {
    fs.writeFileSync(targetPath, patchedBuf);
    return { ok: true, mode: 'direct' };
  } catch (writeErr) {
    try {
      const tempOld = `${targetPath}.task-timer-old-${Date.now()}`;
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

async function evaluateScriptInRunningWindows(devToolsPortPath, scriptExpression) {
  if (!devToolsPortPath || !fs.existsSync(devToolsPortPath)) {
    return { count: 0, values: [], reason: '未检测到运行中的 DevToolsActivePort 文件' };
  }

  try {
    const lines = fs.readFileSync(devToolsPortPath, 'utf8').trim().split(/\r?\n/);
    const port = Number(lines[0]);
    if (!port || Number.isNaN(port)) {
      return { count: 0, values: [], reason: 'DevToolsActivePort 端口无效' };
    }

    const listResp = await fetch(`http://127.0.0.1:${port}/json/list`);
    if (!listResp.ok) {
      return { count: 0, values: [], reason: `无法访问调试目标列表 (${listResp.status})` };
    }
    const targets = await listResp.json();
    const pageTargets = targets.filter(
      (t) =>
        t.type === 'page' &&
        t.webSocketDebuggerUrl &&
        (t.url?.includes('127.0.0.1') || t.url?.includes('localhost') || t.title?.includes('Antigravity'))
    );

    if (pageTargets.length === 0) {
      return { count: 0, values: [], reason: '未找到主界面渲染目标' };
    }

    let count = 0;
    const values = [];
    for (const target of pageTargets) {
      const res = await evaluateViaWebSocket(target.webSocketDebuggerUrl, scriptExpression);
      if (res.ok) {
        count++;
        values.push(res.value);
      }
    }
    return { count, values };
  } catch (err) {
    return { count: 0, values: [], reason: err?.message || String(err) };
  }
}

async function runInstall() {
  const hostPaths = resolveWindowsHostPaths();

  console.log('=== [1/3] 同步插件到全局目录 ~/.gemini/config/plugins/task-timer ===');
  if (hostPaths) {
    copyDirSync(PLUGIN_ROOT, hostPaths.globalPluginDir);
    console.log('  -> [Windows 全局] 已同步至:', hostPaths.globalPluginDir);
  } else {
    console.log('  -> 提示: 未检测到 Windows 宿主目录，跳过全局文件同步。');
  }

  console.log('\n=== [2/3] 增量注入 Antigravity 启动桥接 (main.js，保留现有插件) ===');
  if (!hostPaths || !fs.existsSync(hostPaths.asarPath)) {
    console.log('  -> 未找到 app.asar，跳过客户端启动注入。');
  } else {
    const patchedBuf = buildPatchedAsarBuffer(hostPaths.asarPath, (relPath, fileBuf) => {
      if (relPath === 'dist/main.js') {
        const cleanText = stripMarkedBlock(fileBuf.toString('utf8'));
        return getMainHookSnippet(hostPaths.hookWinPosixPath) + cleanText;
      }
      return null;
    });
    const res = writeAsarSafely(hostPaths.asarPath, patchedBuf);
    if (res.ok) {
      console.log(`  -> 已无冲突增量更新 app.asar (${res.mode}，Windows 与 WSL 模式均自动加载)`);
    } else {
      console.log('  -> 提示: 更新 app.asar 失败（可关闭 Antigravity 后再重试）:', res.error);
    }
  }

  console.log('\n=== [3/3] 向当前运行中的 Antigravity 窗口热注入任务总运行时长组件 ===');
  const scriptContent = fs.readFileSync(
    path.join(PLUGIN_ROOT, 'renderer', 'task-timer.js'),
    'utf8'
  );
  const hotScript = `(() => { window.__AGY_TASK_TIMER_FORCE_RELOAD__ = true; window.__AGY_TASK_TIMER_LOCKED__ = false; window.__AGY_TASK_TIMER_INSTALLED__ = false; ${scriptContent}; return { installed: Boolean(window.__AGY_TASK_TIMER_INSTALLED__), version: window.__AGY_TASK_TIMER_VERSION__ || '' }; })()`;
  const hotResult = await evaluateScriptInRunningWindows(hostPaths?.devToolsPortPath, hotScript);
  if (hotResult.count > 0) {
    const ver = hotResult.values.find((v) => v && v.version)?.version || '';
    console.log(
      `  -> 热注入成功！已实时更新 ${hotResult.count} 个活动窗口 (v${ver})，无需重启即可生效。`
    );
  } else {
    console.log(`  -> 热注入跳过 (${hotResult.reason})，重启 Antigravity 后自动生效。`);
  }
}

async function runUninstall() {
  const hostPaths = resolveWindowsHostPaths();

  console.log('=== [1/2] 从 app.asar 中精确移除 task-timer 启动钩子 ===');
  if (hostPaths && fs.existsSync(hostPaths.asarPath)) {
    const patchedBuf = buildPatchedAsarBuffer(hostPaths.asarPath, (relPath, fileBuf) => {
      if (relPath === 'dist/main.js') {
        const text = fileBuf.toString('utf8');
        if (!text.includes(START_MARKER)) return null;
        return stripMarkedBlock(text);
      }
      return null;
    });
    const res = writeAsarSafely(hostPaths.asarPath, patchedBuf);
    if (res.ok) {
      console.log('  -> 已移除 task-timer 钩子（保留其他插件完整不变）');
    } else {
      console.log('  -> 移除失败（请关闭 Antigravity 后重试）:', res.error);
    }
  }

  console.log('\n=== [2/2] 清理当前运行窗口中的任务总运行时长组件 ===');
  const cleanupRes = await evaluateScriptInRunningWindows(
    hostPaths?.devToolsPortPath,
    'try { window.__AGY_TASK_TIMER_CLEANUP__ && window.__AGY_TASK_TIMER_CLEANUP__(); window.__AGY_TASK_TIMER_LOCKED__ = false; window.__AGY_TASK_TIMER_INSTALLED__ = false; } catch {}'
  );
  console.log(
    cleanupRes.count > 0
      ? `  -> 已清理 ${cleanupRes.count} 个活动窗口的任务计时条。`
      : `  -> 跳过窗口清理 (${cleanupRes.reason})。`
  );
}

async function runStatus() {
  const hostPaths = resolveWindowsHostPaths();
  console.log('=== Antigravity Task Timer 状态检查 ===');
  console.log('1. 工作区插件目录:', fs.existsSync(PLUGIN_ROOT) ? `已就绪 (${PLUGIN_ROOT})` : '缺失');
  if (hostPaths) {
    console.log(
      '2. 全局插件目录:  ',
      fs.existsSync(hostPaths.globalPluginDir) ? `已安装 (${hostPaths.globalPluginDir})` : '未安装'
    );
    console.log(
      '3. ASAR main.js:  ',
      checkAsarPatched(hostPaths.asarPath) ? '已注入启动钩子 (增量共存)' : '未注入'
    );
  }
}

const action = (process.argv[2] || 'install').toLowerCase();
if (action === 'uninstall' || action === 'restore') {
  await runUninstall();
} else if (action === 'status') {
  await runStatus();
} else {
  await runInstall();
}
