import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { currentUser, deviceId, parse, type Ctx } from '../context.js';
import { track, type TrackedEvent } from '../events.js';

// Clients may only send events the server can't observe itself.
const clientEvent = z.discriminatedUnion('name', [
  z.object({ name: z.literal('activity_viewed'), activityId: z.uuid() }),
  z.object({
    name: z.literal('availability_received'),
    activityId: z.uuid(),
    // Commit → client receive, already corrected for clock offset by the client.
    latencyMs: z.number().min(0).max(600_000),
    version: z.number().int().optional(),
  }),
]);
const eventsBody = z.object({ events: z.array(clientEvent).min(1).max(100) });

const REPORT_VIEWS = {
  oversold: 'v_slo_oversold',
  bookingSuccess: 'v_slo_booking_success',
  availabilityLatency: 'v_slo_availability_latency',
  bookersWhoInvite: 'v_goal_bookers_who_invite',
  inviteConversion: 'v_goal_invite_conversion',
  kFactorByRail: 'v_k_factor_by_rail',
  plansHappened: 'v_plans_happened',
  funnel: 'v_invite_funnel',
  holdout: 'v_invite_holdout',
} as const;

export async function trackingRoutes(app: FastifyInstance, ctx: Ctx) {
  const { db, metrics } = ctx;

  app.post('/events', async (req, reply) => {
    const { events } = parse(eventsBody, req.body);
    const user = await currentUser(ctx, req);
    const device = deviceId(req);
    const rows: TrackedEvent[] = events.map((e) => {
      if (e.name === 'availability_received') {
        metrics.availabilityLatency.observe(e.latencyMs / 1000);
        return {
          name: e.name,
          userId: user?.id,
          deviceId: device,
          activityId: e.activityId,
          props: { latency_ms: Math.round(e.latencyMs), version: e.version },
        };
      }
      return { name: e.name, userId: user?.id, deviceId: device, activityId: e.activityId };
    });
    await track(db, ...rows);
    return reply.code(202).send({ accepted: rows.length });
  });

  app.get('/metrics', async (_req, reply) => {
    reply.header('content-type', metrics.registry.contentType);
    return metrics.registry.metrics();
  });

  /** Every scope goal, its current value and target, from the SQL views. */
  app.get('/admin/report', async () => {
    const entries = await Promise.all(
      Object.entries(REPORT_VIEWS).map(async ([k, view]) => [k, (await db.query(`SELECT * FROM ${view}`)).rows] as const),
    );
    const r = Object.fromEntries(entries) as Record<keyof typeof REPORT_VIEWS, any[]>;
    const success = r.bookingSuccess[0];
    const latency = r.availabilityLatency[0];
    const conversion = r.inviteConversion.find((x) => x.rail === 'vouch');
    const inviters = r.bookersWhoInvite.find((x) => x.segment === 'all bookers');
    const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));

    return {
      generatedAt: new Date().toISOString(),
      goals: [
        goal('Never oversell an activity', 'technical', num(r.oversold[0].oversold_activities), 0, (v) => v === 0, 'activities'),
        goal('Bookings succeed when spots exist', 'technical', num(success.success_rate_pct), 99.5, (v) => v >= 99.5, '%'),
        goal('Availability feels live (p95)', 'technical', num(latency.p95_ms), 2000, (v) => v <= 2000, 'ms'),
        goal('Bookers become inviters', 'product', num(inviters?.invite_rate_pct), 30, (v) => v >= 30, '%'),
        goal('Vouch invites turn into guests', 'product', num(conversion?.conversion_pct), 25, (v) => v >= 25, '%'),
      ],
      views: r,
    };
  });
}

function goal(name: string, type: string, value: number | null, target: number, ok: (v: number) => boolean, unit: string) {
  return { name, type, value, target, unit, status: value === null ? 'no_data' : ok(value) ? 'met' : 'missed' };
}
