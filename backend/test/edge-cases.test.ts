import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { config } from '../src/config.js';
import { bookingIntegrity, call, createActivity, createUser, key, resetDb, startServer, type TestServer } from './helpers.js';
import { openStream } from './sse.js';

let s: TestServer;
let host: string;

beforeAll(async () => {
  await resetDb();
  s = await startServer();
  host = await createUser(s.url, 'Host');
});

afterAll(async () => {
  await s?.close();
});

const book = (activityId: string, userId: string, idempotencyKey = key()) =>
  call(s.url, 'POST', `/activities/${activityId}/bookings`, { userId, body: { idempotencyKey } });

const invite = (activityId: string, userId: string, body: object) =>
  call(s.url, 'POST', `/activities/${activityId}/invites`, { userId, body });

const claim = (code: string, body: object, userId?: string) =>
  call(s.url, 'POST', `/invites/${code}/claim`, { userId, body: { idempotencyKey: key(), ...body } });

async function invitable(capacity: number) {
  let a = await createActivity(s.url, host, capacity);
  while (!a.invitesEnabled) a = await createActivity(s.url, host, capacity);
  return a;
}

const backdate = (activityId: string) =>
  s.db.query(`UPDATE activities SET starts_at = now() - interval '1 minute' WHERE id = $1`, [activityId]);

describe('the empty system', () => {
  it('reports every goal as "no data" instead of crashing or dividing by zero', async () => {
    const fresh = await call(s.url, 'GET', '/admin/report');
    expect(fresh.status).toBe(200);
    const byName = Object.fromEntries(fresh.body.goals.map((g: any) => [g.name, g]));
    expect(byName['Never oversell an activity'].status).toBe('met');
    for (const name of [
      'Bookings succeed when spots exist',
      'Availability feels live (p95)',
      'Bookers become inviters',
      'Vouch invites turn into guests',
    ]) {
      expect(byName[name].status).toBe('no_data');
    }
  });
});

