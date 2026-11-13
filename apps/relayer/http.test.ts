import { expect, it } from 'vitest';
import { clientBucket, cors } from './http.ts';

it('uses only a single validated IP and groups IPv6 by /48', () => {
  for (const invalid of ['garbage', '1.1.1.1, 2.2.2.2', 'fe80::1%lo0', 'a'.repeat(1000)])
    expect(clientBucket(invalid, '192.0.2.1')).toBe('192.0.2.1');
  expect(clientBucket('2001:db8:aaaa:1::1', '')).toBe('2001:db8:aaaa::/48');
  expect(clientBucket('2001:db8:aaaa:ffff::2', '')).toBe('2001:db8:aaaa::/48');
  expect(clientBucket('::ffff:192.0.2.1', '')).toBe('192.0.2.1');
});
it('grants exact origins on errors and validates preflight headers and methods', () => {
  expect(cors('https://annon.dev')).toMatchObject({
    headers: {
      'Access-Control-Allow-Origin': 'https://annon.dev',
      'Access-Control-Expose-Headers': 'Retry-After',
    },
  });
  for (const origin of [
    'null',
    'https://annon.dev.evil.test',
    'https://annon.dev/',
    'http://annon.dev',
    'https://random.vercel.app',
  ])
    expect(cors(origin).headers['Access-Control-Allow-Origin']).toBeUndefined();
  expect(
    cors('https://annon.dev', undefined, { method: 'POST', headers: 'content-type' }).status,
  ).toBe(204);
  expect(
    cors('https://annon.dev', undefined, { method: 'POST', headers: 'authorization' }).status,
  ).toBe(403);
  expect(cors('https://annon.dev', undefined, { method: 'DELETE', headers: '' }).status).toBe(403);
  expect(() => cors(undefined, { allow: ['http://annon.dev'] })).toThrow();
});
