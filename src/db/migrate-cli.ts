import { loadConfig } from '../config.js';
import { createLogger } from '../lib/logger.js';
import { createDatabase } from './database.js';
import { migrate } from './migrate.js';

const config = loadConfig();
const logger = createLogger(config.LOG_LEVEL);
const db = createDatabase(config, logger);

try {
  const applied = await migrate(db, config.DB_SCHEMA, logger);
  logger.info({ applied }, 'Migrations complete');
} finally {
  await db.close();
}
