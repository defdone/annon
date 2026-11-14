import { access, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import {
  backupSecret,
  backupSecretHex,
  buyer,
  fileId,
  nearPayment,
  purchaseRecord,
  recoveryRecord,
  sealedFile,
  workspace,
} from '../../test/commands.js';
import { Annon } from '../api/annon.js';
import { AnnonError } from '../errors.js';
import {
  type EncryptedRecord,
  encryptedPurchaseStore,
  exportPurchase,
  exportRecovery,
} from '../pay/backup.js';
import { type PurchaseRecord, purchaseKey } from '../pay/purchase.js';
import { fileStore } from '../pay/store-node.js';
import { createAdapter, type Dependencies } from './adapter.js';
import { publicError } from './errors.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const pendingNext =
  'Check the payment; configure readable saved state and the matching backup secret to resume Base unlock. 1Click SUCCESS alone is not acceptance.';
const purchaseId = `0x${'77'.repeat(32)}`;
const agentConfig = (dir: string) => ({ workDir: dir, maxPrice: '1', dailyBudget: '1' });

async function saveRecord(dir: string, record: PurchaseRecord, secret = backupSecret) {
  await mkdir(join(dir, 'records'), { recursive: true });
  const store = encryptedPurchaseStore(fileStore<EncryptedRecord>(join(dir, 'records')), secret);
  await store.compareAndSet(purchaseKey(record.id), null, record);
}

/** An SDK whose acceptance and decryption are scripted; everything else is the real SDK. */
function scriptedSdk(
  accept: (record: PurchaseRecord | undefined, id?: string) => Promise<boolean>,
  extra: (sdk: Annon) => void = () => {},
): NonNullable<Dependencies['sdk']> {
  return (options) => {
    const sdk = new Annon(options);
    vi.spyOn(sdk, 'accept').mockImplementation(accept);
    extra(sdk);
    return sdk;
  };
}

it('status without a backup secret reports pending setup and leaves no retry gate for humans', async () => {
  const ws = await workspace('status-setup');
  const purchase = vi.fn(async () => null);
  try {
    const run = createAdapter({ ANNON_CONFIG: ws.config }, { purchase });
    expect(await run({ command: 'status', target: purchaseId })).toEqual({
      purchaseId,
      state: 'pending',
      next: pendingNext,
    });
    expect(purchase).toHaveBeenCalledWith('https://near.test', 'annon.near', purchaseId);
    await expect(access(join(ws.dir, 'retry-gates'))).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    await ws.remove();
  }
});

it('status for an agent without a backup secret defers the next check by 30 seconds', async () => {
  const ws = await workspace('status-setup-agent', {});
  await writeFile(
    ws.config,
    JSON.stringify({
      contractId: 'annon.near',
      nearRpc: 'https://near.test',
      stateDir: ws.dir,
      trustContract: true,
      ...agentConfig(ws.dir),
    }),
  );
  const purchase = vi.fn(async () => null);
  try {
    const run = createAdapter({ ANNON_CONFIG: ws.config }, { agent: true, purchase });
    expect(await run({ command: 'status', target: purchaseId })).toEqual({
      purchaseId,
      state: 'pending',
      next: pendingNext,
    });
    const error = await run({ command: 'status', target: purchaseId }).catch((e) => e);
    expect(publicError(error)).toMatchObject({
      code: 'settlement_pending',
      exitCode: 4,
      purchaseId,
    });
    expect(publicError(error).retryAfterSeconds).toBeGreaterThan(25);
    expect(publicError(error).retryAfterSeconds).toBeLessThanOrEqual(30);
    // The gate refuses before chain state is read again.
    expect(purchase).toHaveBeenCalledTimes(1);
  } finally {
    await ws.remove();
  }
});

it('status with a configured but unreadable backup secret file reports pending setup', async () => {
  const ws = await workspace('status-secret-file');
  const sdk = vi.fn();
  try {
    const run = createAdapter(
      { ANNON_CONFIG: ws.config, ANNON_BACKUP_SECRET_FILE: join(ws.dir, 'missing-secret') },
      { purchase: async () => null, sdk },
    );
    expect(await run({ command: 'status', target: purchaseId })).toEqual({
      purchaseId,
      state: 'pending',
      next: pendingNext,
    });
    expect(sdk).not.toHaveBeenCalled();
    // Other commands still fail on the missing secret.
    const error = await run({ command: 'stop', target: fileId }).catch((e) => e);
    expect(publicError(error)).toMatchObject({ code: 'backup_secret_required', exitCode: 2 });
  } finally {
    await ws.remove();
  }
});

it('status reports pending setup when the saved record cannot be decrypted with this secret', async () => {
  const ws = await workspace('status-wrong-secret');
  const record = purchaseRecord();
  await saveRecord(ws.dir, record, new Uint8Array(32).fill(0xcd));
  const accept = vi.fn(async () => true);
  try {
    const run = createAdapter(
      { ANNON_CONFIG: ws.config, ANNON_BACKUP_SECRET: backupSecretHex },
      { purchase: async () => null, sdk: scriptedSdk(accept) },
    );
    expect(await run({ command: 'status', target: record.id })).toEqual({
      purchaseId: record.id,
      state: 'pending',
      next: pendingNext,
    });
    expect(accept).not.toHaveBeenCalled();
  } finally {
    await ws.remove();
  }
});

it.each([false, true])(
  'status from the saved record reports acceptance %s with its payment',
  async (accepted) => {
    const ws = await workspace('status-record');
    const record = purchaseRecord();
    await saveRecord(ws.dir, record);
    const accept = vi.fn(async () => accepted);
    const wallet = vi.fn();
    try {
      const run = createAdapter(
        { ANNON_CONFIG: ws.config, ANNON_BACKUP_SECRET: backupSecretHex },
        { purchase: async () => null, wallet, sdk: scriptedSdk(accept) },
      );
      expect(await run({ command: 'status', target: record.id })).toEqual(
        accepted
          ? {
              purchaseId: record.id,
              state: 'accepted',
              route: 'near',
              payment: nearPayment,
              next: 'open',
            }
          : {
              purchaseId: record.id,
              state: 'pending',
              route: 'near',
              payment: nearPayment,
              retryAfterSeconds: 30,
              next: 'Check the payment and retry status. 1Click SUCCESS alone is not acceptance.',
            },
      );
      expect(accept).toHaveBeenCalledWith(record, record.id);
      expect(wallet).not.toHaveBeenCalled();
    } finally {
      await ws.remove();
    }
  },
);

it.each(['not accepted', 'refused with a wait'] as const)(
  'status for an agent defers the next check when the purchase is %s',
  async (mode) => {
    const ws = await workspace('status-agent');
    await writeFile(
      ws.config,
      JSON.stringify({
        contractId: 'annon.near',
        nearRpc: 'https://near.test',
        stateDir: ws.dir,
        trustContract: true,
        ...agentConfig(ws.dir),
      }),
    );
    const record = purchaseRecord();
    await saveRecord(ws.dir, record);
    const accept = vi.fn(async () => {
      if (mode === 'not accepted') return false;
      throw Object.assign(new AnnonError('relayer_rate_limited'), { retryAfterSeconds: 45 });
    });
    try {
      const run = createAdapter(
        { ANNON_CONFIG: ws.config, ANNON_BACKUP_SECRET: backupSecretHex },
        { agent: true, purchase: async () => null, sdk: scriptedSdk(accept) },
      );
      const first = await run({ command: 'status', target: record.id }).catch((e) => e);
      if (mode === 'not accepted') expect(first).toMatchObject({ state: 'pending' });
      else expect(publicError(first)).toMatchObject({ code: 'relayer_rate_limited' });
      const error = await run({ command: 'status', target: record.id }).catch((e) => e);
      const code = mode === 'not accepted' ? 'settlement_pending' : 'relayer_rate_limited';
      const limit = mode === 'not accepted' ? 30 : 45;
      expect(publicError(error)).toMatchObject({ code, exitCode: 4, purchaseId: record.id });
      expect(publicError(error).retryAfterSeconds).toBeGreaterThan(limit - 5);
      expect(publicError(error).retryAfterSeconds).toBeLessThanOrEqual(limit);
      expect(accept).toHaveBeenCalledTimes(1);
    } finally {
      await ws.remove();
    }
  },
);

it('recover lists recovered purchases with backup paths and per-purchase public errors', async () => {
  const ws = await workspace('recover', { network: 'near:testnet' });
  const recoveryWallet = { identity: buyer, authorize: vi.fn() };
  const wallet = vi.fn(async () => recoveryWallet);
  const env = { ANNON_CONFIG: ws.config, ANNON_BACKUP_SECRET: backupSecretHex };
  const failed = `0x${'88'.repeat(32)}`;
  const refusal = new AnnonError('wrong_identity', 'PRIVATE_DETAIL');
  const recover = vi.fn(async (o: { onError?: (purchaseId: string, error: unknown) => void }) => {
    o.onError?.(failed, refusal);
    return [recoveryRecord(purchaseId)];
  });
  try {
    const run = createAdapter(env, {
      wallet,
      sdk: (options) => {
        const sdk = new Annon(options);
        vi.spyOn(sdk, 'recover').mockImplementation(recover);
        return sdk;
      },
    });
    const { code, message } = publicError(refusal);
    expect(await run({ command: 'recover', recovery: 'near:buyer.near' })).toEqual({
      errors: [{ purchaseId: failed, code, message }],
      recovered: [
        {
          purchaseId,
          fileId,
          grant: 0,
          backup: join(ws.dir, 'backups', `recovery-${purchaseId}.json`),
        },
      ],
    });
    expect(recover).toHaveBeenLastCalledWith({
      onError: expect.any(Function),
      wallet: recoveryWallet,
    });
    // The wallet is loaded for the configured network, not a default.
    expect(wallet).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'recover', network: 'near:testnet' }),
      env,
      'https://near.test',
    );
    await run({ command: 'recover', recovery: 'near:buyer.near', purchase: purchaseId });
    expect(recover).toHaveBeenLastCalledWith({
      onError: expect.any(Function),
      wallet: recoveryWallet,
      purchaseId,
    });
  } finally {
    await ws.remove();
  }
});

