import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { createTestDb, type TestDb } from './helpers/db.js';
import { eventually } from './helpers/fake-engine.js';
import { createManager } from './helpers/manager.js';

let t: TestDb;
let h: ReturnType<typeof createManager>;
before(async () => { t = await createTestDb(); });
after(async () => { await h?.manager.deactivate(); await t.cleanup(); });
beforeEach(async () => {
  await h?.manager.deactivate();
  for (const table of ['webhook_outbox', 'sessions']) await t.db.pool.query(`DELETE FROM ${t.db.table(table)}`);
  h = createManager(t);
  await h.manager.activate();
});

const PHONE = '2348012345678';
const incoming = (id: string, over: Record<string, unknown> = {}) => ({
  type: 'message' as const,
  message: { messageId: id, chatId: `${PHONE}@s.whatsapp.net`, phone: PHONE, pushName: 'Ada', timestamp: Math.floor(Date.now() / 1000), type: 'text' as const, text: 'How much are fees?', ...over },
});
async function openSession(id = 'school-0001') {
  await h.manager.create(id);
  await eventually(() => h.engines.created.some((e) => e.sessionId === id && e.started));
  h.engines.latest(id).emit({ type: 'open', phone: '2349000000001' });
  await eventually(async () => (await h.manager.get(id)).status === 'open');
  return h.engines.latest(id);
}

test('linking: QR is exposed only while waiting, then the session opens and FlexDesk is told', async () => {
  await h.manager.create('school-0001');
  await eventually(() => h.engines.created.length === 1 && h.engines.created[0]!.started);
  const engine = h.engines.latest('school-0001');
  assert.equal((await h.manager.get('school-0001')).qr, null, 'no QR before WhatsApp provides one');

  engine.emit({ type: 'qr', qr: 'QR-ONE' });
  await eventually(async () => (await h.manager.get('school-0001')).status === 'qr');
  assert.equal((await h.manager.get('school-0001')).qr, 'QR-ONE');
  engine.emit({ type: 'qr', qr: 'QR-TWO' });
  await eventually(async () => (await h.manager.get('school-0001')).qr === 'QR-TWO');
  assert.equal((await h.manager.list())[0]!.qr, null, 'the list never includes QR codes');

  engine.emit({ type: 'open', phone: '2349000000001' });
  await eventually(async () => (await h.manager.get('school-0001')).status === 'open');
  const view = await h.manager.get('school-0001');
  assert.equal(view.qr, null, 'QR is gone once linked');
  assert.equal(view.phone, '2349000000001');
  assert.ok(view.connectedAt);
  await eventually(async () => (await h.events('session.status')).length === 1);
  assert.deepEqual((await h.events('session.status')).map((e) => e.data.status), ['open']);
  assert.equal((await h.repository.get('school-0001'))?.phone, '2349000000001');
});

test('create is idempotent, validates ids and enforces the session cap', async () => {
  await h.manager.create('school-0001');
  await h.manager.create('school-0001');
  await eventually(() => h.engines.created.length >= 1);
  assert.equal(h.engines.created.length, 1, 'a second create does not open a second connection');
  await assert.rejects(h.manager.create('short'), (e: { code?: string }) => e.code === 'invalid_session_id');
  await assert.rejects(h.manager.create('bad id with spaces'), (e: { code?: string }) => e.code === 'invalid_session_id');
  await h.manager.create('school-0002');
  await h.manager.create('school-0003');
  await assert.rejects(h.manager.create('school-0004'), (e: { code?: string }) => e.code === 'capacity');
  await assert.rejects(h.manager.get('nope-nope-1'), (e: { code?: string }) => e.code === 'session_not_found');
});

test('a dropped connection reconnects with backoff and tells FlexDesk once, not per attempt', async () => {
  const first = await openSession();
  first.emit({ type: 'close', code: 408, reason: 'timed out', disposition: 'reconnect' });
  await eventually(() => h.engines.created.length === 2);
  assert.equal((await h.manager.get('school-0001')).status, 'reconnecting');

  h.engines.latest('school-0001').emit({ type: 'close', code: 408, reason: 'timed out', disposition: 'reconnect' });
  await eventually(() => h.engines.created.length === 3);
  h.engines.latest('school-0001').emit({ type: 'open', phone: '2349000000001' });
  await eventually(async () => (await h.manager.get('school-0001')).status === 'open');
  await eventually(async () => (await h.events('session.status')).length === 3);
  assert.deepEqual((await h.events('session.status')).map((e) => e.data.status), ['open', 'reconnecting', 'open']);
});

