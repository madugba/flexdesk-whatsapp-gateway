import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { after, before, test } from 'node:test';
import { initAuthCreds } from '@whiskeysockets/baileys';
import { LeaderLock } from '../src/db/leader-lock.js';
import { migrate } from '../src/db/migrate.js';
import { PostgresAuthStore } from '../src/engine/auth-state.js';
import { SecretBox } from '../src/lib/secret-box.js';
import { WebhookDispatcher } from '../src/webhooks/dispatcher.js';
import { WebhookOutbox } from '../src/webhooks/outbox.js';
import { verifySignature } from '../src/webhooks/signature.js';
import { createTestDb, type TestDb } from './helpers/db.js';
import { eventually } from './helpers/fake-engine.js';
import { TEST_WEBHOOK_SECRET } from './helpers/env.js';

let t: TestDb;
before(async () => { t = await createTestDb(); });
after(async () => { await t.cleanup(); });

const insertSession = (id: string) => t.db.pool.query(`INSERT INTO ${t.db.table('sessions')} ("id") VALUES ($1) ON CONFLICT DO NOTHING`, [id]);

test('migrations are idempotent and safe to run concurrently', async () => {
  assert.deepEqual(await migrate(t.db, t.config.DB_SCHEMA, t.logger), []);
  const fresh = await createTestDb();
  try {
    const results = await Promise.all([1, 2, 3].map(() => migrate(fresh.db, fresh.config.DB_SCHEMA, fresh.logger)));
    assert.equal(results.flat().length, 0, 'createTestDb already applied them');
  } finally {
    await fresh.cleanup();
  }
});

test('auth state: credentials and keys survive a reload, encrypted at rest, deletions apply', async () => {
  const box = new SecretBox(t.config.GATEWAY_ENCRYPTION_KEY);
  const store = new PostgresAuthStore(t.db, box);
  await insertSession('session-one');

  const first = await store.load('session-one');
  const noiseKey = Buffer.from(first.state.creds.noiseKey.private).toString('hex');
  await first.saveCreds();
  await first.state.keys.set({
    'pre-key': { '1': { private: Buffer.from('priv'), public: Buffer.from('pub') }, '2': { private: Buffer.from('p2'), public: Buffer.from('q2') } },
    session: { 'a.0': Buffer.from([1, 2, 3, 4]) },
    'app-state-sync-key': { K1: { keyData: Buffer.from('kd'), timestamp: 5 } },
  });

  const second = await store.load('session-one');
  assert.equal(Buffer.from(second.state.creds.noiseKey.private).toString('hex'), noiseKey, 'same credentials after reload');
  const preKeys = await second.state.keys.get('pre-key', ['1', '2', '3']);
  assert.deepEqual(Buffer.from(preKeys['1']!.private), Buffer.from('priv'));
  assert.equal(preKeys['3'], undefined, 'missing keys are simply absent');
  assert.deepEqual(Buffer.from((await second.state.keys.get('session', ['a.0']))['a.0']!), Buffer.from([1, 2, 3, 4]));
  const appKey = (await second.state.keys.get('app-state-sync-key', ['K1']))['K1']!;
  assert.deepEqual(Buffer.from(appKey.keyData!), Buffer.from('kd'));

  const { rows } = await t.db.pool.query(`SELECT "value_enc", "creds_enc" FROM ${t.db.table('auth_keys')} k JOIN ${t.db.table('sessions')} s ON s.id = k.session_id LIMIT 1`);
  assert.ok(!rows[0].value_enc.toString().includes('priv'), 'keys are not stored in plaintext');
  assert.ok(!rows[0].creds_enc.toString('latin1').includes(noiseKey), 'credentials are not stored in plaintext');

  await second.state.keys.set({ 'pre-key': { '1': null } });
  assert.equal((await second.state.keys.get('pre-key', ['1']))['1'], undefined);
  assert.ok((await second.state.keys.get('pre-key', ['2']))['2'], 'other keys untouched');
});

