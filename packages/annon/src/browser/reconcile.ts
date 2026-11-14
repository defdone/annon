/**
 * Check a failed browser purchase again. It keeps the saved purchase, its 1Click deposit and its
 * recovery identity, and it never creates, starts or pays: it reads NEAR acceptance and, for 1Click,
 * the existing deposit's status once.
 */
import {
  OneClick,
  type OneClickQuote,
  type PollCheckpoint,
  type SwapStatus,
} from '../oneclick/oneclick.js';
import type { PurchaseRecord } from '../pay/purchase.js';
import type { BrowserPurchaseRecord, BrowserPurchaseState } from './record.js';

export interface ReconcileOptions {
  /** Only the single status read is used; tests and custom endpoints pass their own client. */
  oneClick?: Pick<OneClick, 'status'>;
  signal?: AbortSignal;
}
export interface ReconcileResult {
  state: BrowserPurchaseState;
  /** The 1Click status read by this check, when there was one. */
  swapStatus?: SwapStatus['status'];
}
export interface ReconcileSession {
  record: BrowserPurchaseRecord;
  change(patch: Partial<BrowserPurchaseRecord>): Promise<BrowserPurchaseRecord>;
}
export interface ReconcileDeps {
  accept(record: PurchaseRecord): Promise<boolean>;
  restorePurchase(record: PurchaseRecord): Promise<PurchaseRecord>;
}

/** Throws unless the record is a failed purchase with a saved commitment. */
export function checkReconcilable(record: BrowserPurchaseRecord): PurchaseRecord {
  if (record.state !== 'failed' || !record.purchase)
    throw new Error('only a failed saved purchase can be checked again');
  return record.purchase;
}

const depositOf = (record: PurchaseRecord | undefined) =>
  (record?.quote as OneClickQuote | null | undefined)?.deposit;

/**
 * A 1Click check must read the deposit this purchase was saved with. The restored purchase may be a
 * newer revision of the same commitment, but its deposit address and memo, and those of any saved
 * polling checkpoint, must be the saved ones. Anything else is refused before any read or write.
 */
export function checkSameDeposit(saved: BrowserPurchaseRecord, restored: PurchaseRecord): void {
  if (saved.route !== '1click') return;
  const expected = depositOf(saved.purchase);
  const actual = depositOf(restored);
  const point = saved.checkpoint;
  if (
    expected?.address !== actual?.address ||
    expected?.memo !== actual?.memo ||
    (point && (point.address !== expected?.address || point.memo !== expected?.memo))
  )
    throw new Error('saved purchase changed deposit; check it with support');
}

const settled: Partial<Record<SwapStatus['status'], BrowserPurchaseState>> = {
  SUCCESS: 'accepting',
  REFUNDED: 'refunded',
};

function nextCheckpoint(
  previous: PollCheckpoint | undefined,
  address: string,
  memo: string | undefined,
  status: SwapStatus,
): PollCheckpoint {
  const base =
    previous && previous.address === address && previous.memo === memo
      ? previous
      : { address, ...(memo === undefined ? {} : { memo }), attempts: 0, errors: 0 };
  const { nextPollAt: _wait, ...kept } = base;
  return { ...kept, attempts: kept.attempts + 1, errors: 0, lastStatus: status };
}

/** Runs inside the purchase lease. A failed read leaves the saved state and checkpoint as they were. */
export async function reconcileFailed(
  session: ReconcileSession,
  deps: ReconcileDeps,
  options: ReconcileOptions = {},
): Promise<ReconcileResult> {
  let saved = session.record;
  const restored = await deps.restorePurchase(checkReconcilable(saved));
  if (restored.id !== saved.purchase?.id) throw new Error('saved purchase changed identity');
  checkSameDeposit(saved, restored);
  if (JSON.stringify(restored) !== JSON.stringify(saved.purchase))
    saved = await session.change({ purchase: restored });
  if (await deps.accept(restored)) {
    saved = await session.change({ state: 'accepted' });
    return { state: saved.state };
  }
  const deposit = depositOf(restored);
  if (saved.route !== '1click' || !deposit) return { state: saved.state };
  const status = await (options.oneClick ?? new OneClick()).status(deposit.address, {
    ...(deposit.memo === undefined ? {} : { memo: deposit.memo }),
    ...(options.signal ? { signal: options.signal } : {}),
  });
  saved = await session.change({
    checkpoint: nextCheckpoint(saved.checkpoint, deposit.address, deposit.memo, status),
    state: settled[status.status] ?? 'failed',
  });
  return { state: saved.state, swapStatus: status.status };
}
