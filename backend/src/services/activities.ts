import { config } from '../config.js';
import type { Db, Tx } from '../db/pool.js';
import { notFound } from '../lib/errors.js';
import { experimentBucket } from '../lib/ids.js';
import type { AvailabilityUpdate } from '../realtime.js';
import { randomUUID } from 'node:crypto';

export interface ActivityRow {
  id: string;
  host_id: string;
  host_name: string;
  plan_id: string;
  title: string;
  description: string;
  location: string;
  starts_at: Date;
  price_cents: number;
  currency: string;
  capacity: number;
  spots_taken: number;
  version: string; // bigint comes back as a string
  experiment_bucket: number;
  created_at: Date;
}

export interface ActivityDto {
  id: string;
  planId: string;
  title: string;
  description: string;
  location: string;
  startsAt: string;
  priceCents: number;
  currency: string;
  capacity: number;
  spotsTaken: number;
  spotsLeft: number;
  version: number;
  host: { id: string; name: string };
  /** False when the invite feature is off or this activity is in the holdout. */
  invitesEnabled: boolean;
  hasStarted: boolean;
}

export const ACTIVITY_SELECT = `
  SELECT a.*, u.name AS host_name, p.id AS plan_id
    FROM activities a
    JOIN users u ON u.id = a.host_id
    JOIN plans p ON p.activity_id = a.id`;

export function invitesEnabledFor(bucket: number): boolean {
  return config.invites.enabled && bucket >= config.invites.holdoutPct;
}

export function toDto(a: ActivityRow): ActivityDto {
  return {
    id: a.id,
    planId: a.plan_id,
    title: a.title,
    description: a.description,
    location: a.location,
    startsAt: a.starts_at.toISOString(),
    priceCents: a.price_cents,
    currency: a.currency,
    capacity: a.capacity,
    spotsTaken: a.spots_taken,
    spotsLeft: a.capacity - a.spots_taken,
    version: Number(a.version),
    host: { id: a.host_id, name: a.host_name },
    invitesEnabled: invitesEnabledFor(a.experiment_bucket),
    hasStarted: a.starts_at.getTime() <= Date.now(),
  };
}

export async function getActivity(db: Db | Tx, id: string): Promise<ActivityRow> {
  const { rows } = await db.query<ActivityRow>(`${ACTIVITY_SELECT} WHERE a.id = $1`, [id]);
  if (!rows[0]) throw notFound('Activity');
  return rows[0];
}

export async function listActivities(db: Db, opts: { hostId?: string; upcomingOnly?: boolean }) {
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.hostId) where.push(`a.host_id = $${params.push(opts.hostId)}`);
  if (opts.upcomingOnly) where.push('a.starts_at > now()');
  const { rows } = await db.query<ActivityRow>(
    `${ACTIVITY_SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY a.starts_at ASC LIMIT 200`,
    params,
  );
  return rows.map(toDto);
}

export interface NewActivity {
  title: string;
  description: string;
  location: string;
  startsAt: Date;
  priceCents: number;
  currency: string;
  capacity: number;
}

export async function createActivity(tx: Tx, hostId: string, input: NewActivity): Promise<ActivityRow> {
  const id = randomUUID();
  await tx.query(
    `INSERT INTO activities (id, host_id, title, description, location, starts_at, price_cents, currency, capacity, experiment_bucket)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      id,
      hostId,
      input.title.trim(),
      input.description.trim(),
      input.location.trim(),
      input.startsAt,
      input.priceCents,
      input.currency,
      input.capacity,
      experimentBucket(id),
    ],
  );
  await tx.query('INSERT INTO plans (activity_id) VALUES ($1)', [id]);
  return getActivity(tx, id);
}

export function availabilityOf(row: {
  id: string;
  spots_taken: number;
  capacity: number;
  version: string | number;
}): AvailabilityUpdate {
  return {
    activityId: row.id,
    spotsTaken: row.spots_taken,
    capacity: row.capacity,
    spotsLeft: row.capacity - row.spots_taken,
    version: Number(row.version),
    committedAt: Date.now(),
  };
}

export interface Attendee {
  userId: string;
  name: string;
  bookedAt: string;
  via: 'direct' | 'vouch' | 'public';
  invitedBy: string | null;
  generation: number;
}

export async function listAttendees(db: Db, activityId: string): Promise<Attendee[]> {
  const { rows } = await db.query(
    `SELECT b.user_id, u.name, b.created_at, u.generation, i.rail, inviter.name AS invited_by
       FROM bookings b
       JOIN users u ON u.id = b.user_id
       LEFT JOIN invites i ON i.id = b.invite_id
       LEFT JOIN users inviter ON inviter.id = i.inviter_id
      WHERE b.activity_id = $1 AND b.status = 'confirmed'
      ORDER BY b.created_at ASC`,
    [activityId],
  );
  return rows.map((r) => ({
    userId: r.user_id,
    name: r.name,
    bookedAt: r.created_at.toISOString(),
    via: r.rail ?? 'direct',
    invitedBy: r.invited_by,
    generation: r.generation,
  }));
}
