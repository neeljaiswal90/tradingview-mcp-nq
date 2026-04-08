import { evaluate, evaluateAsync, getClient, getChartApi, getChartCollection } from '../session/manager.js';
import { safeString } from '../cdp/evaluate.js';
import { config } from '../../config.js';
import { waitForChartReady } from './wait.js';
import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';

export async function batchRun({ symbols, timeframes, action, delay_ms, ohlcv_count }: {
  symbols: string[];
  timeframes?: string[] | null;
  action: string;
  delay_ms?: number;
  ohlcv_count?: number;
}) {
  const tfs = timeframes && timeframes.length > 0 ? timeframes : [null];
  const delay = delay_ms || 2000;
  const results: Array<{ symbol: string; timeframe: string | null; success: boolean; result?: unknown; error?: string }> = [];

  let colPath: string | undefined;
  let apiPath: string | undefined;
  try { colPath = await getChartCollection(); } catch {}
  try { apiPath = await getChartApi(); } catch {}

  for (const symbol of symbols) {
    for (const tf of tfs) {
      const combo = { symbol, timeframe: tf };
      try {
        if (colPath) await evaluate(`${colPath}.setSymbol(${safeString(symbol)})`);
        else if (apiPath) await evaluate(`${apiPath}.setSymbol(${safeString(symbol)})`);

        if (tf) {
          if (colPath) await evaluate(`${colPath}.setResolution(${safeString(tf)})`);
          else if (apiPath) await evaluate(`${apiPath}.setResolution(${safeString(tf)})`);
        }

        await waitForChartReady(symbol);
        await new Promise(r => setTimeout(r, delay));

        let actionResult: unknown;
        if (action === 'screenshot') {
          mkdirSync(config.SCREENSHOT_DIR, { recursive: true });
          const client = await getClient();
          const { data } = await client.Page.captureScreenshot({ format: 'png' });
          const ts = new Date().toISOString().replace(/[:.]/g, '-');
          const fname = `batch_${symbol}_${tf || 'default'}_${ts}`.replace(/[\/\\]/g, '_') + '.png';
          const filePath = join(config.SCREENSHOT_DIR, fname);
          writeFileSync(filePath, Buffer.from(data, 'base64'));
          actionResult = { file_path: filePath };
        } else if (action === 'get_ohlcv' && apiPath) {
          const limit = Math.min(ohlcv_count || 100, 500);
          actionResult = await evaluateAsync(`
            new Promise(function(resolve, reject) {
              ${apiPath}.exportData({ includeTime: true, includeSeries: true, includeStudies: false })
                .then(function(result) {
                  var bars = (result.data || []).slice(-${limit});
                  resolve({ bar_count: bars.length, last_bar: bars[bars.length - 1] || null });
                }).catch(reject);
            })
          `);
        } else if (action === 'get_strategy_results') {
          await new Promise(r => setTimeout(r, 1000));
          actionResult = await evaluate(`
            (function() {
              var metrics = {};
              var panel = document.querySelector('[data-name="backtesting"]') || document.querySelector('[class*="strategyReport"]');
              if (!panel) return { error: 'Strategy Tester not found' };
              var items = panel.querySelectorAll('[class*="reportItem"], [class*="metric"]');
              items.forEach(function(item) {
                var label = item.querySelector('[class*="label"]');
                var value = item.querySelector('[class*="value"]');
                if (label && value) metrics[label.textContent.trim()] = value.textContent.trim();
              });
              return { metric_count: Object.keys(metrics).length, metrics: metrics };
            })()
          `);
        } else {
          actionResult = { error: 'Unknown action or API not available: ' + action };
        }
        results.push({ ...combo, success: true, result: actionResult });
      } catch (err: unknown) {
        results.push({ ...combo, success: false, error: (err as Error).message });
      }
    }
  }

  const successCount = results.filter(r => r.success).length;
  return { success: true, total_iterations: results.length, successful: successCount, failed: results.length - successCount, results };
}
