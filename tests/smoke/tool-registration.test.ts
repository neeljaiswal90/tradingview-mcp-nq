import { describe, it, expect } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerHealthTools } from '../../src/tools/health.js';
import { registerChartTools } from '../../src/tools/chart.js';
import { registerPineTools } from '../../src/tools/pine.js';
import { registerDataTools } from '../../src/tools/data.js';
import { registerCaptureTools } from '../../src/tools/capture.js';
import { registerDrawingTools } from '../../src/tools/drawing.js';
import { registerAlertTools } from '../../src/tools/alerts.js';
import { registerBatchTools } from '../../src/tools/batch.js';
import { registerReplayTools } from '../../src/tools/replay.js';
import { registerIndicatorTools } from '../../src/tools/indicators.js';
import { registerWatchlistTools } from '../../src/tools/watchlist.js';
import { registerUiTools } from '../../src/tools/ui.js';
import { registerPaneTools } from '../../src/tools/pane.js';
import { registerTabTools } from '../../src/tools/tab.js';

describe('tool registration — smoke tests', () => {
  it('all tool groups register without throwing', () => {
    const server = new McpServer({
      name: 'test',
      version: '0.0.0',
      description: 'test',
    });

    expect(() => registerHealthTools(server)).not.toThrow();
    expect(() => registerChartTools(server)).not.toThrow();
    expect(() => registerPineTools(server)).not.toThrow();
    expect(() => registerDataTools(server)).not.toThrow();
    expect(() => registerCaptureTools(server)).not.toThrow();
    expect(() => registerDrawingTools(server)).not.toThrow();
    expect(() => registerAlertTools(server)).not.toThrow();
    expect(() => registerBatchTools(server)).not.toThrow();
    expect(() => registerReplayTools(server)).not.toThrow();
    expect(() => registerIndicatorTools(server)).not.toThrow();
    expect(() => registerWatchlistTools(server)).not.toThrow();
    expect(() => registerUiTools(server)).not.toThrow();
    expect(() => registerPaneTools(server)).not.toThrow();
    expect(() => registerTabTools(server)).not.toThrow();
  });
});
