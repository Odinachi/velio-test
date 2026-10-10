import type { Tx } from '../db/pool.js';
import { ApiError, notFound } from '../lib/errors.js';

export interface BookingRow {
  id: string;
  activity_id: string;
  plan_id: string;
  user_id: string;
  status: 'confirmed' | 'cancelled';
  invite_id: string | null;
  idempotency_key: string;
  created_at: Date;
  cancelled_at: Date | null;
}

export interface BookingDto {
  id: string;
  activityId: string;
  planId: string;
  userId: string;
  status: 'confirmed' | 'cancelled';
  inviteId: string | null;
  createdAt: string;
}

export const bookingDto = (b: BookingRow): BookingDto => ({
  id: b.id,
  activityId: b.activity_id,
  planId: b.plan_id,
  userId: b.user_id,
  status: b.status,
  inviteId: b.invite_id,
  createdAt: b.created_at.toISOString(),
});

export interface SpotTaken {
  booking: BookingRow;
  /** The activity's availability right after this booking. Null on an idempotent replay. */
  activity: { id: string; spots_taken: number; capacity: number; version: string } | null;
  replay: boolean;
}

export const soldOut = () =>
  new ApiError(409, 'SOLD_OUT', 'Someone grabbed the last spot a moment before you.');

export async function findByIdempotencyKey(tx: Tx, key: string): Promise<BookingRow | null> {
  const { rows } = await tx.query<BookingRow>('SELECT * FROM bookings WHERE idempotency_key = $1', [key]);
  return rows[0] ?? null;
}

/**
 * Takes one spot for `userId`, inside the caller's transaction.
 *
 * The guarantee against overselling is the conditional UPDATE below: Postgres row-locks the
 * activity, and every queued transaction re-checks `spots_taken < capacity` against the latest
 * committed value. Exactly `capacity` of them can ever match. If anything after it fails, the
 * caller's transaction rolls back and the spot is released with it. The CHECK constraint on
 * `activities` is a second, independent guard.
 */
export async function takeSpot(
  tx: Tx,
  input: { activityId: string; userId: string; idempotencyKey: string; inviteId?: string | null },
): Promise<SpotTaken> {
  const existing = await findByIdempotencyKey(tx, input.idempotencyKey);
  if (existing) {
    if (existing.user_id !== input.userId || existing.activity_id !== input.activityId) {
      throw new ApiError(422, 'IDEMPOTENCY_KEY_REUSED', 'This request key was already used for a different booking.');
    }
    return { booking: existing, activity: null, replay: true };
  }

  const { rows: mine } = await tx.query(
    `SELECT 1 FROM bookings WHERE activity_id = $1 AND user_id = $2 AND status = 'confirmed'`,
    [input.activityId, input.userId],
  );
  if (mine.length) throw alreadyBooked();

  const { rows: updated } = await tx.query(
    `UPDATE activities
        SET spots_taken = spots_taken + 1, version = version + 1
      WHERE id = $1 AND spots_taken < capacity AND starts_at > now() AND host_id <> $2
  RETURNING id, spots_taken, capacity, version`,
    [input.activityId, input.userId],
  );

  if (updated.length === 0) {
    // Work out which condition failed so the user gets the right message.
    const { rows } = await tx.query(
      'SELECT spots_taken, capacity, starts_at, host_id FROM activities WHERE id = $1',
      [input.activityId],
    );
    const a = rows[0];
    if (!a) throw notFound('Activity');
    if (a.host_id === input.userId) throw new ApiError(409, 'HOST_CANNOT_BOOK', "You're hosting this one, so your spot is already covered.");
    if (a.starts_at.getTime() <= Date.now()) throw new ApiError(409, 'ACTIVITY_STARTED', 'This activity has already started.');
    throw soldOut();
  }

  const { rows: booked } = await tx.query<BookingRow>(
    `INSERT INTO bookings (activity_id, plan_id, user_id, invite_id, idempotency_key)
     SELECT $1, p.id, $2, $3, $4 FROM plans p WHERE p.activity_id = $1
  RETURNING *`,
    [input.activityId, input.userId, input.inviteId ?? null, input.idempotencyKey],
  );
  return { booking: booked[0], activity: updated[0], replay: false };
}

export const alreadyBooked = () => new ApiError(409, 'ALREADY_BOOKED', "You're already going to this one.");

/** Cancels a confirmed booking and returns the spot. */
export async function cancelBooking(tx: Tx, bookingId: string, userId: string) {
  const { rows } = await tx.query<BookingRow>(
    `UPDATE bookings SET status = 'cancelled', cancelled_at = now()
      WHERE id = $1 AND user_id = $2 AND status = 'confirmed'
  RETURNING *`,
    [bookingId, userId],
  );
  if (!rows[0]) throw notFound('Booking');
  const { rows: activity } = await tx.query(
    `UPDATE activities SET spots_taken = spots_taken - 1, version = version + 1
      WHERE id = $1
  RETURNING id, spots_taken, capacity, version`,
    [rows[0].activity_id],
  );
  return { booking: rows[0], activity: activity[0] };
}
