import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call, createActivity, createUser, key, resetDb, startServer, type TestServer } from './helpers.js';

let s: TestServer;

beforeAll(async () => {
  await resetDb();
  s = await startServer();
});

afterAll(async () => {
  await s?.close();
});

const flush = () => new Promise((r) => setTimeout(r, 150)); // events are written fire-and-forget

describe('tracking answers every scope goal', () => {
  it('computes inviter rate, conversion per rail, K-factor and SLOs from real flows', async () => {
    const host = await createUser(s.url, 'Host');
    let activity = await createActivity(s.url, host, 4);
    while (!activity.invitesEnabled) activity = await createActivity(s.url, host, 4);

    // Two direct bookers; only Ada invites.
    const ada = await createUser(s.url, 'Ada');
    const bola = await createUser(s.url, 'Bola');
    for (const u of [ada, bola]) {
      await call(s.url, 'POST', `/activities/${activity.id}/bookings`, { userId: u, body: { idempotencyKey: key() } });
    }
    await call(s.url, 'POST', '/events', { userId: ada, deviceId: 'web-ada', body: { events: [{ name: 'activity_viewed', activityId: activity.id }] } });

    const vouch = (await call(s.url, 'POST', `/activities/${activity.id}/invites`, { userId: ada, body: { rail: 'vouch', contactLabel: 'Ben' } })).body.invite;
    const share = (await call(s.url, 'POST', `/activities/${activity.id}/invites`, { userId: ada, body: { rail: 'public' } })).body.invite;

    // Vouch: opened twice on one phone (one unique open), then claimed.
    await call(s.url, 'GET', `/invites/${vouch.code}`, { deviceId: 'phone-ben' });
    await call(s.url, 'GET', `/invites/${vouch.code}`, { deviceId: 'phone-ben' });
    await call(s.url, 'POST', `/invites/${vouch.code}/claim`, { deviceId: 'phone-ben', body: { name: 'Ben', idempotencyKey: key() } });

    // Public link: four people open it, one claims (the last spot), and Ada's own preview doesn't count.
    await call(s.url, 'GET', `/invites/${share.code}`, { userId: ada, deviceId: 'web-ada' });
    for (const d of ['p1', 'p2', 'p3', 'p4']) await call(s.url, 'GET', `/invites/${share.code}`, { deviceId: d });
    await call(s.url, 'POST', `/invites/${share.code}/claim`, { deviceId: 'p1', body: { name: 'Chi', idempotencyKey: key() } });
    // Activity is now full: the next guest is turned away kindly.
    const full = await call(s.url, 'POST', `/invites/${share.code}/claim`, { deviceId: 'p2', body: { name: 'Dayo', idempotencyKey: key() } });
    expect(full.body.error.code).toBe('SOLD_OUT');

    await call(s.url, 'POST', '/events', {
      userId: ada,
      body: { events: [100, 200, 300, 400, 1500].map((latencyMs) => ({ name: 'availability_received', activityId: activity.id, latencyMs })) },
    });
    await flush();

    const { body: report } = await call(s.url, 'GET', '/admin/report');
    const v = report.views;

    expect(v.oversold[0].oversold_activities).toBe(0);
    expect(v.bookingSuccess[0]).toMatchObject({ succeeded: 4, sold_out: 1, errors: 0 });
    expect(Number(v.bookingSuccess[0].success_rate_pct)).toBe(100);

    // 4 bookers (2 direct + 2 guests), 1 inviter.
    expect(v.bookersWhoInvite.find((r: any) => r.segment === 'all bookers')).toMatchObject({ bookers: 4, inviters: 1 });
    expect(v.bookersWhoInvite.find((r: any) => r.segment === 'direct bookers')).toMatchObject({ bookers: 2, inviters: 1 });

    const conv = Object.fromEntries(v.inviteConversion.map((r: any) => [r.rail, r]));
    expect(conv.vouch).toMatchObject({ unique_opens: 1, claimed: 1 });
    expect(Number(conv.vouch.conversion_pct)).toBe(100);
    expect(conv.public).toMatchObject({ unique_opens: 4, claimed: 1 });
    expect(Number(conv.public.conversion_pct)).toBe(25);

    const k = Object.fromEntries(v.kFactorByRail.map((r: any) => [r.rail, r]));
    expect(k.vouch.new_users).toBe(1);
    expect(k.public.new_users).toBe(1);
    expect(k.all.new_users).toBe(2);
    // Existing users who could invite: host + 4 bookers.
    expect(k.all.existing_users).toBe(5);
    expect(Number(k.all.k_factor)).toBe(0.4);

    expect(v.availabilityLatency[0]).toMatchObject({ samples: 5 });
    expect(Number(v.availabilityLatency[0].p50_ms)).toBe(300);

    const statuses = Object.fromEntries(report.goals.map((g: any) => [g.name, g.status]));
    expect(statuses['Never oversell an activity']).toBe('met');
    expect(statuses['Bookers become inviters']).toBe('missed'); // 25% < 30%
  });

  it('exposes Prometheus metrics, including the oversold integrity gauge', async () => {
    const res = await fetch(`${s.url}/metrics`);
    const text = await res.text();
    expect(res.headers.get('content-type')).toContain('text/plain');
    expect(text).toMatch(/velio_booking_attempts_total\{outcome="success",via="direct"\} \d+/);
    expect(text).toMatch(/velio_booking_attempts_total\{outcome="sold_out",via="public"\} 1/);
    expect(text).toContain('velio_oversold_activities 0');
    expect(text).toContain('velio_availability_latency_seconds_bucket');
  });

  it('rejects event names clients are not allowed to send', async () => {
    const res = await call(s.url, 'POST', '/events', { body: { events: [{ name: 'spot_claimed', activityId: '00000000-0000-0000-0000-000000000000' }] } });
    expect(res.status).toBe(400);
  });
});