test('a restart request after pairing reconnects at once, but a restart loop backs off', async () => {
  await h.manager.create('school-0001');
  await eventually(() => h.engines.created.length === 1 && h.engines.created[0]!.started);
  h.engines.latest('school-0001').emit({ type: 'close', code: 515, reason: 'restart required', disposition: 'reconnect_now' });
  await eventually(() => h.engines.created.length === 2);
  for (let i = 3; i <= 4; i++) {
    h.engines.latest('school-0001').emit({ type: 'close', code: 515, reason: 'restart', disposition: 'reconnect_now' });
    await eventually(() => h.engines.created.length === i);
  }
  h.engines.latest('school-0001').emit({ type: 'close', code: 515, reason: 'restart', disposition: 'reconnect_now' });
  await eventually(async () => (await h.manager.get('school-0001')).status === 'reconnecting');
});

test('logged out: credentials are erased, no reconnect, FlexDesk is told, and a fresh QR can be requested', async () => {
  const engine = await openSession();
  await t.db.pool.query(`UPDATE ${t.db.table('sessions')} SET "creds_enc" = '\\x01'`);
  await t.db.pool.query(`INSERT INTO ${t.db.table('auth_keys')} VALUES ('school-0001', 'session', 'x', '\\x01')`);
  engine.emit({ type: 'close', code: 401, reason: 'logged out', disposition: 'logged_out' });
  await eventually(async () => (await h.manager.get('school-0001')).status === 'logged_out');
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(h.engines.created.length, 1, 'does not reconnect a logged-out session');
  const { rows } = await t.db.pool.query(`SELECT "creds_enc", "phone", (SELECT count(*)::int FROM ${t.db.table('auth_keys')}) AS keys FROM ${t.db.table('sessions')}`);
  assert.equal(rows[0].creds_enc, null);
  assert.equal(rows[0].phone, null);
  assert.equal(rows[0].keys, 0);
  assert.equal((await h.events('session.status')).at(-1)?.data.status, 'logged_out');

  await h.manager.reconnect('school-0001');
  await eventually(() => h.engines.created.length === 2);
});

test('replaced and relink never fight for the session; expired QR is reported', async () => {
  const engine = await openSession();
  engine.emit({ type: 'close', code: 440, reason: 'replaced', disposition: 'replaced' });
  await eventually(async () => (await h.manager.get('school-0001')).status === 'replaced');
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(h.engines.created.length, 1);

  await h.manager.create('school-0002');
  await eventually(() => h.engines.created.some((e) => e.sessionId === 'school-0002' && e.started));
  h.engines.latest('school-0002').emit({ type: 'close', code: 408, reason: 'qr timeout', disposition: 'qr_expired' });
  await eventually(async () => (await h.manager.get('school-0002')).status === 'qr_expired');
  await h.manager.reconnect('school-0002');
  await eventually(() => h.engines.created.filter((e) => e.sessionId === 'school-0002').length === 2);
});

test('inbound: recorded once, queued for FlexDesk once, read receipt sent, duplicates and redeliveries ignored', async () => {
  const engine = await openSession();
  engine.emit(incoming('MSG1'));
  await eventually(async () => (await h.events('message.received')).length === 1);
  engine.emit(incoming('MSG1'));
  engine.emit(incoming('MSG2', { text: 'second' }));
  await eventually(async () => (await h.events('message.received')).length === 2);
  await new Promise((resolve) => setTimeout(resolve, 80));
  const messages = await h.events('message.received');
  assert.equal(messages.length, 2, 'duplicate MSG1 was dropped');
  assert.deepEqual(messages[0]!.data, { messageId: 'MSG1', chatId: `${PHONE}@s.whatsapp.net`, phone: PHONE, pushName: 'Ada', timestamp: messages[0]!.data.timestamp, type: 'text', text: 'How much are fees?' });
  assert.deepEqual(engine.read, ['MSG1', 'MSG2']);
  assert.ok(h.nudges.length >= 2, 'delivery is triggered immediately');

  engine.emit(incoming('MSG3', { type: 'unsupported', text: null }));
  await eventually(async () => (await h.events('message.received')).length === 3);
  assert.equal((await h.events('message.received'))[2]!.data.type, 'unsupported');
});

