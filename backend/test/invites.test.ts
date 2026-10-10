import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { config } from '../src/config.js';
import { bookingIntegrity, call, createActivity, createUser, key, resetDb, startServer, type TestServer } from './helpers.js';

let s: TestServer;

beforeAll(async () => {
  await resetDb();
  s = await startServer();
});

afterAll(async () => {
  await s?.close();
});

/** An activity outside the invite holdout, with a booker who is going. */
async function setup(capacity = 10) {
  const host = await createUser(s.url, 'Host');
  let activity = await createActivity(s.url, host, capacity);
  while (!activity.invitesEnabled) activity = await createActivity(s.url, host, capacity);
  const booker = await createUser(s.url, 'Ada');
  const booked = await call(s.url, 'POST', `/activities/${activity.id}/bookings`, { userId: booker, body: { idempotencyKey: key() } });
  expect(booked.status).toBe(201);
  return { host, booker, activity };
}

const invite = (activityId: string, userId: string, body: object) =>
  call(s.url, 'POST', `/activities/${activityId}/invites`, { userId, body });

const claim = (code: string, body: object, userId?: string) =>
  call(s.url, 'POST', `/invites/${code}/claim`, { userId, body: { idempotencyKey: key(), ...body } });

describe('invites and attribution', () => {
  it('runs the vouch journey: invite → open → claim, with attribution recorded', async () => {
    const { booker, activity } = await setup();

    const created = await invite(activity.id, booker, { rail: 'vouch', contactLabel: 'Ben' });
    expect(created.status).toBe(201);
    const { code, url, deepLink } = created.body.invite;
    expect(code).toMatch(/^[A-Z2-9]{8}$/);
    expect(url).toContain(`/i/${code}`);
    expect(deepLink).toBe(`velio://invite/${code}`);

    const opened = await call(s.url, 'GET', `/invites/${code.toLowerCase()}`, { deviceId: 'phone-1' });
    expect(opened.status).toBe(200);
    expect(opened.body.invite).toMatchObject({ status: 'valid', rail: 'vouch', contactLabel: 'Ben', inviter: { name: 'Ada' } });

    const claimed = await claim(code, { name: 'Ben' });
    expect(claimed.status).toBe(201);
    expect(claimed.body.isNewUser).toBe(true);
    expect(claimed.body.user).toMatchObject({ name: 'Ben', generation: 1 });
    expect(claimed.body.activity.spotsTaken).toBe(2);

    const { rows } = await s.db.query('SELECT * FROM attributions WHERE invitee_id = $1', [claimed.body.user.id]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ inviter_id: booker, rail: 'vouch', code, generation: 1, is_new_user: true });

    // A vouch is for one person.
    const again = await claim(code, { name: 'Chidi' });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('INVITE_USED');
    const reopened = await call(s.url, 'GET', `/invites/${code}`);
    expect(reopened.body.invite.status).toBe('used');
  });

  it('tracks generations across hops and lets one public link bring in many people', async () => {
    const { booker, activity } = await setup();
    const vouch = await invite(activity.id, booker, { rail: 'vouch', contactLabel: 'Ben' });
    const ben = (await claim(vouch.body.invite.code, { name: 'Ben' })).body.user;
    expect(ben.generation).toBe(1);

    const share = await invite(activity.id, ben.id, { rail: 'public' });
    expect(share.status).toBe(201);
    // Sharing again gives the same link rather than a pile of codes.
    const shareAgain = await invite(activity.id, ben.id, { rail: 'public' });
    expect(shareAgain.status).toBe(200);
    expect(shareAgain.body.invite.code).toBe(share.body.invite.code);

    const guests = [];
    for (const name of ['Chi', 'Dayo', 'Efe']) guests.push((await claim(share.body.invite.code, { name })).body);
    expect(guests.map((g) => g.user.generation)).toEqual([2, 2, 2]);

    const { rows } = await s.db.query(
      'SELECT rail, generation, inviter_id FROM attributions WHERE invite_id = (SELECT id FROM invites WHERE code = $1)',
      [share.body.invite.code],
    );
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.rail === 'public' && r.generation === 2 && r.inviter_id === ben.id)).toBe(true);
  });

  it('lets an existing user claim without changing their generation', async () => {
    const { booker, activity } = await setup();
    const existing = await createUser(s.url, 'Existing');
    const share = await invite(activity.id, booker, { rail: 'public' });
    const res = await claim(share.body.invite.code, {}, existing);
    expect(res.status).toBe(201);
    expect(res.body.isNewUser).toBe(false);
    expect(res.body.user.generation).toBe(0);
    const { rows } = await s.db.query('SELECT is_new_user, generation FROM attributions WHERE invitee_id = $1', [existing]);
    expect(rows[0]).toMatchObject({ is_new_user: false, generation: 1 });
  });

  it('only lets people who are going send invites', async () => {
    const { activity } = await setup();
    const stranger = await createUser(s.url, 'Stranger');
    const res = await invite(activity.id, stranger, { rail: 'public' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('NOT_GOING');
  });

  it('rejects claiming your own invite and asks new guests for a name', async () => {
    const { booker, activity } = await setup();
    const share = await invite(activity.id, booker, { rail: 'public' });
    expect((await claim(share.body.invite.code, {}, booker)).body.error.code).toBe('OWN_INVITE');
    expect((await claim(share.body.invite.code, {})).body.error.code).toBe('NAME_REQUIRED');
  });

  it('keeps nothing when a guest tries to claim a full activity', async () => {
    const { booker, activity } = await setup(1);
    const vouch = await invite(activity.id, booker, { rail: 'vouch', contactLabel: 'Ben' });
    const opened = await call(s.url, 'GET', `/invites/${vouch.body.invite.code}`);
    expect(opened.body.invite.status).toBe('full');

    const before = (await s.db.query('SELECT count(*)::int AS n FROM users')).rows[0].n;
    const res = await claim(vouch.body.invite.code, { name: 'Ben' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('SOLD_OUT');
    // No orphan guest account and the vouch is still unused.
    expect((await s.db.query('SELECT count(*)::int AS n FROM users')).rows[0].n).toBe(before);
    expect((await s.db.query('SELECT uses FROM invites WHERE code = $1', [vouch.body.invite.code])).rows[0].uses).toBe(0);
  });

  it('returns the same guest and booking when a claim is retried', async () => {
    const { booker, activity } = await setup();
    const vouch = await invite(activity.id, booker, { rail: 'vouch', contactLabel: 'Ben' });
    const idempotencyKey = key();
    const first = await call(s.url, 'POST', `/invites/${vouch.body.invite.code}/claim`, { body: { name: 'Ben', idempotencyKey } });
    const retry = await call(s.url, 'POST', `/invites/${vouch.body.invite.code}/claim`, { body: { name: 'Ben', idempotencyKey } });
    expect(first.status).toBe(201);
    expect(retry.status).toBe(200);
    expect(retry.body.user.id).toBe(first.body.user.id);
    expect(retry.body.booking.id).toBe(first.body.booking.id);
  });

  it('gives a single-use vouch to exactly one of many simultaneous guests', async () => {
    const { booker, activity } = await setup(50);
    const vouch = await invite(activity.id, booker, { rail: 'vouch', contactLabel: 'Ben' });
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => claim(vouch.body.invite.code, { name: `Guest ${i}` })));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.body?.error?.code === 'INVITE_USED')).toHaveLength(19);
    const { rows } = await s.db.query('SELECT count(*)::int AS n FROM attributions WHERE invite_id = (SELECT id FROM invites WHERE code = $1)', [vouch.body.invite.code]);
    expect(rows[0].n).toBe(1);
  });

  it('never oversells when invite claims and direct bookings race for the last spots', async () => {
    const { booker, activity } = await setup(3); // booker already holds 1 of 3
    const share = await invite(activity.id, booker, { rail: 'public' });
    const directs = await Promise.all(Array.from({ length: 15 }, (_, i) => createUser(s.url, `D${i}`)));
    const results = await Promise.all([
      ...Array.from({ length: 15 }, (_, i) => claim(share.body.invite.code, { name: `G${i}` })),
      ...directs.map((u) => call(s.url, 'POST', `/activities/${activity.id}/bookings`, { userId: u, body: { idempotencyKey: key() } })),
    ]);
    expect(results.filter((r) => r.status === 201)).toHaveLength(2);
    expect(results.filter((r) => r.body?.error?.code === 'SOLD_OUT')).toHaveLength(28);
    expect(await bookingIntegrity(s.db, activity.id)).toEqual({ capacity: 3, spots_taken: 3, confirmed: 3 });

    // Invite uses always equal the attributions written for it.
    const { rows } = await s.db.query(
      `SELECT i.uses, (SELECT count(*)::int FROM attributions a WHERE a.invite_id = i.id) AS n FROM invites i WHERE i.code = $1`,
      [share.body.invite.code],
    );
    expect(rows[0].uses).toBe(rows[0].n);
  });

  it('keeps activities in the holdout free of invites', async () => {
    const host = await createUser(s.url, 'Host');
    let activity = await createActivity(s.url, host, 5);
    for (let i = 0; i < 200 && activity.invitesEnabled; i++) activity = await createActivity(s.url, host, 5);
    expect(activity.invitesEnabled).toBe(false);
    const { rows } = await s.db.query('SELECT experiment_bucket FROM activities WHERE id = $1', [activity.id]);
    expect(rows[0].experiment_bucket).toBeLessThan(config.invites.holdoutPct);
    const res = await invite(activity.id, host, { rail: 'public' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('INVITES_DISABLED');
  });
});

