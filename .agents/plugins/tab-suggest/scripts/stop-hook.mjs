#!/usr/bin/env node
/**
 * Antigravity Tab Suggest — 非阻塞 Stop 生命周期 Hook
 *
 * 设计要点：
 * Antigravity 的 Stop Hook 为同步执行，若在 Hook 内直接等待外部大模型返回，会阻塞主界面结束状态。
 * 因此本脚本仅过滤掉手动取消/异常状态，在 <350ms 内将 `{ conversationId, transcriptPath }` 异步投递给
 * 本地常驻服务 `127.0.0.1:45794/api/trigger`（若服务未启动则后台 detached 拉起），随后立即输出 `{}` 退出。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const HOST = '127.0.0.1';
const PORT = Number(process.env.AGY_TAB_SUGGEST_PORT || 45794);

function postTriggerQuick(payloadObj, timeoutMs = 420) {
  return new Promise((resolve) => {
    const body = Buffer.from(JSON.stringify(payloadObj), 'utf8');
    const req = http.request(
      {
        host: HOST,
        port: PORT,
        path: '/api/trigger',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': String(body.length),
        },
        timeout: timeoutMs,
      },
      (res) => {
        res.resume();
        resolve(res.statusCode >= 200 && res.statusCode < 300);
      }
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      try {
        req.destroy();
      } catch {}
      resolve(false);
    });
    req.write(body);
    req.end();
  });
}

function spawnDetachedServiceAndTrigger(payloadObj) {
  try {
    const serviceScript = path.join(__dirname, 'suggest-service.mjs');
    if (!fs.existsSync(serviceScript)) return;
    const child = spawn(process.execPath, [serviceScript, 'serve'], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: { ...process.env },
    });
    child.unref();

    // 留一个极轻量 detached 延时补投递，不阻塞当前 Hook 进程退出
    const delayedCode = `
      const http = require('http');
      setTimeout(() => {
        const b = Buffer.from(${JSON.stringify(JSON.stringify(payloadObj))}, 'utf8');
        const r = http.request({ host: '${HOST}', port: ${PORT}, path: '/api/trigger', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': b.length }, timeout: 1500 }, (res) => res.resume());
        r.on('error', () => {});
        r.write(b);
        r.end();
      }, 450);
    `;
    const triggerChild = spawn(process.execPath, ['-e', delayedCode], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    triggerChild.unref();
  } catch {}
}

async function main() {
  let raw = '';
  try {
    raw = fs.readFileSync(0, 'utf8');
  } catch {}

  let payload = {};
  try {
    if (raw.trim()) {
      payload = JSON.parse(raw);
    }
  } catch {}

  const reason = String(payload.terminationReason || '');
  const cid = String(payload.conversationId || '').trim();

  // 用户主动停止或发生执行错误时不弹推进建议，避免干扰
  if (cid && reason !== 'USER_CANCELED' && reason !== 'ERROR' && payload.fullyIdle !== false) {
    const triggerBody = {
      conversationId: cid,
      transcriptPath: String(payload.transcriptPath || ''),
    };
    const posted = await postTriggerQuick(triggerBody, 380);
    if (!posted) {
      spawnDetachedServiceAndTrigger(triggerBody);
    }
  }

  process.stdout.write('{}\n');
}

await main();
