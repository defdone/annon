import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { hostCapacity } from './capacity.ts';

let dir = '';
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});
it('reserves assembly space and ingress durably, charges failed bytes and preserves publication TTL', async () => {
  dir = await mkdtemp(join(tmpdir(), 'host-capacity-'));
  let now = 0;
  const options = {
    now: () => now,
    hostBytes: 4000,
    poolBytes: 2000,
    ingressPerDay: 1000,
    ttlSeconds: 10,
    canonicalFileId: 'canonical',
    canonicalSlug: 'what-we-are-building',
  };
  const cap = await hostCapacity(dir, options);
  const input = {
    id: 'one',
    fileId: 'file',
    slug: 'file',
    seller: 'evm:unlisted',
    ip: '192.0.2.1',
    listed: false,
    byteSize: 600,
    bodyBytes: 500,
    plaintextSize: 100,
  };
  await cap.reserve(input);
  await expect(
    cap.reserve({ ...input, id: 'two', ip: '192.0.2.2', seller: 'evm:other' }),
  ).rejects.toMatchObject({ code: 'host_capacity' });
  await cap.received('one', 200);
  await cap.close('one');
  const restarted = await hostCapacity(dir, options);
  await restarted.reserve({ ...input, id: 'two' });
  await restarted.received('two', 500);
  await restarted.publish('two');
  now = 9000;
  await restarted.publish('two');
  now = 10000;
  expect(await restarted.expired('file')).toBe(true);
  expect(await restarted.sweep()).toContain('two');
  expect(await restarted.expired('file')).toBe(true);
  await expect(restarted.reserve({ ...input, id: 'three', bodyBytes: 301 })).rejects.toMatchObject({
    code: 'host_capacity',
  });
});
it('exempts only the configured canonical file and rejects plaintext over 50 MB', async () => {
  dir = await mkdtemp(join(tmpdir(), 'host-canonical-'));
  let now = 0;
  const cap = await hostCapacity(dir, {
    now: () => now,
    canonicalFileId: 'canonical',
    canonicalSlug: 'what-we-are-building',
    ttlSeconds: 1,
  });
  const input = {
    id: 'one',
    fileId: 'canonical',
    slug: 'what-we-are-building',
    seller: 'evm:listed',
    ip: '192.0.2.1',
    listed: true,
    byteSize: 100,
    bodyBytes: 50,
    plaintextSize: 10,
  };
  await expect(cap.reserve({ ...input, plaintextSize: 50_000_001 })).rejects.toMatchObject({
    code: 'too_large',
  });
  await cap.reserve(input);
  await cap.received('one', 50);
  await cap.publish('one');
  now = 1000000;
  expect(await cap.expired('canonical')).toBe(false);
});
it('keeps open-pool and listed allowances separate and preserves tombstones on restart', async () => {
  dir = await mkdtemp(join(tmpdir(), 'host-pool-'));
  let now = 0;
  const options = { now: () => now, filesPerDay: 1, filesPerIpDay: 1, ttlSeconds: 1 };
  const cap = await hostCapacity(dir, options);
  const input = {
    id: 'one',
    fileId: 'file',
    slug: 'file',
    seller: 'evm:unlisted',
    ip: '192.0.2.1',
    listed: false,
    byteSize: 100,
    bodyBytes: 50,
    plaintextSize: 10,
  };
  await cap.reserve(input);
  await cap.received('one', 50);
  await cap.verified('one');
  await cap.publish('one');
  await expect(cap.reserve({ ...input, id: 'two', fileId: 'other' })).rejects.toMatchObject({
    code: 'host_capacity',
  });
  await cap.reserve({
    ...input,
    id: 'listed',
    fileId: 'listed',
    seller: 'evm:listed',
    listed: true,
  });
  now = 1000;
  await cap.sweep();
  const restart = await hostCapacity(dir, options);
  await restart.importFile(input);
  expect(await restart.expired('file')).toBe(true);
});
it('keeps expiring bytes reserved until deletion, and refuses missing capacity state after initialization', async () => {
  dir = await mkdtemp(join(tmpdir(), 'host-held-'));
  let now = 0;
  const cap = await hostCapacity(dir, {
    now: () => now,
    hostBytes: 1000,
    poolBytes: 1000,
    ttlSeconds: 1,
  });
  const input = {
    id: 'one',
    fileId: 'file',
    slug: 'file',
    seller: 'seller',
    ip: 'ip',
    listed: false,
    byteSize: 600,
    bodyBytes: 500,
    plaintextSize: 100,
  };
  await cap.importFile(input);
  now = 1000;
  await cap.sweep();
  await expect(cap.reserve({ ...input, id: 'two' })).rejects.toMatchObject({
    code: 'host_capacity',
  });
  await cap.removed('one');
  await cap.reserve({ ...input, id: 'two', byteSize: 400, bodyBytes: 300 });
  const empty = join(dir, 'missing');
  const missing = await hostCapacity(empty, { requireState: true });
  await expect(missing.sweep()).rejects.toThrow('state_missing');
});
it.each([
  ['hostBytes', 1000, false],
  ['poolBytes', 1000, false],
  ['ingressPerDay', 499, false],
  ['filesPerDay', 0, false],
  ['filesPerIpDay', 0, false],
  ['filesPerSellerDay', 0, false],
  ['listedPerSellerDay', 0, true],
  ['concurrency', 0, false],
  ['perSeller', 0, false],
  ['perIp', 0, false],
] as const)('enforces independent admission guard %s', async (name, limit, listed) => {
  dir = await mkdtemp(join(tmpdir(), 'host-bound-'));
  const cap = await hostCapacity(dir, { [name]: limit });
  await expect(
    cap.reserve({
      id: 'one',
      fileId: 'file',
      slug: 'file',
      seller: 'seller',
      ip: 'ip',
      listed,
      byteSize: 600,
      bodyBytes: 500,
      plaintextSize: 100,
    }),
  ).rejects.toMatchObject({ code: 'host_capacity' });
});
it('preserves reservation identity, charges rejected ingress and sweeps abandoned stages without releasing issued quotas', async () => {
  dir = await mkdtemp(join(tmpdir(), 'host-stage-'));
  let now = 0;
  const cap = await hostCapacity(dir, {
    now: () => now,
    filesPerDay: 1,
    ingressPerDay: 1000,
    stagingSeconds: 1,
    idleSeconds: 1,
  });
  const input = {
    id: 'one',
    fileId: 'file',
    slug: 'file',
    seller: 'seller',
    ip: 'ip',
    listed: false,
    byteSize: 600,
    bodyBytes: 500,
    plaintextSize: 100,
  };
  await cap.reserve(input);
  await cap.reserve(input);
  await expect(cap.reserve({ ...input, byteSize: 601 })).rejects.toMatchObject({
    code: 'upload_conflict',
  });
  await expect(cap.verified('one')).rejects.toMatchObject({ code: 'upload_incomplete' });
  await expect(cap.publish('one')).rejects.toMatchObject({ code: 'upload_incomplete' });
  await expect(cap.received('one', 501)).rejects.toMatchObject({ code: 'too_large' });
  await cap.close('one');
  await expect(cap.reserve({ ...input, id: 'two' })).rejects.toMatchObject({
    code: 'host_capacity',
  });
  now = 86_400_000;
  await cap.reserve({ ...input, id: 'three' });
  now += 1000;
  expect(await cap.sweep()).toContain('three');
  await cap.reserve({ ...input, id: 'four' });
  await cap.received('four', 500);
  await cap.verified('four');
  now += 1000;
  expect(await cap.sweep()).toContain('four');
  await expect(cap.reserve({ ...input, id: 'five' })).rejects.toMatchObject({
    code: 'host_capacity',
  });
});
it.each([
  { byteSize: 0, bodyBytes: 0, plaintextSize: 0 },
  { byteSize: NaN },
  { byteSize: 50_086_017 },
  { bodyBytes: 601 },
  { plaintextSize: 50_000_001 },
])('rejects malformed or oversized file declarations %j', async (over) => {
  dir = await mkdtemp(join(tmpdir(), 'host-invalid-'));
  const cap = await hostCapacity(dir);
  await expect(
    cap.reserve({
      id: 'one',
      fileId: 'file',
      slug: 'file',
      seller: 'seller',
      ip: 'ip',
      listed: false,
      byteSize: 600,
      bodyBytes: 500,
      plaintextSize: 100,
      ...over,
    }),
  ).rejects.toMatchObject({ code: 'too_large' });
});
it('carries unfinished ingress reservations across UTC midnight', async () => {
  dir = await mkdtemp(join(tmpdir(), 'host-midnight-'));
  let now = 86_399_000;
  const cap = await hostCapacity(dir, {
    now: () => now,
    ingressPerDay: 999,
    concurrency: 4,
    perIp: 4,
    perSeller: 4,
  });
  const input = {
    id: 'one',
    fileId: 'file',
    slug: 'file',
    seller: 'seller',
    ip: 'ip',
    listed: false,
    byteSize: 600,
    bodyBytes: 500,
    plaintextSize: 100,
  };
  await cap.reserve(input);
  now = 86_400_000;
  await expect(cap.reserve({ ...input, id: 'two' })).rejects.toMatchObject({
    code: 'host_capacity',
  });
});
