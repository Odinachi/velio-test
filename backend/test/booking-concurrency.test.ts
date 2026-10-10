import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { countOversold } from '../src/metrics.js';
import { takeSpot } from '../src/services/bookings.js';
import {
  TEST_DB_URL,
  bookingIntegrity,
  call,
  createActivity,
  createUser,
  key,
  resetDb,
  startServer,
  type TestServer,
} from './helpers.js';

let server: TestServer;
let hostId: string;

beforeAll(async () => {
  await resetDb();
  server = await startServer();
  hostId = await createUser(server.url, 'Host');
});

afterAll(async () => {
  await server?.close();
});

async function users(n: number) {
  return Promise.all(Array.from({ length: n }, (_, i) => createUser(server.url, `Booker ${i}`)));
}

function tally(results: { status: number; body: any }[]) {
  const by: Record<string, number> = {};
  for (const r of results) {
    const k = r.status < 300 ? 'ok' : r.body?.error?.code ?? String(r.status);
    by[k] = (by[k] ?? 0) + 1;
  }
  return by;
}

describe('booking the last spot under concurrency', () => {
  it('lets exactly one of 50 simultaneous bookers take the last spot', async () => {
    const activity = await createActivity(server.url, hostId, 5);
    // Fill all but one spot.
    for (const u of await users(4)) {
      const r = await call(server.url, 'POST', `/activities/${activity.id}/bookings`, { userId: u, body: { idempotencyKey: key() } });
      expect(r.status).toBe(201);
    }

    const racers = await users(50);
    const results = await Promise.all(
      racers.map((u) =>
        call(server.url, 'POST', `/activities/${activity.id}/bookings`, { userId: u, body: { idempotencyKey: key() } }),
      ),
    );

    expect(tally(results)).toEqual({ ok: 1, SOLD_OUT: 49 });
    // Losers get a kind message, not an error dump.
    const loser = results.find((r) => r.status === 409)!;
    expect(loser.body.error.message).toMatch(/last spot/);

    expect(await bookingIntegrity(server.db, activity.id)).toEqual({ capacity: 5, spots_taken: 5, confirmed: 5 });
    expect(await countOversold(server.db)).toBe(0);
  });

  it('sells exactly capacity when 200 people race for 20 spots', async () => {
    const activity = await createActivity(server.url, hostId, 20);
    const racers = await users(200);
    const results = await Promise.all(
      racers.map((u) =>
        call(server.url, 'POST', `/activities/${activity.id}/bookings`, { userId: u, body: { idempotencyKey: key() } }),
      ),
    );

    expect(tally(results)).toEqual({ ok: 20, SOLD_OUT: 180 });
    expect(await bookingIntegrity(server.db, activity.id)).toEqual({ capacity: 20, spots_taken: 20, confirmed: 20 });
    // Every winner is a distinct person.
    const winners = results.filter((r) => r.status === 201).map((r) => r.body.booking.userId);
    expect(new Set(winners).size).toBe(20);
  });

  it('gives one person one spot even if they hammer the button with different request keys', async () => {
    const activity = await createActivity(server.url, hostId, 10);
    const [u] = await users(1);
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        call(server.url, 'POST', `/activities/${activity.id}/bookings`, { userId: u, body: { idempotencyKey: key() } }),
      ),
    );
    expect(tally(results)).toEqual({ ok: 1, ALREADY_BOOKED: 19 });
    expect(await bookingIntegrity(server.db, activity.id)).toMatchObject({ spots_taken: 1, confirmed: 1 });
  });

  it('treats retries with the same idempotency key as one booking', async () => {
    const activity = await createActivity(server.url, hostId, 10);
    const [u] = await users(1);
    const k = key();
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        call(server.url, 'POST', `/activities/${activity.id}/bookings`, { userId: u, body: { idempotencyKey: k } }),
      ),
    );
    expect(results.every((r) => r.status === 200 || r.status === 201)).toBe(true);
    expect(new Set(results.map((r) => r.body.booking.id)).size).toBe(1);
    expect(await bookingIntegrity(server.db, activity.id)).toMatchObject({ spots_taken: 1, confirmed: 1 });
  });

  it('releases a cancelled spot and lets exactly one waiting booker take it', async () => {
    const activity = await createActivity(server.url, hostId, 1);
    const [first, ...others] = await users(11);
    const booked = await call(server.url, 'POST', `/activities/${activity.id}/bookings`, { userId: first, body: { idempotencyKey: key() } });
    const cancel = await call(server.url, 'DELETE', `/bookings/${booked.body.booking.id}`, { userId: first });
    expect(cancel.status).toBe(200);

    const results = await Promise.all(
      others.map((u) =>
        call(server.url, 'POST', `/activities/${activity.id}/bookings`, { userId: u, body: { idempotencyKey: key() } }),
      ),
    );
    expect(tally(results)).toEqual({ ok: 1, SOLD_OUT: 9 });
    expect(await bookingIntegrity(server.db, activity.id)).toMatchObject({ spots_taken: 1, confirmed: 1 });
  });
});

