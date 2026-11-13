import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { retryGate } from './retry-gate.js';

it('enforces a durable host/deployment/purchase/file wait across callers and restarts', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'annon-gate-'));
  let now = 1000;
  try {
    const context = {
      stateDir: dir,
      network: 'near:mainnet',
      contractId: 'annon.near',
      host: 'https://files.test',
      purchaseId: `0x${'11'.repeat(32)}`,
      fileId: `0x${'22'.repeat(32)}`,
    };
    const first = retryGate(context, () => now);
    await first.defer('download_limited', 900);
    const call = vi.fn();
    await expect(
      retryGate(context, () => now)
        .check()
        .then(call),
    ).rejects.toMatchObject({
      code: 'download_limited',
      retryAfterSeconds: 900,
      purchaseId: context.purchaseId,
      fileId: context.fileId,
    });
    expect(call).not.toHaveBeenCalled();
    now += 11;
    await expect(retryGate(context, () => now).check()).rejects.toMatchObject({
      retryAfterSeconds: 889,
    });
    await retryGate({ ...context, host: 'https://other.test' }, () => now).check();
    await retryGate({ ...context, contractId: 'other.near' }, () => now).check();
    now += 889;
    await first.check();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
it('does not shorten concurrent gates and isolates the settlement gate from grant changes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'annon-gate-'));
  try {
    const context = {
      stateDir: dir,
      network: 'near:mainnet',
      contractId: 'annon.near',
      purchaseId: `0x${'11'.repeat(32)}`,
    };
    await Promise.all([
      retryGate(context, () => 1000).defer('settlement_pending', 30),
      retryGate(context, () => 1000).defer('settlement_pending', 10),
    ]);
    await retryGate(context, () => 1000).defer('settlement_pending', 30);
    await retryGate(context, () => 1000).defer('settlement_pending', 10);
    await expect(retryGate(context, () => 1001).check()).rejects.toMatchObject({
      code: 'settlement_pending',
      retryAfterSeconds: 29,
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
