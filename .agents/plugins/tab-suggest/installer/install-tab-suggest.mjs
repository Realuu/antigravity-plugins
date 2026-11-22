#!/usr/bin/env node
/**
 * Antigravity Tab Suggest — Windows + WSL 双端无冲突安装 / 卸载 / 状态检查工具
 *
 * 支持动作：
 *   node installer/install-tab-suggest.mjs install    # 同步 Windows/WSL 全局目录 + 增量注入 app.asar + 启动本地服务 + 热注入当前窗口
 *   node installer/install-tab-suggest.mjs uninstall  # 移除 app.asar 钩子 + 停止后台服务 + 清理 WSL 副本与当前窗口组件
 *   node installer/install-tab-suggest.mjs status     # 检查插件目录、服务、凭证与 ASAR 注入状态
 */
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PLUGIN_ROOT = path.resolve(__dirname, '..');

const IS_WIN = process.platform === 'win32';
const IS_LINUX = process.platform === 'linux';
const WSL_EXE = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'wsl.exe');

const SERVICE_PORT = 45794;
const START_MARKER = '/* __AGY_TAB_SUGGEST_START__ */';
const END_MARKER = '/* __AGY_TAB_SUGGEST_END__ */';

function resolveWindowsHostPaths() {
  if (IS_WIN) {
    const winHome = os.homedir();
    const globalPluginDir = path.join(winHome, '.gemini', 'config', 'plugins', 'tab-suggest');
    const hookWinPosixPath = path
      .join(globalPluginDir, 'bridge', 'electron-main-hook.cjs')
      .replace(/\\/g, '/');
    return {
      winHome,
      globalPluginDir,
      hookWinPosixPath,
      asarPath: path.join(winHome, 'AppData', 'Local', 'Programs', 'antigravity', 'resources', 'app.asar'),
      devToolsPortPath: path.join(winHome, 'AppData', 'Roaming', 'Antigravity', 'DevToolsActivePort'),
      pidFilePath: path.join(winHome, '.gemini', 'antigravity', 'sidecar_data', 'tab-suggest', 'service.json'),
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
          const globalPluginDir = path.join(candidateHome, '.gemini', 'config', 'plugins', 'tab-suggest');
          return {
            winHome: candidateHome,
            globalPluginDir,
            hookWinPosixPath: `C:/Users/${entry.name}/.gemini/config/plugins/tab-suggest/bridge/electron-main-hook.cjs`,
            asarPath: candidateAsar,
            devToolsPortPath: path.join(candidateHome, 'AppData', 'Roaming', 'Antigravity', 'DevToolsActivePort'),
            pidFilePath: path.join(candidateHome, '.gemini', 'antigravity', 'sidecar_data', 'tab-suggest', 'service.json'),
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

function discoverWslDevDistros() {
  if (!IS_WIN || !fs.existsSync(WSL_EXE)) return [];
  try {
    const rawBuf = execFileSync(WSL_EXE, ['--list', '--verbose'], { timeout: 8000 });
    const text = decodeWslOutput(rawBuf);
    const distros = [];
    for (const line of text.split(/\r?\n/)) {
      const m = /^(\*?)\s*(\S+)\s+(\S+)\s+(\d+)\s*$/.exec(line);
      if (!m) continue;
      const name = m[2];
      const version = parseInt(m[4], 10);
      if (version !== 2 || /^(docker-desktop|rancher-|podman-)/i.test(name)) continue;

      let linuxHome = '';
      try {
        const homeOut = execFileSync(WSL_EXE, ['-d', name, '--exec', 'sh', '-c', 'echo "$HOME"'], {
          encoding: 'utf8',
          timeout: 8000,
        }).trim();
        if (homeOut.startsWith('/')) linuxHome = homeOut;
      } catch {}

      if (linuxHome) {
        const uncHome = `\\\\wsl.localhost\\${name}${linuxHome.replace(/\//g, '\\')}`;
        distros.push({
          name,
          linuxHome,
          uncPluginDir: `${uncHome}\\.gemini\\config\\plugins\\tab-suggest`,
          posixPluginDir: `${linuxHome}/.gemini/config/plugins/tab-suggest`,
        });
      }
    }
    return distros;
  } catch {
    return [];
  }
}

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
        `chmod +x "${distroInfo.posixPluginDir}/installer/install-tab-suggest.mjs" "${distroInfo.posixPluginDir}/scripts/suggest-service.mjs" "${distroInfo.posixPluginDir}/scripts/stop-hook.mjs" "${distroInfo.posixPluginDir}/sidecars/tab_suggest/server.mjs" 2>/dev/null || true`,
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
  const blockRe = new RegExp(`\\n?${escapedStart}[\\s\\S]*?${escapedEnd}\\n?`, 'g');
  return text.replace(blockRe, '');
}

function getMainHookSnippet(hookWinPosixPath) {
  return `${START_MARKER}\ntry { require("${hookWinPosixPath}"); } catch (_e) {}\n${END_MARKER}\n`;
}

function getPreloadHookSnippet() {
  return `\n${START_MARKER}\ntry { const { contextBridge, ipcRenderer } = require("electron"); contextBridge.exposeInMainWorld("__agyTabSuggestIPC", { insertText: (text) => ipcRenderer.invoke("tab-suggest:insert-text", text) }); } catch (_e) {}\n${END_MARKER}\n`;
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
      const tempOld = `${targetPath}.tabsuggest-old-${Date.now()}`;
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

function probeLocalService() {
  return new Promise((resolve) => {
    const req = http.get(
      { host: '127.0.0.1', port: SERVICE_PORT, path: '/api/status', timeout: 1000 },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          } catch {
            resolve(null);
          }
        });
      }
    );
    req.on('error', () => resolve(null));
    req.on('timeout', () => {
      try {
        req.destroy();
      } catch {}
      resolve(null);
    });
  });
}

