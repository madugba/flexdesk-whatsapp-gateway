import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { FastifyInstance } from 'fastify';
import pino from 'pino';
import { buildServer } from '../src/http/server.js';
import { createTestDb, type TestDb } from './helpers/db.js';
import { TEST_API_KEY } from './helpers/env.js';
import { eventually } from './helpers/fake-engine.js';
import { createManager } from './helpers/manager.js';

let t: TestDb;
let h: ReturnType<typeof createManager>;
let app: FastifyInstance;
const auth = { authorization: `Bearer ${TEST_API_KEY}` };

before(async () => {
  t = await createTestDb();
  h = createManager(t);
  await h.manager.activate();
  app = await buildServer({ manager: h.manager, outbox: h.outbox, isLeader: () => true, apiKeys: [TEST_API_KEY], logger: t.logger });
});
after(async () => { await app.close(); await h.manager.deactivate(); await t.cleanup(); });

const call = (method: 'GET' | 'POST' | 'DELETE', url: string, payload?: unknown, headers: Record<string, string> = auth) =>
  app.inject({ method, url, headers, ...(payload === undefined ? {} : { payload: payload as object }) });

test('health is public; everything under /v1 needs the API key', async () => {
  assert.equal((await call('GET', '/healthz', undefined, {})).statusCode, 200);
  assert.deepEqual((await call('GET', '/healthz', undefined, {})).json(), { status: 'ok' });
  for (const headers of [{}, { authorization: 'Bearer wrong' }, { authorization: TEST_API_KEY }, { authorization: `Basic ${TEST_API_KEY}` }] as Array<Record<string, string>>) {
    const response = await call('GET', '/v1/sessions', undefined, headers);
    assert.equal(response.statusCode, 401);
    assert.equal(response.headers['www-authenticate'], 'Bearer');
    assert.equal(response.json().error.code, 'unauthorized');
  }
  assert.equal((await call('POST', '/v1/sessions', { sessionId: 'school-0001' }, {})).statusCode, 401, 'writes are protected too');
  assert.equal((await call('GET', '/v1/nope')).statusCode, 404);
  assert.equal((await call('GET', '/nope', undefined, {})).statusCode, 404);
});

test('session lifecycle over HTTP, with no-store caching and the QR only on the single session', async () => {
  const created = await call('POST', '/v1/sessions', { sessionId: 'school-0001' });
  assert.equal(created.statusCode, 200);
  assert.equal(created.headers['cache-control'], 'no-store');
  assert.equal(created.json().status, 'connecting');
  await eventually(() => h.engines.created.some((e) => e.started));
  h.engines.latest('school-0001').emit({ type: 'qr', qr: 'QR-DATA' });
  await eventually(async () => (await call('GET', '/v1/sessions/school-0001')).json().qr === 'QR-DATA');
  assert.equal((await call('GET', '/v1/sessions')).json().sessions[0].qr, null, 'list never includes the QR');

  h.engines.latest('school-0001').emit({ type: 'open', phone: '2349000000001' });
  await eventually(async () => (await call('GET', '/v1/sessions/school-0001')).json().status === 'open');

  h.engines.latest('school-0001').emit({ type: 'message', message: { messageId: 'M1', chatId: '2348012345678@s.whatsapp.net', phone: '2348012345678', pushName: null, timestamp: Math.floor(Date.now() / 1000), type: 'text', text: 'hi' } });
  await eventually(async () => (await h.events('message.received')).length === 1);
  const sent = await call('POST', '/v1/sessions/school-0001/messages', { to: '2348012345678', text: 'Hello!', idempotencyKey: 'idem-000001' });
  assert.equal(sent.statusCode, 200);
  assert.deepEqual(Object.keys(sent.json()).sort(), ['chatId', 'messageId']);

  const status = (await call('GET', '/v1/status')).json();
  assert.equal(status.leader, true);
  assert.equal(status.sessions, 1);
  assert.ok(status.memory.rssMb > 0);

  assert.equal((await call('DELETE', '/v1/sessions/school-0001')).statusCode, 204);
  assert.equal((await call('GET', '/v1/sessions/school-0001')).statusCode, 404);
});

