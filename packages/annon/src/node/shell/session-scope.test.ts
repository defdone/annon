import { writeFile } from 'node:fs/promises';
import { expect, it, vi } from 'vitest';
import { contract, fileId, nearRpc, workspace } from '../../../test/commands.js';
import { session } from '../../../test/session.js';
import { createAdapter } from '../adapter.js';
import type { Config } from '../config.js';
import { rememberPurchase } from '../purchase-ref.js';

const purchaseOf = (byte: string) => `0x${byte.repeat(32)}`;

it('status and open without an ID reach the adapter as typed, whatever was bought before', async () => {
  const id = purchaseOf('ab');
  const s = session(async (o) =>
    o.command === 'buy'
      ? { purchaseId: id, state: 'deposit_required', route: '1click', next: 'n', backup: '/b' }
      : { purchaseId: id, state: 'accepted', output: o.output, bytes: 1 },
  );
  await s.prompts(1);
  const lines = [
    'buy https://files.test/a --contract-id a.near',
    'status --contract-id b.near',
    'status',
    'open --output o.bin --network near:testnet',
    'status --state-dir /elsewhere',
    'open --output o.bin --config /other.json',
  ];
  for (const [i, line] of lines.entries()) {
    s.type(line);
    await s.prompts(i + 2);
  }
  s.type('exit');
  await s.exit;
  expect(s.calls).toEqual([
    { command: 'buy', target: 'https://files.test/a', contractId: 'a.near' },
    { command: 'status', contractId: 'b.near' },
    { command: 'status' },
    { command: 'open', output: 'o.bin', network: 'near:testnet' },
    { command: 'status', stateDir: '/elsewhere' },
    { command: 'open', output: 'o.bin', config: '/other.json' },
  ]);
});

it('each line uses the latest purchase of its own contract, network, config and state directory', async () => {
  const one = await workspace('scope-one');
  const two = await workspace('scope-two');
  const at = (dir: string, contractId = contract, network = 'near:mainnet') =>
    ({ stateDir: dir, network, contractId }) as Config;
  const [here, otherContract, otherNetwork, otherDir] = ['a1', 'b2', 'c3', 'd4'].map(purchaseOf);
  const purchase = vi.fn(async () => ({ file_id: fileId, grants: [] }) as never);
  try {
    await rememberPurchase(at(one.dir), here as string);
    await rememberPurchase(at(one.dir, 'other.near'), otherContract as string);
    await rememberPurchase(at(one.dir, contract, 'near:testnet'), otherNetwork as string);
    await rememberPurchase(at(two.dir), otherDir as string);
    const run = createAdapter({ ANNON_CONFIG: one.config }, { purchase });
    const s = session((o) => run(o));
    await s.prompts(1);
    let done = 1;
    const line = async (text: string) => {
      s.type(text);
      await s.prompts(++done);
      return purchase.mock.lastCall;
    };
    expect(await line('status')).toEqual([nearRpc, contract, here]);
    expect(await line('status --contract-id other.near --trust-contract')).toEqual([
      nearRpc,
      'other.near',
      otherContract,
    ]);
    expect(await line('status --network near:testnet --trust-contract')).toEqual([
      nearRpc,
      contract,
      otherNetwork,
    ]);
    expect(await line(`status --state-dir ${two.dir}`)).toEqual([nearRpc, contract, otherDir]);
    expect(await line(`status --config ${two.config}`)).toEqual([nearRpc, contract, otherDir]);
    expect(await line('status')).toEqual([nearRpc, contract, here]);
    // A contract with no saved purchase gets none, not the one a line before it used.
    purchase.mockClear();
    await line('status --contract-id empty.near --trust-contract');
    expect(s.text()).toContain('No purchase has been saved by buy for this contract yet.');
    expect(purchase).not.toHaveBeenCalled();
    // The config file changes on disk between two lines of the same session.
    await writeFile(
      one.config,
      JSON.stringify({
        contractId: 'other.near',
        network: 'near:mainnet',
        nearRpc,
        stateDir: one.dir,
        trustContract: true,
      }),
    );
    expect(await line('status')).toEqual([nearRpc, 'other.near', otherContract]);
    s.type('exit');
    await s.exit;
  } finally {
    await one.remove();
    await two.remove();
  }
});
