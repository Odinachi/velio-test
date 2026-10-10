import { config } from '../config.js';
import type { UserRow } from '../context.js';
import type { Db, Tx } from '../db/pool.js';
import { ApiError, isUniqueViolation } from '../lib/errors.js';
import { inviteCode, normalizeCode } from '../lib/ids.js';
import { getActivity, invitesEnabledFor, type ActivityRow } from './activities.js';
import { findByIdempotencyKey, takeSpot, type SpotTaken } from './bookings.js';

export type Rail = 'vouch' | 'public';

export interface InviteRow {
  id: string;
  code: string;
  activity_id: string;
  inviter_id: string;
  rail: Rail;
  contact_label: string | null;
  max_uses: number | null;
  uses: number;
  expires_at: Date;
  created_at: Date;
}

export type InviteStatus = 'valid' | 'expired' | 'used' | 'full';

export const inviteLinks = (code: string) => ({
  url: `${config.webUrl}/i/${code}`,
  deepLink: `velio://invite/${code}`,
});

export const inviteDto = (i: InviteRow) => ({
  id: i.id,
  code: i.code,
  activityId: i.activity_id,
  inviterId: i.inviter_id,
  rail: i.rail,
  contactLabel: i.contact_label,
  uses: i.uses,
  maxUses: i.max_uses,
  expiresAt: i.expires_at.toISOString(),
  createdAt: i.created_at.toISOString(),
  ...inviteLinks(i.code),
});

const inviteNotFound = () =>
  new ApiError(404, 'INVITE_NOT_FOUND', "We couldn't find that invite. Check the code and try again.");

export function statusOf(invite: InviteRow, activity: ActivityRow): InviteStatus {
  if (invite.expires_at.getTime() <= Date.now() || activity.starts_at.getTime() <= Date.now()) return 'expired';
  if (invite.max_uses !== null && invite.uses >= invite.max_uses) return 'used';
  if (activity.spots_taken >= activity.capacity) return 'full';
  return 'valid';
}

