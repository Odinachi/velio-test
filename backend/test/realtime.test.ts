import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call, createActivity, createUser, key, resetDb, startServer, type TestServer } from './helpers.js';
import { openStream, type SseMessage } from './sse.js';

// Two API instances sharing Redis, like a horizontally scaled deployment.
let a: TestServer;
let b: TestServer;

beforeAll(async () => {
  await resetDb();
  a = await startServer({ redis: true, poolSize: 20 });
  b = await startServer({ redis: true, poolSize: 20 });
});

afterAll(async () => {
  await a?.close();
  await b?.close();
});

function collector() {
  const messages: SseMessage[] = [];
  const waitFor = async (pred: (m: SseMessage) => boolean, timeoutMs = 3000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const m = messages.find(pred);
      if (m) return m;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error('no matching SSE message');
  };
  return { messages, push: (m: SseMessage) => messages.push(m), waitFor };
}

describe('live availability', () => {
  it('pushes a booking made on instance A to a client connected to instance B', async () => {
    const host = await createUser(a.url, 'Host');
    const booker = await createUser(a.url, 'Booker');
    const activity = await createActivity(a.url, host, 3);

    const c = collector();
    const stream = await openStream(`${b.url}/stream?activityIds=${activity.id}`, c.push);
    try {
      const sentAt = Date.now();
      const res = await call(a.url, 'POST', `/activities/${activity.id}/bookings`, { userId: booker, body: { idempotencyKey: key() } });
      expect(res.status).toBe(201);

      const update = await c.waitFor((m) => m.event === 'availability');
      expect(update.data).toMatchObject({ activityId: activity.id, spotsTaken: 1, spotsLeft: 2, capacity: 3, version: 1 });
      expect(update.receivedAt - sentAt).toBeLessThan(2000);
    } finally {
      stream.close();
    }
  });

  it('only sends updates for the activities a client asked for, and versions always increase', async () => {
    const host = await createUser(a.url, 'Host');
    const watched = await createActivity(a.url, host, 10);
    const other = await createActivity(a.url, host, 10);

    const c = collector();
    const stream = await openStream(`${a.url}/stream?activityIds=${watched.id}`, c.push);
    try {
      const bookers = await Promise.all(Array.from({ length: 5 }, (_, i) => createUser(a.url, `B${i}`)));
      await Promise.all(
        bookers.flatMap((u) => [
          call(a.url, 'POST', `/activities/${watched.id}/bookings`, { userId: u, body: { idempotencyKey: key() } }),
          call(b.url, 'POST', `/activities/${other.id}/bookings`, { userId: u, body: { idempotencyKey: key() } }),
        ]),
      );
      await c.waitFor((m) => m.event === 'availability' && m.data.version === 5);

      const updates = c.messages.filter((m) => m.event === 'availability').map((m) => m.data);
      expect(updates.every((u) => u.activityId === watched.id)).toBe(true);
      // Every version 1..5 arrives once. Clients sort/ignore by version, so order doesn't matter.
      expect(updates.map((u) => u.version).sort()).toEqual([1, 2, 3, 4, 5]);
      expect(updates.find((u) => u.version === 5)).toMatchObject({ spotsTaken: 5, spotsLeft: 5 });
    } finally {
      stream.close();
    }
  });

  it('publishes cancellations so freed spots show up live', async () => {
    const host = await createUser(a.url, 'Host');
    const booker = await createUser(a.url, 'Booker');
    const activity = await createActivity(a.url, host, 1);
    const booked = await call(a.url, 'POST', `/activities/${activity.id}/bookings`, { userId: booker, body: { idempotencyKey: key() } });

    const c = collector();
    const stream = await openStream(`${b.url}/stream`, c.push);
    try {
      await call(a.url, 'DELETE', `/bookings/${booked.body.booking.id}`, { userId: booker });
      const update = await c.waitFor((m) => m.event === 'availability' && m.data.activityId === activity.id);
      expect(update.data).toMatchObject({ spotsTaken: 0, spotsLeft: 1, version: 2 });
    } finally {
      stream.close();
    }
  });
});
