import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/http/server.js';
import { MAX_DOCUMENT_BYTES } from '../src/http/document-body.js';
import { createTestDb, type TestDb } from './helpers/db.js';
import { TEST_API_KEY } from './helpers/env.js';
import { eventually } from './helpers/fake-engine.js';
import { createManager } from './helpers/manager.js';

const PHONE = '2348012345678';
const CHAT = `${PHONE}@s.whatsapp.net`;
const SESSION = 'school-0001';
const URL = `/v1/sessions/${SESSION}/documents`;
const auth = { authorization: `Bearer ${TEST_API_KEY}` };

let t: TestDb;
let h: ReturnType<typeof createManager>;
let app: FastifyInstance;

const pdf = (bytes = 200) => Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(bytes, 0x41)]);
const body = (overrides: Record<string, unknown> = {}) => ({
  to: PHONE,
  fileName: 'Second Term Result - Ada O.pdf',
  mimeType: 'application/pdf',
  data: pdf().toString('base64'),
  caption: "Ada's Second Term result",
  idempotencyKey: `idem-${Math.random().toString(36).slice(2, 12)}`,
  ...overrides,
});
const post = (payload: unknown) => app.inject({ method: 'POST', url: URL, headers: auth, payload: payload as object });

before(async () => {
  t = await createTestDb();
  h = createManager(t);
  await h.manager.activate();
  app = await buildServer({ manager: h.manager, outbox: h.outbox, isLeader: () => true, apiKeys: [TEST_API_KEY], logger: t.logger });

  await h.manager.create(SESSION);
  await eventually(() => h.engines.created.some((e) => e.started));
  const engine = h.engines.latest(SESSION);
  engine.emit({ type: 'open', phone: '2349000000001' });
  await eventually(async () => (await h.manager.get(SESSION)).status === 'open');
  engine.emit({ type: 'message', message: { messageId: 'M1', chatId: CHAT, phone: PHONE, pushName: null, timestamp: Math.floor(Date.now() / 1000), type: 'text', text: 'hi' } });
  await eventually(async () => (await h.events('message.received')).length === 1);
});
after(async () => { await app.close(); await h.manager.deactivate(); await t.cleanup(); });

test('a PDF is sent to someone who messaged within the window, with its name and caption, after a typing pause', async () => {
  const engine = h.engines.latest(SESSION);
  const response = await post(body());
  assert.equal(response.statusCode, 200);
  assert.deepEqual(Object.keys(response.json()).sort(), ['chatId', 'messageId']);

  const sent = engine.documents.at(-1)!;
  assert.equal(sent.chatId, CHAT);
  assert.equal(sent.document.fileName, 'Second Term Result - Ada O.pdf');
  assert.equal(sent.document.mimeType, 'application/pdf');
  assert.equal(sent.document.caption, "Ada's Second Term result");
  assert.deepEqual(sent.document.data, pdf());
  assert.ok(engine.presences.includes(`composing:${CHAT}`) && engine.presences.includes(`paused:${CHAT}`));
});

test('a document needs no caption', async () => {
  const { caption: _unused, ...rest } = body();
  void _unused;
  const response = await post(rest);
  assert.equal(response.statusCode, 200);
  assert.equal(h.engines.latest(SESSION).documents.at(-1)!.document.caption, undefined);
});

test('the same guards as text: reply window, idempotency, and failure releases the key', async () => {
  const engine = h.engines.latest(SESSION);

  const stranger = await post(body({ to: '2348099999999' }));
  assert.equal(stranger.statusCode, 422);
  assert.equal(stranger.json().error.code, 'outside_reply_window');
  assert.equal((await post(body({ to: '120363@g.us' }))).json().error.code, 'invalid_recipient');

  const before = engine.documents.length;
  const once = body({ idempotencyKey: 'idem-doc-0001' });
  const a = await post(once);
  const b = await post(once);
  assert.equal(a.json().messageId, b.json().messageId);
  assert.equal(engine.documents.length, before + 1, 'a retried request does not send the file twice');

  engine.failNextSend = true;
  const failing = body({ idempotencyKey: 'idem-doc-0002' });
  assert.equal((await post(failing)).json().error.code, 'send_failed');
  assert.equal((await post(failing)).statusCode, 200, 'a failed send can be retried with the same key');

  assert.equal((await app.inject({ method: 'POST', url: `/v1/sessions/missing-0001/documents`, headers: auth, payload: body() })).json().error.code, 'session_not_found');
});

test('only real PDFs of a sensible size and a plain name are accepted', async () => {
  const engine = h.engines.latest(SESSION);
  const before = engine.documents.length;

  const refused: Array<[string, Record<string, unknown>, string]> = [
    ['not a PDF', { data: Buffer.from('MZ-this-is-an-exe-pretending').toString('base64') }, 'invalid_document'],
    ['too large', { data: pdf(MAX_DOCUMENT_BYTES).toString('base64') }, 'invalid_document'],
    ['wrong type', { mimeType: 'image/png' }, 'invalid_request'],
    ['not base64', { data: 'not base64 at all!!' }, 'invalid_request'],
    ['empty', { data: '' }, 'invalid_request'],
    ['no extension', { fileName: 'result' }, 'invalid_request'],
    ['path in the name', { fileName: '../../etc/passwd.pdf' }, 'invalid_request'],
    ['exe name', { fileName: 'result.pdf.exe' }, 'invalid_request'],
    ['unknown field', { url: 'http://169.254.169.254/' }, 'invalid_request'],
    ['caption too long', { caption: 'x'.repeat(1025) }, 'invalid_request'],
    ['weak key', { idempotencyKey: 'short' }, 'invalid_request'],
  ];
  for (const [label, overrides, code] of refused) {
    const response = await post(body(overrides));
    assert.ok(response.statusCode === 422, `${label}: ${response.statusCode}`);
    assert.equal(response.json().error.code, code, label);
    assert.ok(!response.body.includes('at '), `${label}: no stack trace`);
  }
  assert.equal(engine.documents.length, before, 'nothing refused was sent');
});

test('this route takes a large body, and everything past its own limit is refused outright', async () => {
  const response = await post(body({ data: pdf(1_000_000).toString('base64') }));
  assert.equal(response.statusCode, 200, 'a 1 MB file is fine, though the default body limit is 64 KB');

  const huge = await app.inject({ method: 'POST', url: URL, headers: { ...auth, 'content-type': 'application/json' }, payload: JSON.stringify({ data: 'A'.repeat(8 * 1024 * 1024) }) });
  assert.equal(huge.statusCode, 413);

  const messages = await app.inject({ method: 'POST', url: `/v1/sessions/${SESSION}/messages`, headers: { ...auth, 'content-type': 'application/json' }, payload: JSON.stringify({ to: PHONE, text: 'x'.repeat(70_000) }) });
  assert.equal(messages.statusCode, 413, 'other routes keep the small limit');
});

test('the document route needs the API key', async () => {
  const response = await app.inject({ method: 'POST', url: URL, payload: body() });
  assert.equal(response.statusCode, 401);
});
