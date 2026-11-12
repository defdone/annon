import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { alias: { '@defdone/annon': fileURLToPath(new URL('../annon/src', import.meta.url)) } },
  test: { testTimeout: 30_000, hookTimeout: 30_000 },
});
