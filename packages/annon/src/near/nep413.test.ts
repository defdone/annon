import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { hex } from '../settle-near/codec.js';
import { type NearMessage, nep413Hash } from './nep413.js';

// NEP-413 §Example, independently laid out Borsh bytes (no SDK encoder).
const prefix =
  '9d010080020000006869000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f090000006d796170702e636f6d';
describe('NEP-413 spec vectors', () => {
  it.each([
    [undefined, '00'],
    ['myapp.com/callback', '01120000006d796170702e636f6d2f63616c6c6261636b'],
    ['', '0100000000'],
  ])('encodes callbackUrl Option<string>: %s', (callbackUrl, suffix) => {
    const p: NearMessage = {
      message: 'hi',
      nonce: Uint8Array.from({ length: 32 }, (_, i) => i),
      recipient: 'myapp.com',
      ...(callbackUrl === undefined ? {} : { callbackUrl }),
    };
    const expected = `0x${createHash('sha256')
      .update(Buffer.from(prefix + suffix, 'hex'))
      .digest('hex')}`;
    expect(hex(nep413Hash(p))).toBe(expected);
  });
  it('rejects short nonces', () =>
    expect(() => nep413Hash({ message: '', recipient: '', nonce: new Uint8Array(31) })).toThrow());
});
