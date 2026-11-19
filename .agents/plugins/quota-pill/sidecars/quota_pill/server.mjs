import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// 防止 quota-fetcher 在自身作为 45790 桥接服务运行时递归请求自身
process.env.AGY_QUOTA_DISABLE_BRIDGE_FALLBACK = '1';

const { getQuotaStatus } = await import('../../scripts/quota-fetcher.mjs');

const SIDECAR_PORT = Number(process.env.PORT || process.env.ANTIGRAVITY_SIDECAR_PORT || 0);
const FIXED_MIRROR_PORT = 45790;

function isPluginEnabled() {
  try {
    const cfgPath = path.join(os.homedir(), '.gemini', 'config', 'config.json');
    if (!fs.existsSync(cfgPath)) return true;
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    if (cfg?.plugins?.['quota-pill']?.enabled === false) {
      return false;
    }
    return true;
  } catch {
    return true;
  }
}

async function handleRequest(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const reqUrl = new URL(req.url || '/', 'http://127.0.0.1');

  if (reqUrl.pathname === '/api/quota') {
    const refresh = reqUrl.searchParams.get('refresh') === '1';
    const data = await getQuotaStatus(refresh);
    data.pluginEnabled = isPluginEnabled();
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(JSON.stringify(data));
    return;
  }

  if (reqUrl.pathname === '/api/shutdown') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true }));
    setTimeout(() => process.exit(0), 60);
    return;
  }

  if (reqUrl.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ status: 'ok', plugin: 'quota-pill', pid: process.pid }));
    return;
  }

  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Antigravity Quota Pill Local Bridge is running on /api/quota');
}

if (SIDECAR_PORT > 0 && SIDECAR_PORT !== FIXED_MIRROR_PORT) {
  const sidecarServer = http.createServer((req, res) => {
    void handleRequest(req, res);
  });
  sidecarServer.listen(SIDECAR_PORT, '127.0.0.1');
}

const mirrorServer = http.createServer((req, res) => {
  void handleRequest(req, res);
});
mirrorServer.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    if (!SIDECAR_PORT) {
      process.exit(0);
    }
  }
});
mirrorServer.listen(FIXED_MIRROR_PORT, '127.0.0.1', () => {
  console.log(`[quota-pill] local quota bridge listening on http://127.0.0.1:${FIXED_MIRROR_PORT}`);
});
