import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { expect, it, vi } from 'vitest';
import type { Input } from '../cli.js';
import type { Dependencies } from '../command-context.js';
import { AdapterError } from '../errors.js';
import { complete } from './complete.js';
import { createSession } from './session.js';
import { humanOutput, sessionAllowed, welcome } from './welcome.js';
import { splitWords } from './words.js';

const id = `0x${'ab'.repeat(32)}`;
const other = `0x${'cd'.repeat(32)}`;
type Hooks = Pick<Dependencies, 'prompt' | 'notify'>;
type Adapter = (input: Input, hooks: Hooks) => Promise<Record<string, unknown>>;

/** A session on in-memory streams. `type` sends a line; `shown` waits for text to appear. */
function session(adapter: Adapter, terminal = false) {
  const input = new PassThrough();
  const output = new PassThrough();
  let text = '';
  output.on('data', (chunk) => {
    text += String(chunk);
  });
  const calls: Input[] = [];
  const s = createSession({
    input,
    output,
    welcome: 'Annon test',
    terminal,
    wait: async () => {},
    adapter: (hooks) => (o) => {
      calls.push(o);
      return adapter(o, hooks);
    },
  });
  const exit = s.run();
  return {
    calls,
    exit,
    interrupt: s.interrupt,
    type: (line: string) => input.write(`${line}\n`),
    keys: (keys: string) => input.write(keys),
    end: () => input.end(),
    text: () => text,
    shown: (part: string) => vi.waitFor(() => expect(text).toContain(part)),
    /** Waits until the prompt has been printed `count` times: that many commands are done. */
    prompts: (count: number) =>
      vi.waitFor(() => expect(text.split('annon> ').length - 1).toBe(count)),
  };
}
const catalog = {
  items: [
    { title: 'First', url: 'https://files.test/one' },
    { title: 'Second', url: 'https://files.test/two' },
  ].map((e) => ({
    ...e,
    name: 'f',
    expiresAt: null,
    salesStopped: false,
    takenDown: false,
    terms: { near: { price: '200000' }, base: null, seller: { kind: 'near', id: 'seller.near' } },
  })),
  total: 2,
  nextOffset: null,
};

it('runs the one-shot commands without the prefix until exit, and prints readable results', async () => {
  const s = session(async (o) =>
    o.command === 'status' ? { purchaseId: id, state: 'accepted', next: 'open' } : { version: 1 },
  );
  await s.shown('Annon test\nannon> ');
  s.type(`status ${id}`);
  await s.shown(`Purchase ${id} is accepted.`);
  s.type(`annon status "${other}" --json`);
  await s.shown(
    JSON.stringify({ ok: true, result: { purchaseId: id, state: 'accepted', next: 'open' } }),
  );
  s.type('');
  s.type('nonsense');
  await s.shown('Error: Invalid arguments. Run annon --help. (invalid_arguments)');
  s.type('status "unclosed');
  await s.shown('Error: A quote is not closed. (invalid_arguments)');
  s.type('help');
  await s.shown('Commands work as on the command line');
  s.type('shell');
  await s.shown('This is the session already.');
  s.type('exit');
  expect(await s.exit).toBe(0);
  expect(s.calls).toEqual([
    { command: 'status', target: id },
    { command: 'status', target: other, json: true },
  ]);
});

it.each(['quit', 'ctrl-d'])('%s leaves the session with exit code 0', async (how) => {
  const s = session(async () => ({}));
  await s.prompts(1);
  if (how === 'quit') s.type('quit');
  else s.end();
  expect(await s.exit).toBe(0);
  expect(s.calls).toEqual([]);
});

