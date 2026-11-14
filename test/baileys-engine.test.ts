import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { WebSocketServer } from 'ws';
import { BaileysEngineFactory } from '../src/engine/baileys-engine.js';
import { PostgresAuthStore } from '../src/engine/auth-state.js';
import type { EngineEvent } from '../src/engine/types.js';
import { SecretBox } from '../src/lib/secret-box.js';
import { createTestDb, type TestDb } from './helpers/db.js';
import { eventually } from './helpers/fake-engine.js';

let t: TestDb;
let wss: WebSocketServer;
before(async () => { t = await createTestDb(); });
after(async () => { wss?.close(); await t.cleanup(); });

/**
 * WhatsApp itself is not reachable from tests, so this checks the adapter's wiring against
 * a local WebSocket server standing in for it: it connects, it reports a close with the
 * right classification. Credentials are only written once WhatsApp pairs, which needs a phone.
 */
test('the Baileys adapter connects, reports and reports a dropped link', async () => {
  wss = new WebSocketServer({ port: 0 });
  const connections: number[] = [];
  wss.on('connection', (socket) => { connections.push(Date.now()); setTimeout(() => socket.close(), 50); });
  await new Promise<void>((resolve) => wss.once('listening', resolve));
  const { port } = wss.address() as { port: number };

  await t.db.pool.query(`INSERT INTO ${t.db.table('sessions')} ("id") VALUES ('school-0001')`);
  const factory = new BaileysEngineFactory(new PostgresAuthStore(t.db, new SecretBox(t.config.GATEWAY_ENCRYPTION_KEY)), t.logger, {
    waWebSocketUrl: `ws://127.0.0.1:${port}`,
  });
  const engine = await factory.create('school-0001');
  const events: EngineEvent[] = [];
  engine.onEvent((event) => events.push(event));
  await engine.start();

  await eventually(() => events.some((event) => event.type === 'close'), 8_000);
  assert.ok(connections.length >= 1, 'the adapter opened a WebSocket');
  const close = events.find((event) => event.type === 'close');
  assert.equal(close?.type === 'close' && close.disposition, 'qr_expired', 'a drop before pairing means the QR was never scanned');

  await assert.rejects(engine.sendText('2348012345678@s.whatsapp.net', 'x'), /not open/);
  await engine.stop();
});
