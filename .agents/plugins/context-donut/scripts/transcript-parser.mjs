import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const IS_WIN = process.platform === 'win32';
const IS_LINUX = process.platform === 'linux';

/**
 * 收集 Windows 侧通过 UNC 访问 WSL 2 发行版时的用户目录
 */
function collectWinWslHomes(distro) {
  if (!distro || !IS_WIN) return [];
  const homes = [];
  const seen = new Set();
  const pushHome = (p) => {
    if (!p) return;
    const key = p.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      homes.push(p);
    }
  };

  try {
    const cacheFile = path.resolve(__dirname, '..', '.wsl-distros.json');
    if (fs.existsSync(cacheFile)) {
      const parsed = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (item && item.name === distro && item.uncHome && fs.existsSync(item.uncHome)) {
            pushHome(item.uncHome);
          }
        }
      }
    }
  } catch {}

  for (const root of [`\\\\wsl.localhost\\${distro}`, `\\\\wsl$\\${distro}`]) {
    let found = false;
    try {
      const homeBase = path.join(root, 'home');
      if (fs.existsSync(homeBase)) {
        for (const entry of fs.readdirSync(homeBase, { withFileTypes: true })) {
          if (entry.isDirectory()) {
            pushHome(path.join(homeBase, entry.name));
            found = true;
          }
        }
      }
    } catch {}
    try {
      if (fs.existsSync(path.join(root, 'root', '.gemini'))) {
        pushHome(path.join(root, 'root'));
        found = true;
      }
    } catch {}
    if (found) break;
  }

  return homes;
}

/**
 * 获取 Antigravity Brain 目录列表（兼容 Windows 本地、WSL Linux 原生以及跨端互补扫描）
 */
