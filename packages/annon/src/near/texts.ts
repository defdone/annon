import { utc } from '../settle-near/codec.js';

export { usdc, utc } from '../settle-near/codec.js';

/** Authoritative contract arguments and texts (near-settlement §§3,9). */
import { type Identity, identityText } from '../settle-near/identity.js';
import { buyerKey, type ReopenV2, reopenTextV2 } from '../settle-near/purchase.js';
import { registerTextV2, type SettlementAssets, type Terms } from '../settle-near/terms.js';

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

export function registerText(
  contractId: string,
  a: RegisterArgs,
  assets?: SettlementAssets,
): string {
  if (contractId !== a.terms.contract) throw new TypeError('terms contract mismatch');
  buyerKey(a.seller_key);
  return registerTextV2(a.terms, a.seller_key, a.deadline, assets);
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
