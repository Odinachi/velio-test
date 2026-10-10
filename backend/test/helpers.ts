import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { buildApp } from '../src/app.js';
import { migrate } from '../src/db/migrate.js';
import { createPool, type Db } from '../src/db/pool.js';
import { createMetrics } from '../src/metrics.js';
import { createLocalBus, createRedisBus, type AvailabilityBus } from '../src/realtime.js';

export const TEST_DB_URL = process.env.TEST_DATABASE_URL ?? 'postgres://velio:velio@localhost:5442/velio_test';
export const TEST_REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://localhost:6389';

/** Drops everything and re-applies migrations. Dropping the schema bypasses the append-only triggers. */
export async function resetDb() {
  const client = new pg.Client({ connectionString: TEST_DB_URL });
  await client.connect();
  await client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await client.end();
  await migrate(TEST_DB_URL);
}

export interface TestServer {
  url: string;
  db: Db;
  bus: AvailabilityBus;
  close(): Promise<void>;
}

/** A real HTTP server on a random port, so requests run truly concurrently over sockets. */
export async function startServer(opts: { redis?: boolean; poolSize?: number } = {}): Promise<TestServer> {
  const db = createPool(TEST_DB_URL, opts.poolSize ?? 60);
  const metrics = createMetrics(db);
  const bus = opts.redis ? createRedisBus(TEST_REDIS_URL) : createLocalBus();
  const app = await buildApp({ db, bus, metrics });
  const address = await app.listen({ port: 0, host: '127.0.0.1' });
  return {
    url: address,
    db,
    bus,
    async close() {
      await app.close();
      await bus.close();
      await db.end();
    },
  };
}

export async function call<T = any>(
  base: string,
  method: string,
  path: string,
  opts: { body?: unknown; userId?: string; deviceId?: string } = {},
): Promise<{ status: number; body: T }> {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (opts.userId) headers['x-user-id'] = opts.userId;
  if (opts.deviceId) headers['x-device-id'] = opts.deviceId;
  const res = await fetch(base + path, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

export async function createUser(base: string, name = 'User'): Promise<string> {
  const { body } = await call(base, 'POST', '/users', { body: { name } });
  return body.user.id;
}

export async function createActivity(base: string, hostId: string, capacity: number, extra: Record<string, unknown> = {}) {
  const { status, body } = await call(base, 'POST', '/activities', {
    userId: hostId,
    body: {
      title: 'Sunset Kayaking',
      description: 'Paddle out at golden hour.',
      location: 'Lekki Lagoon',
      startsAt: new Date(Date.now() + 7 * 86400_000).toISOString(),
      priceCents: 4500,
      capacity,
      ...extra,
    },
  });
  if (status !== 201) throw new Error(`createActivity failed: ${status} ${JSON.stringify(body)}`);
  return body.activity as { id: string; capacity: number; spotsLeft: number; invitesEnabled: boolean };
}

export const key = () => randomUUID();

export async function bookingIntegrity(db: Db, activityId: string) {
  const { rows } = await db.query(
    `SELECT a.capacity, a.spots_taken,
            (SELECT count(*)::int FROM bookings b WHERE b.activity_id = a.id AND b.status = 'confirmed') AS confirmed
       FROM activities a WHERE a.id = $1`,
    [activityId],
  );
  return rows[0] as { capacity: number; spots_taken: number; confirmed: number };
}