async function stopExistingService(pidFilePath) {
  try {
    if (pidFilePath && fs.existsSync(pidFilePath)) {
      const info = JSON.parse(fs.readFileSync(pidFilePath, 'utf8'));
      if (info && info.pid) {
        try {
          process.kill(Number(info.pid));
        } catch {}
      }
    }
  } catch {}
}

async function ensureLocalServiceStarted(serviceScriptPath, pidFilePath, restart = false) {
  if (restart) {
    await stopExistingService(pidFilePath);
    await new Promise((r) => setTimeout(r, 250));
  } else {
    const alive = await probeLocalService();
    if (alive && alive.ok) return alive;
  }

  if (serviceScriptPath && fs.existsSync(serviceScriptPath)) {
    try {
      const child = spawn(process.execPath, [serviceScriptPath, 'serve'], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        env: { ...process.env },
      });
      child.unref();
    } catch {}
  }

  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 200));
    const st = await probeLocalService();
    if (st && st.ok) return st;
  }
  return null;
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
            params: { expression, returnByValue: true },
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

  console.log('=== [1/4] 同步 Tab Suggest 插件到 Windows 与 WSL 全局目录 ===');
  if (IS_LINUX) {
    const linuxGlobalDir = path.join(os.homedir(), '.gemini', 'config', 'plugins', 'tab-suggest');
    copyDirSync(PLUGIN_ROOT, linuxGlobalDir);
    activePluginDir = linuxGlobalDir;
    console.log('  -> [WSL 当前环境] 已同步至:', linuxGlobalDir);
  }

  if (hostPaths) {
    copyDirSync(PLUGIN_ROOT, hostPaths.globalPluginDir);
    if (IS_WIN) activePluginDir = hostPaths.globalPluginDir;
    console.log('  -> [Windows 全局] 已同步至:', hostPaths.globalPluginDir);
  }

  if (IS_WIN) {
    const wslDistros = discoverWslDevDistros();
    for (const d of wslDistros) {
      const res = syncPluginToWslDistro(d);
      console.log(
        res.ok
          ? `  -> [WSL:${d.name}] 已迁移至: ${d.posixPluginDir} (${res.mode})`
          : `  -> [WSL:${d.name}] 迁移失败: ${res.error}`
      );
    }
  }

  console.log('\n=== [2/4] 增量注入 Antigravity 启动与输入桥接 ===');
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
    console.log(
      res.ok
        ? `  -> 已无冲突增量更新 app.asar (${res.mode})`
        : `  -> 提示: 更新 app.asar 失败: ${res.error}`
    );
  }

  console.log('\n=== [3/4] 启动/刷新本地智能补全服务 (127.0.0.1:45794) ===');
  const serviceScript = path.join(activePluginDir, 'scripts', 'suggest-service.mjs');
  const st = await ensureLocalServiceStarted(serviceScript, hostPaths?.pidFilePath, true);
  if (st && st.ok) {
    const channelLabel = st.provider === 'openai-compatible' ? 'OpenAI 兼容' : 'Vertex AI';
    const activeModel = st.activeModel || st.model;
    const credDesc = st.hasCredentials
      ? st.provider === 'openai-compatible'
        ? `已就绪 [${st.openaiKeyMasked || '本地免密钥'}]`
        : `已绑定 ${st.projectId}`
      : '待配置密钥/凭证';
    console.log(
      `  -> 本地服务已就绪 (端口 45794, 通道: ${channelLabel}, 模型: ${activeModel}, 凭证状态: ${credDesc})`
    );
  } else {
    console.log('  -> 提示: 本地服务将在 Antigravity 窗口活动中自动拉起。');
  }

  console.log('\n=== [4/4] 向当前运行中的 Antigravity 窗口免重启热注入 ===');
  const scriptContent = fs.readFileSync(path.join(PLUGIN_ROOT, 'renderer', 'composer-ghost.js'), 'utf8');
  const hotScript = `(() => { window.__AGY_TAB_SUGGEST_FORCE_RELOAD__ = true; window.__AGY_TAB_SUGGEST_LOCKED__ = false; window.__AGY_TAB_SUGGEST_INSTALLED__ = false; ${scriptContent}; return { installed: Boolean(window.__AGY_TAB_SUGGEST_INSTALLED__), version: window.__AGY_TAB_SUGGEST_VERSION__ || '' }; })()`;
  const hotResult = await evaluateScriptInRunningWindows(hostPaths?.devToolsPortPath, hotScript);
  if (hotResult.count > 0) {
    const ver = hotResult.values.find((v) => v && v.version)?.version || '1.0.0';
    console.log(`  -> 热注入成功！已实时更新 ${hotResult.count} 个活动窗口 (v${ver})，无需重启立即可用。`);
  } else {
    console.log(`  -> 热注入跳过 (${hotResult.reason})，重启 Antigravity 后自动生效。`);
  }
}

