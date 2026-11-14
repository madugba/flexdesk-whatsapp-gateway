import { randomBytes } from 'node:crypto';
import { loadConfig, type Config } from '../../src/config.js';

export const TEST_API_KEY = 'a'.repeat(40);
export const TEST_WEBHOOK_SECRET = 'w'.repeat(40);

export function testConfig(overrides: Record<string, string> = {}): Config {
  return loadConfig({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgresql://postgres@localhost:5432/gateway_test',
    DB_SSL: 'false',
    DB_SCHEMA: `t_${randomBytes(4).toString('hex')}`,
    GATEWAY_API_KEYS: TEST_API_KEY,
    GATEWAY_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    WEBHOOK_URL: 'http://127.0.0.1:9/hook',
    WEBHOOK_SECRET: TEST_WEBHOOK_SECRET,
    SEND_MIN_INTERVAL_MS: '0',
    ...overrides,
  });
}
