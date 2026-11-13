import { termsHash } from '@defdone/annon';
/** Read-only archival inventory. Never infer historical existence from current state. */
import { getFile, rpcReply } from '@defdone/annon/near/rpc';

import { readSplitState } from '@defdone/annon/pay/split';
import { checkProtocolFee, RelayError, ZERO_FEE } from '@defdone/annon/relay';

function withinDeadline(deadline: number) {
  return async <T>(work: Promise<T>): Promise<T> => {
    if (Date.now() >= deadline) throw new Error('Cutover scan time limit reached.');
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        work,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('Cutover scan time limit reached.')),
            Math.max(0, deadline - Date.now()),
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
}

export interface ScanCheckpoint {
  nextHash: string | null;
  previousHeight: number;
  files: string[];
  transactions: string[];
  receipts: string[];
  totals: [string, string][];
}
export interface ScanProgress {
  load(): Promise<ScanCheckpoint | null>;
  save(state: ScanCheckpoint): Promise<void>;
}

export async function scanRegistrations(
  url: string,
  contract: string,
  cutover: { hash: string; height: number; fromHeight: number; maxSeconds?: number },
  rpc: typeof rpcReply = rpcReply,
  funding?: { funder: string; totals: Map<string, bigint> },
  progress?: ScanProgress,
): Promise<string[]> {
  if (
    !Number.isSafeInteger(cutover.fromHeight) ||
    cutover.fromHeight < 0 ||
    cutover.fromHeight > cutover.height ||
    !Number.isSafeInteger(cutover.height)
  )
    throw new Error('Verified CUTOVER_FROM_HEIGHT is required.');
  const maxSeconds = cutover.maxSeconds ?? 600;
  if (!Number.isSafeInteger(maxSeconds) || maxSeconds < 1 || maxSeconds > 3600)
    throw new Error('Cutover time limit is invalid.');
  const bounded = withinDeadline(Date.now() + maxSeconds * 1000);
  const files = new Set<string>(),
    transactions = new Set<string>(),
    receipts = new Set<string>(),
    heights = new Map<string, number>();
  const read = async (method: string, params: object) => {
    const r = await bounded(rpc(url, method, params));
    if (r.error || !r.result || typeof r.result !== 'object')
      throw new Error('Archival history is incomplete.');
    return r.result as Record<string, unknown>;
  };
  const block = async (hash: string) => {
    const r = await read('block', { block_id: hash });
    const h = r.header as { hash?: string; height?: number; prev_hash?: string };
    if (
      h?.hash !== hash ||
      typeof h.height !== 'number' ||
      !Number.isSafeInteger(h.height) ||
      h.height < 0
    )
      throw new Error('Archival block is invalid.');
    heights.set(hash, h.height);
    return { header: { ...h, height: h.height }, chunks: r.chunks as { chunk_hash: string }[] };
  };
  // The lower bound must be the account creation block, not an arbitrary recent height.
  if (cutover.fromHeight > 0) {
    const absent = await bounded(
      rpc(url, 'query', {
        request_type: 'view_account',
        account_id: contract,
        block_id: cutover.fromHeight - 1,
      }),
    );
    if (absent.error?.cause?.name !== 'UNKNOWN_ACCOUNT')
      throw new Error('CUTOVER_FROM_HEIGHT must prove account creation.');
    await read('query', {
      request_type: 'view_account',
      account_id: contract,
      block_id: cutover.fromHeight,
    });
  }
  const saved = await progress?.load();
  for (const id of saved?.files ?? []) files.add(id);
  for (const id of saved?.transactions ?? []) transactions.add(id);
  for (const id of saved?.receipts ?? []) receipts.add(id);
  for (const [id, value] of saved?.totals ?? []) funding?.totals.set(id, BigInt(value));
  let hash: string | null = saved ? saved.nextHash : cutover.hash,
    previousHeight = saved?.previousHeight ?? cutover.height + 1;
  const checkpoint = () =>
    progress?.save({
      nextHash: hash,
      previousHeight,
      files: [...files],
      transactions: [...transactions],
      receipts: [...receipts],
      totals: [...(funding?.totals ?? [])].map(([id, amount]) => [id, String(amount)]),
    });
  while (hash !== null) {
    const b = await block(hash);
    const height = b.header.height;
    if (
      height >= previousHeight ||
      (hash === cutover.hash && height !== cutover.height) ||
      !Array.isArray(b.chunks)
    )
      throw new Error('Archival block chain is incomplete.');
    previousHeight = height;
    for (const chunk of b.chunks) {
      if (typeof chunk.chunk_hash !== 'string') throw new Error('Archival chunk is invalid.');
      const c = await read('chunk', { chunk_id: chunk.chunk_hash });
      const txs = c.transactions as { hash: string; signer_id: string; receiver_id: string }[];
      if (!Array.isArray(txs)) throw new Error('Archival transactions are missing.');
      for (const tx of txs) {
        if (typeof tx.hash !== 'string' || typeof tx.signer_id !== 'string')
          throw new Error('Archival transaction is invalid.');
        if (tx.receiver_id !== contract) continue;
        if (transactions.has(tx.hash)) continue;
        transactions.add(tx.hash);
        const status = await read('EXPERIMENTAL_tx_status', {
          tx_hash: tx.hash,
          sender_account_id: tx.signer_id,
          wait_until: 'FINAL',
        });
        if (status.final_execution_status !== 'FINAL' || !Array.isArray(status.receipts_outcome))
          throw new Error('Archival outcome is incomplete.');
        for (const entry of status.receipts_outcome) {
          const receipt = entry as {
            id?: string;
            block_hash: string;
            outcome: { executor_id: string; status: object; logs: string[] };
          };
          if (
            receipt.outcome?.executor_id !== contract ||
            !receipt.outcome.status ||
            'Failure' in receipt.outcome.status
          )
            continue;
          if (
            !(
              'SuccessValue' in receipt.outcome.status ||
              'SuccessReceiptId' in receipt.outcome.status
            ) ||
            !Array.isArray(receipt.outcome.logs)
          )
            throw new Error('Archival receipt is invalid.');
          const receiptHeight =
            heights.get(receipt.block_hash) ?? (await block(receipt.block_hash)).header.height;
          if (receiptHeight > cutover.height || receiptHeight < cutover.fromHeight) continue;
          const receiptKey = receipt.id ?? `${tx.hash}|${status.receipts_outcome.indexOf(entry)}`;
          if (receipts.has(receiptKey)) continue;
          receipts.add(receiptKey);
          for (const log of receipt.outcome.logs) {
            if (!log.startsWith('EVENT_JSON:')) continue;
            const event = JSON.parse(log.slice('EVENT_JSON:'.length));
            if (
              event.standard !== 'annon' ||
              event.version !== '2.0.0' ||
              !['file_registered', 'file_storage_funded'].includes(event.event)
            )
              continue;
            if (!Array.isArray(event.data)) throw new Error('Registration event is invalid.');
            for (const item of event.data) {
              if (typeof item.file_id !== 'string' || !/^0x[0-9a-f]{64}$/.test(item.file_id))
                throw new Error('Registration event is invalid.');
              if (event.event === 'file_registered') files.add(item.file_id);
              else if (funding && item.funder === funding.funder) {
                if (typeof item.amount !== 'string' || !/^(0|[1-9][0-9]*)$/.test(item.amount))
                  throw new Error('Funding event is invalid.');
                funding.totals.set(
                  item.file_id,
                  (funding.totals.get(item.file_id) ?? 0n) + BigInt(item.amount),
                );
              }
            }
          }
        }
      }
    }
    if (height < cutover.fromHeight) throw new Error('Archival creation bound is invalid.');
    if (height === cutover.fromHeight) hash = null;
    else {
      if (!b.header.prev_hash || b.header.prev_hash === hash)
        throw new Error('Archival block chain is incomplete.');
      hash = b.header.prev_hash;
    }
    await checkpoint();
  }
  return [...files].sort();
}

