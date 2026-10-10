import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';
import type { Db } from './db/pool.js';

export type BookingOutcome = 'success' | 'sold_out' | 'already_booked' | 'rejected' | 'error';

export function createMetrics(db: Db) {
  const registry = new Registry();
  collectDefaultMetrics({ register: registry, prefix: 'velio_process_' });

  const bookingAttempts = new Counter({
    name: 'velio_booking_attempts_total',
    help: 'Booking attempts (direct and invite claims) by outcome',
    labelNames: ['outcome', 'via'] as const,
    registers: [registry],
  });

  const bookingDuration = new Histogram({
    name: 'velio_booking_duration_seconds',
    help: 'Server time to process a booking attempt',
    labelNames: ['outcome'] as const,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
    registers: [registry],
  });

  const availabilityLatency = new Histogram({
    name: 'velio_availability_latency_seconds',
    help: 'Booking commit to an open client receiving the update (client-reported, clock-offset corrected)',
    buckets: [0.05, 0.1, 0.25, 0.5, 1, 1.5, 2, 3, 5, 10],
    registers: [registry],
  });

  const fanoutLatency = new Histogram({
    name: 'velio_availability_fanout_seconds',
    help: 'Booking commit to the update being written to an SSE connection (server clock)',
    buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2],
    registers: [registry],
  });

  const sseClients = new Gauge({
    name: 'velio_sse_clients',
    help: 'Open live-availability connections on this instance',
    registers: [registry],
  });

  const publishFailures = new Counter({
    name: 'velio_availability_publish_failures_total',
    help: 'Availability updates that could not be published to Redis',
    registers: [registry],
  });

  // Integrity check that runs on every scrape: must always be zero.
  new Gauge({
    name: 'velio_oversold_activities',
    help: 'Activities whose spots_taken exceeds capacity or disagrees with confirmed bookings',
    registers: [registry],
    async collect() {
      this.set(await countOversold(db));
    },
  });

  return {
    registry,
    bookingAttempts,
    bookingDuration,
    availabilityLatency,
    fanoutLatency,
    sseClients,
    publishFailures,
  };
}

export type Metrics = ReturnType<typeof createMetrics>;

export async function countOversold(db: Db): Promise<number> {
  const { rows } = await db.query<{ n: number }>(`
    SELECT count(*)::int AS n
      FROM activities a
      LEFT JOIN (SELECT activity_id, count(*) AS c FROM bookings WHERE status = 'confirmed' GROUP BY 1) b
             ON b.activity_id = a.id
     WHERE a.spots_taken > a.capacity OR COALESCE(b.c, 0) <> a.spots_taken`);
  return rows[0].n;
}