test('auth state: sessions are isolated, rows cannot be swapped, wrong key fails, deletes cascade', async () => {
  const store = new PostgresAuthStore(t.db, new SecretBox(t.config.GATEWAY_ENCRYPTION_KEY));
  await insertSession('session-a');
  await insertSession('session-b');
  const a = await store.load('session-a');
  const b = await store.load('session-b');
  await a.saveCreds();
  await b.saveCreds();
  await a.state.keys.set({ session: { x: Buffer.from('A-secret') } });
  assert.equal((await b.state.keys.get('session', ['x']))['x'], undefined, 'session b cannot read session a keys');

  await t.db.pool.query(
    `UPDATE ${t.db.table('sessions')} SET "creds_enc" = (SELECT "creds_enc" FROM ${t.db.table('sessions')} WHERE "id" = 'session-a') WHERE "id" = 'session-b'`,
  );
  await assert.rejects(store.load('session-b'), 'ciphertext copied to another session fails authentication');

  const wrongKey = new PostgresAuthStore(t.db, new SecretBox(Buffer.alloc(32, 7).toString('base64')));
  await assert.rejects(wrongKey.load('session-a'));

  await t.db.pool.query(`DELETE FROM ${t.db.table('sessions')} WHERE "id" = 'session-a'`);
  const { rows } = await t.db.pool.query(`SELECT count(*)::int AS n FROM ${t.db.table('auth_keys')} WHERE "session_id" = 'session-a'`);
  assert.equal(rows[0].n, 0, 'deleting a session deletes its keys');
});

test('auth state: concurrent saves keep the latest credentials', async () => {
  const store = new PostgresAuthStore(t.db, new SecretBox(t.config.GATEWAY_ENCRYPTION_KEY));
  await insertSession('session-race');
  const loaded = await store.load('session-race');
  const writes: Array<Promise<void>> = [];
  for (let i = 0; i < 20; i++) {
    (loaded.state.creds as { registrationId: number }).registrationId = i;
    writes.push(loaded.saveCreds());
  }
  await Promise.all(writes);
  assert.equal((await store.load('session-race')).state.creds.registrationId, 19);
  void initAuthCreds;
});

interface Received { headers: IncomingMessage['headers']; body: string }