/** Only people who are going (or hosting) can invite: an invite is "come with me". */
export async function createInvite(
  db: Db,
  inviter: UserRow,
  activityId: string,
  input: { rail: Rail; contactLabel?: string },
): Promise<{ invite: InviteRow; created: boolean }> {
  const activity = await getActivity(db, activityId);
  if (!invitesEnabledFor(activity.experiment_bucket)) {
    throw new ApiError(403, 'INVITES_DISABLED', "Invites aren't available for this activity.");
  }
  if (activity.starts_at.getTime() <= Date.now()) {
    throw new ApiError(409, 'ACTIVITY_STARTED', 'This activity has already started.');
  }
  if (activity.host_id !== inviter.id) {
    const { rows } = await db.query(
      `SELECT 1 FROM bookings WHERE activity_id = $1 AND user_id = $2 AND status = 'confirmed'`,
      [activityId, inviter.id],
    );
    if (!rows.length) throw new ApiError(403, 'NOT_GOING', 'Book a spot first, then bring your friends.');
  }

  if (input.rail === 'public') {
    // One public link per person per activity, so sharing twice gives the same link.
    const { rows } = await db.query<InviteRow>(
      `SELECT * FROM invites WHERE activity_id = $1 AND inviter_id = $2 AND rail = 'public'`,
      [activityId, inviter.id],
    );
    if (rows[0]) return { invite: rows[0], created: false };
  }

  const expiresAt =
    input.rail === 'vouch'
      ? new Date(Math.min(Date.now() + config.invites.vouchTtlHours * 3600_000, activity.starts_at.getTime()))
      : activity.starts_at;

  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const { rows } = await db.query<InviteRow>(
        `INSERT INTO invites (code, activity_id, inviter_id, rail, contact_label, max_uses, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [
          inviteCode(),
          activityId,
          inviter.id,
          input.rail,
          input.rail === 'vouch' ? input.contactLabel!.trim() : null,
          input.rail === 'vouch' ? 1 : null,
          expiresAt,
        ],
      );
      return { invite: rows[0], created: true };
    } catch (err) {
      if (!isUniqueViolation(err, 'invites_code_key')) throw err;
    }
  }
  throw new Error('could not generate a unique invite code');
}

export async function findInvite(db: Db, rawCode: string) {
  const code = normalizeCode(rawCode);
  const { rows } = await db.query<InviteRow & { inviter_name: string }>(
    `SELECT i.*, u.name AS inviter_name FROM invites i JOIN users u ON u.id = i.inviter_id WHERE i.code = $1`,
    [code],
  );
  if (!rows[0]) throw inviteNotFound();
  const activity = await getActivity(db, rows[0].activity_id);
  return { invite: rows[0], activity, status: statusOf(rows[0], activity) };
}

export interface ClaimResult {
  spot: SpotTaken;
  user: UserRow;
  isNewUser: boolean;
  invite: InviteRow;
  generation: number;
}

/**
 * Claims a spot through an invite, in one transaction:
 * create the guest (if new) → take a spot → count the use → write attribution.
 *
 * If any step fails (sold out, code used up), nothing is kept: no half-created guest,
 * no consumed vouch, no attribution without a booking.
 */
export async function claimInvite(
  tx: Tx,
  input: { code: string; viewer: UserRow | null; name?: string; idempotencyKey: string },
): Promise<ClaimResult> {
  const replay = await findByIdempotencyKey(tx, input.idempotencyKey);
  if (replay) return replayClaim(tx, replay.id);

  // Lock the invite so a single-use vouch can't be claimed twice by two different people.
  const { rows } = await tx.query<InviteRow & { inviter_generation: number }>(
    `SELECT i.*, u.generation AS inviter_generation
       FROM invites i JOIN users u ON u.id = i.inviter_id
      WHERE i.code = $1
        FOR UPDATE OF i`,
    [normalizeCode(input.code)],
  );
  const invite = rows[0];
  if (!invite) throw inviteNotFound();
  if (invite.expires_at.getTime() <= Date.now()) {
    throw new ApiError(410, 'INVITE_EXPIRED', 'This invite has expired.');
  }
  if (input.viewer?.id === invite.inviter_id) {
    throw new ApiError(409, 'OWN_INVITE', "That's your own invite. Send it to a friend!");
  }
  if (invite.max_uses !== null && invite.uses >= invite.max_uses) {
    throw new ApiError(409, 'INVITE_USED', 'This invite was already claimed.');
  }

  const generation = invite.inviter_generation + 1;
  let user = input.viewer;
  const isNewUser = !user;
  if (!user) {
    const name = input.name?.trim();
    if (!name) throw new ApiError(400, 'NAME_REQUIRED', 'Tell us your first name so your friends know you are coming.');
    // Generation is stamped once, at signup, from the invite that brought them.
    const created = await tx.query<UserRow>('INSERT INTO users (name, generation) VALUES ($1, $2) RETURNING *', [
      name,
      generation,
    ]);
    user = created.rows[0];
  }

  const spot = await takeSpot(tx, {
    activityId: invite.activity_id,
    userId: user.id,
    idempotencyKey: input.idempotencyKey,
    inviteId: invite.id,
  });

  await tx.query('UPDATE invites SET uses = uses + 1 WHERE id = $1', [invite.id]);
  await tx.query(
    `INSERT INTO attributions (invitee_id, inviter_id, invite_id, rail, code, activity_id, booking_id, generation, is_new_user)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [user.id, invite.inviter_id, invite.id, invite.rail, invite.code, invite.activity_id, spot.booking.id, generation, isNewUser],
  );

  return { spot, user, isNewUser, invite: { ...invite, uses: invite.uses + 1 }, generation };
}

/** A retried claim returns what the first one did, including the guest account it created. */
export async function replayClaim(tx: Tx, bookingId: string): Promise<ClaimResult> {
  const { rows } = await tx.query(
    `SELECT row_to_json(b) AS booking, row_to_json(u) AS "user", row_to_json(i) AS invite, a.is_new_user, a.generation
       FROM bookings b
       JOIN users u ON u.id = b.user_id
       JOIN invites i ON i.id = b.invite_id
       JOIN attributions a ON a.booking_id = b.id
      WHERE b.id = $1`,
    [bookingId],
  );
  if (!rows[0]) throw new ApiError(422, 'IDEMPOTENCY_KEY_REUSED', 'This request key was already used for a different booking.');
  const r = rows[0];
  const dates = <T>(o: any, keys: string[]): T => {
    for (const k of keys) if (o[k]) o[k] = new Date(o[k]);
    return o;
  };
  return {
    spot: { booking: dates(r.booking, ['created_at', 'cancelled_at']), activity: null, replay: true },
    user: dates(r.user, ['created_at']),
    invite: dates(r.invite, ['expires_at', 'created_at']),
    isNewUser: r.is_new_user,
    generation: r.generation,
  };
}

export async function listMyInvites(db: Db, userId: string) {
  const { rows } = await db.query(
    `SELECT i.*,
            COALESCE(json_agg(json_build_object('name', u.name, 'claimedAt', a.created_at) ORDER BY a.created_at)
                     FILTER (WHERE a.id IS NOT NULL), '[]') AS claims
       FROM invites i
       LEFT JOIN attributions a ON a.invite_id = i.id
       LEFT JOIN users u ON u.id = a.invitee_id
      WHERE i.inviter_id = $1
      GROUP BY i.id
      ORDER BY i.created_at DESC`,
    [userId],
  );
  return rows.map((r) => ({ ...inviteDto(r), claims: r.claims as { name: string; claimedAt: string }[] }));
}
