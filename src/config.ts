import { z } from 'zod';

const SCHEMA_NAME = /^[a-z_][a-z0-9_]{0,62}$/;

const boolean = z
  .enum(['true', 'false'])
  .transform((value) => value === 'true');

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('production'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  DATABASE_URL: z.string().min(1),
  DB_SCHEMA: z.string().regex(SCHEMA_NAME, 'must be a lowercase identifier').default('wa_gateway'),
  DB_SSL: boolean.default(true),
  DB_SSL_CA: z.string().optional(),
  GATEWAY_API_KEYS: z
    .string()
    .transform((value) => value.split(',').map((key) => key.trim()).filter(Boolean))
    .pipe(z.array(z.string().min(32, 'each API key must be at least 32 characters')).min(1).max(2)),
  GATEWAY_ENCRYPTION_KEY: z
    .string()
    .refine((value) => Buffer.from(value, 'base64').length === 32, 'must be 32 random bytes, base64-encoded'),
  WEBHOOK_URL: z.url(),
  WEBHOOK_SECRET: z.string().min(32, 'must be at least 32 characters'),
  MAX_SESSIONS: z.coerce.number().int().min(1).max(500).default(20),
  REPLY_WINDOW_HOURS: z.coerce.number().min(1).max(72).default(24),
  SEND_MIN_INTERVAL_MS: z.coerce.number().int().min(0).default(1500),
  SEND_MAX_PER_HOUR: z.coerce.number().int().min(1).default(300),
  SEND_MAX_QUEUE: z.coerce.number().int().min(1).default(50),
  MARK_READ: boolean.default(true),
  /** This service's own public address, for keeping itself awake. Render sets RENDER_EXTERNAL_URL by itself. */
  KEEP_ALIVE_URL: z.url().optional(),
  RENDER_EXTERNAL_URL: z.url().optional(),
  /** Under Render's 15-minute sleep timeout. */
  KEEP_ALIVE_MINUTES: z.coerce.number().int().min(1).max(14).default(10),
});

export type Config = z.infer<typeof envSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => `  ${issue.path.join('.')}: ${issue.message}`).join('\n');
    throw new Error(`Invalid configuration:\n${problems}`);
  }

  const config = parsed.data;
  const webhook = new URL(config.WEBHOOK_URL);
  const isLocalhost = webhook.hostname === 'localhost' || webhook.hostname === '127.0.0.1';
  if (config.NODE_ENV === 'production' && webhook.protocol !== 'https:' && !isLocalhost) {
    throw new Error('Invalid configuration:\n  WEBHOOK_URL: must use https in production');
  }
  return config;
}

/** Where the service should ask for itself to stay awake, or null when it isn't on a host that sleeps it. */
export function keepAliveUrl(config: Config): string | null {
  return config.KEEP_ALIVE_URL ?? config.RENDER_EXTERNAL_URL ?? null;
}
