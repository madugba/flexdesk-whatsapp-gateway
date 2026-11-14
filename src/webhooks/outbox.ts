import type pg from 'pg';
import type { Database } from '../db/database.js';

export type Queryable = Pick<pg.Pool, 'query'>;

export interface OutboxEvent {
  id: string;
  sessionId: string;
  eventType: string;
  payload: Record<string, unknown>;
  attempts: number;
  createdAt: Date;
}

const LEASE_SECONDS = 120;

/**
 * Events are written to Postgres first and delivered afterwards, so a restart or an
 * outage at the receiver never loses one. Writing through the caller's transaction makes
 * "record this message" and "queue its webhook" succeed or fail together.
 */
export class WebhookOutbox {
  constructor(private readonly db: Database) {}

  async enqueue(
    sessionId: string,
    eventType: string,
    payload: Record<string, unknown>,
    client: Queryable = this.db.pool,
  ): Promise<void> {
    await client.query(
      `INSERT INTO ${this.db.table('webhook_outbox')} ("session_id", "event_type", "payload") VALUES ($1, $2, $3)`,
      [sessionId, eventType, JSON.stringify(payload)],
    );
  }

  /** Claims due events and leases them so another delivery loop cannot pick them up meanwhile. */
  async claimDue(limit: number): Promise<OutboxEvent[]> {
    const table = this.db.table('webhook_outbox');
    const { rows } = await this.db.pool.query(
      `UPDATE ${table} SET "next_attempt_at" = now() + make_interval(secs => $2)
       WHERE "id" IN (
         SELECT "id" FROM ${table}
         WHERE "delivered_at" IS NULL AND "failed_at" IS NULL AND "next_attempt_at" <= now()
         ORDER BY "id" LIMIT $1 FOR UPDATE SKIP LOCKED
       )
       RETURNING "id", "session_id", "event_type", "payload", "attempts", "created_at"`,
      [limit, LEASE_SECONDS],
    );
    return rows
      .map((row) => ({
        id: String(row.id),
        sessionId: row.session_id as string,
        eventType: row.event_type as string,
        payload: row.payload as Record<string, unknown>,
        attempts: row.attempts as number,
        createdAt: row.created_at as Date,
      }))
      .sort((a, b) => Number(a.id) - Number(b.id));
  }

  async markDelivered(id: string): Promise<void> {
    await this.db.pool.query(
      `UPDATE ${this.db.table('webhook_outbox')} SET "delivered_at" = now(), "attempts" = "attempts" + 1, "last_error" = NULL WHERE "id" = $1`,
      [id],
    );
  }

  async markRetry(id: string, error: string, delaySeconds: number): Promise<void> {
    await this.db.pool.query(
      `UPDATE ${this.db.table('webhook_outbox')}
       SET "attempts" = "attempts" + 1, "last_error" = $2, "next_attempt_at" = now() + make_interval(secs => $3) WHERE "id" = $1`,
      [id, error.slice(0, 500), delaySeconds],
    );
  }

  async markFailed(id: string, error: string): Promise<void> {
    await this.db.pool.query(
      `UPDATE ${this.db.table('webhook_outbox')} SET "attempts" = "attempts" + 1, "last_error" = $2, "failed_at" = now() WHERE "id" = $1`,
      [id, error.slice(0, 500)],
    );
  }

  async stats(): Promise<{ pending: number; failed: number }> {
    const { rows } = await this.db.pool.query<{ pending: string; failed: string }>(
      `SELECT count(*) FILTER (WHERE "delivered_at" IS NULL AND "failed_at" IS NULL) AS pending,
              count(*) FILTER (WHERE "failed_at" IS NOT NULL) AS failed
       FROM ${this.db.table('webhook_outbox')}`,
    );
    return { pending: Number(rows[0]?.pending ?? 0), failed: Number(rows[0]?.failed ?? 0) };
  }
}
