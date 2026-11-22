#!/usr/bin/env node
/**
 * Antigravity Quota Pill — Windows + WSL 双端无冲突安装 / 卸载 / 状态检查工具
 *
 * 支持动作（可在 Windows 或 WSL Linux 环境内直接执行）：
 *   node installer/install-quota.mjs install    # 同步 Windows 与 WSL 全局插件目录 + 增量注入 app.asar + 清理旧独立占位进程 + 热注入当前窗口
 *   node installer/install-quota.mjs uninstall  # 移除 app.asar 钩子 + 清理 WSL 副本 + 清理当前窗口 UI + 停止独立桥接服务
 *   node installer/install-quota.mjs status     # 检查工作区、Windows 全局、WSL 发行版、ASAR 挂载与 45790 主进程桥接状态
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PLUGIN_ROOT = path.resolve(__dirname, '..');

const IS_WIN = process.platform === 'win32';
const IS_LINUX = process.platform === 'linux';
const WSL_EXE = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'wsl.exe');
const START_MARKER = '/* __AGY_QUOTA_PILL_START__ */';
const END_MARKER = '/* __AGY_QUOTA_PILL_END__ */';
const BRIDGE_PORT = 45790;

/**
 * 定位 Windows 宿主侧用户目录、全局插件目录与 Antigravity app.asar 路径（同时支持从 Windows 或 WSL Linux 执行）
 */
