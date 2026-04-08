import { describe, it, expect } from 'vitest';

describe('CLI routing — smoke tests', () => {
  it('CLI module imports without error', async () => {
    await expect(import('../../src/cli/router.js')).resolves.toBeDefined();
  });

  it('router exports register and run', async () => {
    const router = await import('../../src/cli/router.js');
    expect(typeof router.register).toBe('function');
    expect(typeof router.run).toBe('function');
  });

  it('command modules import without error', async () => {
    const modules = [
      '../../src/cli/commands/health.js',
      '../../src/cli/commands/chart.js',
      '../../src/cli/commands/data.js',
      '../../src/cli/commands/pine.js',
      '../../src/cli/commands/capture.js',
      '../../src/cli/commands/drawing.js',
      '../../src/cli/commands/alerts.js',
      '../../src/cli/commands/replay.js',
      '../../src/cli/commands/indicator.js',
      '../../src/cli/commands/watchlist.js',
      '../../src/cli/commands/layout.js',
      '../../src/cli/commands/pane.js',
      '../../src/cli/commands/tab.js',
      '../../src/cli/commands/stream.js',
      '../../src/cli/commands/ui.js',
    ];
    for (const mod of modules) {
      await expect(import(mod)).resolves.toBeDefined();
    }
  });
});