it.each([{}, { recovery: 'near:buyer.near', purchase: 'not-an-id' }])(
  'recover refuses invalid input %o before the SDK runs',
  async (input) => {
    const ws = await workspace('recover-usage');
    const recover = vi.fn();
    try {
      const run = createAdapter(
        { ANNON_CONFIG: ws.config, ANNON_BACKUP_SECRET: backupSecretHex },
        {
          wallet: async () => ({ identity: buyer, authorize: vi.fn() }),
          sdk: (options) => {
            const sdk = new Annon(options);
            vi.spyOn(sdk, 'recover').mockImplementation(recover);
            return sdk;
          },
        },
      );
      const error = await run({ command: 'recover', ...input }).catch((e) => e);
      expect(publicError(error)).toMatchObject({ code: 'invalid_arguments', exitCode: 2 });
      expect(recover).not.toHaveBeenCalled();
    } finally {
      await ws.remove();
    }
  },
);

it.each([false, true])(
  'open refuses an unaccepted purchase before writing output (agent %s)',
  async (agent) => {
    const ws = await workspace('open-pending');
    if (agent)
      await writeFile(
        ws.config,
        JSON.stringify({
          contractId: 'annon.near',
          nearRpc: 'https://near.test',
          stateDir: ws.dir,
          trustContract: true,
          ...agentConfig(ws.dir),
        }),
      );
    const record = purchaseRecord();
    await saveRecord(ws.dir, record);
    const local = join(ws.dir, 'file.pay2');
    await writeFile(local, 'ciphertext');
    const accept = vi.fn(async () => false);
    const openTo = vi.fn();
    try {
      const run = createAdapter(
        { ANNON_CONFIG: ws.config, ANNON_BACKUP_SECRET: backupSecretHex },
        {
          agent,
          sdk: scriptedSdk(accept, (sdk) => vi.spyOn(sdk, 'openTo').mockImplementation(openTo)),
        },
      );
      const input = {
        command: 'open' as const,
        target: record.id,
        file: local,
        output: join(ws.dir, 'out'),
      };
      const error = await run(input).catch((e) => e);
      expect(publicError(error)).toMatchObject({
        code: 'settlement_pending',
        exitCode: 4,
        message: publicError({ code: 'settlement_pending' }).message,
      });
      expect(accept).toHaveBeenCalledWith(record, record.id);
      expect(openTo).not.toHaveBeenCalled();
      await expect(access(join(ws.dir, 'out'))).rejects.toMatchObject({ code: 'ENOENT' });
      const again = await run(input).catch((e) => e);
      expect(publicError(again)).toMatchObject({ code: 'settlement_pending', exitCode: 4 });
      // Only an agent is held back by the saved retry gate; a human asks the chain again.
      expect(accept).toHaveBeenCalledTimes(agent ? 1 : 2);
      if (agent) expect(publicError(again).retryAfterSeconds).toBeGreaterThan(25);
    } finally {
      await ws.remove();
    }
  },
);

