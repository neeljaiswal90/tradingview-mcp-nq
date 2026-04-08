import { getClient, evaluate } from '../session/manager.js';
import { config } from '../../config.js';

interface TabInfo {
  index: number;
  id: string;
  title: string;
  url: string;
  chart_id: string | null;
}

export async function list() {
  const resp = await fetch(`http://${config.CDP_HOST}:${config.CDP_PORT}/json/list`);
  const targets = await resp.json() as Array<{ type: string; url: string; title: string; id: string }>;

  const tabs: TabInfo[] = targets
    .filter(t => t.type === 'page' && /tradingview\.com\/chart/i.test(t.url))
    .map((t, i) => ({
      index: i,
      id: t.id,
      title: t.title.replace(/^Live stock.*charts on /, ''),
      url: t.url,
      chart_id: t.url.match(/\/chart\/([^/?]+)/)?.[1] || null,
    }));

  return { success: true, tab_count: tabs.length, tabs };
}

export async function newTab() {
  const c = await getClient();

  const isMac = process.platform === 'darwin';
  const mod = isMac ? 4 : 2;

  await c.Input.dispatchKeyEvent({
    type: 'keyDown',
    modifiers: mod,
    key: 't',
    code: 'KeyT',
    windowsVirtualKeyCode: 84,
  });
  await c.Input.dispatchKeyEvent({ type: 'keyUp', key: 't', code: 'KeyT' });

  await new Promise(r => setTimeout(r, 2000));

  const state = await list();
  return { action: 'new_tab_opened', ...state };
}

export async function closeTab() {
  const before = await list();
  if (before.tab_count <= 1) {
    throw new Error('Cannot close the last tab. Use tv_launch to restart TradingView instead.');
  }

  const c = await getClient();
  const isMac = process.platform === 'darwin';
  const mod = isMac ? 4 : 2;

  await c.Input.dispatchKeyEvent({
    type: 'keyDown',
    modifiers: mod,
    key: 'w',
    code: 'KeyW',
    windowsVirtualKeyCode: 87,
  });
  await c.Input.dispatchKeyEvent({ type: 'keyUp', key: 'w', code: 'KeyW' });

  await new Promise(r => setTimeout(r, 1000));

  const after = await list();
  return { success: true, action: 'tab_closed', tabs_before: before.tab_count, tabs_after: after.tab_count };
}

export async function switchTab({ index }: { index: number | string }) {
  const tabs = await list();
  const idx = Number(index);

  if (idx >= tabs.tab_count) {
    throw new Error(`Tab index ${idx} out of range (have ${tabs.tab_count} tabs)`);
  }

  const target = tabs.tabs[idx]!;

  try {
    const resp = await fetch(`http://${config.CDP_HOST}:${config.CDP_PORT}/json/activate/${target.id}`);
    const text = await resp.text();
    return { success: true, action: 'switched', index: idx, tab_id: target.id, chart_id: target.chart_id };
  } catch (e: unknown) {
    throw new Error(`Failed to activate tab ${idx}: ${(e as Error).message}`);
  }
}
