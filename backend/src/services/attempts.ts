import type { Ctx } from '../context.js';
import { track, type TrackedEvent } from '../events.js';
import { ApiError, isUniqueViolation } from '../lib/errors.js';
import type { BookingOutcome } from '../metrics.js';
import { availabilityOf } from './activities.js';
import { alreadyBooked, type SpotTaken } from './bookings.js';

interface AttemptMeta {
  activityId: string;
  userId: string | null;
  deviceId: string | null;
  via: 'direct' | 'vouch' | 'public';
  inviteId?: string | null;
}

/**
 * Wraps every way of taking a spot (direct booking or invite claim) so they are measured the
 * same way: one attempt, one outcome, one duration, and an availability update after commit.
 */
export async function runBookingAttempt<T extends { spot: SpotTaken }>(
  ctx: Ctx,
  meta: AttemptMeta,
  attempt: () => Promise<T>,
  onDuplicateKey: () => Promise<T>,
): Promise<T> {
  const started = performance.now();
  let outcome: BookingOutcome = 'error';
  let errorCode: string | undefined;
  try {
    let result: T;
    try {
      result = await attempt();
    } catch (err) {
      // Two concurrent requests with the same idempotency key: the loser replays the winner.
      if (isUniqueViolation(err, 'bookings_idempotency_key_key')) result = await onDuplicateKey();
      else if (isUniqueViolation(err, 'bookings_one_live_per_user')) throw alreadyBooked();
      else throw err;
    }
    outcome = 'success';

    if (!result.spot.replay && result.spot.activity) {
      // Not awaited: the booking is committed, and the broadcast must never delay the reply.
      void ctx.bus.publish(availabilityOf(result.spot.activity));
      void track(ctx.db, {
        name: 'booking_succeeded',
        userId: result.spot.booking.user_id,
        deviceId: meta.deviceId,
        activityId: meta.activityId,
        inviteId: meta.inviteId,
        rail: meta.via === 'direct' ? null : meta.via,
        props: { via: meta.via, duration_ms: Math.round(performance.now() - started) },
      });
    }
    return result;
  } catch (err) {
    if (err instanceof ApiError) {
      errorCode = err.code;
      outcome = err.code === 'SOLD_OUT' ? 'sold_out' : err.code === 'ALREADY_BOOKED' ? 'already_booked' : 'rejected';
    } else {
      errorCode = (err as Error).message;
    }
    throw err;
  } finally {
    const seconds = (performance.now() - started) / 1000;
    ctx.metrics.bookingAttempts.inc({ outcome, via: meta.via });
    ctx.metrics.bookingDuration.observe({ outcome }, seconds);
    const base = { userId: meta.userId, deviceId: meta.deviceId, activityId: meta.activityId, inviteId: meta.inviteId };
    const events: TrackedEvent[] = [{ name: 'booking_attempted', ...base, props: { via: meta.via } }];
    if (outcome === 'sold_out') events.push({ name: 'booking_sold_out', ...base, props: { via: meta.via } });
    if (outcome === 'error' || outcome === 'rejected') {
      events.push({ name: 'booking_failed', ...base, props: { via: meta.via, outcome, error: errorCode } });
    }
    void track(ctx.db, ...events);
  }
}
