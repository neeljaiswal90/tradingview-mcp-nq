/**
 * Dashboard HTTP Server — serves REST API + SSE stream + static frontend.
 *
 * Endpoints:
 *   GET /api/dashboard/snapshot   — full dashboard state
 *   GET /api/dashboard/stream     — SSE stream of state updates
 *   GET /api/dashboard/history    — recent trade history
 *   GET /*                        — static files from dashboard/dist/
 *
 * Uses Node built-in http module — zero new dependencies.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'http';
import { readFile } from 'fs/promises';
import { join, extname } from 'path';
import { existsSync } from 'fs';
import type { DashboardStateManager } from './state-manager.js';

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
};

export interface DashboardServerOptions {
  port: number;
  stateManager: DashboardStateManager;
  /** Path to the built frontend (dashboard/dist). */
  staticDir: string;
}

export class DashboardServer {
  private readonly options: DashboardServerOptions;
  private readonly sseClients = new Set<ServerResponse>();
  private server: ReturnType<typeof createServer> | null = null;
  private throttleTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingUpdate = false;

  constructor(options: DashboardServerOptions) {
    this.options = options;

    // Listen for state changes and broadcast to SSE clients
    options.stateManager.on('update', () => this.throttledBroadcast());
  }

  async start(): Promise<void> {
    const { port, stateManager, staticDir } = this.options;

    this.server = createServer(async (req, res) => {
      const url = req.url ?? '/';
      const method = req.method ?? 'GET';

      // CORS headers for dev
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

      if (method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

      try {
        // API routes
        if (url === '/api/dashboard/snapshot') {
          this.sendJson(res, stateManager.getSnapshot());
        } else if (url === '/api/dashboard/stream') {
          this.handleSSE(req, res);
        } else if (url === '/api/dashboard/history') {
          const snap = stateManager.getSnapshot();
          this.sendJson(res, {
            recent_trades: snap.recent_trades,
            pnl_history: snap.pnl_history,
          });
        } else {
          // Static file serving
          await this.serveStatic(res, url, staticDir);
        }
      } catch (err) {
        console.error('[DASHBOARD] Request error:', err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Internal server error' }));
      }
    });

    return new Promise((resolve, reject) => {
      this.server!.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') {
          console.warn(`[DASHBOARD] Port ${port} in use, trying ${port + 1}...`);
          this.server!.listen(port + 1, '0.0.0.0', () => {
            console.log(`[DASHBOARD] 🖥️  Dashboard server running at http://localhost:${port + 1}`);
            resolve();
          });
        } else {
          reject(err);
        }
      });

      this.server!.listen(port, '0.0.0.0', () => {
        console.log(`[DASHBOARD] 🖥️  Dashboard server running at http://localhost:${port}`);
        resolve();
      });
    });
  }

  stop(): void {
    for (const client of this.sseClients) {
      client.end();
    }
    this.sseClients.clear();
    this.server?.close();
  }

  // ─── SSE ─────────────────────────────────────────────────────────────────

  private handleSSE(req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    // Send initial snapshot
    const snap = this.options.stateManager.getSnapshot();
    res.write(`event: snapshot\ndata: ${JSON.stringify(snap)}\n\n`);

    this.sseClients.add(res);
    console.log(`[DASHBOARD] SSE client connected (total: ${this.sseClients.size})`);

    // Heartbeat every 30s to keep connection alive
    const heartbeat = setInterval(() => {
      res.write(': heartbeat\n\n');
    }, 30_000);

    req.on('close', () => {
      this.sseClients.delete(res);
      clearInterval(heartbeat);
      console.log(`[DASHBOARD] SSE client disconnected (total: ${this.sseClients.size})`);
    });
  }

  private broadcastEvent(event: string, data: string): void {
    const message = `event: ${event}\ndata: ${data}\n\n`;
    for (const client of this.sseClients) {
      client.write(message);
    }
  }

  /** Throttle broadcasts to max 2/sec to avoid flooding. */
  private throttledBroadcast(): void {
    if (this.throttleTimer) {
      this.pendingUpdate = true;
      return;
    }

    this.doBroadcast();

    this.throttleTimer = setTimeout(() => {
      this.throttleTimer = null;
      if (this.pendingUpdate) {
        this.pendingUpdate = false;
        this.doBroadcast();
      }
    }, 500);
  }

  private broadcastCount = 0;

  private doBroadcast(): void {
    if (this.sseClients.size === 0) return;
    const snap = this.options.stateManager.getSnapshot();
    this.broadcastCount++;
    this.broadcastEvent('snapshot', JSON.stringify(snap));
    // Log every 10th broadcast to avoid spam
    if (this.broadcastCount % 10 === 1) {
      console.log(
        `[DASHBOARD] SSE broadcast #${this.broadcastCount} → ${this.sseClients.size} client(s)` +
        ` | cycle=${snap.app.cycle_count} | conf=${snap.directional.confidence ?? 'n/a'}`,
      );
    }
  }

  // ─── JSON response ───────────────────────────────────────────────────────

  private sendJson(res: ServerResponse, data: unknown): void {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(data));
  }

  // ─── Static files ────────────────────────────────────────────────────────

  private async serveStatic(res: ServerResponse, url: string, staticDir: string): Promise<void> {
    let filePath = url === '/' ? '/index.html' : url;
    // Strip query string
    filePath = filePath.split('?')[0]!;
    const fullPath = join(staticDir, filePath);

    // Security: prevent directory traversal
    if (!fullPath.startsWith(staticDir)) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }

    if (!existsSync(fullPath)) {
      // SPA fallback: serve index.html for non-file routes
      const indexPath = join(staticDir, 'index.html');
      if (existsSync(indexPath)) {
        const content = await readFile(indexPath);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(content);
      } else {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
      }
      return;
    }

    const ext = extname(fullPath);
    const contentType = MIME_TYPES[ext] ?? 'application/octet-stream';
    const content = await readFile(fullPath);

    // Cache static assets (hashed filenames from Vite)
    const cacheControl = ext === '.html'
      ? 'no-cache'
      : 'public, max-age=31536000, immutable';

    res.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': cacheControl,
    });
    res.end(content);
  }
}
