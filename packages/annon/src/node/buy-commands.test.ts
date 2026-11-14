import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import {
  backupSecret,
  backupSecretHex,
  buyer,
  contract,
  contractConfig,
  fileId,
  nearPayment,
  nearViews,
  purchaseRecord,
  recoveryRecord,
  sealedFile,
  workspace,
} from '../../test/commands.js';
import { Annon } from '../api/annon.js';
import type { Bought, BuyOptions } from '../api/annon-types.js';
import type { OneClickQuote } from '../oneclick/oneclick.js';
import {
  type EncryptedRecord,
  encryptedPurchaseStore,
  encryptedRecoveryStore,
} from '../pay/backup.js';
import { type PurchaseRecord, purchaseKey } from '../pay/purchase.js';
import { fileStore } from '../pay/store-node.js';
import { hex } from '../settle-near/codec.js';
import { NEAR_USDC } from '../settle-near/terms.js';
import { createAdapter, type Dependencies } from './adapter.js';
import type { BudgetRecord } from './budget.js';
import type { Input } from './cli.js';
import { publicError } from './errors.js';
import type { PurchaseGuard } from './purchase-guard.js';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const url = 'https://files.test/file';
const headerUrl = 'https://files.test/header';
const sourceAsset = 'nep141:base-usdc.synthetic.near';
const next = 'Fund the deposit if instructed, then check status and open this purchase.';

it.each([false, true])('verify checks a file against its listing (remote %s)', async (remote) => {
  const ws = await workspace('verify');
  const sealed = await sealedFile();
  const local = join(ws.dir, 'file.pay2');
  await writeFile(local, sealed.file);
  const fetcher = vi.fn<typeof fetch>(async (target, init) => {
    expect(String(target)).toBe(url);
    expect(new Headers(init?.headers).get('Range')).toMatch(/^bytes=0-/);
    return new Response(sealed.file);
  });
  const file = vi.fn(async () => sealed.info);
  const wallet = vi.fn();
  try {
    const run = createAdapter({ ANNON_CONFIG: ws.config }, { fetch: fetcher, file, wallet });
    expect(await run({ command: 'verify', target: remote ? url : local })).toEqual({
      fileId,
      verified: true,
      checked: remote ? 'header' : 'header-and-body',
      contractId: contract,
    });
    expect(file).toHaveBeenCalledWith('https://near.test', contract, fileId);
    expect(fetcher).toHaveBeenCalledTimes(remote ? 1 : 0);
    // Verifying needs neither a wallet nor a backup secret.
    expect(wallet).not.toHaveBeenCalled();
  } finally {
    await ws.remove();
  }
});

it('verify refuses a file whose only key stanza is for another contract', async () => {
  const ws = await workspace('verify-stanza');
  const sealed = await sealedFile({ contractId: 'other.near', signedFor: contract });
  const local = join(ws.dir, 'file.pay2');
  await writeFile(local, sealed.file);
  try {
    const run = createAdapter({ ANNON_CONFIG: ws.config }, { file: async () => sealed.info });
    const error = await run({ command: 'verify', target: local }).catch((e) => e);
    expect(publicError(error)).toEqual({
      code: 'no_usable_stanza',
      message: 'The file has no key stanza for the trusted contract.',
      exitCode: 1,
    });
  } finally {
    await ws.remove();
  }
});

it('verify requires a file', async () => {
  const ws = await workspace('verify-usage');
  const file = vi.fn();
  try {
    const error = await createAdapter(
      { ANNON_CONFIG: ws.config },
      { file },
    )({
      command: 'verify',
    }).catch((e) => e);
    expect(publicError(error)).toMatchObject({ code: 'invalid_arguments', exitCode: 2 });
    expect(file).not.toHaveBeenCalled();
  } finally {
    await ws.remove();
  }
});

type Spy = (o: BuyOptions, sdk: Annon) => Promise<Bought>;

/** Saves `record` the way the SDK does before it returns, after the adapter's checkpoint. */
const saving =
  (record: PurchaseRecord, extra: Partial<Bought> = {}): Spy =>
  async (o, sdk) => {
    await o.beforeSave?.(record);
    await sdk.store.compareAndSet(purchaseKey(record.id), null, record);
    return { route: o.route ?? 'near', record, ...extra };
  };

