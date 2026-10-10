import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Tests share one Postgres database, so run files one at a time.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
