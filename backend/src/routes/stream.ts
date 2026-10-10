import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parse, type Ctx } from '../context.js';
import type { AvailabilityUpdate } from '../realtime.js';

const query = z.object({
  // Comma-separated activity ids. Omit to receive every activity (host dashboards, lists).
  activityIds: z
    .string()
    .optional()
    .transform((s) => (s ? s.split(',').filter(Boolean) : []))
    .pipe(z.array(z.uuid()).max(200)),
});

const HEARTBEAT_MS = 15_000;

/**
 * Live availability over Server-Sent Events.
 *
 * One-way server → client is all availability needs, and SSE gives us automatic reconnects and
 * plain HTTP. Clients should refetch on reconnect and ignore updates whose `version` is not newer
 * than what they hold.
 */
export async function streamRoutes(app: FastifyInstance, ctx: Ctx) {
  app.get('/stream', async (req, reply) => {
    const { activityIds } = parse(query, req.query);

    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
      // hijack() bypasses the CORS plugin, so set the header ourselves.
      'access-control-allow-origin': (req.headers.origin as string) ?? '*',
      vary: 'Origin',
    });
    res.socket?.setNoDelay(true);

    const send = (event: string, data: unknown, id?: string) => {
      res.write(`${id ? `id: ${id}\n` : ''}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    // The server clock lets clients correct for skew when they report latency.
    res.write('retry: 2000\n\n');
    send('hello', { serverTime: Date.now() });

    const onUpdate = (u: AvailabilityUpdate) => {
      send('availability', u, `${u.activityId}:${u.version}`);
      ctx.metrics.fanoutLatency.observe(Math.max(0, Date.now() - u.committedAt) / 1000);
    };
    const unsubscribers = activityIds.length
      ? activityIds.map((id) => ctx.bus.subscribe(id, onUpdate))
      : [ctx.bus.subscribe('*', onUpdate)];

    const heartbeat = setInterval(() => send('ping', { serverTime: Date.now() }), HEARTBEAT_MS);
    ctx.metrics.sseClients.inc();

    let closed = false;
    const cleanup = () => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      unsubscribers.forEach((u) => u());
      ctx.metrics.sseClients.dec();
    };
    req.raw.on('close', cleanup);
    res.on('error', cleanup);
  });
}
