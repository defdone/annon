import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { ownDirectory } from '../../packages/annon/src/pay/store-node.ts';
import { cutover } from './cutover.ts';
import { sealLegacy } from './cutover-scan.ts';

vi.mock('./cutover-scan.ts', () => ({ sealLegacy: vi.fn() }));
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
it('scans beside a running service, refuses its final seal, and resumes when only the time budget changes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cutover-online-'));
  const stateDir = join(dir, 'state');
  const policyFile = join(dir, 'policy.json');
  const policy = {
    network: 'near:mainnet',
    contractId: 'market.test',
    snapshot: {
      hash: 'block',
      height: 100,
      fromHeight: 10,
      maxSeconds: 600,
      fee: { fixed: '30000', bps: 100, treasuryNear: null, treasuryEvm: null },
      inventory: [],
      sponsor: 'sponsor.test',
    },
  };
  await writeFile(policyFile, JSON.stringify(policy));
  let release = await ownDirectory(stateDir);
  const progress = {
    nextHash: null,
    previousHeight: 10,
    files: [],
    transactions: [],
    receipts: [],
    totals: [],
  };
  let scans = 0;
  vi.mocked(sealLegacy).mockImplementation(async (o) => {
    scans++;
    if (scans === 1) {
      expect(await o.scanProgress?.load()).toBeNull();
      await o.scanProgress?.save(progress);
      expect((await readdir(stateDir)).filter((name) => name === 'registry')).toEqual([]);
    } else expect(await o.scanProgress?.load()).toEqual(progress);
    await o.seal?.(
      {
        policyVersion: 'legacy-v0',
        blockHash: 'block',
        blockHeight: 100,
        scannedThrough: 100,
        minPrice: '100000',
        fee: policy.snapshot.fee,
        inventory: [],
      },
      [],
    );
    return { scanned: 0, eligible: 0 };
  });
  try {
    await expect(cutover(policyFile, stateDir, 'https://archive.test')).rejects.toThrow('busy');
    expect(scans).toBe(1);
    await release();
    vi.stubEnv('CUTOVER_MAX_SECONDS', '3600');
    await cutover(policyFile, stateDir, 'https://archive.test');
    expect(scans).toBe(2);
    release = await ownDirectory(stateDir);
    expect(await readdir(join(stateDir, 'registry'))).not.toHaveLength(0);
  } finally {
    await release();
    await rm(dir, { recursive: true, force: true });
  }
});
