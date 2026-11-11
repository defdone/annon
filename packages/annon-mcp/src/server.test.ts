import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
import { exportRecovery, type RecoveryRecord } from '../../annon/src/pay/backup.js';
import { type PurchaseRecord, purchaseKey } from '../../annon/src/pay/purchase.js';
import { paymentRequired } from '../../annon/src/pay/seller.js';
import { fileStore } from '../../annon/src/pay/store-node.js';
import { bytes, hex } from '../../annon/src/settle-near/codec.js';
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
async function harness(agent = true, prompt?: (message: string) => Promise<boolean>) {
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
  const adapter = createAdapter(env, {
    agent,
    ...(prompt ? { prompt } : {}),
    wait,
    notify,
    wallet: async () => wallet,
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
        return { file, header, terms: finalTerms, preview: sealed.preview };
      });
      vi.spyOn(sdk, 'resumeSell').mockImplementation(async (args) => {
        calls.push({ command: 'resumeSell', args });
        await args.publish({ file, header, terms: finalTerms });
        return { file, header, terms: finalTerms, preview: sealed.preview };
      });
      vi.spyOn(sdk, 'buy').mockImplementation(async (args) => {
        calls.push({ command: 'buy', args });
        const base = args.payer?.identity.kind === 'evm';
        const p = {
          ...purchase,
          route: base ? ('base-usdc' as const) : ('near-usdc' as const),
          network: base ? 'eip155:8453' : terms.network,
          asset: base ? must(terms.base).usdc : terms.near.token,
          buyer_key: hex(keyFromSecret(new Uint8Array(32).fill(6)).publicKeyBytes),
          recovery: wallet.identity,
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
            buyer: wallet.identity.id,
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
        if (args.origin)
          return {
            route: p.route,
            record,
            instructions: (await args.oneClick?.quote(record.message, args.origin))?.deposit,
          } as Awaited<ReturnType<Annon['buy']>>;
        await args.submitBase?.('SIGNED_PAYMENT_PAYLOAD');
        return { route: p.route, record, payment: 'SIGNED_PAYMENT_PAYLOAD' };
      });
      vi.spyOn(sdk, 'accept').mockResolvedValue(true);
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
  const defaults = {
    contractId: terms.contract,
    nearRpc: 'https://rpc.example',
    baseRpc: 'https://base.example',
    config: join(dir, 'config.json'),
    trustContract: true,
    wallet: 'evm' as const,
    url: 'https://files.example/file',
  };
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
    listing: f,
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
        target: h.offerFile,
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
      expect(await readFile(join(h.dir, 'sold.pay2'))).toEqual(
        Buffer.from(await readFile(h.localFile)),
      );
      const bought = await call('annon_buy', {
        target: h.offerFile,
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
        arguments: { target: h.offerFile, url: h.defaults.url, route: 'base' },
      });
      expect(result.isError).not.toBe(true);
      expect(JSON.stringify(result)).not.toContain('SIGNED_PAYMENT_PAYLOAD');
      expect(
        h.fetcher.mock.calls.some(([, o]) => o?.headers && 'PAYMENT-SIGNATURE' in o.headers),
      ).toBe(true);
      const invalid = await connection.client.callTool({
        name: 'annon_buy',
        arguments: {
          target: h.offerFile,
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
    await expect(
      h.adapter({
        ...h.defaults,
        trustContract: false,
        json: true,
        command: 'buy',
        target: h.offerFile,
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
    await h.adapter({ ...h.defaults, command: 'buy', target: h.offerFile, route: 'base' });
    const payload = Buffer.from(
      JSON.stringify({ resource: { url: 'https://files.example/file' } }),
    ).toString('base64');
    const sdk = new Annon(h.options);
    await sdk.store.compareAndSet(purchaseKey(h.saved.id), h.saved, {
      ...h.saved,
      revision: 1,
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
    });
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
      ['buy', h.offerFile, '--route', 'base', '--wallet', 'evm', '--json'],
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
    const noCap = createAdapter(
      {
        ANNON_CONFIG: h.env.ANNON_CONFIG,
        ANNON_STATE_DIR: h.env.ANNON_STATE_DIR,
        ANNON_BACKUP_SECRET: h.env.ANNON_BACKUP_SECRET,
      },
      { wallet: vi.fn() },
    );
    await expect(
      noCap({ ...h.defaults, command: 'buy', target: h.offerFile }),
    ).rejects.toMatchObject({ code: 'max_price_required' });
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
      h.adapter({ ...h.defaults, command: 'buy', target: h.offerFile, maxPrice: '9' }),
    ).rejects.toMatchObject({ code: 'price_above_max' });
    expect(h.calls).toEqual([]);
  });
  it('uses only configured origin names and the wallet refund address', async () => {
    const h = await harness();
    await h.adapter({
      ...h.defaults,
      command: 'buy',
      target: h.offerFile,
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
        target: h.offerFile,
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
    h.env.ANNON_ALLOWED_RESOURCES = 'https://human.example/file';
    await expect(
      h.adapter({ ...h.defaults, command: 'buy', target: h.offerFile }),
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
  await writeFile(h.defaults.config, JSON.stringify({ dailyBudget: '0.3' }));
  const input = {
    ...h.defaults,
    command: 'buy' as const,
    target: h.offerFile,
    route: '1click' as const,
    origin: 'base-usdc',
  };
  await h.adapter(input);
  await expect(h.adapter(input)).rejects.toMatchObject({ code: 'budget_exceeded' });
  expect(h.calls.filter((c) => c.command === 'buy')).toHaveLength(1);
});

it('refuses an agent payment without a persisted budget before invoking buy', async () => {
  const h = await harness();
  await writeFile(h.defaults.config, '{}');
  await expect(
    h.adapter({
      ...h.defaults,
      command: 'buy',
      target: h.offerFile,
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
    h.adapter({ ...h.defaults, command: 'buy', target: h.offerFile, route: 'base' }),
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
    h.adapter({ ...h.defaults, command: 'buy', target: h.offerFile, route: 'base', json: true }),
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
      ['buy', h.offerFile, '--route', '1click', '--origin', 'base-usdc', '--json'],
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
      arguments: { target: h.offerFile, route: '1click', origin: 'base-usdc' },
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
        target: h.offerFile,
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
  'refunds the agent budget only for a definite quote refusal (status=%s)',
  async (status) => {
    const h = await harness();
    await writeFile(h.defaults.config, JSON.stringify({ dailyBudget: '0.2' }));
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
      target: h.offerFile,
      route: '1click' as const,
      origin: 'base-usdc',
    };
    await expect(h.adapter(input)).rejects.toThrow();
    h.fetcher.mockImplementation(original);
    if (status === 400) {
      await expect(h.adapter(input)).resolves.toMatchObject({ state: 'deposit_required' });
      expect(h.calls.filter((c) => c.command === 'buy')).toHaveLength(2);
    } else {
      await expect(h.adapter(input)).rejects.toMatchObject({ code: 'budget_exceeded' });
      expect(h.calls.filter((c) => c.command === 'buy')).toHaveLength(1);
    }
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
        const input = {
          ...h.defaults,
          network,
          command: 'buy' as const,
          target: h.offerFile,
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
        target: h.offerFile,
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
        target: h.offerFile,
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
