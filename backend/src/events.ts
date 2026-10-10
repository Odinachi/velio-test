import type { Db, Tx } from './db/pool.js';

export type EventName =
  | 'user_signed_up'
  | 'activity_created'
  | 'activity_viewed'
  | 'booking_attempted'
  | 'booking_succeeded'
  | 'booking_sold_out'
  | 'booking_failed'
  | 'booking_cancelled'
  | 'invite_created'
  | 'invite_opened'
  | 'spot_claimed'
  | 'availability_received';

export interface TrackedEvent {
  name: EventName;
  userId?: string | null;
  deviceId?: string | null;
  activityId?: string | null;
  inviteId?: string | null;
  rail?: 'vouch' | 'public' | null;
  props?: Record<string, unknown>;
}

/** Records events in the append-only log. Failures are logged, never thrown into the request. */
export async function track(db: Db | Tx, ...events: TrackedEvent[]): Promise<void> {
  if (events.length === 0) return;
  const values: unknown[] = [];
  const rows = events.map((e, i) => {
    const o = i * 7;
    values.push(
      e.name,
      e.userId ?? null,
      e.deviceId ?? null,
      e.activityId ?? null,
      e.inviteId ?? null,
      e.rail ?? null,
      JSON.stringify(e.props ?? {}),
    );
    return `($${o + 1}, $${o + 2}, $${o + 3}, $${o + 4}, $${o + 5}, $${o + 6}, $${o + 7})`;
  });
  try {
    await db.query(
      `INSERT INTO events (name, user_id, device_id, activity_id, invite_id, rail, props) VALUES ${rows.join(', ')}`,
      values,
    );
  } catch (err) {
    console.error('[events] failed to record', events.map((e) => e.name), (err as Error).message);
  }
}
