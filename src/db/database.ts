import pg from 'pg';
import type { Config } from '../config.js';
import type { Logger } from '../lib/logger.js';

export interface Database {
  readonly pool: pg.Pool;
  /** Schema-qualified, quoted table name. The schema is validated at config load. */
  table(name: string): string;
  /** A dedicated connection that is not returned to the pool (used for the leader lock). */
  dedicatedClient(): Promise<pg.Client>;
  close(): Promise<void>;
}

function sslOptions(config: Config, logger: Logger): pg.ClientConfig['ssl'] {
  if (!config.DB_SSL) return undefined;
  if (config.DB_SSL_CA) return { ca: config.DB_SSL_CA.replace(/\\n/g, '\n'), rejectUnauthorized: true };
  logger.warn('DB_SSL_CA is not set: the database connection is encrypted but the server certificate is not verified');
  return { rejectUnauthorized: false };
}

export function createDatabase(config: Config, logger: Logger): Database {
  const connection: pg.PoolConfig = {
    connectionString: config.DATABASE_URL,
    ssl: sslOptions(config, logger),
    application_name: 'flexdesk-whatsapp-gateway',
  };
  const pool = new pg.Pool({
    ...connection,
    max: 8,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    statement_timeout: 15_000,
  });
  pool.on('error', (error) => logger.error({ error }, 'Idle database client error'));

  return {
    pool,
    table: (name) => `"${config.DB_SCHEMA}"."${name}"`,
    dedicatedClient: async () => {
      const client = new pg.Client({ ...connection, keepAlive: true });
      client.on('error', (error) => logger.warn({ error }, 'Dedicated database client error'));
      await client.connect();
      return client;
    },
    close: () => pool.end(),
  };
}
