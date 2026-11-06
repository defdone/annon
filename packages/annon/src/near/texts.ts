/**
 * The exact texts the Annon contract asks wallets to sign (EIP-191). The client builds them
 * itself, from its own values, so a page or a relayer can't slip a different text in front of the
 * wallet. `specs/vectors/texts.json`, written by the contract's own tests, keeps both in step.
 */

export interface RegisterArgs {
  file_id: string;
  seller: string;
  /** USDC base units (6 decimals), as the contract's `U128`: a decimal string. */
  price: string;
  /** Where buyers pay: the seller's wallet, a platform's, or e.g. an immutable revenue split. */
  pay_to: string;
  cipher_hash: string;
  moderator: string | null;
  /** The seller's one-time G1 key, 48 bytes hex. */
  seller_key: string;
  /** Unix seconds. */
  deadline: number;
}

export interface ReopenArgs {
  file_id: string;
  wallet: string;
  key: string;
  deadline: number;
}

export interface StopSalesArgs {
  file_id: string;
  deadline: number;
}

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
  return [
    'Annon: list a file for sale',
    'Signing this lets whoever holds the seller key below open the file.',
    `contract: ${contractId}`,
    `file: ${hex0x(a.file_id, 32, 'file_id')}`,
    `seller: ${hex0x(a.seller, 20, 'seller')}`,
    `price: ${usdc(a.price)} USDC`,
    `pay to: ${hex0x(a.pay_to, 20, 'pay_to')}`,
    `cipher: ${hex0x(a.cipher_hash, 32, 'cipher_hash')}`,
    `moderator: ${a.moderator ?? '(none)'}`,
    `seller key: ${hex0x(a.seller_key, 48, 'seller_key')}`,
    `valid until: ${utc(a.deadline)}`,
  ].join('\n');
}

export function reopenText(contractId: string, a: ReopenArgs): string {
  return [
    'Annon: open a file again',
    'Signing this lets whoever holds the one-time key below open the file.',
    `contract: ${contractId}`,
    `file: ${hex0x(a.file_id, 32, 'file_id')}`,
    `wallet: ${hex0x(a.wallet, 20, 'wallet')}`,
    `one-time key: ${hex0x(a.key, 48, 'key')}`,
    `valid until: ${utc(a.deadline)}`,
  ].join('\n');
}

export function stopSalesText(contractId: string, a: StopSalesArgs): string {
  return [
    'Annon: stop selling a file',
    "Signing this is final: the file can't be sold again. Past buyers keep access.",
    `contract: ${contractId}`,
    `file: ${hex0x(a.file_id, 32, 'file_id')}`,
    `valid until: ${utc(a.deadline)}`,
  ].join('\n');
}
