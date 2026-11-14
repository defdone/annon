import { expect, it } from 'vitest';
import { concatParts, hexDigits } from './bytes.js';
import { concat as pay2Concat } from './envelope/pay2.js';
import { toHex } from './pay/eip3009.js';
import { concat as codecConcat, hex } from './settle-near/codec.js';

// The previous pay2, codec and EIP-3009 copies used this same byte-copy loop.
function previousConcat(...parts: Uint8Array[]) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
// The split copy accepted its parts as one array rather than rest arguments.
function previousSplitConcat(parts: Uint8Array[]) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
const previousHex = (b: Uint8Array) =>
  Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

it('preserves concatenation and hex encoding for random byte views without aliasing inputs', () => {
  let seed = 0x731eab5;
  const random = () => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return seed >>> 0;
  };
  for (let trial = 0; trial < 256; trial++) {
    const parts = Array.from({ length: random() % 12 }, (_, index) => {
      const size = random() % 257;
      const bytes = Uint8Array.from({ length: size + 9 }, () => random() & 255);
      return index % 2 ? bytes.subarray(3, 3 + size) : Buffer.from(bytes).subarray(4, 4 + size);
    });
    const snapshots = parts.map((p) => Uint8Array.from(p));
    const expected = previousConcat(...parts);
    expect(concatParts(parts)).toEqual(expected);
    expect(pay2Concat(...parts)).toEqual(expected);
    expect(codecConcat(...parts)).toEqual(expected);
    expect(concatParts(parts)).toEqual(previousSplitConcat(parts));
    for (const p of parts) {
      expect(hexDigits(p)).toBe(previousHex(p));
      expect(hex(p)).toBe(`0x${previousHex(p)}`);
      expect(toHex(p)).toBe(`0x${previousHex(p)}`);
      expect(hex(p)).toBe(`0x${Buffer.from(p).toString('hex')}`);
    }
    const copy = concatParts(parts);
    copy.fill(0);
    expect(parts.map((p) => Uint8Array.from(p))).toEqual(snapshots);
  }
});

it('keeps array-based concatenation independent of the function argument limit', () => {
  const parts = Array.from({ length: 150_000 }, () => new Uint8Array(0));
  expect(concatParts(parts)).toEqual(previousSplitConcat(parts));
});

it('preserves the previous iterator behavior of byte copying and hex formatting', () => {
  class Bytes extends Uint8Array {
    override [Symbol.iterator]() {
      return Uint8Array.of(255)[Symbol.iterator]();
    }
  }
  const bytes = new Bytes([1, 2, 3]);
  expect(concatParts([bytes, bytes])).toEqual(previousConcat(bytes, bytes));
  expect(hexDigits(bytes)).toBe(previousHex(bytes));
  expect(toHex(bytes)).toBe(`0x${previousHex(bytes)}`);
  expect(hex(bytes)).toBe(`0x${previousHex(bytes)}`);
});
