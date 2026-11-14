import { createHmac, timingSafeEqual } from 'node:crypto';

export const SIGNATURE_HEADER = 'x-gateway-signature';
export const DEFAULT_TOLERANCE_SECONDS = 300;

function digest(secret: string, timestamp: number, body: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}

/** Header value: `t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>">`. */
export function signBody(secret: string, body: string, timestamp: number = Math.floor(Date.now() / 1000)): string {
  return `t=${timestamp},v1=${digest(secret, timestamp, body)}`;
}

/**
 * Receiver-side check, kept here as the reference implementation (and for the tests).
 * Rejects bad signatures and timestamps outside the tolerance, which stops replays.
 */
export function verifySignature(
  secret: string,
  body: string,
  header: string | null | undefined,
  nowSeconds: number = Math.floor(Date.now() / 1000),
  toleranceSeconds: number = DEFAULT_TOLERANCE_SECONDS,
): boolean {
  const parts = Object.fromEntries((header ?? '').split(',').map((part) => part.trim().split('=') as [string, string]));
  const timestamp = Number(parts.t);
  const provided = parts.v1;
  if (!Number.isInteger(timestamp) || !provided) return false;
  if (Math.abs(nowSeconds - timestamp) > toleranceSeconds) return false;

  const expected = Buffer.from(digest(secret, timestamp, body), 'hex');
  const actual = Buffer.from(provided, 'hex');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
