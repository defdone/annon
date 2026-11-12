import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Allow CPU contention during exhaustive crypto checks and optional multi-GiB round trips.
    testTimeout:
      process.env.ANNON_LARGE_FILES === '1'
        ? 900_000
        : process.env.ANNON_EXHAUSTIVE === '1'
          ? 180_000
          : 60_000,
    hookTimeout: 30_000,
  },
});
