---
name: install-canvas
description: Enable ClaudeClaw Canvas - rich content rendering via Telegram Mini App. Converts agent responses to styled visuals (tables, charts, code) delivered as PNG images in chat with an interactive Mini App canvas. Canvas is now a built-in plugin; this skill configures it.
argument-hint: ""
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, AskUserQuestion
user-invocable: true
---

# Enable ClaudeClaw Canvas

Canvas is now a **built-in plugin** in ClaudeClaw OS (`plugins/canvas/`), loaded
through the plugin architecture. There is **nothing to clone and no `install.sh`
to run** — no file copies into `src/`, no `sed` patches, no `bot.ts` wiring.
Your job is to configure it and restart.

## What this does

Adds rich content rendering. Agent responses with structured data (tables, lists,
code, comparisons) are automatically:
1. Converted to styled, dark-themed HTML
2. Rendered to a PNG screenshot (via Playwright)
3. Sent as a photo in the Telegram chat
4. Streamed to a persistent Telegram Mini App canvas for interactive viewing

## Steps

### Step 1: Confirm the Canvas plugin is present

```bash
PROJECT_ROOT=$(git rev-parse --show-toplevel 2>/dev/null)
ls "$PROJECT_ROOT/plugins/canvas/plugin.ts"
```

If that file exists, Canvas is built in — continue to Step 2. If it does NOT
exist, this ClaudeClaw OS predates the plugin loader; fall back to the legacy
`sed` installer (`bash ClaudeClaw_Canvas/install.sh`), which is **deprecated** —
recommend the user upgrade ClaudeClaw OS to a version with the plugin loader.

### Step 2: Configure the tenant .env

Ask the user for their Tailscale hostname or tunnel URL, then add to the tenant `.env`:

```
CANVAS_PORT=3144
CANVAS_URL=https://<hostname>:3144
```

For multi-tenant setups, each tenant gets a different port (3144, 3145, 3146...).

### Step 3: Expose the canvas port

```bash
tailscale funnel --bg --https=3144 http://127.0.0.1:3144
```

Or for Cloudflare:
```bash
cloudflared tunnel --url http://localhost:3144
```

### Step 4: Install the renderer (once per machine)

```bash
npx playwright install chromium
```

### Step 5: Build and restart

```bash
cd "$PROJECT_ROOT"
npm run build
launchctl kickstart -k gui/$(id -u)/com.claudeclaw.<tenant>
```

### Step 6: Verify

```bash
# Plugin loaded?
grep "plugin] loaded canvas" /tmp/claudeclaw-<tenant>.log | tail -1
# Canvas server answering? (main process only)
curl -s http://127.0.0.1:3144/ | head -2   # should return <!DOCTYPE html>
```

Tell the user to send a message to their bot that would produce structured data
(like "compare the weather in two cities") and verify they see a PNG image in the
chat with an "Open in Canvas" button.

## Troubleshooting

- **Port in use**: The canvas server retries 5 times with backoff. If it still fails, check `lsof -iTCP:3144` for conflicts.
- **PNG not rendering**: Run `npx playwright install chromium` to ensure the browser is installed.
- **Mini App shows bug icon / blank**: Telegram cached a broken version. The asset URLs carry a `?v=` cache buster; force-close and reopen the Mini App.
- **Unreadable / light-mode colors**: Canvas pins a dark theme; if you see light-on-light, the client cached an old stylesheet — force-close and reopen.
- **No image in chat, just text**: Check logs for "Canvas PNG send failed" — usually means Playwright chromium isn't installed.
- **Plugin didn't load**: confirm `plugins/canvas/plugin.js` exists after `npm run build`, and check the startup log for a `Failed to load plugin canvas` error.
