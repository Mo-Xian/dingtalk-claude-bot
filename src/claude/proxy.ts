/**
 * Claude CLI Proxy - 独立运行的代理进程
 *
 * 功能：
 * - 管理 Claude CLI 子进程的生命周期
 * - 通过 Named Pipe (Windows) / Unix Socket 暴露 IPC 接口
 * - Bot 重启时只需重连 Pipe，不影响 Claude CLI 进程
 *
 * 用法：
 *   npx tsx src/claude/proxy.ts <processName> <sessionId>
 *   node dist/claude/proxy.js <processName> <sessionId>
 */

import { spawn, ChildProcess, execSync } from 'child_process';
import * as net from 'net';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const processName = process.argv[2] || 'default';
const sessionId = process.argv[3] || 'default-session';

const pipePath = os.platform() === 'win32'
  ? `\\\\.\\pipe\\claude-bot-${processName}`
  : path.join(os.tmpdir(), `claude-bot-${processName}.sock`);

const pidFile = path.join(os.tmpdir(), `claude-proxy-${processName}.pid`);
const logFile = path.join(os.tmpdir(), `claude-proxy-${processName}.log`);

function log(msg: string) {
  const line = `[${new Date().toISOString()}] [proxy:${processName}] ${msg}\n`;
  try {
    fs.appendFileSync(logFile, line);
  } catch {
    // ignore write errors
  }
}

let claude: ChildProcess | null = null;
let currentClient: net.Socket | null = null;
let shuttingDown = false;

// 重启退避机制
const MAX_RESTART_RETRIES = 5;
const BASE_RESTART_DELAY = 3000; // 3s, 6s, 12s, 24s, 48s
let restartCount = 0;
let lastSuccessTime = 0;
// 检查 session 文件是否已存在（Claude CLI 用文件判断 session 是否 "in use"）
function sessionFileExists(): boolean {
  // Claude CLI 的 session 文件路径：~/.claude/projects/<projectDir>/<sessionId>.jsonl
  // projectDir 由 cwd 决定，格式为路径中的分隔符替换为 '-'
  const homeDir = os.homedir();
  const cwd = process.cwd().replace(/[:\\\/]/g, '-');
  const sessionFile = path.join(homeDir, '.claude', 'projects', cwd, `${sessionId}.jsonl`);
  const exists = fs.existsSync(sessionFile);
  log(`Session file check: ${sessionFile} → ${exists ? 'EXISTS (will use --resume)' : 'NOT FOUND (will use --session-id)'}`);
  return exists;
}

