import { afterEach, expect, it, vi } from 'vitest';
import {
  backupSecretHex,
  contract,
  fileId,
  nearRpc,
  nearViews,
  workspace,
} from '../../test/commands.js';
import { Annon } from '../api/annon.js';
import { createAdapter } from './adapter.js';
import { publicError } from './errors.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it('budget reads the file storage balance without a wallet or a backup secret', async () => {
  const ws = await workspace('budget');
  const views = {
    file_storage_balance: vi.fn((_args: Record<string, unknown>) => ({
      available: '7000',
      admission_requirement: '2500',
    })),
  };
  vi.stubGlobal('fetch', nearViews(views));
  const wallet = vi.fn();
  const sdk = vi.fn();
  try {
    const run = createAdapter({ ANNON_CONFIG: ws.config }, { wallet, sdk });
    expect(await run({ command: 'budget', target: fileId })).toEqual({
      fileId,
      available: '7000',
      admissionRequirement: '2500',
    });
    expect(views.file_storage_balance).toHaveBeenCalledWith({ file_id: fileId });
    expect(wallet).not.toHaveBeenCalled();
    expect(sdk).not.toHaveBeenCalled();
  } finally {
    await ws.remove();
  }
});

it.each([undefined, 'file.pay2', `0x${'AB'.repeat(32)}`])(
  'budget refuses the file reference %s before any RPC call',
  async (target) => {
    const ws = await workspace('budget-usage');
    const fetcher = nearViews({});
    vi.stubGlobal('fetch', fetcher);
    try {
      const error = await createAdapter({ ANNON_CONFIG: ws.config })({
        command: 'budget',
        ...(target ? { target } : {}),
      }).catch((e) => e);
      expect(publicError(error)).toMatchObject({ code: 'invalid_arguments', exitCode: 2 });
      expect(fetcher).not.toHaveBeenCalled();
    } finally {
      await ws.remove();
    }
  },
);

it('a NEAR owner funds the file directly and gets exactly the funded amount back', async () => {
  const ws = await workspace('fund-near');
  const call = vi.fn(async () => null);
  const sdk = vi.fn();
  try {
    const run = createAdapter(
      { ANNON_CONFIG: ws.config },
      {
        sdk,
        wallet: async () => ({
          identity: { kind: 'near', id: 'owner.near' },
          authorize: vi.fn(),
          call,
          transferPurchase: vi.fn(),
        }),
      },
    );
    expect(await run({ command: 'fund', target: fileId, fundAmount: '0.05' })).toEqual({
      fileId,
      fundedNear: '0.05',
    });
    expect(call).toHaveBeenCalledTimes(1);
    expect(call).toHaveBeenCalledWith(
      expect.objectContaining({ receiverId: contract, method: 'fund_file_storage' }),
    );
    // The direct path needs neither the backup secret nor the SDK.
    expect(sdk).not.toHaveBeenCalled();
  } finally {
    await ws.remove();
  }
});

it('a non-NEAR owner funds through the SDK with the wallet it loaded once', async () => {
  const ws = await workspace('fund-sdk');
  const owner = {
    identity: { kind: 'evm' as const, id: `0x${'11'.repeat(20)}` },
    authorize: vi.fn(),
  };
  const wallet = vi.fn(async () => owner);
  const fund = vi.fn(async () => null);
  const env = { ANNON_CONFIG: ws.config, ANNON_BACKUP_SECRET: backupSecretHex };
  try {
    const run = createAdapter(env, {
      wallet,
      sdk: (options) => {
        const sdk = new Annon(options);
        vi.spyOn(sdk, 'fund').mockImplementation(fund);
        return sdk;
      },
    });
    expect(await run({ command: 'fund', target: fileId, fundAmount: '0.05' })).toEqual({
      fileId,
      fundedNear: '0.05',
    });
    expect(fund).toHaveBeenCalledTimes(1);
    expect(fund).toHaveBeenCalledWith(fileId, 50000000000000000000000n, owner);
    // The first funding step selected the wallet; the SDK step reuses it.
    expect(wallet).toHaveBeenCalledTimes(1);
    expect(wallet).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'fund', network: 'near:mainnet' }),
      env,
      nearRpc,
    );
  } finally {
    await ws.remove();
  }
});

it('SDK funding still requires the backup secret after the owner is known', async () => {
  const ws = await workspace('fund-secret');
  const fund = vi.fn();
  try {
    const run = createAdapter(
      { ANNON_CONFIG: ws.config },
      {
        wallet: async () => ({
          identity: { kind: 'evm', id: `0x${'11'.repeat(20)}` },
          authorize: vi.fn(),
        }),
        sdk: (options) => {
          const sdk = new Annon(options);
          vi.spyOn(sdk, 'fund').mockImplementation(fund);
          return sdk;
        },
      },
    );
    const error = await run({ command: 'fund', target: fileId, fundAmount: '0.05' }).catch(
      (e) => e,
    );
    expect(publicError(error)).toMatchObject({ code: 'backup_secret_required', exitCode: 2 });
    expect(fund).not.toHaveBeenCalled();
  } finally {
    await ws.remove();
  }
});
