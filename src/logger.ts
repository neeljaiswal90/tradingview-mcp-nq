import { config, isLevelEnabled, type LogLevel } from './config.js';

function write(level: LogLevel, msg: string, data?: Record<string, unknown>): void {
  if (!isLevelEnabled(level)) return;
  const ts = new Date().toISOString();
  const entry = data
    ? JSON.stringify({ ts, level, msg, ...data })
    : `${ts} [${level.toUpperCase()}] ${msg}`;
  process.stderr.write(entry + '\n');
}

export const logger = {
  debug: (msg: string, data?: Record<string, unknown>) => write('debug', msg, data),
  info: (msg: string, data?: Record<string, unknown>) => write('info', msg, data),
  warn: (msg: string, data?: Record<string, unknown>) => write('warn', msg, data),
  error: (msg: string, data?: Record<string, unknown>) => write('error', msg, data),
  level: config.LOG_LEVEL,
};