/**
 * A buyer CLI against a synthetic host (offer at `url`, header at `headerUrl`) and NEAR views.
 * The SDK is real except for `buy`, which `spy` scripts.
 */
async function harness(
  o: {
    config?: Record<string, unknown>;
    agent?: boolean;
    storage?: { available: string; admission_requirement: string };
    host?: number;
    purchase?: Dependencies['purchase'];
    prompt?: boolean;
    spy?: Spy;
  } = {},
) {
  const ws = await workspace('buy', {
    maxPrice: '0.2',
    ...(o.agent ? { allowedResources: [url] } : {}),
    ...o.config,
  });
  if (o.agent) {
    const config = JSON.parse(await readFile(ws.config, 'utf8'));
    await writeFile(ws.config, JSON.stringify({ ...config, workDir: ws.dir }));
  }
  const sealed = await sealedFile();
  const offer = {
    x402Version: 2,
    resource: { url },
    accepts: [],
    extensions: {
      annon: {
        info: { version: 3, network: 'near:mainnet', contract, fileId, header: headerUrl },
      },
    },
  };
  const offerPath = join(ws.dir, 'offer.json');
  await writeFile(offerPath, JSON.stringify(offer));
  const fetcher = nearViews(
    {
      get_config: () => contractConfig(),
      file_storage_balance: () => o.storage ?? { available: '10', admission_requirement: '1' },
    },
    (target, init) => {
      if (target === url) {
        if (new Headers(init?.headers).get('PAYMENT-SIGNATURE'))
          return new Response('host reply', { status: o.host ?? 200 });
        return new Response(null, {
          status: 402,
          headers: { 'PAYMENT-REQUIRED': Buffer.from(JSON.stringify(offer)).toString('base64') },
        });
      }
      if (target === headerUrl) return new Response(sealed.header);
      return undefined;
    },
  );
  vi.stubGlobal('fetch', fetcher);
  const prompt = vi.fn(async (_text: string) => o.prompt ?? true);
  const notify = vi.fn();
  const paymentTerms = vi.fn();
  const buyerWallet = { identity: buyer, authorize: vi.fn(), call: vi.fn() };
  const wallet = vi.fn(async () => buyerWallet);
  const buy = vi.fn<Spy>(o.spy ?? saving(purchaseRecord({ headerHash: sealed.headerHash })));
  const run = createAdapter(
    { ANNON_CONFIG: ws.config, ANNON_BACKUP_SECRET: backupSecretHex },
    {
      ...(o.agent ? { agent: true } : {}),
      fetch: fetcher,
      prompt,
      notify,
      paymentTerms,
      wallet,
      file: async () => sealed.info,
      purchase: o.purchase ?? (async () => null),
      sdk: (options) => {
        const sdk = new Annon(options);
        vi.spyOn(sdk, 'buy').mockImplementation((options) => buy(options, sdk));
        return sdk;
      },
    },
  );
  const input = (extra: Partial<Input> = {}): Input =>
    o.agent
      ? { command: 'buy', target: url, ...extra }
      : { command: 'buy', target: offerPath, url, ...extra };
  const records = () =>
    encryptedPurchaseStore(fileStore<EncryptedRecord>(join(ws.dir, 'records')), backupSecret);
  const guard = async () => {
    const dir = join(ws.dir, 'purchase-guards');
    const [name] = (await readdir(dir)).filter((n) => n.endsWith('.json'));
    return {
      path: join(dir, String(name)),
      value: JSON.parse(await readFile(join(dir, String(name)), 'utf8')) as PurchaseGuard,
    };
  };
  const budget = () => fileStore<BudgetRecord>(join(ws.dir, 'budgets')).load('agent:USDC');
  return {
    ws,
    sealed,
    offerPath,
    fetcher,
    prompt,
    notify,
    paymentTerms,
    wallet,
    buyerWallet,
    buy,
    run,
    input,
    records,
    guard,
    budget,
  };
}

