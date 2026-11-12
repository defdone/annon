import { expect, it } from 'vitest';
import { hostSettings } from './config.ts';

const env = {
  PUBLIC_URL: 'https://demo.example',
  RELAYER_ORIGIN: 'https://relay.example',
  SELLERS: 'evm:0x1111111111111111111111111111111111111111',
  CANONICAL_DEMO_FILE_ID: `0x${'11'.repeat(32)}`,
};
it('uses frozen defaults, accepts zero disabling caps and rejects invalid or raised maxima', () => {
  expect(hostSettings(env)).toMatchObject({
    perIpMinute: 600,
    paymentsPerClientMinute: 60,
    sendsPerMinute: 10,
    facilitator: { maxWaiting: 16 },
    maxFileBytes: 50_000_000,
    maxPay2Bytes: 50_086_016,
    capacity: { ingressPerDay: 1_000_000_000, ttlSeconds: 604800 },
  });
  expect(hostSettings({ ...env, SPONSORED_FILES_PER_DAY: '0' }).capacity.filesPerDay).toBe(0);
  for (const override of [
    { MAX_FILE_BYTES: '50000001' },
    { MAX_FEE_GWEI: 'Infinity' },
    { PER_IP_MINUTE: '-1' },
    { FACILITATOR_STUCK_SECONDS: '0' },
    { MAX_PAY2_BYTES: 'NaN' },
    { PUBLIC_URL: 'https://demo.example/path' },
    { RELAYER_ORIGIN: 'http://relay.example' },
    { SELLERS: '' },
    { CORS_PREVIEW_ORIGINS: 'https://a.b.vercel.app' },
  ])
    expect(() => hostSettings({ ...env, ...override })).toThrow();
});

it('excludes test sources from both runtime image source copies', async () => {
  const { readFile } = await import('node:fs/promises');
  const docker = await readFile(new URL('./Dockerfile', import.meta.url), 'utf8');
  for (const line of docker.split('\n').filter((line) => /^COPY .*\/(src|\*\.ts)/.test(line))) {
    expect(line).toContain('--exclude=**/*.test.ts');
  }
  expect(docker).not.toContain('COPY apps/demo-host/*.ts');
});
