#!/usr/bin/env node
/**
 * Antigravity Tab Suggest — 会话上下文解析与常驻本地服务 (127.0.0.1:45794)
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import {
  clearSavedCredentials,
  generateNextSuggestionFromMessages,
  getPublicStatus,
  PID_FILE,
  saveConfig,
  saveCredentialsJson,
  SERVICE_VERSION,
} from './vertex-client.mjs';

export const HOST = '127.0.0.1';
export const PORT = Number(process.env.AGY_TAB_SUGGEST_PORT || 45794);

const IS_WIN = process.platform === 'win32';
const IS_LINUX = process.platform === 'linux';
const MAX_BODY_BYTES = 2 * 1024 * 1024;

function getBrainDirs() {
  const home = os.homedir();
  const candidates = [
    path.join(home, '.gemini', 'antigravity', 'brain'),
    path.join(home, '.gemini', 'antigravity-ide', 'brain'),
    path.join(home, '.gemini', 'antigravity-cli', 'brain'),
  ];

  if (IS_WIN) {
    try {
      const wslStatePath = path.join(home, 'AppData', 'Roaming', 'Antigravity', 'wsl_state.json');
      if (fs.existsSync(wslStatePath)) {
        const parsed = JSON.parse(fs.readFileSync(wslStatePath, 'utf8'));
        const distro = String(parsed?.distro || '').trim();
        if (distro) {
          for (const root of [`\\\\wsl.localhost\\${distro}`, `\\\\wsl$\\${distro}`]) {
            const homeBase = path.join(root, 'home');
            if (fs.existsSync(homeBase)) {
              for (const u of fs.readdirSync(homeBase, { withFileTypes: true })) {
                if (u.isDirectory()) {
                  candidates.unshift(
                    path.join(homeBase, u.name, '.gemini', 'antigravity', 'brain'),
                    path.join(homeBase, u.name, '.gemini', 'antigravity-ide', 'brain')
                  );
                }
              }
              break;
            }
          }
        }
      }
    } catch {}
  } else if (IS_LINUX && fs.existsSync('/mnt/c/Users')) {
    try {
      for (const entry of fs.readdirSync('/mnt/c/Users', { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        if (['Public', 'Default', 'Default User', 'All Users'].includes(entry.name)) continue;
        candidates.push(path.join('/mnt/c/Users', entry.name, '.gemini', 'antigravity', 'brain'));
      }
    } catch {}
  }

  const seen = new Set();
  const result = [];
  for (const dir of candidates) {
    const key = dir.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) {
        result.push(dir);
      }
    } catch {}
  }
  return result;
}

export function resolveTranscriptFile(conversationId, explicitTranscriptPath = '') {
  if (explicitTranscriptPath && typeof explicitTranscriptPath === 'string') {
    const trimmed = explicitTranscriptPath.trim();
    if (trimmed && fs.existsSync(trimmed)) {
      return {
        conversationId:
          conversationId || path.basename(path.dirname(path.dirname(path.dirname(trimmed)))),
        transcriptPath: trimmed,
      };
    }
    if (IS_WIN && trimmed.startsWith('/')) {
      try {
        const wslStatePath = path.join(os.homedir(), 'AppData', 'Roaming', 'Antigravity', 'wsl_state.json');
        if (fs.existsSync(wslStatePath)) {
          const distro = String(JSON.parse(fs.readFileSync(wslStatePath, 'utf8'))?.distro || '').trim();
          if (distro) {
            const uncPath = `\\\\wsl.localhost\\${distro}${trimmed.replace(/\//g, '\\')}`;
            if (fs.existsSync(uncPath)) {
              return { conversationId, transcriptPath: uncPath };
            }
          }
        }
      } catch {}
    }
  }

  const cid = String(conversationId || '').trim();
  if (!cid) return null;

  for (const dir of getBrainDirs()) {
    const p = path.join(dir, cid, '.system_generated', 'logs', 'transcript.jsonl');
    if (fs.existsSync(p)) {
      return { conversationId: cid, transcriptPath: p };
    }
  }
  return null;
}

function cleanUserPromptText(rawContent) {
  const s = String(rawContent || '');
  const m = s.match(/<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/i);
  const extracted = m
    ? m[1]
    : s
        .replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/gi, '')
        .replace(/<USER_SETTINGS_CHANGE>[\s\S]*?<\/USER_SETTINGS_CHANGE>/gi, '');
  return extracted.trim();
}

function clipHeadTail(text, maxHead = 320, maxTail = 960) {
  const clean = String(text || '').trim();
  if (clean.length <= maxHead + maxTail + 40) return clean;
  return `${clean.slice(0, maxHead)}\n...(中间已省略)...\n${clean.slice(-maxTail)}`;
}

export function extractTranscriptTurnContext(transcriptPath, conversationId = '') {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return null;
  const raw = fs.readFileSync(transcriptPath, 'utf8');
  const lines = raw.split(/\r?\n/);

  const turns = [];
  let currentTurn = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    let step;
    try {
      step = JSON.parse(line);
    } catch {
      continue;
    }

    const stepIdx = typeof step.step_index === 'number' ? step.step_index : i;

    if (step.type === 'USER_INPUT') {
      const userText = cleanUserPromptText(step.content);
      if (!userText) continue;
      currentTurn = {
        userText,
        userStepIdx: stepIdx,
        replies: [],
        tools: new Set(),
        lastStepHasAskQuestion: false,
        lastAgentStepIdx: stepIdx,
      };
      turns.push(currentTurn);
    } else if (currentTurn && step.type === 'PLANNER_RESPONSE') {
      currentTurn.lastAgentStepIdx = stepIdx;
      let stepAsked = false;
      if (Array.isArray(step.tool_calls)) {
        for (const tc of step.tool_calls) {
          const tName = String(tc?.name || tc?.tool_name || '').trim();
          if (tName) {
            currentTurn.tools.add(tName);
            if (tName === 'ask_question') {
              stepAsked = true;
            }
          }
        }
      }
      currentTurn.lastStepHasAskQuestion = stepAsked;
      const replyContent = String(step.content || '').trim();
      if (replyContent) {
        currentTurn.replies.push({ stepIdx, text: replyContent });
      }
    }
  }

  if (turns.length === 0) return null;
  const lastTurn = turns[turns.length - 1];
  if (lastTurn.replies.length === 0 && !lastTurn.lastStepHasAskQuestion) {
    return null;
  }

  // 当最后一步正在展示原生多选问题卡片 ask_question 时，礼貌避让原生选项卡片
  if (lastTurn.lastStepHasAskQuestion) {
    return {
      skipReason: 'ask_question_active',
      turnCount: turns.length,
      turnSignature: `${conversationId}:${turns.length}:${lastTurn.lastAgentStepIdx}`,
    };
  }

  const finalReply = lastTurn.replies[lastTurn.replies.length - 1];
  const prevTurn = turns.length >= 2 ? turns[turns.length - 2] : null;

  const summaryBlocks = [];
  if (prevTurn && prevTurn.replies.length > 0) {
    const prevLastReply = prevTurn.replies[prevTurn.replies.length - 1].text;
    summaryBlocks.push(
      `【上一轮背景摘要】\n用户曾说：${prevTurn.userText.slice(0, 200)}\nAI 上轮结论：${prevLastReply.slice(-260)}`
    );
  }

  const toolsUsed = [...lastTurn.tools];
  summaryBlocks.push(`【本轮用户请求】\n${clipHeadTail(lastTurn.userText, 240, 420)}`);
  if (toolsUsed.length > 0) {
    summaryBlocks.push(`【本轮 AI 调用过的工具】\n${toolsUsed.slice(0, 12).join(', ')}`);
  }
  summaryBlocks.push(
    `【本轮 AI 最终回复（重点关注结尾结论与待办）】\n${clipHeadTail(finalReply.text, 320, 980)}`
  );
  summaryBlocks.push('\n请直接输出用户接下来最可能发送的那一句简短指令：');

  return {
    skipReason: '',
    turnCount: turns.length,
    lastReplyStepIdx: finalReply.stepIdx,
    turnSignature: `${conversationId}:${turns.length}:${finalReply.stepIdx}`,
    promptText: summaryBlocks.join('\n\n'),
  };
}

const sessionSuggestionMap = new Map();

function pruneSessionMap() {
  if (sessionSuggestionMap.size <= 80) return;
  const oldestKey = sessionSuggestionMap.keys().next().value;
  if (oldestKey !== undefined) sessionSuggestionMap.delete(oldestKey);
}

export async function triggerConversationSuggestion({
  conversationId,
  transcriptPath = '',
  force = false,
}) {
  const cid = String(conversationId || '').trim();
  if (!cid) return { ok: false, reason: 'missing_conversation_id' };

  const pub = getPublicStatus();
  if (!pub.enabled) {
    return { ok: false, reason: 'plugin_disabled' };
  }
  if (!pub.hasCredentials) {
    return { ok: false, reason: 'missing_credentials' };
  }

  await new Promise((r) => setTimeout(r, 120));

  const resolved = resolveTranscriptFile(cid, transcriptPath);
  if (!resolved) {
    return { ok: false, reason: 'transcript_not_found' };
  }

  const ctx = extractTranscriptTurnContext(resolved.transcriptPath, cid);
  if (!ctx) {
    return { ok: false, reason: 'turn_incomplete' };
  }

  if (ctx.skipReason) {
    pruneSessionMap();
    sessionSuggestionMap.set(cid, {
      status: 'idle',
      suggestion: '',
      turnSignature: ctx.turnSignature,
      updatedAt: Date.now(),
      error: '',
    });
    return { ok: true, skipped: ctx.skipReason, turnSignature: ctx.turnSignature };
  }

  const existing = sessionSuggestionMap.get(cid);
  if (
    !force &&
    existing &&
    existing.turnSignature === ctx.turnSignature &&
    ['generating', 'ready', 'accepted', 'dismissed'].includes(existing.status)
  ) {
    return { ok: true, deduplicated: true, state: existing };
  }

  pruneSessionMap();
  const pendingState = {
    status: 'generating',
    suggestion: '',
    turnSignature: ctx.turnSignature,
    updatedAt: Date.now(),
    latencyMs: 0,
    error: '',
  };
  sessionSuggestionMap.set(cid, pendingState);

  void (async () => {
    try {
      const result = await generateNextSuggestionFromMessages(ctx.promptText);
      const latest = sessionSuggestionMap.get(cid);
      if (!latest || latest.turnSignature !== ctx.turnSignature || latest.status === 'dismissed') {
        return;
      }
      sessionSuggestionMap.set(cid, {
        status: result.suggestion ? 'ready' : 'idle',
        suggestion: result.suggestion || '',
        turnSignature: ctx.turnSignature,
        updatedAt: Date.now(),
        latencyMs: result.latencyMs,
        error: '',
      });
    } catch (err) {
      const latest = sessionSuggestionMap.get(cid);
      if (!latest || latest.turnSignature !== ctx.turnSignature) return;
      sessionSuggestionMap.set(cid, {
        status: 'error',
        suggestion: '',
        turnSignature: ctx.turnSignature,
        updatedAt: Date.now(),
        latencyMs: 0,
        error: err?.message || String(err),
      });
    }
  })();

  return { ok: true, queued: true, turnSignature: ctx.turnSignature };
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        req.destroy();
        reject(new Error('请求体过大'));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(body);
}

export function startSuggestServer() {
  const server = http.createServer(async (req, res) => {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      });
      res.end();
      return;
    }

    const u = new URL(req.url || '/', `http://${HOST}:${PORT}`);

    try {
      if (req.method === 'GET' && u.pathname === '/api/health') {
        sendJson(res, 200, { ok: true, version: SERVICE_VERSION, pid: process.pid });
        return;
      }

      if (req.method === 'GET' && u.pathname === '/api/status') {
        sendJson(res, 200, getPublicStatus());
        return;
      }

      if (req.method === 'GET' && u.pathname === '/api/suggestion') {
        const cid = u.searchParams.get('conversationId') || '';
        const pub = getPublicStatus();
        let state = cid ? sessionSuggestionMap.get(cid) || null : null;

        // 若该会话存在上一轮未消费的建议，但 transcript.jsonl 已进入新一轮对话，则自动淘汰过期建议
        if (cid && state && state.status === 'ready' && state.turnSignature) {
          try {
            const resolved = resolveTranscriptFile(cid);
            if (resolved && resolved.transcriptPath) {
              const stStat = fs.statSync(resolved.transcriptPath);
              if (!state._checkedMtimeMs || stStat.mtimeMs > state._checkedMtimeMs) {
                const latestCtx = extractTranscriptTurnContext(resolved.transcriptPath, cid);
                if (!latestCtx || latestCtx.turnSignature !== state.turnSignature) {
                  state = {
                    ...state,
                    status: 'dismissed',
                    suggestion: '',
                    _checkedMtimeMs: stStat.mtimeMs,
                  };
                  sessionSuggestionMap.set(cid, state);
                } else {
                  state._checkedMtimeMs = stStat.mtimeMs;
                }
              }
            }
          } catch {}
        }

        sendJson(res, 200, {
          ok: true,
          pluginEnabled: pub.pluginEnabled,
          enabled: pub.enabled,
          provider: pub.provider,
          hasCredentials: pub.hasCredentials,
          projectId: pub.projectId,
          model: pub.activeModel || pub.model,
          state,
        });
        return;
      }

      if (req.method === 'GET' && u.pathname === '/api/recent') {
        const items = [];
        for (const [cid, st] of sessionSuggestionMap.entries()) {
          items.push({ conversationId: cid, ...st });
        }
        items.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
        sendJson(res, 200, { ok: true, items: items.slice(0, 10) });
        return;
      }

      if (req.method === 'POST' && u.pathname === '/api/config') {
        const raw = await readRequestBody(req);
        const body = raw ? JSON.parse(raw) : {};

        if (body.clearCredentials) {
          clearSavedCredentials();
        }
        if (typeof body.credentialJson === 'string' && body.credentialJson.trim()) {
          saveCredentialsJson(body.credentialJson);
        }

        const allowedKeys = [
          'enabled',
          'provider',
          'location',
          'projectId',
          'model',
          'openaiBaseUrl',
          'openaiModel',
        ];
        const patch = {};
        for (const k of allowedKeys) {
          if (body[k] !== undefined) {
            patch[k] = body[k];
          }
        }
        if (body.clearOpenaiKey) {
          patch.openaiApiKey = '';
        } else if (typeof body.openaiApiKey === 'string' && body.openaiApiKey.trim()) {
          patch.openaiApiKey = body.openaiApiKey.trim();
        }
        if (Object.keys(patch).length > 0) {
          saveConfig(patch);
        }
        sendJson(res, 200, getPublicStatus());
        return;
      }

      if (req.method === 'POST' && u.pathname === '/api/test') {
        const raw = await readRequestBody(req);
        const body = raw ? JSON.parse(raw) : {};
        const sampleContext =
          '【本轮用户请求】\n帮我重构登录鉴权中间件并加上单元测试\n\n【本轮 AI 最终回复】\n已完成鉴权中间件重构并补充了 `auth.test.ts` 的 6 组边界用例代码。需要我现在运行全量测试确认通过吗？\n\n请直接输出用户接下来最可能发送的那一句简短指令：';

        const result = await generateNextSuggestionFromMessages(sampleContext, body);
        sendJson(res, 200, {
          ok: true,
          provider: result.provider,
          suggestion: result.suggestion,
          latencyMs: result.latencyMs,
          endpoint: result.endpoint,
          model: result.model,
          projectId: result.projectId,
        });
        return;
      }

      if (req.method === 'POST' && u.pathname === '/api/trigger') {
        const raw = await readRequestBody(req);
        const body = raw ? JSON.parse(raw) : {};
        const out = await triggerConversationSuggestion({
          conversationId: body.conversationId || '',
          transcriptPath: body.transcriptPath || '',
          force: Boolean(body.force),
        });
        sendJson(res, out.queued ? 202 : 200, out);
        return;
      }

      if (req.method === 'POST' && u.pathname === '/api/feedback') {
        const raw = await readRequestBody(req);
        const body = raw ? JSON.parse(raw) : {};
        const cid = String(body.conversationId || '').trim();
        const action = String(body.action || '').trim();
        if (cid && sessionSuggestionMap.has(cid)) {
          const cur = sessionSuggestionMap.get(cid);
          if (!body.turnSignature || cur.turnSignature === body.turnSignature) {
            sessionSuggestionMap.set(cid, {
              ...cur,
              status: action === 'accepted' ? 'accepted' : 'dismissed',
              suggestion: '',
              updatedAt: Date.now(),
            });
          }
        }
        sendJson(res, 200, { ok: true });
        return;
      }

      sendJson(res, 404, { ok: false, error: 'Not Found' });
    } catch (err) {
      sendJson(res, 400, { ok: false, error: err?.message || String(err) });
    }
  });

  server.on('error', (err) => {
    if (err && err.code === 'EADDRINUSE') {
      process.exit(0);
    }
  });

  server.listen(PORT, HOST, () => {
    try {
      fs.writeFileSync(
        PID_FILE,
        JSON.stringify(
          {
            pid: process.pid,
            port: PORT,
            version: SERVICE_VERSION,
            startedAt: new Date().toISOString(),
          },
          null,
          2
        ),
        'utf8'
      );
    } catch {}
  });

  return server;
}

const __filename = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]).toLowerCase() === path.resolve(__filename).toLowerCase()) {
  const cmd = (process.argv[2] || 'serve').toLowerCase();

  if (cmd === 'status') {
    console.log(JSON.stringify(getPublicStatus(), null, 2));
    process.exit(0);
  } else if (cmd === 'import-key') {
    const keyPath = process.argv[3];
    if (!keyPath || !fs.existsSync(keyPath)) {
      console.error('用法: node suggest-service.mjs import-key <service-account.json>');
      process.exit(1);
    }
    try {
      const raw = fs.readFileSync(keyPath, 'utf8');
      const info = saveCredentialsJson(raw);
      saveConfig({ provider: 'vertex-maas' });
      console.log(`导入成功！类型: ${info.credentialType}, Project ID: ${info.projectId}, 账号: ${info.clientEmail}`);
      process.exit(0);
    } catch (err) {
      console.error('导入失败:', err.message);
      process.exit(1);
    }
  } else if (cmd === 'set-openai') {
    const baseUrl = process.argv[3];
    const model = process.argv[4];
    const apiKey = process.argv[5] || '';
    if (!baseUrl || !model) {
      console.error('用法: node suggest-service.mjs set-openai <baseUrl> <model> [apiKey]');
      process.exit(1);
    }
    const patch = {
      provider: 'openai-compatible',
      openaiBaseUrl: baseUrl,
      openaiModel: model,
    };
    if (apiKey) {
      patch.openaiApiKey = apiKey;
    }
    saveConfig(patch);
    console.log(JSON.stringify(getPublicStatus(), null, 2));
    process.exit(0);
  } else if (cmd === 'test') {
    try {
      const sample =
        '【本轮用户请求】\n帮我开发一个对话框补全插件\n\n【本轮 AI 最终回复】\n已完成插件核心模块编码与热注入脚本。是否现在执行安装并在当前窗口验证补全效果？\n\n请直接输出用户接下来最可能发送的那一句简短指令：';
      const res = await generateNextSuggestionFromMessages(sample);
      console.log(JSON.stringify({ ok: true, ...res }, null, 2));
      process.exit(0);
    } catch (err) {
      console.error(JSON.stringify({ ok: false, error: err.message }, null, 2));
      process.exit(1);
    }
  } else {
    startSuggestServer();
  }
}
