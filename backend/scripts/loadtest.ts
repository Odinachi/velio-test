/**
 * SLO load test. Run against a live API (or several, comma-separated):
 *
 *   npm run loadtest
 *   API_URLS=http://localhost:4000,http://localhost:4001 BOOKERS=2000 SPOTS=300 npm run loadtest
 *
 * Opens WATCHERS live connections, then fires BOOKERS simultaneous bookings at an activity with
 * SPOTS spots, and checks every scope SLO. Watchers run on this machine, so commit → receive
 * latency is measured on one clock with no skew.
 */
import { randomUUID } from 'node:crypto';
import { openStream } from '../test/sse.js';

const urls = (process.env.API_URLS ?? 'http://localhost:4000').split(',');
const BOOKERS = Number(process.env.BOOKERS ?? 1000);
const SPOTS = Number(process.env.SPOTS ?? 200);
const WATCHERS = Number(process.env.WATCHERS ?? 50);

const pick = (i: number) => urls[i % urls.length];

async function post(base: string, path: string, body: unknown, userId?: string) {
  const res = await fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(userId ? { 'x-user-id': userId } : {}) },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function inBatches<T>(n: number, size: number, fn: (i: number) => Promise<T>): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < n; i += size) {
    out.push(...(await Promise.all(Array.from({ length: Math.min(size, n - i) }, (_, j) => fn(i + j)))));
  }
  return out;
}

const pct = (xs: number[], p: number) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
};

async function main() {
  console.log(`Load test: ${BOOKERS} bookers → ${SPOTS} spots, ${WATCHERS} live watchers, ${urls.length} API instance(s)\n`);

  const host = (await post(urls[0], '/users', { name: 'Load Host' })).body.user.id;
  const activity = (
    await post(
      urls[0],
      '/activities',
      {
        title: `Load test ${new Date().toISOString()}`,
        startsAt: new Date(Date.now() + 86400_000).toISOString(),
        priceCents: 1000,
        capacity: SPOTS,
      },
      host,
    )
  ).body.activity;

  const latencies: number[] = [];
  const lastVersion = new Map<number, number>();
  const streams = await Promise.all(
    Array.from({ length: WATCHERS }, (_, w) =>
      openStream(`${pick(w)}/stream?activityIds=${activity.id}`, (m) => {
        if (m.event !== 'availability') return;
        latencies.push(m.receivedAt - m.data.committedAt);
        lastVersion.set(w, Math.max(lastVersion.get(w) ?? 0, m.data.version));
      }),
    ),
  );

  process.stdout.write('Creating bookers… ');
  const users = await inBatches(BOOKERS, 100, async (i) => (await post(pick(i), '/users', { name: `Booker ${i}` })).body.user.id as string);
  console.log('done');

  process.stdout.write('Firing all bookings at once… ');
  const started = Date.now();
  const results = await Promise.all(
    users.map(async (u, i) => {
      const t = Date.now();
      const r = await post(pick(i), `/activities/${activity.id}/bookings`, { idempotencyKey: randomUUID() }, u);
      return { status: r.status, code: r.body?.error?.code as string | undefined, ms: Date.now() - t };
    }),
  );
  const wall = Date.now() - started;
  console.log(`done in ${wall} ms`);

  // Give the last updates a moment to arrive.
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && [...lastVersion.values()].filter((v) => v >= SPOTS).length < WATCHERS) {
    await new Promise((r) => setTimeout(r, 50));
  }
  streams.forEach((s) => s.close());

  // Report latencies the same way the clients do, so /admin/report reflects this run.
  for (let i = 0; i < latencies.length; i += 100) {
    await post(urls[0], '/events', {
      events: latencies.slice(i, i + 100).map((latencyMs) => ({ name: 'availability_received', activityId: activity.id, latencyMs })),
    });
  }

  const ok = results.filter((r) => r.status === 201).length;
  const soldOut = results.filter((r) => r.code === 'SOLD_OUT').length;
  const errors = results.filter((r) => r.status >= 500 || r.status === 0).length;
  const other = results.length - ok - soldOut - errors;
  const watchersComplete = [...lastVersion.values()].filter((v) => v >= SPOTS).length;
  const report = await (await fetch(`${urls[0]}/admin/report`)).json();
  const oversold = report.views.oversold[0].oversold_activities;
  const successRate = (100 * ok) / Math.max(1, ok + errors);
  const p95 = pct(latencies, 95);

  const rows: [string, string, string, boolean][] = [
    ['Never oversell', `${oversold} oversold; ${ok} booked of ${SPOTS} spots`, '0 oversold', oversold === 0 && ok === SPOTS],
    ['Bookings succeed when spots exist', `${successRate.toFixed(2)}% (${ok} ok, ${errors} errors)`, '≥ 99.5%', successRate >= 99.5],
    ['Availability feels live (p95)', `${p95} ms over ${latencies.length} deliveries`, '≤ 2000 ms', p95 <= 2000],
  ];

  console.log('\nOutcomes');
  console.log(`  booked ${ok} · sold out ${soldOut} · errors ${errors} · other ${other}`);
  console.log(`  booking latency p50 ${pct(results.map((r) => r.ms), 50)} ms · p95 ${pct(results.map((r) => r.ms), 95)} ms · p99 ${pct(results.map((r) => r.ms), 99)} ms`);
  console.log(`  live update latency p50 ${pct(latencies, 50)} ms · p95 ${p95} ms · p99 ${pct(latencies, 99)} ms · max ${Math.max(...latencies)} ms`);
  console.log(`  watchers that saw the final count: ${watchersComplete}/${WATCHERS}`);
  console.log('\nSLOs');
  for (const [name, value, target, met] of rows) console.log(`  ${met ? 'PASS' : 'FAIL'}  ${name.padEnd(36)} ${value.padEnd(44)} target ${target}`);

  process.exit(rows.every((r) => r[3]) ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
