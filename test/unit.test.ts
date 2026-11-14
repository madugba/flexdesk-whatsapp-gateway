import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { loadConfig } from '../src/config.js';
import { classifyDisconnect, reconnectDelayMs } from '../src/engine/disconnect.js';
import { parseRecipient, phoneFromJid } from '../src/engine/jid.js';
import { createApiKeyVerifier } from '../src/http/api-key-auth.js';
import { errors } from '../src/lib/errors.js';
import { SecretBox } from '../src/lib/secret-box.js';
import { SendQueue } from '../src/sessions/send-queue.js';
import { retryDelaySeconds } from '../src/webhooks/dispatcher.js';
import { signBody, verifySignature } from '../src/webhooks/signature.js';
import { testConfig, TEST_API_KEY } from './helpers/env.js';

const key = () => randomBytes(32).toString('base64');

test('secret box: round trip, fresh nonce, tamper and context binding', () => {
  const box = new SecretBox(key());
  const sealed = box.seal(Buffer.from('secret'), 's1/creds');
  assert.equal(box.open(sealed, 's1/creds').toString(), 'secret');
  assert.notDeepEqual(box.seal(Buffer.from('secret'), 's1/creds'), sealed);

  assert.throws(() => box.open(sealed, 's2/creds'), 'moved to another row');
  const tampered = Buffer.from(sealed);
  tampered[tampered.length - 1] = (tampered[tampered.length - 1] as number) ^ 1;
  assert.throws(() => box.open(tampered, 's1/creds'));
  assert.throws(() => new SecretBox(key()).open(sealed, 's1/creds'), 'different key');
  assert.throws(() => new SecretBox(Buffer.alloc(8).toString('base64')));
});

test('signature: valid, tampered body, wrong secret, stale and malformed headers', () => {
  const body = '{"a":1}';
  const now = 1_800_000_000;
  const header = signBody('s'.repeat(32), body, now);
  assert.equal(verifySignature('s'.repeat(32), body, header, now), true);
  assert.equal(verifySignature('s'.repeat(32), '{"a":2}', header, now), false);
  assert.equal(verifySignature('x'.repeat(32), body, header, now), false);
  assert.equal(verifySignature('s'.repeat(32), body, header, now + 301), false, 'replay outside tolerance');
  assert.equal(verifySignature('s'.repeat(32), body, header, now + 299), true);
  for (const bad of [undefined, null, '', 'garbage', 't=abc,v1=00', `t=${now}`, `t=${now},v1=zz`]) {
    assert.equal(verifySignature('s'.repeat(32), body, bad, now), false);
  }
});

test('recipients: phone numbers and user ids accepted; groups and junk rejected', () => {
  assert.deepEqual(parseRecipient('2348012345678'), { jid: '2348012345678@s.whatsapp.net', phone: '2348012345678' });
  assert.deepEqual(parseRecipient(' 2348012345678 '), { jid: '2348012345678@s.whatsapp.net', phone: '2348012345678' });
  assert.deepEqual(parseRecipient('2348012345678@s.whatsapp.net'), { jid: '2348012345678@s.whatsapp.net', phone: '2348012345678' });
  assert.deepEqual(parseRecipient('1234567890123@lid'), { jid: '1234567890123@lid', phone: null });
  for (const bad of ['', '0801234567', '+2348012345678', '12345', '120363@g.us', 'status@broadcast', '2348012345678:5@s.whatsapp.net', 'abc@lid', '2348012345678@evil.com']) {
    assert.equal(parseRecipient(bad), null, bad);
  }
  assert.equal(phoneFromJid('2348012345678:12@s.whatsapp.net'), '2348012345678');
  assert.equal(phoneFromJid('99@lid'), null);
});

test('disconnects are classified so we never fight WhatsApp or loop on a dead session', () => {
  assert.equal(classifyDisconnect(515, false), 'reconnect_now');
  assert.equal(classifyDisconnect(401, true), 'logged_out');
  assert.equal(classifyDisconnect(440, true), 'replaced');
  for (const code of [500, 411, 403]) assert.equal(classifyDisconnect(code, true), 'relink');
  assert.equal(classifyDisconnect(408, false), 'qr_expired');
  assert.equal(classifyDisconnect(undefined, false), 'qr_expired');
  assert.equal(classifyDisconnect(408, true), 'reconnect');
  assert.equal(classifyDisconnect(503, true), 'reconnect');
});

