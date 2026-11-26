#!/usr/bin/env node
/**
 * Antigravity Context Donut — Windows + WSL 双端无冲突增量安装 / 卸载 / 状态检查工具
 *
 * 支持三种动作（可在 Windows 或 WSL Linux 环境内直接执行）：
 *   node installer/install-donut.mjs install    # 同步 Windows 与 WSL 全局插件目录 + 增量注入 app.asar + 连通性校验 + 热注入当前窗口
 *   node installer/install-donut.mjs uninstall  # 精确移除 app.asar 中的 context-donut 钩子 + 清理 WSL 副本 + 清理当前窗口组件
 *   node installer/install-donut.mjs status     # 检查工作区、Windows 全局、WSL 2 发行版与 ASAR 增量注入状态
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
const START_MARKER = '/* __AGY_CONTEXT_DONUT_START__ */';
const END_MARKER = '/* __AGY_CONTEXT_DONUT_END__ */';
const LEGACY_MARKER = '/* __AGY_CONTEXT_DONUT_HOOK__ */';

/**
 * 定位 Windows 宿主侧用户目录、全局插件目录与 Antigravity app.asar 路径（同时支持从 Windows 或 WSL Linux 执行）
 */
function resolveWindowsHostPaths() {
  if (IS_WIN) {
    const winHome = os.homedir();
    const globalPluginDir = path.join(winHome, '.gemini', 'config', 'plugins', 'context-donut');
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
          const globalPluginDir = path.join(candidateHome, '.gemini', 'config', 'plugins', 'context-donut');
          // Antigravity 主进程始终运行在 Windows Electron 下，require 路径必须为 Windows 盘符路径
          const hookWinPosixPath = `C:/Users/${entry.name}/.gemini/config/plugins/context-donut/bridge/electron-main-hook.cjs`;
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

/**
 * 递归复制目录
 */
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
        const uncHome = `\\\\wsl.localhost\\${name}${linuxHome.replace(/\//g, '\\')}`;
        const uncPluginDir = `${uncHome}\\.gemini\\config\\plugins\\context-donut`;
        const posixPluginDir = `${linuxHome}/.gemini/config/plugins/context-donut`;
        distros.push({
          isDefault: m[1] === '*',
          name,
          state,
          linuxHome,
          uncHome,
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
 * 将插件同步到指定 WSL 2 发行版的 ~/.gemini/config/plugins/context-donut
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
        `find "${distroInfo.posixPluginDir}" -type f \\( -name "*.mjs" -o -name "*.js" -o -name "*.cjs" -o -name "*.json" -o -name "*.md" \\) -exec sed -i 's/\\r$//' {} + 2>/dev/null || true`,
        `chmod +x "${distroInfo.posixPluginDir}/installer/install-donut.mjs" "${distroInfo.posixPluginDir}/scripts/transcript-parser.mjs" "${distroInfo.posixPluginDir}/scripts/hook-tracker.mjs" 2>/dev/null || true`,
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

/**
 * 读取 ASAR 归档结构为内存文件树
 */
function readAsarArchive(asarFilePath) {
  const buf = fs.readFileSync(asarFilePath);
  const headerPayloadSize = buf.readUInt32LE(4);
  const headerStringSize = buf.readUInt32LE(12);
  const headerJson = buf.toString('utf8', 16, 16 + headerStringSize).replace(/\0+$/, '');
  const header = JSON.parse(headerJson);
  const baseOffset = 8 + headerPayloadSize;
  return { buf, header, baseOffset };
}

/**
 * 在内存 ASAR 中增量修改指定文件并重新打包生成新的 ASAR Buffer
 */
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

/**
 * 仅移除本插件（新版块标记及旧版单行标记）的代码段，保留其余插件钩子完整不变
 */
function stripMarkedBlock(text) {
  const escapedStart = START_MARKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const escapedEnd = END_MARKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const escapedLegacy = LEGACY_MARKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const blockRe = new RegExp(`\\n?${escapedStart}[\\s\\S]*?${escapedEnd}\\n?`, 'g');
  const legacyRe = new RegExp(`\\n?${escapedLegacy}\\ntry \\{[^\\n]*\\} catch \\(_e\\) \\{\\}\\n?`, 'g');
  return text.replace(blockRe, '').replace(legacyRe, '');
}

function getMainHookSnippet(hookWinPosixPath) {
  return `${START_MARKER}\ntry { require("${hookWinPosixPath}"); } catch (_e) {}\n${END_MARKER}\n`;
}

function getPreloadHookSnippet() {
  return `\n${START_MARKER}\ntry { const { contextBridge, ipcRenderer } = require("electron"); contextBridge.exposeInMainWorld("__agyContextDonutIPC", { getUsage: (cid) => ipcRenderer.invoke("context-donut:get-usage", cid) }); } catch (_e) {}\n${END_MARKER}\n`;
}

function checkAsarPatched(asarFilePath) {
  if (!asarFilePath || !fs.existsSync(asarFilePath)) return { main: false, preload: false };
  try {
    const { buf, header, baseOffset } = readAsarArchive(asarFilePath);
    const readDistText = (name) => {
      const node = header?.files?.dist?.files?.[name];
      if (!node) return '';
      const off = baseOffset + parseInt(node.offset, 10);
      return buf.toString('utf8', off, off + node.size);
    };
    const mainText = readDistText('main.js');
    const preloadText = readDistText('preload.js');
    return {
      main: mainText.includes(START_MARKER) || mainText.includes(LEGACY_MARKER),
      preload: preloadText.includes(START_MARKER) || preloadText.includes(LEGACY_MARKER),
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
      const tempOld = `${targetPath}.donut-old-${Date.now()}`;
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
  let activePluginDir = PLUGIN_ROOT;

  console.log('=== [1/4] 同步插件到 Windows 与 WSL 全局目录 ===');
  if (IS_LINUX) {
    const linuxGlobalDir = path.join(os.homedir(), '.gemini', 'config', 'plugins', 'context-donut');
    copyDirSync(PLUGIN_ROOT, linuxGlobalDir);
    activePluginDir = linuxGlobalDir;
    console.log('  -> [WSL 当前环境] 已同步至:', linuxGlobalDir);
  }

  if (hostPaths) {
    copyDirSync(PLUGIN_ROOT, hostPaths.globalPluginDir);
    if (IS_WIN) activePluginDir = hostPaths.globalPluginDir;
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
      // 仅写入 Windows 全局插件目录，保持工作区源码干净
      if (hostPaths) {
        try {
          const cacheData = wslDistros.map((d) => ({
            name: d.name,
            linuxHome: d.linuxHome,
            uncHome: d.uncHome,
          }));
          fs.writeFileSync(
            path.join(hostPaths.globalPluginDir, '.wsl-distros.json'),
            JSON.stringify(cacheData, null, 2),
            'utf8'
          );
        } catch {}
      }
    }
  }

  console.log('\n=== [2/4] 增量注入 Antigravity 启动桥接 (Windows + WSL 模式通用) ===');
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
        return cleanText + getPreloadHookSnippet();
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

  console.log('\n=== [3/4] 验证跨端日志解析与会话目录连通性 ===');
  try {
    const parserMod = await import(
      `file://${path.join(activePluginDir, 'scripts', 'transcript-parser.mjs').replace(/\\/g, '/')}`
    );
    const dirs = parserMod.getBrainDirs();
    const latest = parserMod.getLatestTranscriptStats();
    console.log(
      `  -> 已识别 ${dirs.length} 个会话日志目录 (最新会话: ${latest.conversationId ? latest.conversationId.slice(0, 8) + '…' : '暂无'}, Token: ${latest.totalTokens})`
    );
  } catch (err) {
    console.log('  -> 日志解析预检跳过:', err?.message || String(err));
  }

  console.log('\n=== [4/4] 向当前运行中的 Antigravity 窗口热注入 Context Donut 甜甜圈组件 ===');
  const scriptContent = fs.readFileSync(
    path.join(PLUGIN_ROOT, 'renderer', 'composer-donut.js'),
    'utf8'
  );
  const hotScript = `(() => { window.__AGY_CONTEXT_DONUT_FORCE_RELOAD__ = true; window.__AGY_CONTEXT_DONUT_LOCKED__ = false; window.__AGY_CONTEXT_DONUT_INSTALLED__ = false; ${scriptContent}; return { installed: Boolean(window.__AGY_CONTEXT_DONUT_INSTALLED__), version: window.__AGY_CONTEXT_DONUT_VERSION__ || '' }; })()`;
  const hotResult = await evaluateScriptInRunningWindows(hostPaths?.devToolsPortPath, hotScript);
  if (hotResult.count > 0) {
    const ver = hotResult.values.find((v) => v && v.version)?.version || '';
    console.log(
      `  -> 热注入成功！已实时更新 ${hotResult.count} 个活动窗口 (v${ver})，无需重启即可生效。`
    );
  } else {
    console.log(`  -> 热注入跳过 (${hotResult.reason})，切换 WSL 或重启 Antigravity 后自动生效。`);
  }
}

async function runUninstall() {
  const hostPaths = resolveWindowsHostPaths();

  console.log('=== [1/3] 从 app.asar 中精确移除 context-donut 启动与预加载钩子 ===');
  if (hostPaths && fs.existsSync(hostPaths.asarPath)) {
    const patchedBuf = buildPatchedAsarBuffer(hostPaths.asarPath, (relPath, fileBuf) => {
      if (relPath === 'dist/main.js' || relPath === 'dist/preload.js') {
        const text = fileBuf.toString('utf8');
        if (!text.includes(START_MARKER) && !text.includes(LEGACY_MARKER)) return null;
        return stripMarkedBlock(text);
      }
      return null;
    });
    const res = writeAsarSafely(hostPaths.asarPath, patchedBuf);
    if (res.ok) {
      console.log('  -> 已移除 context-donut 钩子（保留其他插件完整不变）');
    } else {
      console.log('  -> 移除失败（请关闭 Antigravity 后重试）:', res.error);
    }
  }

  console.log('\n=== [2/3] 清理 WSL 发行版全局插件目录副本 ===');
  if (IS_WIN) {
    const wslDistros = discoverWslDevDistros();
    for (const d of wslDistros) {
      const ok = removePluginFromWslDistro(d);
      console.log(`  -> [WSL:${d.name}] ${ok ? '已清理' : '清理失败'}: ${d.posixPluginDir}`);
    }
  } else if (IS_LINUX) {
    const linuxGlobalDir = path.join(os.homedir(), '.gemini', 'config', 'plugins', 'context-donut');
    if (fs.existsSync(linuxGlobalDir) && path.resolve(linuxGlobalDir) !== path.resolve(PLUGIN_ROOT)) {
      fs.rmSync(linuxGlobalDir, { recursive: true, force: true });
      console.log('  -> 已清理 WSL 全局副本:', linuxGlobalDir);
    }
  }

  console.log('\n=== [3/3] 清理当前运行窗口中的甜甜圈组件 ===');
  const cleanupRes = await evaluateScriptInRunningWindows(
    hostPaths?.devToolsPortPath,
    'try { window.__AGY_CONTEXT_DONUT_CLEANUP__ && window.__AGY_CONTEXT_DONUT_CLEANUP__(); window.__AGY_CONTEXT_DONUT_LOCKED__ = false; window.__AGY_CONTEXT_DONUT_INSTALLED__ = false; } catch {}'
  );
  console.log(
    cleanupRes.count > 0
      ? `  -> 已清理 ${cleanupRes.count} 个活动窗口的注入组件。`
      : `  -> 跳过窗口清理 (${cleanupRes.reason})。`
  );
}

async function runStatus() {
  const hostPaths = resolveWindowsHostPaths();
  console.log('=== Antigravity Context Donut 双端状态检查 ===');
  console.log('1. 当前插件源码目录:', fs.existsSync(PLUGIN_ROOT) ? `已就绪 (${PLUGIN_ROOT})` : '缺失');
  if (hostPaths) {
    console.log(
      '2. Windows 全局目录:',
      fs.existsSync(hostPaths.globalPluginDir) ? `已安装 (${hostPaths.globalPluginDir})` : '未安装'
    );
    const patched = checkAsarPatched(hostPaths.asarPath);
    console.log('3. ASAR main.js:    ', patched.main ? '已注入启动钩子 (Windows/WSL 双模共存)' : '未注入');
    console.log('4. ASAR preload:    ', patched.preload ? '已注入上下文 IPC 钩子 (Windows/WSL 双模共存)' : '未注入');
  }
  if (IS_WIN) {
    const wslDistros = discoverWslDevDistros();
    if (wslDistros.length === 0) {
      console.log('5. WSL 2 发行版目录: 未检测到 WSL 2 开发发行版');
    } else {
      for (const d of wslDistros) {
        const exists = fs.existsSync(d.uncPluginDir);
        console.log(
          `5. WSL [${d.name}] 插件:`,
          exists ? `已安装 (${d.posixPluginDir})` : `未安装 (${d.posixPluginDir})`
        );
      }
    }
  } else if (IS_LINUX) {
    const linuxGlobalDir = path.join(os.homedir(), '.gemini', 'config', 'plugins', 'context-donut');
    console.log(
      '5. WSL 当前全局目录:',
      fs.existsSync(linuxGlobalDir) ? `已安装 (${linuxGlobalDir})` : '未安装'
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
