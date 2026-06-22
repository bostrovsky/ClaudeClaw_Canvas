/**
 * Canvas Middleware — single entry point for the canvas response pipeline.
 *
 * Call processCanvasResponse() from bot.ts's response handler.
 * It handles: marker extraction, markdown-to-HTML conversion,
 * canvas push, PNG rendering, and Telegram photo sending.
 *
 * Returns the text to send as a Telegram message (with structured
 * content stripped out, since the PNG covers it).
 */

import fs from 'fs';
import { type Context, InputFile } from 'grammy';
import { CANVAS_URL } from './config.js';
import { emitCanvasEvent } from './canvas.js';
import { renderHtmlToPng } from './canvas-render.js';
import { extractCanvasMarkers, markdownToCanvasHtml, stripStructuredContent } from './canvas-transform.js';
import { logger } from './logger.js';

export interface CanvasResult {
  /** Text to send as a Telegram message (structured content stripped if PNG was sent) */
  telegramText: string;
  /** Whether a PNG image was sent to the chat */
  pngSent: boolean;
}

/**
 * Process a response through the canvas pipeline.
 *
 * 1. Extracts [CANVAS:...] markers (explicit agent directives)
 * 2. Auto-converts remaining markdown to styled HTML
 * 3. Pushes to canvas SSE channel
 * 4. Renders HTML to PNG via Playwright
 * 5. Sends PNG as a Telegram photo with "Open in Canvas" button
 * 6. Returns stripped text for any remaining Telegram message
 */
export async function processCanvasResponse(
  responseText: string,
  chatId: string,
  ctx: Context,
): Promise<CanvasResult> {
  // If canvas isn't configured, pass through unchanged
  if (!CANVAS_URL) {
    return { telegramText: responseText, pngSent: false };
  }

  // Step 1: Extract explicit [CANVAS:...] markers
  const { text: afterMarkers, payloads: markerPayloads } = extractCanvasMarkers(responseText);
  for (const payload of markerPayloads) {
    emitCanvasEvent(chatId, payload);
  }

  // Step 2: Auto-convert remaining text to styled HTML
  let canvasHtml: string | null = null;
  if (markerPayloads.length === 0) {
    canvasHtml = markdownToCanvasHtml(afterMarkers);
    if (canvasHtml) {
      emitCanvasEvent(chatId, { type: 'html', content: canvasHtml });
    }
  }

  // If no canvas content was generated, pass through unchanged
  const htmlContent = canvasHtml || markerPayloads.find(p => p.type === 'html')?.content;
  if (!htmlContent) {
    return { telegramText: afterMarkers, pngSent: false };
  }

  // Step 3: Render to PNG and send as Telegram photo
  let pngSent = false;
  try {
    const pngPath = await renderHtmlToPng(htmlContent);
    if (pngPath) {
      const { InlineKeyboard } = await import('grammy');
      const canvasUrl = `${CANVAS_URL}${CANVAS_URL.includes('?') ? '&' : '?'}chatId=${chatId}&v=${Date.now()}`;
      const keyboard = new InlineKeyboard().webApp('Open in Canvas', canvasUrl);

      await ctx.replyWithPhoto(new InputFile(pngPath), { reply_markup: keyboard });
      pngSent = true;
      fs.unlink(pngPath, () => {});
    }
  } catch (err) {
    logger.error({ err }, 'Canvas PNG send failed, falling back to text');
  }

  // Step 4: Return appropriate text for Telegram
  if (pngSent) {
    return { telegramText: '', pngSent: true };
  }

  // PNG failed — send stripped text as fallback
  return { telegramText: stripStructuredContent(afterMarkers), pngSent: false };
}
