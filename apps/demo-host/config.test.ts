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
    capacity: { ingressPerDay: 2_000_000_000, ttlSeconds: 604800 },
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

it.each([
  ['UPLOAD_AUTH_SECONDS', '601'],
  ['UPLOAD_RESERVATION_SECONDS', '599'],
  ['UPLOAD_RESERVATION_SECONDS', '601'],
  ['UPLOAD_AUTH_HEADER_BYTES', '8193'],
  ['UPLOAD_FILENAME_BYTES', '256'],
  ['UPLOAD_TITLE_BYTES', '121'],
  ['UPLOAD_DESCRIPTION_BYTES', '501'],
  ['UPLOAD_REQUEST_SECONDS', '1801'],
  ['OPEN_POOL_ENABLED', '2'],
  ['DEMO_RESERVATION_SIGNING_KEY', 'invalid'],
] as const)('rejects invalid upload setting %s', (key, value) => {
  expect(() => hostSettings({ ...env, [key]: value })).toThrow();
});
it('parses upload defaults and disabling separately from the listed allowance', () => {
  expect(hostSettings({ ...env, OPEN_POOL_ENABLED: '0' })).toMatchObject({
    uploads: {
      openPoolEnabled: false,
      authSeconds: 600,
      reservationSeconds: 600,
      filenameBytes: 255,
      titleBytes: 120,
      descriptionBytes: 500,
    },
    uploadHttp: {
      maxJsonBytes: 131072,
      maxHeaderBytes: 65536,
      authHeaderBytes: 8192,
      idleSeconds: 600,
      requestSeconds: 1800,
    },
    capacity: {
      listedPerSellerDay: 20,
      filesPerDay: 200,
      filesPerIpDay: 10,
      filesPerSellerDay: 10,
    },
  });
});
