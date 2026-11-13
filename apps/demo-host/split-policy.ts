import { AnnonError } from '../../packages/annon/src/errors.ts';
import { createSplit, hostedSplitSalt, type Split } from '../../packages/annon/src/pay/split.ts';
import { checkProtocolFee, type ProtocolFee } from '../../packages/annon/src/relay/fees.ts';
import { BASE_USDC, type Terms } from '../../packages/annon/src/settle-near/terms.ts';

export type SplitSettings = { enabled: false } | SplitLimits;
export interface SplitLimits {
  enabled: true;
  deploymentsPerDay: number;
  sendsPerMinute: number;
  revertsPerDay: number;
  gasLimit: bigint;
  maxFeeGwei: number;
  l1FeeAllowanceWei: bigint;
  dailyBudgetWei: bigint;
  walletDailyBudgetWei: bigint;
}
/** Rebuild every factory parameter from the authenticated immutable terms. */
export function hostedSplit(terms: Terms, fee: ProtocolFee | undefined, minimum = 100000n) {
  if (
    terms.seller.kind !== 'evm' ||
    !terms.base ||
    terms.base.usdc !== BASE_USDC ||
    terms.near.recipients.some((r) => r.identity.kind !== 'evm')
  )
    throw new AnnonError('not_sponsored');
  if (BigInt(terms.near.price) < minimum || BigInt(terms.base.price) < minimum)
    throw new AnnonError('not_sponsored');
  if (!fee) throw new AnnonError('not_sponsored');
  try {
    checkProtocolFee(terms, fee);
  } catch {
    throw new AnnonError('not_sponsored');
  }
  const split: Split = {
    recipients: terms.near.recipients.map((r) => r.identity.id),
    allocations: terms.near.recipients.map((r) => BigInt(r.bps)),
    totalAllocation: 10000n,
    distributionIncentive: 0,
  };
  const call = createSplit('push', split, hostedSplitSalt());
  if (call.address !== terms.base.pay_to) throw new AnnonError('not_sponsored');
  return { call, split };
}
