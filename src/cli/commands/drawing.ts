import { register } from '../router.js';
import * as core from '../../core/tradingview/drawing.js';

register('draw', {
  description: 'Drawing tools (shape, list, get, remove, clear)',
  subcommands: new Map([
    ['shape', {
      description: 'Draw a shape on the chart',
      options: {
        type: { type: 'string', short: 't', description: 'Shape type: horizontal_line, trend_line, rectangle, text' },
        price: { type: 'string', short: 'p', description: 'Price level' },
        time: { type: 'string', description: 'Unix timestamp' },
        price2: { type: 'string', description: 'Second point price (for trend_line, rectangle)' },
        time2: { type: 'string', description: 'Second point time (for trend_line, rectangle)' },
        text: { type: 'string', description: 'Text content (for text shapes)' },
        overrides: { type: 'string', description: 'JSON style overrides' },
      },
      handler: (opts: Record<string, unknown>) => {
        const point = { time: Number(opts.time), price: Number(opts.price) };
        const point2 = opts.price2 ? { time: Number(opts.time2), price: Number(opts.price2) } : undefined;
        return core.drawShape({ shape: (opts.type as string) || 'horizontal_line', point, point2, overrides: opts.overrides as string | undefined, text: opts.text as string | undefined });
      },
    }],
    ['list', {
      description: 'List all drawings on the chart',
      handler: () => core.listDrawings(),
    }],
    ['get', {
      description: 'Get properties of a drawing',
      handler: (_opts: Record<string, unknown>, positionals: string[]) => core.getProperties({ entity_id: positionals[0]! }),
    }],
    ['remove', {
      description: 'Remove a drawing by entity ID',
      handler: (_opts: Record<string, unknown>, positionals: string[]) => core.removeOne({ entity_id: positionals[0]! }),
    }],
    ['clear', {
      description: 'Remove all drawings',
      handler: () => core.clearAll(),
    }],
  ]),
});
