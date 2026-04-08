import { connectToTradingView, disconnectClient } from '../cdp/connection.js';
import { evaluate as cdpEvaluate, evaluateAsync as cdpEvaluateAsync, type CDPClient, type EvaluateOpts } from '../cdp/evaluate.js';
import { KNOWN_PATHS } from '../tradingview/known-paths.js';
import { logger } from '../../logger.js';
import { unwrap } from '../../result.js';
import type { CDPTarget } from '../cdp/targets.js';

let _client: CDPClient | null = null;
let _targetInfo: CDPTarget | null = null;

async function ensureConnected(): Promise<CDPClient> {
  if (_client) {
    try {
      await _client.Runtime.evaluate({ expression: '1', returnByValue: true });
      return _client;
    } catch {
      logger.warn('CDP liveness probe failed, reconnecting');
      _client = null;
      _targetInfo = null;
    }
  }
  const result = await connectToTradingView();
  const conn = unwrap(result);
  _client = conn.client;
  _targetInfo = conn.target;
  return _client;
}

export async function getClient(): Promise<CDPClient> {
  return ensureConnected();
}

export async function getTargetInfo(): Promise<CDPTarget> {
  if (!_targetInfo) {
    await ensureConnected();
  }
  return _targetInfo!;
}

export async function evaluate(expression: string, opts: EvaluateOpts = {}): Promise<unknown> {
  const client = await getClient();
  return cdpEvaluate(client, expression, opts);
}

export async function evaluateAsync(expression: string): Promise<unknown> {
  const client = await getClient();
  return cdpEvaluateAsync(client, expression);
}

export function invalidate(): void {
  _client = null;
  _targetInfo = null;
}

export async function disconnect(): Promise<void> {
  if (_client) {
    await disconnectClient(_client);
    _client = null;
    _targetInfo = null;
  }
}

async function verifyAndReturn(path: string, name: string): Promise<string> {
  const exists = await evaluate(`typeof (${path}) !== 'undefined' && (${path}) !== null`);
  if (!exists) {
    throw new Error(`${name} not available at ${path}`);
  }
  return path;
}

export async function getChartApi(): Promise<string> {
  return verifyAndReturn(KNOWN_PATHS.chartApi, 'Chart API');
}

export async function getChartCollection(): Promise<string> {
  return verifyAndReturn(KNOWN_PATHS.chartWidgetCollection, 'Chart Widget Collection');
}

export async function getBottomBar(): Promise<string> {
  return verifyAndReturn(KNOWN_PATHS.bottomWidgetBar, 'Bottom Widget Bar');
}

export async function getReplayApi(): Promise<string> {
  return verifyAndReturn(KNOWN_PATHS.replayApi, 'Replay API');
}

export async function getMainSeriesBars(): Promise<string> {
  return verifyAndReturn(KNOWN_PATHS.mainSeriesBars, 'Main Series Bars');
}
