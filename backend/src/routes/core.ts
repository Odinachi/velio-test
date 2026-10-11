import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { currentUser, deviceId, parse, requireUser, userDto, uuidParam, type Ctx, type UserRow } from '../context.js';
import { withTx } from '../db/pool.js';
import { track } from '../events.js';
import { ApiError } from '../lib/errors.js';
import {
  availabilityOf,
  createActivity,
  getActivity,
  listActivities,
  listAttendees,
  toDto,
  type ActivityRow,
} from '../services/activities.js';
import { runBookingAttempt } from '../services/attempts.js';
import { bookingDto, cancelBooking, findByIdempotencyKey, takeSpot, type BookingRow } from '../services/bookings.js';

const newUser = z.object({ name: z.string().trim().min(1).max(60) });

const newActivity = z.object({
  title: z.string().trim().min(1).max(120),
  description: z.string().trim().max(2000).default(''),
  location: z.string().trim().max(200).default(''),
  startsAt: z.iso.datetime({ offset: true }).transform((s) => new Date(s)),
  priceCents: z.number().int().min(0).max(10_000_00),
  currency: z.string().length(3).toUpperCase().default('USD'),
  capacity: z.number().int().min(1).max(10_000),
});

const bookBody = z.object({ idempotencyKey: z.string().min(8).max(100) });

const listQuery = z.object({
  hostId: z.uuid().optional(),
  upcoming: z.enum(['true', 'false']).optional(),
});

export async function coreRoutes(app: FastifyInstance, ctx: Ctx) {
  const { db } = ctx;

  // --- Users (simple identity; full auth is out of scope) ---

  app.post('/users', async (req, reply) => {
    const { name } = parse(newUser, req.body);
    const { rows } = await db.query<UserRow>('INSERT INTO users (name) VALUES ($1) RETURNING *', [name]);
    void track(db, {
      name: 'user_signed_up',
      userId: rows[0].id,
      deviceId: deviceId(req),
      props: { generation: 0, source: 'organic' },
    });
    return reply.code(201).send({ user: userDto(rows[0]) });
  });

  app.get('/users', async () => {
    const { rows } = await db.query<UserRow>('SELECT * FROM users ORDER BY created_at DESC LIMIT 100');
    return { users: rows.map(userDto) };
  });

  app.get('/me', async (req) => {
    const user = await requireUser(ctx, req);
    return { user: userDto(user) };
  });

  // --- Activities ---

  app.get('/activities', async (req) => {
    const q = parse(listQuery, req.query);
    return { activities: await listActivities(db, { hostId: q.hostId, upcomingOnly: q.upcoming === 'true' }) };
  });

  app.post('/activities', async (req, reply) => {
    const host = await requireUser(ctx, req);
    const input = parse(newActivity, req.body);
    if (input.startsAt.getTime() <= Date.now()) {
      throw new ApiError(400, 'VALIDATION', 'startsAt: pick a time in the future');
    }
    const row = await withTx(db, (tx) => createActivity(tx, host.id, input));
    void track(db, {
      name: 'activity_created',
      userId: host.id,
      activityId: row.id,
      props: { capacity: row.capacity, price_cents: row.price_cents, experiment_bucket: row.experiment_bucket },
    });
    return reply.code(201).send({ activity: toDto(row) });
  });

  app.get('/activities/:id', async (req) => {
    const { id } = parse(uuidParam, req.params);
    const [row, user] = await Promise.all([getActivity(db, id), currentUser(ctx, req)]);
    let myBooking = null;
    if (user) {
      const { rows } = await db.query<BookingRow>(
        `SELECT * FROM bookings WHERE activity_id = $1 AND user_id = $2 AND status = 'confirmed'`,
        [id, user.id],
      );
      myBooking = rows[0] ? bookingDto(rows[0]) : null;
    }
    return { activity: toDto(row), myBooking, isHost: user?.id === row.host_id };
  });

  app.get('/activities/:id/attendees', async (req) => {
    const { id } = parse(uuidParam, req.params);
    await getActivity(db, id);
    return { attendees: await listAttendees(db, id) };
  });

  // --- Bookings ---

  app.post('/activities/:id/bookings', async (req, reply) => {
    const { id: activityId } = parse(uuidParam, req.params);
    const user = await requireUser(ctx, req);
    const { idempotencyKey } = parse(bookBody, req.body);

    const result = await runBookingAttempt(
      ctx,
      { activityId, userId: user.id, deviceId: deviceId(req), via: 'direct' },
      () => withTx(db, async (tx) => ({ spot: await takeSpot(tx, { activityId, userId: user.id, idempotencyKey }) })),
      async () => {
        const booking = await withTx(db, (tx) => findByIdempotencyKey(tx, idempotencyKey));
        return { spot: { booking: booking!, activity: null, replay: true } };
      },
    );

    const activity = await getActivity(db, activityId);
    return reply
      .code(result.spot.replay ? 200 : 201)
      .send({ booking: bookingDto(result.spot.booking), activity: toDto(activity), replay: result.spot.replay });
  });

  app.get('/me/bookings', async (req) => {
    const user = await requireUser(ctx, req);
    const { rows } = await db.query<BookingRow & { activity: ActivityRow }>(
      `SELECT b.* FROM bookings b
         JOIN activities a ON a.id = b.activity_id
        WHERE b.user_id = $1 AND b.status = 'confirmed'
        ORDER BY a.starts_at ASC`,
      [user.id],
    );
    const activities = await Promise.all(rows.map((b) => getActivity(db, b.activity_id)));
    return { bookings: rows.map((b, i) => ({ ...bookingDto(b), activity: toDto(activities[i]) })) };
  });

  app.delete('/bookings/:id', async (req) => {
    const { id } = parse(uuidParam, req.params);
    const user = await requireUser(ctx, req);
    const { booking, activity } = await withTx(db, (tx) => cancelBooking(tx, id, user.id));
    void ctx.bus.publish(availabilityOf(activity));
    void track(db, { name: 'booking_cancelled', userId: user.id, activityId: booking.activity_id });
    return { booking: bookingDto(booking) };
  });
}
