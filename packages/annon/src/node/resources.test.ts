import { expect, it } from 'vitest';
import { resourceAllowed } from './resources.js';

it('opens agent URL policy only when absent and keeps exact and same-origin prefix boundaries', () => {
  expect(resourceAllowed(undefined, 'https://example.com/file')).toBe(true);
  expect(resourceAllowed(undefined, 'http://localhost:1234/file')).toBe(true);
  expect(resourceAllowed(undefined, 'http://example.com/file')).toBe(false);
  expect(resourceAllowed([], 'https://example.com/file')).toBe(false);
  const rules = ['https://example.com/files/*', 'https://other.example/exact'];
  for (const url of [
    'https://example.com/files/a',
    'https://example.com/files/nested/b',
    'https://other.example/exact',
  ])
    expect(resourceAllowed(rules, url)).toBe(true);
  for (const url of [
    'https://example.com/files2/a',
    'https://example.com.evil/files/a',
    'https://example.com:444/files/a',
    'https://example.com/files/../secret',
    'https://other.example/exact/a',
    'offer.json',
  ])
    expect(resourceAllowed(rules, url)).toBe(false);
});

it.each(['%2f', '%2F', '%5c', '%5C'])(
  'refuses encoded separators %s even with an open policy',
  (separator) => {
    expect(resourceAllowed(undefined, `https://example.com/files/a${separator}secret`)).toBe(false);
    expect(
      resourceAllowed(
        ['https://example.com/files/*'],
        `https://example.com/files/a${separator}secret`,
      ),
    ).toBe(false);
  },
);
