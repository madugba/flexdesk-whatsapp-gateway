import { keepAliveUrl, loadConfig } from './config.js';
import { KeepAlive } from './keep-alive.js';
import { createDatabase } from './db/database.js';
import { LeaderLock } from './db/leader-lock.js';
import { migrate } from './db/migrate.js';
import { BaileysEngineFactory } from './engine/baileys-engine.js';
import { PostgresAuthStore } from './engine/auth-state.js';
import { buildServer } from './http/server.js';
import { createLogger } from './lib/logger.js';
import { SecretBox } from './lib/secret-box.js';
import { Maintenance } from './maintenance.js';
import { SessionManager } from './sessions/session-manager.js';
import { SessionRepository } from './sessions/session-repository.js';
import { WebhookDispatcher } from './webhooks/dispatcher.js';
import { WebhookOutbox } from './webhooks/outbox.js';

const SHUTDOWN_TIMEOUT_MS = 20_000;

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.LOG_LEVEL);
  const db = createDatabase(config, logger);

  await migrate(db, config.DB_SCHEMA, logger);

  const repository = new SessionRepository(db);
  const outbox = new WebhookOutbox(db);
  const dispatcher = new WebhookDispatcher(outbox, { url: config.WEBHOOK_URL, secret: config.WEBHOOK_SECRET }, logger);
  const engines = new BaileysEngineFactory(new PostgresAuthStore(db, new SecretBox(config.GATEWAY_ENCRYPTION_KEY)), logger);
  const manager = new SessionManager({
    repository,
    engines,
    outbox,
    dispatcher,
    logger,
    options: {
      maxSessions: config.MAX_SESSIONS,
      replyWindowHours: config.REPLY_WINDOW_HOURS,
      markRead: config.MARK_READ,
      send: { minIntervalMs: config.SEND_MIN_INTERVAL_MS, maxPerHour: config.SEND_MAX_PER_HOUR, maxQueued: config.SEND_MAX_QUEUE },
    },
  });
  const maintenance = new Maintenance(repository, () => manager.sessionCount, logger);

  const leader = new LeaderLock(
    db,
    {
      onAcquired: async () => {
        dispatcher.start();
        maintenance.start();
        await manager.activate();
      },
      onLost: async () => {
        maintenance.stop();
        await dispatcher.stop();
        await manager.deactivate();
      },
    },
    logger,
  );

  // The HTTP server starts first so Render's health check passes while a previous instance
  // still holds the leader lock during a deploy.
  const app = await buildServer({ manager, outbox, isLeader: () => leader.isLeader, apiKeys: config.GATEWAY_API_KEYS, logger });
  await app.listen({ port: config.PORT, host: '0.0.0.0' });
  leader.start();

  const awakeUrl = keepAliveUrl(config);
  const keepAlive = awakeUrl ? new KeepAlive({ url: awakeUrl, intervalMs: config.KEEP_ALIVE_MINUTES * 60_000 }, logger) : null;
  keepAlive?.start();
  logger.info({ keepAlive: keepAlive ? `every ${config.KEEP_ALIVE_MINUTES} minutes` : 'off' }, 'Keep-alive');

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'Shutting down');
    const force = setTimeout(() => {
      logger.error('Shutdown timed out');
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    force.unref();

    await app.close().catch((error: unknown) => logger.error({ error }, 'Closing the HTTP server failed'));
    keepAlive?.stop();
    maintenance.stop();
    await dispatcher.stop();
    await manager.deactivate();
    await leader.stop();
    await db.close().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('unhandledRejection', (error) => logger.error({ error }, 'Unhandled rejection'));
  process.on('uncaughtException', (error) => {
    logger.fatal({ error }, 'Uncaught exception');
    void shutdown('uncaughtException');
  });
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
