function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number, got "${raw}"`);
  return n;
}

export const config = {
  port: int('PORT', 4000),
  databaseUrl: process.env.DATABASE_URL ?? 'postgres://velio:velio@localhost:5442/velio',
  redisUrl: process.env.REDIS_URL ?? 'redis://localhost:6389',
  dbPoolSize: int('DB_POOL_SIZE', 20),
  // Public base URL used when building invite links.
  webUrl: process.env.WEB_URL ?? 'http://localhost:3000',
  invites: {
    // Kill switch for the whole invite feature.
    enabled: (process.env.INVITES_ENABLED ?? 'true') !== 'false',
    // Share of activities (0-100) that never offer invites, so we can measure causal lift.
    holdoutPct: int('INVITES_HOLDOUT_PCT', 10),
    vouchTtlHours: int('VOUCH_TTL_HOURS', 24 * 7),
  },
};