it.each(['purchase', 'recovery'] as const)(
  'open decrypts with an encrypted %s backup file instead of a saved ID',
  async (kind) => {
    const ws = await workspace('open-backup');
    const record = purchaseRecord();
    const recovery = recoveryRecord(purchaseId);
    const backup = join(ws.dir, `${kind}.backup`);
    await writeFile(
      backup,
      kind === 'purchase'
        ? await exportPurchase(record, backupSecret)
        : await exportRecovery(recovery, backupSecret),
    );
    const local = join(ws.dir, 'file.pay2');
    await writeFile(local, 'ciphertext');
    const output = join(ws.dir, 'out');
    const plaintext = new TextEncoder().encode('opened content');
    const accept = vi.fn(async () => true);
    const openTo = vi.fn(
      async (o: {
        file: unknown;
        sink: WritableStream<Uint8Array>;
        record?: unknown;
        recovery?: unknown;
      }) => {
        await new Blob([plaintext]).stream().pipeTo(o.sink);
        return { meta: { name: 'f', mime: '', size: plaintext.length } };
      },
    );
    try {
      const run = createAdapter(
        { ANNON_CONFIG: ws.config, ANNON_BACKUP_SECRET: backupSecretHex },
        {
          sdk: scriptedSdk(accept, (sdk) =>
            vi.spyOn(sdk, 'openTo').mockImplementation(openTo as never),
          ),
        },
      );
      const result = await run({ command: 'open', target: backup, file: local, output });
      if (kind === 'purchase') {
        expect(result).toEqual({
          fileId,
          purchaseId: record.id,
          output,
          bytes: plaintext.length,
          route: 'near',
          payment: nearPayment,
        });
        expect(accept).toHaveBeenCalledWith(record, record.id);
        expect(openTo.mock.calls[0]?.[0]).toMatchObject({ record });
        expect(openTo.mock.calls[0]?.[0]).not.toHaveProperty('recovery');
      } else {
        expect(result).toEqual({ fileId, purchaseId, output, bytes: plaintext.length });
        expect(accept).toHaveBeenCalledWith(undefined, purchaseId);
        expect(openTo.mock.calls[0]?.[0]).toMatchObject({ recovery });
        expect(openTo.mock.calls[0]?.[0]).not.toHaveProperty('record');
      }
      expect(new Uint8Array(await readFile(output))).toEqual(plaintext);
    } finally {
      await ws.remove();
    }
  },
);

