import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Includes the opt-in Docker production install check.
  test: { testTimeout: 180_000, hookTimeout: 30_000 },
});
