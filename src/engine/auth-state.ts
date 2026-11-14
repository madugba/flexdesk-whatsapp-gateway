import type pg from 'pg';
import { BufferJSON, initAuthCreds, proto } from '@whiskeysockets/baileys';
import type { AuthenticationCreds, AuthenticationState, SignalDataSet, SignalDataTypeMap } from '@whiskeysockets/baileys';
import type { Database } from '../db/database.js';
import type { SecretBox } from '../lib/secret-box.js';

type Category = keyof SignalDataTypeMap;

const credsContext = (sessionId: string) => `${sessionId}/creds`;
const keyContext = (sessionId: string, category: string, id: string) => `${sessionId}/${category}/${id}`;

const serialize = (value: unknown) => Buffer.from(JSON.stringify(value, BufferJSON.replacer), 'utf8');
const deserialize = <T>(data: Buffer): T => JSON.parse(data.toString('utf8'), BufferJSON.reviver) as T;

export interface LoadedAuthState {
  state: AuthenticationState;
  /** Persists the credentials. Writes are serialized so an older snapshot never overwrites a newer one. */
  saveCreds(): Promise<void>;
}

/**
 * Stores a session's WhatsApp credentials and Signal keys in Postgres, encrypted with
 * AES-256-GCM and bound to their row. Replaces Baileys' file-based store, which its own
 * documentation says is not meant for production.
 */
export class PostgresAuthStore {
  constructor(
    private readonly db: Database,
    private readonly box: SecretBox,
  ) {}

  async load(sessionId: string): Promise<LoadedAuthState> {
    const sessions = this.db.table('sessions');
    const { rows } = await this.db.pool.query<{ creds_enc: Buffer | null }>(
      `SELECT "creds_enc" FROM ${sessions} WHERE "id" = $1`,
      [sessionId],
    );
    const stored = rows[0]?.creds_enc;
    const creds: AuthenticationCreds = stored
      ? deserialize<AuthenticationCreds>(this.box.open(stored, credsContext(sessionId)))
      : initAuthCreds();

    let pending: Promise<void> = Promise.resolve();
    const saveCreds = () => {
      pending = pending.then(() =>
        this.db.pool
          .query(`UPDATE ${sessions} SET "creds_enc" = $2, "updated_at" = now() WHERE "id" = $1`, [
            sessionId,
            this.box.seal(serialize(creds), credsContext(sessionId)),
          ])
          .then(() => undefined),
      );
      return pending;
    };

    return {
      state: {
        creds,
        keys: {
          get: (type, ids) => this.getKeys(sessionId, type, ids),
          set: (data) => this.setKeys(sessionId, data),
        },
      },
      saveCreds,
    };
  }

  private async getKeys<T extends Category>(sessionId: string, type: T, ids: string[]) {
    const result: { [id: string]: SignalDataTypeMap[T] } = {};
    if (ids.length === 0) return result;

    const { rows } = await this.db.pool.query<{ key_id: string; value_enc: Buffer }>(
      `SELECT "key_id", "value_enc" FROM ${this.db.table('auth_keys')}
       WHERE "session_id" = $1 AND "category" = $2 AND "key_id" = ANY($3::text[])`,
      [sessionId, type, ids],
    );
    for (const row of rows) {
      let value = deserialize<SignalDataTypeMap[T]>(this.box.open(row.value_enc, keyContext(sessionId, type, row.key_id)));
      if (type === 'app-state-sync-key' && value) {
        value = proto.Message.AppStateSyncKeyData.fromObject(value as object) as unknown as SignalDataTypeMap[T];
      }
      result[row.key_id] = value;
    }
    return result;
  }

  private async setKeys(sessionId: string, data: SignalDataSet): Promise<void> {
    const upsert = { categories: [] as string[], ids: [] as string[], values: [] as Buffer[] };
    const remove = { categories: [] as string[], ids: [] as string[] };

    for (const [category, entries] of Object.entries(data)) {
      for (const [id, value] of Object.entries(entries ?? {})) {
        if (value === null || value === undefined) {
          remove.categories.push(category);
          remove.ids.push(id);
        } else {
          upsert.categories.push(category);
          upsert.ids.push(id);
          upsert.values.push(this.box.seal(serialize(value), keyContext(sessionId, category, id)));
        }
      }
    }
    if (upsert.ids.length === 0 && remove.ids.length === 0) return;

    const client: pg.PoolClient = await this.db.pool.connect();
    try {
      await client.query('BEGIN');
      if (upsert.ids.length > 0) {
        await client.query(
          `INSERT INTO ${this.db.table('auth_keys')} ("session_id", "category", "key_id", "value_enc")
           SELECT $1, c, i, v FROM unnest($2::text[], $3::text[], $4::bytea[]) AS t(c, i, v)
           ON CONFLICT ("session_id", "category", "key_id") DO UPDATE SET "value_enc" = EXCLUDED."value_enc"`,
          [sessionId, upsert.categories, upsert.ids, upsert.values],
        );
      }
      if (remove.ids.length > 0) {
        await client.query(
          `DELETE FROM ${this.db.table('auth_keys')}
           WHERE "session_id" = $1 AND ("category", "key_id") IN (SELECT c, i FROM unnest($2::text[], $3::text[]) AS t(c, i))`,
          [sessionId, remove.categories, remove.ids],
        );
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}