test('replying: only to people who messaged within the window, by chat id or phone', async () => {
  const engine = await openSession();
  await assert.rejects(h.manager.send('school-0001', PHONE, 'hello', undefined), (e: { code?: string }) => e.code === 'outside_reply_window');

  engine.emit(incoming('MSG1'));
  await eventually(async () => (await h.events('message.received')).length === 1);
  const byPhone = await h.manager.send('school-0001', PHONE, 'Fees are N50,000', undefined);
  assert.equal(byPhone.chatId, `${PHONE}@s.whatsapp.net`);
  assert.deepEqual(engine.sent, [{ chatId: `${PHONE}@s.whatsapp.net`, text: 'Fees are N50,000' }]);
  assert.deepEqual(engine.presences.slice(0, 2), [`composing:${PHONE}@s.whatsapp.net`, `paused:${PHONE}@s.whatsapp.net`], 'types before sending');
  await h.manager.send('school-0001', `${PHONE}@s.whatsapp.net`, 'by chat id', undefined);

  await assert.rejects(h.manager.send('school-0001', '2348099999999', 'x', undefined), (e: { code?: string }) => e.code === 'outside_reply_window', 'a stranger cannot be messaged');
  await assert.rejects(h.manager.send('school-0001', '120363@g.us', 'x', undefined), (e: { code?: string }) => e.code === 'invalid_recipient');
  await assert.rejects(h.manager.send('school-0001', '0801', 'x', undefined), (e: { code?: string }) => e.code === 'invalid_recipient');

  h.clock.now += 25 * 3_600_000;
  await assert.rejects(h.manager.send('school-0001', PHONE, 'late', undefined), (e: { code?: string }) => e.code === 'outside_reply_window', 'window closes after 24 hours');
});

test('replying to a hidden-number (LID) chat works by chat id, and a later phone-number message opens both', async () => {
  const engine = await openSession();
  engine.emit(incoming('L1', { chatId: '99887766@lid', phone: null }));
  await eventually(async () => (await h.events('message.received')).length === 1);
  await h.manager.send('school-0001', '99887766@lid', 'hi', undefined);
  assert.equal(engine.sent[0]!.chatId, '99887766@lid');
  await assert.rejects(h.manager.send('school-0001', PHONE, 'x', undefined), (e: { code?: string }) => e.code === 'outside_reply_window');

  engine.emit(incoming('L2', { chatId: '99887766@lid', phone: PHONE }));
  await eventually(async () => (await h.events('message.received')).length === 2);
  await h.manager.send('school-0001', PHONE, 'now by phone', undefined);
});

test('sending is idempotent, releases the key on failure, and refuses concurrent duplicates', async () => {
  const engine = await openSession();
  engine.emit(incoming('MSG1'));
  await eventually(async () => (await h.events('message.received')).length === 1);

  const a = await h.manager.send('school-0001', PHONE, 'once', 'idem-key-0001');
  const b = await h.manager.send('school-0001', PHONE, 'once', 'idem-key-0001');
  assert.equal(a.messageId, b.messageId);
  assert.equal(engine.sent.length, 1, 'a retried request does not send twice');

  engine.failNextSend = true;
  await assert.rejects(h.manager.send('school-0001', PHONE, 'x', 'idem-key-0002'), (e: { code?: string }) => e.code === 'send_failed');
  const retried = await h.manager.send('school-0001', PHONE, 'x', 'idem-key-0002');
  assert.ok(retried.messageId, 'a failed send can be retried with the same key');

  const results = await Promise.allSettled([
    h.manager.send('school-0001', PHONE, 'race', 'idem-key-0003'),
    h.manager.send('school-0001', PHONE, 'race', 'idem-key-0003'),
  ]);
  assert.equal(engine.sent.filter((m) => m.text === 'race').length, 1, 'concurrent duplicates send once');
  assert.ok(results.some((r) => r.status === 'fulfilled'));
});

test('sending needs an open session', async () => {
  await h.manager.create('school-0001');
  await eventually(() => h.engines.created.length === 1);
  await assert.rejects(h.manager.send('school-0001', PHONE, 'x', undefined), (e: { code?: string }) => e.code === 'session_not_open');
  await assert.rejects(h.manager.send('missing-0001', PHONE, 'x', undefined), (e: { code?: string }) => e.code === 'session_not_found');
});

test('deactivating closes sockets without unlinking; activating resumes linked sessions and expires unlinked ones', async () => {
  const linked = await openSession('school-0001');
  await h.manager.create('school-0002');
  await eventually(() => h.engines.created.some((e) => e.sessionId === 'school-0002' && e.started));
  h.engines.latest('school-0002').emit({ type: 'qr', qr: 'Q' });
  await eventually(async () => (await h.manager.get('school-0002')).status === 'qr');

  await h.manager.deactivate();
  assert.equal(linked.stopped, true);
  assert.equal(linked.loggedOut, false, 'a restart must not unlink the phone');
  await assert.rejects(h.manager.get('school-0001'), (e: { code?: string }) => e.code === 'not_ready');
  const before = h.engines.created.length;

  await h.manager.activate();
  await eventually(() => h.engines.created.length === before + 1);
  assert.equal(h.engines.latest('school-0001').sessionId, 'school-0001');
  assert.equal((await h.repository.get('school-0002'))?.status, 'qr_expired', 'a QR does not survive a restart');
});