it.each([
  ['submitted', {}],
  ['deposit_required', { instructions: { address: 'deposit.near', amount: '1' } }],
  ['uncertain', { uncertain: { purchaseId: '', txHash: 'synthetic-uncertain-transaction' } }],
] as const)(
  'a human NEAR buy at exactly the price cap confirms the terms and ends %s',
  async (state, extra) => {
    const h = await harness();
    const record = purchaseRecord({ headerHash: h.sealed.headerHash });
    h.buy.mockImplementation(saving(record, extra as Partial<Bought>));
    try {
      expect(await h.run(h.input({ maxPrice: '0.2' }))).toEqual({
        purchaseId: record.id,
        fileId,
        route: 'near',
        payment: nearPayment,
        state,
        ...('uncertain' in extra ? { txHash: extra.uncertain.txHash } : {}),
        backup: join(h.ws.dir, 'backups', `${record.id}.json`),
        ...('instructions' in extra ? { instructions: extra.instructions } : {}),
        next,
      });
      expect(h.buy).toHaveBeenCalledTimes(1);
      const options = h.buy.mock.calls[0]?.[0];
      expect(options).toMatchObject({
        fileId,
        route: 'near',
        maxPrice: 200000n,
        recovery: h.buyerWallet,
        payer: h.buyerWallet,
        refund: buyer,
        moderators: [],
        url,
      });
      expect(options?.header).toEqual(h.sealed.header);
      expect(options).not.toHaveProperty('origin');
      // The human sees and approves the exact terms before the SDK can pay.
      const terms = {
        file: fileId,
        resource: url,
        network: 'near:mainnet',
        route: 'near',
        price: '200000',
        recipients: h.sealed.terms.near.recipients,
        remainder: 0,
        baseRecipient: h.sealed.terms.base?.pay_to,
        token: NEAR_USDC,
      };
      expect(h.paymentTerms).toHaveBeenCalledWith(terms);
      expect(h.notify).toHaveBeenCalledTimes(1);
      expect(h.prompt).toHaveBeenCalledWith('Type yes to pay: ');
      expect(h.prompt.mock.invocationCallOrder[0]).toBeLessThan(
        h.buy.mock.invocationCallOrder[0] ?? 0,
      );
      // The saved record gains the public payment summary in its next revision.
      expect(await h.records().load(purchaseKey(record.id))).toMatchObject({
        revision: 1,
        payment: nearPayment,
      });
      expect(await fileStore(join(h.ws.dir, 'resources')).load(fileId)).toEqual({
        id: fileId,
        revision: 0,
        contractId: contract,
        url,
        header: hex(h.sealed.header),
      });
      expect((await h.guard()).value).toMatchObject({ owner: null, purchases: [record.id] });
    } finally {
      await h.ws.remove();
    }
  },
);

it.each([
  ['a requested cap above the configured maximum', { maxPrice: '0.3' }, 'price_above_max', 2],
  ['a registered price above the requested cap', { maxPrice: '0.1' }, 'price_above_max', 1],
  ['a file without purchase storage', {}, 'file_storage_low', 2],
  ['a declined confirmation', {}, 'confirmation_required', 3],
] as const)('a human buy stops before paying on %s', async (name, flags, code, exitCode) => {
  const h = await harness({
    ...(name.includes('storage')
      ? { storage: { available: '1', admission_requirement: '2' } }
      : {}),
    ...(name.includes('declined') ? { prompt: false } : {}),
  });
  try {
    const error = await h.run(h.input(flags)).catch((e) => e);
    expect(publicError(error)).toMatchObject({ code, exitCode });
    expect(h.buy).not.toHaveBeenCalled();
    if (name.startsWith('a requested cap')) {
      expect(h.wallet).not.toHaveBeenCalled();
      expect(h.fetcher).not.toHaveBeenCalled();
    }
    if (!name.includes('declined')) expect(h.prompt).not.toHaveBeenCalled();
  } finally {
    await h.ws.remove();
  }
});

it('a human buy from an offer file needs the resource URL it names', async () => {
  const h = await harness();
  try {
    const error = await h
      .run({ command: 'buy', target: h.offerPath, maxPrice: '0.2' })
      .catch((e) => e);
    expect(error).toMatchObject({ message: 'resource mismatch' });
    expect(h.wallet).not.toHaveBeenCalled();
    expect(h.buy).not.toHaveBeenCalled();
  } finally {
    await h.ws.remove();
  }
});