async function runUninstall() {
  const hostPaths = resolveWindowsHostPaths();

  console.log('=== [1/4] 从 app.asar 移除 tab-suggest 钩子 ===');
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
    console.log(res.ok ? '  -> 已精确移除 tab-suggest 钩子' : `  -> 移除失败: ${res.error}`);
  }

  console.log('\n=== [2/4] 停止本地后台补全服务 ===');
  await stopExistingService(hostPaths?.pidFilePath);
  console.log('  -> 已发送停止信号');

  console.log('\n=== [3/4] 清理全局插件目录副本 ===');
  if (hostPaths && fs.existsSync(hostPaths.globalPluginDir) && path.resolve(hostPaths.globalPluginDir) !== path.resolve(PLUGIN_ROOT)) {
    try {
      fs.rmSync(hostPaths.globalPluginDir, { recursive: true, force: true });
      console.log('  -> 已清理 Windows 全局副本');
    } catch {}
  }
  if (IS_WIN) {
    for (const d of discoverWslDevDistros()) {
      try {
        execFileSync(WSL_EXE, ['-d', d.name, '--exec', 'sh', '-c', `rm -rf "${d.posixPluginDir}"`], { timeout: 8000 });
        console.log(`  -> [WSL:${d.name}] 已清理: ${d.posixPluginDir}`);
      } catch {}
    }
  }

  console.log('\n=== [4/4] 清理当前窗口内的幽灵补全组件 ===');
  const cleanupRes = await evaluateScriptInRunningWindows(
    hostPaths?.devToolsPortPath,
    'try { window.__AGY_TAB_SUGGEST_CLEANUP__ && window.__AGY_TAB_SUGGEST_CLEANUP__(); window.__AGY_TAB_SUGGEST_LOCKED__ = false; window.__AGY_TAB_SUGGEST_INSTALLED__ = false; } catch {}'
  );
  console.log(cleanupRes.count > 0 ? `  -> 已清理 ${cleanupRes.count} 个活动窗口。` : `  -> 跳过窗口清理 (${cleanupRes.reason})。`);
}

async function runStatus() {
  const hostPaths = resolveWindowsHostPaths();
  const st = await probeLocalService();
  console.log('=== Antigravity Tab Suggest 状态检查 ===');
  console.log('1. 插件源码目录:', fs.existsSync(PLUGIN_ROOT) ? `已就绪 (${PLUGIN_ROOT})` : '缺失');
  if (hostPaths) {
    console.log('2. Windows 全局:', fs.existsSync(hostPaths.globalPluginDir) ? `已安装 (${hostPaths.globalPluginDir})` : '未安装');
    const patched = checkAsarPatched(hostPaths.asarPath);
    console.log('3. ASAR 注入:   ', `main=${patched.main ? '是' : '否'}, preload=${patched.preload ? '是' : '否'}`);
  }
  console.log(
    '4. 本地补全服务:',
    st && st.ok
      ? `运行中 (127.0.0.1:${SERVICE_PORT}, 通道=${st.provider === 'openai-compatible' ? 'OpenAI兼容' : 'VertexAI'}, 模型=${st.activeModel || st.model}, 凭证=${st.hasCredentials ? '已就绪' : '待配置'})`
      : '未运行'
  );
}

const action = (process.argv[2] || 'install').toLowerCase();
if (action === 'uninstall' || action === 'restore') {
  await runUninstall();
} else if (action === 'status') {
  await runStatus();
} else {
  await runInstall();
}
