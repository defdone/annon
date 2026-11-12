import { mkdir, mkdtemp, readdir, readFile, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { downloadLedger } from './downloads.ts';

let dir = '';
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});
const input = {
  network: 'near:mainnet',
  contract: 'contract.near',
  purchaseId: `0x${'11'.repeat(32)}`,
  fileId: `0x${'22'.repeat(32)}`,
  version: 'immutable',
  size: 1000,
  headerLength: 100,
  start: 100,
  range: true,
};
it('counts only finished whole bodies, persists cooldowns and keeps recovery grants in one quota', async () => {
  dir = await mkdtemp(join(tmpdir(), 'host-downloads-'));
  let now = 1_000_000;
  const ledger = await downloadLedger(dir, { now: () => now });
  for (let i = 0; i < 3; i++) {
    const lease = await ledger.reserve(input);
    expect(lease.ok).toBe(true);
    if (!lease.ok) throw new Error('refused');
    await lease.delivery.wrote(1000);
    await expect(lease.delivery.finish()).rejects.toThrow();
    await lease.delivery.prepare();
    await lease.delivery.finish();
    await lease.delivery.finish();
  }
  const restarted = await downloadLedger(dir, { now: () => now });
  expect(await restarted.reserve(input)).toMatchObject({
    ok: false,
    status: 429,
    code: 'download_limited',
    retryAfterSeconds: 900,
  });
  now += 899_001;
  expect(await restarted.reserve(input)).toMatchObject({ retryAfterSeconds: 1 });
  now += 999;
  const fourth = await restarted.reserve(input);
  if (!fourth.ok) throw new Error('refused');
  await fourth.delivery.wrote(1000);
  await fourth.delivery.prepare();
  await fourth.delivery.finish();
  expect(await restarted.reserve(input)).toMatchObject({ retryAfterSeconds: 7200 });
  now += 7_200_000;
  const fifth = await restarted.reserve(input);
  if (!fifth.ok) throw new Error('refused');
  await fifth.delivery.wrote(1000);
  await fifth.delivery.prepare();
  await fifth.delivery.finish();
  expect(await restarted.reserve(input)).toMatchObject({ retryAfterSeconds: 86400 });
});
it('bounds resumes, refuses arbitrary offsets and concurrent streams, and favors retries after a crash', async () => {
  dir = await mkdtemp(join(tmpdir(), 'host-resume-'));
  let now = 0;
  const ledger = await downloadLedger(dir, { now: () => now });
  expect(await ledger.reserve({ ...input, start: 500 })).toMatchObject({ ok: false, status: 416 });
  const first = await ledger.reserve(input);
  if (!first.ok) throw new Error('refused');
  expect(await ledger.reserve(input)).toMatchObject({
    code: 'download_in_progress',
    retryAfterSeconds: 5,
  });
  await first.delivery.wrote(500);
  await first.delivery.interrupt();
  expect(await ledger.reserve({ ...input, start: 501 })).toMatchObject({ status: 416 });
  now = 599_999;
  const resumed = await ledger.reserve({ ...input, start: 400 });
  if (!resumed.ok) throw new Error('refused');
  await resumed.delivery.wrote(1000);
  await resumed.delivery.prepare();
  const restart = await downloadLedger(dir, { now: () => now });
  const retry = await restart.reserve(input);
  if (!retry.ok) throw new Error('refused');
  await retry.delivery.interrupt();
  now += 600_001;
  expect(await restart.reserve({ ...input, start: 400 })).toMatchObject({ status: 416 });
  expect((await restart.reserve({ ...input, start: 0, range: false })).ok).toBe(true);
});
it('does not admit a second simultaneous reservation or resume beyond total attempt lifetime', async () => {
  dir = await mkdtemp(join(tmpdir(), 'host-race-'));
  let now = 0;
  const ledger = await downloadLedger(dir, { now: () => now });
  const both = await Promise.all([ledger.reserve(input), ledger.reserve(input)]);
  expect(both.filter((r) => r.ok)).toHaveLength(1);
  const first = both.find((r) => r.ok);
  if (!first?.ok) throw new Error('refused');
  await first.delivery.wrote(500);
  await first.delivery.interrupt();
  now = 1_799_000;
  expect(await ledger.reserve({ ...input, start: 300 })).toMatchObject({ status: 416 });
  const fresh = await ledger.reserve(input);
  if (!fresh.ok) throw new Error('refused');
  now += 1_799_000;
  await fresh.delivery.wrote(500);
  await fresh.delivery.interrupt();
  now += 1001;
  expect(await ledger.reserve({ ...input, start: 300 })).toMatchObject({ status: 416 });
});
it('rejects incomplete and excessive coverage, preserves version binding and never bills interruption', async () => {
  dir = await mkdtemp(join(tmpdir(), 'host-coverage-'));
  const ledger = await downloadLedger(dir);
  const a = await ledger.reserve(input);
  if (!a.ok) throw new Error('refused');
  await expect(a.delivery.prepare()).rejects.toThrow();
  await expect(a.delivery.finish()).rejects.toThrow();
  await expect(a.delivery.wrote(1001)).rejects.toThrow();
  await a.delivery.wrote(500);
  await expect(a.delivery.wrote(499)).rejects.toThrow();
  await a.delivery.interrupt();
  expect(await ledger.reserve({ ...input, start: 400, version: 'changed' })).toMatchObject({
    status: 416,
  });
  for (let i = 0; i < 5; i++) {
    const r = await ledger.reserve(input);
    if (!r.ok) throw new Error('refused');
    await r.delivery.wrote(1000);
    await r.delivery.prepare();
    await r.delivery.interrupt();
  }
  const success = await ledger.reserve(input);
  expect(success.ok).toBe(true);
});
it('keeps quotas separate for each network, contract, purchase and file', async () => {
  dir = await mkdtemp(join(tmpdir(), 'host-keys-'));
  const ledger = await downloadLedger(dir);
  for (const over of [
    {},
    { network: 'other' },
    { contract: 'other' },
    { purchaseId: 'other' },
    { fileId: 'other' },
  ]) {
    for (let i = 0; i < 3; i++) {
      const r = await ledger.reserve({ ...input, ...over });
      if (!r.ok) throw new Error('shared quota');
      await r.delivery.wrote(1000);
      await r.delivery.prepare();
      await r.delivery.finish();
    }
    expect(await ledger.reserve({ ...input, ...over })).toMatchObject({ code: 'download_limited' });
  }
});
it('refuses corrupt saved quota fields instead of resetting download allowances', async () => {
  dir = await mkdtemp(join(tmpdir(), 'host-corrupt-quota-'));
  const ledger = await downloadLedger(dir);
  const r = await ledger.reserve(input);
  if (!r.ok) throw new Error('refused');
  await r.delivery.interrupt();
  const { readdir, readFile, writeFile } = await import('node:fs/promises');
  const file = (await readdir(dir)).find((name) => name.endsWith('.json'));
  if (!file) throw new Error('missing ledger');
  const saved = JSON.parse(await readFile(join(dir, file), 'utf8'));
  delete saved.completedCount;
  await writeFile(join(dir, file), JSON.stringify(saved));
  await expect(ledger.reserve(input)).rejects.toThrow('invalid');
});