it.each([
  [200, true],
  [206, true],
  [402, true],
  [503, true],
  [404, false],
  [500, false],
])('a Base payment submission answered with HTTP %s is accepted: %s', async (status, ok) => {
  const h = await harness({ host: status });
  const record = purchaseRecord({ headerHash: h.sealed.headerHash });
  const save = saving(record);
  h.buy.mockImplementation(async (o, sdk) => {
    await o.submitBase?.('signed-payment');
    return save(o, sdk);
  });
  try {
    const result = await h.run(h.input()).catch((e) => e);
    if (ok) expect(result).toMatchObject({ purchaseId: record.id, state: 'submitted' });
    else
      expect(publicError(result)).toMatchObject({
        code: 'host_payment_failed',
        message: `Payment submission failed: host HTTP ${status}. Keep the saved purchase and check status before retrying.`,
      });
    const submission = h.fetcher.mock.calls.find(
      ([, init]) => new Headers(init?.headers).get('PAYMENT-SIGNATURE') === 'signed-payment',
    );
    expect(String(submission?.[0])).toBe(url);
  } finally {
    await h.ws.remove();
  }
});

it('a saved purchase of the same file accepted on chain blocks a new buy until --force', async () => {
  const purchase = vi.fn(async () => ({}) as never);
  const h = await harness({ purchase });
  const earlier = purchaseRecord({ nonce: `0x${'45'.repeat(32)}` });
  await mkdir(join(h.ws.dir, 'records'), { recursive: true });
  await h.records().compareAndSet(purchaseKey(earlier.id), null, earlier);
  try {
    const error = await h.run(h.input()).catch((e) => e);
    expect(publicError(error)).toMatchObject({ code: 'purchase_open', exitCode: 2 });
    expect(purchase).toHaveBeenCalledWith('https://near.test', contract, earlier.id);
    expect(h.prompt).not.toHaveBeenCalled();
    expect(h.buy).not.toHaveBeenCalled();
    await expect(h.run(h.input({ force: true }))).resolves.toMatchObject({ state: 'submitted' });
    expect(h.buy).toHaveBeenCalledTimes(1);
  } finally {
    await h.ws.remove();
  }
});

it('an expired, unsettled saved purchase and other saved records do not block a new buy', async () => {
  const purchase = vi.fn(async () => null);
  const h = await harness({ purchase });
  const expired = purchaseRecord({ nonce: `0x${'45'.repeat(32)}`, expiresAt: '1000' });
  await mkdir(join(h.ws.dir, 'records'), { recursive: true });
  await h.records().compareAndSet(purchaseKey(expired.id), null, expired);
  const raw = fileStore<EncryptedRecord>(join(h.ws.dir, 'records'));
  const recovery = recoveryRecord(`0x${'46'.repeat(32)}`);
  await encryptedRecoveryStore(raw, backupSecret).compareAndSet(
    `annon/recovery/${recovery.purchase_id}`,
    null,
    recovery,
  );
  try {
    await expect(h.run(h.input())).resolves.toMatchObject({ state: 'submitted' });
    expect(purchase).toHaveBeenCalledWith('https://near.test', contract, expired.id);
    expect(purchase).toHaveBeenCalledTimes(1);
    expect(h.buy).toHaveBeenCalledTimes(1);
  } finally {
    await h.ws.remove();
  }
});

it('a reservation whose record was never saved blocks a second buy inside its claim window', async () => {
  const h = await harness();
  const record = purchaseRecord({ headerHash: h.sealed.headerHash });
  h.buy.mockImplementationOnce(async (o) => {
    await o.beforeSave?.(record);
    throw new Error('interrupted before the record was saved');
  });
  try {
    await expect(h.run(h.input())).rejects.toThrow('interrupted');
    expect((await h.guard()).value).toMatchObject({ owner: null, purchases: [record.id] });
    const error = await h.run(h.input()).catch((e) => e);
    expect(publicError(error)).toMatchObject({ code: 'purchase_open', exitCode: 2 });
    expect(h.buy).toHaveBeenCalledTimes(1);
  } finally {
    await h.ws.remove();
  }
});

