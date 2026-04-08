import { register } from '../router.js';
import * as core from '../../core/tradingview/ui.js';

register('layout', {
  description: 'Layout tools (list, switch)',
  subcommands: new Map([
    ['list', {
      description: 'List saved chart layouts',
      handler: () => core.layoutList(),
    }],
    ['switch', {
      description: 'Switch to a saved layout by name or ID',
      handler: (opts: Record<string, unknown>, positionals: string[]) => {
        if (!positionals[0]) throw new Error('Layout name required. Usage: tv layout switch "My Layout"');
        return core.layoutSwitch({ name: positionals.join(' ') });
      },
    }],
  ]),
});
