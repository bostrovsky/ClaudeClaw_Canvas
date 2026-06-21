/**
 * Canvas Server — Telegram Mini App for rich content rendering.
 *
 * Runs on a SEPARATE port from the ClaudeClaw dashboard so only this
 * minimal surface is exposed publicly (via Tailscale Funnel or Cloudflare
 * Tunnel). The dashboard stays on its own port, accessible only within
 * the private network.
 *
 * Public surface (funneled):
 *   GET  /           — Mini App HTML (no auth, Telegram must load it)
 *   GET  /stream     — SSE stream (auth: Telegram initData HMAC)
 *   GET  /*.js|css   — static assets (no auth)
 *
 * Internal only (loopback, not funneled):
 *   POST /push       — agents push content here (bot token required)
 *   GET  /state      — current buffer (bot token required)
 */

import fs from 'fs';
import path from 'path';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { serve } from '@hono/node-server';

import { getCanvasChannel, emitCanvasEvent, validateTelegramInitData } from './canvas.js';
import type { CanvasPayload } from './canvas.js';

export interface CanvasServerConfig {
  /** Port to listen on (default: 3144) */
  port: number;
  /** Telegram bot token (used for initData validation and push auth) */
  botToken: string;
  /** Default chat ID for single-tenant setups */
  defaultChatId: string;
  /** Directory containing the Mini App static files (index.html, canvas.js, canvas.css) */
  webDir: string;
  /** Optional logger (defaults to console) */
  logger?: { info: (...args: any[]) => void; warn: (...args: any[]) => void; error: (...args: any[]) => void };
}

export function startCanvasServer(config: CanvasServerConfig): void {
  const { port, botToken, defaultChatId, webDir } = config;
  const log = config.logger || console;

  const app = new Hono();

  // ── CORS for Telegram WebView ──────────────────────────────────────
  app.use('*', async (c, next) => {
    c.header('Access-Control-Allow-Origin', '*');
    c.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    c.header('Access-Control-Allow-Headers', 'Content-Type');
    if (c.req.method === 'OPTIONS') return new Response(null, { status: 204 });
    await next();
  });

  // ── Public routes (exposed via Funnel) ─────────────────────────────

  // Mini App HTML shell
  app.get('/', (c) => {
    const indexPath = path.join(webDir, 'index.html');
    if (!fs.existsSync(indexPath)) return c.text('Canvas not built.', 503);
    const html = fs.readFileSync(indexPath, 'utf-8');
    return c.html(html);
  });

  // Static assets (JS, CSS)
  app.get('/:file{.+\\.(js|css|png|svg)}', (c) => {
    const file = c.req.param('file');
    const filePath = path.join(webDir, file);
    if (!filePath.startsWith(webDir + path.sep)) return c.text('', 403);
    if (!fs.existsSync(filePath)) return c.text('', 404);
    const data = fs.readFileSync(filePath);
    const ext = path.extname(filePath).toLowerCase();
    const ctype = ext === '.js' ? 'application/javascript'
      : ext === '.css' ? 'text/css'
      : ext === '.png' ? 'image/png'
      : ext === '.svg' ? 'image/svg+xml'
      : 'application/octet-stream';
    return new Response(new Uint8Array(data), {
      headers: { 'Content-Type': ctype, 'Cache-Control': 'public, max-age=3600' },
    });
  });

  // SSE stream — auth via Telegram initData HMAC or dev token
  app.get('/stream', (c) => {
    const initData = c.req.query('initData') || '';
    const devToken = c.req.query('token') || '';
    const user = validateTelegramInitData(initData, botToken);
    if (!user && devToken !== botToken) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    const chatId = c.req.query('chatId') || defaultChatId;
    const fromSeq = parseInt(c.req.query('fromSeq') || '0', 10);
    const channel = getCanvasChannel(chatId);

    return streamSSE(c, async (stream) => {
      const state = channel.getState().filter(p => p.seq > fromSeq);
      await stream.writeSSE({ event: 'state', data: JSON.stringify(state) });

      const handler = async (payload: CanvasPayload) => {
        try {
          await stream.writeSSE({ event: 'canvas_push', data: JSON.stringify(payload) });
        } catch { /* disconnected */ }
      };

      const unsub = channel.onPush(handler);

      const pingInterval = setInterval(async () => {
        try { await stream.writeSSE({ event: 'ping', data: '' }); }
        catch { clearInterval(pingInterval); }
      }, 30_000);

      try {
        await new Promise<void>((_, reject) => {
          stream.onAbort(() => reject(new Error('aborted')));
        });
      } catch { /* expected */ }
      finally {
        clearInterval(pingInterval);
        unsub();
      }
    });
  });

  // ── Internal routes (loopback only) ────────────────────────────────

  app.post('/push', async (c) => {
    const body = await c.req.json() as {
      chatId?: string; type?: string; content?: string; title?: string; secret?: string;
    };
    if (body.secret !== botToken) return c.json({ error: 'Forbidden' }, 403);

    const chatId = body.chatId || defaultChatId;
    const type = body.type as CanvasPayload['type'];
    if (!type || !body.content) return c.json({ error: 'type and content required' }, 400);
    if (!['html', 'markdown', 'table', 'chart', 'clear'].includes(type)) {
      return c.json({ error: 'Invalid type' }, 400);
    }
    const payload = emitCanvasEvent(chatId, { type, content: body.content, title: body.title });
    return c.json({ ok: true, seq: payload.seq });
  });

  app.get('/state', (c) => {
    const secret = c.req.query('secret');
    if (secret !== botToken) return c.json({ error: 'Forbidden' }, 403);
    const chatId = c.req.query('chatId') || defaultChatId;
    return c.json({ state: getCanvasChannel(chatId).getState() });
  });

  // ── Start server (with retry on EADDRINUSE) ────────────────────────

  function tryListen(attempt = 1, maxAttempts = 5): void {
    const server = serve({ fetch: app.fetch, port, hostname: '127.0.0.1' });
    server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE' && attempt < maxAttempts) {
        log.warn(`Canvas port ${port} in use, retrying in ${attempt * 2}s (attempt ${attempt}/${maxAttempts})`);
        setTimeout(() => tryListen(attempt + 1, maxAttempts), attempt * 2000);
      } else if (err.code === 'EADDRINUSE') {
        log.warn(`Canvas port ${port} still in use after ${maxAttempts} attempts, skipping`);
      } else {
        log.error(`Canvas server error: ${err.message}`);
      }
    });
    server.on('listening', () => {
      log.info(`Canvas server running on port ${port}`);
    });
  }

  tryListen();
}
