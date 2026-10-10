import { buildApp } from './app.js';
import { config } from './config.js';
import { migrate } from './db/migrate.js';
import { createPool } from './db/pool.js';
import { createMetrics } from './metrics.js';
import { createRedisBus } from './realtime.js';

const applied = await migrate();
if (applied.length) console.log(`Applied migrations: ${applied.join(', ')}`);

const db = createPool();
// The tracking views read the holdout split from the database, so keep it in sync with config.
await db.query(
  `INSERT INTO experiment_config (key, value) VALUES ('invites_holdout_pct', $1)
   ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
  [config.invites.holdoutPct],
);
const metrics = createMetrics(db);
const bus = createRedisBus(config.redisUrl, () => metrics.publishFailures.inc());
const app = await buildApp({ db, bus, metrics }, { logger: true });

await app.listen({ port: config.port, host: '0.0.0.0' });

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    await app.close();
    await bus.close();
    await db.end();
    process.exit(0);
  });
}
