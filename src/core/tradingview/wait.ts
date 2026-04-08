import { evaluate } from '../session/manager.js';

const DEFAULT_TIMEOUT = 10000;
const POLL_INTERVAL = 200;

interface ChartReadyState {
  isLoading: boolean;
  barCount: number;
  currentSymbol: string;
}

export async function waitForChartReady(
  expectedSymbol: string | null = null,
  expectedTf: string | null = null,
  timeout: number = DEFAULT_TIMEOUT,
): Promise<boolean> {
  const start = Date.now();
  let lastBarCount = -1;
  let stableCount = 0;

  while (Date.now() - start < timeout) {
    const state = await evaluate(`
      (function() {
        // Check for loading spinner
        var spinner = document.querySelector('[class*="loader"]')
          || document.querySelector('[class*="loading"]')
          || document.querySelector('[data-name="loading"]');
        var isLoading = spinner && spinner.offsetParent !== null;

        // Try to get bar count from data window or chart
        var barCount = -1;
        try {
          var bars = document.querySelectorAll('[class*="bar"]');
          barCount = bars.length;
        } catch {}

        // Get current symbol from header
        var symbolEl = document.querySelector('[data-name="legend-source-title"]')
          || document.querySelector('[class*="title"] [class*="apply-common-tooltip"]');
        var currentSymbol = symbolEl ? symbolEl.textContent.trim() : '';

        return { isLoading: !!isLoading, barCount: barCount, currentSymbol: currentSymbol };
      })()
    `) as ChartReadyState | null;

    if (!state) {
      await new Promise(r => setTimeout(r, POLL_INTERVAL));
      continue;
    }

    if (state.isLoading) {
      stableCount = 0;
      await new Promise(r => setTimeout(r, POLL_INTERVAL));
      continue;
    }

    if (expectedSymbol && state.currentSymbol && !state.currentSymbol.toUpperCase().includes(expectedSymbol.toUpperCase())) {
      stableCount = 0;
      await new Promise(r => setTimeout(r, POLL_INTERVAL));
      continue;
    }

    if (state.barCount === lastBarCount && state.barCount > 0) {
      stableCount++;
    } else {
      stableCount = 0;
    }
    lastBarCount = state.barCount;

    if (stableCount >= 2) {
      return true;
    }

    await new Promise(r => setTimeout(r, POLL_INTERVAL));
  }

  return false;
}
