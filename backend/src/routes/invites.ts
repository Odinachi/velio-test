import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { currentUser, deviceId, parse, requireUser, userDto, uuidParam, type Ctx } from '../context.js';
import { withTx } from '../db/pool.js';
import { track } from '../events.js';
import { getActivity, toDto } from '../services/activities.js';
import { runBookingAttempt } from '../services/attempts.js';
import { bookingDto, findByIdempotencyKey, type BookingRow } from '../services/bookings.js';
import {
  claimInvite,
  createInvite,
  findInvite,
  inviteDto,
  listMyInvites,
  replayClaim,
} from '../services/invites.js';

const newInvite = z.discriminatedUnion('rail', [
  z.object({ rail: z.literal('vouch'), contactLabel: z.string().trim().min(1).max(60) }),
  z.object({ rail: z.literal('public') }),
]);

const codeParam = z.object({ code: z.string().min(4).max(20) });

const claimBody = z.object({
  name: z.string().trim().min(1).max(60).optional(),
  idempotencyKey: z.string().min(8).max(100),
});

export async function inviteRoutes(app: FastifyInstance, ctx: Ctx) {
  const { db } = ctx;

  app.post('/activities/:id/invites', async (req, reply) => {
    const { id } = parse(uuidParam, req.params);
    const inviter = await requireUser(ctx, req);
    const input = parse(newInvite, req.body);
    const { invite, created } = await createInvite(db, inviter, id, input);
    if (created) {
      void track(db, {
        name: 'invite_created',
        userId: inviter.id,
        deviceId: deviceId(req),
        activityId: id,
        inviteId: invite.id,
        rail: invite.rail,
      });
    }
    return reply.code(created ? 201 : 200).send({ invite: inviteDto(invite) });
  });

  app.get('/me/invites', async (req) => {
    const user = await requireUser(ctx, req);
    return { invites: await listMyInvites(db, user.id) };
  });

  // Resolving an invite is what we count as an "open".
  app.get('/invites/:code', async (req) => {
    const { code } = parse(codeParam, req.params);
    const [{ invite, activity, status }, viewer] = await Promise.all([findInvite(db, code), currentUser(ctx, req)]);

    let myBooking = null;
    if (viewer) {
      const { rows } = await db.query<BookingRow>(
        `SELECT * FROM bookings WHERE activity_id = $1 AND user_id = $2 AND status = 'confirmed'`,
        [activity.id, viewer.id],
      );
      myBooking = rows[0] ? bookingDto(rows[0]) : null;
    }

    void track(db, {
      name: 'invite_opened',
      userId: viewer?.id,
      deviceId: deviceId(req),
      activityId: activity.id,
      inviteId: invite.id,
      rail: invite.rail,
      props: { status, is_inviter: viewer?.id === invite.inviter_id },
    });

    return {
      invite: {
        code: invite.code,
        rail: invite.rail,
        status,
        contactLabel: invite.contact_label,
        inviter: { id: invite.inviter_id, name: invite.inviter_name },
        expiresAt: invite.expires_at.toISOString(),
      },
      activity: toDto(activity),
      myBooking,
      isInviter: viewer?.id === invite.inviter_id,
    };
  });

  app.post('/invites/:code/claim', async (req, reply) => {
    const { code } = parse(codeParam, req.params);
    const body = parse(claimBody, req.body);
    const viewer = await currentUser(ctx, req);
    const { invite } = await findInvite(db, code);

    const result = await runBookingAttempt(
      ctx,
      { activityId: invite.activity_id, userId: viewer?.id ?? null, deviceId: deviceId(req), via: invite.rail, inviteId: invite.id },
      () => withTx(db, (tx) => claimInvite(tx, { code, viewer, name: body.name, idempotencyKey: body.idempotencyKey })),
      () =>
        withTx(db, async (tx) => {
          const booking = await findByIdempotencyKey(tx, body.idempotencyKey);
          return replayClaim(tx, booking!.id);
        }),
    );

    if (!result.spot.replay) {
      const base = { userId: result.user.id, deviceId: deviceId(req), activityId: invite.activity_id, inviteId: invite.id, rail: invite.rail };
      void track(
        db,
        ...(result.isNewUser
          ? [{ name: 'user_signed_up' as const, ...base, props: { generation: result.user.generation, source: 'invite' } }]
          : []),
        { name: 'spot_claimed', ...base, props: { is_new_user: result.isNewUser, generation: result.generation } },
      );
    }

    const activity = await getActivity(db, invite.activity_id);
    return reply.code(result.spot.replay ? 200 : 201).send({
      user: userDto(result.user),
      booking: bookingDto(result.spot.booking),
      activity: toDto(activity),
      isNewUser: result.isNewUser,
      replay: result.spot.replay,
    });
  });
}