/** Seal only a complete historical scan and an explicit prior-policy snapshot. */
export async function sealLegacy(
  o: import('@defdone/annon/relay').CheckOptions & {
    ledger?: import('@defdone/annon/relay').RelayLedger;
    seal?: import('@defdone/annon/relay').RelayLedger['seal'];
    archivalRpc: string;
    scanProgress?: ScanProgress;
  },
  snapshot: {
    hash: string;
    height: number;
    fromHeight: number;
    maxSeconds?: number;
    fee: import('@defdone/annon/relay').ProtocolFee;
    inventory: string[];
    sponsor: string;
  },
  rpc: typeof rpcReply = rpcReply,
  splitReader: typeof import('@defdone/annon/pay/split').readSplitState = readSplitState,
  fileReader: typeof getFile = getFile,
): Promise<{ scanned: number; eligible: number }> {
  if (
    snapshot.fee.fixed !== '30000' ||
    snapshot.fee.bps !== 100 ||
    !o.archivalRpc ||
    !snapshot.sponsor
  )
    throw new Error('Explicit prior policy is required.');
  const maxSeconds = snapshot.maxSeconds ?? 600;
  if (!Number.isSafeInteger(maxSeconds) || maxSeconds < 1 || maxSeconds > 3600)
    throw new Error('Cutover time limit is invalid.');
  const deadline = Date.now() + maxSeconds * 1000;
  const bounded = withinDeadline(deadline);
  if (await o.ledger?.cutover()) throw new Error('Cutover is already sealed.');
  const final = await bounded(rpc(o.archivalRpc, 'block', { finality: 'final' }));
  const finalHeader = (final.result as { header?: { height?: number } })?.header;
  if (
    final.error ||
    !Number.isSafeInteger(finalHeader?.height) ||
    (finalHeader?.height ?? -1) < snapshot.height
  )
    throw new Error('Cutover is not finalized.');
  const canonical = await bounded(rpc(o.archivalRpc, 'block', { block_id: snapshot.height }));
  if (
    canonical.error ||
    (canonical.result as { header?: { hash?: string } })?.header?.hash !== snapshot.hash
  )
    throw new Error('Cutover is not canonical.');
  const totals = new Map<string, bigint>();
  const files = await scanRegistrations(
    o.archivalRpc,
    o.contractId,
    { ...snapshot, maxSeconds: Math.max(1, Math.floor((deadline - Date.now()) / 1000)) },
    rpc,
    {
      funder: snapshot.sponsor,
      totals,
    },
    o.scanProgress,
  );
  if (snapshot.inventory.some((id) => !files.includes(id)))
    throw new Error('Inventory is absent from historical events.');
  const decisions: import('@defdone/annon/relay').SponsorshipDecision[] = [];
  for (const id of files) {
    const file = await bounded(fileReader(o.archivalRpc, o.contractId, id, snapshot.hash));
    if (!file) throw new Error('Historical registration is missing.');
    if (
      file.terms.network !== (o.network ?? 'near:mainnet') ||
      file.termsHash !==
        termsHash(file.terms, { ...(o.nearUsdc ? { nearUsdc: o.nearUsdc } : {}), baseUsdc: o.usdc })
    )
      throw new Error('Historical deployment mismatch.');
    const inventory = snapshot.inventory.includes(id);
    try {
      if (
        BigInt(file.terms.near.price) < 100000n ||
        (file.terms.base && BigInt(file.terms.base.price) < 100000n)
      )
        throw new RelayError('not_sponsored');
      if (!inventory) {
        try {
          checkProtocolFee(file.terms, snapshot.fee);
        } catch {
          throw new RelayError('not_sponsored');
        }
      }
      if (file.terms.base) {
        if (file.terms.near.recipients.some((r) => r.identity.kind !== 'evm'))
          throw new RelayError('not_sponsored');
        try {
          await bounded(
            splitReader(o.baseRpc, file.terms.base.pay_to, {
              recipients: file.terms.near.recipients.map((r) => r.identity.id),
              allocations: file.terms.near.recipients.map((r) => BigInt(r.bps)),
              totalAllocation: 10000n,
              distributionIncentive: 0,
            }),
          );
        } catch (e) {
          if ((e as { code?: string })?.code === 'bad_requirements')
            throw new RelayError('not_sponsored');
          throw e;
        }
      }
      decisions.push({
        network: file.terms.network,
        contract: o.contractId,
        fileId: id,
        termsHash: file.termsHash,
        terms: file.terms,
        eligible: true,
        tier: 'legacy',
        listed: inventory,
        policyVersion: 'legacy-v0',
        minPrice: '100000',
        fee: inventory ? structuredClone(ZERO_FEE) : snapshot.fee,
        decidedAt: o.now ?? Math.floor(Date.now() / 1000),
        allocated: totals.has(id) ? String(totals.get(id)) : null,
        outcome: 'registered',
      });
    } catch (e) {
      if (!(e instanceof RelayError && e.code === 'not_sponsored') || inventory) throw e;
    }
  }
  const seal = o.seal ?? o.ledger?.seal.bind(o.ledger);
  if (!seal) throw new Error('Cutover seal is unavailable.');
  await seal(
    {
      policyVersion: 'legacy-v0',
      blockHash: snapshot.hash,
      blockHeight: snapshot.height,
      scannedThrough: snapshot.height,
      minPrice: '100000',
      fee: snapshot.fee,
      inventory: snapshot.inventory,
    },
    decisions,
  );
  return { scanned: files.length, eligible: decisions.length };
}
