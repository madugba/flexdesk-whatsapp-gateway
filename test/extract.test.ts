import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { WAMessage } from '@whiskeysockets/baileys';
import { extractInbound } from '../src/engine/message-extract.js';

const base = (overrides: Partial<WAMessage> & { key?: Partial<WAMessage['key']> } = {}): WAMessage => ({
  ...overrides,
  key: { remoteJid: '2348012345678@s.whatsapp.net', id: 'ABC123', fromMe: false, ...overrides.key },
  messageTimestamp: 1_800_000_000,
  pushName: 'Ada',
} as WAMessage);

test('plain and extended text become text messages with the sender phone', () => {
  const plain = extractInbound(base({ message: { conversation: 'How much are fees?' } }));
  assert.deepEqual(plain, {
    messageId: 'ABC123', chatId: '2348012345678@s.whatsapp.net', phone: '2348012345678', pushName: 'Ada',
    timestamp: 1_800_000_000, type: 'text', text: 'How much are fees?',
  });
  const extended = extractInbound(base({ message: { extendedTextMessage: { text: 'hello' } } }));
  assert.equal(extended?.text, 'hello');
  const wrapped = extractInbound(base({ message: { ephemeralMessage: { message: { conversation: 'wrapped' } } } }));
  assert.equal(wrapped?.text, 'wrapped', 'disappearing-message wrapper is unwrapped');
});

test('LID chats keep the exact chat id and use the alternate phone when WhatsApp provides it', () => {
  const withAlt = extractInbound(base({ key: { remoteJid: '99887766@lid', remoteJidAlt: '2348012345678@s.whatsapp.net' }, message: { conversation: 'hi' } }));
  assert.equal(withAlt?.chatId, '99887766@lid');
  assert.equal(withAlt?.phone, '2348012345678');
  const hidden = extractInbound(base({ key: { remoteJid: '99887766@lid' }, message: { conversation: 'hi' } }));
  assert.equal(hidden?.phone, null);
});

test('media and other non-text content is reported as unsupported, not dropped', () => {
  const image = extractInbound(base({ message: { imageMessage: { mimetype: 'image/jpeg' } } }));
  assert.equal(image?.type, 'unsupported');
  assert.equal(image?.text, null);
});

test('our own messages, groups, broadcasts, status, reactions and protocol messages are ignored', () => {
  const text = { conversation: 'x' };
  assert.equal(extractInbound(base({ key: { fromMe: true }, message: text })), null);
  assert.equal(extractInbound(base({ key: { remoteJid: '1203630@g.us' }, message: text })), null);
  assert.equal(extractInbound(base({ key: { remoteJid: 'status@broadcast' }, message: text })), null);
  assert.equal(extractInbound(base({ key: { remoteJid: '123@newsletter' }, message: text })), null);
  assert.equal(extractInbound(base({ message: { reactionMessage: { text: '👍' } } })), null);
  assert.equal(extractInbound(base({ message: { protocolMessage: { type: 0 } } })), null);
  assert.equal(extractInbound(base({ message: undefined })), null);
  assert.equal(extractInbound({ key: {} } as WAMessage), null);
});

test('messages that waited while the gateway was offline are accepted when recent, and old ones are not', async () => {
  const { shouldAcceptUpsert, OFFLINE_MESSAGE_MAX_AGE_SECONDS } = await import('../src/engine/upsert-filter.js');
  const now = 1_800_000_000;
  const aged = (seconds: number) => ({ timestamp: now - seconds });

  assert.equal(shouldAcceptUpsert('notify', aged(0), now), true, 'a live message');
  assert.equal(shouldAcceptUpsert('notify', aged(3_600), now), true, 'live messages are never filtered by age here');

  assert.equal(shouldAcceptUpsert('append', aged(5), now), true, 'a message that arrived as the connection came back');
  assert.equal(shouldAcceptUpsert('append', aged(120), now), true, 'one that waited through a cold start');
  assert.equal(shouldAcceptUpsert('append', aged(OFFLINE_MESSAGE_MAX_AGE_SECONDS), now), true, 'right at the limit');
  assert.equal(shouldAcceptUpsert('append', aged(OFFLINE_MESSAGE_MAX_AGE_SECONDS + 1), now), false, 'too old to be worth answering');
  assert.equal(shouldAcceptUpsert('append', aged(24 * 3_600), now), false, 'yesterday\'s message');
  assert.equal(shouldAcceptUpsert('append', { timestamp: now + 30 }, now), true, 'a clock a little ahead of ours is not a reason to drop it');

  assert.equal(shouldAcceptUpsert('prepend', aged(1), now), false, 'unknown kinds are ignored');
  assert.equal(shouldAcceptUpsert('', aged(1), now), false);
});
