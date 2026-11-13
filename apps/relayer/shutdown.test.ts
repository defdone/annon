import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import * as rpc from '../../packages/annon/src/near/rpc.ts';
import * as relay from '../../packages/annon/src/relay/relay.ts';
import { type Config, keeper } from './server.ts';

it('drains the current keeper pass before stopping', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'annon-keeper-drain-'));
  let entered: () => void = () => {};
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let release: (value: Awaited<ReturnType<typeof relay.keep>>) => void = () => {};
  const pass = new Promise<Awaited<ReturnType<typeof relay.keep>>>((resolve) => {
    release = resolve;
  });
  const chain = vi
    .spyOn(rpc, 'getConfig')
    .mockResolvedValue({ network: 'near:mainnet' } as Awaited<ReturnType<typeof rpc.getConfig>>);
  const keep = vi.spyOn(relay, 'keep').mockImplementation(async () => {
    entered();
    return pass;
  });
  const c: Config = {
    nearRpc: 'https://rpc.test',
    baseRpc: 'https://base.test',
    contractId: 'market.test',
    usdc: `0x${'11'.repeat(20)}`,
    sender: { accountId: 'relay.test', key: 'test-double' },
    disabled: false,
    perIpHour: 600,
    perDay: 1000,
    policy: { minPrice: 100000n, maxDeadlineSeconds: 600 },
    keeper: {
      sender: { accountId: 'keeper.test', key: 'other-test-double' },
      stateDir: dir,
      hourlyBudget: 5n * 10n ** 23n,
      dailyBudget: 10n ** 24n,
      gasPrice: 100000000n,
      reserveLowWater: 1n,
    },
  };
  const stop = keeper(c, 15);
  try {
    await ready;
    let closed = false;
    const closing = stop().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    release({ sent: [], errors: [], incidents: [] });
    await closing;
    expect(closed).toBe(true);
  } finally {
    release({ sent: [], errors: [], incidents: [] });
    await stop();
    keep.mockRestore();
    chain.mockRestore();
    await rm(dir, { recursive: true, force: true });
  }
});

it('handles SIGTERM by closing HTTP and draining background work', () => {
  const script = `
    import {serve} from './server.ts';
    const server=serve({nearRpc:'https://rpc.test',baseRpc:'https://base.test',contractId:'market.test',
      usdc:'0x${'11'.repeat(20)}',sender:{accountId:'relay.test',key:'test-double'},
      policy:{minPrice:100000n,maxDeadlineSeconds:600},disabled:true,perIpHour:600,perDay:1000},0);
    server.once('listening',()=>process.kill(process.pid,'SIGTERM'));
    server.once('close',()=>console.log('closed'));
    setTimeout(()=>process.exit(4),2000).unref();
  `;
  const out = spawnSync(
    process.execPath,
    ['--no-warnings', '--import', './ts-hook.mjs', '--input-type=module', '-e', script],
    { cwd: import.meta.dirname, encoding: 'utf8', timeout: 5000 },
  );
  expect(out.status, out.stderr).toBe(0);
  expect(out.stdout).toContain('closed');
});
