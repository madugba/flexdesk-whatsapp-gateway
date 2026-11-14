import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { z } from 'zod';
import { GatewayError } from '../lib/errors.js';
import type { Logger } from '../lib/logger.js';
import type { SessionManager } from '../sessions/session-manager.js';
import type { WebhookOutbox } from '../webhooks/outbox.js';
import { createApiKeyVerifier } from './api-key-auth.js';
import { decodeDocument, documentBody, MAX_DOCUMENT_REQUEST_BYTES } from './document-body.js';

export interface ServerDeps {
  manager: SessionManager;
  outbox: WebhookOutbox;
  isLeader: () => boolean;
  apiKeys: string[];
  logger: Logger;
}

const sessionBody = z.object({ sessionId: z.string() }).strict();
const messageBody = z
  .object({
    to: z.string().min(1).max(64),
    text: z.string().min(1).max(4096),
    idempotencyKey: z.string().min(8).max(128).optional(),
  })
  .strict();

export async function buildServer(deps: ServerDeps): Promise<FastifyInstance> {
  const app = Fastify({
    loggerInstance: deps.logger as unknown as FastifyBaseLogger,
    bodyLimit: 64 * 1024,
    trustProxy: true,
  });
  const isAuthorized = createApiKeyVerifier(deps.apiKeys);

  await app.register(rateLimit, { max: 300, timeWindow: '1 minute' });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof GatewayError) {
      if (error.retryAfterSeconds) reply.header('retry-after', String(error.retryAfterSeconds));
      return reply.status(error.httpStatus).send({ error: { code: error.code, message: error.message } });
    }
    if (error instanceof z.ZodError) {
      return reply.status(422).send({
        error: { code: 'invalid_request', message: 'The request is invalid.', details: error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })) },
      });
    }
    const statusCode = (error as { statusCode?: number }).statusCode;
    if (typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500) {
      return reply.status(statusCode).send({ error: { code: 'bad_request', message: (error as Error).message } });
    }
    request.log.error({ error }, 'Unhandled error');
    return reply.status(500).send({ error: { code: 'internal_error', message: 'Something went wrong.' } });
  });

  app.setNotFoundHandler((_request, reply) => reply.status(404).send({ error: { code: 'not_found', message: 'Not found.' } }));

  // Liveness only: no secrets, no database. Safe to expose and to ping.
  app.get('/healthz', async () => ({ status: 'ok' }));

  await app.register(
    async (api) => {
      api.addHook('onRequest', async (request, reply) => {
        reply.header('cache-control', 'no-store');
        if (!isAuthorized(request.headers.authorization)) {
          return reply.status(401).header('www-authenticate', 'Bearer').send({ error: { code: 'unauthorized', message: 'Invalid or missing API key.' } });
        }
      });

      api.get('/status', async () => {
        const memory = process.memoryUsage();
        return {
          leader: deps.isLeader(),
          ready: deps.manager.isActive,
          sessions: deps.manager.sessionCount,
          webhooks: await deps.outbox.stats(),
          memory: { rssMb: Math.round(memory.rss / 1_048_576), heapUsedMb: Math.round(memory.heapUsed / 1_048_576) },
          uptimeSeconds: Math.round(process.uptime()),
        };
      });

      api.post('/sessions', async (request) => deps.manager.create(sessionBody.parse(request.body).sessionId));
      api.get('/sessions', async () => ({ sessions: await deps.manager.list() }));
      api.get<{ Params: { id: string } }>('/sessions/:id', async (request) => deps.manager.get(request.params.id));
      api.post<{ Params: { id: string } }>('/sessions/:id/reconnect', async (request) => deps.manager.reconnect(request.params.id));
      api.delete<{ Params: { id: string } }>('/sessions/:id', async (request, reply) => {
        await deps.manager.remove(request.params.id);
        return reply.status(204).send();
      });
      api.post<{ Params: { id: string } }>('/sessions/:id/messages', async (request) => {
        const body = messageBody.parse(request.body);
        return deps.manager.send(request.params.id, body.to, body.text, body.idempotencyKey);
      });
      // Only this route accepts a large body; everything else keeps the small default.
      api.post<{ Params: { id: string } }>('/sessions/:id/documents', { bodyLimit: MAX_DOCUMENT_REQUEST_BYTES }, async (request) => {
        const body = documentBody.parse(request.body);
        return deps.manager.sendDocument(request.params.id, body.to, decodeDocument(body), body.idempotencyKey);
      });
    },
    { prefix: '/v1' },
  );

  return app;
}
