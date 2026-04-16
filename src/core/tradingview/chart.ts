import { evaluate as _evaluate, evaluateAsync as _evaluateAsync } from '../session/manager.js';
import { safeString, requireFinite } from '../cdp/evaluate.js';
import { waitForChartReady as _waitForChartReady } from './wait.js';
import { KNOWN_PATHS } from './known-paths.js';
import { tvUiLock } from './tv-ui-lock.js';

const CHART_API = 'window.TradingViewApi._activeChartWidgetWV.value()';

interface Deps {
  evaluate?: typeof _evaluate;
  evaluateAsync?: typeof _evaluateAsync;
  waitForChartReady?: typeof _waitForChartReady;
}

function _resolve(deps?: Deps) {
  return {
    evaluate: deps?.evaluate ?? _evaluate,
    evaluateAsync: deps?.evaluateAsync ?? _evaluateAsync,
    waitForChartReady: deps?.waitForChartReady ?? _waitForChartReady,
  };
}

export async function getState({ _deps }: { _deps?: Deps } = {}) {
  const { evaluate } = _resolve(_deps);
  const state = await evaluate(`
    (function() {
      var chart = ${CHART_API};
      var studies = [];
      try {
        var allStudies = chart.getAllStudies();
        studies = allStudies.map(function(s) {
          return { id: s.id, name: s.name || s.title || 'unknown' };
        });
      } catch(e) {}
      return {
        symbol: chart.symbol(),
        resolution: chart.resolution(),
        chartType: chart.chartType(),
        studies: studies,
      };
    })()
  `) as Record<string, unknown>;
  return { success: true, ...state };
}

export async function setSymbol({ symbol, _deps }: { symbol: string; _deps?: Deps }) {
  const { evaluateAsync, waitForChartReady } = _resolve(_deps);
  await evaluateAsync(`
    (function() {
      var chart = ${CHART_API};
      return new Promise(function(resolve) {
        chart.setSymbol(${safeString(symbol)}, {});
        setTimeout(resolve, 500);
      });
    })()
  `);
  const ready = await waitForChartReady(symbol);
  return { success: true, symbol, chart_ready: ready };
}

export async function setTimeframe({ timeframe, paneIndex, _deps }: { timeframe: string; paneIndex?: number; _deps?: Deps }) {
  const { evaluate, waitForChartReady } = _resolve(_deps);
  const diag = process.env.COLLECT_DIAG === '1';

  if (paneIndex != null) {
    // Multi-pane: focus the target pane under the cross-process lock, then
    // call setResolution on the (now-active) chart API wrapper.
    return tvUiLock.runExclusive(async () => {
      const CWC = KNOWN_PATHS.chartWidgetCollection;
      const tFocus = diag ? Date.now() : 0;
      // Focus pane by clicking its main div
      await evaluate(`
        (function() {
          var cwc = ${CWC};
          var all = cwc.getAll();
          if (${paneIndex} < all.length && all[${paneIndex}]._mainDiv) {
            all[${paneIndex}]._mainDiv.click();
          }
        })()
      `);
      await new Promise(r => setTimeout(r, 200));

      // Verify focus landed on the correct pane
      const activeIdx = await evaluate(`
        (function() {
          var cwc = ${CWC};
          var all = cwc.getAll();
          var active = window.TradingViewApi._activeChartWidgetWV.value();
          for (var j = 0; j < all.length; j++) {
            try { if (active._chartWidget && all[j] === active._chartWidget) return j; } catch(e) {}
          }
          return -1;
        })()
      `) as number;

      if (activeIdx !== paneIndex) {
        throw new Error(
          `[setTimeframe] Focus verification failed: expected pane ${paneIndex}, got ${activeIdx}`,
        );
      }
      const focusMs = diag ? Date.now() - tFocus : 0;

      // Now set resolution on the active (verified) pane
      const tSetRes = diag ? Date.now() : 0;
      await evaluate(`
        (function() {
          var chart = ${CHART_API};
          chart.setResolution(${safeString(timeframe)}, {});
        })()
      `);
      const setResMs = diag ? Date.now() - tSetRes : 0;
      const tWait = diag ? Date.now() : 0;
      const ready = await waitForChartReady(null, timeframe);
      const waitReadyMs = diag ? Date.now() - tWait : 0;
      if (diag) {
        console.debug(
          `[CHART-TIMING] tf=${timeframe} pane=${paneIndex} focus=${focusMs}ms setRes=${setResMs}ms waitReady=${waitReadyMs}ms ready=${ready}`,
        );
      }
      return { success: true, timeframe, paneIndex, chart_ready: ready };
    });
  }

  // Single-pane (original path): no lock needed
  const tSetRes = diag ? Date.now() : 0;
  await evaluate(`
    (function() {
      var chart = ${CHART_API};
      chart.setResolution(${safeString(timeframe)}, {});
    })()
  `);
  const setResMs = diag ? Date.now() - tSetRes : 0;
  const tWait = diag ? Date.now() : 0;
  const ready = await waitForChartReady(null, timeframe);
  const waitReadyMs = diag ? Date.now() - tWait : 0;
  if (diag) {
    console.debug(
      `[CHART-TIMING] tf=${timeframe} pane=none setRes=${setResMs}ms waitReady=${waitReadyMs}ms ready=${ready}`,
    );
  }
  return { success: true, timeframe, chart_ready: ready };
}

