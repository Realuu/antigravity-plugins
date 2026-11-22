#!/usr/bin/env node
/**
 * Antigravity Tab Suggest — 右上角「插件 -> Tab 智能补全」Sidecar 服务入口
 *
 * 1. 监听 Antigravity 分配的 Sidecar 端口以渲染右侧配置面板 `/ui.html`；
 * 2. 若本地固定端口 `127.0.0.1:45794` 尚未启动，自动在同一进程内拉起补全 API 服务作为双保险保活。
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { PORT as API_PORT, startSuggestServer } from '../../scripts/suggest-service.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const UI_HTML_PATH = path.join(__dirname, 'ui.html');

const SIDECAR_PORT = Number(
  process.env.ANTIGRAVITY_SIDECAR_WEB_PORT ||
    process.env.PORT ||
    process.env.ANTIGRAVITY_SIDECAR_PORT ||
    0
);

const sidecarServer = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const u = new URL(req.url || '/', 'http://127.0.0.1');

  if (u.pathname === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
    return;
  }

  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(fs.readFileSync(UI_HTML_PATH, 'utf8'));
});

sidecarServer.listen(SIDECAR_PORT, '127.0.0.1', () => {
  const addr = sidecarServer.address();
  const actualPort = typeof addr === 'object' && addr ? addr.port : SIDECAR_PORT;
  console.log(`[Tab Suggest Sidecar] listening on http://127.0.0.1:${actualPort}`);
});

// 确保 127.0.0.1:45794 本地补全 API 始终在线（若已被主进程拉起则静默跳过 EADDRINUSE）
const probeReq = http.get(
  { host: '127.0.0.1', port: API_PORT, path: '/api/health', timeout: 600 },
  (r) => r.resume()
);
probeReq.on('error', () => {
  try {
    startSuggestServer();
  } catch {}
});
