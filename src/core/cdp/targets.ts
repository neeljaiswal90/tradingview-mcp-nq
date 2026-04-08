import { config } from '../../config.js';
import { logger } from '../../logger.js';

export interface CDPTarget {
  id: string;
  type: string;
  title: string;
  url: string;
  description: string;
  devtoolsFrontendUrl?: string;
  webSocketDebuggerUrl?: string;
}

export async function discoverTargets(): Promise<CDPTarget[]> {
  const url = `http://${config.CDP_HOST}:${config.CDP_PORT}/json/list`;
  const resp = await fetch(url);
  return resp.json() as Promise<CDPTarget[]>;
}

export async function findChartTarget(): Promise<CDPTarget | null> {
  const targets = await discoverTargets();
  const chartTarget = targets.find(
    (t) => t.type === 'page' && /tradingview\.com\/chart/i.test(t.url),
  );
  if (chartTarget) return chartTarget;

  const tvTarget = targets.find(
    (t) => t.type === 'page' && /tradingview/i.test(t.url),
  );
  return tvTarget ?? null;
}
