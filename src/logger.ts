type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

const LOG_LEVELS: Record<LogLevel, number> = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
};

const currentLevel: LogLevel = 'DEBUG';

const LOG_DIR = 'logs';
const LOG_FILE = `${LOG_DIR}/bot_${new Date().toISOString().slice(0, 10)}.log`;

// 确保日志目录存在
import * as fs from 'fs';
if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

// 写入日志文件
function writeLog(content: string): void {
  fs.appendFileSync(LOG_FILE, content + '\n');
}

function formatTimestamp(): string {
  return new Date().toISOString();
}

function log(level: LogLevel, prefix: string, message: string, data?: any): void {
  if (LOG_LEVELS[level] < LOG_LEVELS[currentLevel]) return;

  const timestamp = formatTimestamp();
  const prefix_str = `[${timestamp}] [${level}] [${prefix}]`;

  let logLine: string;
  if (data !== undefined) {
    logLine = `${prefix_str} ${message} ${JSON.stringify(data)}`;
  } else {
    logLine = `${prefix_str} ${message}`;
  }

  console.log(logLine);
  writeLog(logLine);
}

export const logger = {
  debug: (prefix: string, message: string, data?: any) => log('DEBUG', prefix, message, data),
  info: (prefix: string, message: string, data?: any) => log('INFO', prefix, message, data),
  warn: (prefix: string, message: string, data?: any) => log('WARN', prefix, message, data),
  error: (prefix: string, message: string, data?: any) => log('ERROR', prefix, message, data),
};
