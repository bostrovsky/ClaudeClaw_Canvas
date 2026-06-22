/**
 * Render HTML content to a PNG screenshot using Playwright.
 * Used to send rich canvas content as an image in Telegram chat.
 */

import { chromium, type Browser } from 'playwright';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { logger } from './logger.js';

let browser: Browser | null = null;

async function getBrowser(): Promise<Browser> {
  if (browser && browser.isConnected()) return browser;
  browser = await chromium.launch({ headless: true });
  return browser;
}

/**
 * Render HTML string to a PNG file. Returns the file path.
 * The HTML is wrapped in a dark-themed container matching the canvas style.
 */
export async function renderHtmlToPng(html: string, width = 600): Promise<string | null> {
  try {
    const b = await getBrowser();
    const page = await b.newPage({ viewport: { width, height: 800 } });

    // Wrap content in a styled page
    const fullHtml = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    background: #0f172a;
    color: #cbd5e1;
    padding: 0;
  }
  table { width: 100%; border-collapse: collapse; font-size: 20px; }
  th { padding: 12px 16px; text-align: left; font-weight: 600; font-size: 16px;
       text-transform: uppercase; letter-spacing: 0.5px; color: #94a3b8;
       border-bottom: 2px solid #334155; background: rgba(255,255,255,0.02); }
  td { padding: 12px 16px; border-bottom: 1px solid #1e293b; font-size: 20px; }
  tr:nth-child(even) { background: rgba(255,255,255,0.02); }
  strong { color: #f1f5f9; }
  h1, h2, h3 { color: #f1f5f9; margin: 16px 0 10px; }
  h1 { font-size: 32px; }
  h2 { font-size: 26px; }
  h3 { font-size: 22px; }
  p { margin: 12px 0; line-height: 1.7; font-size: 20px; }
  ul { list-style: none; padding: 0; }
  li { padding: 12px 16px; border-bottom: 1px solid rgba(255,255,255,0.04); font-size: 20px; }
  pre { background: #1e1e1e; padding: 16px; border-radius: 6px; overflow-x: auto;
        font-size: 18px; color: #d4d4d4; line-height: 1.5; }
  code { font-family: 'SF Mono', 'Fira Code', monospace; }
</style>
</head>
<body>${html}</body>
</html>`;

    await page.setContent(fullHtml, { waitUntil: 'networkidle' });

    // Size to content
    const bodyHandle = await page.$('body');
    const box = await bodyHandle?.boundingBox();
    const contentHeight = box ? Math.ceil(box.height) : 400;

    await page.setViewportSize({ width, height: Math.min(contentHeight + 20, 2000) });

    const tmpPath = path.join(os.tmpdir(), `claudeclaw-canvas-${Date.now()}.png`);
    await page.screenshot({
      path: tmpPath,
      clip: { x: 0, y: 0, width, height: Math.min(contentHeight + 20, 2000) },
      type: 'png',
    });

    await page.close();
    return tmpPath;
  } catch (err) {
    logger.error({ err }, 'Failed to render canvas HTML to PNG');
    return null;
  }
}
