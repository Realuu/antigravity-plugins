import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const VENDOR_DIR = path.join(__dirname, 'vendor');

const HOST = '127.0.0.1';
const FIXED_FALLBACK_PORT = 45792;
const requestedPort = parseInt(
  process.env.ANTIGRAVITY_SIDECAR_WEB_PORT ||
    process.env.PORT ||
    process.env.ANTIGRAVITY_SIDECAR_PORT ||
    String(FIXED_FALLBACK_PORT),
  10
);
const LISTEN_PORT = Number.isNaN(requestedPort) ? FIXED_FALLBACK_PORT : requestedPort;

const WSL_EXE = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'wsl.exe');
const MAX_SCROLLBACK_BYTES = 256 * 1024; // 每个标签保留最近 256KB 原始字节，收起面板重开时无缝还原屏幕

// ============================================================================
// 1. WSL 内置 Python3 原生 POSIX PTY 守护脚本 (支持真彩色、信号控制、TIOCSWINSZ 动态缩放)
// ============================================================================
const PTY_BRIDGE_PY = `
import os, sys, pty, pwd, json, base64, struct, fcntl, signal, termios, threading

def send_msg(obj):
    try:
        line = (json.dumps(obj, separators=(',', ':')) + '\\n').encode('utf-8')
        os.write(1, line)
    except OSError:
        pass

def set_winsize(fd, rows, cols):
    try:
        rows = max(2, min(500, int(rows)))
        cols = max(4, min(1000, int(cols)))
        winsize = struct.pack('HHHH', rows, cols, 0, 0)
        fcntl.ioctl(fd, termios.TIOCSWINSZ, winsize)
    except Exception:
        pass

def main():
    start_cwd = os.environ.get('AGY_WSL_START_CWD', '').strip()
    init_cols = int(os.environ.get('AGY_WSL_COLS', '100') or '100')
    init_rows = int(os.environ.get('AGY_WSL_ROWS', '30') or '30')

    home_dir = os.path.expanduser('~')
    try:
        user_shell = pwd.getpwuid(os.getuid()).pw_shell or os.environ.get('SHELL') or '/bin/bash'
    except Exception:
        user_shell = os.environ.get('SHELL') or '/bin/bash'

    master_fd, slave_fd = pty.openpty()
    set_winsize(master_fd, init_rows, init_cols)

    pid = os.fork()
    if pid == 0:
        try:
            os.close(master_fd)
            os.setsid()
            try:
                fcntl.ioctl(slave_fd, termios.TIOCSCTTY, 0)
            except Exception:
                pass
            os.dup2(slave_fd, 0)
            os.dup2(slave_fd, 1)
            os.dup2(slave_fd, 2)
            if slave_fd > 2:
                os.close(slave_fd)

            target_dir = home_dir
            if start_cwd and os.path.isdir(start_cwd):
                target_dir = start_cwd
            try:
                os.chdir(target_dir)
            except Exception:
                os.chdir(home_dir)

            env = dict(os.environ)
            for k in ('AGY_WSL_START_CWD', 'AGY_WSL_COLS', 'AGY_WSL_ROWS'):
                env.pop(k, None)
            env['TERM'] = 'xterm-256color'
            env['COLORTERM'] = 'truecolor'
            env['HOME'] = home_dir
            env['SHELL'] = user_shell

            os.execvpe(user_shell, [user_shell, '-l'], env)
        except Exception as err:
            os.write(2, f'Failed to exec shell: {err}\\r\\n'.encode('utf-8'))
            os._exit(1)

    os.close(slave_fd)
    actual_cwd = start_cwd if (start_cwd and os.path.isdir(start_cwd)) else home_dir
    send_msg({
        't': 'm',
        'pid': pid,
        'shell': os.path.basename(user_shell),
        'home': home_dir,
        'cwd': actual_cwd
    })

    stop_event = threading.Event()

    def terminate_child():
        if stop_event.is_set():
            return
        stop_event.set()
        try:
            os.killpg(os.getpgid(pid), signal.SIGHUP)
        except Exception:
            try:
                os.kill(pid, signal.SIGHUP)
            except Exception:
                pass
        try:
            os.close(master_fd)
        except Exception:
            pass

    def stdin_reader():
        while not stop_event.is_set():
            try:
                raw_line = sys.stdin.buffer.readline()
            except Exception:
                break
            if not raw_line:
                terminate_child()
                break
            line_str = raw_line.decode('utf-8', errors='ignore').strip()
            if not line_str:
                continue
            try:
                msg = json.loads(line_str)
            except Exception:
                continue
            mtype = msg.get('t')
            if mtype == 'i':
                data_b64 = msg.get('d', '')
                if data_b64:
                    try:
                        os.write(master_fd, base64.b64decode(data_b64))
                    except OSError:
                        break
            elif mtype == 'r':
                set_winsize(master_fd, msg.get('r', 30), msg.get('c', 100))
            elif mtype == 'k':
                terminate_child()
                break

    reader_thread = threading.Thread(target=stdin_reader, daemon=True)
    reader_thread.start()

    while not stop_event.is_set():
        try:
            chunk = os.read(master_fd, 16384)
            if not chunk:
                break
            send_msg({'t': 'o', 'd': base64.b64encode(chunk).decode('ascii')})
        except OSError:
            break

    stop_event.set()
    exit_code = 0
    try:
        _, status = os.waitpid(pid, 0)
        if os.WIFEXITED(status):
            exit_code = os.WEXITSTATUS(status)
        elif os.WIFSIGNALED(status):
            exit_code = 128 + os.WTERMSIG(status)
    except Exception:
        pass

    send_msg({'t': 'x', 'code': exit_code})

if __name__ == '__main__':
    main()
`;

