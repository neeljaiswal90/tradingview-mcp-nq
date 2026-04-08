import { register } from '../router.js';
import * as core from '../../core/tradingview/alerts.js';

register('alert', {
  description: 'Alert tools (list, create, delete)',
  subcommands: new Map([
    ['list', {
      description: 'List active alerts',
      handler: () => core.list(),
    }],
    ['create', {
      description: 'Create a price alert',
      options: {
        price: { type: 'string', short: 'p', description: 'Price level' },
        condition: { type: 'string', short: 'c', description: 'Condition: crossing, greater_than, less_than' },
        message: { type: 'string', short: 'm', description: 'Alert message' },
      },
      handler: (opts: Record<string, unknown>) => core.create({
        price: Number(opts.price),
        condition: (opts.condition as string) || 'crossing',
        message: opts.message as string | undefined,
      }),
    }],
    ['delete', {
      description: 'Delete alerts',
      options: {
        all: { type: 'boolean', description: 'Delete all alerts' },
      },
      handler: (opts: Record<string, unknown>) => core.deleteAlerts({ delete_all: (opts.all as boolean | undefined) ?? false }),
    }],
  ]),
});
