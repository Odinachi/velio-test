/**
 * Demo data through the real API, so it exercises the same paths as the apps:
 *   npm run seed            (API must be running)
 */
import { randomUUID } from 'node:crypto';

const API = process.env.API_URL ?? 'http://localhost:4000';

async function api(method: string, path: string, body?: unknown, userId?: string) {
  const res = await fetch(API + path, {
    method,
    headers: { 'content-type': 'application/json', ...(userId ? { 'x-user-id': userId } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${JSON.stringify(json)}`);
  return json;
}

const user = async (name: string) => (await api('POST', '/users', { name })).user.id as string;
const days = (n: number, hour: number) => {
  const d = new Date(Date.now() + n * 86400_000);
  d.setHours(hour, 0, 0, 0);
  return d.toISOString();
};

const activities = [
  { title: 'Sunset Kayaking', location: 'Lekki Lagoon', description: 'Paddle out at golden hour with a guide. No experience needed; life jackets provided.', startsAt: days(3, 17), priceCents: 4500, capacity: 8 },
  { title: 'Secret Speakeasy Tour', location: 'Victoria Island (address sent the day before)', description: 'Three hidden bars, one password each. Drinks not included.', startsAt: days(5, 20), priceCents: 3000, capacity: 12 },
  { title: 'Sunrise Hike & Breakfast', location: 'Aso Rock trailhead', description: 'Easy 5 km hike, then breakfast at the top.', startsAt: days(7, 6), priceCents: 2000, capacity: 15 },
  { title: 'Pottery Night', location: 'Studio 9, Yaba', description: 'Throw your first bowl. Clay, wheel and apron included.', startsAt: days(4, 19), priceCents: 3500, capacity: 4 },
  { title: 'Rooftop Film Club', location: 'Ikoyi rooftop', description: 'Classic film under the stars. Bring a blanket.', startsAt: days(2, 20), priceCents: 1500, capacity: 30 },
];

async function main() {
  const [tobi, amara] = [await user('Tobi (host)'), await user('Amara (host)')];
  const bookers = await Promise.all(['Ada', 'Bola', 'Chidi', 'Damola', 'Efe', 'Funke'].map(user));

  const created = [];
  for (const [i, a] of activities.entries()) {
    created.push((await api('POST', '/activities', a, i % 2 ? amara : tobi)).activity);
  }

  // Some bookings so the dashboards aren't empty; Pottery Night is one spot from full.
  const book = (activityId: string, userId: string) =>
    api('POST', `/activities/${activityId}/bookings`, { idempotencyKey: randomUUID() }, userId);
  for (const u of bookers.slice(0, 3)) await book(created[0].id, u);
  for (const u of bookers.slice(0, 3)) await book(created[3].id, u);
  for (const u of bookers.slice(2, 6)) await book(created[1].id, u);

  // Ada vouches for a friend; Bola shares a public link.
  const enabled = created.find((a) => a.invitesEnabled) ?? created[0];
  let vouch, share;
  try {
    if (enabled.id !== created[0].id) await book(enabled.id, bookers[0]).catch(() => {});
    vouch = (await api('POST', `/activities/${enabled.id}/invites`, { rail: 'vouch', contactLabel: 'Kemi' }, bookers[0])).invite;
    await book(enabled.id, bookers[1]).catch(() => {});
    share = (await api('POST', `/activities/${enabled.id}/invites`, { rail: 'public' }, bookers[1])).invite;
  } catch (err) {
    console.warn('Could not create demo invites:', (err as Error).message);
  }

  console.log(`Seeded ${created.length} activities, ${bookers.length + 2} users.`);
  if (vouch) console.log(`Vouch code for Kemi:  ${vouch.code}   ${vouch.url}`);
  if (share) console.log(`Public share code:    ${share.code}   ${share.url}`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
