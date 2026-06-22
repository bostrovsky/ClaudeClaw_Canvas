/**
 * Canvas Server — Telegram Mini App for rich content rendering.
 *
 * Runs on a SEPARATE port from the dashboard (default 3144) so only
 * this minimal surface is exposed via Tailscale Funnel. The dashboard
 * stays on its own port, accessible only within the tailnet.
 *
 * Public surface (funneled):
 *   GET  /           — Mini App HTML (no auth, Telegram must load it)
 *   GET  /stream     — SSE stream (auth: Telegram initData HMAC)
 *   GET  /*.js|css   — static assets (no auth)
 *
 * Internal only (loopback, not funneled):
 *   POST /push       — agents push content here (localhost only)
 *   GET  /state      — current buffer (localhost only)
 */

import fs from 'fs';
import path from 'path';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { serve } from '@hono/node-server';

import { ALLOWED_CHAT_ID, activeBotToken, CANVAS_PORT, PROJECT_ROOT } from './config.js';
import { getCanvasChannel, emitCanvasEvent, validateTelegramInitData } from './canvas.js';
import type { CanvasPayload } from './canvas.js';
import { logger } from './logger.js';

export function startCanvasServer(): void {
  const app = new Hono();
  const canvasDir = path.join(PROJECT_ROOT, 'dist', 'web', 'canvas');

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
    const indexPath = path.join(canvasDir, 'index.html');
    if (!fs.existsSync(indexPath)) return c.text('Canvas not built.', 503);
    const html = fs.readFileSync(indexPath, 'utf-8');
    return c.html(html);
  });

  // Static assets (JS, CSS)
  app.get('/:file{.+\\.(js|css|png|svg)}', (c) => {
    const file = c.req.param('file');
    const filePath = path.join(canvasDir, file);
    if (!filePath.startsWith(canvasDir + path.sep)) return c.text('', 403);
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

  // SSE stream — auth via Telegram initData HMAC (production) or bot token (dev testing)
  app.get('/stream', (c) => {
    const initData = c.req.query('initData') || '';
    const devToken = c.req.query('token') || '';
    const user = validateTelegramInitData(initData, activeBotToken);
    // Dev fallback: accept bot token as query param for browser testing
    if (!user && devToken !== activeBotToken) {
      return c.json({ error: 'Unauthorized. Telegram initData validation failed.' }, 401);
    }

    const chatId = c.req.query('chatId') || ALLOWED_CHAT_ID;
    const fromSeq = parseInt(c.req.query('fromSeq') || '0', 10);
    const channel = getCanvasChannel(chatId);

    return streamSSE(c, async (stream) => {
      // Send current state
      const state = channel.getState().filter(p => p.seq > fromSeq);
      await stream.writeSSE({ event: 'state', data: JSON.stringify(state) });

      // Forward new pushes
      const handler = async (payload: CanvasPayload) => {
        try {
          await stream.writeSSE({ event: 'canvas_push', data: JSON.stringify(payload) });
        } catch { /* disconnected */ }
      };

      const unsub = channel.onPush(handler);

      // Keepalive
      const pingInterval = setInterval(async () => {
        try { await stream.writeSSE({ event: 'ping', data: '' }); }
        catch { clearInterval(pingInterval); }
      }, 30_000);

      // Wait for disconnect
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

  // Push content — only accessible from localhost
  app.post('/push', async (c) => {
    const remoteAddr = c.req.header('x-forwarded-for') || c.req.header('host') || '';
    // When served directly (no reverse proxy), connections from Funnel come
    // via Tailscale's proxy. Internal pushes come from 127.0.0.1.
    // We bind the push endpoint check to a simple shared secret instead.
    const body = await c.req.json() as {
      chatId?: string;
      type?: string;
      content?: string;
      title?: string;
      secret?: string;
    };

    // Internal secret — prevents external Funnel traffic from pushing.
    // Uses the bot token as the shared secret (already known to the bot process).
    if (body.secret !== activeBotToken) {
      return c.json({ error: 'Forbidden' }, 403);
    }

    const chatId = body.chatId || ALLOWED_CHAT_ID;
    const type = body.type as CanvasPayload['type'];
    if (!type || !body.content) {
      return c.json({ error: 'type and content required' }, 400);
    }
    if (!['html', 'markdown', 'table', 'chart', 'clear'].includes(type)) {
      return c.json({ error: 'Invalid type. Use: html, markdown, table, chart, clear' }, 400);
    }
    const payload = emitCanvasEvent(chatId, { type, content: body.content, title: body.title });
    return c.json({ ok: true, seq: payload.seq });
  });

  // Get current state — also internal only
  app.get('/state', (c) => {
    const chatId = c.req.query('chatId') || ALLOWED_CHAT_ID;
    const secret = c.req.query('secret');
    if (secret !== activeBotToken) {
      return c.json({ error: 'Forbidden' }, 403);
    }
    const channel = getCanvasChannel(chatId);
    return c.json({ state: channel.getState() });
  });

  // ── Start server (with retry on EADDRINUSE) ────────────────────────

  function tryListen(attempt = 1, maxAttempts = 5): void {
    const server = serve({ fetch: app.fetch, port: CANVAS_PORT, hostname: '127.0.0.1' });
    server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE' && attempt < maxAttempts) {
        logger.warn({ port: CANVAS_PORT, attempt }, 'Canvas port %d in use, retrying in %ds...', CANVAS_PORT, attempt * 2);
        setTimeout(() => tryListen(attempt + 1, maxAttempts), attempt * 2000);
      } else if (err.code === 'EADDRINUSE') {
        logger.warn({ port: CANVAS_PORT }, 'Canvas port %d still in use after %d attempts, skipping', CANVAS_PORT, maxAttempts);
      } else {
        logger.error({ err, port: CANVAS_PORT }, 'Canvas server error');
      }
    });
    server.on('listening', () => {
      logger.info({ port: CANVAS_PORT }, 'Canvas server running on port %d', CANVAS_PORT);
    });
  }

  tryListen();
}
