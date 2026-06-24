#!/bin/bash
# ClaudeClaw Canvas — One-command installer
# Run from your ClaudeClaw OS root directory:
#   bash /path/to/ClaudeClaw_Canvas/install.sh
#
# Or clone and install:
#   git clone https://github.com/bostrovsky/ClaudeClaw_Canvas.git
#   bash ClaudeClaw_Canvas/install.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CLAW_DIR="$(pwd)"

# ── Verify we're in a ClaudeClaw directory ────────────────────────────
if [ ! -f "$CLAW_DIR/src/bot.ts" ] || [ ! -f "$CLAW_DIR/src/index.ts" ]; then
  echo "Error: Run this from your ClaudeClaw OS root directory."
  echo "  cd /path/to/claudeclaw-os && bash $0"
  exit 1
fi

# ── DEPRECATED: Canvas is now a built-in plugin ───────────────────────
# This sed-based installer copies files into src/ and patches bot.ts/
# config.ts/index.ts. It exists only for ClaudeClaw versions that predate
# the plugin loader. On a current ClaudeClaw OS, Canvas already ships in
# plugins/canvas/ — just set CANVAS_URL/CANVAS_PORT in .env and rebuild.
if [ -f "$CLAW_DIR/plugins/canvas/plugin.ts" ] || [ -f "$CLAW_DIR/plugins/canvas/plugin.js" ]; then
  echo "Canvas is already built in as a plugin (plugins/canvas/). The sed-based"
  echo "installer is deprecated and unnecessary here. To enable Canvas:"
  echo "  1. set CANVAS_URL / CANVAS_PORT in your tenant .env"
  echo "  2. tailscale funnel --bg --https=3144 http://127.0.0.1:3144"
  echo "  3. npx playwright install chromium"
  echo "  4. npm run build && restart the tenant"
  echo "See docs/PLUGINS.md. Re-run with CANVAS_FORCE_LEGACY_INSTALL=1 to override."
  [ "${CANVAS_FORCE_LEGACY_INSTALL:-}" = "1" ] || exit 1
fi

echo "WARNING: running the DEPRECATED sed-based Canvas installer."
echo "Installing ClaudeClaw Canvas into $CLAW_DIR"

# ── Copy source files ────────────────────────────────────────────────
echo "  Copying source files..."
for f in canvas.ts canvas-server.ts canvas-transform.ts canvas-render.ts canvas-middleware.ts; do
  cp "$SCRIPT_DIR/src/$f" "$CLAW_DIR/src/$f"
done

# ── Copy web frontend ───────────────────────────────────────────────
echo "  Copying Mini App frontend..."
mkdir -p "$CLAW_DIR/web/public/canvas"
cp "$SCRIPT_DIR/web/index.html" "$CLAW_DIR/web/public/canvas/"
cp "$SCRIPT_DIR/web/canvas.js" "$CLAW_DIR/web/public/canvas/"
cp "$SCRIPT_DIR/web/canvas.css" "$CLAW_DIR/web/public/canvas/"

