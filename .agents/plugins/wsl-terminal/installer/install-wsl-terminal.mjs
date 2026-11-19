#!/usr/bin/env node
/**
 * Antigravity WSL Terminal — 标准 Sidecar 插件安装 / 卸载 / 状态检查工具
 *
 * 特点：
 * - 纯标准 Sidecar 扩展（零 app.asar 侵入，客户端自动更新也不会失效）
 * - 支持动作：
 *   node installer/install-wsl-terminal.mjs install    # 同步插件至 ~/.gemini/config/plugins/wsl-terminal
 *   node installer/install-wsl-terminal.mjs uninstall  # 从全局插件目录移除 wsl-terminal
 *   node installer/install-wsl-terminal.mjs status     # 检查安装状态与 WSL python3 环境
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PLUGIN_ROOT = path.resolve(__dirname, '..');
const PROJECT_ROOT = path.resolve(PLUGIN_ROOT, '..', '..', '..');
const GLOBAL_PLUGIN_DIR = path.join(os.homedir(), '.gemini', 'config', 'plugins', 'wsl-terminal');

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

function doInstall() {
  console.log('[1/2] 正在同步 WSL 终端插件到全局配置目录...');
  // 直接覆盖同步文件，避免 LanguageServer 已启动 Sidecar 锁住目录句柄导致 rmSync EPERM
  copyDirSync(PLUGIN_ROOT, GLOBAL_PLUGIN_DIR);

  // 写入默认工作区提示兜底文件
  const hintFile = path.join(GLOBAL_PLUGIN_DIR, 'sidecars', 'wsl_terminal', 'workspace_hint.json');
  fs.writeFileSync(
    hintFile,
    JSON.stringify({ windowsPath: PROJECT_ROOT, updatedAt: new Date().toISOString() }, null, 2),
    'utf8'
  );

  console.log(`      已安装至: ${GLOBAL_PLUGIN_DIR}`);
  console.log('[2/2] 校验本地 xterm 静态依赖...');
  const vendorJs = path.join(GLOBAL_PLUGIN_DIR, 'sidecars', 'wsl_terminal', 'vendor', 'xterm.js');
  const vendorCss = path.join(GLOBAL_PLUGIN_DIR, 'sidecars', 'wsl_terminal', 'vendor', 'xterm.css');
  if (!fs.existsSync(vendorJs) || !fs.existsSync(vendorCss)) {
    console.error('  [!] 缺少 vendor/xterm.js 或 xterm.css，请检查构建产物！');
    process.exit(1);
  }
  console.log('      静态终端组件校验通过 (零外网依赖 / 零 app.asar 修改)。');
  console.log('\n安装完成！你现在可以在对话右上角「⋮ → 扩展 → WSL 终端」直接点击打开。');
}

function doUninstall() {
  if (fs.existsSync(GLOBAL_PLUGIN_DIR)) {
    fs.rmSync(GLOBAL_PLUGIN_DIR, { recursive: true, force: true });
    console.log(`已移除全局插件目录: ${GLOBAL_PLUGIN_DIR}`);
  } else {
    console.log('全局目录中未检测到 wsl-terminal 插件，无需卸载。');
  }
}

function doStatus() {
  const installed = fs.existsSync(path.join(GLOBAL_PLUGIN_DIR, 'plugin.json'));
  const vendorReady = fs.existsSync(
    path.join(PLUGIN_ROOT, 'sidecars', 'wsl_terminal', 'vendor', 'xterm.js')
  );
  console.log('=== WSL Terminal Plugin Status ===');
  console.log(`源码目录 : ${PLUGIN_ROOT}`);
  console.log(`全局目录 : ${GLOBAL_PLUGIN_DIR} (${installed ? '已安装' : '未安装'})`);
  console.log(`本地依赖 : xterm.js (${vendorReady ? '就绪' : '缺失'})`);
}

const action = (process.argv[2] || 'status').toLowerCase();
if (action === 'install') {
  doInstall();
} else if (action === 'uninstall') {
  doUninstall();
} else {
  doStatus();
}
