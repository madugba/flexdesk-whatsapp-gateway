import { createDatabase, type Database } from '../../src/db/database.js';
import { migrate } from '../../src/db/migrate.js';
import { createLogger } from '../../src/lib/logger.js';
import { testConfig } from './env.js';
import type { Config } from '../../src/config.js';

export interface TestDb {
  db: Database;
  config: Config;
  logger: ReturnType<typeof createLogger>;
  cleanup(): Promise<void>;
}

/** A migrated database in a schema of its own, so test files never see each other's rows. */
export async function createTestDb(overrides: Record<string, string> = {}): Promise<TestDb> {
  const config = testConfig(overrides);
  const logger = createLogger('silent');
  const db = createDatabase(config, logger);
  await migrate(db, config.DB_SCHEMA, logger);
  return {
    db,
    config,
    logger,
    cleanup: async () => {
      await db.pool.query(`DROP SCHEMA IF EXISTS "${config.DB_SCHEMA}" CASCADE`);
      await db.close();
    },
  };
}
