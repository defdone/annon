import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { buyFlow } from './buy-flow.js';
import type { Input } from './cli.js';
import { AdapterError, publicError } from './errors.js';

const id = `0x${'ab'.repeat(32)}`;
const bought = (state: string) => ({ purchaseId: id, state, route: 'near', next: 'n' });
const buy: Input = {
  command: 'buy',
  target: 'https://files.test/f',
  config: '/c.json',
  wallet: 'near',
};
const wait = async () => {};

/** An adapter scripted per command; `statuses` are the answers to successive status checks. */
function scripted(state: string, statuses: (string | Error)[], open?: Error) {
  return vi.fn(async (input: Input) => {
    if (input.command === 'buy') return bought(state);
    if (input.command === 'status') {
      const next = statuses.shift() ?? 'pending';
      if (next instanceof Error) throw next;
      return { purchaseId: id, state: next };
    }
    if (open) throw open;
    return { purchaseId: id, output: input.output, bytes: 7 };
  });
}

it('scripts and agents get the plain buy: no waiting, no status, no open', async () => {
  const execute = scripted('submitted', ['accepted']);
  expect(await buyFlow(buy, execute, false, { wait })).toEqual(bought('submitted'));
  expect(execute).toHaveBeenCalledTimes(1);
  const other = vi.fn(async () => ({ state: 'pending' }));
  await buyFlow({ command: 'status', target: id }, other, true, { wait });
  expect(other).toHaveBeenCalledTimes(1);
});

it('--open waits for acceptance, then opens with the same deployment and wallet options', async () => {
  const execute = scripted('submitted', ['pending', 'accepted']);
  const notify = vi.fn();
  const waiting: boolean[] = [];
  const result = await buyFlow({ ...buy, open: 'out.bin' }, execute, false, {
    wait,
    notify,
    onWaiting: (w) => waiting.push(w),
  });
  expect(result).toEqual({
    ...bought('submitted'),
    state: 'opened',
    opened: { output: 'out.bin', bytes: 7 },
    next: 'The file is saved.',
  });
  expect(execute.mock.calls.map(([input]) => input)).toEqual([
    { ...buy, open: 'out.bin' },
    { command: 'status', target: id, config: '/c.json', wallet: 'near' },
    { command: 'status', target: id, config: '/c.json', wallet: 'near' },
    { command: 'open', target: id, output: 'out.bin', config: '/c.json', wallet: 'near' },
  ]);
  expect(notify).toHaveBeenCalledWith('Payment sent. Waiting for NEAR to accept...');
  expect(waiting).toEqual([true, false]);
});

it('an existing output name is refused before anything is bought', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'annon-flow-'));
  const taken = join(dir, 'taken.bin');
  await writeFile(taken, 'x');
  const execute = scripted('submitted', ['accepted']);
  try {
    const error = await buyFlow({ ...buy, open: taken }, execute, false, { wait }).catch((e) => e);
    expect(publicError(error)).toMatchObject({ code: 'output_exists', exitCode: 2 });
    expect(execute).not.toHaveBeenCalled();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it.each(['submitted', 'uncertain'])(
  'a %s payment that is not accepted in time stays a saved purchase and is never bought again',
  async (state) => {
    const execute = scripted(state, []);
    const notify = vi.fn();
    const result = (await buyFlow(buy, execute, true, { wait, notify })) as Record<string, unknown>;
    expect(result).toMatchObject({ purchaseId: id, state, settlement: 'pending' });
    expect(result.next).toContain('Do not pay again');
    expect(result).not.toHaveProperty('opened');
    expect(execute.mock.calls.filter(([input]) => input.command === 'buy')).toHaveLength(1);
    expect(execute.mock.calls.filter(([input]) => input.command === 'status')).toHaveLength(60);
    expect(execute.mock.calls.some(([input]) => input.command === 'open')).toBe(false);
    if (state === 'uncertain')
      expect(notify).toHaveBeenCalledWith(
        'The wallet may have sent this payment. Do not pay again. Checking NEAR...',
      );
  },
);

it('an uncertain payment that NEAR accepts is opened', async () => {
  const execute = scripted('uncertain', ['accepted']);
  expect(await buyFlow({ ...buy, open: 'out.bin' }, execute, false, { wait })).toMatchObject({
    state: 'opened',
  });
});

it('a failed status check or open is reported next to the purchase, not instead of it', async () => {
  const down = new AdapterError('unavailable', 'RPC down.', 1);
  expect(await buyFlow(buy, scripted('uncertain', [down]), true, { wait })).toMatchObject({
    purchaseId: id,
    state: 'uncertain',
    settlement: 'pending',
    statusError: { code: 'unavailable', exitCode: 1 },
  });
  const execute = scripted(
    'submitted',
    ['accepted'],
    new AdapterError('unavailable', 'Host down.'),
  );
  expect(await buyFlow({ ...buy, open: 'out.bin' }, execute, false, { wait })).toMatchObject({
    purchaseId: id,
    state: 'accepted',
    openError: { code: 'unavailable', message: 'Host down.' },
  });
});

it('a deposit route returns its instructions without waiting', async () => {
  const execute = scripted('deposit_required', ['accepted']);
  expect(await buyFlow({ ...buy, open: 'out.bin' }, execute, true, { wait })).toEqual(
    bought('deposit_required'),
  );
  expect(execute).toHaveBeenCalledTimes(1);
});

it('cancelling the wait stops the checks and keeps the purchase pending', async () => {
  const stop = new AbortController();
  const execute = scripted('submitted', []);
  const result = await buyFlow(buy, execute, true, {
    signal: stop.signal,
    wait: async () => stop.abort(),
  });
  expect(result).toMatchObject({ purchaseId: id, settlement: 'pending' });
  expect(execute.mock.calls.filter(([input]) => input.command === 'status')).toHaveLength(1);
});

it('a person is asked where to save once the purchase is accepted; no path leaves it accepted', async () => {
  const savePath = vi.fn(async (): Promise<string | undefined> => 'asked.bin');
  expect(
    await buyFlow(buy, scripted('submitted', ['accepted']), true, { wait, savePath }),
  ).toMatchObject({ state: 'opened', opened: { output: 'asked.bin' } });
  savePath.mockResolvedValue(undefined);
  const execute = scripted('submitted', ['accepted']);
  expect(await buyFlow(buy, execute, true, { wait, savePath })).toMatchObject({
    state: 'accepted',
  });
  expect(execute.mock.calls.some(([input]) => input.command === 'open')).toBe(false);
});