it('open for an agent defers the download after a host download limit', async () => {
  const ws = await workspace('open-download-limit');
  const root = await realpath(ws.dir);
  const url = 'https://files.test/file';
  await writeFile(
    ws.config,
    JSON.stringify({
      contractId: 'annon.near',
      nearRpc: 'https://near.test',
      stateDir: ws.dir,
      trustContract: true,
      allowedResources: [url],
      ...agentConfig(ws.dir),
    }),
  );
  const sealed = await sealedFile();
  const record = purchaseRecord({ headerHash: sealed.headerHash });
  await saveRecord(ws.dir, record);
  const fetcher = vi.fn<typeof fetch>(async (target) => {
    if (String(target) === url) return new Response(sealed.header);
    throw new Error(`Unexpected network access: ${String(target)}`);
  });
  const accept = vi.fn(async () => true);
  const openTo = vi.fn(async () => {
    throw Object.assign(new AnnonError('download_limited'), { retryAfterSeconds: 120 });
  });
  try {
    const run = createAdapter(
      { ANNON_CONFIG: ws.config, ANNON_BACKUP_SECRET: backupSecretHex },
      {
        agent: true,
        fetch: fetcher,
        file: async () => sealed.info,
        sdk: scriptedSdk(accept, (sdk) => vi.spyOn(sdk, 'openTo').mockImplementation(openTo)),
      },
    );
    const input = { command: 'open' as const, target: record.id, url, output: join(root, 'out') };
    const first = await run(input).catch((e) => e);
    expect(publicError(first)).toMatchObject({ code: 'download_limited', retryAfterSeconds: 120 });
    expect(openTo).toHaveBeenCalledTimes(1);
    const second = await run(input).catch((e) => e);
    expect(publicError(second)).toMatchObject({
      code: 'download_limited',
      exitCode: 4,
      purchaseId: record.id,
      fileId,
    });
    expect(publicError(second).retryAfterSeconds).toBeGreaterThan(115);
    // The download gate refuses before acceptance is checked or the file is fetched again.
    expect(accept).toHaveBeenCalledTimes(1);
    expect(openTo).toHaveBeenCalledTimes(1);
  } finally {
    await ws.remove();
  }
});