it('buy takes a row of the last catalog, waits for acceptance and offers to save the file', async () => {
  const s = session(async (o) => {
    if (o.command === 'catalog') return catalog;
    if (o.command === 'buy')
      return { purchaseId: id, state: 'submitted', route: 'near', backup: '/b' };
    if (o.command === 'status') return { purchaseId: id, state: 'accepted', next: 'open' };
    return { purchaseId: id, output: o.output, bytes: 9 };
  });
  await s.prompts(1);
  s.type('catalog --shop demo');
  await s.shown(' 2  Second');
  await s.prompts(2);
  s.type('buy 2 --max-price 0.2');
  await s.shown('Row 2: Second (https://files.test/two)');
  await s.shown('Payment sent. Waiting for NEAR to accept...');
  await s.shown('Save the file now? Path (Enter to skip): ');
  s.type('out.bin');
  await s.shown('Accepted by NEAR. Saved out.bin (9 bytes).');
  await s.prompts(3);
  // The session's own purchase is what status and open mean without an ID.
  s.type('status');
  await s.prompts(4);
  s.type('open --output again.bin');
  await s.shown(`Saved again.bin (9 bytes) from purchase ${id}.`);
  s.type('exit');
  await s.exit;
  expect(s.calls).toEqual([
    { command: 'catalog', shop: 'demo' },
    { command: 'buy', target: 'https://files.test/two', maxPrice: '0.2' },
    { command: 'status', target: id },
    { command: 'open', target: id, output: 'out.bin' },
    { command: 'status', target: id },
    { command: 'open', target: id, output: 'again.bin' },
  ]);
});

it('a row number without a listing, or with --shop, is left to the adapter; a row off the listing is refused', async () => {
  const s = session(async (o) => {
    if (o.command === 'catalog') return catalog;
    throw new AdapterError('invalid_arguments', 'The catalog has no row 7.', 2);
  });
  await s.prompts(1);
  s.type('buy 1');
  await s.prompts(2);
  s.type('catalog');
  await s.prompts(3);
  s.type('buy 7');
  await s.prompts(4);
  s.type('buy 1 --shop other');
  await s.prompts(5);
  s.type('exit');
  await s.exit;
  // A row that is not on screen is never looked up in some other listing.
  expect(s.calls.filter((o) => o.command === 'buy')).toEqual([
    { command: 'buy', target: '1' },
    { command: 'buy', target: '1', shop: 'other' },
  ]);
  expect(s.text()).toContain(
    'Error: Row 7 is not in the last catalog listing. Run catalog again. (invalid_arguments)',
  );
});

it('prompts are answered in the session: only yes confirms, Ctrl-C at a prompt means no', async () => {
  const answers: boolean[] = [];
  const s = session(async (_o, hooks) => {
    answers.push((await hooks.prompt?.('Type yes to pay: ')) === true);
    return { purchaseId: id, state: 'deposit_required', route: '1click', next: 'n', backup: '/b' };
  });
  await s.prompts(1);
  s.type('buy https://files.test/one');
  await s.shown('Type yes to pay: ');
  s.type('YES');
  await s.prompts(2);
  s.type('buy https://files.test/one');
  await vi.waitFor(() => expect(s.text().split('Type yes to pay: ').length).toBe(3));
  s.type('y');
  await s.prompts(3);
  s.type('buy https://files.test/one');
  await vi.waitFor(() => expect(s.text().split('Type yes to pay: ').length).toBe(4));
  await s.interrupt();
  await s.prompts(4);
  s.type('exit');
  expect(await s.exit).toBe(0);
  expect(answers).toEqual([true, false, false]);
});

it('Ctrl-C during a payment asks before leaving; no keeps the command and its result', async () => {
  let pay: (value: Record<string, unknown>) => void = () => {};
  const s = session((o) =>
    o.command === 'buy'
      ? new Promise((resolve) => {
          pay = resolve;
        })
      : Promise.resolve({ purchaseId: id, state: 'pending' }),
  );
  await s.prompts(1);
  s.type('buy https://files.test/one');
  await vi.waitFor(() => expect(s.calls).toHaveLength(1));
  void s.interrupt();
  await s.shown('A payment may be in progress. Exit anyway? (y/N) ');
  s.type('');
  await s.shown('Still running.');
  pay({
    purchaseId: id,
    state: 'uncertain',
    route: 'near',
    next: 'Do not pay again.',
    backup: '/b',
  });
  // The uncertain purchase is still reported in full, then followed with status checks.
  await s.shown(`Purchase ${id}`);
  await s.shown('Do not pay again');
  s.type('exit');
  expect(await s.exit).toBe(0);
});

