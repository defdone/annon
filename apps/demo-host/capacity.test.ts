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

it('keeps assembly and expired staging bytes charged until their physical removal', async () => {
  dir = await mkdtemp(join(tmpdir(), 'host-assembly-hold-'));
  let now = 0;
  const cap = await hostCapacity(dir, {
    now: () => now,
    hostBytes: 2100,
    poolBytes: 2100,
    stagingSeconds: 1,
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
  await cap.received('one', 500);
  await cap.verified('one');
  await cap.publish('one');
  await expect(cap.reserve({ ...input, id: 'two' })).rejects.toMatchObject({
    code: 'host_capacity',
  });
  await cap.releaseAssembly('one');
  await cap.reserve({ ...input, id: 'two' });
  await cap.received('two', 500);
  await cap.verified('two');
  now = 1000;
  expect(await cap.sweep()).toContain('two');
  await expect(cap.reserve({ ...input, id: 'three' })).rejects.toMatchObject({
    code: 'host_capacity',
  });
  await cap.removed('two');
  await cap.reserve({ ...input, id: 'three' });
});
it.each(['concurrency', 'perSeller', 'perIp', 'ingressPerDay'] as const)(
  'applies %s again to a retry or assembly stream',
  async (name) => {
    dir = await mkdtemp(join(tmpdir(), 'host-retry-limit-'));
    const cap = await hostCapacity(dir, { [name]: name === 'ingressPerDay' ? 1000 : 1 });
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
    await cap.received('one', 500);
    await cap.verified('one');
    await cap.reserve({ ...input, id: 'two' });
    await expect(cap.begin('one', name === 'ingressPerDay')).rejects.toMatchObject({
      code: 'host_capacity',
    });
    await cap.close('two');
    await cap.begin('one', true);
    await expect(cap.begin('one', true)).rejects.toMatchObject({ code: 'upload_conflict' });
    await cap.received('one', 500);
    await cap.end('one');
    await cap.begin('one', false);
    await cap.end('one');
  },
);

it('refuses corrupt counter and object records on every state read', async () => {
  const { readdir, readFile, writeFile } = await import('node:fs/promises');
  dir = await mkdtemp(join(tmpdir(), 'host-invalid-ledger-'));
  const cap = await hostCapacity(dir, { now: () => 0 });
  await cap.sweep();
  const file = join(dir, (await readdir(dir)).find((name) => name.endsWith('.json')) ?? 'missing');
  const valid = JSON.parse(await readFile(file, 'utf8'));
  for (const changed of [
    { ...valid, objects: 1 },
    { ...valid, days: { 0: { ingress: null, files: 0, ips: {}, sellers: {} } } },
    { ...valid, objects: { broken: { state: 'published', byteSize: null } } },
  ]) {
    await writeFile(file, JSON.stringify(changed));
    await expect(cap.sweep()).rejects.toMatchObject({ reason: 'state_invalid' });
    await expect(cap.expired('file')).rejects.toMatchObject({ reason: 'state_invalid' });
  }
});

it.each(['filesPerDay', 'filesPerIpDay', 'filesPerSellerDay', 'listedPerSellerDay'] as const)(
  'persists and enforces the consumed %s allowance independently',
  async (guard) => {
    dir = await mkdtemp(join(tmpdir(), 'host-counter-'));
    const options = { [guard]: 1 };
    const input = {
      id: 'one',
      fileId: 'one',
      slug: 'one',
      seller: 'seller',
      ip: 'ip',
      listed: guard === 'listedPerSellerDay',
      byteSize: 100,
      bodyBytes: 50,
      plaintextSize: 10,
    };
    const cap = await hostCapacity(dir, options);
    await cap.reserve(input);
    await cap.received(input.id, input.bodyBytes);
    await cap.verified(input.id);
    const restart = await hostCapacity(dir, options);
    await expect(
      restart.reserve({
        ...input,
        id: 'two',
        fileId: 'two',
        ...(guard === 'filesPerDay' ? { seller: 'other', ip: 'other' } : {}),
        ...(guard === 'filesPerIpDay' ? { seller: 'other' } : {}),
        ...(guard.endsWith('SellerDay') ? { ip: 'other' } : {}),
      }),
    ).rejects.toMatchObject({ code: 'host_capacity' });
  },
);

it.each(['concurrency', 'perSeller', 'perIp', 'ingressPerDay'] as const)(
  'applies %s to retries and header assembly as well as admission',
  async (guard) => {
    dir = await mkdtemp(join(tmpdir(), 'host-retry-limit-'));
    const input = {
      id: 'one',
      fileId: 'one',
      slug: 'one',
      seller: 'seller',
      ip: 'ip',
      listed: false,
      byteSize: 100,
      bodyBytes: 50,
      plaintextSize: 10,
    };
    const cap = await hostCapacity(dir);
    await cap.reserve(input);
    await cap.received(input.id, input.bodyBytes);
    await cap.verified(input.id);
    const restart = await hostCapacity(dir, { [guard]: guard === 'ingressPerDay' ? 99 : 0 });
    await expect(restart.begin('one', true)).rejects.toMatchObject({ code: 'host_capacity' });
    await restart.publish('one');
  },
);

it.each([{ fileId: 'other' }, { slug: 'other' }])(
  'requires both canonical bindings %j',
  async (over) => {
    dir = await mkdtemp(join(tmpdir(), 'host-canonical-bind-'));
    let now = 0;
    const cap = await hostCapacity(dir, {
      now: () => now,
      canonicalFileId: 'canonical',
      ttlSeconds: 1,
    });
    const input = {
      id: 'one',
      fileId: 'canonical',
      slug: 'what-we-are-building',
      seller: 'seller',
      ip: 'ip',
      listed: true,
      byteSize: 100,
      bodyBytes: 50,
      plaintextSize: 10,
      ...over,
    };
    await cap.importFile(input);
    now = 1000;
    expect(await cap.expired(input.fileId)).toBe(true);
    expect(await cap.expiredSlug(input.slug)).toBe(true);
    const other = {
      ...input,
      id: 'two',
      fileId: 'canonical',
      slug: 'what-we-are-building',
      ...over,
    };
    await cap.reserve(other);
    await cap.received(other.id, other.bodyBytes);
    await cap.publish(other.id);
    now = 2000;
    expect((await cap.info(other.id))?.expiresAt).toBe(2000);
  },
);

it('charges an over-budget incoming piece before rejecting it without a Content-Length', async () => {
  dir = await mkdtemp(join(tmpdir(), 'host-actual-ingress-'));
  let now = 0;
  const cap = await hostCapacity(dir, { now: () => now, ingressPerDay: 100 });
  const input = {
    id: 'one',
    fileId: 'one',
    slug: 'one',
    seller: 'seller',
    ip: 'ip',
    listed: false,
    byteSize: 200,
    bodyBytes: 100,
    plaintextSize: 10,
  };
  await cap.reserve(input);
  now = 86400000;
  await cap.received('one', 60);
  await cap.close('one');
  await cap.reserve({ ...input, id: 'two', bodyBytes: 40 });
  await expect(cap.received('two', 41)).rejects.toMatchObject({ code: 'too_large' });
  await cap.close('two');
  await expect(
    (await hostCapacity(dir, { now: () => now, ingressPerDay: 100 })).reserve({
      ...input,
      id: 'three',
      bodyBytes: 1,
    }),
  ).rejects.toMatchObject({ code: 'host_capacity' });
});

it('rejects invalid ingress calls and refuses publication after expiry', async () => {
  dir = await mkdtemp(join(tmpdir(), 'host-invalid-ingress-'));
  let now = 0;
  const cap = await hostCapacity(dir, { now: () => now, stagingSeconds: 1 });
  const input = {
    id: 'one',
    fileId: 'one',
    slug: 'one',
    seller: 'seller',
    ip: 'ip',
    listed: false,
    byteSize: 100,
    bodyBytes: 50,
    plaintextSize: 10,
  };
  await cap.reserve(input);
  for (const amount of [-1, NaN, 1.5])
    await expect(cap.received('one', amount)).rejects.toMatchObject({ code: 'upload_conflict' });
  await cap.received('one', 50);
  await cap.verified('one');
  await expect(cap.received('one', 1)).rejects.toMatchObject({ code: 'upload_conflict' });
  now = 1000;
  await cap.sweep();
  await expect(cap.publish('one')).rejects.toMatchObject({ code: 'upload_conflict' });
});

it('applies import size and space limits before admitting operator files', async () => {
  dir = await mkdtemp(join(tmpdir(), 'host-import-limits-'));
  const input = {
    id: 'one',
    fileId: 'one',
    slug: 'one',
    seller: 'seller',
    ip: 'ip',
    listed: false,
    byteSize: 100,
    bodyBytes: 50,
    plaintextSize: 10,
  };
  const cap = await hostCapacity(dir, { hostBytes: 150, poolBytes: 150 });
  for (const over of [{ byteSize: 50_086_017 }, { plaintextSize: 50_000_001 }])
    await expect(cap.importFile({ ...input, ...over })).rejects.toMatchObject({
      code: 'too_large',
    });
  await cap.importFile(input);
  await expect(cap.importFile({ ...input, id: 'two' })).rejects.toMatchObject({
    code: 'host_capacity',
  });
});

it('releases abandoned retry reservations on restart while preserving received ingress', async () => {
  dir = await mkdtemp(join(tmpdir(), 'host-retry-recover-'));
  const cap = await hostCapacity(dir, { ingressPerDay: 120 });
  const input = {
    id: 'one',
    fileId: 'one',
    slug: 'one',
    seller: 'seller',
    ip: 'ip',
    listed: false,
    byteSize: 100,
    bodyBytes: 50,
    plaintextSize: 10,
  };
  await cap.reserve(input);
  await cap.received('one', 50);
  await cap.verified('one');
  await cap.begin('one', true);
  await cap.received('one', 21);
  const restart = await hostCapacity(dir, { ingressPerDay: 120 });
  await restart.recover();
  await restart.begin('one', false);
  await restart.end('one');
  await expect(restart.begin('one', true)).rejects.toMatchObject({ code: 'host_capacity' });
  await restart.publish('one');
});

it('rechecks daily ingress on each piece after the operator lowers the limit', async () => {
  dir = await mkdtemp(join(tmpdir(), 'host-lowered-ingress-'));
  const input = {
    id: 'one',
    fileId: 'file',
    slug: 'file',
    seller: 'seller',
    ip: 'ip',
    listed: false,
    byteSize: 200,
    bodyBytes: 100,
    plaintextSize: 10,
  };
  const first = await hostCapacity(dir, { ingressPerDay: 100 });
  await first.reserve(input);
  await first.received('one', 20);
  const next = await hostCapacity(dir, { ingressPerDay: 50 });
  await next.received('one', 30);
  await expect(next.received('one', 1)).rejects.toMatchObject({ code: 'too_large' });
});
it.each(['files', 'ip', 'seller'] as const)(
  'uses the demo default %s allowance across restart',
  async (guard) => {
    dir = await mkdtemp(join(tmpdir(), 'host-demo-default-'));
    const input = {
      id: '',
      fileId: '',
      slug: '',
      seller: 'seller',
      ip: 'ip',
      listed: false,
      byteSize: 100,
      bodyBytes: 50,
      plaintextSize: 10,
    };
    const cap = await hostCapacity(dir);
    const limit = guard === 'files' ? 30 : 3;
    for (let i = 0; i < limit; i++) {
      await cap.reserve({
        ...input,
        id: String(i),
        fileId: String(i),
        seller: guard === 'seller' ? 'seller' : String(i),
        ip: guard === 'ip' ? 'ip' : String(i),
      });
      await cap.received(String(i), 50);
      await cap.verified(String(i));
    }
    await expect(
      (await hostCapacity(dir)).reserve({
        ...input,
        id: 'extra',
        fileId: 'extra',
        seller: guard === 'seller' ? 'seller' : 'extra',
        ip: guard === 'ip' ? 'ip' : 'extra',
      }),
    ).rejects.toMatchObject({ code: 'host_capacity' });
  },
);
