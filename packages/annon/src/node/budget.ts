import type { Store, Versioned } from '../pay/store.js';
export class BudgetError extends Error {
  readonly code = 'budget_exceeded';
}
export interface BudgetRecord extends Versioned {
  day: number;
  hour: number;
  daily: string;
  hourly: string;
}
/** Conservative reservations are never refunded on ambiguous submissions. UTC windows. */
export async function reserveSpend(
  store: Store<BudgetRecord>,
  scope: string,
  amount: bigint,
  limits: { daily: bigint; hourly?: bigint },
  now = Date.now(),
): Promise<void> {
  if (amount < 0n || limits.daily < 0n || (limits.hourly !== undefined && limits.hourly < 0n))
    throw new TypeError('invalid spend limit');
  const day = Math.floor(now / 86400000),
    hour = Math.floor(now / 3600000);
  for (;;) {
    const old = await store.load(scope);
    if (old && (old.day > day || old.hour > hour))
      throw new BudgetError('Clock moved backwards; spending is paused.');
    const daily = BigInt(old?.day === day ? old.daily : '0') + amount;
    const hourly = BigInt(old?.hour === hour ? old.hourly : '0') + amount;
    if (daily > limits.daily || (limits.hourly !== undefined && hourly > limits.hourly))
      throw new BudgetError('The persisted spending budget is exhausted.');
    if (
      await store.compareAndSet(scope, old, {
        id: scope,
        revision: (old?.revision ?? -1) + 1,
        day,
        hour,
        daily: String(daily),
        hourly: String(hourly),
      })
    )
      return;
  }
}
