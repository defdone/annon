/**
 * Sale terms a seller approves in a terminal, as short lines in place of the JSON object that
 * `--json` and pipes keep. Amounts come in base units: USDC has 6 decimals, NEAR 24.
 */

import { localTime } from '../../browser/login-format.js';
import type { ProtocolFee } from '../../relay/fees.js';
import { usdc } from '../../settle-near/codec.js';
import { type Identity, identityText } from '../../settle-near/identity.js';
import { cleanText, short } from './text.js';

/** The contract's per-sale storage numbers (contracts/annon/src/receive.rs, economics tests). */
const BYTE_COST = 10n ** 19n;
const SALE_ADMISSION_BYTES = 4096n;
const SALE_BYTES = 854n;

/** Sales a purchase storage budget covers: the first needs 4096 free bytes, each uses about 854. */
export function salesCovered(budget: bigint): bigint {
  const bytes = budget / BYTE_COST;
  return bytes < SALE_ADMISSION_BYTES ? 0n : 1n + (bytes - SALE_ADMISSION_BYTES) / SALE_BYTES;
}

/** USDC base units with at least two decimals, e.g. `0.10`. */
export function usdcText(units: string | bigint): string {
  const [whole, fraction = ''] = usdc(units).split('.');
  return `${whole}.${fraction.padEnd(2, '0')}`;
}

/** yoctoNEAR as a plain NEAR amount, e.g. `0.05`. */
export function nearText(yocto: string | bigint): string {
  const n = BigInt(yocto);
  const fraction = (n % 10n ** 24n).toString().padStart(24, '0').replace(/0+$/, '');
  return `${n / 10n ** 24n}${fraction ? `.${fraction}` : ''}`;
}

const percent = (bps: number) => `${bps / 100}%`;

/** An identity as a person reads it: the account name, or the address shortened when long. */
export function identityName(identity: Identity): string {
  let id = identity.id;
  if (identity.kind === 'solana') {
    try {
      id = identityText(identity).slice('Solana '.length);
    } catch {}
  }
  // A named NEAR account reads whole; addresses and implicit accounts are shortened.
  return identity.kind === 'near' && id.includes('.') ? cleanText(id) : short(cleanText(id));
}

/** `evm:0xe8cce8cc...d86d`: the kind and the readable name. */
export const identityLabel = (identity: Identity) => `${identity.kind}:${identityName(identity)}`;

type Split = { recipients: { identity: Identity; bps: number }[] };
const same = (a: Identity, b: Identity | null) => !!b && a.kind === b.kind && a.id === b.id;

export const splitText = (split: Split) =>
  split.recipients.map((r) => `${identityName(r.identity)} ${percent(r.bps)}`).join(', ');

/** `none`, or the advertised fee and the treasury's share of the split. */
export function feeText(fee: ProtocolFee | null | undefined, split: Split): string {
  if (!fee) return 'none';
  const asked = `${usdcText(fee.fixed)} USDC + ${percent(fee.bps)}`;
  const treasury = split.recipients.find(
    (r) => same(r.identity, fee.treasuryNear) || same(r.identity, fee.treasuryEvm),
  );
  return treasury
    ? `${asked}, treasury ${identityName(treasury.identity)} gets ${percent(treasury.bps)}`
    : asked;
}

export const purchaseStorageText = (yocto: string) =>
  `${nearText(yocto)} NEAR (covers about ${salesCovered(BigInt(yocto))} sales)`;

/** The terms object `share` builds before its approval prompt. */
export interface ShareTerms {
  seller: Identity;
  host: string;
  contract: string;
  price: string;
  split: Split;
  fee: ProtocolFee | null;
  listingStorage: string | null;
  purchaseStorage: string | null;
  registerDeposit: string;
}

export function shareTermsText(t: ShareTerms): string {
  return [
    `Seller: ${identityName(t.seller)}`,
    `Host: ${cleanText(t.host)}`,
    `Contract: ${cleanText(t.contract)}`,
    `Price: ${usdcText(t.price)} USDC`,
    `Split: ${splitText(t.split)}`,
    `Fee: ${feeText(t.fee, t.split)}`,
    ...(t.listingStorage === null ? [] : [`Listing storage: ${nearText(t.listingStorage)} NEAR`]),
    ...(t.purchaseStorage === null
      ? []
      : [`Purchase storage: ${purchaseStorageText(t.purchaseStorage)}`]),
    ...(BigInt(t.registerDeposit) > 0n
      ? [`Register deposit: ${nearText(t.registerDeposit)} NEAR`]
      : []),
  ].join('\n');
}

/** The split a sponsored `sell` registers, with its fee. */
export function sellSplitText(split: Split, fee: ProtocolFee | undefined, aboveMaximum: boolean) {
  return [
    `Split: ${splitText(split)}`,
    `Fee: ${feeText(fee, split)}${aboveMaximum ? ' (above your maxProtocolFee)' : ''}`,
  ].join('\n');
}

/** A hosting expiry in Unix seconds: local date and time with the raw value, or no expiry. */
export const hostingExpiry = (seconds: number | null) =>
  seconds === null ? 'no expiry' : `${localTime(seconds * 1000)} (${seconds})`;