// ============================================================================
// 2. 工作区路径解析与 Windows -> WSL /mnt/<drive> 映射
// ============================================================================
function fileUriToWindowsPath(uri) {
  if (!uri || typeof uri !== 'string') return '';
  try {
    if (uri.startsWith('file://')) {
      return fileURLToPath(uri);
    }
    return uri;
  } catch {
    return '';
  }
}

export function windowsPathToWslPath(rawPath) {
  if (!rawPath || typeof rawPath !== 'string') return '';
  const trimmed = rawPath.trim();
  if (!trimmed) return '';

  // 已经是 POSIX 路径
  if (trimmed.startsWith('/')) {
    return trimmed;
  }

  // \\wsl.localhost\Ubuntu\home\user 或 \\wsl$\Ubuntu\...
  const uncMatch = /^\\\\(?:wsl\.localhost|wsl\$)\\[^\\]+(.*)$/i.exec(trimmed);
  if (uncMatch) {
    const sub = uncMatch[1].replace(/\\/g, '/');
    return sub.startsWith('/') ? sub : `/${sub}`;
  }

  // 标准盘符路径 D:\projects\my-app -> /mnt/d/projects/my-app
  const driveMatch = /^([a-zA-Z]):[\\/](.*)$/.exec(trimmed);
  if (driveMatch) {
    const drive = driveMatch[1].toLowerCase();
    const rest = driveMatch[2].replace(/\\/g, '/').replace(/\/+$/, '');
    return rest ? `/mnt/${drive}/${rest}` : `/mnt/${drive}`;
  }

  return '';
}

function isReasonableProjectDir(winDir) {
  if (!winDir || typeof winDir !== 'string') return false;
  const norm = path.resolve(winDir);
  const lower = norm.toLowerCase();
  const homeLower = os.homedir().toLowerCase();
  if (lower.includes('\\.gemini\\')) return false;
  if (lower.endsWith('\\.agents') || lower.includes('\\.agents\\')) return false;
  if (lower.includes('\\appdata\\local\\programs\\antigravity')) return false;
  if (lower.startsWith('c:\\windows')) return false;
  if (lower === homeLower) return false;
  try {
    return fs.existsSync(norm) && fs.statSync(norm).isDirectory();
  } catch {
    return false;
  }
}

