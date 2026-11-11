/** Public sponsorship policy. Amounts use USDC base units, arithmetic stays integer-only. */
import { compare } from '../settle-near/codec.js';
import {
  encodeIdentity,
  type Identity,
  identityJson,
  parseIdentity,
} from '../settle-near/identity.js';
import type { NearTerms, Terms } from '../settle-near/terms.js';

export interface ProtocolFee {
  fixed: string;
  bps: number;
  treasuryNear: Identity | null;
  treasuryEvm: Identity | null;
}
export function requiredFeeBps(price: string, fee: Pick<ProtocolFee, 'fixed' | 'bps'>): number {
  if (
    !/^(0|[1-9][0-9]*)$/.test(fee.fixed) ||
    !Number.isSafeInteger(fee.bps) ||
    fee.bps < 0 ||
    fee.bps > 10000
  )
    throw new TypeError('invalid protocol fee');
  const p = BigInt(price);
  if (p <= 0n) throw new TypeError('positive price required');
  const n = (BigInt(fee.fixed) * 10000n + p * BigInt(fee.bps) + p - 1n) / p;
  if (n >= 10000n) throw new TypeError('protocol fee leaves no seller share');
  return Number(n);
}
function allocate(
  near: NearTerms,
  requests: { identity: Identity | null; bps: number }[],
): NearTerms {
  const required = new Map<string, { identity: Identity; bps: number }>();
  for (const request of requests) {
    if (!request.bps) continue;
    if (!request.identity) throw new TypeError('sponsorship treasury unavailable');
    const identity = parseIdentity(request.identity);
    const key = identityJson(identity);
    const existing = near.recipients.find((r) => identityJson(r.identity) === key)?.bps ?? 0;
    required.set(key, {
      identity,
      bps: Math.max(existing, request.bps, required.get(key)?.bps ?? 0),
    });
  }
  if (
    !required.size ||
    [...required].every(([key, r]) =>
      near.recipients.some((old) => identityJson(old.identity) === key && old.bps >= r.bps),
    )
  ) {
    const unchanged = structuredClone(near);
    const remainder = near.recipients[near.remainder];
    if (remainder && required.has(identityJson(remainder.identity))) {
      const seller = near.recipients.findIndex((r) => !required.has(identityJson(r.identity)));
      if (seller >= 0) unchanged.remainder = seller;
    }
    return unchanged;
  }
  const originalRemainder = near.recipients[near.remainder]?.identity;
  const others = near.recipients.filter((r) => !required.has(identityJson(r.identity)));
  const fixed = [...required.values()];
  const available = 10000 - fixed.reduce((n, r) => n + r.bps, 0);
  const total = others.reduce((n, r) => n + r.bps, 0);
  if (!others.length || available <= 0 || others.length + fixed.length > 8)
    throw new TypeError('fee requires seller share and one of eight recipient slots');
  const recipients = others.map((r) => ({ ...r, bps: Math.floor((r.bps * available) / total) }));
  recipients.push(...fixed);
  const rounding =
    recipients.find(
      (r) =>
        originalRemainder &&
        !required.has(identityJson(r.identity)) &&
        identityJson(r.identity) === identityJson(originalRemainder),
    ) ?? recipients[0];
  if (!rounding) throw new TypeError('seller recipient required');
  rounding.bps += 10000 - recipients.reduce((n, r) => n + r.bps, 0);
  if (recipients.some((r) => r.bps <= 0)) throw new TypeError('fee rounds a recipient to zero');
  recipients.sort((a, b) => compare(encodeIdentity(a.identity), encodeIdentity(b.identity)));
  return { ...near, recipients, remainder: recipients.indexOf(rounding) };
}
export function applyProtocolFee(
  near: NearTerms,
  fee: ProtocolFee,
  base: boolean,
  price = near.price,
): NearTerms {
  if (base && requiredFeeBps(price, fee) && fee.treasuryEvm?.kind !== 'evm')
    throw new TypeError('EVM treasury required');
  return allocate(near, [
    {
      identity: base ? fee.treasuryEvm : (fee.treasuryNear ?? fee.treasuryEvm),
      bps: requiredFeeBps(price, fee),
    },
  ]);
}
/** Base terms use one EVM treasury share satisfying the larger route requirement. */
export function applySponsoredFee(
  near: NearTerms,
  fee: ProtocolFee,
  basePrice?: string,
): NearTerms {
  if (basePrice && fee.treasuryEvm?.kind !== 'evm') throw new TypeError('EVM treasury required');
  return allocate(near, [
    {
      identity: basePrice ? fee.treasuryEvm : (fee.treasuryNear ?? fee.treasuryEvm),
      bps: Math.max(
        requiredFeeBps(near.price, fee),
        basePrice ? requiredFeeBps(basePrice, fee) : 0,
      ),
    },
  ]);
}
export const DEFAULT_MAX_PROTOCOL_FEE = Object.freeze({ fixed: '30000', bps: 100 });
export function protocolFeeAboveMax(
  price: string,
  fee: Pick<ProtocolFee, 'fixed' | 'bps'>,
  max: Pick<ProtocolFee, 'fixed' | 'bps'> = DEFAULT_MAX_PROTOCOL_FEE,
): boolean {
  for (const value of [fee, max]) {
    if (
      !/^(0|[1-9][0-9]*)$/.test(value.fixed) ||
      !Number.isSafeInteger(value.bps) ||
      value.bps < 0 ||
      value.bps > 10000
    )
      throw new TypeError('invalid protocol fee');
  }
  const p = BigInt(price);
  if (p <= 0n) throw new TypeError('positive price required');
  return (
    BigInt(fee.fixed) * 10000n + p * BigInt(fee.bps) >
    BigInt(max.fixed) * 10000n + p * BigInt(max.bps)
  );
}
export function checkProtocolFee(terms: Terms, fee: ProtocolFee): void {
  const check = (price: string, treasury: Identity | null) => {
    const required = requiredFeeBps(price, fee);
    if (!required) return;
    if (
      !treasury ||
      !terms.near.recipients.some(
        (r) => identityJson(r.identity) === identityJson(treasury) && r.bps >= required,
      )
    )
      throw new TypeError('required treasury share missing');
  };
  check(terms.near.price, terms.base ? fee.treasuryEvm : (fee.treasuryNear ?? fee.treasuryEvm));
  if (terms.base) {
    if (fee.treasuryEvm?.kind !== 'evm' && requiredFeeBps(terms.base.price, fee))
      throw new TypeError('EVM treasury required');
    check(terms.base.price, fee.treasuryEvm);
  }
}
