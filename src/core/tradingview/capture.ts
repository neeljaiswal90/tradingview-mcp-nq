import { getClient, evaluate } from '../session/manager.js';
import { getChartCollection } from '../session/manager.js';
import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { config } from '../../config.js';

export async function captureScreenshot({
  region,
  filename,
  method,
}: {
  region?: string;
  filename?: string;
  method?: string;
} = {}) {
  mkdirSync(config.SCREENSHOT_DIR, { recursive: true });

  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const fname = (filename || `tv_${region}_${ts}`).replace(/[/\\]/g, '_');
  const filePath = join(config.SCREENSHOT_DIR, `${fname}.png`);

  if (method === 'api') {
    try {
      const colPath = await getChartCollection();
      await evaluate(`${colPath}.takeScreenshot()`);
      return {
        success: true, method: 'api' as const,
        note: 'takeScreenshot() triggered — TradingView will save/show the screenshot via its own UI',
      };
    } catch {
      // Fall through to CDP method
    }
  }

  const client = await getClient();
  let clip: { x: number; y: number; width: number; height: number; scale: number } | undefined;

  if (region === 'chart') {
    const bounds = await evaluate(`
      (function() {
        var el = document.querySelector('[data-name="pane-canvas"]')
          || document.querySelector('[class*="chart-container"]')
          || document.querySelector('canvas');
        if (!el) return null;
        var rect = el.getBoundingClientRect();
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      })()
    `) as { x: number; y: number; width: number; height: number } | null;
    if (bounds) clip = { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height, scale: 1 };
  } else if (region === 'strategy_tester') {
    const bounds = await evaluate(`
      (function() {
        var el = document.querySelector('[data-name="backtesting"]')
          || document.querySelector('[class*="strategyReport"]');
        if (!el) return null;
        var rect = el.getBoundingClientRect();
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      })()
    `) as { x: number; y: number; width: number; height: number } | null;
    if (bounds) clip = { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height, scale: 1 };
  }

  const params: { format: 'png'; clip?: typeof clip } = { format: 'png' };
  if (clip) params.clip = clip;

  const { data } = await client.Page.captureScreenshot(params) as { data: string };
  writeFileSync(filePath, Buffer.from(data, 'base64'));

  return {
    success: true, method: 'cdp' as const, file_path: filePath, region,
    size_bytes: Buffer.from(data, 'base64').length,
  };
}