async function queryLsWorkspaceDir() {
  const lsAddr = process.env.ANTIGRAVITY_LS_ADDRESS;
  const csrf = process.env.ANTIGRAVITY_CSRF_TOKEN;
  if (!lsAddr || !csrf) return '';

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 600);
    const resp = await fetch(
      `http://${lsAddr}/exa.language_server_pb.LanguageServerService/GetWorkspaceInfos`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-codeium-csrf-token': csrf,
        },
        body: '{}',
        signal: controller.signal,
      }
    );
    clearTimeout(timer);
    if (!resp.ok) return '';
    const data = await resp.json();
    const infos = data?.workspaceInfos || data?.workspaces || [];
    for (const info of infos) {
      const uri = info?.workspaceUri || info?.uri || info?.rootUri || '';
      const p = fileUriToWindowsPath(uri);
      if (isReasonableProjectDir(p)) return p;
    }
  } catch {
    // ignore
  }
  return '';
}

function extractLatestActiveSessionWorkspace() {
  try {
    const brainDir = path.join(os.homedir(), '.gemini', 'antigravity', 'brain');
    if (!fs.existsSync(brainDir)) return '';
    const candidates = [];
    for (const entry of fs.readdirSync(brainDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const tp = path.join(brainDir, entry.name, '.system_generated', 'logs', 'transcript.jsonl');
      try {
        const st = fs.statSync(tp);
        candidates.push({ tp, mtimeMs: st.mtimeMs });
      } catch {}
    }
    candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);

    for (const item of candidates.slice(0, 5)) {
      const fd = fs.openSync(item.tp, 'r');
      const headBuf = Buffer.alloc(32768);
      const bytesRead = fs.readSync(fd, headBuf, 0, headBuf.length, 0);
      fs.closeSync(fd);
      const headText = headBuf.toString('utf8', 0, bytesRead);
      const cwdMatch = /Command Working Directory:\s*([A-Za-z]:[^\r\n"]+)/.exec(headText);
      if (cwdMatch) {
        const unescaped = cwdMatch[1].replace(/\\n.*$/, '').replace(/\\\\/g, '\\').trim();
        if (isReasonableProjectDir(unescaped)) {
          return path.resolve(unescaped);
        }
      }
    }
  } catch {
    // ignore
  }
  return '';
}

async function detectActiveWorkspaceInfo() {
  // 1. 环境变量显式指定当前工作区
  const envCandidates = [
    process.env.ANTIGRAVITY_WORKSPACE_ROOT,
    process.env.WORKSPACE_FOLDER,
  ];
  for (const c of envCandidates) {
    const p = fileUriToWindowsPath(c);
    if (isReasonableProjectDir(p)) {
      return { windowsPath: path.resolve(p), wslPath: windowsPathToWslPath(p) };
    }
  }

  // 2. 从当前最新活跃会话的 transcript.jsonl 精准提取正在使用的工作区 (<1ms)
  const activeSessionDir = extractLatestActiveSessionWorkspace();
  if (activeSessionDir) {
    return {
      windowsPath: activeSessionDir,
      wslPath: windowsPathToWslPath(activeSessionDir),
    };
  }

  // 3. 若插件位于 <workspace>/.agents/plugins/wsl-terminal/sidecars/wsl_terminal (往上回退 5 层)
  const maybeWorkspace = path.resolve(__dirname, '..', '..', '..', '..', '..');
  if (isReasonableProjectDir(maybeWorkspace)) {
    return {
      windowsPath: maybeWorkspace,
      wslPath: windowsPathToWslPath(maybeWorkspace),
    };
  }

  // 4. 当前进程工作目录
  const cwd = process.cwd();
  if (isReasonableProjectDir(cwd)) {
    return { windowsPath: path.resolve(cwd), wslPath: windowsPathToWslPath(cwd) };
  }

  // 5. 向本地 Language Server 查询工作区列表兜底
  const lsDir = await queryLsWorkspaceDir();
  if (lsDir) {
    return { windowsPath: path.resolve(lsDir), wslPath: windowsPathToWslPath(lsDir) };
  }

  // 6. 兜底读取持久化记录的最近工作区（由安装脚本写入）
  const fallbackMeta = path.join(__dirname, 'workspace_hint.json');
  if (fs.existsSync(fallbackMeta)) {
    try {
      const hint = JSON.parse(fs.readFileSync(fallbackMeta, 'utf8'));
      if (hint?.windowsPath && isReasonableProjectDir(hint.windowsPath)) {
        return {
          windowsPath: path.resolve(hint.windowsPath),
          wslPath: windowsPathToWslPath(hint.windowsPath),
        };
      }
    } catch {
      // ignore
    }
  }

  return { windowsPath: '', wslPath: '' };
}

// ============================================================================
// 3. 多标签 PTY 会话池与环形屏幕回放缓冲
// ============================================================================
const sessions = new Map();
let tabCounter = 0;

function appendScrollback(session, buf) {
  session.scrollbackChunks.push(buf);
  session.scrollbackBytes += buf.length;
  while (session.scrollbackBytes > MAX_SCROLLBACK_BYTES && session.scrollbackChunks.length > 1) {
    const removed = session.scrollbackChunks.shift();
    session.scrollbackBytes -= removed.length;
  }
}

function broadcastEvent(session, eventObj) {
  const payload = `data: ${JSON.stringify(eventObj)}\n\n`;
  for (const res of session.subscribers) {
    try {
      res.write(payload);
    } catch {
      session.subscribers.delete(res);
    }
  }
}

async function createTerminalSession({ cols = 100, rows = 30, startInHome = false } = {}) {
  const wsInfo = await detectActiveWorkspaceInfo();
  const id = `tab-${++tabCounter}-${crypto.randomBytes(2).toString('hex')}`;
  const indexLabel = tabCounter;
  const targetStartCwd = startInHome ? '' : wsInfo.wslPath;

  const session = {
    id,
    index: indexLabel,
    title: `bash ${indexLabel}`,
    shell: 'bash',
    alive: true,
    exitCode: null,
    createdAt: Date.now(),
    cols: Math.max(10, Number(cols) || 100),
    rows: Math.max(4, Number(rows) || 30),
    homeDir: '~',
    cwd: targetStartCwd || '~',
    workspaceWindowsPath: wsInfo.windowsPath,
    workspaceWslPath: wsInfo.wslPath,
    scrollbackChunks: [],
    scrollbackBytes: 0,
    subscribers: new Set(),
    proc: null,
    stdoutRemainder: '',
  };

  // 通过环境变量传递起始目录与行列尺寸给 WSL (WSLENV 自动桥接)
  const spawnEnv = {
    ...process.env,
    AGY_WSL_START_CWD: targetStartCwd || '',
    AGY_WSL_COLS: String(session.cols),
    AGY_WSL_ROWS: String(session.rows),
    WSLENV: [
      process.env.WSLENV,
      'AGY_WSL_START_CWD/u',
      'AGY_WSL_COLS/u',
      'AGY_WSL_ROWS/u',
    ]
      .filter(Boolean)
      .join(':'),
  };

  let proc;
  try {
    proc = spawn(WSL_EXE, ['--', 'python3', '-u', '-c', PTY_BRIDGE_PY], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: spawnEnv,
      windowsHide: true,
    });
  } catch (err) {
    session.alive = false;
    session.exitCode = -1;
    const errMsg = Buffer.from(`\r\n\x1b[31m[WSL 启动失败] ${err.message}\x1b[0m\r\n`, 'utf8');
    appendScrollback(session, errMsg);
    sessions.set(id, session);
    return session;
  }

  session.proc = proc;
  sessions.set(id, session);

  proc.stdout.on('data', (chunk) => {
    session.stdoutRemainder += chunk.toString('utf8');
    let newlineIdx;
    while ((newlineIdx = session.stdoutRemainder.indexOf('\n')) !== -1) {
      const line = session.stdoutRemainder.slice(0, newlineIdx).trim();
      session.stdoutRemainder = session.stdoutRemainder.slice(newlineIdx + 1);
      if (!line) continue;

      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }

      if (msg.t === 'o' && msg.d) {
        const rawBytes = Buffer.from(msg.d, 'base64');
        appendScrollback(session, rawBytes);
        broadcastEvent(session, { t: 'o', d: msg.d });
      } else if (msg.t === 'm') {
        if (msg.shell) {
          session.shell = msg.shell;
          session.title = `${msg.shell} ${session.index}`;
        }
        if (msg.home) session.homeDir = msg.home;
        if (msg.cwd) session.cwd = msg.cwd;
        broadcastEvent(session, {
          t: 'm',
          title: session.title,
          shell: session.shell,
          homeDir: session.homeDir,
          cwd: session.cwd,
          workspaceWslPath: session.workspaceWslPath,
        });
      } else if (msg.t === 'x') {
        session.alive = false;
        session.exitCode = msg.code ?? 0;
        const exitBanner = Buffer.from(
          `\r\n\x1b[90m[会话已结束，退出码 ${session.exitCode}]\x1b[0m\r\n`,
          'utf8'
        );
        appendScrollback(session, exitBanner);
        broadcastEvent(session, {
          t: 'o',
          d: exitBanner.toString('base64'),
        });
        broadcastEvent(session, { t: 'x', code: session.exitCode });
      }
    }
  });

  proc.stderr.on('data', (chunk) => {
    // 捕获 wsl.exe 或 python3 未安装的早期错误并显示在终端画布上
    const text = chunk.includes(0)
      ? chunk.toString('utf16le').replace(/^\uFEFF/, '')
      : chunk.toString('utf8');
    if (!text.trim()) return;
    const formatted = Buffer.from(`\r\n\x1b[33m${text.replace(/\r?\n/g, '\r\n')}\x1b[0m`, 'utf8');
    appendScrollback(session, formatted);
    broadcastEvent(session, { t: 'o', d: formatted.toString('base64') });
  });

  proc.on('exit', (code) => {
    if (session.alive) {
      session.alive = false;
      session.exitCode = code ?? 0;
      broadcastEvent(session, { t: 'x', code: session.exitCode });
    }
  });

  proc.on('error', (err) => {
    session.alive = false;
    session.exitCode = -1;
    const errBuf = Buffer.from(`\r\n\x1b[31m[进程错误] ${err.message}\x1b[0m\r\n`, 'utf8');
    appendScrollback(session, errBuf);
    broadcastEvent(session, { t: 'o', d: errBuf.toString('base64') });
    broadcastEvent(session, { t: 'x', code: -1 });
  });

  return session;
}

