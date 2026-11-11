import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { privateKeyToAccount } from 'viem/accounts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Annon, type AnnonOptions, SellError } from '../../annon/src/api/annon.js';
import { parseHeader, sealWithKey, sha256 } from '../../annon/src/envelope/pay2.js';
import { keyFromSecret } from '../../annon/src/keys/near-ckd.js';
import type { FileInfo } from '../../annon/src/near/rpc.js';
import * as rpcModule from '../../annon/src/near/rpc.js';
import * as adapterModule from '../../annon/src/node/adapter.js';
import { createAdapter } from '../../annon/src/node/adapter.js';
import type { BudgetRecord } from '../../annon/src/node/budget.js';
import type { Input } from '../../annon/src/node/cli.js';
import { runCli } from '../../annon/src/node/cli.js';
import { type OneClickQuote, OneClickQuoteExpired } from '../../annon/src/oneclick/oneclick.js';
import {
  encryptedPurchaseStore,
  exportPurchase,
  exportRecovery,
  importPurchase,
  type RecoveryRecord,
} from '../../annon/src/pay/backup.js';
import { block } from '../../annon/src/pay/base.js';
import { type PurchaseRecord, purchaseKey } from '../../annon/src/pay/purchase.js';
import { paymentRequired } from '../../annon/src/pay/seller.js';
import { fileStore } from '../../annon/src/pay/store-node.js';
import { bytes, hex } from '../../annon/src/settle-near/codec.js';
import { parseIdentity } from '../../annon/src/settle-near/identity.js';
import {
  baseNonceV2,
  buildPurchaseMessage,
  purchaseId,
} from '../../annon/src/settle-near/purchase.js';
import { termsHash } from '../../annon/src/settle-near/terms.js';
import type { NearWallet } from '../../annon/src/wallet/wallet.js';
import { must, purchase, terms } from '../../annon/test/fixtures.js';
import { createServer } from './server.js';

const directories: string[] = [];
afterEach(async () => {
  for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});
