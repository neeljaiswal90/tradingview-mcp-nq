export const config = {
  CDP_HOST: process.env.TV_CDP_HOST ?? '127.0.0.1',
  CDP_PORT: Number(process.env.TV_CDP_PORT ?? 9222),
  MAX_RETRIES: Number(process.env.TV_MAX_RETRIES ?? 5),
  BASE_DELAY_MS: Number(process.env.TV_BASE_DELAY_MS ?? 500),
  EVAL_TIMEOUT_MS: Number(process.env.TV_EVAL_TIMEOUT_MS ?? 10000),
  LOG_LEVEL: (process.env.TV_LOG_LEVEL ?? 'info') as LogLevel,
  SCREENSHOT_DIR: process.env.TV_SCREENSHOT_DIR ?? './screenshots',
} as const;

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LOG_LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

export function isLevelEnabled(level: LogLevel): boolean {
  return LOG_LEVEL_ORDER[level] >= LOG_LEVEL_ORDER[config.LOG_LEVEL];
}
