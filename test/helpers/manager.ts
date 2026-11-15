import { SessionManager } from '../../src/sessions/session-manager.js';
import { SessionRepository } from '../../src/sessions/session-repository.js';
import { WebhookOutbox } from '../../src/webhooks/outbox.js';
import { FakeEngineFactory } from './fake-engine.js';
import type { TestDb } from './db.js';

export function createManager(t: TestDb, overrides: Partial<ConstructorParameters<typeof SessionManager>[0]['options']> = {}) {
  const repository = new SessionRepository(t.db);
  const outbox = new WebhookOutbox(t.db);
  const engines = new FakeEngineFactory();
  const nudges: number[] = [];
  const clock = { now: Date.now() };
  const manager = new SessionManager({
    repository,
    engines,
    outbox,
    dispatcher: { nudge: () => { nudges.push(Date.now()); } },
    logger: t.logger,
    options: {
      maxSessions: 3,
      replyWindowHours: 24,
      maxReplyWindowHours: 168,
      markRead: true,
      send: { minIntervalMs: 0, maxPerHour: 100, maxQueued: 10 },
      ...overrides,
    },
    sleep: async () => undefined,
    random: () => 0.5,
    now: () => clock.now,
    reconnectDelay: () => 20,
  });
  const events = async (type?: string) => {
    const { rows } = await t.db.pool.query(
      `SELECT "event_type", "session_id", "payload" FROM ${t.db.table('webhook_outbox')} ${type ? `WHERE "event_type" = '${type}'` : ''} ORDER BY "id"`,
    );
    return rows.map((row) => ({ type: row.event_type as string, sessionId: row.session_id as string, data: row.payload as Record<string, unknown> }));
  };
  return { manager, repository, outbox, engines, nudges, clock, events };
}