it('Ctrl-C during a payment leaves only after y, with exit code 130 and a warning', async () => {
  const s = session(() => new Promise(() => {}));
  await s.prompts(1);
  s.type('buy https://files.test/one');
  await vi.waitFor(() => expect(s.calls).toHaveLength(1));
  void s.interrupt();
  await s.shown('A payment may be in progress. Exit anyway? (y/N) ');
  s.type('y');
  expect(await s.exit).toBe(130);
  expect(s.text()).toContain('check the purchase with annon status before paying again');
});

it('Ctrl-C drops a read-only command, stops a wait for acceptance, and clears an idle line', async () => {
  let checks = 0;
  const s = session((o) => {
    if (o.command === 'catalog') return new Promise(() => {});
    if (o.command === 'buy')
      return Promise.resolve({ purchaseId: id, state: 'submitted', route: 'near', backup: '/b' });
    checks++;
    return new Promise((resolve) =>
      setTimeout(() => resolve({ purchaseId: id, state: 'pending' }), 5),
    );
  });
  await s.prompts(1);
  await s.interrupt();
  await s.shown('(type exit to leave)');
  await s.prompts(2);
  s.type('catalog');
  await vi.waitFor(() => expect(s.calls).toHaveLength(1));
  await s.interrupt();
  await s.shown('Cancelled.');
  await s.prompts(3);
  s.type('buy https://files.test/one');
  await vi.waitFor(() => expect(checks).toBeGreaterThan(1));
  await s.interrupt();
  await s.shown('Stopped waiting. The purchase is saved; check it with status.');
  await s.shown('Not accepted yet. Do not pay again.');
  await s.prompts(4);
  expect(s.text()).not.toContain('Exit anyway?');
  s.type('exit');
  expect(await s.exit).toBe(0);
});

it('a catalog dropped with Ctrl-C does not change what a row number means', async () => {
  let late: (value: Record<string, unknown>) => void = () => {};
  let listings = 0;
  const s = session((o) => {
    if (o.command === 'buy') return Promise.reject(new AdapterError('trust_required', 'Stop.', 3));
    if (++listings === 1) return Promise.resolve(catalog);
    return new Promise((resolve) => {
      late = resolve;
    });
  });
  await s.prompts(1);
  s.type('catalog');
  await s.prompts(2);
  s.type('catalog --search x');
  await vi.waitFor(() => expect(listings).toBe(2));
  await s.interrupt();
  await s.prompts(3);
  late({ ...catalog, items: [catalog.items[1], catalog.items[0]] });
  // Let the dropped listing finish before the next line is read.
  await new Promise((resolve) => setImmediate(resolve));
  s.type('buy 1');
  await s.shown('Row 1: First (https://files.test/one)');
  s.type('exit');
  await s.exit;
  expect(s.calls.at(-1)).toEqual({ command: 'buy', target: 'https://files.test/one' });
  expect(s.text()).not.toContain('Second (');
});

it('in a terminal Tab completes, Ctrl-C clears the line and Ctrl-D leaves', async () => {
  const s = session(async () => ({ items: [], total: 0, nextOffset: null }), true);
  await s.shown('annon> ');
  s.keys('garbage\u0003');
  await s.shown('(type exit to leave)');
  // Tab completes only as its own keypress; a pasted tab is text.
  for (const key of ['cat', '\t', '\r']) {
    s.keys(key);
    await new Promise((resolve) => setImmediate(resolve));
  }
  await s.shown('No files.');
  s.keys('\u0004');
  expect(await s.exit).toBe(0);
  expect(s.calls).toEqual([{ command: 'catalog' }]);
});

