# ClaudeClaw Canvas

Rich content rendering for ClaudeClaw via Telegram Mini App. Turns plain-text agent responses into styled visuals -- tables, charts, code blocks, formatted lists -- delivered as PNG images in chat and interactive HTML in a persistent Mini App canvas.

Inspired by [OpenClaw tg-canvas](https://github.com/clvv/openclaw-tg-canvas).

## What It Does

When a ClaudeClaw agent responds with structured data (tables, bullet lists, code blocks, comparisons), Canvas automatically:

1. **Converts** the markdown response to styled, dark-themed HTML
2. **Renders** the HTML to a PNG screenshot via Playwright
3. **Sends** the PNG as a photo in the Telegram chat (visual-first)
4. **Pushes** the interactive HTML to a Telegram Mini App for scrolling, zooming, and Chart.js interactivity
5. **Strips** the structured content from the text message so there's no duplication

The user sees a beautiful rendered image in chat. Tapping "Open in Canvas" shows the interactive version.

## Architecture

```
Agent response (markdown)
    |
    v
canvas-transform.ts: markdown --> styled HTML
    |
    +---> canvas-render.ts: HTML --> PNG (Playwright screenshot)
    |         |
    |         v
    |     Telegram chat: sends PNG as photo
    |
    +---> canvas.ts: pushes HTML to CanvasChannel (in-memory ring buffer)
              |
              v
          canvas-server.ts: SSE stream --> Mini App frontend
              |
              v
          web/canvas.js: renders HTML in Telegram Mini App WebView
```

**Security model:**
- Canvas server runs on a **separate port** (default 3144) from the dashboard
- Only the canvas port is exposed publicly (via Tailscale Funnel or Cloudflare Tunnel)
- SSE stream authenticated via Telegram's initData HMAC-SHA256
- Push endpoint protected by bot token (internal only)
- Dashboard stays on its own port, tailnet-only

## Files

| File | Purpose |
|------|---------|
| `src/canvas.ts` | CanvasChannel (ring buffer + events), Telegram initData HMAC validation |
| `src/canvas-server.ts` | Hono HTTP server: serves Mini App, SSE stream, push/state API |
| `src/canvas-transform.ts` | Markdown-to-styled-HTML converter with auto-tabling of key:value lists |
| `src/canvas-render.ts` | Playwright HTML-to-PNG screenshot renderer |
| `src/canvas-middleware.ts` | Single `processCanvasResponse()` call for bot.ts integration |
| `src/index.ts` | Public API exports |
| `web/index.html` | Telegram Mini App HTML shell |
| `web/canvas.js` | Mini App frontend: SSE connection, content rendering, Chart.js |
| `web/canvas.css` | Dark-themed styles matching Telegram's UI |

## Installation

### Prerequisites

- ClaudeClaw OS (the multi-tenant Telegram bot platform)
- Node.js 20+
- Playwright (`npx playwright install chromium`)
- A public HTTPS URL for the canvas port (Tailscale Funnel or Cloudflare Tunnel)

### 1. Copy source files

Copy `src/canvas*.ts` into your ClaudeClaw `src/` directory. Copy `web/` contents into `web/public/canvas/`.

### 2. Add to your .env

```bash
# Canvas port (separate from dashboard)
CANVAS_PORT=3144

# Public HTTPS URL for the canvas (Tailscale Funnel or Cloudflare Tunnel)
CANVAS_URL=https://your-host.tail12345.ts.net:3144
```

### 3. Start the canvas server

In your `src/index.ts`, after starting the dashboard:

```typescript
import { startCanvasServer } from './canvas-server.js';

// Inside your main startup:
startCanvasServer({
  port: parseInt(process.env.CANVAS_PORT || '3144'),
  botToken: process.env.TELEGRAM_BOT_TOKEN!,
  defaultChatId: process.env.ALLOWED_CHAT_ID!,
  webDir: path.join(PROJECT_ROOT, 'dist', 'web', 'canvas'),
});
```

### 4. Add middleware to bot response pipeline

In your `src/bot.ts`, replace the text-sending logic with:

```typescript
import { processCanvasResponse } from './canvas-middleware.js';

// After getting the agent response:
const canvasResult = await processCanvasResponse(responseText, chatId, ctx, CANVAS_URL);

// Only send text if PNG wasn't sent:
if (canvasResult.telegramText) {
  await ctx.reply(formatForTelegram(canvasResult.telegramText), { parse_mode: 'HTML' });
}
```

### 5. Set up the menu button

Add to your bot startup to make Canvas always accessible:

```typescript
if (CANVAS_URL) {
  bot.api.setChatMenuButton({
    menu_button: {
      type: 'web_app',
      text: 'Canvas',
      web_app: { url: `${CANVAS_URL}?chatId=${ALLOWED_CHAT_ID}` },
    },
  });
}
```

### 6. Expose the canvas port

```bash
# Tailscale Funnel (recommended)
tailscale funnel --bg --https=3144 http://127.0.0.1:3144

# Or Cloudflare Tunnel
cloudflared tunnel --url http://localhost:3144
```

### 7. Build and restart

```bash
npm run build
launchctl kickstart -k gui/$(id -u)/com.claudeclaw.<tenant>
```

## Content Types

The canvas auto-detects and renders these content types from agent responses:

| Content | Detection | Rendering |
|---------|-----------|-----------|
| Bullet lists with `key: value` pattern | 3+ items matching `X: Y` | Styled table with alternating rows |
| Markdown tables (`\| col \| col \|`) | Pipe-delimited rows | Dark-themed table with headers |
| Code blocks (`` ``` ``) | Triple backtick fences | Syntax-highlighted panel |
| Numbered lists | `1.` / `2.` prefix | Styled ordered list with blue numbers |
| Headings | `#` / `##` / `###` | Sized, bold, light-colored |
| Regular text | Everything else | Styled paragraphs |

Agents can also use explicit markers for direct control:

```
[CANVAS:html|<h1>Custom HTML</h1>]
[CANVAS:chart|{"type":"line","data":{"labels":["Mon","Tue"],"datasets":[{"data":[1,2]}]}}]
[CANVAS:table|{"headers":["A","B"],"rows":[["1","2"]]}]
[CANVAS:clear]
```

## Multi-Tenant

Each tenant gets their own canvas port. In a multi-tenant ClaudeClaw setup:

| Tenant | Dashboard Port | Canvas Port |
|--------|---------------|-------------|
| Brian | 3141 | 3144 |
| Jodie | 3142 | 3145 |
| Christine | 3143 | 3146 |

Each canvas server is independent. Tailscale Funnel each port separately.

## License

MIT
