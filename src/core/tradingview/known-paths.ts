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
