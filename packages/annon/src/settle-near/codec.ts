/** Small bounded Borsh primitives; all integers here are little-endian. */
import { sha256 } from '@noble/hashes/sha2.js';

export const utf8 = new TextEncoder();
export const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};
export const hex = (b: Uint8Array): string =>
  `0x${Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')}`;
export function bytes(s: string, length: number): Uint8Array<ArrayBuffer> {
  if (typeof s !== 'string' || !new RegExp(`^0x[0-9a-f]{${length * 2}}$`).test(s))
    throw new TypeError(`expected canonical ${length}-byte hex`);
  return Uint8Array.from(s.slice(2).match(/../g) ?? [], (x) => Number.parseInt(x, 16));
}
export function uint(s: string | bigint, bits: number): bigint {
  if (
    typeof s !== 'bigint' &&
    (typeof s !== 'string' ||
      s.length > Math.ceil(bits * Math.LOG10E * Math.LN2) ||
      !/^(0|[1-9][0-9]*)$/.test(s))
  )
    throw new TypeError('expected canonical unsigned integer');
  const n = BigInt(s);
  if (n < 0n || n >= 1n << BigInt(bits)) throw new RangeError(`expected u${bits}`);
  return n;
}
export function le(value: string | bigint | number, length: number): Uint8Array<ArrayBuffer> {
  if (typeof value === 'number' && !Number.isSafeInteger(value))
    throw new RangeError('expected integer');
  let n = uint(typeof value === 'number' ? BigInt(value) : value, length * 8);
  return Uint8Array.from({ length }, () => {
    const b = Number(n & 255n);
    n >>= 8n;
    return b;
  });
}
export const str = (s: string) => {
  const b = utf8.encode(s);
  return concat(le(b.length, 4), b);
};
export const hash = (tag: string, data: Uint8Array) =>
  hex(sha256(concat(utf8.encode(tag), new Uint8Array([0]), data)));
export function account(s: string): string {
  if (typeof s !== 'string' || !/^(?=.{2,64}$)[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(s))
    throw new TypeError('invalid NEAR account id');
  return s;
}
export function network(s: string): string {
  if (!['near:mainnet', 'near:testnet', 'near:sandbox'].includes(s))
    throw new TypeError('invalid NEAR network');
  return s;
}
export function exactKeys(
  value: unknown,
  keys: string[],
): asserts value is Record<string, unknown> {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).length !== keys.length ||
    !keys.every((k) => Object.hasOwn(value, k))
  )
    throw new TypeError('unexpected object fields');
}
export const compare = (a: Uint8Array, b: Uint8Array) => {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const d = (a[i] as number) - (b[i] as number);
    if (d) return d;
  }
  return a.length - b.length;
};