test('backoff grows, is capped and stays jittered', () => {
  const mid = () => 0.5;
  assert.deepEqual([1, 2, 3, 4].map((attempt) => reconnectDelayMs(attempt, mid)), [2000, 4000, 8000, 16000]);
  assert.equal(reconnectDelayMs(50, mid), 300_000);
  assert.ok(reconnectDelayMs(3, () => 0) < reconnectDelayMs(3, () => 1));
  assert.deepEqual([0, 1, 2].map((attempts) => retryDelaySeconds(attempts, mid)), [5, 10, 20]);
  assert.equal(retryDelaySeconds(40, mid), 3600);
});

test('api keys: constant-time check accepts either rotated key and nothing else', () => {
  const verify = createApiKeyVerifier(['k'.repeat(40), 'n'.repeat(40)]);
  assert.equal(verify(`Bearer ${'k'.repeat(40)}`), true);
  assert.equal(verify(`Bearer ${'n'.repeat(40)}`), true);
  for (const bad of [undefined, '', 'Bearer', 'Bearer ', `Bearer ${'k'.repeat(39)}`, `bearer ${'k'.repeat(40)}`, 'k'.repeat(40), `Bearer ${'k'.repeat(41)}`]) {
    assert.equal(verify(bad), false, String(bad));
  }
});

test('config: rejects weak or malformed settings with readable messages', () => {
  const base = {
    DATABASE_URL: 'postgresql://x', GATEWAY_API_KEYS: TEST_API_KEY, GATEWAY_ENCRYPTION_KEY: key(),
    WEBHOOK_URL: 'https://flexdesk.example/hook', WEBHOOK_SECRET: 'w'.repeat(32),
  };
  assert.equal(loadConfig(base).DB_SCHEMA, 'wa_gateway');
  assert.throws(() => loadConfig({ ...base, GATEWAY_API_KEYS: 'short' }), /at least 32/);
  assert.throws(() => loadConfig({ ...base, GATEWAY_API_KEYS: 'a'.repeat(32) + ',' + 'b'.repeat(32) + ',' + 'c'.repeat(32) }));
  assert.throws(() => loadConfig({ ...base, GATEWAY_ENCRYPTION_KEY: 'abc' }), /32 random bytes/);
  assert.throws(() => loadConfig({ ...base, WEBHOOK_SECRET: 'short' }), /at least 32/);
  assert.throws(() => loadConfig({ ...base, WEBHOOK_URL: 'http://flexdesk.example/hook' }), /https in production/);
  assert.doesNotThrow(() => loadConfig({ ...base, WEBHOOK_URL: 'http://localhost:3000/hook' }));
  assert.throws(() => loadConfig({ ...base, DB_SCHEMA: 'x"; DROP TABLE y;--' }), /lowercase identifier/);
  assert.throws(() => loadConfig({ ...base, DATABASE_URL: '' }));
  assert.equal(testConfig().SEND_MIN_INTERVAL_MS, 0);
});

test('send queue: serial order, spacing, capacity and hourly cap', async () => {
  let clock = 0;
  const sleeps: number[] = [];
  const queue = new SendQueue({
    maxQueued: 2, maxPerHour: 4, minIntervalMs: 1000, random: () => 0,
    now: () => clock,
    sleep: async (ms) => { sleeps.push(ms); clock += ms; },
  });
  const order: number[] = [];
  const first = queue.run(async () => { order.push(1); return 'a'; });
  const second = queue.run(async () => { order.push(2); return 'b'; });
  assert.throws(() => queue.run(async () => 'c'), (error: unknown) => (error as { code?: string }).code === 'queue_full');
  assert.deepEqual(await Promise.all([first, second]), ['a', 'b']);
  assert.deepEqual(order, [1, 2]);
  assert.ok(sleeps.some((ms) => ms > 0), 'second send waited for the spacing interval');

  await queue.run(async () => 'c');
  await queue.run(async () => 'd');
  assert.throws(() => queue.run(async () => 'e'), (error: unknown) => (error as { code?: string }).code === 'rate_limited');
  clock += 3_600_001;
  assert.equal(await queue.run(async () => 'f'), 'f');

  const failing = queue.run(async () => { throw new Error('x'); });
  await assert.rejects(failing);
  assert.equal(await queue.run(async () => 'after failure'), 'after failure', 'a failure does not wedge the queue');
  assert.equal(errors.queueFull().httpStatus, 429);
});
