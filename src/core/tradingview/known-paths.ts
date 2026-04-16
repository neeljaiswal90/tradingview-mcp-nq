export const KNOWN_PATHS = {
  chartApi: 'window.TradingViewApi._activeChartWidgetWV.value()',
  chartWidgetCollection: 'window.TradingViewApi._chartWidgetCollection',
  bottomWidgetBar: 'window.TradingView.bottomWidgetBar',
  replayApi: 'window.TradingViewApi._replayApi',
  alertService: 'window.TradingViewApi._alertService',
  chartApiInstance: 'window.ChartApiInstance',
  mainSeriesBars: 'window.TradingViewApi._activeChartWidgetWV.value()._chartWidget.model().mainSeries().bars()',
  strategyStudy: 'chart._chartWidget.model().model().dataSources()',
  layoutManager: 'window.TradingViewApi.getSavedCharts',
  symbolSearchApi: 'window.TradingViewApi.searchSymbols',
  pineFacadeApi: 'https://pine-facade.tradingview.com/pine-facade',
} as const;

/**
 * Resolve JS expression paths for a specific pane index.
 *
 * When `paneIndex` is undefined/null, returns the default active-chart paths
 * (backward compatible with single-pane mode).
 *
 * When set, returns paths that access `cwc.getAll()[N]` directly — no pane
 * focus required, safe for concurrent multi-runner reads.
 *
 * Note: `cwc.getAll()[N]` returns the raw `_chartWidget` object, which is the
 * same object accessed via `_activeChartWidgetWV.value()._chartWidget`.
 */
export function resolvePanePaths(paneIndex?: number | null) {
  if (paneIndex == null) {
    const api = KNOWN_PATHS.chartApi;
    const cw = `${api}._chartWidget`;
    return {
      chartWidget: cw,
      model: `${cw}.model()`,
      bars: KNOWN_PATHS.mainSeriesBars,
      mainSeries: `${cw}.model().mainSeries()`,
      symbol: `${cw}.model().mainSeries().symbol()`,
    };
  }
  const cwc = KNOWN_PATHS.chartWidgetCollection;
  const base = `${cwc}.getAll()[${paneIndex}]`;
  return {
    chartWidget: base,
    model: `${base}.model()`,
    bars: `${base}.model().mainSeries().bars()`,
    mainSeries: `${base}.model().mainSeries()`,
    symbol: `${base}.model().mainSeries().symbol()`,
  };
}