export async function setType({ chart_type, _deps }: { chart_type: string; _deps?: Deps }) {
  const { evaluate } = _resolve(_deps);
  const typeMap: Record<string, number> = {
    'Bars': 0, 'Candles': 1, 'Line': 2, 'Area': 3,
    'Renko': 4, 'Kagi': 5, 'PointAndFigure': 6, 'LineBreak': 7,
    'HeikinAshi': 8, 'HollowCandles': 9,
  };
  const typeNum = typeMap[chart_type] ?? Number(chart_type);
  if (isNaN(typeNum) || typeNum < 0 || typeNum > 9 || !Number.isInteger(typeNum)) {
    throw new Error(`Unknown chart type: ${chart_type}. Use a name (Candles, Line, etc.) or number (0-9).`);
  }
  await evaluate(`
    (function() {
      var chart = ${CHART_API};
      chart.setChartType(${typeNum});
    })()
  `);
  return { success: true, chart_type, type_num: typeNum };
}

export async function manageIndicator({
  action,
  indicator,
  entity_id,
  inputs: inputsRaw,
  _deps,
}: {
  action: string;
  indicator?: string;
  entity_id?: string;
  inputs?: string | Record<string, unknown>;
  _deps?: Deps;
}) {
  const { evaluate } = _resolve(_deps);
  const inputs = inputsRaw
    ? (typeof inputsRaw === 'string' ? JSON.parse(inputsRaw) as Record<string, unknown> : inputsRaw)
    : undefined;

  if (action === 'add') {
    const inputArr = inputs ? Object.entries(inputs).map(([k, v]) => ({ id: k, value: v })) : [];
    const before = await evaluate(`${CHART_API}.getAllStudies().map(function(s) { return s.id; })`) as string[] | null;
    await evaluate(`
      (function() {
        var chart = ${CHART_API};
        chart.createStudy(${safeString(indicator!)}, false, false, ${JSON.stringify(inputArr)});
      })()
    `);
    await new Promise(r => setTimeout(r, 1500));
    const after = await evaluate(`${CHART_API}.getAllStudies().map(function(s) { return s.id; })`) as string[] | null;
    const newIds = (after || []).filter(id => !(before || []).includes(id));
    return { success: newIds.length > 0, action: 'add', indicator, entity_id: newIds[0] || null, new_study_count: newIds.length };
  } else if (action === 'remove') {
    if (!entity_id) throw new Error('entity_id required for remove action. Use chart_get_state to find study IDs.');
    await evaluate(`
      (function() {
        var chart = ${CHART_API};
        chart.removeEntity(${safeString(entity_id)});
      })()
    `);
    return { success: true, action: 'remove', entity_id };
  } else {
    throw new Error('action must be "add" or "remove"');
  }
}

export async function getVisibleRange({ _deps }: { _deps?: Deps } = {}) {
  const { evaluate } = _resolve(_deps);
  const result = await evaluate(`
    (function() {
      var chart = ${CHART_API};
      return { visible_range: chart.getVisibleRange(), bars_range: chart.getVisibleBarsRange() };
    })()
  `) as Record<string, unknown>;
  return { success: true, visible_range: result.visible_range, bars_range: result.bars_range };
}

