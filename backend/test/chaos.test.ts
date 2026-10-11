import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { createPool } from '../src/db/pool.js';
import { countOversold, createMetrics } from '../src/metrics.js';
import { createRedisBus } from '../src/realtime.js';
import { TEST_DB_URL, bookingIntegrity, call, createActivity, createUser, key, resetDb, startServer, type TestServer } from './helpers.js';
import { openStream } from './sse.js';

let s: TestServer;
let host: string;

beforeAll(async () => {
  await resetDb();
  s = await startServer({ poolSize: 80 });
  host = await createUser(s.url, 'Host');
});

afterAll(async () => {
  await s?.close();
});

describe('chaos: many people booking and cancelling at once', () => {
  it('never exceeds capacity while 40 people book and cancel in a loop, checked continuously', async () => {
    const capacity = 5;
    const activity = await createActivity(s.url, host, capacity);
    const users = await Promise.all(Array.from({ length: 40 }, (_, i) => createUser(s.url, `Churn ${i}`)));

    // Sample the invariant from a separate connection the whole time the storm runs.
    let running = true;
    const violations: unknown[] = [];
    let samples = 0;
    const watcher = (async () => {
      while (running) {
        const row = await bookingIntegrity(s.db, activity.id);
        samples++;
        if (row.spots_taken > capacity || row.spots_taken < 0) violations.push(row);
        const { rows } = await s.db.query(
          `SELECT count(*)::int AS n FROM bookings WHERE activity_id = $1 AND status = 'confirmed'`,
          [activity.id],
        );
        if (rows[0].n > capacity) violations.push({ confirmed: rows[0].n });
      }
    })();

    const outcomes = { booked: 0, soldOut: 0, cancelled: 0, other: 0 };
    await Promise.all(
      users.map(async (u) => {
        for (let round = 0; round < 6; round++) {
          const b = await call(s.url, 'POST', `/activities/${activity.id}/bookings`, { userId: u, body: { idempotencyKey: key() } });
          if (b.status === 201) {
            outcomes.booked++;
            const c = await call(s.url, 'DELETE', `/bookings/${b.body.booking.id}`, { userId: u });
            if (c.status === 200) outcomes.cancelled++;
            else outcomes.other++;
          } else if (b.body?.error?.code === 'SOLD_OUT') outcomes.soldOut++;
          else outcomes.other++;
        }
      }),
    );
    running = false;
    await watcher;

    expect(violations).toEqual([]);
    expect(samples).toBeGreaterThan(5);
    expect(outcomes.other).toBe(0);
    expect(outcomes.booked).toBe(outcomes.cancelled);
    expect(outcomes.booked + outcomes.soldOut).toBe(40 * 6);
    // Everyone cancelled, so the activity ends empty and consistent.
    expect(await bookingIntegrity(s.db, activity.id)).toEqual({ capacity, spots_taken: 0, confirmed: 0 });
    expect(await countOversold(s.db)).toBe(0);
  });

  it('keeps 30 activities consistent when 300 bookings land on them at random at once', async () => {
    const activities = await Promise.all(Array.from({ length: 30 }, (_, i) => createActivity(s.url, host, 1 + (i % 7))));
    const users = await Promise.all(Array.from({ length: 300 }, (_, i) => createUser(s.url, `Rand ${i}`)));
    const results = await Promise.all(
      users.map((u, i) => {
        const a = activities[(i * 7919) % activities.length];
        return call(s.url, 'POST', `/activities/${a.id}/bookings`, { userId: u, body: { idempotencyKey: key() } });
      }),
    );
    expect(results.every((r) => r.status === 201 || r.body?.error?.code === 'SOLD_OUT')).toBe(true);
    for (const a of activities) {
      const row = await bookingIntegrity(s.db, a.id);
      expect(row.spots_taken).toBe(row.confirmed);
      expect(row.spots_taken).toBeLessThanOrEqual(row.capacity);
    }
    // Total sold equals total spots, since 300 people far exceed the 30 activities' capacity.
    const totalCapacity = activities.reduce((n, a) => n + a.capacity, 0);
    expect(results.filter((r) => r.status === 201)).toHaveLength(totalCapacity);
  });

  it('streams a burst of 100 updates to a watcher with every version exactly once', async () => {
    const activity = await createActivity(s.url, host, 100);
    const versions: number[] = [];
    const stream = await openStream(`${s.url}/stream?activityIds=${activity.id}`, (m) => {
      if (m.event === 'availability') versions.push(m.data.version);
    });
    try {
      const users = await Promise.all(Array.from({ length: 100 }, (_, i) => createUser(s.url, `Burst ${i}`)));
      await Promise.all(
        users.map((u) => call(s.url, 'POST', `/activities/${activity.id}/bookings`, { userId: u, body: { idempotencyKey: key() } })),
      );
      const deadline = Date.now() + 3000;
      while (versions.length < 100 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
      expect([...versions].sort((x, y) => x - y)).toEqual(Array.from({ length: 100 }, (_, i) => i + 1));
    } finally {
      stream.close();
    }
  });
});

describe('infrastructure failure', () => {
  it('keeps taking bookings when Redis is unreachable, and counts the missed broadcasts', async () => {
    const db = createPool(TEST_DB_URL, 10);
    const metrics = createMetrics(db);
    // Nothing listens on port 1: every publish fails.
    const bus = createRedisBus('redis://127.0.0.1:1', () => metrics.publishFailures.inc());
    const app = await buildApp({ db, bus, metrics });
    const url = await app.listen({ port: 0, host: '127.0.0.1' });
    try {
      const u = await createUser(url, 'No Redis');
      const activity = await createActivity(url, host, 3);
      const started = Date.now();
      const res = await call(url, 'POST', `/activities/${activity.id}/bookings`, { userId: u, body: { idempotencyKey: key() } });
      expect(res.status).toBe(201);
      // A dead Redis must not hold the booking hostage.
      expect(Date.now() - started).toBeLessThan(2000);
      expect(await bookingIntegrity(db, activity.id)).toMatchObject({ spots_taken: 1, confirmed: 1 });
      const text = await (await fetch(`${url}/metrics`)).text();
      expect(Number(/^velio_availability_publish_failures_total (\d+)/m.exec(text)![1])).toBeGreaterThanOrEqual(1);
    } finally {
      await app.close();
      await bus.close();
      await db.end();
    }
  });

  it('turns a database outage into a clear 500 without leaking internals, then recovers', async () => {
    const db = createPool(TEST_DB_URL, 5);
    const metrics = createMetrics(db);
    const { createLocalBus } = await import('../src/realtime.js');
    const app = await buildApp({ db, bus: createLocalBus(), metrics });
    const url = await app.listen({ port: 0, host: '127.0.0.1' });
    try {
      const u = await createUser(url, 'Outage');
      const activity = await createActivity(url, host, 3);
      // Simulate the database dropping every query.
      const original = db.query.bind(db);
      (db as any).query = () => Promise.reject(new Error('connection terminated unexpectedly'));
      const res = await call(url, 'POST', `/activities/${activity.id}/bookings`, { userId: u, body: { idempotencyKey: key() } });
      expect(res.status).toBe(500);
      expect(res.body.error.code).toBe('INTERNAL');
      expect(JSON.stringify(res.body)).not.toContain('connection terminated');
      (db as any).query = original;

      const retry = await call(url, 'POST', `/activities/${activity.id}/bookings`, { userId: u, body: { idempotencyKey: key() } });
      expect(retry.status).toBe(201);
    } finally {
      await app.close();
      await db.end();
    }
  });
});