describe('input boundaries', () => {
  it.each([
    ['capacity 0', { capacity: 0 }],
    ['capacity above 10,000', { capacity: 10_001 }],
    ['fractional capacity', { capacity: 2.5 }],
    ['negative price', { priceCents: -1 }],
    ['fractional price', { priceCents: 10.5 }],
    ['a start time in the past', { startsAt: new Date(Date.now() - 60_000).toISOString() }],
    ['a start time that is not a date', { startsAt: 'next friday' }],
    ['a blank title', { title: '   ' }],
    ['a 121-character title', { title: 'x'.repeat(121) }],
    ['capacity sent as a string', { capacity: '10' }],
  ])('rejects an activity with %s as a 400', async (_, override) => {
    const res = await call(s.url, 'POST', '/activities', {
      userId: host,
      body: {
        title: 'Edge',
        startsAt: new Date(Date.now() + 86400_000).toISOString(),
        priceCents: 100,
        capacity: 5,
        ...override,
      },
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION');
  });

  it('accepts the exact limits: 1 spot, 10,000 spots, free, 120-character title', async () => {
    for (const body of [{ capacity: 1 }, { capacity: 10_000 }, { priceCents: 0 }, { title: 'y'.repeat(120) }]) {
      const a = await createActivity(s.url, host, 5, body);
      expect(a.id).toBeTruthy();
    }
  });

  it('rejects blank, whitespace-only and 61-character names, but keeps emoji and non-Latin names intact', async () => {
    for (const name of ['', '    ', 'n'.repeat(61)]) {
      expect((await call(s.url, 'POST', '/users', { body: { name } })).status).toBe(400);
    }
    for (const name of ['Zoë 🛶', 'محمد', '张伟', "O'Brien; DROP TABLE users;--"]) {
      const res = await call(s.url, 'POST', '/users', { body: { name } });
      expect(res.status).toBe(201);
      expect(res.body.user.name).toBe(name);
    }
  });

  it('answers malformed requests with 4xx, never 500', async () => {
    const a = await createActivity(s.url, host, 5);
    const u = await createUser(s.url);
    const malformed = await fetch(`${s.url}/activities/${a.id}/bookings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user-id': u },
      body: '{"idempotencyKey": ',
    });
    expect(malformed.status).toBe(400);

    const cases = await Promise.all([
      call(s.url, 'GET', '/activities/not-a-uuid'),
      call(s.url, 'GET', '/activities/00000000-0000-4000-8000-000000000000'),
      call(s.url, 'POST', `/activities/${a.id}/bookings`, { userId: u, body: {} }),
      call(s.url, 'POST', `/activities/${a.id}/bookings`, { userId: u, body: { idempotencyKey: 'short' } }),
      call(s.url, 'POST', `/activities/${a.id}/bookings`, { userId: 'not-a-uuid', body: { idempotencyKey: key() } }),
      call(s.url, 'POST', `/activities/${a.id}/bookings`, { userId: '00000000-0000-4000-8000-000000000000', body: { idempotencyKey: key() } }),
      call(s.url, 'POST', '/activities/00000000-0000-4000-8000-000000000000/bookings', { userId: u, body: { idempotencyKey: key() } }),
      call(s.url, 'GET', '/invites/abc'),
      call(s.url, 'GET', `/invites/${'A'.repeat(21)}`),
      call(s.url, 'GET', '/invites/ZZZZZZZZ'),
      call(s.url, 'GET', '/stream?activityIds=not-a-uuid'),
      call(s.url, 'DELETE', '/bookings/00000000-0000-4000-8000-000000000000', { userId: u }),
    ]);
    expect(cases.map((c) => c.status)).toEqual([400, 404, 400, 400, 401, 401, 404, 400, 400, 404, 400, 404]);
    expect(cases.every((c) => typeof c.body?.error?.message === 'string')).toBe(true);
  });

  it('refuses a live stream for more than 200 activities', async () => {
    const ids = Array.from({ length: 201 }, () => '00000000-0000-4000-8000-000000000000').join(',');
    expect((await call(s.url, 'GET', `/stream?activityIds=${ids}`)).status).toBe(400);
  });

  it('rejects client event batches that are empty, oversized or carry impossible latencies', async () => {
    const a = await createActivity(s.url, host, 5);
    const ev = (latencyMs: number) => ({ name: 'availability_received', activityId: a.id, latencyMs });
    for (const events of [[], Array.from({ length: 101 }, () => ev(10)), [ev(-1)], [ev(600_001)]]) {
      expect((await call(s.url, 'POST', '/events', { body: { events } })).status).toBe(400);
    }
    expect((await call(s.url, 'POST', '/events', { body: { events: Array.from({ length: 100 }, () => ev(10)) } })).status).toBe(202);
  });
});

describe('time running out', () => {
  it('refuses bookings and invites once the activity has started', async () => {
    const a = await invitable(5);
    const u = await createUser(s.url);
    await book(a.id, u);
    await backdate(a.id);

    const late = await book(a.id, await createUser(s.url));
    expect(late.status).toBe(409);
    expect(late.body.error.code).toBe('ACTIVITY_STARTED');
    expect((await invite(a.id, u, { rail: 'public' })).body.error.code).toBe('ACTIVITY_STARTED');
    expect((await call(s.url, 'GET', '/activities?upcoming=true')).body.activities.some((x: any) => x.id === a.id)).toBe(false);
  });

  it('expires an invite: it opens as expired and every claim, even simultaneous ones, is refused', async () => {
    const a = await invitable(50);
    const u = await createUser(s.url);
    await book(a.id, u);
    const share = (await invite(a.id, u, { rail: 'public' })).body.invite;
    await s.db.query(`UPDATE invites SET expires_at = now() - interval '1 second' WHERE code = $1`, [share.code]);

    expect((await call(s.url, 'GET', `/invites/${share.code}`)).body.invite.status).toBe('expired');
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => claim(share.code, { name: `Late ${i}` })));
    expect(results.every((r) => r.status === 410 && r.body.error.code === 'INVITE_EXPIRED')).toBe(true);
    expect(await bookingIntegrity(s.db, a.id)).toMatchObject({ spots_taken: 1, confirmed: 1 });
  });

  it('caps a vouch at the activity start time even when that is sooner than 7 days', async () => {
    const soon = new Date(Date.now() + 3600_000);
    let a = await createActivity(s.url, host, 5, { startsAt: soon.toISOString() });
    while (!a.invitesEnabled) a = await createActivity(s.url, host, 5, { startsAt: soon.toISOString() });
    const vouch = (await invite(a.id, host, { rail: 'vouch', contactLabel: 'Ben' })).body.invite;
    expect(vouch.expiresAt).toBe((a as unknown as { startsAt: string }).startsAt);
  });
});

describe('book, cancel and retry sequences', () => {
  it('lets someone cancel and book again, with a new spot each time', async () => {
    const a = await createActivity(s.url, host, 1);
    const u = await createUser(s.url);
    for (let round = 0; round < 3; round++) {
      const b = await book(a.id, u);
      expect(b.status).toBe(201);
      expect((await call(s.url, 'DELETE', `/bookings/${b.body.booking.id}`, { userId: u })).status).toBe(200);
    }
    expect(await bookingIntegrity(s.db, a.id)).toEqual({ capacity: 1, spots_taken: 0, confirmed: 0 });
  });

  it('frees exactly one spot when the same cancellation is sent 20 times at once', async () => {
    const a = await createActivity(s.url, host, 3);
    const users = await Promise.all([1, 2, 3].map(() => createUser(s.url)));
    const bookings = await Promise.all(users.map((u) => book(a.id, u)));
    const target = bookings[0].body.booking.id;

    const results = await Promise.all(Array.from({ length: 20 }, () => call(s.url, 'DELETE', `/bookings/${target}`, { userId: users[0] })));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 404)).toHaveLength(19);
    expect(await bookingIntegrity(s.db, a.id)).toEqual({ capacity: 3, spots_taken: 2, confirmed: 2 });
  });

  it("won't let anyone cancel someone else's booking", async () => {
    const a = await createActivity(s.url, host, 2);
    const [owner, stranger] = await Promise.all([createUser(s.url), createUser(s.url)]);
    const b = await book(a.id, owner);
    expect((await call(s.url, 'DELETE', `/bookings/${b.body.booking.id}`, { userId: stranger })).status).toBe(404);
    expect((await call(s.url, 'DELETE', `/bookings/${b.body.booking.id}`, { userId: host })).status).toBe(404);
    expect(await bookingIntegrity(s.db, a.id)).toMatchObject({ spots_taken: 1, confirmed: 1 });
  });

  it('replays a successful booking even after the activity has since sold out', async () => {
    const a = await createActivity(s.url, host, 1);
    const u = await createUser(s.url);
    const k = key();
    const first = await book(a.id, u, k);
    // A lost response, then a retry: the activity is full now, but this person already has the spot.
    const retry = await book(a.id, u, k);
    expect(first.status).toBe(201);
    expect(retry.status).toBe(200);
    expect(retry.body.replay).toBe(true);
    expect(retry.body.booking.id).toBe(first.body.booking.id);
  });

  it('refuses to reuse a request key for a different activity or a different person', async () => {
    const [a1, a2] = await Promise.all([createActivity(s.url, host, 5), createActivity(s.url, host, 5)]);
    const [u1, u2] = await Promise.all([createUser(s.url), createUser(s.url)]);
    const k = key();
    expect((await book(a1.id, u1, k)).status).toBe(201);
    const otherActivity = await book(a2.id, u1, k);
    const otherPerson = await book(a1.id, u2, k);
    expect(otherActivity.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(otherPerson.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(await bookingIntegrity(s.db, a2.id)).toMatchObject({ spots_taken: 0 });
  });

  it("refuses to replay a direct booking's key as an invite claim", async () => {
    const a = await invitable(5);
    const u = await createUser(s.url);
    const k = key();
    await book(a.id, u, k);
    const share = (await invite(a.id, u, { rail: 'public' })).body.invite;
    const res = await call(s.url, 'POST', `/invites/${share.code}/claim`, { body: { name: 'Sneaky', idempotencyKey: k } });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('stops hosts booking their own activity', async () => {
    const a = await createActivity(s.url, host, 5);
    const res = await book(a.id, host);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('HOST_CANNOT_BOOK');
    expect(await bookingIntegrity(s.db, a.id)).toMatchObject({ spots_taken: 0 });
  });
});

describe('invite edge cases', () => {
  it('keeps a vouch valid after the inviter cancels, but stops them creating new invites', async () => {
    const a = await invitable(5);
    const ada = await createUser(s.url, 'Ada');
    const booked = await book(a.id, ada);
    const vouch = (await invite(a.id, ada, { rail: 'vouch', contactLabel: 'Ben' })).body.invite;
    await call(s.url, 'DELETE', `/bookings/${booked.body.booking.id}`, { userId: ada });

    expect((await invite(a.id, ada, { rail: 'public' })).body.error.code).toBe('NOT_GOING');
    const ben = await claim(vouch.code, { name: 'Ben' });
    expect(ben.status).toBe(201);
    expect(ben.body.user.generation).toBe(1);
  });

  it('does not consume a vouch when the guest is already going', async () => {
    const a = await invitable(5);
    const [ada, ben] = await Promise.all([createUser(s.url, 'Ada'), createUser(s.url, 'Ben')]);
    await Promise.all([book(a.id, ada), book(a.id, ben)]);
    const vouch = (await invite(a.id, ada, { rail: 'vouch', contactLabel: 'Ben' })).body.invite;

    const res = await claim(vouch.code, {}, ben);
    expect(res.body.error.code).toBe('ALREADY_BOOKED');
    expect((await s.db.query('SELECT uses FROM invites WHERE code = $1', [vouch.code])).rows[0].uses).toBe(0);
    expect((await s.db.query('SELECT count(*)::int AS n FROM attributions WHERE invite_id = (SELECT id FROM invites WHERE code = $1)', [vouch.code])).rows[0].n).toBe(0);
  });

  it('gives one spot to a person who claims an invite and books directly at the same moment', async () => {
    const a = await invitable(10);
    const ada = await createUser(s.url, 'Ada');
    await book(a.id, ada);
    const share = (await invite(a.id, ada, { rail: 'public' })).body.invite;
    const ben = await createUser(s.url, 'Ben');

    const results = await Promise.all([
      ...Array.from({ length: 5 }, () => claim(share.code, {}, ben)),
      ...Array.from({ length: 5 }, () => book(a.id, ben)),
    ]);
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.body?.error?.code === 'ALREADY_BOOKED')).toHaveLength(9);
    expect(await bookingIntegrity(s.db, a.id)).toMatchObject({ spots_taken: 2, confirmed: 2 });
    const { rows } = await s.db.query('SELECT uses FROM invites WHERE code = $1', [share.code]);
    const { rows: attr } = await s.db.query('SELECT count(*)::int AS n FROM attributions WHERE invitee_id = $1', [ben]);
    expect(rows[0].uses).toBe(attr[0].n);
  });

  it('lets a vouch hit the last spot exactly once when 30 public-link guests race the vouched friend', async () => {
    const a = await invitable(2);
    const ada = await createUser(s.url, 'Ada');
    await book(a.id, ada);
    const vouch = (await invite(a.id, ada, { rail: 'vouch', contactLabel: 'Ben' })).body.invite;
    const share = (await invite(a.id, ada, { rail: 'public' })).body.invite;

    const tag = key().slice(0, 8);
    const results = await Promise.all([
      claim(vouch.code, { name: `Ben ${tag}` }),
      ...Array.from({ length: 30 }, (_, i) => claim(share.code, { name: `Crowd ${tag} ${i}` })),
    ]);
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.body?.error?.code === 'SOLD_OUT')).toHaveLength(30);
    expect(await bookingIntegrity(s.db, a.id)).toEqual({ capacity: 2, spots_taken: 2, confirmed: 2 });
    // Only the winner has an account; the 30 losing guests left nothing behind.
    const { rows } = await s.db.query(`SELECT count(*)::int AS n FROM users WHERE name LIKE '%' || $1 || '%'`, [tag]);
    expect(rows[0].n).toBe(1);
  });

  it('tracks a 6-hop invite chain with generations 1 to 6', async () => {
    const a = await invitable(10);
    let inviter = await createUser(s.url, 'Root');
    await book(a.id, inviter);
    const generations: number[] = [];
    for (let hop = 1; hop <= 6; hop++) {
      const v = (await invite(a.id, inviter, { rail: 'vouch', contactLabel: `Hop ${hop}` })).body.invite;
      const r = await claim(v.code, { name: `Hop ${hop}` });
      generations.push(r.body.user.generation);
      inviter = r.body.user.id;
    }
    expect(generations).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('accepts codes typed in lowercase, with spaces or dashes', async () => {
    const a = await invitable(5);
    const ada = await createUser(s.url);
    await book(a.id, ada);
    const { code } = (await invite(a.id, ada, { rail: 'public' })).body.invite;
    const messy = ` ${code.slice(0, 4).toLowerCase()}-${code.slice(4)} `;
    expect((await call(s.url, 'GET', `/invites/${encodeURIComponent(messy)}`)).status).toBe(200);
    expect((await claim(encodeURIComponent(messy), { name: 'Typist' })).status).toBe(201);
  });

  it('honours already-issued invites when the kill switch is flipped, but stops new ones', async () => {
    const a = await invitable(5);
    const ada = await createUser(s.url);
    await book(a.id, ada);
    const vouch = (await invite(a.id, ada, { rail: 'vouch', contactLabel: 'Ben' })).body.invite;
    config.invites.enabled = false;
    try {
      expect((await invite(a.id, ada, { rail: 'public' })).body.error.code).toBe('INVITES_DISABLED');
      expect((await call(s.url, 'GET', `/activities/${a.id}`)).body.activity.invitesEnabled).toBe(false);
      expect((await claim(vouch.code, { name: 'Ben' })).status).toBe(201);
    } finally {
      config.invites.enabled = true;
    }
  });

  it('rejects a vouch without a name and a contact name over 60 characters', async () => {
    const a = await invitable(5);
    const ada = await createUser(s.url);
    await book(a.id, ada);
    expect((await invite(a.id, ada, { rail: 'vouch' })).status).toBe(400);
    expect((await invite(a.id, ada, { rail: 'vouch', contactLabel: '  ' })).status).toBe(400);
    expect((await invite(a.id, ada, { rail: 'vouch', contactLabel: 'b'.repeat(61) })).status).toBe(400);
    expect((await invite(a.id, ada, { rail: 'carrier-pigeon' })).status).toBe(400);
  });
});

describe('live connections', () => {
  it('counts open streams and releases them when clients disconnect', async () => {
    const gauge = async () => {
      const text = await (await fetch(`${s.url}/metrics`)).text();
      return Number(/^velio_sse_clients (\d+)/m.exec(text)![1]);
    };
    const before = await gauge();
    const streams = await Promise.all(Array.from({ length: 5 }, () => openStream(`${s.url}/stream`, () => {})));
    expect(await gauge()).toBe(before + 5);
    streams.forEach((st) => st.close());
    const deadline = Date.now() + 3000;
    while ((await gauge()) !== before && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    expect(await gauge()).toBe(before);
  });
});
