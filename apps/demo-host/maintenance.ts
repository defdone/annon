import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SellerRecord } from '../../packages/annon/src/pay/settle.ts';
import type { Store } from '../../packages/annon/src/pay/store.ts';

/** Uncertain broadcasts and their id bindings are retained for reconciliation. */
export async function sweepSellerRecords(
  dir: string,
  store: Store<SellerRecord>,
  now = Date.now(),
  graceSeconds = 86400,
) {
  const records: SellerRecord[] = [];
  for (const name of await readdir(dir)) {
    if (!/^[0-9a-f]{64}\.json$/.test(name)) continue;
    records.push(JSON.parse(await readFile(join(dir, name), 'utf8')) as SellerRecord);
  }
  let removed = 0;
  for (const r of records) {
    const expiry =
      Number(r.kind === 'id' ? r.keepUntil : r.validBefore) * 1000 + graceSeconds * 1000;
    if (!Number.isFinite(expiry) || now <= expiry) continue;
    if (
      r.kind === 'purchase' &&
      (r.transaction || (r.state !== 'unpaid' && r.submissionAttempted !== false))
    )
      continue;
    if (r.kind === 'id') {
      if (!r.purchaseKey) continue;
      const purchase = await store.load(r.purchaseKey);
      if (
        purchase?.kind === 'purchase' &&
        (purchase.transaction ||
          (purchase.state !== 'unpaid' && purchase.submissionAttempted !== false))
      )
        continue;
    }
    if (await store.compareAndSet(r.id, r, null)) removed++;
  }
  return removed;
}