async function harness(
  agent = true,
  prompt?: (message: string) => Promise<boolean>,
  unsafeUnlock = false,
  buyerWallet?: import('../../annon/src/node/wallets.js').LocalWallet,
  realBuy = false,
  afterBuy?: (sdk: Annon, options: AnnonOptions) => void | Promise<void>,
) {
  const dir = await mkdtemp(join(tmpdir(), 'annon-mcp-'));
  directories.push(dir);
  await writeFile(join(dir, 'config.json'), JSON.stringify({ dailyBudget: '10' }));
  const contractConfig = {
    network: terms.network,
    nearUsdc: terms.near.token,
    usdc: must(terms.base).usdc,
    mpc: 'v1.signer',
    ckdDomain: 0,
    foreignTxDomain: 0,
    intents: 'intents.near',
  };
  vi.spyOn(rpcModule, 'getConfig').mockImplementation(async () => contractConfig);
  const account = privateKeyToAccount(`0x${'42'.repeat(32)}`);
  const baseSplit = {
    address: must(terms.base).pay_to,
    kind: 'push' as const,
    salt: `0x${'01'.repeat(32)}`,
  };
  const wallet = {
    identity: { kind: 'evm' as const, id: account.address.toLowerCase() },
    authorize: async (text: string) => ({
      kind: 'evm' as const,
      sig: await account.signMessage({ message: text }),
    }),
    signTypedData: vi.fn(),
    sendBase: vi.fn(),
  };
  const data = new TextEncoder().encode('private purchased content');
  const sealed = await sealWithKey(new Uint8Array(32).fill(5), data, {
    fileId: bytes(terms.file_id, 32),
    name: 'file.txt',
    mime: 'text/plain',
    authKind: 0,
  });
  const file = await sealed.finish({
    contractId: terms.contract,
    ckdSecret: new Uint8Array(48).fill(3),
    seller: wallet.identity,
    sign: async (text: string) => account.signMessage({ message: text }),
  });
  const header = file.subarray(0, parseHeader(file).headerLen);
  const finalTerms = {
    ...structuredClone(terms),
    cipher_hash: hex(sealed.cipherHash),
    seller: wallet.identity,
  };
  const f: FileInfo = {
    terms: finalTerms,
    termsHash: termsHash(finalTerms),
    seller: wallet.identity,
    price: BigInt(must(terms.base).price),
    payTo: must(terms.base).pay_to,
    cipherHash: finalTerms.cipher_hash,
    moderator: null,
    headerHash: null,
    salesStoppedAt: null,
    takenDown: null,
  };
  const offer = paymentRequired(
    {
      nearRpc: 'https://rpc.example',
      contractId: terms.contract,
      fileId: terms.file_id,
      url: 'https://files.example/file',
      header: 'https://files.example/header',
    },
    f,
    must(terms.base).usdc,
  );
  const offerFile = join(dir, 'offer.json');
  await writeFile(offerFile, JSON.stringify(offer));
  const localFile = join(dir, 'file.pay2');
  await writeFile(localFile, file);
  const plaintext = join(dir, 'file.txt');
  await writeFile(plaintext, data);
  const calls: { command: string; args: unknown }[] = [];
  let sdk: Annon;
  let options: AnnonOptions;
  let saved: PurchaseRecord | undefined;
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    if (String(url) === 'https://files.example/file' && !init?.headers)
      return Response.json(offer, {
        status: 402,
        headers: { 'PAYMENT-REQUIRED': Buffer.from(JSON.stringify(offer)).toString('base64') },
      });
    if (String(url).endsWith('/header')) return new Response(header);
    if (String(url).endsWith('/quote'))
      return Response.json({
        quoteRequest: JSON.parse(String(init?.body)),
        quote: {
          deadline: JSON.parse(String(init?.body)).deadline,
          timeEstimate: 35,
          amountIn: '210000',
          amountOut: '200000',
          depositAddress: 'deposit-address',
          depositMemo: '123',
        },
      });
    if (init?.headers && 'PAYMENT-SIGNATURE' in init.headers)
      return new Response(null, { status: 503 });
    throw new Error('Unexpected network access');
  });
  const env = {
    ANNON_CONFIG: join(dir, 'config.json'),
    ANNON_STATE_DIR: dir,
    ANNON_MAX_PRICE: '0.2',
    ANNON_ORIGINS: JSON.stringify({
      'base-usdc': { fromChain: 'base', fromAsset: 'nep141:base-usdc' },
    }),
    ANNON_ALLOWED_RESOURCES: 'https://files.example/file',
    ANNON_BACKUP_SECRET: 'ab'.repeat(32),
    ANNON_EVM_PRIVATE_KEY: `0x${'42'.repeat(32)}`,
  };
  const wait = vi.fn(async (_ms: number) => {});
  const notify = vi.fn();
  const reviews: unknown[] = [];
  const adapter = createAdapter(env, {
    agent,
    ...(prompt ? { prompt } : {}),
    wait,
    notify,
    paymentTerms: (review) => reviews.push(review),
    wallet: async () => buyerWallet ?? wallet,
    file: async () => f,
    purchase: async (_rpc, _contract, id) => ({
      purchase_id: id,
      file_id: terms.file_id,
      terms_hash: f.termsHash,
      buyer_key: purchase.buyer_key,
      recovery: wallet.identity,
      route: 'near-usdc',
      delivery: 1,
      accepted_at: 1,
      grants: 2,
    }),
    fetch: fetcher,
    sdk(o) {
      options = o;
      sdk = new Annon(o);
      vi.spyOn(sdk, 'sell').mockImplementation(async (args) => {
        calls.push({ command: 'sell', args });
        await args.publish({ file, header, terms: finalTerms });
        return { file, header, terms: finalTerms, baseSplit, preview: sealed.preview };
      });
      vi.spyOn(sdk, 'resumeSell').mockImplementation(async (args) => {
        calls.push({ command: 'resumeSell', args });
        await args.publish({ file, header, terms: finalTerms });
        return { file, header, terms: finalTerms, baseSplit, preview: sealed.preview };
      });
      if (!realBuy)
        vi.spyOn(sdk, 'buy').mockImplementation(async (args) => {
          calls.push({ command: 'buy', args });
          const base = args.payer?.identity.kind === 'evm';
          const p = {
            ...purchase,
            route: base ? ('base-usdc' as const) : ('near-usdc' as const),
            network: base ? 'eip155:8453' : terms.network,
            asset: base ? must(terms.base).usdc : terms.near.token,
            price: base ? must(f.terms.base).price : f.terms.near.price,
            buyer_key: hex(keyFromSecret(new Uint8Array(32).fill(6)).publicKeyBytes),
            recovery: args.recovery.identity,
            terms_hash: f.termsHash,
          };
          const id = purchaseId(p);
          const record: PurchaseRecord = {
            schemaVersion: 2,
            id,
            revision: 0,
            purchase: p,
            message: buildPurchaseMessage(p),
            buyerSecret: hex(new Uint8Array(32).fill(6)),
            recovery: p.recovery,
            quote: null,
            checkedHeaderHash: hex(await sha256(header)),
            terms: {
              network: p.network,
              contractId: p.contract,
              fileId: p.file_id,
              buyer: args.recovery.identity.id,
              seller: f.seller,
              to: p.contract,
              usdc: p.asset,
              price: p.price,
              buyerKey: p.buyer_key,
              nonce: base ? baseNonceV2(id) : p.nonce,
              headerHash: hex(await sha256(header)),
              cipherHash: f.cipherHash,
              moderator: null,
            },
            attempts: [],
          };
          saved = record;
          await sdk.store.compareAndSet(purchaseKey(id), null, record);
          if (args.origin) {
            const quote = must(await args.oneClick?.quote(record.message, args.origin));
            const next = { ...record, revision: record.revision + 1, quote };
            await sdk.store.compareAndSet(purchaseKey(id), record, next);
            saved = next;
            await args.onQuote?.(quote);
            await afterBuy?.(sdk, o);
            return { route: p.route, record: next, instructions: quote.deposit };
          }
          await args.submitBase?.('SIGNED_PAYMENT_PAYLOAD');
          await afterBuy?.(sdk, o);
          return { route: p.route, record, payment: 'SIGNED_PAYMENT_PAYLOAD' };
        });
      vi.spyOn(sdk, 'accept').mockImplementation(async () => {
        if (unsafeUnlock) await o.send?.('unlock', { args: {} });
        return true;
      });
      vi.spyOn(sdk, 'open').mockImplementation(async (args) => {
        calls.push({ command: 'open', args });
        return { meta: { name: 'file.txt', mime: 'text/plain', size: data.length }, data };
      });
      vi.spyOn(sdk, 'recover').mockImplementation(async (args) => {
        calls.push({ command: 'recover', args });
        const r: RecoveryRecord = {
          kind: 'recovery',
          id: `recovery:${must(saved).id}`,
          revision: 0,
          purchase_id: must(saved).id,
          file_id: terms.file_id,
          recovery: wallet.identity,
          buyerSecret: hex(new Uint8Array(32).fill(8)),
          fresh_key: hex(keyFromSecret(new Uint8Array(32).fill(8)).publicKeyBytes),
          nonce: hex(new Uint8Array(32).fill(9)),
          deadline: 1800000000,
          grant: 1,
        };
        await o.writeBackup(r.id, await exportRecovery(r, o.backupSecret));
        return [r];
      });
      return sdk;
    },
  });
  const deployment = {
    contractId: terms.contract,
    nearRpc: 'https://rpc.example',
    baseRpc: 'https://base.example',
    config: join(dir, 'config.json'),
    trustContract: true,
    wallet: 'evm' as const,
    url: 'https://files.example/file',
  };
  await writeFile(
    env.ANNON_CONFIG,
    JSON.stringify({
      ...deployment,
      dailyBudget: '10',
      maxPrice: '0.2',
      stateDir: dir,
      workDir: dir,
      allowedResources: [env.ANNON_ALLOWED_RESOURCES],
    }),
  );
  const defaults: Partial<Input> & { config: string; url: string; wallet: 'evm' } = agent
    ? { config: env.ANNON_CONFIG, wallet: 'evm' as const, url: deployment.url }
    : deployment;
  return {
    dir,
    adapter,
    defaults,
    calls,
    plaintext,
    localFile,
    offerFile,
    data,
    env,
    fetcher,
    file,
    header,
    agent: true,
    wait,
    notify,
    reviews,
    listing: f,
    baseSplit,
    contractConfig,
    get options() {
      return options;
    },
    get saved() {
      return must(saved);
    },
  };
}
async function connect(execute: (o: Input) => Promise<Record<string, unknown>>) {
  const server = createServer(execute);
  const client = new Client({ name: 'test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

it.each(['near', 'base', '1click'] as const)(
  'reports verified %s payment amounts through CLI and MCP, saved status and open',
  async (route) => {
    for (const transport of ['cli', 'mcp']) {
      const buyer =
        route === 'near'
          ? { identity: { kind: 'near' as const, id: 'buyer.testnet' }, authorize: vi.fn() }
          : undefined;
      const h = await harness(true, undefined, false, buyer);
      must(h.listing.terms.base).price = '123456';
      const expected = {
        amountUsdc: route === 'base' ? '0.123456' : '0.2',
        amountBaseUnits: route === 'base' ? '123456' : '200000',
        asset: {
          symbol: 'USDC',
          id: route === 'base' ? must(terms.base).usdc : terms.near.token,
        },
        network: route === 'base' ? 'eip155:8453' : terms.network,
        route,
        ...(route === '1click'
          ? {
              source: {
                chain: 'base',
                asset: 'nep141:base-usdc',
                amount: '210000',
                depositBefore: expect.any(String),
              },
            }
          : {}),
      };
      const connection = await connect((o) => h.adapter({ ...h.defaults, ...o }));
      try {
        const call = async (command: 'buy' | 'status' | 'open', args: Record<string, unknown>) => {
          if (transport === 'mcp') {
            const response = await connection.client.callTool({
              name: `annon_${command}`,
              arguments: args,
            });
            expect(response.isError, JSON.stringify(response)).not.toBe(true);
            return (response.structuredContent as { result: Record<string, unknown> }).result;
          }
          const printed: string[] = [];
          expect(
            await runCli(
              [command, String(args.target), '--json'],
              (o) => h.adapter({ ...h.defaults, ...o, ...args }),
              (s) => printed.push(s),
            ),
          ).toBe(0);
          return JSON.parse(must(printed[0])).result as Record<string, unknown>;
        };
        const bought = await call('buy', {
          target: h.defaults.url,
          url: h.defaults.url,
          route,
          ...(route === '1click' ? { origin: 'base-usdc' } : {}),
        });
        expect(bought.payment).toEqual(expected);
        const backup = await importPurchase(
          await readFile(String(bought.backup), 'utf8'),
          h.options.backupSecret,
        );
        expect(backup.payment).toEqual(bought.payment);
        const store = encryptedPurchaseStore(h.options.rawStore, h.options.backupSecret);
        const saved = must(await store.load(purchaseKey(String(bought.purchaseId))));
        // Cached summaries are projected, never returned wholesale with unexpected fields.
        const withExtraFields = {
          ...saved,
          revision: saved.revision + 1,
          payment: {
            ...must(saved.payment),
            amountUsdc: 'HOST_TEXT',
            authorization: 'SIGNED_PAYMENT_PAYLOAD',
            ...(saved.payment?.source
              ? { source: { ...saved.payment.source, address: 'deposit-address' } }
              : {}),
          },
        };
        await store.compareAndSet(purchaseKey(saved.id), saved, withExtraFields);
        const status = await call('status', { target: bought.purchaseId });
        const opened = await call('open', {
          target: bought.purchaseId,
          file: h.localFile,
          output: join(h.dir, 'payment-output.txt'),
        });
        for (const result of [status, opened]) {
          expect(result.payment).toEqual(expected);
          expect(JSON.stringify(result)).not.toMatch(
            /deposit-address|SIGNED_PAYMENT_PAYLOAD|buyerSecret/,
          );
        }

        // Simulate an older backup and encrypted record without the new optional field.
        const legacy: PurchaseRecord = {
          ...withExtraFields,
          revision: withExtraFields.revision + 1,
        };
        delete legacy.payment;
        await store.compareAndSet(purchaseKey(saved.id), withExtraFields, legacy);
        const legacyBackup = join(h.dir, 'legacy.json');
        await writeFile(legacyBackup, await exportPurchase(legacy, h.options.backupSecret));
        const { source: _, ...legacyExpected } = expected;
        expect((await call('status', { target: saved.id })).payment).toEqual(legacyExpected);
        expect(
          (
            await call('open', {
              target: legacyBackup,
              file: h.localFile,
              output: join(h.dir, 'legacy-output.txt'),
            })
          ).payment,
        ).toEqual(legacyExpected);
      } finally {
        await connection.close();
      }
    }
  },
);

it.each([false, true])(
  'pending status only includes a retry hint when no human setup is needed (saved secret %s)',
  async (secret) => {
    const h = await harness();
    const bought = await h.adapter({
      ...h.defaults,
      command: 'buy',
      target: h.defaults.url,
      route: '1click',
      origin: 'base-usdc',
    });
    vi.spyOn(rpcModule, 'getPurchase').mockResolvedValue(null);
    const { ANNON_BACKUP_SECRET: _secret, ...publicEnv } = h.env;
    const env = secret ? h.env : publicEnv;
    const execute = createAdapter(env, { agent: true, purchase: async () => null });
    const { wallet: _, ...defaults } = h.defaults;
    const connection = await connect((o) => execute({ ...defaults, ...o }));
    try {
      const result = await connection.client.callTool({
        name: 'annon_status',
        arguments: { target: bought.purchaseId },
      });
      expect(result.structuredContent).toMatchObject({
        ok: true,
        result: { state: 'pending' },
      });
      const status = result.structuredContent as { result: Record<string, unknown> };
      if (secret) expect(status.result.retryAfterSeconds).toBe(30);
      else expect(status.result).not.toHaveProperty('retryAfterSeconds');
      const printed: string[] = [];
      expect(
        await runCli(
          ['status', String(bought.purchaseId), '--json'],
          (o) => execute({ ...defaults, ...o }),
          (s) => printed.push(s),
        ),
      ).toBe(4);
      expect(JSON.parse(must(printed[0]))).toMatchObject({
        ok: true,
        result: { state: 'pending' },
      });
      if (!secret)
        expect(JSON.parse(must(printed[0])).result).not.toHaveProperty('retryAfterSeconds');
    } finally {
      await connection.close();
    }
  },
);

it.each([
  'wrong secret',
  'no secret',
  'invalid secret',
  'missing secret file',
  'missing record',
  'corrupt record',
])('accepted status survives %s without a payment summary', async (failure) => {
  const h = await harness();
  const bought = await h.adapter({
    ...h.defaults,
    command: 'buy',
    target: h.defaults.url,
    route: 'base',
  });
  if (failure === 'wrong secret') h.env.ANNON_BACKUP_SECRET = 'cd'.repeat(32);
  if (failure === 'no secret') Reflect.deleteProperty(h.env, 'ANNON_BACKUP_SECRET');
  if (failure === 'invalid secret') h.env.ANNON_BACKUP_SECRET = 'invalid';
  if (failure === 'missing secret file') {
    Reflect.set(h.env, 'ANNON_BACKUP_SECRET_FILE', join(h.dir, 'missing-secret'));
  }
  const raw = fileStore<import('../../annon/src/pay/backup.js').EncryptedRecord>(
    join(h.dir, 'records'),
  );
  const key = purchaseKey(String(bought.purchaseId));
  const saved = must(await raw.load(key));
  if (failure === 'missing record') await raw.compareAndSet(key, saved, null);
  if (failure === 'corrupt record')
    await raw.compareAndSet(key, saved, {
      ...saved,
      revision: saved.revision + 1,
      backup: 'invalid',
    });
  const connection = await connect((o) => h.adapter({ ...h.defaults, ...o }));
  try {
    const result = await connection.client.callTool({
      name: 'annon_status',
      arguments: { target: bought.purchaseId },
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      ok: true,
      result: { state: 'accepted', purchaseId: bought.purchaseId },
    });
    expect((result.structuredContent as { result: object }).result).not.toHaveProperty('payment');
  } finally {
    await connection.close();
  }
  const execute = createAdapter(h.env, {
    agent: true,
    purchase: async () => null,
    fetch: async () => {
      throw new Error('unexpected network access');
    },
  });
  const pending = await execute({
    ...h.defaults,
    command: 'status',
    target: String(bought.purchaseId),
  });
  expect(pending).toMatchObject({ state: 'pending', purchaseId: bought.purchaseId });
  expect(pending).not.toHaveProperty('payment');
  expect(pending).not.toHaveProperty('retryAfterSeconds');
});

it.each(['wrong secret', 'missing record', 'corrupt record'])(
  'writes recovery plaintext before best-effort payment lookup with %s',
  async (failure) => {
    const h = await harness();
    const bought = await h.adapter({
      ...h.defaults,
      command: 'buy',
      target: h.defaults.url,
      route: 'base',
    });
    // The replacement secret protects a fresh recovery grant; the original purchase secret is unavailable.
    h.env.ANNON_BACKUP_SECRET = 'cd'.repeat(32);
    const recovered = await h.adapter({
      ...h.defaults,
      command: 'recover',
      recovery: `evm:${h.saved.recovery.id}`,
      purchase: String(bought.purchaseId),
    });
    const backup = must((recovered.recovered as { backup: string }[])[0]).backup;
    const raw = fileStore<import('../../annon/src/pay/backup.js').EncryptedRecord>(
      join(h.dir, 'records'),
    );
    const key = purchaseKey(String(bought.purchaseId));
    const saved = must(await raw.load(key));
    if (failure === 'missing record') await raw.compareAndSet(key, saved, null);
    if (failure === 'corrupt record')
      await raw.compareAndSet(key, saved, {
        ...saved,
        revision: saved.revision + 1,
        backup: 'invalid',
      });
    const output = join(h.dir, 'recovery-output.txt');
    let lookedUpAfterWrite = false;
    const original = adapterModule.createAdapter;
    const execute = original(h.env, {
      agent: true,
      fetch: h.fetcher,
      sdk(options) {
        const sdk = new Annon(options);
        vi.spyOn(sdk, 'accept').mockResolvedValue(true);
        vi.spyOn(sdk, 'open').mockResolvedValue({
          meta: { name: 'file.txt', mime: 'text/plain', size: h.data.length },
          data: h.data,
        });
        const load = sdk.store.load.bind(sdk.store);
        vi.spyOn(sdk.store, 'load').mockImplementation(async (name) => {
          // The optional lookup must occur only after the useful work is durable.
          expect(await readFile(output)).toEqual(Buffer.from(h.data));
          lookedUpAfterWrite = true;
          return load(name);
        });
        return sdk;
      },
    });
    const { wallet: _, ...defaults } = h.defaults;
    const result = await execute({
      ...defaults,
      command: 'open',
      target: backup,
      file: h.localFile,
      output,
    });
    expect(result).toMatchObject({
      bytes: h.data.length,
      purchaseId: bought.purchaseId,
      output: await realpath(output),
    });
    expect(result).not.toHaveProperty('payment');
    expect(await readFile(output)).toEqual(Buffer.from(h.data));
    expect(lookedUpAfterWrite).toBe(true);
  },
);

it('drops invalid encrypted source metadata in status and open without losing the price', async () => {
  const h = await harness();
  const bought = await h.adapter({
    ...h.defaults,
    command: 'buy',
    target: h.defaults.url,
    route: '1click',
    origin: 'base-usdc',
  });
  const store = encryptedPurchaseStore(h.options.rawStore, h.options.backupSecret);
  const saved = must(await store.load(purchaseKey(String(bought.purchaseId))));
  const payment = must(saved.payment);
  const next = {
    ...saved,
    revision: saved.revision + 1,
    payment: { ...payment, source: { ...must(payment.source), decimals: 256 } },
  };
  await store.compareAndSet(purchaseKey(saved.id), saved, next);
  const status = await h.adapter({ ...h.defaults, command: 'status', target: saved.id });
  const opened = await h.adapter({
    ...h.defaults,
    command: 'open',
    target: saved.id,
    file: h.localFile,
    output: join(h.dir, 'invalid-source.txt'),
  });
  for (const result of [status, opened]) {
    expect(result.payment).toMatchObject({ amountUsdc: '0.2', route: '1click' });
    expect(result.payment).not.toHaveProperty('source');
  }
});

it.each(['near', 'base', '1click'] as const)(
  'returns the completed %s purchase when optional metadata persistence fails',
  async (route) => {
    for (const failure of ['CAS conflict', 'CAS rejection', 'backup write']) {
      for (const transport of ['cli', 'mcp']) {
        const buyer =
          route === 'near'
            ? { identity: { kind: 'near' as const, id: terms.contract }, authorize: vi.fn() }
            : undefined;
        let metadataWrite = vi.fn();
        const h = await harness(true, undefined, false, buyer, false, (sdk, options) => {
          metadataWrite = vi.spyOn(sdk.store, 'compareAndSet');
          if (failure === 'CAS conflict') metadataWrite.mockResolvedValue(false);
          if (failure === 'CAS rejection')
            metadataWrite.mockRejectedValue(new Error('private metadata failure'));
          if (failure === 'backup write')
            options.writeBackup = async () => {
              throw new Error('private backup failure');
            };
        });
        await patchConfig(h.defaults.config, { dailyBudget: '0.2' });
        const args = {
          target: h.defaults.url,
          url: h.defaults.url,
          route,
          ...(route === '1click' ? { origin: 'base-usdc' } : {}),
        };
        const connection = await connect((o) => h.adapter({ ...h.defaults, ...o }));
        let result: Record<string, unknown>;
        try {
          if (transport === 'mcp') {
            const response = await connection.client.callTool({
              name: 'annon_buy',
              arguments: args,
            });
            expect(response.isError, JSON.stringify(response)).not.toBe(true);
            result = (response.structuredContent as { result: Record<string, unknown> }).result;
          } else {
            const printed: string[] = [];
            expect(
              await runCli(
                ['buy', h.defaults.url, '--json'],
                (o) => h.adapter({ ...h.defaults, ...o, ...args }),
                (s) => printed.push(s),
              ),
            ).toBe(0);
            result = JSON.parse(must(printed[0])).result;
          }
          expect(result).toMatchObject({ purchaseId: h.saved.id, payment: { route } });
          expect(metadataWrite).toHaveBeenCalledTimes(1);
          if (route === '1click')
            expect(result.instructions).toMatchObject({
              address: 'deposit-address',
              amount: '210000',
            });
          else
            expect(
              h.fetcher.mock.calls.some(
                ([, init]) => init?.headers && 'PAYMENT-SIGNATURE' in init.headers,
              ),
            ).toBe(true);
          expect(JSON.stringify(result)).not.toContain('private');
          expect(
            await fileStore<BudgetRecord>(join(h.dir, 'budgets')).load('agent:USDC'),
          ).toMatchObject({ daily: '200000', hourly: '200000' });
          await expect(h.adapter({ ...h.defaults, command: 'buy', ...args })).rejects.toMatchObject(
            { code: 'budget_exceeded' },
          );
        } finally {
          await connection.close();
        }
      }
    }
  },
);

it.each(['packages/annon-mcp/README.md', 'skills/annon/SKILL.md'])(
  'documents the two route meanings in %s',
  async (file) => {
    const text = await readFile(new URL(`../../../${file}`, import.meta.url), 'utf8');
    expect(text).toContain(
      'Top-level `route` is the contract route (`near-usdc`/`base-usdc`); `payment.route` is how the buyer paid (`near`/`base`/`1click`).',
    );
  },
);

it('keeps the skill buy examples together before the URL rule', async () => {
  const text = await readFile(new URL('../../../skills/annon/SKILL.md', import.meta.url), 'utf8');
  const examples = text.indexOf('Buy directly with NEAR USDC');
  const code = text.indexOf('```sh', examples);
  const end = text.indexOf('```', code + 5);
  expect(text.indexOf('URLs accept HTTPS', examples)).toBeGreaterThan(end);
});

it('creates the production MCP adapter in agent mode', async () => {
  const factory = vi.spyOn(adapterModule, 'createAdapter').mockReturnValue(async () => ({}));
  const server = createServer();
  try {
    expect(factory).toHaveBeenCalledExactlyOnceWith(process.env, { agent: true });
  } finally {
    await server.close();
  }
});

it.each(['refundTo', 'fromChain', 'fromAsset'] as const)(
  'the adapter directly refuses agent-controlled %s',
  async (field) => {
    const h = await harness();
    await expect(
      h.adapter({
        ...h.defaults,
        command: 'buy',
        target: h.defaults.url,
        [field]: 'attacker',
      }),
    ).rejects.toMatchObject({ code: 'origin_not_allowed' });
    expect(h.calls).toEqual([]);
    expect(h.fetcher).not.toHaveBeenCalled();
  },
);

it.each(['offer file', 'HTTPS URL'])(
  'the adapter directly refuses an unapproved %s resource',
  async (source) => {
    const h = await harness();
    await expect(
      h.adapter({
        ...h.defaults,
        command: 'buy',
        target: source === 'offer file' ? h.offerFile : 'https://attacker.example/file',
        url: 'https://attacker.example/file',
      }),
    ).rejects.toMatchObject({ code: 'resource_not_allowed' });
    expect(h.calls).toEqual([]);
    expect(h.fetcher).not.toHaveBeenCalled();
  },
);

describe('stdio MCP tools through SDK adapters (no network)', () => {
  it('publishes strict schemas and routes sell, buy, open, recover, verify and status without secrets', async () => {
    const h = await harness();
    const log = vi.spyOn(console, 'log');
    const error = vi.spyOn(console, 'error');
    const connection = await connect((o) => h.adapter({ ...h.defaults, ...o }));
    const { client } = connection;
    try {
      const tools = (await client.listTools()).tools;
      expect(tools.map((t) => t.name).sort()).toEqual([
        'annon_buy',
        'annon_open',
        'annon_recover',
        'annon_sell',
        'annon_status',
        'annon_verify',
      ]);
      for (const tool of tools) {
        expect(tool.inputSchema.additionalProperties).toBe(false);
        expect(tool.outputSchema).toBeTruthy();
        expect(JSON.stringify(tool.inputSchema)).not.toContain('privateKey');
      }
      const results: unknown[] = [];
      const call = async (name: string, args: object) => {
        const result = await client.callTool({
          name,
          arguments: { ...args, ...(name === 'annon_buy' ? { url: h.defaults.url } : {}) },
        });
        expect(result.isError, JSON.stringify(result)).not.toBe(true);
        results.push(result);
        return result.structuredContent as { result: Record<string, unknown> };
      };
      const sold = await call('annon_sell', {
        target: h.plaintext,
        price: '0.2',
        split: `evm:${terms.seller.id}:10000`,
        output: join(h.dir, 'sold.pay2'),
        base: true,
      });
      expect(sold.result.fileId).toBe(terms.file_id);
      expect(sold.result.baseSplit).toEqual(h.baseSplit);
      expect(await readFile(join(h.dir, 'sold.pay2'))).toEqual(
        Buffer.from(await readFile(h.localFile)),
      );
      const bought = await call('annon_buy', {
        target: h.defaults.url,
        route: '1click',
        origin: 'base-usdc',
      });
      expect(bought.result).toMatchObject({
        state: 'deposit_required',
        route: 'near-usdc',
        instructions: { address: 'deposit-address', amount: '210000', memo: '123' },
      });
      const id = h.saved.id;
      await call('annon_open', {
        target: id,
        file: h.localFile,
        output: join(h.dir, 'opened.txt'),
      });
      expect(await readFile(join(h.dir, 'opened.txt'))).toEqual(Buffer.from(h.data));
      const recovered = await call('annon_recover', {
        recovery: `evm:${h.saved.recovery.id}`,
        purchase: id,
      });
      expect(recovered.result.recovered).toMatchObject([{ purchaseId: id, grant: 1 }]);
      const recovery = (recovered.result.recovered as { backup: string }[])[0];
      await call('annon_open', {
        target: must(recovery).backup,
        file: h.localFile,
        output: join(h.dir, 'recovered.txt'),
      });
      expect((await call('annon_verify', { target: h.localFile })).result).toMatchObject({
        verified: true,
        checked: 'header-and-body',
      });
      expect((await call('annon_status', { target: id })).result).toMatchObject({
        state: 'accepted',
        purchaseId: id,
      });
      const all = JSON.stringify(results);
      for (const value of [
        h.env.ANNON_EVM_PRIVATE_KEY,
        h.env.ANNON_BACKUP_SECRET,
        h.saved.buyerSecret,
        'SIGNED_PAYMENT_PAYLOAD',
        new TextDecoder().decode(h.data),
      ])
        expect(all).not.toContain(value);
      expect(log).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
    } finally {
      await connection.close();
    }
  });
  it('submits Base via the SDK without returning the authorization, and enforces tool schemas', async () => {
    const h = await harness();
    const connection = await connect((o) => h.adapter({ ...h.defaults, ...o }));
    try {
      const result = await connection.client.callTool({
        name: 'annon_buy',
        arguments: { target: h.defaults.url, url: h.defaults.url, route: 'base' },
      });
      expect(result.isError).not.toBe(true);
      expect(JSON.stringify(result)).not.toContain('SIGNED_PAYMENT_PAYLOAD');
      expect(
        h.fetcher.mock.calls.some(([, o]) => o?.headers && 'PAYMENT-SIGNATURE' in o.headers),
      ).toBe(true);
      const invalid = await connection.client.callTool({
        name: 'annon_buy',
        arguments: {
          target: h.defaults.url,
          route: 'invalid',
          privateKey: 'SECRET_VALUE',
        },
      });
      expect(invalid.isError).toBe(true);
      expect(JSON.stringify(invalid)).not.toContain('SECRET_VALUE');
    } finally {
      await connection.close();
    }
  });
  it.each([502, 409])(
    'returns host HTTP %i as an owned error through CLI and MCP',
    async (status) => {
      for (const mode of ['cli', 'mcp']) {
        const h = await harness();
        const original = must(h.fetcher.getMockImplementation());
        h.fetcher.mockImplementation(async (url, init) =>
          init?.headers && 'PAYMENT-SIGNATURE' in init.headers
            ? new Response('PRIVATE_UPSTREAM', { status })
            : original(url, init),
        );
        let result: unknown;
        if (mode === 'mcp') {
          const connection = await connect((o) => h.adapter({ ...h.defaults, ...o }));
          try {
            const response = await connection.client.callTool({
              name: 'annon_buy',
              arguments: { target: h.defaults.url, url: h.defaults.url, route: 'base' },
            });
            expect(response.isError).toBe(true);
            result = response.structuredContent;
          } finally {
            await connection.close();
          }
        } else {
          const output: string[] = [];
          const exit = await runCli(
            ['buy', h.defaults.url, '--route', 'base', '--json'],
            (o) => h.adapter({ ...h.defaults, ...o }),
            (s) => output.push(s),
          );
          expect(exit).toBe(1);
          result = JSON.parse(must(output[0]));
        }
        expect(result).toMatchObject({
          ok: false,
          error: { code: 'host_payment_failed', message: expect.stringContaining(String(status)) },
        });
        expect(JSON.stringify(result)).not.toContain('PRIVATE_UPSTREAM');
        expect(h.saved.id).toBeTruthy();
      }
    },
  );
  it('returns payment_not_safe immediately through MCP without unlock waits', async () => {
    const h = await harness(true, undefined, true);
    const bought = await h.adapter({
      ...h.defaults,
      command: 'buy',
      target: h.defaults.url,
      route: 'base',
    });
    h.fetcher.mockClear();
    h.fetcher.mockImplementation(async () =>
      Response.json({ error: 'payment_not_safe', message: 'PRIVATE_UPSTREAM' }, { status: 425 }),
    );
    await patchConfig(h.defaults.config, { relayer: 'https://relay.example' });
    const connection = await connect((o) => h.adapter({ ...h.defaults, ...o }));
    try {
      const result = await connection.client.callTool({
        name: 'annon_open',
        arguments: { target: bought.purchaseId, output: join(h.dir, 'out') },
      });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).toContain('payment_not_safe');
      expect(result.structuredContent).toMatchObject({
        error: {
          message: expect.stringContaining('status again in about 30 seconds'),
          retryAfterSeconds: 30,
        },
      });
      expect(JSON.stringify(result)).not.toContain('PRIVATE_UPSTREAM');
      expect(h.wait).not.toHaveBeenCalled();
      expect(h.notify).not.toHaveBeenCalled();
      expect(h.fetcher).toHaveBeenCalledTimes(1);
    } finally {
      await connection.close();
    }
  });
  it.each(['base', 'near', 'near-json-rpc'] as const)(
    'maps %s RPC rate limits to fixed CLI and MCP errors',
    async (source) => {
      vi.stubGlobal(
        'fetch',
        vi.fn(
          async () =>
            new Response(
              source === 'near-json-rpc'
                ? JSON.stringify({
                    jsonrpc: '2.0',
                    error: { code: -429, message: 'PRIVATE_UPSTREAM' },
                  })
                : 'PRIVATE_UPSTREAM',
              { status: source === 'near-json-rpc' ? 200 : 429 },
            ),
        ),
      );
      const execute = async (): Promise<Record<string, unknown>> => {
        try {
          if (source === 'base') await block('https://base.example', 'safe');
          else await rpcModule.rpcReply('https://near.example', 'query', {});
        } catch (error) {
          // The typed marker, rather than mutable diagnostic text, must select the public error.
          (error as Error).message = 'PRIVATE_UPSTREAM';
          throw error;
        }
        throw new Error('expected the stubbed RPC to refuse');
      };
      const expected =
        source === 'base'
          ? {
              code: 'base_rpc_rate_limited',
              message:
                'The Base RPC is rate limiting requests. Configure a Base RPC endpoint with an API key (baseRpc).',
            }
          : {
              code: 'near_rpc_rate_limited',
              message: 'Configure a NEAR RPC endpoint with an API key (nearRpc)',
            };
      const connection = await connect(execute);
      try {
        const output: string[] = [];
        expect(
          await runCli(['status', terms.file_id, '--json'], execute, (s) => output.push(s)),
        ).toBe(1);
        expect(JSON.parse(must(output[0]))).toEqual({ ok: false, error: expected });
        const result = await connection.client.callTool({
          name: 'annon_status',
          arguments: { target: terms.file_id },
        });
        expect(result.isError).toBe(true);
        expect(result.structuredContent).toEqual({ ok: false, error: expected });
        expect(JSON.stringify(result)).not.toContain('PRIVATE_UPSTREAM');
      } finally {
        await connection.close();
        vi.unstubAllGlobals();
      }
    },
  );
  it('sanitizes upstream errors and rejects untrusted contracts before wallet use', async () => {
    const connection = await connect(async () => {
      throw new Error('SECRET_VALUE');
    });
    try {
      const result = await connection.client.callTool({
        name: 'annon_verify',
        arguments: { target: 'file' },
      });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).not.toContain('SECRET_VALUE');
    } finally {
      await connection.close();
    }
    const h = await harness();
    await patchConfig(h.defaults.config, { trustContract: false });
    await expect(
      h.adapter({
        ...h.defaults,
        json: true,
        command: 'buy',
        target: h.defaults.url,
      }),
    ).rejects.toMatchObject({ code: 'trust_required' });
    expect(h.calls).toEqual([]);
  });
  it('verifies the advertised header of a gated URL and refuses existing outputs before selling', async () => {
    const h = await harness();
    const required = Buffer.from(await readFile(h.offerFile)).toString('base64');
    h.fetcher.mockImplementationOnce(
      async () => new Response(null, { status: 402, headers: { 'PAYMENT-REQUIRED': required } }),
    );
    expect(
      await h.adapter({ ...h.defaults, command: 'verify', target: 'https://files.example/file' }),
    ).toMatchObject({ verified: true, checked: 'header' });
    await expect(
      h.adapter({
        ...h.defaults,
        command: 'sell',
        target: h.plaintext,
        price: '0.2',
        split: `evm:${terms.seller.id}:10000`,
        output: h.localFile,
      }),
    ).rejects.toMatchObject({ code: 'output_exists' });
    expect(h.calls).toEqual([]);
  });
  it('retries only identical key-release requests after timeouts, with bounded backoff', async () => {
    const h = await harness();
    await h.adapter({
      ...h.defaults,
      command: 'sell',
      target: h.plaintext,
      price: '0.2',
      split: `evm:${terms.seller.id}:10000`,
      output: join(h.dir, 'new.pay2'),
    });
    const call = vi
      .fn()
      .mockRejectedValueOnce(new Error('request timed out SECRET'))
      .mockResolvedValueOnce(null);
    const owner: NearWallet = {
      identity: { kind: 'near', id: 'caller.near' },
      authorize: async () => undefined,
      call,
      transferPurchase: vi.fn(),
    };
    const args = { args: { purchase_id: `0x${'11'.repeat(32)}` } };
    await must(h.options.send)('reopen', args, owner);
    expect(call).toHaveBeenCalledTimes(2);
    expect(call.mock.calls[0]).toEqual(call.mock.calls[1]);
    expect(h.wait).toHaveBeenCalledWith(1000);
    expect(JSON.stringify(h.notify.mock.calls)).not.toContain('SECRET');
    call.mockReset().mockRejectedValue(new Error('request timed out SECRET'));
    await expect(must(h.options.send)('reopen', args, owner)).rejects.toThrow();
    expect(call).toHaveBeenCalledTimes(3);
    call.mockClear();
    await expect(must(h.options.send)('register', args, owner)).rejects.toThrow();
    expect(call).toHaveBeenCalledTimes(1);
  });
  it('resends the saved Base authorization with a grant-proved download after a lost reply', async () => {
    const h = await harness();
    await h.adapter({ ...h.defaults, command: 'buy', target: h.defaults.url, route: 'base' });
    const payload = Buffer.from(
      JSON.stringify({ resource: { url: 'https://files.example/file' } }),
    ).toString('base64');
    const sdk = new Annon(h.options);
    const saved = must(await sdk.store.load(purchaseKey(h.saved.id)));
    expect(
      await sdk.store.compareAndSet(purchaseKey(saved.id), saved, {
        ...saved,
        revision: saved.revision + 1,
        attempts: [
          {
            attemptId: 'saved',
            preparedAt: 1,
            searchFromBlock: 1,
            validBefore: '1800003600',
            paymentRequired: JSON.parse(await readFile(h.offerFile, 'utf8')),
            payload,
          },
        ],
      }),
    ).toBe(true);
    h.fetcher.mockClear().mockImplementation(async () => new Response(h.file));
    const result = await h.adapter({
      ...h.defaults,
      command: 'open',
      target: h.saved.id,
      output: join(h.dir, 'downloaded.txt'),
    });
    expect(result.bytes).toBe(h.data.length);
    const headers = h.fetcher.mock.calls[0]?.[1]?.headers;
    expect(headers).toMatchObject({ 'PAYMENT-SIGNATURE': payload });
    expect(headers && 'Annon-Buyer-Proof' in headers).toBe(true);
    expect(JSON.stringify(result)).not.toContain(payload);
  });
  it('uses the same safe structured results in CLI JSON output', async () => {
    const h = await harness();
    const out = vi.fn();
    const exit = await runCli(
      ['buy', h.defaults.url, '--route', 'base', '--wallet', 'evm', '--json'],
      (o) => h.adapter({ ...h.defaults, ...o }),
      out,
    );
    expect(exit).toBe(0);
    expect(out).toHaveBeenCalledTimes(1);
    expect(JSON.parse(must(out.mock.calls[0])[0])).toMatchObject({
      ok: true,
      result: { route: 'base-usdc', state: 'submitted' },
    });
    for (const value of [
      h.env.ANNON_EVM_PRIVATE_KEY,
      h.env.ANNON_BACKUP_SECRET,
      h.saved.buyerSecret,
      'SIGNED_PAYMENT_PAYLOAD',
    ])
      expect(out.mock.calls.flat().join('')).not.toContain(value);
  });
  it.each([
    'contractId',
    'nearRpc',
    'baseRpc',
    'relayer',
    'network',
    'stateDir',
    'trustContract',
    'config',
    'maxPrice',
    'backupSecretFile',
    'moderator',
    'evmKeyFile',
    'refundTo',
    'fromChain',
    'fromAsset',
  ])('rejects tool-controlled configuration: %s', async (field) => {
    const execute = vi.fn(async () => ({}));
    const c = await connect(execute);
    try {
      const r = await c.client.callTool({
        name: 'annon_buy',
        arguments: {
          target: 'https://files.example/file',
          [field]: field === 'trustContract' ? true : field === 'maxPrice' ? '999999' : 'attacker',
        },
      });
      expect(r.isError).toBe(true);
      expect(execute).not.toHaveBeenCalled();
    } finally {
      await c.close();
    }
  });
  it('requires a human-configured price cap and independently checks an offer-file resource URL', async () => {
    const h = await harness();
    await patchConfig(h.defaults.config, { maxPrice: undefined });
    const noCap = createAdapter(
      {
        ANNON_CONFIG: h.env.ANNON_CONFIG,
        ANNON_STATE_DIR: h.env.ANNON_STATE_DIR,
        ANNON_BACKUP_SECRET: h.env.ANNON_BACKUP_SECRET,
      },
      { wallet: vi.fn() },
    );
    await expect(
      noCap({ ...h.defaults, command: 'buy', target: h.defaults.url }),
    ).rejects.toMatchObject({ code: 'max_price_required' });
    await patchConfig(h.defaults.config, { maxPrice: '0.2' });
    await expect(
      h.adapter({
        ...h.defaults,
        command: 'buy',
        target: h.offerFile,
        url: 'https://other.example/file',
      }),
    ).rejects.toMatchObject({ code: 'resource_not_allowed' });
    expect(h.calls).toEqual([]);
  });
  it('rejects a larger CLI cap before any wallet or payment work', async () => {
    const h = await harness();
    await expect(
      h.adapter({ ...h.defaults, command: 'buy', target: h.defaults.url, maxPrice: '9' }),
    ).rejects.toMatchObject({ code: 'agent_policy' });
    expect(h.calls).toEqual([]);
  });
  it('uses only configured origin names and the wallet refund address', async () => {
    const h = await harness();
    await h.adapter({
      ...h.defaults,
      command: 'buy',
      target: h.defaults.url,
      route: '1click',
      origin: 'base-usdc',
    });
    const args = h.calls.find((c) => c.command === 'buy')?.args as { origin: { refundTo: string } };
    expect(args.origin.refundTo).toBe(
      privateKeyToAccount(`0x${'42'.repeat(32)}`).address.toLowerCase(),
    );
    await expect(
      h.adapter({
        ...h.defaults,
        command: 'buy',
        target: h.defaults.url,
        route: '1click',
        origin: 'attacker',
      }),
    ).rejects.toMatchObject({ code: 'origin_not_allowed' });
  });
  it('resumes a sell through the real MCP schema without price or split', async () => {
    const execute = vi.fn(async () => ({ fileId: terms.file_id }));
    const connection = await connect(execute);
    try {
      const r = await connection.client.callTool({
        name: 'annon_sell',
        arguments: { target: 'original.txt', resume: terms.file_id },
      });
      expect(r.isError).not.toBe(true);
      expect(execute).toHaveBeenCalledWith(
        expect.objectContaining({ command: 'sell', resume: terms.file_id }),
      );
    } finally {
      await connection.close();
    }
  });

  it('requires a human-allowed URL for an MCP offer file even when agent URL and offer agree', async () => {
    const h = await harness();
    await patchConfig(h.defaults.config, { allowedResources: ['https://human.example/file'] });
    await expect(
      h.adapter({ ...h.defaults, command: 'buy', target: h.defaults.url }),
    ).rejects.toMatchObject({ code: 'resource_not_allowed' });
    expect(h.calls).toEqual([]);
  });
  it('executes sell resume through the adapter with the original plaintext', async () => {
    const h = await harness();
    const result = await h.adapter({
      ...h.defaults,
      command: 'sell',
      target: h.plaintext,
      resume: terms.file_id,
      output: join(h.dir, 'resumed.pay2'),
    });
    expect(result.fileId).toBe(terms.file_id);
    expect(result.baseSplit).toEqual(h.baseSplit);
    expect(h.calls).toMatchObject([
      { command: 'resumeSell', args: { fileId: terms.file_id, data: h.data } },
    ]);
    expect(await readFile(join(h.dir, 'resumed.pay2'))).toEqual(Buffer.from(h.file));
  });
  it('reports a failed sell fileId through both CLI and MCP without upstream secrets', async () => {
    const execute = async () => {
      throw new SellError(terms.file_id, { cause: new Error('SECRET_VALUE') });
    };
    const out = vi.fn();
    expect(
      await runCli(
        ['sell', 'file', '--price', '0.2', '--split', 'near:seller.near:10000', '--json'],
        execute,
        out,
      ),
    ).toBe(1);
    expect(JSON.parse(out.mock.calls[0]?.[0] ?? '')).toMatchObject({
      error: { code: 'sell_incomplete', fileId: terms.file_id },
    });
    expect(JSON.stringify(out.mock.calls)).not.toContain('SECRET_VALUE');
    const c = await connect(execute);
    try {
      const result = await c.client.callTool({
        name: 'annon_sell',
        arguments: { target: 'file', price: '0.2', split: 'near:seller.near:10000' },
      });
      expect(result.structuredContent).toMatchObject({
        error: { code: 'sell_incomplete', fileId: terms.file_id },
      });
      expect(JSON.stringify(result)).not.toContain('SECRET_VALUE');
    } finally {
      await c.close();
    }
  });
  it('verifies and reads accepted status with only a NEAR RPC configured', async () => {
    const h = await harness();
    const { baseRpc: _baseRpc, ...defaults } = h.defaults;
    expect(await h.adapter({ ...defaults, command: 'verify', target: h.localFile })).toMatchObject({
      verified: true,
    });
    expect(
      await h.adapter({ ...defaults, command: 'status', target: terms.file_id }),
    ).toMatchObject({ state: 'accepted' });
    expect(h.fetcher).not.toHaveBeenCalled();
  });
});

it('charges the agent daily budget before buy and preserves it across adapter restarts', async () => {
  const h = await harness();
  await patchConfig(h.defaults.config, { dailyBudget: '0.3' });
  const input = {
    ...h.defaults,
    command: 'buy' as const,
    target: h.defaults.url,
    route: '1click' as const,
    origin: 'base-usdc',
  };
  await h.adapter(input);
  await expect(h.adapter(input)).rejects.toMatchObject({ code: 'budget_exceeded' });
  expect(h.calls.filter((c) => c.command === 'buy')).toHaveLength(1);
});

it('refuses an agent payment without a persisted budget before invoking buy', async () => {
  const h = await harness();
  await patchConfig(h.defaults.config, { dailyBudget: undefined });
  await expect(
    h.adapter({
      ...h.defaults,
      command: 'buy',
      target: h.defaults.url,
      route: '1click',
      origin: 'base-usdc',
    }),
  ).rejects.toMatchObject({ code: 'budget_required' });
  expect(h.calls.filter((c) => c.command === 'buy')).toHaveLength(0);
});

it('shows exact human payment terms and refuses payment until confirmed', async () => {
  const prompt = vi.fn(async (_message: string) => false);
  const h = await harness(false, prompt);
  await expect(
    h.adapter({ ...h.defaults, command: 'buy', target: h.defaults.url, route: 'base' }),
  ).rejects.toMatchObject({ code: 'confirmation_required' });
  expect(h.calls.filter((c) => c.command === 'buy')).toHaveLength(0);
  expect(prompt).toHaveBeenCalledTimes(1);
  const shown = prompt.mock.calls[0]?.[0] ?? '';
  expect(h.notify).toHaveBeenCalledTimes(1);
  const termsText = h.notify.mock.calls[0]?.[0] ?? '';
  expect(shown).toBe('Type yes to pay: ');
  expect(termsText).toContain(terms.file_id);
  expect(termsText).toContain(must(terms.base).usdc);
  expect(termsText).not.toContain('\u2014');
  expect(termsText).toContain('eip155:8453');
  expect(termsText).toContain('0.2 USDC');
  expect(termsText).toContain('100%');
  expect(termsText).toContain('USDC on Base');
  expect(termsText).toContain(must(terms.base).pay_to);
  for (const r of terms.near.recipients) expect(termsText).toContain(r.identity.id);
});

it('human JSON mode never prompts or silently pays using a local key', async () => {
  const prompt = vi.fn(async (_message: string) => true);
  const h = await harness(false, prompt);
  await expect(
    h.adapter({ ...h.defaults, command: 'buy', target: h.defaults.url, route: 'base', json: true }),
  ).rejects.toMatchObject({ code: 'confirmation_required' });
  expect(prompt).not.toHaveBeenCalled();
  expect(h.notify).toHaveBeenCalledTimes(1);
  expect(JSON.parse(h.notify.mock.calls[0]?.[0] ?? '')).toMatchObject({
    price: terms.near.price,
    recipients: terms.near.recipients,
  });
  expect(h.calls.filter((c) => c.command === 'buy')).toHaveLength(0);
});

it('returns a quote refusal through both CLI and MCP with a decimal minimum and no response secrets', async () => {
  const h = await harness();
  const original = h.fetcher.getMockImplementation();
  h.fetcher.mockImplementation(async (url, init) =>
    String(url).endsWith('/quote')
      ? Response.json(
          { message: 'Amount is too low for bridge, try at least 149983', debug: 'SECRET_VALUE' },
          { status: 400 },
        )
      : must(original)(url, init),
  );
  const execute = (o: Input) => h.adapter({ ...h.defaults, ...o });
  const out = vi.fn();
  expect(
    await runCli(
      ['buy', h.defaults.url, '--route', '1click', '--origin', 'base-usdc', '--json'],
      execute,
      out,
    ),
  ).toBe(1);
  const expected = {
    code: 'oneclick_refused',
    message: 'Amount is too low for bridge, try at least 149983',
    minimumAmountUsdc: '0.149983',
  };
  expect(JSON.parse(out.mock.calls[0]?.[0] ?? '').error).toEqual(expected);
  const c = await connect(execute);
  try {
    const result = await c.client.callTool({
      name: 'annon_buy',
      arguments: { target: h.defaults.url, route: '1click', origin: 'base-usdc' },
    });
    expect(result.structuredContent).toEqual({ ok: false, error: expected });
    expect(JSON.stringify([result, out.mock.calls])).not.toContain('SECRET_VALUE');
  } finally {
    await c.close();
  }
});

it.each([false, true])(
  'refuses noncanonical USDC before confirmation, notification or an agent budget charge (agent=%s)',
  async (agent) => {
    const prompt = vi.fn(async () => true);
    const h = await harness(agent, prompt);
    h.listing.terms.near.token = 'fake-usdc.near';
    await expect(
      h.adapter({
        ...h.defaults,
        command: 'buy',
        target: h.defaults.url,
        route: '1click',
        origin: 'base-usdc',
        json: true,
      }),
    ).rejects.toThrow(/canonical USDC/);
    expect(prompt).not.toHaveBeenCalled();
    expect(h.notify).not.toHaveBeenCalled();
    expect(h.calls.filter((c) => c.command === 'buy')).toHaveLength(0);
    const { fileStore } = await import('../../annon/src/pay/store-node.js');
    expect(await fileStore(join(h.dir, 'budgets')).load('agent:USDC')).toBeNull();
  },
);

it.each([400, 500, 429, 0])(
  'refunds the agent budget before any deposit instructions are returned (status=%s)',
  async (status) => {
    const h = await harness();
    await patchConfig(h.defaults.config, { dailyBudget: '0.2' });
    const original = must(h.fetcher.getMockImplementation());
    h.fetcher.mockImplementation(async (url, init) => {
      if (!String(url).endsWith('/quote')) return original(url, init);
      if (!status) throw new Error('lost quote response');
      return Response.json(
        { message: status === 429 ? 'unknown refusal' : 'No routes found' },
        { status },
      );
    });
    const input = {
      ...h.defaults,
      command: 'buy' as const,
      target: h.defaults.url,
      route: '1click' as const,
      origin: 'base-usdc',
    };
    await expect(h.adapter(input)).rejects.toThrow();
    h.fetcher.mockImplementation(original);
    await expect(h.adapter(input)).resolves.toMatchObject({ state: 'deposit_required' });
    expect(h.calls.filter((c) => c.command === 'buy')).toHaveLength(2);
  },
);

it.each(['near:testnet', 'near:sandbox'])(
  'admits configured payment tokens on %s before buy or confirmation',
  async (network) => {
    for (const agent of [false, true]) {
      for (const route of ['1click', 'base'] as const) {
        const prompt = vi.fn(async () => false);
        const h = await harness(agent, prompt);
        h.contractConfig.network = network;
        h.contractConfig.nearUsdc = 'usdc.testnet';
        h.contractConfig.usdc = `0x${'12'.repeat(20)}`;
        h.listing.terms.network = network;
        h.listing.terms.near.token = h.contractConfig.nearUsdc;
        must(h.listing.terms.base).usdc = h.contractConfig.usdc;
        if (agent) await patchConfig(h.defaults.config, { network });
        const input = {
          ...h.defaults,
          ...(agent ? {} : { network }),
          command: 'buy' as const,
          target: h.defaults.url,
          route,
          ...(route === '1click' ? { origin: 'base-usdc' } : {}),
        };
        if (agent) {
          await expect(h.adapter(input)).resolves.toMatchObject({
            state: route === '1click' ? 'deposit_required' : 'submitted',
          });
          expect(h.calls.filter((c) => c.command === 'buy')).toHaveLength(1);
        } else {
          await expect(h.adapter(input)).rejects.toMatchObject({ code: 'confirmation_required' });
          expect(h.notify.mock.calls[0]?.[0]).toContain(
            route === '1click' ? h.contractConfig.nearUsdc : h.contractConfig.usdc,
          );
          expect(prompt).toHaveBeenCalledTimes(1);
        }
      }
    }
  },
);

it.each(['near', 'base'] as const)(
  'rejects %s payment tokens that differ from contract configuration',
  async (route) => {
    const h = await harness();
    if (route === 'near') h.contractConfig.nearUsdc = 'other-usdc.near';
    else h.contractConfig.usdc = `0x${'12'.repeat(20)}`;
    await expect(
      h.adapter({
        ...h.defaults,
        command: 'buy',
        target: h.defaults.url,
        route: route === 'near' ? '1click' : 'base',
        origin: 'base-usdc',
      }),
    ).rejects.toMatchObject({ code: 'network_mismatch' });
    expect(h.calls.filter((c) => c.command === 'buy')).toHaveLength(0);
    expect(await fileStore(join(h.dir, 'budgets')).load('agent:USDC')).toBeNull();
  },
);

it.each(['invalid', '0'])(
  'preserves oneclick_refused when the budget refund encounters a corrupt ledger (%s)',
  async (daily) => {
    const h = await harness();
    const original = must(h.fetcher.getMockImplementation());
    const ledger = fileStore<BudgetRecord>(join(h.dir, 'budgets'));
    h.fetcher.mockImplementation(async (url, init) => {
      if (!String(url).endsWith('/quote')) return original(url, init);
      const old = must(await ledger.load('agent:USDC'));
      expect(
        await ledger.compareAndSet(old.id, old, { ...old, revision: old.revision + 1, daily }),
      ).toBe(true);
      return Response.json({ message: 'No routes found' }, { status: 400 });
    });
    await expect(
      h.adapter({
        ...h.defaults,
        command: 'buy',
        target: h.defaults.url,
        route: '1click',
        origin: 'base-usdc',
      }),
    ).rejects.toMatchObject({
      code: 'oneclick_refused',
      message: 'No routes found',
    });
    expect((await ledger.load('agent:USDC'))?.daily).toBe(daily);
    expect(h.calls.filter((c) => c.command === 'buy')).toHaveLength(1);
  },
);

const sourceTokens = ['sUSDC', 'USDT', 'USD1', 'USDC'].map((symbol) => ({
  blockchain: 'sol',
  symbol,
  decimals: 6,
  assetId: `nep141:sol-${symbol.toLowerCase()}`,
  contractAddress: `test-sol-${symbol.toLowerCase()}-token`,
}));
function stubSource(h: Awaited<ReturnType<typeof harness>>, tokens = sourceTokens) {
  const original = must(h.fetcher.getMockImplementation());
  h.fetcher.mockImplementation(async (url, init) => {
    if (String(url).endsWith('/tokens')) return Response.json(tokens);
    const response = await original(url, init);
    if (!String(url).endsWith('/quote')) return response;
    const result = await response.json();
    result.quote.amountIn = '202064';
    result.quote.amountInFormatted = '0.202064';
    return Response.json(result);
  });
}
it.each(['solana', 'sol'])(
  'quotes the exact sol USDC token for --from-chain %s and defaults the Solana refund',
  async (chain) => {
    const buyer = {
      identity: { kind: 'solana' as const, id: '07'.repeat(32) },
      authorize: vi.fn(),
    };
    const h = await harness(false, async () => true, false, buyer);
    stubSource(h);
    const result = await h.adapter({
      ...h.defaults,
      command: 'buy',
      target: h.defaults.url,
      route: '1click',
      fromChain: chain,
    });
    const request = JSON.parse(
      String(h.fetcher.mock.calls.find(([url]) => String(url).endsWith('/quote'))?.[1]?.body),
    );
    expect(request).toMatchObject({
      originAsset: 'nep141:sol-usdc',
      refundTo: expect.any(String),
      refundType: 'ORIGIN_CHAIN',
      dry: false,
    });
    expect(parseIdentity({ kind: 'solana', id: request.refundTo })).toEqual(buyer.identity);
    expect(result.source).toMatchObject({
      chain: 'sol',
      asset: 'nep141:sol-usdc',
      symbol: 'USDC',
      contractAddress: 'test-sol-usdc-token',
      amount: '202064',
      amountFormatted: '0.202064',
    });
    expect(result.payment).toMatchObject({ source: result.source });
  },
);
it.each([
  ['ethereum', 'eth'],
  ['arbitrum', 'arb'],
  ['polygon', 'pol'],
  ['optimism', 'op'],
  ['avalanche', 'avax'],
  ['berachain', 'bera'],
  ...[
    'eth',
    'base',
    'arb',
    'pol',
    'op',
    'avax',
    'bsc',
    'gnosis',
    'bera',
    'scroll',
    'monad',
    'xlayer',
    'abs',
    'plasma',
  ].map((id) => [id, id]),
])('looks up EVM chain %s as the real token-list id %s', async (chain, blockchain) => {
  const h = await harness(false, async () => true);
  stubSource(h, [
    {
      blockchain,
      symbol: 'USDC',
      decimals: 6,
      assetId: 'nep141:evm-usdc',
      contractAddress: 'test-evm-token',
    },
  ]);
  await h.adapter({
    ...h.defaults,
    command: 'buy',
    target: h.defaults.url,
    route: '1click',
    fromChain: chain,
  });
  const args = h.calls.find((c) => c.command === 'buy')?.args as {
    origin: { chain: string; refundTo: string };
  };
  expect(args.origin).toMatchObject({
    chain: 'evm',
    refundTo: privateKeyToAccount(`0x${'42'.repeat(32)}`).address.toLowerCase(),
  });
});
it.each(['missing', 'ambiguous'])(
  'refuses %s exact USDC selection without falling back to sUSDC',
  async (mode) => {
    const h = await harness(false, async () => true);
    const tokens =
      mode === 'missing'
        ? sourceTokens.filter((t) => t.symbol !== 'USDC')
        : [...sourceTokens, { ...must(sourceTokens.at(-1)), assetId: 'nep141:second-usdc' }];
    stubSource(h, tokens);
    await expect(
      h.adapter({
        ...h.defaults,
        command: 'buy',
        target: h.defaults.url,
        route: '1click',
        fromChain: 'solana',
        refundTo: 'test-refund',
      }),
    ).rejects.toMatchObject({ code: 'origin_asset_required' });
    expect(h.calls).toEqual([]);
  },
);
it.each([true, false])(
  'shows the live source quote before human confirmation (accepted=%s)',
  async (accepted) => {
    const prompt = vi.fn(async () => {
      const quote = h.saved.quote as OneClickQuote;
      expect(quote.deposit.amount).toBe('202064');
      const text = h.notify.mock.calls.at(-1)?.[0] ?? '';
      expect(text).toContain('Source chain: Solana (sol)');
      expect(text).toContain('Source asset: USDC (test-sol-usdc-token)');
      expect(text).toContain('0.202064 USDC (202064 base units)');
      expect(text).toContain(`Deposit before: ${quote.deposit.depositBefore}`);
      expect(text).not.toContain('about');
      return accepted;
    });
    const h = await harness(false, prompt);
    stubSource(h);
    const operation = h.adapter({
      ...h.defaults,
      command: 'buy',
      target: h.defaults.url,
      route: '1click',
      fromChain: 'solana',
      refundTo: 'test-refund',
    });
    if (accepted)
      await expect(operation).resolves.toMatchObject({
        state: 'deposit_required',
        source: { amount: '202064', amountFormatted: '0.202064' },
      });
    else await expect(operation).rejects.toMatchObject({ code: 'confirmation_required' });
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(h.fetcher.mock.calls.filter(([url]) => String(url).endsWith('/quote'))).toHaveLength(1);
  },
);
it('keeps explicit unknown chain assets working and includes their quoted source amount in agent JSON', async () => {
  const h = await harness();
  h.env.ANNON_ORIGINS = JSON.stringify({
    custom: { fromChain: 'unknown-chain', fromAsset: 'nep141:custom', refundTo: 'test-refund' },
  });
  stubSource(h);
  const output: string[] = [];
  expect(
    await runCli(
      ['buy', h.defaults.url, '--route', '1click', '--origin', 'custom', '--json'],
      (o) => h.adapter({ ...h.defaults, ...o }),
      (text) => output.push(text),
    ),
  ).toBe(0);
  expect(JSON.parse(must(output[0])).result.source).toMatchObject({
    chain: 'unknown-chain',
    asset: 'nep141:custom',
    amount: '202064',
    amountFormatted: '0.202064',
  });
  expect(h.notify).not.toHaveBeenCalled();
  expect(h.fetcher.mock.calls.some(([url]) => String(url).endsWith('/tokens'))).toBe(false);
});

it('keeps human JSON 1Click mode non-interactive and does not create a quote without confirmation', async () => {
  const prompt = vi.fn(async () => true);
  const h = await harness(false, prompt);
  stubSource(h);
  await expect(
    h.adapter({
      ...h.defaults,
      command: 'buy',
      target: h.defaults.url,
      route: '1click',
      fromChain: 'solana',
      refundTo: 'test-refund',
      json: true,
    }),
  ).rejects.toMatchObject({ code: 'confirmation_required' });
  expect(prompt).not.toHaveBeenCalled();
  expect(h.calls).toEqual([]);
  expect(h.fetcher.mock.calls.some(([url]) => String(url).endsWith('/quote'))).toBe(false);
});
it('passes the exact quote into browser approval terms without a terminal prompt or a browser', async () => {
  const prompt = vi.fn(async () => {
    throw new Error('unexpected terminal prompt');
  });
  const h = await harness(false, prompt);
  await writeFile(
    h.defaults.config,
    JSON.stringify({ signer: { mode: 'browser', identity: h.listing.seller } }),
  );
  stubSource(h);
  const result = await h.adapter({
    ...h.defaults,
    command: 'buy',
    target: h.defaults.url,
    route: '1click',
    fromChain: 'solana',
    refundTo: 'test-refund',
  });
  expect(h.reviews.at(-1)).toMatchObject({ source: result.source });
  expect(result.source).toMatchObject({
    amount: '202064',
    amountFormatted: '0.202064',
    symbol: 'USDC',
  });
  expect(prompt).not.toHaveBeenCalled();
  expect(h.notify).not.toHaveBeenCalled();
});

it.each(['\u001b[2J', '\n', '\r', '\t', '\0', '\u202e', '/', ' ', 'x'.repeat(129)])(
  'drops unsafe token contract metadata %j before human or structured output',
  async (unsafe) => {
    const h = await harness(false, async () => true);
    stubSource(
      h,
      sourceTokens.map((t) => ({ ...t, contractAddress: unsafe })),
    );
    const result = await h.adapter({
      ...h.defaults,
      command: 'buy',
      target: h.defaults.url,
      route: '1click',
      fromChain: 'solana',
      refundTo: 'test-refund',
    });
    expect(result.source).not.toHaveProperty('contractAddress');
    expect(h.notify.mock.calls.at(-1)?.[0]).toContain('Source asset: USDC\n');
  },
);
it.each([
  'nep141:token\u001b[2J',
  'nep141:token\n',
  'nep141:token\r',
  'nep141:token\0',
  'nep141:token name',
  'x'.repeat(129),
])('rejects unsafe token asset id %j before requesting a quote', async (assetId) => {
  const h = await harness(false, async () => true);
  stubSource(
    h,
    sourceTokens.map((t) => ({ ...t, assetId })),
  );
  await expect(
    h.adapter({
      ...h.defaults,
      command: 'buy',
      target: h.defaults.url,
      route: '1click',
      fromChain: 'solana',
      refundTo: 'test-refund',
    }),
  ).rejects.toMatchObject({ code: 'origin_asset_required' });
  expect(h.calls).toEqual([]);
  expect(h.notify).not.toHaveBeenCalled();
  expect(h.fetcher.mock.calls.some(([url]) => String(url).endsWith('/quote'))).toBe(false);
});
it('preserves Sui separators in safe token identifiers', async () => {
  const h = await harness(false, async () => true);
  stubSource(h, [
    {
      blockchain: 'sui',
      assetId: 'nep141:sui-token::usdc',
      symbol: 'USDC',
      decimals: 6,
      contractAddress: 'test-token::usdc::USDC',
    },
  ]);
  const result = await h.adapter({
    ...h.defaults,
    command: 'buy',
    target: h.defaults.url,
    route: '1click',
    fromChain: 'sui',
    refundTo: 'test-refund',
  });
  expect(result.source).toMatchObject({
    asset: 'nep141:sui-token::usdc',
    contractAddress: 'test-token::usdc::USDC',
  });
});
it.each(['aurora', 'sui', 'hypercore', 'aptos'])(
  'does not infer an EVM refund for %s',
  async (chain) => {
    const h = await harness(false, async () => true);
    stubSource(h);
    await expect(
      h.adapter({
        ...h.defaults,
        command: 'buy',
        target: h.defaults.url,
        route: '1click',
        fromChain: chain,
        fromAsset: 'nep141:custom',
      }),
    ).rejects.toMatchObject({ code: 'origin_required' });
    const result = await h.adapter({
      ...h.defaults,
      command: 'buy',
      target: h.defaults.url,
      route: '1click',
      fromChain: chain,
      fromAsset: 'nep141:custom',
      refundTo: 'test-refund',
    });
    expect(result.instructions).toMatchObject({ chain: 'other' });
  },
);
it('refuses a human purchase without a prompt before creating a quote or purchase', async () => {
  const h = await harness(false);
  stubSource(h);
  await expect(
    h.adapter({
      ...h.defaults,
      command: 'buy',
      target: h.defaults.url,
      route: '1click',
      fromChain: 'solana',
      refundTo: 'test-refund',
    }),
  ).rejects.toMatchObject({ code: 'confirmation_required' });
  expect(h.calls).toEqual([]);
  expect(h.fetcher.mock.calls.some(([url]) => String(url).endsWith('/quote'))).toBe(false);
});
it.each(['proof', 'cutoff', 'storage', 'review'])(
  'refunds a 1Click agent reservation after a real SDK %s failure, retaining it after instructions return',
  async (failure) => {
    let refuse = true;
    let current = Date.parse('2026-11-11T12:00:00Z');
    vi.spyOn(Date, 'now').mockImplementation(() => current);
    const account = privateKeyToAccount(`0x${'42'.repeat(32)}`);
    const buyer = {
      identity: { kind: 'evm' as const, id: account.address.toLowerCase() },
      authorize: async (text: string) => {
        if (refuse && failure === 'proof') throw new Error('private proof failure');
        return { kind: 'evm' as const, sig: await account.signMessage({ message: text }) };
      },
    };
    const h = await harness(true, undefined, false, buyer, true);
    vi.spyOn(rpcModule, 'getFile').mockResolvedValue(h.listing);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('unexpected external read');
      }),
    );
    await patchConfig(h.defaults.config, { dailyBudget: '0.2' });
    const fetcher = must(h.fetcher.getMockImplementation());
    h.fetcher.mockImplementation(async (url, init) => {
      const response = await fetcher(url, init);
      if (refuse && failure === 'storage' && String(url).endsWith('/quote'))
        h.options.writeBackup = async () => {
          throw new Error('private backup failure');
        };
      return response;
    });
    vi.spyOn(h.reviews, 'push').mockImplementation((...items) => {
      if (refuse && failure === 'review') throw new Error('private review failure');
      if (refuse && failure === 'cutoff') current += 2401000;
      return Array.prototype.push.apply(h.reviews, items);
    });
    const input = {
      ...h.defaults,
      command: 'buy' as const,
      target: h.defaults.url,
      route: '1click' as const,
      origin: 'base-usdc',
    };
    const output: string[] = [];
    try {
      expect(
        await runCli(
          ['buy', h.defaults.url, '--route', '1click', '--origin', 'base-usdc', '--json'],
          () => h.adapter(input),
          (text) => output.push(text),
        ),
      ).toBe(1);
      expect(output.join('')).not.toContain('deposit-address');
      expect(output.join('')).not.toContain('private');
      if (failure === 'cutoff')
        expect(JSON.parse(must(output[0])).error.code).toBe('quote_expired');
      expect(h.notify).not.toHaveBeenCalled();
      expect(JSON.stringify(h.reviews)).not.toContain('deposit-address');
      const ledger = fileStore<BudgetRecord>(join(h.dir, 'budgets'));
      expect(await ledger.load('agent:USDC')).toMatchObject({ daily: '0', hourly: '0' });
      refuse = false;
      expect(await h.adapter(input)).toMatchObject({
        instructions: { address: 'deposit-address' },
      });
      expect(await ledger.load('agent:USDC')).toMatchObject({ daily: '200000', hourly: '200000' });
      await expect(h.adapter(input)).rejects.toMatchObject({ code: 'budget_exceeded' });
    } finally {
      vi.unstubAllGlobals();
    }
  },
);
it('returns quote_expired through CLI and MCP with a fixed actionable message', async () => {
  const execute = async () => {
    const error = new OneClickQuoteExpired();
    error.message = 'private upstream diagnostic';
    throw error;
  };
  const output: string[] = [];
  expect(await runCli(['buy', 'offer.json', '--json'], execute, (s) => output.push(s))).toBe(1);
  const expected = {
    ok: false,
    error: { code: 'quote_expired', message: 'The 1Click quote expired. Run buy again.' },
  };
  expect(JSON.parse(must(output[0]))).toEqual(expected);
  const connection = await connect(execute);
  try {
    const result = await connection.client.callTool({
      name: 'annon_buy',
      arguments: { target: 'https://files.example/file' },
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual(expected);
  } finally {
    await connection.close();
  }
});

async function patchConfig(path: string, patch: Record<string, unknown>) {
  await writeFile(path, JSON.stringify({ ...JSON.parse(await readFile(path, 'utf8')), ...patch }));
}

it('refuses an agent offer file even when its resource URL is allowlisted', async () => {
  const h = await harness();
  await expect(
    h.adapter({ ...h.defaults, command: 'buy', target: h.offerFile, url: h.defaults.url }),
  ).rejects.toMatchObject({ code: 'resource_not_allowed' });
  expect(h.fetcher).not.toHaveBeenCalled();
  expect(h.calls).toEqual([]);
  const execute = vi.fn(async () => ({}));
  const connection = await connect(execute);
  try {
    const result = await connection.client.callTool({
      name: 'annon_buy',
      arguments: { target: h.offerFile, url: h.defaults.url },
    });
    expect(result.isError).toBe(true);
    expect(execute).not.toHaveBeenCalled();
  } finally {
    await connection.close();
  }
});
it('rejects an offer header on a different origin before fetching it', async () => {
  const h = await harness();
  const offer = JSON.parse(await readFile(h.offerFile, 'utf8'));
  offer.extensions.annon.info.header = 'https://other.example/header';
  h.fetcher.mockImplementation(async () =>
    Response.json(offer, {
      status: 402,
      headers: { 'PAYMENT-REQUIRED': Buffer.from(JSON.stringify(offer)).toString('base64') },
    }),
  );
  await expect(
    h.adapter({ ...h.defaults, command: 'buy', target: h.defaults.url }),
  ).rejects.toThrow('header origin mismatch');
  expect(h.fetcher).toHaveBeenCalledTimes(1);
  expect(h.calls).toEqual([]);
});

it.each([
  'sell.target',
  'sell.output',
  'open.file',
  'open.output',
  'verify.target',
  'open.target',
  'open.purchase',
] as const)('confines %s against absolute, traversal and symlink escapes', async (field) => {
  const h = await harness();
  const outside = await mkdtemp(join(tmpdir(), 'annon-outside-'));
  directories.push(outside);
  await writeFile(join(outside, 'file.txt'), 'outside');
  await symlink(outside, join(h.dir, 'escape'));
  await symlink(join(outside, 'file.txt'), join(h.dir, 'escape-file'));
  await symlink(join(outside, 'missing.txt'), join(h.dir, 'dangling'));
  const [command, option] = field.split('.') as [
    'sell' | 'open' | 'verify',
    'target' | 'file' | 'output' | 'purchase',
  ];
  for (const bad of [
    join(outside, option === 'output' ? 'new.txt' : 'file.txt'),
    `../${h.dir.split('/').at(-1)}/file.txt`,
    `escape/${option === 'output' ? 'new.txt' : 'file.txt'}`,
    'escape-file',
    'dangling',
  ]) {
    const input = {
      ...h.defaults,
      command,
      target: command === 'sell' ? h.plaintext : terms.file_id,
      output: join(h.dir, 'out.txt'),
      ...(command === 'sell'
        ? { price: '0.2', split: 'near:buyer.testnet:10000' }
        : { file: h.localFile }),
      [option]: bad,
    };
    await expect(h.adapter(input)).rejects.toMatchObject({ code: 'path_not_allowed' });
  }
  expect(h.calls).toEqual([]);
});
it('resolves relative sell paths in the operator workDir, including the default output', async () => {
  const h = await harness();
  await mkdir(join(h.dir, 'nested'));
  await writeFile(join(h.dir, 'nested', 'input.txt'), 'inside');
  const result = await h.adapter({
    ...h.defaults,
    command: 'sell',
    target: 'nested/input.txt',
    price: '0.2',
    split: 'near:buyer.testnet:10000',
  });
  expect(await readFile(String(result.file))).toEqual(Buffer.from(h.file));
});
it('checks the relayer sponsorship floor before a Base payment or budget reservation', async () => {
  const h = await harness();
  await patchConfig(h.defaults.config, { relayer: 'https://relay.example' });
  const original = must(h.fetcher.getMockImplementation());
  h.fetcher.mockImplementation(async (url, init) =>
    String(url).endsWith('/v1/capabilities')
      ? Response.json({
          contract: terms.contract,
          minPrice: '200001',
          disabled: false,
          methods: ['unlock'],
        })
      : original(url, init),
  );
  await expect(
    h.adapter({ ...h.defaults, command: 'buy', target: h.defaults.url, route: 'base' }),
  ).rejects.toMatchObject({ code: 'not_sponsored' });
  expect(h.calls).toEqual([]);
  expect(await fileStore<BudgetRecord>(join(h.dir, 'budgets')).load('agent:USDC')).toBeNull();
});

it('resolves a local verify target from workDir and leaves URL targets remote', async () => {
  const h = await harness();
  expect(await h.adapter({ ...h.defaults, command: 'verify', target: 'file.pay2' })).toMatchObject({
    verified: true,
  });
  h.fetcher.mockImplementation(async (url) => {
    expect(String(url)).toBe(h.defaults.url);
    return new Response(h.header);
  });
  expect(
    await h.adapter({ ...h.defaults, command: 'verify', target: h.defaults.url }),
  ).toMatchObject({ verified: true });
});
it.each(['backup', 'pay2-id', 'pay2-backup'] as const)(
  'opens relative %s inputs from workDir',
  async (kind) => {
    const h = await harness();
    const bought = await h.adapter({
      ...h.defaults,
      command: 'buy',
      target: h.defaults.url,
      route: 'base',
    });
    await writeFile(join(h.dir, 'relative-backup.json'), await readFile(String(bought.backup)));
    const out = await h.adapter({
      ...h.defaults,
      command: 'open',
      target: kind === 'backup' ? 'relative-backup.json' : 'file.pay2',
      ...(kind === 'backup'
        ? { file: 'file.pay2' }
        : { purchase: kind === 'pay2-id' ? String(bought.purchaseId) : 'relative-backup.json' }),
      output: 'opened.txt',
    });
    expect(out.bytes).toBe(h.data.length);
    expect(await readFile(join(h.dir, 'opened.txt'))).toEqual(Buffer.from(h.data));
  },
);
