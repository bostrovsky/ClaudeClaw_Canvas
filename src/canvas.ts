/**
 * Canvas Channel — in-memory state management for the ClaudeClaw Canvas.
 *
 * Manages per-tenant ring buffers of pushed content and provides
 * event subscription for real-time SSE streaming to the Mini App.
 * Also handles Telegram initData HMAC-SHA256 validation.
 */

import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';

// ── Types ────────────────────────────────────────────────────────────

export interface CanvasPayload {
  type: 'html' | 'markdown' | 'table' | 'chart' | 'clear';
  content: string;
  title?: string;
  seq: number;
  timestamp: number;
}

export interface TelegramUser {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
  language_code?: string;
}

// ── CanvasChannel (per-tenant ring buffer + event emitter) ───────────

const BUFFER_SIZE = 50;

export class CanvasChannel {
  private buffer: CanvasPayload[] = [];
  private seq = 0;
  private emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(20);
  }

  push(payload: Omit<CanvasPayload, 'seq' | 'timestamp'>): CanvasPayload {
    const full: CanvasPayload = {
      ...payload,
      seq: ++this.seq,
      timestamp: Date.now(),
    };

    if (payload.type === 'clear') {
      this.buffer = [];
    } else {
      this.buffer.push(full);
      if (this.buffer.length > BUFFER_SIZE) {
        this.buffer.shift();
      }
    }

    this.emitter.emit('push', full);
    return full;
  }

  getState(): CanvasPayload[] {
    return [...this.buffer];
  }

  getSeq(): number {
    return this.seq;
  }

  onPush(handler: (payload: CanvasPayload) => void): () => void {
    this.emitter.on('push', handler);
    return () => { this.emitter.off('push', handler); };
  }
}

// ── Channel registry (keyed by chatId) ──────────────────────────────

const channels = new Map<string, CanvasChannel>();

export function getCanvasChannel(chatId: string): CanvasChannel {
  let ch = channels.get(chatId);
  if (!ch) {
    ch = new CanvasChannel();
    channels.set(chatId, ch);
  }
  return ch;
}

export function emitCanvasEvent(
  chatId: string,
  payload: Omit<CanvasPayload, 'seq' | 'timestamp'>,
): CanvasPayload {
  const channel = getCanvasChannel(chatId);
  return channel.push(payload);
}

// ── Telegram initData HMAC-SHA256 validation ────────────────────────

/**
 * Validates Telegram Mini App initData using HMAC-SHA256.
 * See: https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 *
 * Returns the user object if valid, null otherwise.
 */
export function validateTelegramInitData(
  initData: string,
  botToken: string,
  maxAgeSeconds = 86400,
): TelegramUser | null {
  if (!initData || !botToken) return null;

  try {
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    if (!hash) return null;

    params.delete('hash');

    const dataCheckString = [...params.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join('\n');

    const secretKey = crypto
      .createHmac('sha256', 'WebAppData')
      .update(botToken)
      .digest();

    const computedHash = crypto
      .createHmac('sha256', secretKey)
      .update(dataCheckString)
      .digest('hex');

    if (hash.length !== computedHash.length) return null;
    if (!crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(computedHash))) {
      return null;
    }

    const authDate = params.get('auth_date');
    if (authDate) {
      const age = Math.floor(Date.now() / 1000) - parseInt(authDate, 10);
      if (age > maxAgeSeconds) return null;
    }

    const userStr = params.get('user');
    if (!userStr) return null;

    return JSON.parse(userStr) as TelegramUser;
  } catch {
    return null;
  }
}
