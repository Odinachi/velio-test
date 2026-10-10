import cors from '@fastify/cors';
import Fastify from 'fastify';
import type { Ctx } from './context.js';
import { ApiError } from './lib/errors.js';
import { coreRoutes } from './routes/core.js';
import { streamRoutes } from './routes/stream.js';

export async function buildApp(ctx: Ctx, opts: { logger?: boolean } = {}) {
  // Long-lived SSE connections would otherwise keep close() waiting forever.
  const app = Fastify({ logger: opts.logger ?? false, forceCloseConnections: true });

  await app.register(cors, {
    origin: true,
    exposedHeaders: ['x-request-id'],
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ApiError) {
      return reply.code(err.status).send({ error: { code: err.code, message: err.message, ...err.details } });
    }
    const e = err as { statusCode?: number; message?: string };
    if (e.statusCode && e.statusCode < 500) {
      return reply.code(e.statusCode).send({ error: { code: 'BAD_REQUEST', message: e.message } });
    }
    req.log.error(err);
    if (!opts.logger) console.error(err);
    return reply.code(500).send({ error: { code: 'INTERNAL', message: 'Something went wrong on our side. Please try again.' } });
  });

  app.get('/health', async () => ({ ok: true }));

  await coreRoutes(app, ctx);
  await streamRoutes(app, ctx);

  return app;
}