test('invalid requests get precise 4xx answers and never a stack trace', async () => {
  const cases: Array<[string, unknown, number, string]> = [
    ['/v1/sessions', {}, 422, 'invalid_request'],
    ['/v1/sessions', { sessionId: 'x' }, 422, 'invalid_session_id'],
    ['/v1/sessions', { sessionId: 'school-0009', extra: 1 }, 422, 'invalid_request'],
    ['/v1/sessions/missing-0001/messages', { to: '2348012345678', text: 'x' }, 404, 'session_not_found'],
  ];
  for (const [url, body, status, code] of cases) {
    const response = await call('POST', url, body);
    assert.equal(response.statusCode, status, url);
    assert.equal(response.json().error.code, code);
    assert.ok(!response.body.includes('at '), 'no stack trace');
  }
  await call('POST', '/v1/sessions', { sessionId: 'school-0002' });
  await eventually(() => h.engines.created.some((e) => e.sessionId === 'school-0002' && e.started));
  h.engines.latest('school-0002').emit({ type: 'open', phone: '2349000000002' });
  await eventually(async () => (await call('GET', '/v1/sessions/school-0002')).json().status === 'open');
  for (const body of [{ to: '2348012345678' }, { to: '2348012345678', text: '' }, { to: '2348012345678', text: 'x'.repeat(4097) }, { to: '', text: 'x' }, { text: 'x' }, { to: '2348012345678', text: 'x', idempotencyKey: 'short' }]) {
    assert.equal((await call('POST', '/v1/sessions/school-0002/messages', body)).statusCode, 422, JSON.stringify(body).slice(0, 60));
  }
  const stranger = await call('POST', '/v1/sessions/school-0002/messages', { to: '2348012345678', text: 'hello' });
  assert.equal(stranger.statusCode, 422);
  assert.equal(stranger.json().error.code, 'outside_reply_window');
  assert.equal((await call('POST', '/v1/sessions', 'not-json')).statusCode >= 400, true);
  const huge = await app.inject({ method: 'POST', url: '/v1/sessions', headers: { ...auth, 'content-type': 'application/json' }, payload: JSON.stringify({ sessionId: 'x'.repeat(70_000) }) });
  assert.equal(huge.statusCode, 413);
});

test('while this process is not the leader the API says so instead of guessing', async () => {
  await h.manager.deactivate();
  const response = await call('POST', '/v1/sessions', { sessionId: 'school-0003' });
  assert.equal(response.statusCode, 503);
  assert.equal(response.headers['retry-after'], '5');
  assert.equal(response.json().error.code, 'not_ready');
  assert.equal((await call('GET', '/healthz', undefined, {})).statusCode, 200, 'liveness stays up so the host does not kill the process');
  await h.manager.activate();
});

test('too many requests are throttled', async () => {
  const limited = await buildServer({ manager: h.manager, outbox: h.outbox, isLeader: () => true, apiKeys: [TEST_API_KEY], logger: t.logger });
  let last = 200;
  for (let i = 0; i < 305; i++) last = (await limited.inject({ method: 'GET', url: '/healthz' })).statusCode;
  assert.equal(last, 429);
  await limited.close();
});

test('the health page is not logged (Render asks for it every few seconds), but real requests are', async () => {
  const lines: string[] = [];
  const logger = pino({ level: 'info' }, { write: (line: string) => { lines.push(line); } });
  const quietApp = await buildServer({ manager: h.manager, outbox: h.outbox, isLeader: () => true, apiKeys: [TEST_API_KEY], logger: logger as unknown as typeof t.logger });
  try {
    for (let i = 0; i < 5; i++) assert.equal((await quietApp.inject({ method: 'GET', url: '/healthz' })).statusCode, 200);
    assert.equal(lines.filter((line) => line.includes('/healthz')).length, 0, 'five health checks leave no trace in the log');

    await quietApp.inject({ method: 'GET', url: '/v1/status', headers: auth });
    assert.ok(lines.some((line) => line.includes('/v1/status')), 'other requests are still logged');
  } finally {
    await quietApp.close();
  }
});