it('a long command other than a payment asks with its own name', async () => {
  const s = session(() => new Promise(() => {}));
  await s.prompts(1);
  s.type('login');
  await vi.waitFor(() => expect(s.calls).toHaveLength(1));
  void s.interrupt();
  await s.shown('login is still running. Exit anyway? (y/N) ');
  s.type('yes');
  expect(await s.exit).toBe(130);
  expect(s.text()).not.toContain('payment');
});

it('splits lines into arguments and completes commands and flags', () => {
  expect(splitWords(`  shop add "https://shop.test/my shop" --id 'a b' c\\ d  `)).toEqual([
    'shop',
    'add',
    'https://shop.test/my shop',
    '--id',
    'a b',
    'c d',
  ]);
  expect(splitWords('share f --title ""')).toEqual(['share', 'f', '--title', '']);
  expect(complete('st')).toEqual([['status ', 'stop '], 'st']);
  expect(complete('annon ca')).toEqual([['catalog '], 'ca']);
  expect(complete('ex')[0]).toEqual(['exit ']);
  expect(complete('shop ')).toEqual([['add '], '']);
  expect(complete('buy 2 --op')).toEqual([['--open '], '--op']);
  expect(complete('buy --private')[0]).toEqual([]);
  expect(complete('nonsense --j')[0]).toEqual([]);
});

it('a session starts only for a person at a terminal outside agent mode', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'annon-session-'));
  const human = join(dir, 'human.json');
  const agent = join(dir, 'agent.json');
  await writeFile(human, JSON.stringify({ network: 'near:mainnet' }));
  await writeFile(agent, JSON.stringify({ agent: true }));
  try {
    const env = { ANNON_CONFIG: human };
    expect(await sessionAllowed([], true, env)).toBe(true);
    expect(await sessionAllowed(['shell'], true, env)).toBe(true);
    expect(await sessionAllowed([], false, env)).toBe(false);
    expect(await sessionAllowed(['shell'], false, env)).toBe(false);
    for (const argv of [['--json'], ['shell', '--json'], ['status'], ['--help']])
      expect(await sessionAllowed(argv, true, env)).toBe(false);
    expect(await sessionAllowed([], true, { ANNON_AGENT: 'true' })).toBe(false);
    expect(await sessionAllowed(['shell'], true, { ANNON_CONFIG: agent })).toBe(false);
    // Human text follows the same rule; pipes and agents keep the JSON envelope.
    expect(await humanOutput(true, env)).toBe(true);
    expect(await humanOutput(false, env)).toBe(false);
    expect(await humanOutput(true, { ANNON_AGENT: 'true' })).toBe(false);
    expect(await humanOutput(true, { ANNON_CONFIG: agent })).toBe(false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it('the welcome names version, network, account and contract trust without writing anything', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'annon-welcome-'));
  const path = join(dir, 'config.json');
  const base = {
    network: 'near:mainnet',
    nearRpc: 'https://near.test',
    stateDir: join(dir, 'state'),
  };
  try {
    expect(await welcome({ ANNON_CONFIG: path })).toMatch(
      /^Annon \d+\.\d+\.\d+\S*\nNetwork: NEAR mainnet\nAccount: not signed in \(run login\)\nContract: not configured\nType help/,
    );
    await writeFile(
      path,
      JSON.stringify({
        ...base,
        contractId: 'annon.near',
        signer: { mode: 'browser', identity: { kind: 'near', id: 'alice.near' } },
      }),
    );
    expect(await welcome({ ANNON_CONFIG: path })).toContain(
      'Account: alice.near\nContract: annon.near (not trusted yet)',
    );
    await writeFile(
      path,
      JSON.stringify({ ...base, contractId: 'annon.near', trustContract: true }),
    );
    expect(await welcome({ ANNON_CONFIG: path })).toContain('Contract: annon.near (trusted)');
    await writeFile(path, '{broken');
    expect(await welcome({ ANNON_CONFIG: path })).toContain('Config: could not be read.');
    await expect(rm(join(dir, 'state'))).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
