import { randomUUID } from 'node:crypto';
import type { Store } from '../pay/store.js';
import { AdapterError } from './errors.js';

export interface PurchaseGuard {
  id: string;
  revision: number;
  owner: string | null;
  until: number;
  purchases: string[];
}
const refused = () =>
  new AdapterError(
    'purchase_open',
    'A saved purchase already exists for this file. Resume it, or explicitly use --force for another purchase.',
    2,
  );
/** Reserve before confirmation and signing; checkpoints renew the in-progress claim. */
export async function claimPurchase(
  store: Store<PurchaseGuard>,
  key: string,
  o: {
    known?: readonly string[];
    force?: boolean;
    now?: () => number;
    live: (purchaseId: string, claimUntil: number) => Promise<boolean>;
  },
) {
  const now = o.now ?? (() => Math.floor(Date.now() / 1000));
  const owner = randomUUID();
  let held: PurchaseGuard;
  for (;;) {
    const before = await store.load(key);
    if (before?.owner && before.until > now()) throw refused();
    const purchases = Array.from(new Set([...(before?.purchases ?? []), ...(o.known ?? [])]));
    if (!o.force)
      for (const id of purchases) if (await o.live(id, before?.until ?? 0)) throw refused();
    const next = {
      id: key,
      revision: (before?.revision ?? -1) + 1,
      owner,
      until: now() + 120,
      purchases,
    };
    if (await store.compareAndSet(key, before, next)) {
      held = next;
      break;
    }
  }
  let queue = Promise.resolve();
  const update = (patch: () => Partial<PurchaseGuard>) => {
    const pending = queue.then(async () => {
      const next = {
        ...held,
        revision: held.revision + 1,
        ...patch(),
      };
      if (!(await store.compareAndSet(key, held, next)))
        throw new AdapterError(
          'store_conflict',
          'The purchase reservation changed. Resume saved state.',
          4,
        );
      held = next;
    });
    queue = pending.catch(() => {});
    return pending;
  };
  return {
    renew: () => update(() => ({ until: Math.max(held.until, now() + 120) })),
    saved: (purchaseId: string) =>
      update(() => ({
        until: Math.max(held.until, now() + 120),
        purchases: Array.from(new Set([...held.purchases, purchaseId])),
      })),
    release: () => update(() => ({ owner: null })),
  };
}