async function receiver(handler: (received: Received, attempt: number) => number): Promise<{ url: string; received: Received[]; server: Server }> {
  const received: Received[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const entry = { headers: req.headers, body: Buffer.concat(chunks).toString() };
      received.push(entry);
      res.statusCode = handler(entry, received.length);
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  return { url: `http://127.0.0.1:${port}/hook`, received, server };
}

test('webhooks: delivered signed, in order, with event ids; retried until accepted', async () => {
  const outbox = new WebhookOutbox(t.db);
  await t.db.pool.query(`DELETE FROM ${t.db.table('webhook_outbox')}`);
  const target = await receiver((_received, attempt) => (attempt <= 2 ? 500 : 200));
  const dispatcher = new WebhookDispatcher(outbox, { url: target.url, secret: TEST_WEBHOOK_SECRET }, t.logger);
  try {
    await outbox.enqueue('s1', 'message.received', { n: 1 });
    await outbox.enqueue('s1', 'message.received', { n: 2 });
    dispatcher.start();
    await eventually(async () => {
      const { rows } = await t.db.pool.query(`SELECT count(*)::int AS n FROM ${t.db.table('webhook_outbox')} WHERE "attempts" = 1`);
      return rows[0].n === 2;
    });
    const { rows: waiting } = await t.db.pool.query(`SELECT count(*)::int AS n FROM ${t.db.table('webhook_outbox')} WHERE "attempts" = 1 AND "next_attempt_at" > now() + interval '3 seconds'`);
    assert.equal(waiting[0].n, 2, 'failed events back off instead of hammering the receiver');
    await t.db.pool.query(`UPDATE ${t.db.table('webhook_outbox')} SET "next_attempt_at" = now() WHERE "delivered_at" IS NULL`);
    await eventually(async () => (await outbox.stats()).pending === 0, 4_000);

    const delivered = target.received.filter((r) => r.headers['x-gateway-event-type']);
    assert.equal(delivered.length, 4, 'two failures were each retried once');
    const first = delivered[0]!;
    assert.equal(verifySignature(TEST_WEBHOOK_SECRET, first.body, first.headers['x-gateway-signature'] as string), true);
    assert.equal(first.headers['content-type'], 'application/json');
    const parsed = JSON.parse(first.body);
    assert.equal(parsed.type, 'message.received');
    assert.equal(parsed.sessionId, 's1');
    assert.equal(parsed.id, first.headers['x-gateway-event-id']);
    assert.ok(parsed.occurredAt);
    const { rows } = await t.db.pool.query(`SELECT count(*) FILTER (WHERE "delivered_at" IS NOT NULL)::int AS done FROM ${t.db.table('webhook_outbox')}`);
    assert.equal(rows[0].done, 2);
  } finally {
    await dispatcher.stop();
    target.server.close();
  }
});

test('webhooks: events wait out an outage, then go through; poison events are parked after the cap', async () => {
  const outbox = new WebhookOutbox(t.db);
  await t.db.pool.query(`DELETE FROM ${t.db.table('webhook_outbox')}`);
  await outbox.enqueue('s2', 'session.status', { status: 'open' });
  const dead = new WebhookDispatcher(outbox, { url: 'http://127.0.0.1:1/hook', secret: TEST_WEBHOOK_SECRET }, t.logger);
  dead.start();
  await eventually(async () => {
    const { rows } = await t.db.pool.query(`SELECT "attempts", "last_error" FROM ${t.db.table('webhook_outbox')}`);
    return rows[0]?.attempts >= 1;
  });
  await dead.stop();
  assert.equal((await outbox.stats()).pending, 1, 'still queued, not lost');
  assert.equal((await outbox.stats()).failed, 0);

  await t.db.pool.query(`UPDATE ${t.db.table('webhook_outbox')} SET "attempts" = 14, "next_attempt_at" = now()`);
  const parked = new WebhookDispatcher(outbox, { url: 'http://127.0.0.1:1/hook', secret: TEST_WEBHOOK_SECRET }, t.logger);
  parked.start();
  await eventually(async () => (await outbox.stats()).failed === 1);
  await parked.stop();
  assert.deepEqual(await outbox.stats(), { pending: 0, failed: 1 });
});

test('webhooks: two delivery loops never take the same event', async () => {
  const outbox = new WebhookOutbox(t.db);
  await t.db.pool.query(`DELETE FROM ${t.db.table('webhook_outbox')}`);
  for (let i = 0; i < 30; i++) await outbox.enqueue('s3', 'message.received', { i });
  const [a, b] = await Promise.all([outbox.claimDue(20), outbox.claimDue(20)]);
  const ids = [...a, ...b].map((event) => event.id);
  assert.equal(ids.length, 30);
  assert.equal(new Set(ids).size, 30, 'no event claimed twice');
});

test('leader lock: one holder at a time; a waiting instance takes over when the holder stops', async () => {
  const events: string[] = [];
  const make = (name: string) => new LeaderLock(t.db, { onAcquired: () => { events.push(`${name}+`); }, onLost: () => { events.push(`${name}-`); } }, t.logger);
  const first = make('A');
  const second = make('B');
  first.start();
  await eventually(() => first.isLeader);
  second.start();
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(second.isLeader, false, 'second instance waits while the first holds the lock');
  await first.stop();
  await eventually(() => second.isLeader, 8_000);
  assert.deepEqual(events.filter((e) => e.endsWith('+')), ['A+', 'B+']);

  await t.db.pool.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = 'flexdesk-whatsapp-gateway' AND pid <> pg_backend_pid() AND query LIKE '%advisory%'`);
  await second.stop();
});