export function getBrainDirs() {
  const home = os.homedir();
  const candidates = [
    path.join(home, '.gemini', 'antigravity', 'brain'),
    path.join(home, '.gemini', 'antigravity-ide', 'brain'),
    path.join(home, '.gemini', 'antigravity-cli', 'brain'),
  ];

  if (IS_WIN) {
    const distroOrder = [];
    try {
      const wslStatePath = path.join(home, 'AppData', 'Roaming', 'Antigravity', 'wsl_state.json');
      if (fs.existsSync(wslStatePath)) {
        const parsed = JSON.parse(fs.readFileSync(wslStatePath, 'utf8'));
        const active = String(parsed?.distro || '').trim();
        if (active) distroOrder.push(active);
      }
    } catch {}

    try {
      const cacheFile = path.resolve(__dirname, '..', '.wsl-distros.json');
      if (fs.existsSync(cacheFile)) {
        const parsed = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
        if (Array.isArray(parsed)) {
          for (const item of parsed) {
            const name = String(item?.name || '').trim();
            if (name && !distroOrder.includes(name)) distroOrder.push(name);
          }
        }
      }
    } catch {}

    for (const distro of distroOrder) {
      for (const wslHome of collectWinWslHomes(distro)) {
        candidates.push(
          path.join(wslHome, '.gemini', 'antigravity', 'brain'),
          path.join(wslHome, '.gemini', 'antigravity-ide', 'brain'),
          path.join(wslHome, '.gemini', 'antigravity-cli', 'brain')
        );
      }
    }
  } else if (IS_LINUX) {
    try {
      const mntUsers = '/mnt/c/Users';
      if (fs.existsSync(mntUsers)) {
        for (const entry of fs.readdirSync(mntUsers, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue;
          if (['Public', 'Default', 'Default User', 'All Users'].includes(entry.name)) continue;
          const winHome = path.join(mntUsers, entry.name);
          candidates.push(
            path.join(winHome, '.gemini', 'antigravity', 'brain'),
            path.join(winHome, '.gemini', 'antigravity-ide', 'brain'),
            path.join(winHome, '.gemini', 'antigravity-cli', 'brain')
          );
        }
      }
    } catch {}
  }

  const seen = new Set();
  return candidates.filter((dir) => {
    const key = IS_WIN ? dir.toLowerCase() : dir;
    if (seen.has(key)) return false;
    seen.add(key);
    try {
      return fs.existsSync(dir) && fs.statSync(dir).isDirectory();
    } catch {
      return false;
    }
  });
}

/**
 * 根据 conversationId 定位 transcript.jsonl 路径；若未传入则自动查找最近修改的活跃会话
 */
export function resolveTranscriptPath(conversationId, explicitTranscriptPath) {
  if (explicitTranscriptPath && fs.existsSync(explicitTranscriptPath)) {
    return {
      conversationId: conversationId || extractConversationIdFromPath(explicitTranscriptPath),
      transcriptPath: explicitTranscriptPath,
    };
  }

  const brainDirs = getBrainDirs();
  const targetCid = typeof conversationId === 'string' ? conversationId.trim() : '';

  if (targetCid) {
    for (const brainDir of brainDirs) {
      const candidate = path.join(
        brainDir,
        targetCid,
        '.system_generated',
        'logs',
        'transcript.jsonl'
      );
      if (fs.existsSync(candidate)) {
        return { conversationId: targetCid, transcriptPath: candidate };
      }
    }
    // 明确指定了 conversationId 但日志尚未生成时直接返回 null，避免回退串台显示其他旧会话
    return null;
  }

  // 未指定 conversationId 时，回退查找最近修改的活跃会话 transcript.jsonl
  let latest = null;
  let latestMtime = 0;

  for (const brainDir of brainDirs) {
    let entries = [];
    try {
      entries = fs.readdirSync(brainDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const cid = entry.name;
      const tPath = path.join(brainDir, cid, '.system_generated', 'logs', 'transcript.jsonl');
      try {
        const stat = fs.statSync(tPath);
        if (stat.mtimeMs > latestMtime) {
          latestMtime = stat.mtimeMs;
          latest = { conversationId: cid, transcriptPath: tPath };
        }
      } catch {
        // 忽略不存在日志的子目录
      }
    }
  }

  return latest;
}

function extractConversationIdFromPath(filePath) {
  const normalized = filePath.replace(/\\/g, '/');
  const match = normalized.match(/\/brain\/([0-9a-fA-F-]{36})\//);
  return match ? match[1] : 'unknown';
}

/**
 * 解析 transcript.jsonl，精确计算当前上下文占用与历史趋势
 */
export function parseTranscriptUsage(transcriptPath, conversationIdOverride) {
  const emptyResult = {
    conversationId: conversationIdOverride || null,
    transcriptPath: transcriptPath || null,
    modelName: 'Gemini',
    inputTokens: 0,
    cacheReadTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    promptTokens: 0,
    cumulativeOutputTokens: 0,
    cacheHitRate: 0,
    turnCount: 0,
    plannerStepCount: 0,
    stepCount: 0,
    history: [],
    updatedAt: new Date().toISOString(),
  };

  if (!transcriptPath || !fs.existsSync(transcriptPath)) {
    return emptyResult;
  }

  try {
    const stat = fs.statSync(transcriptPath);
    const content = fs.readFileSync(transcriptPath, 'utf8');
    const lines = content.split(/\r?\n/).filter((line) => line.trim().length > 0);

    let latestPlanner = null;
    let modelName = 'Gemini';
    let turnCount = 0;
    let plannerStepCount = 0;
    let cumulativeOutputTokens = 0;
    const history = [];

    for (const line of lines) {
      let step;
      try {
        step = JSON.parse(line);
      } catch {
        continue;
      }

      if (step.type === 'USER_INPUT') {
        turnCount++;
        // 检测用户是否切换了模型设置
        if (typeof step.content === 'string') {
          const modelMatch = step.content.match(/changed setting `Model Selection` from .*? to ([^\n.]+)/);
          if (modelMatch && modelMatch[1]) {
            modelName = modelMatch[1].trim();
          }
        }
      }

      if (step.type === 'PLANNER_RESPONSE' || step.token_usage) {
        const u = step.token_usage && typeof step.token_usage === 'object' ? step.token_usage : step;
        const input = Number(u.input_tokens) || 0;
        const cache = Number(u.cache_read_tokens) || 0;
        const output = Number(u.output_tokens) || 0;
        const total = input + cache + output;

        if (u.model && typeof u.model === 'string') {
          modelName = u.model;
        }

        if (total > 0) {
          plannerStepCount++;
          cumulativeOutputTokens += output;
          latestPlanner = {
            stepIndex: step.step_index,
            inputTokens: input,
            cacheReadTokens: cache,
            outputTokens: output,
            totalTokens: total,
            createdAt: step.created_at || null,
          };
          history.push({
            step: plannerStepCount,
            stepIndex: step.step_index,
            inputTokens: input,
            cacheReadTokens: cache,
            outputTokens: output,
            totalTokens: total,
            createdAt: step.created_at || null,
          });
        }
      }
    }

    const inputTokens = latestPlanner ? latestPlanner.inputTokens : 0;
    const cacheReadTokens = latestPlanner ? latestPlanner.cacheReadTokens : 0;
    const outputTokens = latestPlanner ? latestPlanner.outputTokens : 0;
    const promptTokens = inputTokens + cacheReadTokens;
    const totalTokens = promptTokens + outputTokens;
    const cacheHitRate =
      promptTokens > 0 ? Math.round((cacheReadTokens / promptTokens) * 1000) / 10 : 0;

    return {
      conversationId: conversationIdOverride || extractConversationIdFromPath(transcriptPath),
      transcriptPath,
      modelName,
      inputTokens,
      cacheReadTokens,
      outputTokens,
      promptTokens,
      totalTokens,
      cumulativeOutputTokens,
      cacheHitRate,
      turnCount,
      plannerStepCount,
      stepCount: lines.length,
      history: history.slice(-30), // 保留最近 30 步趋势用于图表展示
      fileMtimeMs: stat.mtimeMs,
      updatedAt: latestPlanner?.createdAt || new Date(stat.mtimeMs).toISOString(),
    };
  } catch {
    return emptyResult;
  }
}

/**
 * 供 hook-tracker.mjs 调用的便捷封装：自动定位会话并返回最新 Token 统计
 */
export function getLatestTranscriptStats(options = {}) {
  const resolved = resolveTranscriptPath(options.conversationId, options.transcriptPath);
  if (!resolved || !resolved.transcriptPath) {
    return parseTranscriptUsage(null, options.conversationId || null);
  }
  return parseTranscriptUsage(resolved.transcriptPath, resolved.conversationId);
}

// 允许作为独立 CLI 直接执行：`node scripts/transcript-parser.mjs [conversationId]`
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const requestedCid = process.argv[2] ? String(process.argv[2]).trim() : undefined;
  const result = getLatestTranscriptStats({ conversationId: requestedCid });
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}
