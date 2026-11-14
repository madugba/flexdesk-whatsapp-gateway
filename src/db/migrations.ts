export interface Migration {
  id: string;
  /** `{schema}` is replaced with the quoted schema name. */
  sql: string;
}

/** Append-only. Never edit a migration that has been released. */
export const MIGRATIONS: Migration[] = [
  {
    id: '001_initial',
    sql: `
      CREATE TABLE IF NOT EXISTS {schema}."sessions" (
        "id"                     TEXT PRIMARY KEY,
        "status"                 TEXT NOT NULL DEFAULT 'connecting',
        "phone"                  TEXT,
        "creds_enc"              BYTEA,
        "last_connected_at"      TIMESTAMPTZ,
        "last_disconnect_code"   INTEGER,
        "last_disconnect_reason" TEXT,
        "created_at"             TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updated_at"             TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS {schema}."auth_keys" (
        "session_id" TEXT NOT NULL REFERENCES {schema}."sessions"("id") ON DELETE CASCADE,
        "category"   TEXT NOT NULL,
        "key_id"     TEXT NOT NULL,
        "value_enc"  BYTEA NOT NULL,
        PRIMARY KEY ("session_id", "category", "key_id")
      );

      CREATE TABLE IF NOT EXISTS {schema}."chat_windows" (
        "session_id"      TEXT NOT NULL REFERENCES {schema}."sessions"("id") ON DELETE CASCADE,
        "jid"             TEXT NOT NULL,
        "last_inbound_at" TIMESTAMPTZ NOT NULL,
        PRIMARY KEY ("session_id", "jid")
      );

      CREATE TABLE IF NOT EXISTS {schema}."seen_messages" (
        "session_id"  TEXT NOT NULL REFERENCES {schema}."sessions"("id") ON DELETE CASCADE,
        "message_id"  TEXT NOT NULL,
        "received_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY ("session_id", "message_id")
      );
      CREATE INDEX IF NOT EXISTS "seen_messages_received_at_idx" ON {schema}."seen_messages" ("received_at");

      CREATE TABLE IF NOT EXISTS {schema}."sent_messages" (
        "session_id"      TEXT NOT NULL REFERENCES {schema}."sessions"("id") ON DELETE CASCADE,
        "idempotency_key" TEXT NOT NULL,
        "message_id"      TEXT NOT NULL,
        "created_at"      TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY ("session_id", "idempotency_key")
      );
      CREATE INDEX IF NOT EXISTS "sent_messages_created_at_idx" ON {schema}."sent_messages" ("created_at");

      CREATE TABLE IF NOT EXISTS {schema}."webhook_outbox" (
        "id"              BIGSERIAL PRIMARY KEY,
        "session_id"      TEXT NOT NULL,
        "event_type"      TEXT NOT NULL,
        "payload"         JSONB NOT NULL,
        "attempts"        INTEGER NOT NULL DEFAULT 0,
        "next_attempt_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "delivered_at"    TIMESTAMPTZ,
        "failed_at"       TIMESTAMPTZ,
        "last_error"      TEXT,
        "created_at"      TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS "webhook_outbox_due_idx" ON {schema}."webhook_outbox" ("next_attempt_at")
        WHERE "delivered_at" IS NULL AND "failed_at" IS NULL;

      -- Defence in depth: if this schema were ever exposed through Supabase's API, the
      -- roles it uses (anon, authenticated) have no policies and so can read nothing.
      -- The owning role (the gateway) is unaffected.
      ALTER TABLE {schema}."sessions" ENABLE ROW LEVEL SECURITY;
      ALTER TABLE {schema}."auth_keys" ENABLE ROW LEVEL SECURITY;
      ALTER TABLE {schema}."chat_windows" ENABLE ROW LEVEL SECURITY;
      ALTER TABLE {schema}."seen_messages" ENABLE ROW LEVEL SECURITY;
      ALTER TABLE {schema}."sent_messages" ENABLE ROW LEVEL SECURITY;
      ALTER TABLE {schema}."webhook_outbox" ENABLE ROW LEVEL SECURITY;
    `,
  },
];
