/** One-time archival bootstrap, using an operator-reviewed JSON policy and inventory. */
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileStore, ownDirectory } from '@defdone/annon/pay/store-node';
import { RelayLedger, type RelayState, requestHash } from '@defdone/annon/relay';
import type { ScanCheckpoint } from './cutover-scan.ts';
import { sealLegacy } from './cutover-scan.ts';

export async function cutover(policyFile: string, stateDir: string, archivalRpc: string) {
  const policy = JSON.parse(await readFile(policyFile, 'utf8'));
  if (process.env.CUTOVER_FROM_HEIGHT)
    policy.snapshot.fromHeight = Number(process.env.CUTOVER_FROM_HEIGHT);
  if (process.env.CUTOVER_MAX_SECONDS)
    policy.snapshot.maxSeconds = Number(process.env.CUTOVER_MAX_SECONDS);
  if (!Number.isSafeInteger(policy.snapshot.fromHeight) || policy.snapshot.fromHeight < 1)
    throw new Error('CUTOVER_FROM_HEIGHT is required.');
  const checkpointDir = `${stateDir}.cutover`;
  const releaseScan = await ownDirectory(checkpointDir);
  try {
    const checkpoints = fileStore<
      import('@defdone/annon/pay/store').Versioned & { progress: ScanCheckpoint }
    >(checkpointDir);
    const { hash, height, fromHeight, fee, inventory, sponsor } = policy.snapshot;
    const checkpointId = `cutover-${requestHash({
      network: policy.network,
      contract: policy.contractId,
      hash,
      height,
      fromHeight,
      fee,
      inventory,
      sponsor,
    })}`;
    const scanProgress = {
      load: async () => (await checkpoints.load(checkpointId))?.progress ?? null,
      save: async (progress: ScanCheckpoint) => {
        const old = await checkpoints.load(checkpointId);
        if (
          !(await checkpoints.compareAndSet(checkpointId, old, {
            id: checkpointId,
            revision: (old?.revision ?? -1) + 1,
            progress,
          }))
        )
          throw new Error('Cutover checkpoint conflict.');
      },
    };
    await sealLegacy(
      {
        ...policy,
        policy: { minPrice: 100000n, maxDeadlineSeconds: 600 },
        seal: async (snapshot, decisions) => {
          const releaseState = await ownDirectory(stateDir);
          try {
            const registry = join(stateDir, 'registry');
            await mkdir(registry, { recursive: true, mode: 0o700 });
            const ledger = new RelayLedger(
              fileStore<RelayState>(registry),
              `${policy.network}|${policy.contractId}`,
            );
            await ledger.seal(snapshot, decisions);
          } finally {
            await releaseState();
          }
        },
        archivalRpc,
        scanProgress,
      },
      policy.snapshot,
    );
  } finally {
    await releaseScan();
  }
}
if (import.meta.url === `file://${process.argv[1]}`) {
  if (!process.argv[2] || !process.env.RELAYER_STATE_DIR || !process.env.NEAR_ARCHIVAL_RPC)
    throw new Error('Policy file, RELAYER_STATE_DIR and NEAR_ARCHIVAL_RPC are required.');
  await cutover(process.argv[2], process.env.RELAYER_STATE_DIR, process.env.NEAR_ARCHIVAL_RPC);
}
