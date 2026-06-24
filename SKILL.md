---
name: install-canvas
description: Install ClaudeClaw Canvas - rich content rendering via Telegram Mini App. Converts agent responses to styled visuals (tables, charts, code) delivered as PNG images in chat with an interactive Mini App canvas.
argument-hint: ""
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, AskUserQuestion
user-invocable: true
---

# Install ClaudeClaw Canvas

You are installing the ClaudeClaw Canvas module from https://github.com/bostrovsky/ClaudeClaw_Canvas.git

## What this does

Adds rich content rendering to ClaudeClaw. Agent responses with structured data (tables, lists, code, comparisons) are automatically:
1. Converted to styled, dark-themed HTML
2. Rendered to a PNG screenshot (via Playwright)
3. Sent as a photo in the Telegram chat
4. Streamed to a persistent Telegram Mini App canvas for interactive viewing

## Installation steps

### Step 1: Find the ClaudeClaw root

```bash
PROJECT_ROOT=$(git rev-parse --show-toplevel 2>/dev/null)
```

If that fails, ask the user where their ClaudeClaw OS directory is.

### Step 2: Clone and run the installer

```bash
cd "$PROJECT_ROOT"
if [ ! -d ClaudeClaw_Canvas ]; then
  git clone https://github.com/bostrovsky/ClaudeClaw_Canvas.git
fi
bash ClaudeClaw_Canvas/install.sh
```

The installer copies source files, patches config.ts/index.ts/bot.ts, installs Playwright chromium, and builds.

### Step 3: Wire processCanvasResponse into bot.ts

Find the response pipeline in `src/bot.ts` where the agent response text is about to be sent to Telegram. Look for the pattern where `extractFileMarkers` is called and text is sent via `ctx.reply`.

Insert the canvas middleware call between file marker extraction and the text send:

```typescript
// After extracting file markers:
const { text: responseText, files: fileMarkers } = extractFileMarkers(rawResponse);

// ADD THIS: Canvas pipeline - renders PNG and sends as photo
const canvasResult = await processCanvasResponse(responseText, chatIdStr, ctx, CANVAS_URL);

// Modify the text send to use canvasResult.telegramText instead of responseText:
const telegramText = canvasResult.telegramText;
// Only send text if canvas didn't already send a PNG:
const textWithFooter = telegramText ? telegramText + costFooter : '';
```

The import `import { processCanvasResponse } from './canvas-middleware.js'` should already be added by the installer. If not, add it.

### Step 4: Configure the tenant .env

Ask the user for their Tailscale hostname or tunnel URL, then add:

```
CANVAS_PORT=3144
CANVAS_URL=https://<hostname>:3144
```

For multi-tenant setups, each tenant gets a different port (3144, 3145, 3146...).

### Step 5: Expose the canvas port

```bash
tailscale funnel --bg --https=3144 http://127.0.0.1:3144
```

Or for Cloudflare:
```bash
cloudflared tunnel --url http://localhost:3144
```

### Step 6: Build and restart

```bash
cd "$PROJECT_ROOT"
npm run build
launchctl kickstart -k gui/$(id -u)/com.claudeclaw.<tenant>
```

### Step 7: Verify

```bash
# Check canvas server is running
curl -s http://127.0.0.1:3144/ | head -2
# Should return: <!DOCTYPE html>
```

Tell the user to send a message to their bot that would produce structured data (like "compare the weather in two cities") and verify they see a PNG image in the chat with an "Open in Canvas" button.

## Troubleshooting

- **Port in use**: The canvas server retries 5 times with backoff. If it still fails, check `lsof -iTCP:3144` for conflicts.
- **PNG not rendering**: Run `npx playwright install chromium` to ensure the browser is installed.
- **Mini App shows bug icon**: Telegram cached a broken version. The URL includes a `v=timestamp` cache buster that should fix this on next open.
- **No image in chat, just text**: Check logs for "Canvas PNG send failed" - usually means Playwright chromium isn't installed.
