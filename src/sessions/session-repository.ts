import type { Database } from '../db/database.js';
import type { InboundMessage, SessionStatus } from '../engine/types.js';
import type { Queryable } from '../webhooks/outbox.js';

export interface SessionRow {
  id: string;
  status: SessionStatus;
  phone: string | null;
  lastConnectedAt: Date | null;
  lastDisconnectCode: number | null;
  lastDisconnectReason: string | null;
}

export interface StatusUpdate {
  status: SessionStatus;
  phone?: string | null;
  connectedAt?: Date;
  disconnectCode?: number | null;
  disconnectReason?: string | null;
}

export type SendClaim = { claimed: true } | { claimed: false; messageId: string | null };

const RETENTION_DAYS = 7;

function toRow(row: Record<string, unknown>): SessionRow {
  return {
    id: row.id as string,
    status: row.status as SessionStatus,
    phone: (row.phone as string | null) ?? null,
    lastConnectedAt: (row.last_connected_at as Date | null) ?? null,
    lastDisconnectCode: (row.last_disconnect_code as number | null) ?? null,
    lastDisconnectReason: (row.last_disconnect_reason as string | null) ?? null,
  };
}

const COLUMNS = `"id", "status", "phone", "last_connected_at", "last_disconnect_code", "last_disconnect_reason"`;

/** All SQL for sessions and the records kept per session. */
export class SessionRepository {
  constructor(private readonly db: Database) {}

  async get(id: string): Promise<SessionRow | null> {
    const { rows } = await this.db.pool.query(`SELECT ${COLUMNS} FROM ${this.db.table('sessions')} WHERE "id" = $1`, [id]);
    return rows[0] ? toRow(rows[0]) : null;
  }

  async list(): Promise<SessionRow[]> {
    const { rows } = await this.db.pool.query(`SELECT ${COLUMNS} FROM ${this.db.table('sessions')} ORDER BY "created_at"`);
    return rows.map(toRow);
  }

  async count(): Promise<number> {
    const { rows } = await this.db.pool.query<{ count: string }>(`SELECT count(*) FROM ${this.db.table('sessions')}`);
    return Number(rows[0]?.count ?? 0);
  }

