import { existsSync, readFileSync } from 'fs';
import type { ExecutionMode, RestartMode } from './types.js';
import { pickDefaultSymbol } from './contracts.js';

/**
 * Load a .env file into process.env (only sets vars that are not already set).
 * No external dependency — simple key=value parser, ignores comments and blanks.
 */
function loadDotEnv(path: string = '.env'): void {
  try {
    if (!existsSync(path)) return;
    const raw = readFileSync(path, 'utf8');
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx < 0) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      let value = trimmed.slice(eqIdx + 1).trim();
      // Strip surrounding quotes if present
      if ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      // Only set if not already in the environment (env vars win over .env file)
      if (process.env[key] === undefined) {
        process.env[key] = value;
      }
    }
  } catch {
    // Non-fatal — .env loading failure should never crash the app
  }
}

/**
 * Operational / runtime environment settings.
 *
 * IMPORTANT — Config Precedence Rule:
 *   Strategy, risk, and trading parameters (account_equity, max_risk_per_trade_pct,
 *   max_daily_loss_pct, max_consecutive_losses, time_stop_minutes,
 *   analysis_interval_seconds, etc.) are owned EXCLUSIVELY by indicator-config.json
 *   and loaded via IndicatorConfigManager.
 *
 *   This interface and loadEnv() are for operational / runtime wiring only:
 *   mode, symbol, logging, adapter selection.
 *
 *   See IndicatorConfigManager for all trading parameter ownership.
 */
export interface AutotradeEnv {
  MODE: ExecutionMode;
  LIVE_TRADING_ENABLED: boolean;
  SYMBOL: string;
  LOG_DIR: string;
  EXECUTION_ADAPTER: string;
  STRATEGY_VERSION: string;
  RESTART_MODE: RestartMode;
  RUNTIME_HEARTBEAT_INTERVAL_MS: number;
  RUNTIME_HEARTBEAT_STALE_MS: number;
}

export function loadEnv(): AutotradeEnv {
  // Load .env file into process.env (env vars already set take precedence)
  loadDotEnv();

  const rawMode = process.env['MODE'] ?? 'paper';
  const liveEnabled = process.env['LIVE_TRADING_ENABLED'] === 'true';

  // Resolve execution mode: live requires explicit LIVE_TRADING_ENABLED=true
  let mode: ExecutionMode;
  if (rawMode === 'live' && liveEnabled) {
    mode = 'live';
  } else if (rawMode === 'signal_only') {
    mode = 'signal_only';
  } else {
    mode = 'paper';
    if (rawMode === 'live' && !liveEnabled) {
      console.warn('[ENV] MODE=live but LIVE_TRADING_ENABLED is not true — falling back to paper');
    }
  }

  // ── Warn about deprecated env vars that have moved to indicator-config.json ──
  warnDeprecatedTradingEnvVars();

  const restartMode = (process.env['RESTART_MODE'] ?? 'dev') as RestartMode;
  if (restartMode !== 'dev' && restartMode !== 'prod') {
    console.warn(`[ENV] Invalid RESTART_MODE="${restartMode}", falling back to "dev".`);
  }

  return {
    MODE: mode,
    LIVE_TRADING_ENABLED: liveEnabled,
    SYMBOL: process.env['SYMBOL'] ?? pickDefaultSymbol(),
    LOG_DIR: process.env['LOG_DIR'] ?? './logs',
    EXECUTION_ADAPTER: process.env['EXECUTION_ADAPTER'] ?? 'none',
    STRATEGY_VERSION: 'STRAT_v1.0',
    RESTART_MODE: (restartMode === 'dev' || restartMode === 'prod') ? restartMode : 'dev',
    RUNTIME_HEARTBEAT_INTERVAL_MS: parseInt(process.env['RUNTIME_HEARTBEAT_INTERVAL_MS'] ?? '10000', 10),
    RUNTIME_HEARTBEAT_STALE_MS: parseInt(process.env['RUNTIME_HEARTBEAT_STALE_MS'] ?? '40000', 10),
  };
}

/**
 * Env vars that formerly controlled trading/risk parameters. These are now
 * owned by indicator-config.json. If a user still has them set, we warn
 * loudly so they know to migrate.
 */
const DEPRECATED_TRADING_ENV_VARS = [
  'MAX_RISK_PCT',
  'MAX_DAILY_LOSS_PCT',
  'MAX_CONSECUTIVE_LOSSES',
  'ACCOUNT_EQUITY',
  'TIME_STOP_MINUTES',
  'ANALYSIS_INTERVAL_SECONDS',
] as const;

function warnDeprecatedTradingEnvVars(): void {
  const found: string[] = [];
  for (const key of DEPRECATED_TRADING_ENV_VARS) {
    if (process.env[key] !== undefined) {
      found.push(key);
    }
  }
  if (found.length > 0) {
    console.warn(
      `[ENV] ⚠️  Deprecated: the following env vars no longer control trading behavior:\n` +
      `       ${found.join(', ')}\n` +
      `       These parameters are now owned exclusively by indicator-config.json.\n` +
      `       Remove them from .env to silence this warning.`,
    );
  }
}

export function printEnv(env: AutotradeEnv): void {
  console.log('┌─ Environment (operational) ──────────────────────────');
  console.log(`│  MODE:                ${env.MODE.toUpperCase()}`);
  console.log(`│  LIVE_ENABLED:        ${env.LIVE_TRADING_ENABLED}`);
  console.log(`│  SYMBOL:              ${env.SYMBOL}`);
  console.log(`│  LOG_DIR:             ${env.LOG_DIR}`);
  console.log(`│  EXECUTION_ADAPTER:   ${env.EXECUTION_ADAPTER}`);
  console.log(`│  RESTART_MODE:        ${env.RESTART_MODE}`);
  console.log(`│  HEARTBEAT_INTERVAL:  ${env.RUNTIME_HEARTBEAT_INTERVAL_MS}ms`);
  console.log(`│  HEARTBEAT_STALE:     ${env.RUNTIME_HEARTBEAT_STALE_MS}ms`);
  console.log('└──────────────────────────────────────────────────────');
}
