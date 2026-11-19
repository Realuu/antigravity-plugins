#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { resolveTranscriptPath, parseTranscriptUsage } from './transcript-parser.mjs';

/**
 * Antigravity 生命周期 Hook 脚本
 * 接收 stdin 的会话元数据，解析实时 Token 占用并写入状态快照，向 stdout 输出合法 JSON `{}`。
 */
async function main() {
  const hookEvent = process.argv[2] || 'unknown';
  let rawInput = '';

  try {
    rawInput = fs.readFileSync(0, 'utf8');
  } catch {
    // 无 stdin 时忽略
  }

  let payload = {};
  try {
    if (rawInput.trim()) {
      payload = JSON.parse(rawInput);
    }
  } catch {
    // 忽略解析异常
  }

  try {
    const resolved = resolveTranscriptPath(payload.conversationId, payload.transcriptPath);
    if (resolved && resolved.transcriptPath) {
      const usage = parseTranscriptUsage(resolved.transcriptPath, resolved.conversationId);
      if (payload.modelName && payload.modelName !== 'auto') {
        usage.modelName = payload.modelName;
      }
      usage.lastHookEvent = hookEvent;
      usage.workspacePaths = payload.workspacePaths || [];

      const stateDir = path.join(os.homedir(), '.gemini', 'antigravity', 'scratch');
      fs.mkdirSync(stateDir, { recursive: true });
      const stateFile = path.join(stateDir, 'context-donut-state.json');
      fs.writeFileSync(stateFile, JSON.stringify(usage, null, 2), 'utf8');
    }
  } catch {
    // 确保任何异常都不阻塞 Agent 主循环
  }

  process.stdout.write('{}\n');
}

main();