# ── Add env vars to config.ts ───────────────────────────────────────
echo "  Patching config.ts..."
if ! grep -q "CANVAS_URL" "$CLAW_DIR/src/config.ts"; then
  # Add CANVAS_URL and CANVAS_PORT to the env read list
  sed -i.bak "s/'ENABLE_ACP',/'ENABLE_ACP',\n  'CANVAS_URL',\n  'CANVAS_PORT',/" "$CLAW_DIR/src/config.ts"

  # Add the config exports after DASHBOARD_URL
  sed -i.bak '/^export const DASHBOARD_URL/a\
\
// Canvas — Telegram Mini App for rich content rendering (separate port)\
export const CANVAS_URL = process.env.CANVAS_URL || envConfig.CANVAS_URL || '\'''\'';\
export const CANVAS_PORT = parseInt(process.env.CANVAS_PORT || envConfig.CANVAS_PORT || '\''3144'\'', 10);' "$CLAW_DIR/src/config.ts"

  rm -f "$CLAW_DIR/src/config.ts.bak"
  echo "    Added CANVAS_URL and CANVAS_PORT to config.ts"
else
  echo "    CANVAS_URL already in config.ts, skipping"
fi

# ── Patch index.ts to start canvas server ────────────────────────────
echo "  Patching index.ts..."
if ! grep -q "canvas-server" "$CLAW_DIR/src/index.ts"; then
  # Add canvas server startup after dashboard start
  sed -i.bak '/startDashboard(bot\.api);/a\
\
    // Canvas Mini App server (separate port, exposed via Tailscale Funnel)\
    const { startCanvasServer } = await import('\''./canvas-server.js'\'');\
    startCanvasServer();' "$CLAW_DIR/src/index.ts"

  rm -f "$CLAW_DIR/src/index.ts.bak"
  echo "    Added canvas server startup to index.ts"
else
  echo "    Canvas server already in index.ts, skipping"
fi

# ── Patch bot.ts to use canvas middleware ─────────────────────────────
echo "  Patching bot.ts..."
if ! grep -q "canvas-middleware" "$CLAW_DIR/src/bot.ts"; then
  # Add import
  sed -i.bak '/import.*state\.js/a\
import { processCanvasResponse } from '\''./canvas-middleware.js'\'';' "$CLAW_DIR/src/bot.ts"

  # Add CANVAS_URL to config import if not present
  if ! grep -q "CANVAS_URL" "$CLAW_DIR/src/bot.ts"; then
    sed -i.bak 's/DASHBOARD_URL,/DASHBOARD_URL,\n  CANVAS_URL,/' "$CLAW_DIR/src/bot.ts"
  fi

  rm -f "$CLAW_DIR/src/bot.ts.bak"
  echo "    Added canvas middleware import to bot.ts"
  echo ""
  echo "  NOTE: You still need to manually wire processCanvasResponse() into"
  echo "  your bot's response pipeline. See README.md for the integration code."
  echo "  This is a 5-line change in bot.ts's handleMessage function."
else
  echo "    Canvas middleware already in bot.ts, skipping"
fi

# ── Patch bot.ts for menu button ─────────────────────────────────────
if ! grep -q "setChatMenuButton" "$CLAW_DIR/src/bot.ts"; then
  # Add menu button setup after setMyCommands
  sed -i.bak '/bot\.api\.setMyCommands(allCommands)/a\
\
  // Set canvas as the persistent menu button (Mini App launcher)\
  if (CANVAS_URL) {\
    const canvasMenuUrl = `${CANVAS_URL}${CANVAS_URL.includes('\''?'\'') ? '\''&'\'' : '\''?'\''}chatId=${ALLOWED_CHAT_ID}&v=${Date.now()}`;\
    bot.api.setChatMenuButton({\
      menu_button: { type: '\''web_app'\'', text: '\''Canvas'\'', web_app: { url: canvasMenuUrl } },\
    }).catch(() => {});\
  }' "$CLAW_DIR/src/bot.ts"

  rm -f "$CLAW_DIR/src/bot.ts.bak"
  echo "    Added canvas menu button to bot.ts"
else
  echo "    Menu button already in bot.ts, skipping"
fi

# ── Install Playwright chromium if needed ────────────────────────────
echo "  Checking Playwright..."
if ! npx playwright --version > /dev/null 2>&1; then
  echo "    Installing Playwright..."
  npm install playwright
fi
npx playwright install chromium 2>/dev/null || true

# ── Build ────────────────────────────────────────────────────────────
echo "  Building..."
npm run build 2>&1 | tail -3

echo ""
echo "============================================"
echo "  ClaudeClaw Canvas installed successfully!"
echo "============================================"
echo ""
echo "Next steps:"
echo ""
echo "  1. Add to your tenant .env:"
echo "     CANVAS_PORT=3144"
echo "     CANVAS_URL=https://your-host.ts.net:3144"
echo ""
echo "  2. Expose the canvas port publicly:"
echo "     tailscale funnel --bg --https=3144 http://127.0.0.1:3144"
echo ""
echo "  3. Wire processCanvasResponse() into bot.ts"
echo "     (see README.md section 4 for the 5-line change)"
echo ""
echo "  4. Restart your service:"
echo "     launchctl kickstart -k gui/\$(id -u)/com.claudeclaw.<tenant>"
echo ""