  /** Returns true when the session was newly created. */
  async insertIfMissing(id: string): Promise<boolean> {
    const result = await this.db.pool.query(
      `INSERT INTO ${this.db.table('sessions')} ("id") VALUES ($1) ON CONFLICT ("id") DO NOTHING`,
      [id],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async updateStatus(id: string, update: StatusUpdate): Promise<void> {
    await this.db.pool.query(
      `UPDATE ${this.db.table('sessions')} SET
         "status" = $2,
         "phone" = CASE WHEN $3::boolean THEN $4 ELSE "phone" END,
         "last_connected_at" = COALESCE($5, "last_connected_at"),
         "last_disconnect_code" = CASE WHEN $6::boolean THEN $7 ELSE "last_disconnect_code" END,
         "last_disconnect_reason" = CASE WHEN $6::boolean THEN $8 ELSE "last_disconnect_reason" END,
         "updated_at" = now()
       WHERE "id" = $1`,
      [
        id,
        update.status,
        update.phone !== undefined,
        update.phone ?? null,
        update.connectedAt ?? null,
        update.disconnectCode !== undefined || update.disconnectReason !== undefined,
        update.disconnectCode ?? null,
        update.disconnectReason ?? null,
      ],
    );
  }

  /** Forgets the linked device's credentials and keys, so the next connect shows a fresh QR code. */
  async purgeAuth(id: string): Promise<void> {
    await this.db.pool.query(`DELETE FROM ${this.db.table('auth_keys')} WHERE "session_id" = $1`, [id]);
    await this.db.pool.query(
      `UPDATE ${this.db.table('sessions')} SET "creds_enc" = NULL, "phone" = NULL, "updated_at" = now() WHERE "id" = $1`,
      [id],
    );
  }

  async delete(id: string): Promise<void> {
    await this.db.pool.query(`DELETE FROM ${this.db.table('sessions')} WHERE "id" = $1`, [id]);
  }

  /**
   * Records an inbound message exactly once and, in the same transaction, opens the reply
   * window for the sender and runs `onNew` (which queues the webhook). Returns false for a
   * message that was already recorded.
   */
  async recordInbound(
    sessionId: string,
    message: InboundMessage,
    windowJids: string[],
    onNew: (client: Queryable) => Promise<void>,
  ): Promise<boolean> {
    const client = await this.db.pool.connect();
    try {
      await client.query('BEGIN');
      const seen = await client.query(
        `INSERT INTO ${this.db.table('seen_messages')} ("session_id", "message_id") VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [sessionId, message.messageId],
      );
      if ((seen.rowCount ?? 0) === 0) {
        await client.query('ROLLBACK');
        return false;
      }
      await client.query(
        `INSERT INTO ${this.db.table('chat_windows')} ("session_id", "jid", "last_inbound_at")
         SELECT $1, j, LEAST(to_timestamp($3), now()) FROM unnest($2::text[]) AS t(j)
         ON CONFLICT ("session_id", "jid") DO UPDATE
           SET "last_inbound_at" = GREATEST(${this.db.table('chat_windows')}."last_inbound_at", EXCLUDED."last_inbound_at")`,
        [sessionId, windowJids, message.timestamp],
      );
      await onNew(client);
      await client.query('COMMIT');
      return true;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async hasOpenWindow(sessionId: string, jids: string[], since: Date): Promise<boolean> {
    const { rows } = await this.db.pool.query(
      `SELECT 1 FROM ${this.db.table('chat_windows')} WHERE "session_id" = $1 AND "jid" = ANY($2::text[]) AND "last_inbound_at" >= $3 LIMIT 1`,
      [sessionId, jids, since],
    );
    return rows.length > 0;
  }

  async claimSend(sessionId: string, key: string): Promise<SendClaim> {
    const table = this.db.table('sent_messages');
    const inserted = await this.db.pool.query(
      `INSERT INTO ${table} ("session_id", "idempotency_key", "message_id") VALUES ($1, $2, '') ON CONFLICT DO NOTHING`,
      [sessionId, key],
    );
    if ((inserted.rowCount ?? 0) > 0) return { claimed: true };

    const { rows } = await this.db.pool.query<{ message_id: string }>(
      `SELECT "message_id" FROM ${table} WHERE "session_id" = $1 AND "idempotency_key" = $2`,
      [sessionId, key],
    );
    const messageId = rows[0]?.message_id;
    return { claimed: false, messageId: messageId ? messageId : null };
  }

  async completeSend(sessionId: string, key: string, messageId: string): Promise<void> {
    await this.db.pool.query(
      `UPDATE ${this.db.table('sent_messages')} SET "message_id" = $3 WHERE "session_id" = $1 AND "idempotency_key" = $2`,
      [sessionId, key, messageId],
    );
  }

  async releaseSend(sessionId: string, key: string): Promise<void> {
    await this.db.pool.query(
      `DELETE FROM ${this.db.table('sent_messages')} WHERE "session_id" = $1 AND "idempotency_key" = $2 AND "message_id" = ''`,
      [sessionId, key],
    );
  }

  /** Drops old bookkeeping so the database does not grow without bound. */
  async prune(): Promise<void> {
    const cutoff = `now() - interval '${RETENTION_DAYS} days'`;
    await this.db.pool.query(`DELETE FROM ${this.db.table('seen_messages')} WHERE "received_at" < ${cutoff}`);
    await this.db.pool.query(`DELETE FROM ${this.db.table('sent_messages')} WHERE "created_at" < ${cutoff}`);
    await this.db.pool.query(`DELETE FROM ${this.db.table('chat_windows')} WHERE "last_inbound_at" < ${cutoff}`);
    await this.db.pool.query(
      `DELETE FROM ${this.db.table('webhook_outbox')}
       WHERE ("delivered_at" IS NOT NULL AND "delivered_at" < now() - interval '3 days')
          OR ("failed_at" IS NOT NULL AND "failed_at" < now() - interval '14 days')`,
    );
  }
}
