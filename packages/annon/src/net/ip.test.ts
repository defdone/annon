import { expect, it } from 'vitest';
import { clientKey, fixedWindowLimiter } from './ip.js';

it('canonicalizes client addresses and groups IPv6 by /48', () => {
  expect(clientKey('2001:0db8:1:2::9', '10.0.0.1')).toBe('2001:db8:1::/48');
  expect(clientKey('2001:db8:1:ffff::1', undefined)).toBe('2001:db8:1::/48');
  for (const header of ['garbage', 'fe80::1%en0', '1.2.3.4, 5.6.7.8', 'x'.repeat(1000)])
    expect(clientKey(header, '::ffff:192.0.2.1')).toBe('192.0.2.1');
  expect(clientKey('::ffff:c000:201', undefined)).toBe('192.0.2.1');
  expect(clientKey(['192.0.2.2'], '192.0.2.1')).toBe('192.0.2.1');
  expect(clientKey('127.000.0.1', undefined)).toBe('unknown');
});

it('returns the remaining fixed window and bounds overflow keys', () => {
  let time = 59_001;
  const limit = fixedWindowLimiter(1, 60_000, () => time, 1);
  expect(limit('a').allowed).toBe(true);
  expect(limit('a')).toEqual({ allowed: false, retryAfterSeconds: 1 });
  expect(limit('b').allowed).toBe(true);
  expect(limit('c').allowed).toBe(false);
  time = 60_000;
  expect(limit('a').allowed).toBe(true);
  expect(fixedWindowLimiter(0)('a').allowed).toBe(false);
});
