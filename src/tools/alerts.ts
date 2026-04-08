import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/tradingview/alerts.js';

export function registerAlertTools(server: McpServer): void {
  server.tool('alert_create', 'Create a price alert via the TradingView alert dialog', {
    condition: z.string().describe('Alert condition (e.g., "crossing", "greater_than", "less_than")'),
    price: z.coerce.number().describe('Price level for the alert'),
    message: z.string().optional().describe('Alert message'),
  }, async ({ condition, price, message }) => {
    try { return jsonResult(await core.create({ condition, price, message })); }
    catch (err) { return jsonResult({ success: false, error: (err as Error).message }, true); }
  });

  server.tool('alert_list', 'List active alerts', {}, async () => {
    try { return jsonResult(await core.list()); }
    catch (err) { return jsonResult({ success: false, error: (err as Error).message }, true); }
  });

  server.tool('alert_delete', 'Delete all alerts or open context menu for deletion', {
    delete_all: z.coerce.boolean().optional().describe('Delete all alerts'),
  }, async ({ delete_all }) => {
    try { return jsonResult(await core.deleteAlerts({ delete_all: delete_all ?? false })); }
    catch (err) { return jsonResult({ success: false, error: (err as Error).message }, true); }
  });
}
