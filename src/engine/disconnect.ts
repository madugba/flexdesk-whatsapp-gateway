import type { DisconnectDisposition } from './types.js';

// Mirrors Baileys' DisconnectReason without importing it, so this stays unit-testable.
const LOGGED_OUT = 401;
const FORBIDDEN = 403;
const CONNECTION_REPLACED = 440;
const MULTIDEVICE_MISMATCH = 411;
const BAD_SESSION = 500;
const RESTART_REQUIRED = 515;

/**
 * Decides what to do after the connection closed. `paired` is whether the session had
 * ever been linked to a phone: a close before pairing means the QR code expired.
 */
export function classifyDisconnect(code: number | undefined, paired: boolean): DisconnectDisposition {
  if (code === RESTART_REQUIRED) return 'reconnect_now';
  if (code === LOGGED_OUT) return 'logged_out';
  if (code === CONNECTION_REPLACED) return 'replaced';
  if (code === BAD_SESSION || code === MULTIDEVICE_MISMATCH || code === FORBIDDEN) return 'relink';
  if (!paired) return 'qr_expired';
  return 'reconnect';
}

/** Exponential backoff with jitter: about 2s, 4s, 8s ... capped at five minutes. */
export function reconnectDelayMs(attempt: number, random: () => number = Math.random): number {
  const base = Math.min(2_000 * 2 ** Math.max(0, attempt - 1), 300_000);
  return Math.round(base * (0.8 + random() * 0.4));
}
