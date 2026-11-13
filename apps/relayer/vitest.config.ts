import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^@defdone\/annon$/,
        replacement: new URL('../../packages/annon/src/index.ts', import.meta.url).pathname,
      },
      ...[
        'relay',
        'node',
        'near/rpc',
        'download/http',
        'pay/store',
        'pay/store-node',
        'pay/split',
      ].map((path) => ({
        find: new RegExp(`^@defdone/annon/${path}$`),
        replacement: new URL(
          `../../packages/annon/src/${['relay', 'node'].includes(path) ? `${path}/index` : path}.ts`,
          import.meta.url,
        ).pathname,
      })),
    ],
  },
  // Includes the opt-in Docker production install check.
  test: { testTimeout: 180_000, hookTimeout: 30_000 },
});
