import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { terms } from '../../test/fixtures.js';
import { Annon } from '../api/annon.js';
import { createAdapter } from './adapter.js';
import { parseCli } from './cli.js';

it('parses explicit NEAR funding and sale budgets', () => {
  const file = `0x${'12'.repeat(32)}`;
  expect(parseCli(['fund', file, '0.05'])).toMatchObject({
    command: 'fund',
    target: file,
    fundAmount: '0.05',
  });
  expect(parseCli(['budget', file])).toMatchObject({ command: 'budget' });
  expect(
    parseCli([
      'sell',
      'file.txt',
      '--price',
      '1',
      '--split',
      'near:seller.test:10000',
      '--storage-budget',
      '0.05',
    ]),
  ).toMatchObject({ storageBudget: '0.05' });
});

it('funds with a NEAR wallet without requiring an unrelated purchase backup secret', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'annon-fund-'));
  const config = join(dir, 'config.json');
  const call = vi.fn(async () => null);
  try {
    await writeFile(
      config,
      JSON.stringify({
        contractId: 'contract.test',
        nearRpc: 'https://rpc.test',
        stateDir: dir,
        trustContract: true,
      }),
    );
    const adapter = createAdapter(
      {},
      {
        wallet: vi.fn(async () => ({
          identity: { kind: 'near' as const, id: 'sponsor.test' },
          authorize: async () => undefined,
          call,
          transferPurchase: vi.fn(),
        })),
      },
    );
    const target = `0x${'12'.repeat(32)}`;
    await expect(
      adapter({ command: 'fund', target, fundAmount: '0.05', config }),
    ).resolves.toMatchObject({ fileId: target, fundedNear: '0.05' });
    expect(call).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'fund_file_storage',
        args: { file_id: target, amount: '50000000000000000000000' },
        deposit: 50000000000000000000000n,
      }),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it('refuses human-only funding in agent mode before wallet loading', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'annon-human-fund-'));
  try {
    const config = join(dir, 'config.json');
    await writeFile(
      config,
      JSON.stringify({
        contractId: 'contract.test',
        nearRpc: 'https://rpc.test',
        stateDir: dir,
        workDir: dir,
        trustContract: true,
        maxPrice: '1',
        dailyBudget: '1',
      }),
    );
    const wallet = vi.fn();
    const adapter = createAdapter({ ANNON_CONFIG: config }, { agent: true, wallet });
    await expect(
      adapter({ command: 'fund', target: `0x${'12'.repeat(32)}`, json: true }),
    ).rejects.toMatchObject({ code: 'human_only' });
    expect(wallet).not.toHaveBeenCalled();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it.each(['json', 'agent', 'interactive'] as const)(
  'enforces the fee ceiling or shows it for %s sells',
  async (mode) => {
    const dir = await mkdtemp(join(tmpdir(), 'annon-fee-ceiling-'));
    const prompt = vi.fn(async () => true);
    const fee = { fixed: '40000', bps: 100, treasuryNear: terms.seller, treasuryEvm: terms.seller };
    const sign = vi.fn();
    try {
      const config = join(dir, 'config.json');
      const target = join(dir, 'input.txt');
      await writeFile(target, 'input');
      await writeFile(
        config,
        JSON.stringify({
          contractId: terms.contract,
          nearRpc: 'https://rpc.test',
          stateDir: dir,
          workDir: dir,
          relayer: 'https://relay.test',
          trustContract: true,
          maxPrice: '1',
          dailyBudget: '1',
          maxProtocolFee: { fixed: '30000', bps: 100 },
        }),
      );
      const adapter = createAdapter(
        { ANNON_CONFIG: config, ANNON_BACKUP_SECRET: '01'.repeat(32) },
        {
          agent: mode === 'agent',
          prompt,
          wallet: async () => ({ identity: terms.seller, authorize: sign }),
          sdk: (options) => {
            expect(options.maxProtocolFee).toEqual({ fixed: '30000', bps: 100 });
            const sdk = new Annon(options);
            vi.spyOn(sdk, 'sell').mockImplementation(async (args) => {
              await args.onSplit?.(terms.near, fee, true);
              return {
                terms,
                file: new Uint8Array(),
                header: new Uint8Array(),
              };
            });
            return sdk;
          },
        },
      );
      const result = adapter({
        command: 'sell',
        target,
        price: '0.2',
        split: `evm:${terms.seller.id}:10000`,
        json: mode !== 'interactive',
      });
      if (mode === 'interactive') {
        await expect(result).resolves.toBeDefined();
        expect(prompt).toHaveBeenCalledWith(expect.stringContaining('exceeds maxProtocolFee'));
        expect(prompt).toHaveBeenCalledWith(
          expect.stringContaining('40000 USDC base units + 100 bps'),
        );
      } else {
        await expect(result).rejects.toMatchObject({ code: 'protocol_fee_above_max' });
        expect(prompt).not.toHaveBeenCalled();
      }
      expect(sign).not.toHaveBeenCalled();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);

it.each(['self', 'sponsored-flag', 'resume-flag'] as const)(
  'warns or refuses ignored storage budgets for %s sells',
  async (mode) => {
    const dir = await mkdtemp(join(tmpdir(), 'annon-storage-option-'));
    try {
      const target = join(dir, 'input.txt');
      const config = join(dir, 'config.json');
      await writeFile(target, 'input');
      await writeFile(
        config,
        JSON.stringify({
          contractId: terms.contract,
          nearRpc: 'https://rpc.test',
          stateDir: dir,
          trustContract: true,
        }),
      );
      const identity =
        mode === 'sponsored-flag' ? terms.seller : { kind: 'near' as const, id: 'seller.test' };
      const adapter = createAdapter(
        { ANNON_CONFIG: config, ANNON_BACKUP_SECRET: '01'.repeat(32) },
        {
          wallet: async () => ({
            identity,
            authorize: vi.fn(),
            call: vi.fn(),
            transferPurchase: vi.fn(),
          }),
          sdk: (options) => {
            const sdk = new Annon(options);
            vi.spyOn(sdk, 'sell').mockResolvedValue({
              terms,
              file: new Uint8Array(),
              header: new Uint8Array(),
            });
            vi.spyOn(sdk, 'resumeSell').mockResolvedValue({
              terms,
              file: new Uint8Array(),
              header: new Uint8Array(),
            });
            return sdk;
          },
        },
      );
      const result = adapter({
        command: 'sell',
        target,
        json: true,
        ...(mode === 'resume-flag'
          ? { resume: terms.file_id, storageBudget: '0.05' }
          : {
              price: '0.2',
              split: `${identity.kind}:${identity.id}:10000`,
              ...(mode === 'sponsored-flag' ? { storageBudget: '0.05' } : {}),
            }),
      });
      if (mode === 'self')
        await expect(result).resolves.toMatchObject({
          warnings: [expect.stringContaining('no purchase storage budget')],
        });
      else await expect(result).rejects.toMatchObject({ code: 'invalid_arguments' });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);
