# ClaudeClaw Canvas

> [!IMPORTANT]
> **Canvas is now a built-in plugin in ClaudeClaw OS** (`plugins/canvas/`), loaded
> through the plugin architecture. **You no longer clone this repo or run
> `install.sh`** — there are no file copies into `src/` and no `sed` patches.
>
> **To enable Canvas on a current ClaudeClaw OS:**
> 1. Set `CANVAS_URL` and `CANVAS_PORT` in your tenant `.env`
> 2. Expose the port: `tailscale funnel --bg --https=3144 http://127.0.0.1:3144`
> 3. Install the renderer: `npx playwright install chromium`
> 4. `npm run build` and restart the tenant
>
> See `docs/PLUGINS.md` in claudeclaw-os for the plugin architecture. This repo is
> kept for history and reference. The `sed`-based `install.sh` remains only as a
> legacy fallback for ClaudeClaw versions that predate the plugin loader; it is
> deprecated and will be removed.

Rich content rendering for [ClaudeClaw](https://github.com/openclaw/openclaw) via Telegram Mini App. Agent responses with structured data are automatically converted to styled visuals -- tables, charts, code blocks, formatted lists -- delivered as PNG images directly in the Telegram chat, with an interactive Mini App canvas for zooming and scrolling.

Inspired by [OpenClaw tg-canvas](https://github.com/clvv/openclaw-tg-canvas).

## How It Works

When an agent responds with structured data (tables, key:value lists, code blocks, comparisons), Canvas automatically:

1. **Detects** structured content in the markdown response (plain text passes through untouched)
2. **Converts** the structured content to styled, dark-themed HTML
3. **Renders** the HTML to a PNG screenshot via Playwright
4. **Sends** the PNG as a photo in the Telegram chat (visual-first -- the user sees a rendered image, not raw text)
5. **Streams** the interactive HTML to a persistent Telegram Mini App canvas
6. **Strips** the structured content from the text message so there's no duplication

The user sees a clean rendered image in chat. Tapping "Open in Canvas" shows the interactive version with zoom controls.

## Enable Canvas (current ClaudeClaw OS)

Canvas ships as a built-in plugin (`plugins/canvas/`). There's nothing to clone
and no `install.sh` to run — just configure and build:

1. Add to your tenant `.env`:
   ```
   CANVAS_PORT=3144
   CANVAS_URL=https://your-host.ts.net:3144
   ```

2. Expose the port:
   ```bash
   tailscale funnel --bg --https=3144 http://127.0.0.1:3144
   ```

3. Install the renderer (once per machine):
   ```bash
   npx playwright install chromium
   ```

4. Build and restart:
   ```bash
   npm run build
   launchctl kickstart -k gui/$(id -u)/com.claudeclaw.<tenant>
   ```

The plugin registers its `/canvas` command, menu button, and response pipeline
automatically — no `bot.ts` wiring. Confirm it loaded with the
`[plugin] loaded canvas@1.0.0` line in the startup log.

<details>
<summary>Legacy <code>sed</code>-based install (deprecated — pre-plugin ClaudeClaw only)</summary>

```bash
git clone https://github.com/bostrovsky/ClaudeClaw_Canvas.git
bash ClaudeClaw_Canvas/install.sh   # copies files into src/, sed-patches bot.ts/config.ts/index.ts
```

This path exists only for ClaudeClaw versions that predate the plugin loader.
It is deprecated and will be removed. On any current ClaudeClaw OS, use the
plugin (above) instead.
</details>

## What Gets Rendered

Canvas only triggers for actual structured content. Plain text answers pass through normally.

| Content | When It Triggers | How It Renders |
|---------|-----------------|----------------|
| Key:value bullet lists | 3+ items matching `Label: value` | Styled table with alternating rows |
| Markdown tables | Pipe-delimited rows with 6+ pipes | Dark-themed table with headers |
| Code blocks | Triple backtick fences | Syntax-highlighted panel |
| Long bullet lists | 5+ items | Styled card-like list |
| Long numbered lists | 5+ items | Ordered list with blue numbers |

Plain conversational text, short answers, confirmations -- none of these trigger canvas. Only structured data that genuinely looks better rendered.

## Architecture

```
Agent response (markdown)
    |
    v
canvas-transform.ts: detect structured content, convert to styled HTML
    |
    +---> canvas-render.ts: HTML --> PNG (Playwright screenshot)
    |         |
    |         v
    |     Telegram chat: PNG photo + "Open in Canvas" button
    |
    +---> canvas.ts: push HTML to CanvasChannel (in-memory)
              |
              v
          canvas-server.ts: SSE stream to Mini App
              |
              v
          web/canvas.js: render in Telegram Mini App WebView
```

**Security:**
- Canvas server runs on a **separate port** from the dashboard (default 3144)
- Only the canvas port is exposed publicly (via Tailscale Funnel or Cloudflare Tunnel)
- SSE stream authenticated via Telegram's initData HMAC-SHA256
- Push endpoint protected by bot token (internal only)
- Dashboard stays on its own port, private network only

## Mini App Features

- **Single-state canvas** -- each new response replaces the previous (like OpenClaw)
- **A+/A- zoom controls** -- adjusts all content size, persists across sessions
- **Chart.js support** -- agents can push interactive charts via `[CANVAS:chart|{config}]`
- **Script re-execution** -- inline `<script>` tags work in the Telegram WebView
- **Dark theme** -- matches Telegram's UI, respects theme variables
- **Auto-reconnect** -- SSE stream reconnects on disconnect with 3s backoff
- **Live streaming** -- content appears instantly when the canvas is open

## Files

| File | Purpose |
|------|---------|
| `src/canvas.ts` | CanvasChannel (ring buffer + events), Telegram initData HMAC validation |
| `src/canvas-server.ts` | Hono HTTP server: Mini App, SSE stream, push/state API. Retries on port conflict. |
| `src/canvas-transform.ts` | Markdown-to-styled-HTML converter. Auto-detects structured content, converts key:value lists to tables. |
| `src/canvas-render.ts` | Playwright HTML-to-PNG screenshot renderer (600px width, dark theme) |
| `src/canvas-middleware.ts` | Single `processCanvasResponse()` entry point for bot.ts |
| `src/index.ts` | Public API exports |
| `web/index.html` | Telegram Mini App shell with Chart.js CDN |
| `web/canvas.js` | Mini App frontend: SSE, rendering, zoom controls |
| `web/canvas.css` | Dark-themed responsive styles |
| `install.sh` | One-command installer for ClaudeClaw OS |
| `SKILL.md` | Agent-readable install instructions (give your bot the repo URL) |

## Integration

> [!NOTE]
> The manual wiring below applied to the old `src/`-copy install. The plugin form
> (`plugins/canvas/`) does this for you via `ctx.registerResponseMiddleware` — no
> `bot.ts` edits. The section is kept as a description of what Canvas does under
> the hood.

### Bot response pipeline

In `src/bot.ts`, add one call after extracting file markers:

```typescript
import { processCanvasResponse } from './canvas-middleware.js';

// After getting the agent response and extracting file markers:
const canvasResult = await processCanvasResponse(responseText, chatId, ctx, CANVAS_URL);

// Send text only if canvas didn't send a PNG:
const telegramText = canvasResult.telegramText;
if (telegramText) {
  await ctx.reply(formatForTelegram(telegramText + costFooter), { parse_mode: 'HTML' });
}
```

### Canvas server startup

In `src/index.ts`, after `startDashboard()`:

```typescript
const { startCanvasServer } = await import('./canvas-server.js');
startCanvasServer();
```

### Menu button (always-visible Canvas launcher)

```typescript
if (CANVAS_URL) {
  bot.api.setChatMenuButton({
    menu_button: {
      type: 'web_app',
      text: 'Canvas',
      web_app: { url: `${CANVAS_URL}?chatId=${ALLOWED_CHAT_ID}&v=${Date.now()}` },
    },
  });
}
```

### Explicit agent markers

Agents can also push content directly with markers in their response:

```
[CANVAS:html|<h1>Custom HTML</h1>]
[CANVAS:html|Title Here|<div>Content with a title</div>]
[CANVAS:chart|{"type":"line","data":{"labels":["Mon","Tue"],"datasets":[{"data":[1,2]}]}}]
[CANVAS:table|{"headers":["Name","Value"],"rows":[["A","1"],["B","2"]]}]
[CANVAS:clear]
```

## Multi-Tenant

Each tenant gets their own canvas port:

| Tenant | Dashboard Port | Canvas Port |
|--------|---------------|-------------|
| Tenant A | 3141 | 3144 |
| Tenant B | 3142 | 3145 |
| Tenant C | 3143 | 3146 |

Each canvas server is independent. Expose each port separately via Tailscale Funnel or Cloudflare Tunnel.

## Known Limitations

- **Same-machine access (Tailscale Funnel hairpin).** If you run ClaudeClaw and Telegram Desktop on the **same machine**, the canvas Mini App will not load. Tailscale Funnel cannot route traffic from a machine back to itself -- the request goes out to Tailscale's relay servers and times out trying to loop back. **This affects anyone running ClaudeClaw on their daily-use workstation.** The canvas works fine from phones, tablets, and other computers on your network. Workarounds:
  - Use the canvas from your phone or a second computer (recommended)
  - Use Cloudflare Tunnel instead of Tailscale Funnel (CF Tunnel doesn't have the hairpin issue because `cloudflared` runs locally and handles both local and remote traffic)
  - The install script sets up an HTTPS localhost fallback on port `CANVAS_PORT + 100` (e.g. 3244) using mkcert. You can open `https://localhost:3244?chatId=YOUR_CHAT_ID&token=YOUR_BOT_TOKEN` in a browser, but this doesn't help Telegram Desktop since the bot's menu button URL is global across all devices.

- **Canvas state is in-memory.** Content doesn't survive service restarts. Old "Open in Canvas" buttons show blank after a restart. SQLite persistence is planned.

- **Telegram WebView caching.** The Mini App HTML/JS/CSS is aggressively cached by Telegram. Version params (`?v=N`) on asset URLs help. If the canvas shows stale content, close and reopen it.

## Requirements

- [ClaudeClaw OS](https://github.com/openclaw/openclaw)
- Node.js 20+
- Playwright with Chromium (`npx playwright install chromium`)
- [Hono](https://hono.dev) + [@hono/node-server](https://www.npmjs.com/package/@hono/node-server) (already in ClaudeClaw)
- [grammY](https://grammy.dev) (already in ClaudeClaw)
- A public HTTPS URL (Tailscale Funnel or Cloudflare Tunnel)

## License

MIT
