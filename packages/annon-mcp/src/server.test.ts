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
import { createAdapter } from '../../annon/src/node/adapter.js';
import type { Input } from '../../annon/src/node/cli.js';
import { runCli } from '../../annon/src/node/cli.js';
import { exportRecovery, type RecoveryRecord } from '../../annon/src/pay/backup.js';
import { type PurchaseRecord, purchaseKey } from '../../annon/src/pay/purchase.js';
import { paymentRequired } from '../../annon/src/pay/seller.js';
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
async function harness() {
  const dir = await mkdtemp(join(tmpdir(), 'annon-mcp-'));
  directories.push(dir);
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
  const finalTerms = { ...terms, cipher_hash: hex(sealed.cipherHash), seller: wallet.identity };
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
    agent: true,
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
    stateDir: dir,
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
      { ANNON_BACKUP_SECRET: h.env.ANNON_BACKUP_SECRET },
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