test('events from a replaced connection are ignored', async () => {
  const stale = await openSession();
  stale.emit({ type: 'close', code: 408, reason: 'timed out', disposition: 'reconnect' });
  await eventually(() => h.engines.created.length === 2);
  h.engines.latest('school-0001').emit({ type: 'open', phone: '2349000000001' });
  await eventually(async () => (await h.manager.get('school-0001')).status === 'open');
  stale.emit({ type: 'close', code: 401, reason: 'late', disposition: 'logged_out' });
  stale.emit(incoming('GHOST'));
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal((await h.manager.get('school-0001')).status, 'open', 'a stale engine cannot change the status');
  assert.equal((await h.events('message.received')).length, 0, 'or deliver messages');
});

test('rapid open-then-drop is recorded in order', async () => {
  await h.manager.create('school-0001');
  await eventually(() => h.engines.created.length === 1 && h.engines.created[0]!.started);
  const engine = h.engines.latest('school-0001');
  engine.emit({ type: 'open', phone: '2349000000001' });
  engine.emit({ type: 'close', code: 408, reason: 'timed out', disposition: 'reconnect' });
  await eventually(async () => (await h.events('session.status')).length === 2);
  assert.deepEqual((await h.events('session.status')).map((e) => e.data.status), ['open', 'reconnecting']);
  await eventually(async () => (await h.repository.get('school-0001'))?.status === 'reconnecting');
});

test('remove logs out an open session and deletes everything stored for it', async () => {
  const engine = await openSession();
  engine.emit(incoming('MSG1'));
  await eventually(async () => (await h.events('message.received')).length === 1);
  await h.manager.remove('school-0001');
  assert.equal(engine.loggedOut, true);
  assert.equal(await h.repository.get('school-0001'), null);
  const { rows } = await t.db.pool.query(`SELECT (SELECT count(*)::int FROM ${t.db.table('chat_windows')}) AS w, (SELECT count(*)::int FROM ${t.db.table('seen_messages')}) AS s`);
  assert.deepEqual(rows[0], { w: 0, s: 0 });
  await assert.rejects(h.manager.remove('school-0001'), (e: { code?: string }) => e.code === 'session_not_found');
});

test('a failure to start a connection is retried instead of leaving the session dead', async () => {
  h.engines.failCreate = true;
  await h.manager.create('school-0001');
  await eventually(async () => (await h.manager.get('school-0001')).status === 'reconnecting');
  h.engines.failCreate = false;
  await eventually(() => h.engines.created.length === 1);
});

test('a reply that took a while may ask for a longer window, up to a cap, and never reaches someone who has not written in', async () => {
  const engine = await openSession();
  engine.emit(incoming('MSG1'));
  await eventually(async () => (await h.events('message.received')).length === 1);

  h.clock.now += 50 * 3_600_000; // two days later
  await assert.rejects(h.manager.send('school-0001', PHONE, 'late', undefined), (e: { code?: string }) => e.code === 'outside_reply_window', 'the default window has closed');
  await assert.rejects(h.manager.send('school-0001', PHONE, 'late', undefined, 24), (e: { code?: string }) => e.code === 'outside_reply_window', 'asking for the default is no different');
  const longer = await h.manager.send('school-0001', PHONE, 'Your complaint has a reply', undefined, 72);
  assert.ok(longer.messageId, 'a 72-hour window reaches someone who wrote 50 hours ago');
  assert.equal(engine.sent.at(-1)!.text, 'Your complaint has a reply');

  h.clock.now += 6 * 24 * 3_600_000; // about eight days after they wrote
  await assert.rejects(h.manager.send('school-0001', PHONE, 'too late', undefined, 168), (e: { code?: string }) => e.code === 'outside_reply_window', 'even the longest window ends');
  await assert.rejects(h.manager.send('school-0001', '2348099999999', 'x', undefined, 168), (e: { code?: string }) => e.code === 'outside_reply_window', 'a stranger is never reachable, whatever window is asked for');
});

test('a request cannot widen the window past the configured maximum, or shrink it below the default', async () => {
  const engine = await openSession();
  engine.emit(incoming('MSG1'));
  await eventually(async () => (await h.events('message.received')).length === 1);
  h.clock.now += 10 * 3_600_000;
  assert.ok((await h.manager.send('school-0001', PHONE, 'inside the default', undefined, 1)).messageId, 'asking for less than the default does not close a window that is still open');
  h.clock.now += 8 * 24 * 3_600_000;
  await assert.rejects(h.manager.send('school-0001', PHONE, 'x', undefined, 168), (e: { code?: string }) => e.code === 'outside_reply_window');
});