it.each(['renewed', 'conflicting'] as const)(
  'a long buy keeps its reservation alive every 30 seconds (%s guard)',
  async (mode) => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const h = await harness();
    const record = purchaseRecord({ headerHash: h.sealed.headerHash });
    const save = saving(record);
    let start = -1;
    h.buy.mockImplementation(async (o, sdk) => {
      const before = await h.guard();
      start = before.value.revision;
      if (mode === 'conflicting')
        await writeFile(
          before.path,
          JSON.stringify({ ...before.value, revision: before.value.revision + 10 }),
        );
      await vi.advanceTimersByTimeAsync(30000);
      if (mode === 'renewed') {
        // Wait for the renewal itself to land, however long it takes; the test timeout bounds it.
        while ((await h.guard()).value.revision === start)
          await new Promise((resolve) => setImmediate(resolve));
        expect((await h.guard()).value).toMatchObject({
          revision: start + 1,
          owner: expect.any(String),
        });
      }
      // A conflicting renewal needs no wait: the guard applies updates in order, so the save
      // checkpoint fails with store_conflict whether or not the renewal has failed yet.
      return save(o, sdk);
    });
    try {
      const result = await h.run(h.input()).catch((e) => e);
      if (mode === 'renewed') {
        expect(result).toMatchObject({ state: 'submitted' });
        // Renewal, the checkpoint, the saved purchase and the release: four updates.
        expect((await h.guard()).value).toMatchObject({
          revision: start + 4,
          owner: null,
          purchases: [record.id],
        });
      } else {
        expect(publicError(result)).toMatchObject({ code: 'store_conflict', exitCode: 4 });
        // The failed renewal stops the purchase at its save checkpoint.
        expect(await h.records().load(purchaseKey(record.id))).toBeNull();
        expect((await h.guard()).value.revision).toBe(start + 10);
      }
    } finally {
      await h.ws.remove();
    }
  },
);

it.each([
  ['within', '0.2', true],
  ['beyond', '0.1', false],
] as const)(
  'an agent NEAR buy reserves the price %s its daily budget',
  async (_name, dailyBudget, ok) => {
    const h = await harness({ agent: true, config: { maxPrice: '0.3', dailyBudget } });
    try {
      const result = await h.run(h.input()).catch((e) => e);
      if (ok) {
        expect(result).toMatchObject({ state: 'submitted', route: 'near', payment: nearPayment });
        expect(await h.budget()).toMatchObject({ daily: '200000' });
        expect(h.buy.mock.calls[0]?.[0]).toMatchObject({ maxPrice: 300000n, url });
      } else {
        expect(publicError(result)).toMatchObject({ code: 'budget_exceeded' });
        expect(await h.budget()).toBeNull();
        expect(h.buy).not.toHaveBeenCalled();
      }
      // Agents never get a confirmation prompt; the terms still reach the policy hook.
      expect(h.prompt).not.toHaveBeenCalled();
      expect(h.paymentTerms).toHaveBeenCalledWith(expect.objectContaining({ price: '200000' }));
    } finally {
      await h.ws.remove();
    }
  },
);

const quote = (amount: string): OneClickQuote => ({
  request: {} as OneClickQuote['request'],
  response: {},
  deposit: {
    address: `0x${'13'.repeat(20)}`,
    amount,
    asset: sourceAsset,
    chain: 'evm',
    qrData: 'synthetic',
    depositBefore: '2030-01-01T00:00:00.000Z',
    purchaseExpiresAt: '2030-01-01T01:00:00.000Z',
  },
});

