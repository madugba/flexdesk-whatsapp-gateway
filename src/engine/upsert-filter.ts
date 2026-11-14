import type { InboundMessage } from './types.js';

/**
 * How old a message can be and still be worth answering. A reply to a message from the middle of last night reads
 * as nonsense, and FlexDesk stops answering messages older than this anyway.
 */
export const OFFLINE_MESSAGE_MAX_AGE_SECONDS = 15 * 60;

/**
 * Whether to pass on a message from WhatsApp's `messages.upsert`.
 *
 * `notify` is a message that arrived while we were connected. `append` is how Baileys labels a message that was
 * waiting for this linked device while it was disconnected -- asleep on a free host, restarting, or reconnecting --
 * and handed over once it came back. Those are real messages from real people who are waiting for an answer, so a
 * recent one is accepted; ignoring them meant a parent's first message after the gateway had been away was simply
 * lost. An old one is skipped, so a long outage can't set off a flood of late replies.
 *
 * Passing a message on twice is harmless: FlexDesk recognises a message id it has already seen.
 */
export function shouldAcceptUpsert(type: string, message: Pick<InboundMessage, 'timestamp'>, nowSeconds: number): boolean {
  if (type === 'notify') return true;
  if (type !== 'append') return false;
  const age = nowSeconds - message.timestamp;
  return age <= OFFLINE_MESSAGE_MAX_AGE_SECONDS;
}