describe('attribution history is immutable', () => {
  it('rejects UPDATE, DELETE and TRUNCATE on attributions, and generation changes on users', async () => {
    const { booker, activity } = await setup();
    const vouch = await invite(activity.id, booker, { rail: 'vouch', contactLabel: 'Ben' });
    const ben = (await claim(vouch.body.invite.code, { name: 'Ben' })).body.user;

    await expect(s.db.query(`UPDATE attributions SET rail = 'public' WHERE invitee_id = $1`, [ben.id])).rejects.toThrow(/append-only/);
    await expect(s.db.query('DELETE FROM attributions WHERE invitee_id = $1', [ben.id])).rejects.toThrow(/append-only/);
    await expect(s.db.query('TRUNCATE attributions CASCADE')).rejects.toThrow(/append-only/);
    await expect(s.db.query('UPDATE users SET generation = 0 WHERE id = $1', [ben.id])).rejects.toThrow(/immutable/);
    await expect(s.db.query(`DELETE FROM events WHERE name = 'spot_claimed'`)).rejects.toThrow(/append-only/);

    // Names can still change; history can't.
    await s.db.query(`UPDATE users SET name = 'Benjamin' WHERE id = $1`, [ben.id]);
    const { rows } = await s.db.query('SELECT rail, generation FROM attributions WHERE invitee_id = $1', [ben.id]);
    expect(rows[0]).toEqual({ rail: 'vouch', generation: 1 });
  });
});
