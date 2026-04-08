import { register } from '../router.js';
import * as core from '../../core/tradingview/stream.js';

register('stream', {
  description: 'Monitor your local TradingView chart for changes (JSONL output)',
  subcommands: new Map([
    ['quote', {
      description: 'Stream real-time price ticks (OHLCV per bar)',
      options: {
        interval: { type: 'string', short: 'i', description: 'Poll interval in ms (default 300)' },
      },
      handler: async (opts: Record<string, unknown>) => {
        await core.streamQuote({ interval: opts.interval ? Number(opts.interval) : undefined });
        process.exit(0);
      },
    }],
    ['bars', {
      description: 'Stream last bar updates (emits on new bar or price change)',
      options: {
        interval: { type: 'string', short: 'i', description: 'Poll interval in ms (default 500)' },
      },
      handler: async (opts: Record<string, unknown>) => {
        await core.streamBars({ interval: opts.interval ? Number(opts.interval) : undefined });
        process.exit(0);
      },
    }],
    ['values', {
      description: 'Stream indicator values (RSI, MACD, etc.)',
      options: {
        interval: { type: 'string', short: 'i', description: 'Poll interval in ms (default 500)' },
      },
      handler: async (opts: Record<string, unknown>) => {
        await core.streamValues({ interval: opts.interval ? Number(opts.interval) : undefined });
        process.exit(0);
      },
    }],
    ['lines', {
      description: 'Stream Pine Script line.new() price levels',
      options: {
        filter: { type: 'string', short: 'f', description: 'Filter by study name' },
        interval: { type: 'string', short: 'i', description: 'Poll interval in ms (default 1000)' },
      },
      handler: async (opts: Record<string, unknown>) => {
        await core.streamLines({ interval: opts.interval ? Number(opts.interval) : undefined, filter: opts.filter as string | undefined });
        process.exit(0);
      },
    }],
    ['labels', {
      description: 'Stream Pine Script label.new() annotations',
      options: {
        filter: { type: 'string', short: 'f', description: 'Filter by study name' },
        interval: { type: 'string', short: 'i', description: 'Poll interval in ms (default 1000)' },
      },
      handler: async (opts: Record<string, unknown>) => {
        await core.streamLabels({ interval: opts.interval ? Number(opts.interval) : undefined, filter: opts.filter as string | undefined });
        process.exit(0);
      },
    }],
    ['tables', {
      description: 'Stream Pine Script table.new() data',
      options: {
        filter: { type: 'string', short: 'f', description: 'Filter by study name' },
        interval: { type: 'string', short: 'i', description: 'Poll interval in ms (default 2000)' },
      },
      handler: async (opts: Record<string, unknown>) => {
        await core.streamTables({ interval: opts.interval ? Number(opts.interval) : undefined, filter: opts.filter as string | undefined });
        process.exit(0);
      },
    }],
    ['all', {
      description: 'Stream all panes at once (multi-symbol monitoring)',
      options: {
        interval: { type: 'string', short: 'i', description: 'Poll interval in ms (default 500)' },
      },
      handler: async (opts: Record<string, unknown>) => {
        await core.streamAllPanes({ interval: opts.interval ? Number(opts.interval) : undefined });
        process.exit(0);
      },
    }],
  ]),
});
