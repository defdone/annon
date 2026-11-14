import { describe, expect, it, vi } from 'vitest';
import { parseCli, runCli } from './cli.js';
import { AdapterError } from './errors.js';

describe('annon CLI boundary', () => {
  it('parses every command, flags before/after operands, and explicit routes', () => {
    expect(
      parseCli([
        'sell',
        'a.txt',
        '--price',
        '0.2',
        '--split',
        'near:alice.near:10000',
        '--base',
        '--json',
      ]),
    ).toMatchObject({ command: 'sell', target: 'a.txt', price: '0.2', base: true, json: true });
    expect(
      parseCli(['--json', 'buy', 'offer.json', '--route=1click', '--from-chain', 'solana']),
    ).toMatchObject({ command: 'buy', route: '1click', fromChain: 'solana', json: true });
    for (const command of ['open', 'stop', 'verify', 'status'])
      expect(parseCli([command, 'target']).command).toBe(command);
    expect(parseCli(['recover', '--recovery', 'near:alice.near']).recovery).toBe('near:alice.near');
  });
  it.each([
    ['buy'],
    ['sell', 'a'],
    ['recover'],
    ['buy', 'url', '--route', 'wat'],
    ['buy', 'url', '--private-key', 'SECRET'],
    ['status', 'id', 'extra'],
    ['verify', 'a', '--price', '2'],
  ])('rejects invalid arguments without echoing them: %j', (...args) => {
    expect(() => parseCli(args)).toThrow(AdapterError);
    try {
      parseCli(args);
    } catch (e) {
      expect(String(e)).not.toContain('SECRET');
    }
  });
  it('emits one JSON result and a stable exit code; never serializes raw errors', async () => {
    const output = vi.fn();
    expect(
      await runCli(
        ['status', 'id', '--json'],
        async () => ({ purchaseId: 'id', state: 'accepted' }),
        output,
      ),
    ).toBe(0);
    expect(JSON.parse(output.mock.calls[0]?.[0] ?? '')).toEqual({
      ok: true,
      result: { purchaseId: 'id', state: 'accepted' },
    });
    expect(
      await runCli(
        ['status', 'id', '--json'],
        async () => ({ state: 'pending' }),
        () => {},
      ),
    ).toBe(4);
    output.mockClear();
    expect(
      await runCli(
        ['status', 'id', '--json'],
        async () => {
          throw new Error('private_key=SECRET');
        },
        output,
      ),
    ).toBe(1);
    expect(output.mock.calls.flat().join('')).not.toContain('SECRET');
    expect(JSON.parse(output.mock.calls[0]?.[0] ?? '')).toMatchObject({
      ok: false,
      error: { code: 'operation_failed' },
    });
  });
});

it('parses sell resume with original plaintext and no new listing terms', () => {
  expect(parseCli(['sell', 'original.txt', '--resume', `0x${'ab'.repeat(32)}`])).toMatchObject({
    command: 'sell',
    target: 'original.txt',
    resume: `0x${'ab'.repeat(32)}`,
  });
});

it('parses discovery commands and strictly validates paging', () => {
  expect(parseCli(['shops'])).toMatchObject({ command: 'shops' });
  expect(parseCli(['shop', 'add', 'https://shop.test/demo', '--id', 'mine'])).toMatchObject({
    command: 'shop',
    target: 'https://shop.test/demo',
    id: 'mine',
  });
  expect(
    parseCli(['catalog', '--shop', 'mine', '--search', 'notes', '--limit', '2', '--offset', '0']),
  ).toMatchObject({ command: 'catalog', shop: 'mine', search: 'notes', limit: 2, offset: 0 });
  for (const args of [
    ['shop', 'remove', 'x'],
    ['catalog', '--limit', '0'],
    ['catalog', '--offset', '1.2'],
    ['catalog', '--limit', '101'],
    ['shops', 'extra'],
  ])
    expect(() => parseCli(args)).toThrow();
});

it('parses hosted share and resume without allowing new terms on resume', () => {
  expect(
    parseCli([
      'share',
      'a.txt',
      '--price',
      '0.10',
      '--shop',
      'mine',
      '--title',
      'File',
      '--description',
      'Notes',
    ]),
  ).toMatchObject({
    command: 'share',
    target: 'a.txt',
    price: '0.10',
    shop: 'mine',
    title: 'File',
    description: 'Notes',
  });
  expect(parseCli(['share', 'a.txt', '--resume', `0x${'11'.repeat(32)}`])).toMatchObject({
    command: 'share',
    resume: `0x${'11'.repeat(32)}`,
  });
  expect(() => parseCli(['share', 'a.txt'])).toThrow();
  expect(() =>
    parseCli(['share', 'a.txt', '--resume', `0x${'11'.repeat(32)}`, '--price', '1']),
  ).toThrow();
});