describe('proof that the race really is concurrent', () => {
  it('queues competing transactions on the row lock, and they all see the spot is gone', async () => {
    const activity = await createActivity(server.url, hostId, 1);
    const racers = await users(10);
    const [holderId, ...waiters] = racers;

    // Each attempt gets its own connection, exactly like separate API instances would.
    const clients = await Promise.all(racers.map(async () => {
      const c = new pg.Client({ connectionString: TEST_DB_URL });
      await c.connect();
      await c.query('BEGIN');
      return c;
    }));
    const [holder, ...others] = clients;

    try {
      // The holder takes the last spot but hasn't committed yet.
      await takeSpot(holder as any, { activityId: activity.id, userId: holderId, idempotencyKey: key() });

      // Everyone else fires at once. They must block, not slip past.
      const pending = others.map((c, i) => attempt(c, activity.id, waiters[i]));

      // Wait until all 9 are genuinely parked on the activity's row lock.
      const waiting = await waitFor(async () => {
        const { rows } = await server.db.query(
          `SELECT count(*)::int AS n FROM pg_locks l JOIN pg_stat_activity s ON s.pid = l.pid
            WHERE NOT l.granted AND s.datname = current_database()`,
        );
        return rows[0].n >= others.length ? rows[0].n : null;
      });
      expect(waiting).toBeGreaterThanOrEqual(others.length);

      await holder.query('COMMIT');
      const outcomes = await Promise.all(pending);
      expect(outcomes).toEqual(Array(others.length).fill('SOLD_OUT'));
    } finally {
      await Promise.all(clients.map((c) => c.end()));
    }

    expect(await bookingIntegrity(server.db, activity.id)).toEqual({ capacity: 1, spots_taken: 1, confirmed: 1 });
  });

  it('hands the spot to exactly one waiter if the holder rolls back', async () => {
    const activity = await createActivity(server.url, hostId, 1);
    const racers = await users(6);
    const clients = await Promise.all(racers.map(async () => {
      const c = new pg.Client({ connectionString: TEST_DB_URL });
      await c.connect();
      await c.query('BEGIN');
      return c;
    }));
    const [holder, ...others] = clients;
    try {
      await takeSpot(holder as any, { activityId: activity.id, userId: racers[0], idempotencyKey: key() });
      const pending = others.map((c, i) => attempt(c, activity.id, racers[i + 1]));
      await new Promise((r) => setTimeout(r, 200));
      await holder.query('ROLLBACK');
      const outcomes = await Promise.all(pending);
      expect(outcomes.filter((o) => o === 'ok')).toHaveLength(1);
      expect(outcomes.filter((o) => o === 'SOLD_OUT')).toHaveLength(others.length - 1);
    } finally {
      await Promise.all(clients.map((c) => c.end()));
    }
    expect(await bookingIntegrity(server.db, activity.id)).toEqual({ capacity: 1, spots_taken: 1, confirmed: 1 });
  });

  it('refuses an oversell at the database level even if application code is bypassed', async () => {
    const activity = await createActivity(server.url, hostId, 2);
    await expect(
      server.db.query('UPDATE activities SET spots_taken = capacity + 1 WHERE id = $1', [activity.id]),
    ).rejects.toThrow(/spots_within_capacity/);
  });
});

/**
 * One booking attempt on its own connection, ending its transaction straight away like the API
 * does. This matters: a waiter that finds the spot gone still holds the row lock until it ends
 * its transaction, so the API must (and does) roll back promptly.
 */
async function attempt(c: pg.Client, activityId: string, userId: string): Promise<string> {
  try {
    await takeSpot(c as any, { activityId, userId, idempotencyKey: key() });
    await c.query('COMMIT');
    return 'ok';
  } catch (e) {
    await c.query('ROLLBACK');
    return (e as { code?: string }).code ?? String(e);
  }
}

async function waitFor<T>(fn: () => Promise<T | null>, timeoutMs = 5000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await fn();
    if (v !== null) return v;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('timed out waiting for condition');
}