export async function setVisibleRange({ from, to, _deps }: { from: number | string; to: number | string; _deps?: Deps }) {
  const { evaluate } = _resolve(_deps);
  const f = requireFinite(from, 'from');
  const t = requireFinite(to, 'to');
  await evaluate(`
    (function() {
      var chart = ${CHART_API};
      var m = chart._chartWidget.model();
      var ts = m.timeScale();
      var bars = m.mainSeries().bars();
      var startIdx = bars.firstIndex();
      var endIdx = bars.lastIndex();
      var fromIdx = startIdx, toIdx = endIdx;
      for (var i = startIdx; i <= endIdx; i++) {
        var v = bars.valueAt(i);
        if (v && v[0] >= ${f} && fromIdx === startIdx) fromIdx = i;
        if (v && v[0] <= ${t}) toIdx = i;
      }
      ts.zoomToBarsRange(fromIdx, toIdx);
    })()
  `);
  await new Promise(r => setTimeout(r, 500));
  const actual = await evaluate(`
    (function() {
      var chart = ${CHART_API};
      try { var r = chart.getVisibleRange(); return { from: r.from || 0, to: r.to || 0 }; }
      catch(e) { return { from: 0, to: 0, error: e.message }; }
    })()
  `) as Record<string, unknown> | null;
  return { success: true, requested: { from, to }, actual: actual || { from: 0, to: 0 } };
}

export async function scrollToDate({ date, _deps }: { date: string; _deps?: Deps }) {
  const { evaluate } = _resolve(_deps);
  let timestamp: number;
  if (/^\d+$/.test(date)) timestamp = Number(date);
  else timestamp = Math.floor(new Date(date).getTime() / 1000);
  if (isNaN(timestamp)) throw new Error(`Could not parse date: ${date}. Use ISO format (2024-01-15) or unix timestamp.`);

  const resolution = await evaluate(`${CHART_API}.resolution()`) as string;
  let secsPerBar = 60;
  const res = String(resolution);
  if (res === 'D' || res === '1D') secsPerBar = 86400;
  else if (res === 'W' || res === '1W') secsPerBar = 604800;
  else if (res === 'M' || res === '1M') secsPerBar = 2592000;
  else { const mins = parseInt(res, 10); if (!isNaN(mins)) secsPerBar = mins * 60; }

  const halfWindow = 25 * secsPerBar;
  const from = timestamp - halfWindow;
  const to = timestamp + halfWindow;

  await evaluate(`
    (function() {
      var chart = ${CHART_API};
      var m = chart._chartWidget.model();
      var ts = m.timeScale();
      var bars = m.mainSeries().bars();
      var startIdx = bars.firstIndex();
      var endIdx = bars.lastIndex();
      var fromIdx = startIdx, toIdx = endIdx;
      for (var i = startIdx; i <= endIdx; i++) {
        var v = bars.valueAt(i);
        if (v && v[0] >= ${from} && fromIdx === startIdx) fromIdx = i;
        if (v && v[0] <= ${to}) toIdx = i;
      }
      ts.zoomToBarsRange(fromIdx, toIdx);
    })()
  `);
  await new Promise(r => setTimeout(r, 500));
  return { success: true, date, centered_on: timestamp, resolution, window: { from, to } };
}

export async function symbolInfo({ _deps }: { _deps?: Deps } = {}) {
  const { evaluate } = _resolve(_deps);
  const result = await evaluate(`
    (function() {
      var chart = ${CHART_API};
      var info = chart.symbolExt();
      return {
        symbol: info.symbol, full_name: info.full_name, exchange: info.exchange,
        description: info.description, type: info.type, pro_name: info.pro_name,
        typespecs: info.typespecs, resolution: chart.resolution(), chart_type: chart.chartType()
      };
    })()
  `) as Record<string, unknown>;
  return { success: true, ...result };
}

export async function symbolSearch({ query, type }: { query: string; type?: string }) {
  const params = new URLSearchParams({
    text: query,
    hl: '1',
    exchange: '',
    lang: 'en',
    search_type: type || '',
    domain: 'production',
  });

  const resp = await fetch(`https://symbol-search.tradingview.com/symbol_search/v3/?${params}`, {
    headers: { 'Origin': 'https://www.tradingview.com', 'Referer': 'https://www.tradingview.com/' },
  });
  if (!resp.ok) throw new Error(`Symbol search API returned ${resp.status}`);
  const data = await resp.json() as Record<string, unknown>;

  const strip = (s: string | undefined) => (s || '').replace(/<\/?em>/g, '');
  const symbols = (data.symbols || data || []) as Array<Record<string, string>>;
  const results = symbols.slice(0, 15).map(r => ({
    symbol: strip(r.symbol),
    description: strip(r.description),
    exchange: r.exchange || r.prefix || '',
    type: r.type || '',
    full_name: r.exchange ? `${r.exchange}:${strip(r.symbol)}` : strip(r.symbol),
  }));

  return { success: true, query, source: 'rest_api', results, count: results.length };
}