it.each([
  ['a USDC quote within maxPrice', { usdcDecimals: 6 }, '200000', null, '200000'],
  ['a USDC quote above maxPrice', { usdcDecimals: 6 }, '300001', 'price_above_max', null],
  ['a quote above the origin cap', { maxSourceAmount: '1000' }, '1001', 'price_above_max', null],
  ['a quote within the origin cap', { maxSourceAmount: '5000' }, '4000', null, '200000'],
] as const)(
  'an agent 1Click buy checks %s before reserving its budget',
  async (_name, policy, amount, code, reserved) => {
    const origin = {
      fromChain: 'base',
      fromAsset: sourceAsset,
      refundTo: `0x${'12'.repeat(20)}`,
      ...policy,
    };
    const h = await harness({
      agent: true,
      config: { maxPrice: '0.3', dailyBudget: '1', origins: { base: origin } },
    });
    const record = purchaseRecord({ headerHash: h.sealed.headerHash });
    const save = saving(record, { instructions: quote(amount).deposit });
    h.buy.mockImplementation(async (o, sdk) => {
      await o.onQuote?.(quote(amount));
      return save(o, sdk);
    });
    try {
      const result = await h.run(h.input({ origin: 'base' })).catch((e) => e);
      const options = h.buy.mock.calls[0]?.[0];
      expect(options).toMatchObject({
        route: '1click',
        origin: { asset: sourceAsset, chain: 'evm', refundTo: origin.refundTo },
      });
      expect(options).not.toHaveProperty('payer');
      const source = {
        ...('usdcDecimals' in policy ? { symbol: 'USDC', decimals: 6 } : {}),
        chain: 'base',
        asset: sourceAsset,
        amount,
        ...('usdcDecimals' in policy ? { amountFormatted: (Number(amount) / 1e6).toString() } : {}),
        depositBefore: '2030-01-01T00:00:00.000Z',
      };
      if (code === null) {
        expect(result).toMatchObject({
          state: 'deposit_required',
          route: '1click',
          instructions: quote(amount).deposit,
          source,
        });
        expect(h.paymentTerms).toHaveBeenCalledWith(
          expect.objectContaining({ route: '1click', source }),
        );
        expect(await h.budget()).toMatchObject({ daily: reserved });
      } else {
        expect(publicError(result)).toMatchObject({ code, exitCode: 2 });
        expect(h.paymentTerms).not.toHaveBeenCalled();
        expect(await h.budget()).toBeNull();
      }
    } finally {
      await h.ws.remove();
    }
  },
);

it('an agent 1Click buy that fails after the quote returns its budget reservation', async () => {
  const origin = {
    fromChain: 'base',
    fromAsset: sourceAsset,
    refundTo: `0x${'12'.repeat(20)}`,
    usdcDecimals: 6,
  };
  const h = await harness({
    agent: true,
    config: { maxPrice: '0.3', dailyBudget: '0.2', origins: { base: origin } },
  });
  const record = purchaseRecord({ headerHash: h.sealed.headerHash });
  const save = saving(record, { instructions: quote('200000').deposit });
  h.buy.mockImplementationOnce(async (o) => {
    await o.onQuote?.(quote('200000'));
    throw new Error('quote could not be saved');
  });
  h.buy.mockImplementationOnce(async (o, sdk) => {
    await o.onQuote?.(quote('200000'));
    return save(o, sdk);
  });
  try {
    await expect(h.run(h.input({ origin: 'base' }))).rejects.toThrow('quote could not be saved');
    expect(await h.budget()).toMatchObject({ daily: '0' });
    // The whole daily budget is available again for the retry.
    await expect(h.run(h.input({ origin: 'base' }))).resolves.toMatchObject({
      state: 'deposit_required',
    });
    expect(await h.budget()).toMatchObject({ daily: '200000' });
  } finally {
    await h.ws.remove();
  }
});

it.each([
  ['network', { network: 'near:testnet' }],
  ['contract', { contract: 'other.near' }],
] as const)(
  'a buy refuses a listing registered for another %s before any wallet or payment',
  async (_name, change) => {
    const h = await harness();
    const listed = { ...h.sealed.info, terms: { ...h.sealed.info.terms, ...change } };
    const file = vi.fn(async () => listed);
    const run = createAdapter(
      { ANNON_CONFIG: h.ws.config, ANNON_BACKUP_SECRET: backupSecretHex },
      {
        fetch: h.fetcher,
        prompt: h.prompt,
        paymentTerms: h.paymentTerms,
        wallet: h.wallet,
        file,
        purchase: async () => null,
        sdk: (options) => {
          const sdk = new Annon(options);
          vi.spyOn(sdk, 'buy').mockImplementation((o) => h.buy(o, sdk));
          return sdk;
        },
      },
    );
    try {
      const error = await run(h.input()).catch((e) => e);
      expect(error).toBeInstanceOf(Error);
      expect(error.message).toBe('deployment mismatch');
      expect(publicError(error)).toMatchObject({ code: 'operation_failed', exitCode: 1 });
      expect(file).toHaveBeenCalledWith('https://near.test', contract, fileId);
      expect(h.wallet).not.toHaveBeenCalled();
      expect(h.prompt).not.toHaveBeenCalled();
      expect(h.paymentTerms).not.toHaveBeenCalled();
      expect(h.buy).not.toHaveBeenCalled();
    } finally {
      await h.ws.remove();
    }
  },
);
