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

it('prints rules verbatim with provenance in human output and retains JSON strings', async () => {
  const { runCli } = await import('./cli.js');
  const result = {
    shop: { manifest: 'https://shop.test/.well-known/annon-shop.json', name: 'Shop' },
    rules: { text: '<b>café</b>' },
  };
  const lines: string[] = [];
  expect(
    await runCli(
      ['catalog'],
      async () => result,
      (line) => lines.push(line),
    ),
  ).toBe(0);
  expect(lines[0]).toBe(`Shop rules (${result.shop.manifest}):\n${result.rules.text}`);
  lines.length = 0;
  await runCli(
    ['catalog', '--json'],
    async () => result,
    (line) => lines.push(line),
  );
  expect(lines).toHaveLength(1);
  expect(JSON.parse(lines[0] ?? '').result).toEqual(result);
});

it('share output keeps a null hosting expiry in human and JSON output', async () => {
  const { runCli } = await import('./cli.js');
  const result = {
    fileId: `0x${'11'.repeat(32)}`,
    url: 'https://host.example/f/synthetic',
    header: 'https://host.example/f/synthetic/header',
    expiresAt: null,
  };
  for (const json of [false, true]) {
    const lines: string[] = [];
    expect(
      await runCli(
        ['share', 'file.txt', '--price', '0.10', ...(json ? ['--json'] : [])],
        async () => result,
        (line) => lines.push(line),
      ),
    ).toBe(0);
    expect(JSON.parse(lines.at(-1) ?? '')).toEqual({ ok: true, result });
  }
});

it('prints shop list rules with manifest provenance', async () => {
  const { runCli } = await import('./cli.js');
  const manifest = 'https://shop.test/.well-known/annon-shop.json';
  const lines: string[] = [];
  await runCli(
    ['shops'],
    async () => ({
      items: [{ manifest, info: { name: 'Shop', rules: { text: 'T' } }, trusted: false }],
      total: 1,
      nextOffset: null,
    }),
    (line) => lines.push(line),
  );
  expect(lines[0]).toBe(`Shop rules (${manifest}):\nT`);
});

it('parses the shorter buyer flow: latest purchase, row numbers and buy --open', () => {
  expect(parseCli(['status'])).toEqual({ command: 'status' });
  expect(parseCli(['open', '--output', 'a.bin'])).toEqual({ command: 'open', output: 'a.bin' });
  expect(parseCli(['buy', '2', '--shop', 'demo', '--search', 'notes', '--open', 'a.bin'])).toEqual({
    command: 'buy',
    target: '2',
    shop: 'demo',
    search: 'notes',
    open: 'a.bin',
  });
  expect(parseCli(['buy', 'https://files.test/f', '--open', 'a.bin']).open).toBe('a.bin');
  for (const args of [
    // --shop and --search only pick the listing a row number refers to.
    ['buy', 'https://files.test/f', '--shop', 'demo'],
    ['buy', 'offer.json', '--search', 'notes'],
    ['buy'],
    ['verify'],
    ['stop'],
    ['status', '--open', 'a.bin'],
    ['shell'],
  ])
    expect(() => parseCli(args)).toThrow(AdapterError);
});

it.each([
  { args: [], human: true },
  { args: ['--json', '--open', '/nonexistent/annon-test/out.bin'], human: false },
])(
  'an uncertain buy exits 4 even when the status check after it fails: $args',
  async ({ args, human }) => {
    const id = `0x${'ab'.repeat(32)}`;
    const calls: string[] = [];
    const output: string[] = [];
    const code = await runCli(
      ['buy', 'https://files.test/a', ...args],
      async (o) => {
        calls.push(o.command);
        if (o.command === 'buy')
          return { purchaseId: id, state: 'uncertain', route: 'near', backup: '/saved' };
        throw new AdapterError('unavailable', 'RPC down.', 1);
      },
      (text) => output.push(text),
      { human, notify: (text) => output.push(text) },
    );
    // One payment attempt, one status check, and the purchase is still reported in full.
    expect(calls).toEqual(['buy', 'status']);
    expect(code).toBe(4);
    if (human)
      expect(output).toEqual([
        'The wallet may have sent this payment. Do not pay again. Checking NEAR...',
        [
          `Purchase ${id} (near route)`,
          'Status check failed: RPC down. (unavailable)',
          `Not accepted yet. Do not pay again. Run annon status ${id} until it is accepted, then annon open ${id} --output <file>.`,
          'Backup: /saved',
        ].join('\n'),
      ]);
    else
      expect(JSON.parse(output.at(-1) ?? '')).toMatchObject({
        ok: true,
        result: {
          purchaseId: id,
          state: 'uncertain',
          settlement: 'pending',
          backup: '/saved',
          statusError: { code: 'unavailable', message: 'RPC down.', exitCode: 1 },
        },
      });
  },
);

it('a failed open or status check after an established payment keeps its own exit code', async () => {
  const id = `0x${'ab'.repeat(32)}`;
  const run = (state: string, statuses: 'accepted' | Error) =>
    runCli(
      ['buy', 'https://files.test/a', '--json', '--open', '/nonexistent/annon-test/out.bin'],
      async (o) => {
        if (o.command === 'buy') return { purchaseId: id, state, route: 'near', backup: '/saved' };
        if (o.command === 'status' && statuses === 'accepted') return { state: 'accepted' };
        throw o.command === 'status' ? statuses : new AdapterError('unavailable', 'Host down.', 1);
      },
      () => {},
    );
  // Accepted after an uncertain send: the payment is settled, so the open error decides.
  expect(await run('uncertain', 'accepted')).toBe(1);
  expect(await run('submitted', new AdapterError('invalid_config', 'Bad config.', 2))).toBe(2);
});
