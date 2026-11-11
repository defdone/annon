import type { Store, Versioned } from '../pay/store.js';
export class BudgetError extends Error {
  readonly code = 'budget_exceeded';
}
export interface BudgetRecord extends Versioned {
  day: number;
  hour: number;
  daily: string;
  hourly: string;
  reconciled?: string[];
}
/** Reserve in UTC windows; refund once after a definite refusal or retain verified final spend. */
export async function reserveSpend(
  store: Store<BudgetRecord>,
  scope: string,
  amount: bigint,
  limits: { daily: bigint; hourly?: bigint },
  now = Date.now(),
  reservationId?: string,
): Promise<(retained?: bigint) => Promise<void>> {
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
        ...(old?.day === day && old.reconciled ? { reconciled: old.reconciled } : {}),
      })
    )
      break;
  }
  let released: Promise<void> | undefined;
  return (retained = 0n) =>
    (released ??= reconcileSpend(
      store,
      scope,
      { amount: String(amount), at: now, ...(reservationId ? { id: reservationId } : {}) },
      retained,
    ));
}
export interface SpendReservation {
  id?: string;
  amount: string;
  at: number;
}
/** Idempotent across keeper restarts; old UTC windows are never refunded into new ones. */
export async function reconcileSpend(
  store: Store<BudgetRecord>,
  scope: string,
  reservation: SpendReservation,
  retained: bigint,
): Promise<void> {
  const amount = BigInt(reservation.amount);
  if (retained < 0n) throw new TypeError('invalid retained spend');
  const refund = amount > retained ? amount - retained : 0n;
  const day = Math.floor(reservation.at / 86400000),
    hour = Math.floor(reservation.at / 3600000);
  for (;;) {
    const old = await store.load(scope);
    if (!old || old.day !== day || (reservation.id && old.reconciled?.includes(reservation.id)))
      return;
    const daily = BigInt(old.daily) - refund;
    const hourly = BigInt(old.hourly) - (old.hour === hour ? refund : 0n);
    if (daily < 0n || hourly < 0n) throw new Error('invalid budget refund');
    if (
      await store.compareAndSet(scope, old, {
        ...old,
        revision: old.revision + 1,
        daily: String(daily),
        hourly: String(hourly),
        ...(reservation.id ? { reconciled: [...(old.reconciled ?? []), reservation.id] } : {}),
      })
    )
      return;
  }
}
