import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { alias: { '@defdone/annon': fileURLToPath(new URL('../annon/src', import.meta.url)) } },
  test: {
    setupFiles: [fileURLToPath(new URL('../annon/test/isolated-home.ts', import.meta.url))],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