function resolveWindowsHostPaths() {
  if (IS_WIN) {
    const winHome = os.homedir();
    const globalPluginDir = path.join(winHome, '.gemini', 'config', 'plugins', 'quota-pill');
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
          const globalPluginDir = path.join(candidateHome, '.gemini', 'config', 'plugins', 'quota-pill');
          const hookWinPosixPath = `C:/Users/${entry.name}/.gemini/config/plugins/quota-pill/bridge/electron-main-hook.cjs`;
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

function decodeWslOutput(buf) {
  if (!Buffer.isBuffer(buf)) return String(buf || '');
  return buf.includes(0) ? buf.toString('utf16le').replace(/^\uFEFF/, '') : buf.toString('utf8');
}

function windowsPathToWslMount(winPath) {
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(winPath);
  if (!m) return null;
  return `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, '/')}`;
}

/**
 * 列出 Windows 主机上安装的所有 WSL 2 开发发行版及其 Linux $HOME
 */
function discoverWslDevDistros() {
  if (!IS_WIN || !fs.existsSync(WSL_EXE)) return [];
  try {
    const rawBuf = execFileSync(WSL_EXE, ['--list', '--verbose'], {
      timeout: 8000,
    });
    const text = decodeWslOutput(rawBuf);
    const distros = [];
    for (const line of text.split(/\r?\n/)) {
      const m = /^(\*?)\s*(\S+)\s+(\S+)\s+(\d+)\s*$/.exec(line);
      if (!m) continue;
      const name = m[2];
      const state = m[3];
      const version = parseInt(m[4], 10);
      if (version !== 2 || /^(docker-desktop|rancher-|podman-)/i.test(name)) continue;

      let linuxHome = '';
      try {
        const homeOut = execFileSync(WSL_EXE, ['-d', name, '--exec', 'sh', '-c', 'echo "$HOME"'], {
          encoding: 'utf8',
          timeout: 8000,
        }).trim();
        if (homeOut.startsWith('/')) {
          linuxHome = homeOut;
        }
      } catch {}

      if (linuxHome) {
        const uncPluginDir = `\\\\wsl.localhost\\${name}${linuxHome.replace(/\//g, '\\')}\\.gemini\\config\\plugins\\quota-pill`;
        const posixPluginDir = `${linuxHome}/.gemini/config/plugins/quota-pill`;
        distros.push({
          isDefault: m[1] === '*',
          name,
          state,
          linuxHome,
          uncPluginDir,
          posixPluginDir,
        });
      }
    }
    return distros;
  } catch {
    return [];
  }
}

/**
 * 将插件同步到指定 WSL 2 发行版的 ~/.gemini/config/plugins/quota-pill
 */
function syncPluginToWslDistro(distroInfo) {
  const wslSrc = windowsPathToWslMount(PLUGIN_ROOT);
  if (wslSrc) {
    try {
      const script = [
        'set -e',
        `mkdir -p "${distroInfo.linuxHome}/.gemini/config/plugins"`,
        `rm -rf "${distroInfo.posixPluginDir}"`,
        `cp -r "${wslSrc}" "${distroInfo.posixPluginDir}"`,
        `chmod +x "${distroInfo.posixPluginDir}/installer/install-quota.mjs" "${distroInfo.posixPluginDir}/scripts/quota-fetcher.mjs" 2>/dev/null || true`,
      ].join('; ');
      execFileSync(WSL_EXE, ['-d', distroInfo.name, '--exec', 'sh', '-c', script], {
        encoding: 'utf8',
        timeout: 15000,
      });
      return { ok: true, mode: 'wsl-cp' };
    } catch {}
  }

  try {
    copyDirSync(PLUGIN_ROOT, distroInfo.uncPluginDir);
    return { ok: true, mode: 'unc-copy' };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
}

function removePluginFromWslDistro(distroInfo) {
  try {
    execFileSync(
      WSL_EXE,
      ['-d', distroInfo.name, '--exec', 'sh', '-c', `rm -rf "${distroInfo.posixPluginDir}"`],
      { encoding: 'utf8', timeout: 8000 }
    );
    return true;
  } catch {
    try {
      if (fs.existsSync(distroInfo.uncPluginDir)) {
        fs.rmSync(distroInfo.uncPluginDir, { recursive: true, force: true });
      }
      return true;
    } catch {
      return false;
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

function getPreloadHookSnippet() {
  return `${START_MARKER}\ntry { const { contextBridge, ipcRenderer } = require("electron"); contextBridge.exposeInMainWorld("__agyQuotaPillIPC", { getQuota: (force) => ipcRenderer.invoke("quota-pill:get-status", Boolean(force)) }); } catch (_e) {}\n${END_MARKER}\n`;
}

function checkAsarPatched(asarFilePath) {
  if (!asarFilePath || !fs.existsSync(asarFilePath)) return false;
  try {
    const { buf, header, baseOffset } = readAsarArchive(asarFilePath);
    const mainNode = header?.files?.dist?.files?.['main.js'];
    const preloadNode = header?.files?.dist?.files?.['preload.js'];
    if (!mainNode || !preloadNode) return false;
    const mainOff = baseOffset + parseInt(mainNode.offset, 10);
    const preloadOff = baseOffset + parseInt(preloadNode.offset, 10);
    const mainText = buf.toString('utf8', mainOff, mainOff + mainNode.size);
    const preloadText = buf.toString('utf8', preloadOff, preloadOff + preloadNode.size);
    return mainText.includes(START_MARKER) && preloadText.includes(START_MARKER);
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
      const tempOld = `${targetPath}.quota-old-${Date.now()}`;
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

async function queryBridgeHealth() {
  try {
    const resp = await fetch(`http://127.0.0.1:${BRIDGE_PORT}/health`, {
      signal: AbortSignal.timeout(1200),
    });
    if (!resp.ok) return null;
    return await resp.json();
  } catch {
    return null;
  }
}

function evaluateViaWebSocket(wsUrl, expression) {
  return new Promise((resolve) => {
    if (typeof WebSocket === 'undefined') {
      resolve(false);
      return;
    }
    const timer = setTimeout(() => resolve(false), 3000);
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
            resolve(true);
          }
        } catch {}
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

async function evaluateScriptInRunningWindows(devToolsPortPath, scriptExpression) {
  if (!devToolsPortPath || !fs.existsSync(devToolsPortPath)) {
    return { count: 0, reason: '未检测到 DevToolsActivePort（v2.34+ 默认关闭远程调试端口）' };
  }

  try {
    const lines = fs.readFileSync(devToolsPortPath, 'utf8').trim().split(/\r?\n/);
    const port = Number(lines[0]);
    if (!port || Number.isNaN(port)) {
      return { count: 0, reason: 'DevToolsActivePort 端口无效' };
    }

    const listResp = await fetch(`http://127.0.0.1:${port}/json/list`);
    if (!listResp.ok) {
      return { count: 0, reason: `无法访问调试目标列表 (${listResp.status})` };
    }
    const targets = await listResp.json();
    const pageTargets = targets.filter(
      (t) =>
        t.type === 'page' &&
        t.webSocketDebuggerUrl &&
        (t.url?.includes('127.0.0.1') || t.url?.includes('localhost') || t.title?.includes('Antigravity'))
    );

    if (pageTargets.length === 0) {
      return { count: 0, reason: '未找到主界面渲染目标' };
    }

    let count = 0;
    for (const target of pageTargets) {
      const ok = await evaluateViaWebSocket(target.webSocketDebuggerUrl, scriptExpression);
      if (ok) count++;
    }
    return { count };
  } catch (err) {
    return { count: 0, reason: err?.message || String(err) };
  }
}

async function runInstall() {
  const hostPaths = resolveWindowsHostPaths();

  console.log('=== [1/4] 同步插件到 Windows 与 WSL 全局目录 ===');
  if (IS_LINUX) {
    const linuxGlobalDir = path.join(os.homedir(), '.gemini', 'config', 'plugins', 'quota-pill');
    copyDirSync(PLUGIN_ROOT, linuxGlobalDir);
    console.log('  -> [WSL 当前环境] 已同步至:', linuxGlobalDir);
  }

  if (hostPaths) {
    copyDirSync(PLUGIN_ROOT, hostPaths.globalPluginDir);
    console.log('  -> [Windows 全局] 已同步至:', hostPaths.globalPluginDir);
  } else {
    console.log('  -> 提示: 未检测到 Windows 宿主目录，跳过 Windows 侧文件同步。');
  }

  if (IS_WIN) {
    const wslDistros = discoverWslDevDistros();
    if (wslDistros.length === 0) {
      console.log('  -> [WSL 迁移] 未检测到 WSL 2 开发发行版。');
    } else {
      for (const d of wslDistros) {
        const res = syncPluginToWslDistro(d);
        if (res.ok) {
          console.log(`  -> [WSL:${d.name}] 已迁移至: ${d.posixPluginDir} (${res.mode})`);
        } else {
          console.log(`  -> [WSL:${d.name}] 迁移失败: ${res.error}`);
        }
      }
    }
  }

  console.log('\n=== [2/4] 增量注入 Antigravity 客户端启动桥接 (Windows + WSL 模式通用) ===');
  if (!hostPaths || !fs.existsSync(hostPaths.asarPath)) {
    console.log('  -> 未找到 app.asar，跳过客户端启动注入。');
  } else {
    const patchedBuf = buildPatchedAsarBuffer(hostPaths.asarPath, (relPath, fileBuf) => {
      if (relPath === 'dist/main.js') {
        const cleanText = stripMarkedBlock(fileBuf.toString('utf8'));
        return getMainHookSnippet(hostPaths.hookWinPosixPath) + cleanText;
      }
      if (relPath === 'dist/preload.js') {
        const cleanText = stripMarkedBlock(fileBuf.toString('utf8'));
        return cleanText.trimEnd() + '\n' + getPreloadHookSnippet();
      }
      return null;
    });
    const res = writeAsarSafely(hostPaths.asarPath, patchedBuf);
    if (res.ok) {
      console.log(`  -> 已无冲突增量更新 app.asar (${res.mode}，本地与 WSL 模式均自动加载)`);
    } else {
      console.log('  -> 提示: 更新 app.asar 失败（可关闭 Antigravity 后再重试）:', res.error);
    }
  }

  console.log('\n=== [3/4] 检查本地 45790 端口配额桥接宿主 ===');
  const health = await queryBridgeHealth();
  if (health && health.host === 'electron-main') {
    console.log(
      `  -> Electron 主进程内置桥接在线 (v${health.version || 'unknown'}, PID ${health.pid || '-'}, LS端口 ${health.lsPort || 0}, 令牌 ${health.hasCsrfToken ? '已就绪' : '未就绪'})`
    );
    try {
      const qResp = await fetch(`http://127.0.0.1:${BRIDGE_PORT}/api/quota?refresh=1`, {
        signal: AbortSignal.timeout(3500),
      });
      if (qResp.ok) {
        const qData = await qResp.json();
        console.log(
          `  -> 配额数据校验: ok=${qData.ok}, source=${qData.source}, primaryRemaining=${qData.primaryRemainingPercent}%`
        );
      }
    } catch {}
  } else if (health && health.plugin === 'quota-pill') {
    // 清理旧版脱离主进程的独立 server.mjs，防止它在重启后继续抢占 45790 端口
    try {
      await fetch(`http://127.0.0.1:${BRIDGE_PORT}/api/shutdown`, { signal: AbortSignal.timeout(1200) });
      console.log(
        `  -> 已停止旧版独立 45790 桥接进程 (PID ${health.pid || '-'})，重启 Antigravity 后将由主进程自动接管 45790 并直连内存令牌。`
      );
    } catch {
      console.log('  -> 检测到旧版 45790 桥接，请重启 Antigravity 以加载新版主进程桥接。');
    }
  } else {
    console.log('  -> 45790 端口空闲，重启 Antigravity 后将由主进程内置桥接自动启动并接管。');
  }

  console.log('\n=== [4/4] 向当前运行中的 Antigravity 窗口热注入左下角额度组件 ===');
  const rendererPath = path.join(PLUGIN_ROOT, 'renderer', 'sidebar-quota.js');
  const scriptContent = fs.readFileSync(rendererPath, 'utf8');
  const hotExpr = `window.__AGY_QUOTA_PILL_FORCE_RELOAD__ = true; window.__AGY_QUOTA_PILL_LOCKED__ = false; ${scriptContent}`;
  const hotResult = await evaluateScriptInRunningWindows(hostPaths?.devToolsPortPath, hotExpr);
  if (hotResult.count > 0) {
    console.log(`  -> 热注入成功！已实时挂载到 ${hotResult.count} 个活动窗口左下角。`);
  } else {
    console.log(`  -> 热注入跳过 (${hotResult.reason})，重启 Antigravity 后新版主进程钩子与界面将自动生效。`);
  }
}

async function runUninstall() {
  const hostPaths = resolveWindowsHostPaths();

  console.log('=== [1/4] 从 app.asar 中精确移除 quota-pill 启动钩子 ===');
  if (hostPaths && fs.existsSync(hostPaths.asarPath)) {
    const patchedBuf = buildPatchedAsarBuffer(hostPaths.asarPath, (relPath, fileBuf) => {
      if (relPath === 'dist/main.js' || relPath === 'dist/preload.js') {
        const text = fileBuf.toString('utf8');
        if (!text.includes(START_MARKER)) return null;
        return stripMarkedBlock(text);
      }
      return null;
    });
    const res = writeAsarSafely(hostPaths.asarPath, patchedBuf);
    if (res.ok) {
      console.log('  -> 已移除 quota-pill 钩子（保留其他插件完整不变）');
    } else {
      console.log('  -> 移除失败（请关闭 Antigravity 后重试）:', res.error);
    }
  }

  console.log('\n=== [2/4] 清理 WSL 发行版全局插件目录副本 ===');
  if (IS_WIN) {
    const wslDistros = discoverWslDevDistros();
    for (const d of wslDistros) {
      const ok = removePluginFromWslDistro(d);
      console.log(`  -> [WSL:${d.name}] ${ok ? '已清理' : '清理失败'}: ${d.posixPluginDir}`);
    }
  } else if (IS_LINUX) {
    const linuxGlobalDir = path.join(os.homedir(), '.gemini', 'config', 'plugins', 'quota-pill');
    if (fs.existsSync(linuxGlobalDir) && path.resolve(linuxGlobalDir) !== path.resolve(PLUGIN_ROOT)) {
      fs.rmSync(linuxGlobalDir, { recursive: true, force: true });
      console.log('  -> 已清理 WSL 全局副本:', linuxGlobalDir);
    }
  }

  console.log('\n=== [3/4] 从当前运行窗口卸载左下角 UI ===');
  const cleanupRes = await evaluateScriptInRunningWindows(
    hostPaths?.devToolsPortPath,
    'try { window.__AGY_QUOTA_PILL_CLEANUP__ && window.__AGY_QUOTA_PILL_CLEANUP__(); window.__AGY_QUOTA_PILL_LOCKED__ = false; } catch {}'
  );
  console.log(
    cleanupRes.count > 0
      ? `  -> 已清理 ${cleanupRes.count} 个活动窗口的左下角组件。`
      : `  -> 跳过窗口清理 (${cleanupRes.reason})。`
  );

  console.log('\n=== [4/4] 停止独立 45790 桥接服务 ===');
  try {
    await fetch(`http://127.0.0.1:${BRIDGE_PORT}/api/shutdown`, { signal: AbortSignal.timeout(1000) });
    console.log('  -> 已通知本地独立 45790 桥接进程退出。');
  } catch {
    console.log('  -> 未检测到独立运行的 45790 服务。');
  }
}

async function runStatus() {
  const hostPaths = resolveWindowsHostPaths();
  console.log('=== Antigravity Quota Pill 双端状态检查 ===');
  console.log('1. 当前插件源码目录:', fs.existsSync(PLUGIN_ROOT) ? `已就绪 (${PLUGIN_ROOT})` : '缺失');
  if (hostPaths) {
    console.log(
      '2. Windows 全局目录:',
      fs.existsSync(hostPaths.globalPluginDir) ? `已安装 (${hostPaths.globalPluginDir})` : '未安装'
    );
    console.log(
      '3. 客户端 ASAR 钩子:',
      checkAsarPatched(hostPaths.asarPath) ? '已注入启动钩子 (Windows/WSL 双模共存)' : '未注入'
    );
  }
  if (IS_WIN) {
    const wslDistros = discoverWslDevDistros();
    if (wslDistros.length === 0) {
      console.log('4. WSL 2 发行版目录: 未检测到 WSL 2 开发发行版');
    } else {
      for (const d of wslDistros) {
        const exists = fs.existsSync(d.uncPluginDir);
        console.log(
          `4. WSL [${d.name}] 插件:`,
          exists ? `已安装 (${d.posixPluginDir})` : `未安装 (${d.posixPluginDir})`
        );
      }
    }
  } else if (IS_LINUX) {
    const linuxGlobalDir = path.join(os.homedir(), '.gemini', 'config', 'plugins', 'quota-pill');
    console.log(
      '4. WSL 当前全局目录:',
      fs.existsSync(linuxGlobalDir) ? `已安装 (${linuxGlobalDir})` : '未安装'
    );
  }
  const health = await queryBridgeHealth();
  if (!health) {
    console.log('5. 45790 配额桥接:   未启动（重启 Antigravity 后将由主进程自动启动）');
  } else if (health.host === 'electron-main') {
    console.log(
      `5. 45790 配额桥接:   在线 (Electron 主进程内置 v${health.version || 'unknown'}, LS端口=${health.lsPort || 0}, 令牌=${health.hasCsrfToken ? '有效' : '空'})`
    );
  } else {
    console.log(`5. 45790 配额桥接:   旧版独立进程占用 (PID ${health.pid || '-'})，建议重新执行 install 并重启 Antigravity`);
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
