/** Authoritative contract arguments and texts (near-settlement §§3,9). */
import { type Identity, identityText } from '../settle-near/identity.js';
import { buyerKey, type ReopenV2, reopenTextV2 } from '../settle-near/purchase.js';
import { registerTextV2, type Terms } from '../settle-near/terms.js';

export interface RegisterArgs {
  terms: Terms;
  seller_key: string;
  deadline: number;
}
export interface ReopenArgs {
  purchase_id: string;
  fresh_key: string;
  nonce: string;
  deadline: number;
}
export interface SellerArgs {
  file_id: string;
  key: string | null;
  deadline: number;
}
export type StopSalesArgs = SellerArgs;
/** The contract's `hex0x(bytes::<N>(s))`: optional lowercase `0x`, any case, printed lowercase. */
export function hex0x(s: string, bytes: number, name: string): string {
  const h = s.startsWith('0x') ? s.slice(2) : s;
  if (!new RegExp(`^[0-9a-fA-F]{${2 * bytes}}$`).test(h)) {
    throw new TypeError(`${name} must be ${bytes} bytes of hex`);
  }
  return `0x${h.toLowerCase()}`;
}

/** USDC base units as a person reads them: `10000` is `0.01`, `1000000` is `1`. */
export function usdc(units: string | bigint): string {
  const u = BigInt(units);
  if (u < 0n || u >= 2n ** 128n) throw new RangeError('price is a u128');
  const whole = u / 1_000_000n;
  const part = u % 1_000_000n;
  if (part === 0n) return whole.toString();
  return `${whole}.${part.toString().padStart(6, '0').replace(/0+$/, '')}`;
}

/** Unix seconds as `YYYY-MM-DD HH:MM:SS UTC`. */
export function utc(secs: number): string {
  // ponytail: Date covers years up to 9999; the SDK only signs deadlines minutes ahead.
  if (!Number.isSafeInteger(secs) || secs < 0 || secs > 253_402_300_799) {
    throw new RangeError('deadline out of range');
  }
  return `${new Date(secs * 1000).toISOString().slice(0, 19).replace('T', ' ')} UTC`;
}

export function registerText(contractId: string, a: RegisterArgs): string {
  if (contractId !== a.terms.contract) throw new TypeError('terms contract mismatch');
  buyerKey(a.seller_key);
  return registerTextV2(a.terms, a.seller_key, a.deadline);
}
export const reopenText = (a: ReopenV2): string => reopenTextV2(a);
export function reopenSellerText(contract: string, a: SellerArgs, seller: Identity): string {
  buyerKey(a.key ?? '');
  return [
    'Annon: open a file again',
    'Signing this lets whoever holds the one-time key below open the file.',
    `contract: ${contract}`,
    `file: ${hex0x(a.file_id, 32, 'file_id')}`,
    `seller: ${identityText(seller)}`,
    `one-time key: ${a.key}`,
    `valid until: ${utc(a.deadline)}`,
  ].join('\n');
}
export function stopSalesText(contract: string, a: SellerArgs, seller: Identity): string {
  return [
    'Annon: stop selling a file',
    "Signing this is final: the file can't be sold again. Past buyers keep access.",
    `contract: ${contract}`,
    `file: ${hex0x(a.file_id, 32, 'file_id')}`,
    `seller: ${identityText(seller)}`,
    `valid until: ${utc(a.deadline)}`,
  ].join('\n');
}