it('checkpoints offsets after one MiB or one second and flushes exact coverage on prepare and interrupt', async () => {
  dir = await mkdtemp(join(tmpdir(), 'host-checkpoint-'));
  let now = 0;
  const ledger = await downloadLedger(dir, { now: () => now });
  const lease = await ledger.reserve({ ...input, size: 3_000_000, start: 0 });
  if (!lease.ok) throw new Error('refused');
  const saved = async () =>
    JSON.parse(
      await readFile(
        join(dir, (await readdir(dir)).find((n) => n.endsWith('.json')) as string),
        'utf8',
      ),
    );
  const revision = (await saved()).revision;
  for (let n = 1; n <= 15; n++) await lease.delivery.wrote(n * 65536);
  expect((await saved()).revision).toBe(revision);
  await lease.delivery.wrote(1048576);
  expect((await saved()).attempt.offset).toBe(1048576);
  now = 1000;
  await lease.delivery.wrote(1048577);
  expect((await saved()).attempt.offset).toBe(1048577);
  now = 1100;
  await lease.delivery.wrote(1049000);
  now = 1200;
  await lease.delivery.interrupt();
  expect((await saved()).attempt).toMatchObject({
    offset: 1049000,
    activityAt: 1100,
    status: 'interrupted',
  });
  const next = await ledger.reserve({ ...input, size: 3_000_000, start: 1049000 });
  if (!next.ok) throw new Error('refused');
  await next.delivery.wrote(2097576);
  await next.delivery.wrote(3_000_000);
  expect((await saved()).attempt.offset).toBe(2097576);
  await next.delivery.prepare();
  expect((await saved()).attempt).toMatchObject({
    offset: 3_000_000,
    status: 'completion_pending',
  });
});
it('releases the active lease even when interrupt persistence fails', async () => {
  dir = await mkdtemp(join(tmpdir(), 'host-interrupt-failure-'));
  const ledger = await downloadLedger(dir);
  const lease = await ledger.reserve(input);
  if (!lease.ok) throw new Error('refused');
  const backup = `${dir}-backup`;
  await rename(dir, backup);
  await mkdir(dir);
  try {
    await expect(lease.delivery.interrupt()).rejects.toThrow();
    await rm(dir, { recursive: true });
    await rename(backup, dir);
    expect((await ledger.reserve(input)).ok).toBe(true);
  } finally {
    await rm(backup, { recursive: true, force: true });
  }
});
