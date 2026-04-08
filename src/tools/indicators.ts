import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/tradingview/indicators.js';

export function registerIndicatorTools(server: McpServer): void {
  server.tool('indicator_set_inputs', 'Change indicator/study input values (e.g., length, source, period)', {
    entity_id: z.string().describe('Entity ID of the study (from chart_get_state)'),
    inputs: z.string().describe('JSON string of input overrides, e.g. \'{"length": 50, "source": "close"}\'. Keys are input IDs, values are the new values.'),
  }, async ({ entity_id, inputs }) => {
    try { return jsonResult(await core.setInputs({ entity_id, inputs })); }
    catch (err) { return jsonResult({ success: false, error: (err as Error).message }, true); }
  });

  server.tool('indicator_toggle_visibility', 'Show or hide an indicator/study on the chart', {
    entity_id: z.string().describe('Entity ID of the study (from chart_get_state)'),
    visible: z.coerce.boolean().describe('true to show, false to hide'),
  }, async ({ entity_id, visible }) => {
    try { return jsonResult(await core.toggleVisibility({ entity_id, visible })); }
    catch (err) { return jsonResult({ success: false, error: (err as Error).message }, true); }
  });
}