function startClaude() {
  if (shuttingDown) return;

  if (restartCount >= MAX_RESTART_RETRIES) {
    log(`Claude CLI failed ${MAX_RESTART_RETRIES} times consecutively, stopping auto-restart. Proxy stays alive for manual intervention.`);
    return;
  }

  const isWindows = os.platform() === 'win32';
  // 如果 session 文件已存在，用 --resume 恢复；否则用 --session-id 创建新 session
  const useResume = sessionFileExists();
  const sessionArgs = useResume
    ? ['--resume', sessionId]
    : ['--session-id', sessionId];
  const claudeArgs = [
    '-p', '--output-format', 'stream-json', '--input-format', 'stream-json',
    '--verbose', ...sessionArgs, '--dangerously-skip-permissions',
  ];

  log(`Starting Claude CLI: session=${sessionId} (attempt ${restartCount + 1}/${MAX_RESTART_RETRIES})`);

  if (isWindows) {
    const bashPath = 'C:\\Program Files\\Git\\usr\\bin\\bash.exe';
    if (fs.existsSync(bashPath)) {
      claude = spawn(bashPath, ['-c', `claude ${claudeArgs.join(' ')}`], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } else {
      claude = spawn('claude', claudeArgs, {
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: true,
        windowsHide: true,
      });
    }
  } else {
    claude = spawn('claude', claudeArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  }

  log(`Claude CLI started: PID=${claude.pid}`);

  claude.stdout?.on('data', (data: Buffer) => {
    if (currentClient && !currentClient.destroyed) {
      try {
        currentClient.write(data);
      } catch (e: any) {
        log(`Failed to write to client: ${e.message}`);
      }
    }
  });

  claude.stderr?.on('data', (data: Buffer) => {
    const content = data.toString();
    log(`stderr: ${content.substring(0, 500)}`);
  });

  claude.on('error', (err) => {
    log(`Claude CLI error: ${err.message}`);
  });

  claude.on('exit', (code) => {
    log(`Claude CLI exited: code=${code}`);

    // Notify connected client about the crash
    if (currentClient && !currentClient.destroyed) {
      const errorEvent = JSON.stringify({
        type: 'error',
        content: `Claude CLI process exited with code ${code}`,
      });
      try {
        currentClient.write(errorEvent + '\n');
      } catch { /* ignore */ }
    }

    claude = null;

    if (!shuttingDown) {
      const now = Date.now();
      // If the process ran for more than 60s, it was a "successful" run — reset retry count
      if (lastSuccessTime > 0 && (now - lastSuccessTime) > 60000) {
        restartCount = 0;
      }

      restartCount++;
      const delay = BASE_RESTART_DELAY * Math.pow(2, restartCount - 1);
      log(`Restarting Claude CLI in ${delay / 1000}s (retry ${restartCount}/${MAX_RESTART_RETRIES})...`);
      setTimeout(() => startClaude(), delay);
    }
  });

  // Track when CLI successfully starts receiving data (init event)
  const origOnData = claude.stdout?.listeners('data');
  const initWatcher = (data: Buffer) => {
    const text = data.toString();
    if (text.includes('"type":"system"') || text.includes('"subtype":"init"')) {
      lastSuccessTime = Date.now();
      restartCount = 0; // Successfully initialized, reset retry count
      log('Claude CLI initialized successfully, reset restart counter');
    }
  };
  claude.stdout?.on('data', initWatcher);
}

// Clean up stale Unix socket
if (os.platform() !== 'win32' && fs.existsSync(pipePath)) {
  try {
    fs.unlinkSync(pipePath);
  } catch { /* ignore */ }
}

const server = net.createServer((socket) => {
  log('Client connected');

  // Close previous client if any
  if (currentClient && !currentClient.destroyed) {
    log('Closing previous client connection');
    currentClient.destroy();
  }
  currentClient = socket;

  socket.on('data', (data) => {
    if (claude?.stdin && !claude.stdin.destroyed) {
      try {
        claude.stdin.write(data);
      } catch (e: any) {
        log(`Failed to write to Claude CLI stdin: ${e.message}`);
      }
    } else {
      log('Claude CLI stdin not available, dropping data');
    }
  });

  socket.on('close', () => {
    log('Client disconnected');
    if (currentClient === socket) {
      currentClient = null;
    }
  });

  socket.on('error', (err) => {
    log(`Client socket error: ${err.message}`);
    if (currentClient === socket) {
      currentClient = null;
    }
  });
});

server.on('error', (err) => {
  log(`Server error: ${err.message}`);
});

server.listen(pipePath, () => {
  log(`Proxy listening on: ${pipePath}`);
  try {
    fs.writeFileSync(pidFile, process.pid.toString());
  } catch (e: any) {
    log(`Failed to write PID file: ${e.message}`);
  }
});

// Start Claude CLI
startClaude();

// Graceful shutdown
function cleanup() {
  if (shuttingDown) return;
  shuttingDown = true;
  log('Proxy shutting down...');

  server.close();

  if (currentClient && !currentClient.destroyed) {
    currentClient.destroy();
  }

  if (claude && claude.pid) {
    if (os.platform() === 'win32') {
      // Windows: taskkill /T 杀掉整个进程树（bash → claude.exe）
      try {
        execSync(`taskkill /PID ${claude.pid} /T /F`, { timeout: 5000 });
        log(`Killed Claude CLI process tree: PID=${claude.pid}`);
      } catch (e: any) {
        log(`taskkill failed: ${e.message}`);
      }
    } else {
      claude.kill('SIGTERM');
      // Force kill after 3 seconds
      setTimeout(() => {
        if (claude) {
          claude.kill('SIGKILL');
        }
      }, 3000);
    }
  }

  try { fs.unlinkSync(pidFile); } catch { /* ignore */ }
  if (os.platform() !== 'win32') {
    try { fs.unlinkSync(pipePath); } catch { /* ignore */ }
  }

  setTimeout(() => process.exit(0), 4000);
}

process.on('SIGTERM', cleanup);
process.on('SIGINT', cleanup);

log(`Proxy started: PID=${process.pid}, processName=${processName}, sessionId=${sessionId}`);
