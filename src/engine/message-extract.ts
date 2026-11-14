import type { WAMessage } from '@whiskeysockets/baileys';
import { extractMessageContent } from '@whiskeysockets/baileys';
import type { InboundMessage } from './types.js';
import { phoneFromJid } from './jid.js';

const IGNORED_CHATS = ['@g.us', '@broadcast', '@newsletter', '@bot'];

function toSeconds(timestamp: WAMessage['messageTimestamp']): number {
  if (typeof timestamp === 'number') return timestamp;
  if (timestamp && typeof timestamp === 'object' && 'toNumber' in timestamp) return timestamp.toNumber();
  return Math.floor(Date.now() / 1000);
}

function textOf(content: NonNullable<WAMessage['message']>): string | null {
  return (
    content.conversation ??
    content.extendedTextMessage?.text ??
    content.buttonsResponseMessage?.selectedDisplayText ??
    content.listResponseMessage?.title ??
    content.templateButtonReplyMessage?.selectedDisplayText ??
    null
  );
}

/**
 * Turns a raw WhatsApp message into the gateway's inbound shape, or returns null for
 * anything that is not a one-to-one message from a person: our own messages, groups,
 * broadcasts and status updates, and protocol/reaction messages.
 */
export function extractInbound(message: WAMessage): InboundMessage | null {
  const { key } = message;
  const chatId = key?.remoteJid;
  const messageId = key?.id;
  if (!key || key.fromMe || !chatId || !messageId) return null;
  if (chatId === 'status@broadcast' || IGNORED_CHATS.some((suffix) => chatId.endsWith(suffix))) return null;

  const content = extractMessageContent(message.message);
  if (!content) return null;
  const text = textOf(content);
  const isPlumbing = content.protocolMessage || content.reactionMessage || content.senderKeyDistributionMessage;
  if (text === null && isPlumbing) return null;

  return {
    messageId,
    chatId,
    phone: phoneFromJid(chatId) ?? phoneFromJid(key.remoteJidAlt),
    pushName: message.pushName ?? null,
    timestamp: toSeconds(message.messageTimestamp),
    type: text === null ? 'unsupported' : 'text',
    text,
  };
}