it('open refuses a purchase backup made for another contract before any key or file work', async () => {
  const ws = await workspace('open-other-contract');
  const record = purchaseRecord({ contract: 'other.near' });
  const backup = join(ws.dir, 'purchase.backup');
  await writeFile(backup, await exportPurchase(record, backupSecret));
  const local = join(ws.dir, 'file.pay2');
  await writeFile(local, 'ciphertext');
  const output = join(ws.dir, 'out');
  const wallet = vi.fn();
  const accept = vi.fn(async () => true);
  const openTo = vi.fn();
  try {
    const run = createAdapter(
      { ANNON_CONFIG: ws.config, ANNON_BACKUP_SECRET: backupSecretHex, ANNON_WALLET: 'near' },
      {
        wallet,
        sdk: scriptedSdk(accept, (sdk) => vi.spyOn(sdk, 'openTo').mockImplementation(openTo)),
      },
    );
    const error = await run({ command: 'open', target: backup, file: local, output }).catch(
      (e) => e,
    );
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe('backup contract mismatch');
    expect(publicError(error)).toMatchObject({ code: 'operation_failed', exitCode: 1 });
    // No acceptance check, wallet, key claim or decryption, and no output file.
    expect(accept).not.toHaveBeenCalled();
    expect(wallet).not.toHaveBeenCalled();
    expect(openTo).not.toHaveBeenCalled();
    await expect(access(output)).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    await ws.remove();
  }
});