function writeToPty(session, frameObj) {
  if (!session || !session.alive || !session.proc?.stdin?.writable) {
    return false;
  }
  try {
    session.proc.stdin.write(`${JSON.stringify(frameObj)}\n`);
    return true;
  } catch {
    return false;
  }
}

function destroySession(id) {
  const session = sessions.get(id);
  if (!session) return false;
  sessions.delete(id);

  if (session.alive && session.proc) {
    writeToPty(session, { t: 'k' });
    setTimeout(() => {
      try {
        session.proc.kill();
      } catch {}
    }, 300);
  }

  for (const res of session.subscribers) {
    try {
      res.write(`data: ${JSON.stringify({ t: 'closed' })}\n\n`);
      res.end();
    } catch {}
  }
  session.subscribers.clear();
  session.scrollbackChunks = [];
  return true;
}

function serializeSessionSummary(s) {
  return {
    id: s.id,
    index: s.index,
    title: s.title,
    shell: s.shell,
    alive: s.alive,
    exitCode: s.exitCode,
    cols: s.cols,
    rows: s.rows,
    homeDir: s.homeDir,
    cwd: s.cwd,
    workspaceWslPath: s.workspaceWslPath,
    createdAt: s.createdAt,
  };
}

// ============================================================================
// 4. HTTP 路由处理 (完全兼容 plugin://<authority> 同源请求与 SSE 流)
// ============================================================================
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 2 * 1024 * 1024) {
        reject(new Error('Payload too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, obj) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(JSON.stringify(obj));
}

async function handleRequest(req, res) {
  if (req.method === 'OPTIONS') {
    sendJson(res, 200, { ok: true });
    return;
  }

  const urlObj = new URL(req.url || '/', `http://${HOST}:${LISTEN_PORT}`);
  const pathname = urlObj.pathname;

  // 健康检查
  if (pathname === '/healthz') {
    sendJson(res, 200, { status: 'ok', activeSessions: sessions.size });
    return;
  }

  // 查询或新建会话
  if (pathname === '/api/sessions' && req.method === 'GET') {
    const wsInfo = await detectActiveWorkspaceInfo();
    const list = Array.from(sessions.values()).map((s) => {
      // 动态同步最新探测到的工作区路径
      if (wsInfo.wslPath) {
        s.workspaceWslPath = wsInfo.wslPath;
        s.workspaceWindowsPath = wsInfo.windowsPath;
      }
      return serializeSessionSummary(s);
    });
    sendJson(res, 200, {
      sessions: list,
      workspaceWslPath: wsInfo.wslPath,
      workspaceWindowsPath: wsInfo.windowsPath,
    });
    return;
  }

  if (pathname === '/api/sessions' && req.method === 'POST') {
    try {
      const body = await readJsonBody(req);
      const session = await createTerminalSession({
        cols: body.cols,
        rows: body.rows,
        startInHome: Boolean(body.startInHome),
      });
      sendJson(res, 201, { session: serializeSessionSummary(session) });
    } catch (err) {
      sendJson(res, 500, { error: err.message });
    }
    return;
  }

  // 关闭指定会话 (POST /api/sessions/close 或 DELETE)
  if (pathname === '/api/sessions/close' && req.method === 'POST') {
    try {
      const body = await readJsonBody(req);
      const removed = destroySession(body.id);
      sendJson(res, 200, { ok: removed });
    } catch (err) {
      sendJson(res, 400, { error: err.message });
    }
    return;
  }

  // 发送键盘输入字节
  if (pathname === '/api/input' && req.method === 'POST') {
    try {
      const body = await readJsonBody(req);
      const session = sessions.get(body.id);
      if (!session) {
        sendJson(res, 404, { error: 'Session not found' });
        return;
      }
      let dataB64 = body.dataB64;
      if (!dataB64 && typeof body.data === 'string') {
        dataB64 = Buffer.from(body.data, 'utf8').toString('base64');
      }
      const ok = dataB64 ? writeToPty(session, { t: 'i', d: dataB64 }) : true;
      sendJson(res, 200, { ok, alive: session.alive });
    } catch (err) {
      sendJson(res, 400, { error: err.message });
    }
    return;
  }

  // 调整 PTY 窗口行列尺寸
  if (pathname === '/api/resize' && req.method === 'POST') {
    try {
      const body = await readJsonBody(req);
      const session = sessions.get(body.id);
      if (!session) {
        sendJson(res, 404, { error: 'Session not found' });
        return;
      }
      const cols = Math.max(4, Math.min(1000, Number(body.cols) || 100));
      const rows = Math.max(2, Math.min(500, Number(body.rows) || 30));
      session.cols = cols;
      session.rows = rows;
      const ok = writeToPty(session, { t: 'r', c: cols, r: rows });
      sendJson(res, 200, { ok });
    } catch (err) {
      sendJson(res, 400, { error: err.message });
    }
    return;
  }

  // 清空指定会话服务端回放缓冲（配合前端清屏按钮，避免重开面板又回放旧内容）
  if (pathname === '/api/clear-scrollback' && req.method === 'POST') {
    try {
      const body = await readJsonBody(req);
      const session = sessions.get(body.id);
      if (session) {
        session.scrollbackChunks = [];
        session.scrollbackBytes = 0;
      }
      sendJson(res, 200, { ok: true });
    } catch (err) {
      sendJson(res, 400, { error: err.message });
    }
    return;
  }

  // SSE 实时终端字节流订阅（支持历史屏幕回放，面板关闭重开不丢画面）
  if (pathname === '/api/stream' && req.method === 'GET') {
    const id = urlObj.searchParams.get('id') || '';
    const replay = urlObj.searchParams.get('replay') !== '0';
    const session = sessions.get(id);
    if (!session) {
      sendJson(res, 404, { error: 'Session not found' });
      return;
    }

    req.socket?.setNoDelay?.(true);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      'Access-Control-Allow-Origin': '*',
    });

    // 发送初始元数据
    res.write(
      `data: ${JSON.stringify({
        t: 'm',
        title: session.title,
        shell: session.shell,
        alive: session.alive,
        exitCode: session.exitCode,
        homeDir: session.homeDir,
        cwd: session.cwd,
        workspaceWslPath: session.workspaceWslPath,
      })}\n\n`
    );

    // 回放历史屏幕缓冲
    if (replay && session.scrollbackChunks.length > 0) {
      const merged = Buffer.concat(session.scrollbackChunks);
      res.write(`data: ${JSON.stringify({ t: 'o', d: merged.toString('base64') })}\n\n`);
    }

    session.subscribers.add(res);

    const heartbeat = setInterval(() => {
      try {
        res.write(': ping\n\n');
      } catch {
        clearInterval(heartbeat);
        session.subscribers.delete(res);
      }
    }, 15000);

    req.on('close', () => {
      clearInterval(heartbeat);
      session.subscribers.delete(res);
    });
    return;
  }

  // 静态 vendor 资源 (/vendor/xterm.css, /vendor/xterm.js, /vendor/addon-fit.js)
  if (pathname.startsWith('/vendor/')) {
    const rel = pathname.slice('/vendor/'.length);
    const target = path.resolve(VENDOR_DIR, rel);
    if (target.startsWith(VENDOR_DIR) && fs.existsSync(target) && fs.statSync(target).isFile()) {
      const ext = path.extname(target).toLowerCase();
      const contentType =
        ext === '.css'
          ? 'text/css; charset=utf-8'
          : ext === '.js'
            ? 'application/javascript; charset=utf-8'
            : 'application/octet-stream';
      res.writeHead(200, {
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=3600',
      });
      res.end(fs.readFileSync(target));
      return;
    }
    res.writeHead(404);
    res.end('Not Found');
    return;
  }

  // 入口 UI 页面 (/ 或 /ui.html)
  if (pathname === '/' || pathname === '/ui.html' || pathname === '/index.html') {
    const uiPath = path.join(__dirname, 'ui.html');
    let html = fs.readFileSync(uiPath, 'utf8');
    if (urlObj.search) {
      html = html
        .replace('href="/vendor/xterm.css"', `href="/vendor/xterm.css${urlObj.search}"`)
        .replace('src="/vendor/xterm.js"', `src="/vendor/xterm.js${urlObj.search}"`)
        .replace('src="/vendor/addon-fit.js"', `src="/vendor/addon-fit.js${urlObj.search}"`);
    }
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(html);
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not Found');
}

// 进程退出时优雅清理所有打开的 WSL PTY 会话
function cleanupAllSessions() {
  for (const id of Array.from(sessions.keys())) {
    destroySession(id);
  }
}
process.on('SIGINT', () => {
  cleanupAllSessions();
  process.exit(0);
});
process.on('SIGTERM', () => {
  cleanupAllSessions();
  process.exit(0);
});

const mainServer = http.createServer(handleRequest);
mainServer.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE' && LISTEN_PORT !== 0) {
    mainServer.listen(0, HOST);
  }
});
mainServer.listen(LISTEN_PORT, HOST, () => {
  const addr = mainServer.address();
  const actualPort = typeof addr === 'object' && addr ? addr.port : LISTEN_PORT;
  console.log(`[WSL Terminal Sidecar] listening on http://${HOST}:${actualPort}`);
});

if (LISTEN_PORT !== FIXED_FALLBACK_PORT) {
  const mirrorServer = http.createServer(handleRequest);
  mirrorServer.on('error', () => {});
  mirrorServer.listen(FIXED_FALLBACK_PORT, HOST);
}
