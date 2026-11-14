import type pg from 'pg';
import type { Database } from './database.js';
import type { Logger } from '../lib/logger.js';
import { MIGRATIONS } from './migrations.js';

const MIGRATION_LOCK_KEY = 7_265_001;

/** Applies pending migrations. Safe to run from several instances at once and safe to re-run. */
export async function migrate(db: Database, schema: string, logger: Logger): Promise<string[]> {
  const client: pg.PoolClient = await db.pool.connect();
  const applied: string[] = [];
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
    // Created only when missing: `CREATE SCHEMA IF NOT EXISTS` needs database-level rights even if
    // it exists, and the gateway should be able to run as a role that owns just its own schema.
    const exists = await client.query('SELECT 1 FROM pg_namespace WHERE nspname = $1', [schema]);
    if (exists.rowCount === 0) await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query(
      `CREATE TABLE IF NOT EXISTS ${db.table('schema_migrations')} ("id" TEXT PRIMARY KEY, "applied_at" TIMESTAMPTZ NOT NULL DEFAULT now())`,
    );

    const done = new Set(
      (await client.query<{ id: string }>(`SELECT "id" FROM ${db.table('schema_migrations')}`)).rows.map((row) => row.id),
    );

    for (const migration of MIGRATIONS) {
      if (done.has(migration.id)) continue;
      await client.query('BEGIN');
      try {
        await client.query(migration.sql.replaceAll('{schema}', `"${schema}"`));
        await client.query(`INSERT INTO ${db.table('schema_migrations')} ("id") VALUES ($1)`, [migration.id]);
        await client.query('COMMIT');
        applied.push(migration.id);
        logger.info({ migration: migration.id }, 'Applied migration');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]).catch(() => undefined);
    client.release();
  }
  return applied;
}
