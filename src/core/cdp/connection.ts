import CDP from 'chrome-remote-interface';
import { config } from '../../config.js';
import { logger } from '../../logger.js';
import { type Result, ok, fail } from '../../result.js';
import { findChartTarget, type CDPTarget } from './targets.js';
import type { CDPClient } from './evaluate.js';

export interface CDPConnection {
  client: CDPClient;
  target: CDPTarget;
}

export async function connectToTradingView(): Promise<Result<CDPConnection>> {
  let lastError: Error | undefined;

  for (let attempt = 0; attempt < config.MAX_RETRIES; attempt++) {
    try {
      const target = await findChartTarget();
      if (!target) {
        throw new Error(
          'No TradingView chart target found. Is TradingView open with a chart?',
        );
      }

      const client = await CDP({
        host: config.CDP_HOST,
        port: config.CDP_PORT,
        target: target.id,
      }) as unknown as CDPClient;

      await client.Runtime.enable();
      await client.Page.enable();
      await client.DOM.enable();

      logger.debug('CDP connected', { target: target.url, attempt });
      return ok({ client, target });
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      const delay = Math.min(
        config.BASE_DELAY_MS * Math.pow(2, attempt),
        30000,
      );
      logger.debug('CDP connection attempt failed, retrying', {
        attempt,
        delay,
        error: lastError.message,
      });
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  return fail(
    'CDP_CONNECTION_FAILED',
    `CDP connection failed after ${config.MAX_RETRIES} attempts: ${lastError?.message}`,
    'Launch TradingView with --remote-debugging-port=9222',
  );
}

export async function disconnectClient(client: CDPClient): Promise<void> {
  try {
    await (client as unknown as { close(): Promise<void> }).close();
  } catch {
    // ignore close errors
  }
}
