/**
 * ClaudeClaw Canvas — Rich content rendering for Telegram via Mini App.
 *
 * Public API: everything you need to add Canvas to a ClaudeClaw instance.
 */

export { CanvasChannel, CanvasPayload, TelegramUser, getCanvasChannel, emitCanvasEvent, validateTelegramInitData } from './canvas.js';
export { startCanvasServer, CanvasServerConfig } from './canvas-server.js';
export { renderHtmlToPng } from './canvas-render.js';
export { extractCanvasMarkers, markdownToCanvasHtml, stripStructuredContent, CanvasMarkerResult, CanvasPayloadInput } from './canvas-transform.js';
export { processCanvasResponse, CanvasResult } from './canvas-middleware.js';
