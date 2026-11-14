/** Parses decimal USDC and NEAR amounts from command input into base units. */
import { usage } from './errors.js';

export function amount(text: string): string {
  if (!/^(0|[1-9][0-9]*)(\.[0-9]{1,6})?$/.test(text)) throw usage();
  const [whole, fraction = ''] = text.split('.');
  const n = BigInt(whole ?? '') * 1000000n + BigInt(fraction.padEnd(6, '0'));
  if (n <= 0n || n >= 2n ** 128n) throw usage();
  return String(n);
}
export function nearAmount(text: string): bigint {
  if (!/^(0|[1-9][0-9]*)(\.[0-9]{1,24})?$/.test(text)) throw usage();
  const [whole = '0', fraction = ''] = text.split('.');
  const n = BigInt(whole) * 10n ** 24n + BigInt(fraction.padEnd(24, '0'));
  if (n <= 0n || n >= 2n ** 128n) throw usage();
  return n;
}
