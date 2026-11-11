import { bls12_381 as bls } from '@noble/curves/bls12-381.js';
import { base58 } from '@scure/base';
import { privateKeyToAccount } from 'viem/accounts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { terms as initial, must } from '../../test/fixtures.js';
import { fileAppId, hashPoint } from '../keys/near-ckd.js';
import { getFile } from '../near/rpc.js';
import {
  type EncryptedRecord,
  encryptedSellerKeyStore,
  encryptedSellStore,
  importPurchase,
  importRecovery,
  importSell,
  importSellerKey,
  newBackupSecret,
} from '../pay/backup.js';
import type { typedData } from '../pay/eip3009.js';
import { paymentRequired } from '../pay/seller.js';
import { memoryStore } from '../pay/store.js';
import { bytes, hex } from '../settle-near/codec.js';
import type { Identity } from '../settle-near/identity.js';
import { termsHash } from '../settle-near/terms.js';
import { Annon } from './annon.js';

const account = privateKeyToAccount(`0x${'42'.repeat(32)}`);
const wallet = {
  identity: { kind: 'evm', id: account.address.toLowerCase() } as Identity,
  authorize: async (text: string) => ({
    kind: 'evm' as const,
    sig: await account.signMessage({ message: text }),
  }),
};
const msk = 12345n;
const pk = bls.G2.Point.BASE.multiply(msk);
const mpcKey = `bls12381g2:${base58.encode(pk.toBytes(true))}`;
const body = new TextEncoder().encode('a file worth opening');
const now = 1800000000;
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
function harness(seller: Identity = wallet.identity) {
  const raw = memoryStore<EncryptedRecord>();
  const backupSecret = newBackupSecret();
  const backups = new Map<string, string>();
  let file: Uint8Array | undefined;
  let header: Uint8Array | undefined;
  let terms = { ...initial, seller };
  const purchases = new Map<
    string,
    {
      file_id: string;
      terms_hash: string;
      recovery: Identity;
      buyer_key: string;
      grants: number;
      purchase_id: string;
    }
  >();
  const grants = new Map<string, string>();
  const blockedFiles = new Set<string>();
  let baseCode = '0x';
  let baseBalance = 1000000n;
  const calls: {
    method: string;
    args: Record<string, unknown>;
  }[] = [];
  const answer = (fileId: string, key: string) => {
    const sig = hashPoint(pk, fileAppId(terms.contract, bytes(fileId, 32))).multiply(msk);
    return {
      big_y: `bls12381g1:${base58.encode(bls.G1.Point.BASE.multiply(77n).toBytes(true))}`,
      big_c: `bls12381g1:${base58.encode(sig.add(bls.G1.Point.fromBytes(bytes(key, 48)).multiply(77n)).toBytes(true))}`,
    };
  };
  const reopened = new Map<string, number>();
  const send = vi.fn(async (method: string, args: object) => {
    const a = args as Record<string, unknown>;
    calls.push({ method, args: a });
    if (method === 'register') {
      const x = a.args as {
        terms: typeof terms;
        seller_key: string;
      };
      terms = x.terms;
      return answer(terms.file_id, x.seller_key);
    }
    if (method === 'claim_key') {
      const p = must(purchases.get(a.purchase_id as string));
      return answer(p.file_id, must(grants.get(`${a.purchase_id}:${a.grant}`)));
    }
    if (method === 'reopen') {
      const x = a.args as {
        purchase_id: string;
        fresh_key: string;
        nonce: string;
      };
      const p = must(purchases.get(x.purchase_id));
      const request = `${x.purchase_id}:${x.fresh_key}:${x.nonce}`;
      const grant = reopened.get(request) ?? p.grants++;
      reopened.set(request, grant);
      grants.set(`${x.purchase_id}:${grant}`, x.fresh_key);
      return answer(p.file_id, x.fresh_key);
    }
    return null;
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url, init) => {
      const q = JSON.parse(String(init?.body));
      if (q.method !== 'query') {
        const result =
          q.method === 'eth_chainId'
            ? '0x2105'
            : q.method === 'eth_getBlockByNumber'
              ? { number: '0x100', timestamp: `0x${now.toString(16)}` }
              : q.method === 'eth_getCode'
                ? baseCode
                : q.method === 'eth_call'
                  ? `0x${baseBalance.toString(16).padStart(64, '0')}`
                  : null;
        return { json: async () => ({ id: q.id, result }) };
      }
      const a = JSON.parse(Buffer.from(q.params.args_base64, 'base64').toString());
      const result =
        q.params.method_name === 'public_key'
          ? mpcKey
          : q.params.method_name === 'get_file'
            ? blockedFiles.has(a.file_id)
              ? {
                  terms: { ...terms, file_id: a.file_id },
                  terms_hash: termsHash({ ...terms, file_id: a.file_id }),
                  header_hash: null,
                  sales_stopped_at: null,
                  taken_down: 'court_order',
                }
              : {
                  terms,
                  terms_hash: termsHash(terms, { nearUsdc: terms.near.token }),
                  header_hash: header
                    ? hex(
                        await (await import('../envelope/pay2.js')).sha256(
                          header.subarray(0, header.length - 65),
                        ),
                      )
                    : null,
                  sales_stopped_at: null,
                  taken_down: null,
                }
            : q.params.method_name === 'get_purchase'
              ? purchases.has(a.purchase_id)
                ? {
                    route: 'near-usdc',
                    delivery: 0,
                    accepted_at: now,
                    ...purchases.get(a.purchase_id),
                  }
                : null
              : q.params.method_name === 'get_grant'
                ? grants.has(`${a.purchase_id}:${a.grant}`)
                  ? {
                      purchase_id: a.purchase_id,
                      grant: a.grant,
                      buyer_key: grants.get(`${a.purchase_id}:${a.grant}`),
                    }
                  : null
                : q.params.method_name === 'get_config'
                  ? {
                      network: 'near:mainnet',
                      near_usdc: terms.near.token,
                      intents: 'intents.near',
                      mpc: 'v1.signer',
                      ckd_domain: 2,
                      foreign_tx_domain: 3,
                      usdc: initial.base?.usdc,
                    }
                  : q.params.method_name === 'purchases_of'
                    ? [...purchases.keys()].slice(a.from, a.from + a.limit)
                    : null;
      return {
        json: async () => ({
          id: q.id,
          result: { result: [...Buffer.from(JSON.stringify(result))] },
        }),
      };
    }),
  );
  const config = {
    nearRpc: 'https://near.rpc',
    baseRpc: 'https://base.rpc',
    contractId: terms.contract,
    network: 'near:mainnet',
    rawStore: raw,
    backupSecret,
    writeBackup: async (name: string, data: string) => {
      backups.set(name, data);
    },
    send,
    mpcKey,
    now: () => now,
  };
  const sdk = new Annon(config);
  return {
    sdk,
    set baseCode(value: string) {
      baseCode = value;
    },
    set baseBalance(value: bigint) {
      baseBalance = value;
    },
    config,
    raw,
    backupSecret,
    backups,
    send,
    calls,
    purchases,
    grants,
    blockedFiles,
    set nearToken(value: string) {
      terms = { ...terms, near: { ...terms.near, token: value } };
    },
    get terms() {
      return terms;
    },
    get file() {
      return must(file);
    },
    get header() {
      return must(header);
    },
    publish: async (value: { file: Uint8Array; header: Uint8Array }) => {
      file = value.file;
      header = value.header;
    },
  };
}
describe('high-level one-model API', () => {
  it('sells with normalized sorted split terms, registers then publishes and opens a purchased grant', async () => {
    const h = harness();
    const sold = await h.sdk.sell({
      data: body,
      name: 'file.txt',
      mime: 'text/plain',
      seller: wallet,
      near: {
        price: '200000',
        recipients: [{ identity: wallet.identity, bps: 10000 }],
        remainder: wallet.identity,
      },
      publish: h.publish,
    });
    expect(must(h.calls[0]).method).toBe('register');
    expect(sold.terms.pay2_version).toBe(2);
    expect(h.file).toEqual(sold.file);
    expect(
      await importSell(must(h.backups.get(`sell:${sold.terms.file_id}`)), h.backupSecret),
    ).toMatchObject({ published: true, fileKey: null, sellerSecret: null, ckdSecret: null });
    const bought = await h.sdk.buy({
      fileId: sold.terms.file_id,
      header: h.header,
      recovery: wallet,
      refund: wallet.identity,
      maxPrice: 200000n,
      oneClick: {
        quote: async (message: string) => ({
          request: { customRecipientMsg: message },
          response: {},
          deposit: {
            address: 'deposit',
            amount: '202064',
            asset: 'origin',
            chain: 'evm',
            qrData: 'data',
          },
        }),
      } as never,
      origin: { asset: 'nep141:origin', chain: 'evm', refundTo: wallet.identity.id },
    });
    expect(bought.route).toBe('near-usdc');
    expect(must(bought.instructions).address).toBe('deposit');
    expect(await importPurchase(must(h.backups.get(bought.record.id)), h.backupSecret)).toEqual(
      bought.record,
    );
    await expect(h.sdk.open({ record: bought.record, file: h.file })).rejects.toMatchObject({
      code: 'settlement_processing',
    });
    expect(h.calls.some((c) => c.method === 'claim_key')).toBe(false);
    const p = bought.record.purchase;
    h.purchases.set(bought.record.id, {
      purchase_id: bought.record.id,
      file_id: p.file_id,
      terms_hash: p.terms_hash,
      recovery: p.recovery,
      buyer_key: p.buyer_key,
      grants: 1,
    });
    h.grants.set(`${bought.record.id}:0`, p.buyer_key);
    expect((await h.sdk.open({ record: bought.record, file: h.file })).data).toEqual(body);
  });
  it('sends direct NEAR USDC only after the encrypted record and backup exist', async () => {
    const h = harness();
    await h.sdk.sell({
      data: body,
      name: 'x',
      mime: '',
      seller: wallet,
      near: {
        price: '200000',
        recipients: [{ identity: wallet.identity, bps: 10000 }],
        remainder: wallet.identity,
      },
      publish: h.publish,
    });
    const transferPurchase = vi.fn(async (message: string) => {
      const id = JSON.parse(message).purchase.purchase_id;
      expect(h.backups.has(id)).toBe(true);
      return null;
    });
    const payer = {
      identity: { kind: 'near', id: 'buyer.near' } as const,
      authorize: async () => undefined,
      call: vi.fn(),
      transferPurchase,
    };
    await h.sdk.buy({
      fileId: h.terms.file_id,
      header: h.header,
      recovery: wallet,
      refund: payer.identity,
      payer,
      maxPrice: 200000n,
    });
    expect(transferPurchase).toHaveBeenCalledTimes(1);
  });
  it('recovers on a fresh device through purchases_of and reopen, persisting the fresh secret first', async () => {
    const h = harness();
    await h.sdk.sell({
      data: body,
      name: 'x',
      mime: '',
      seller: wallet,
      near: {
        price: '200000',
        recipients: [{ identity: wallet.identity, bps: 10000 }],
        remainder: wallet.identity,
      },
      publish: h.publish,
    });
    const id = `0x${'77'.repeat(32)}`;
    h.purchases.set(id, {
      purchase_id: id,
      file_id: h.terms.file_id,
      terms_hash: termsHash(h.terms),
      recovery: wallet.identity,
      buyer_key: hex(bls.G1.Point.BASE.toBytes(true)),
      grants: 1,
    });
    h.grants.set(`${id}:0`, hex(bls.G1.Point.BASE.toBytes(true)));
    const fresh = new Annon({ ...h.config, rawStore: memoryStore<EncryptedRecord>() });
    const recovered = await fresh.recover({ wallet });
    expect(recovered).toHaveLength(1);
    expect(must(recovered[0]).grant).toBe(1);
    expect(
      await importRecovery(must(h.backups.get(`recovery:${id}`)), h.backupSecret),
    ).toMatchObject({
      purchase_id: id,
      grant: 1,
    });
    expect((await fresh.open({ recovery: must(recovered[0]), file: h.file })).data).toEqual(body);
    await fresh.stop({ fileId: h.terms.file_id, seller: wallet });
    expect(must(h.calls.at(-1)).method).toBe('stop_sales');
  });
  it('creates an ownerless Base split only for EVM recipients, and requires proof for NEAR recovery', async () => {
    const h = harness();
    const sendBaseTransaction = vi.fn(async () => {});
    await h.sdk.sell({
      data: body,
      name: 'x',
      mime: '',
      seller: wallet,
      near: {
        price: '200000',
        recipients: [{ identity: wallet.identity, bps: 10000 }],
        remainder: wallet.identity,
      },
      base: { price: '200000', sendTransaction: sendBaseTransaction },
      publish: h.publish,
    });
    expect(sendBaseTransaction).toHaveBeenCalledTimes(1);
    expect(must(h.terms.base).pay_to).toMatch(/^0x[0-9a-f]{40}$/);
    const recovery = {
      identity: { kind: 'near', id: 'buyer.near' } as const,
      authorize: async () => undefined,
      call: vi.fn(),
      transferPurchase: vi.fn(),
    };
    await expect(
      h.sdk.buy({
        fileId: h.terms.file_id,
        header: h.header,
        recovery,
        refund: recovery.identity,
        origin: { asset: 'nep141:origin', chain: 'near', refundTo: 'buyer.near' },
        maxPrice: 200000n,
      }),
    ).rejects.toThrow(/ownership proof/);
  });
  it('chooses Base for funded EVM EOAs, uses the commitment nonce, and backs up before signing or submitting', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(now * 1000);
    const h = harness();
    await h.sdk.sell({
      data: body,
      name: 'x',
      mime: '',
      seller: wallet,
      near: {
        price: '200000',
        recipients: [{ identity: wallet.identity, bps: 10000 }],
        remainder: wallet.identity,
      },
      base: { price: '200000', sendTransaction: async () => {} },
      publish: h.publish,
    });
    const required = paymentRequired(
      {
        nearRpc: h.config.nearRpc,
        contractId: h.config.contractId,
        fileId: h.terms.file_id,
        url: 'https://files.example/f',
        header: 'https://files.example/header',
      },
      must(await getFile(h.config.nearRpc, h.config.contractId, h.terms.file_id)),
      must(initial.base).usdc,
    );
    const payer = {
      ...wallet,
      address: account.address,
      signTypedData: async (data: ReturnType<typeof typedData>) => {
        expect([...h.backups.keys()].filter((k) => !k.startsWith('sell:'))).toHaveLength(1);
        return account.signTypedData(data as never);
      },
    };
    const submitBase = vi.fn(async () => {
      const r = await importPurchase(
        must([...h.backups.entries()].find(([k]) => !k.startsWith('sell:'))?.[1]),
        h.backupSecret,
      );
      expect(r.attempts[0]?.payload).toBeTruthy();
    });
    const result = await h.sdk.buy({
      fileId: h.terms.file_id,
      header: h.header,
      recovery: wallet,
      refund: wallet.identity,
      payer,
      maxPrice: 200000n,
      paymentRequired: required,
      url: 'https://files.example/f',
      submitBase,
    });
    expect(result.route).toBe('base-usdc');
    expect(submitBase).toHaveBeenCalledTimes(1);
    expect(result.record.purchase.network).toBe('eip155:8453');
  });
  it.each(['smart wallet', 'insufficient balance'])(
    'routes %s through NEAR/1Click',
    async (reason) => {
      const h = harness();
      await h.sdk.sell({
        data: body,
        name: 'x',
        mime: '',
        seller: wallet,
        near: {
          price: '200000',
          recipients: [{ identity: wallet.identity, bps: 10000 }],
          remainder: wallet.identity,
        },
        base: { price: '200000', sendTransaction: async () => {} },
        publish: h.publish,
      });
      if (reason === 'smart wallet') h.baseCode = '0x1234';
      else h.baseBalance = 0n;
      const signTypedData = vi.fn();
      const quote = vi.fn(async () => ({
        request: {},
        response: {},
        deposit: {
          address: 'deposit',
          amount: '202064',
          asset: 'origin',
          chain: 'evm',
          qrData: 'data',
        },
      }));
      const result = await h.sdk.buy({
        fileId: h.terms.file_id,
        header: h.header,
        recovery: wallet,
        refund: wallet.identity,
        payer: { ...wallet, signTypedData } as never,
        maxPrice: 200000n,
        oneClick: { quote } as never,
        origin: { asset: 'nep141:origin', chain: 'evm', refundTo: wallet.identity.id },
      });
      expect(result.route).toBe('near-usdc');
      expect(signTypedData).not.toHaveBeenCalled();
      expect(quote).toHaveBeenCalledTimes(1);
    },
  );
  it('NEAR sellers call register and publish_header themselves before hosting', async () => {
    const seller = {
      identity: { kind: 'near', id: 'seller.near' } as const,
      authorize: async () => undefined,
      call: vi.fn(),
      transferPurchase: vi.fn(),
    };
    const h = harness(seller.identity);
    await h.sdk.sell({
      data: body,
      name: 'x',
      mime: '',
      seller,
      near: {
        price: '200000',
        recipients: [{ identity: wallet.identity, bps: 10000 }],
        remainder: wallet.identity,
      },
      publish: async (file) => {
        expect(h.calls.map((c) => c.method)).toEqual(['register', 'publish_header']);
        await h.publish(file);
      },
    });
    expect(h.header[7]).toBe(2);
    expect(h.header.subarray(-65).every((x) => x === 0)).toBe(true);
  });
  it('resumes an identical recovery after the transaction reply is lost, retaining the fresh secret', async () => {
    const h = harness();
    await h.sdk.sell({
      data: body,
      name: 'x',
      mime: '',
      seller: wallet,
      near: {
        price: '200000',
        recipients: [{ identity: wallet.identity, bps: 10000 }],
        remainder: wallet.identity,
      },
      publish: h.publish,
    });
    const id = `0x${'88'.repeat(32)}`;
    h.purchases.set(id, {
      purchase_id: id,
      file_id: h.terms.file_id,
      terms_hash: termsHash(h.terms),
      recovery: wallet.identity,
      buyer_key: hex(bls.G1.Point.BASE.toBytes(true)),
      grants: 1,
    });
    const original = must(h.send.getMockImplementation());
    h.send.mockImplementationOnce(async (method, args) => {
      await original(method, args);
      throw new Error('lost reply');
    });
    await expect(h.sdk.recover({ wallet, purchaseId: id })).rejects.toThrow('lost reply');
    const pending = await importRecovery(must(h.backups.get(`recovery:${id}`)), h.backupSecret);
    const [r] = await h.sdk.recover({ wallet, purchaseId: id });
    expect(must(r).buyerSecret).toBe(pending.buyerSecret);
    expect(must(r).grant).toBe(1);
    expect(must(h.purchases.get(id)).grants).toBe(2);
  });
  it('uses deadlines below the relay limit even with a client clock one second ahead', async () => {
    const h = harness();
    await h.sdk.sell({
      data: body,
      name: 'x',
      mime: '',
      seller: wallet,
      near: {
        price: '200000',
        recipients: [{ identity: wallet.identity, bps: 10000 }],
        remainder: wallet.identity,
      },
      publish: h.publish,
    });
    expect((must(h.calls[0]).args.args as { deadline: number }).deadline).toBeLessThanOrEqual(
      now - 1 + 600,
    );
  });
  it('rejects an unavailable fallback before recovery signatures, records or backups', async () => {
    const h = harness();
    await h.sdk.sell({
      data: body,
      name: 'x',
      mime: '',
      seller: wallet,
      near: {
        price: '200000',
        recipients: [{ identity: wallet.identity, bps: 10000 }],
        remainder: wallet.identity,
      },
      base: { price: '200000', sendTransaction: async () => {} },
      publish: h.publish,
    });
    h.baseBalance = 0n;
    const authorize = vi.fn(wallet.authorize);
    const backups = h.backups.size;
    await expect(
      h.sdk.buy({
        fileId: h.terms.file_id,
        header: h.header,
        recovery: { ...wallet, authorize },
        payer: { ...wallet, signTypedData: vi.fn() } as never,
        refund: wallet.identity,
        maxPrice: 200000n,
      }),
    ).rejects.toThrow(/origin/);
    expect(authorize).not.toHaveBeenCalled();
    expect(h.backups.size).toBe(backups);
  });
  it('rotates an expired unaccepted recovery and isolates a broken purchase in a batch', async () => {
    const h = harness();
    await h.sdk.sell({
      data: body,
      name: 'x',
      mime: '',
      seller: wallet,
      near: {
        price: '200000',
        recipients: [{ identity: wallet.identity, bps: 10000 }],
        remainder: wallet.identity,
      },
      publish: h.publish,
    });
    const id = `0x${'99'.repeat(32)}`;
    const broken = `0x${'98'.repeat(32)}`;
    const brokenFile = `0x${'97'.repeat(32)}`;
    h.blockedFiles.add(brokenFile);
    h.purchases.set(broken, {
      purchase_id: broken,
      file_id: brokenFile,
      terms_hash: termsHash(h.terms),
      recovery: wallet.identity,
      buyer_key: hex(bls.G1.Point.BASE.toBytes(true)),
      grants: 1,
    });
    h.purchases.set(id, {
      purchase_id: id,
      file_id: h.terms.file_id,
      terms_hash: termsHash(h.terms),
      recovery: wallet.identity,
      buyer_key: hex(bls.G1.Point.BASE.toBytes(true)),
      grants: 1,
    });
    h.send.mockRejectedValueOnce(new Error('offline'));
    await expect(h.sdk.recover({ wallet, purchaseId: id })).rejects.toThrow('offline');
    const old = await importRecovery(must(h.backups.get(`recovery:${id}`)), h.backupSecret);
    const fresh = new Annon({ ...h.config, now: () => now + 601 });
    const errors: string[] = [];
    const recovered = await fresh.recover({
      wallet,
      onError: (id: string) => {
        errors.push(id);
      },
    } as never);
    expect(errors).toEqual([broken]);
    expect(recovered).toHaveLength(1);
    expect(recovered[0]?.buyerSecret).not.toBe(old.buyerSecret);
    expect(recovered[0]?.revision).toBe(2);
    expect([...h.backups.keys()].some((k) => k.includes('revision'))).toBe(true);
  });

  it('resumes a seller after registration lands and the answer or publication is lost', async () => {
    const h = harness();
    const fileId = `0x${'ab'.repeat(32)}`;
    const original = must(h.send.getMockImplementation());
    h.send.mockImplementationOnce(async (method, args) => {
      await original(method, args);
      throw new Error('lost register answer');
    });
    const options = {
      data: body,
      name: 'x',
      mime: '',
      seller: wallet,
      fileId,
      near: {
        price: '200000',
        recipients: [{ identity: wallet.identity, bps: 10000 }],
        remainder: wallet.identity,
      },
      publish: h.publish,
    };
    await expect(h.sdk.sell(options)).rejects.toMatchObject({ fileId });
    expect(h.backups.has(`sell:${fileId}`)).toBe(true);
    h.send.mockImplementation(async (method, args) => {
      if (method === 'reopen_seller') {
        const a = (args as { args: { key: string } }).args;
        const sig = hashPoint(pk, fileAppId(h.terms.contract, bytes(fileId, 32))).multiply(msk);
        return {
          big_y: `bls12381g1:${base58.encode(bls.G1.Point.BASE.multiply(77n).toBytes(true))}`,
          big_c: `bls12381g1:${base58.encode(sig.add(bls.G1.Point.fromBytes(bytes(a.key, 48)).multiply(77n)).toBytes(true))}`,
        };
      }
      return original(method, args);
    });
    const resumed = new Annon(h.config);
    const publish = vi
      .fn()
      .mockRejectedValueOnce(new Error('host unavailable'))
      .mockImplementation(h.publish);
    await expect(
      resumed.resumeSell({ fileId, data: body, seller: wallet, publish }),
    ).rejects.toThrow('host unavailable');
    const pending = await importSell(must(h.backups.get(`sell:${fileId}`)), h.backupSecret);
    expect(pending.fileKey).not.toBeNull();
    expect(pending.ckdSecret).not.toBeNull();
    await expect(
      resumed.resumeSell({ fileId, data: new Uint8Array([9]), seller: wallet, publish }),
    ).rejects.toThrow(/cipher/);
    const sold = await resumed.resumeSell({ fileId, data: body, seller: wallet, publish });
    expect(sold.terms.file_id).toBe(fileId);
    const completed = await importSell(must(h.backups.get(`sell:${fileId}`)), h.backupSecret);
    expect(completed).toMatchObject({
      published: true,
      fileKey: null,
      sellerSecret: null,
      ckdSecret: null,
    });
    expect(await encryptedSellStore(h.raw, h.backupSecret).load(`annon/sell/${fileId}`)).toEqual(
      completed,
    );
    const sellerKey = await importSellerKey(
      must(h.backups.get(`seller-key:${fileId}`)),
      h.backupSecret,
    );
    expect(sellerKey.buyerSecret).toBeNull();
    expect(
      await encryptedSellerKeyStore(h.raw, h.backupSecret).load(`annon/seller-key/${fileId}`),
    ).toEqual(sellerKey);
    expect(h.calls.filter((c) => c.method === 'register')).toHaveLength(1);
    await expect(
      resumed.resumeSell({ fileId, data: new Uint8Array([9]), seller: wallet, publish }),
    ).rejects.toThrow(/published/);
  });
  it('reads CKD keys from the configured MPC domain, with explicit overrides pinned to it', async () => {
    const h = harness();
    const globalFetch = globalThis.fetch;
    const observed: unknown[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url, init) => {
        const q = JSON.parse(String(init?.body));
        if (q.params?.method_name === 'public_key') {
          observed.push({
            account: q.params.account_id,
            args: JSON.parse(Buffer.from(q.params.args_base64, 'base64').toString()),
          });
          return {
            json: async () => ({
              id: q.id,
              result: { result: [...Buffer.from(JSON.stringify(mpcKey))] },
            }),
          };
        }
        return globalFetch(url, init);
      }),
    );
    const dynamic = new Annon({ ...h.config, mpcKey: undefined } as never);
    await dynamic.sell({
      data: body,
      name: 'x',
      mime: '',
      seller: wallet,
      near: {
        price: '200000',
        recipients: [{ identity: wallet.identity, bps: 10000 }],
        remainder: wallet.identity,
      },
      publish: h.publish,
    });
    expect(observed).toContainEqual({ account: 'v1.signer', args: { domain_id: 2 } });
  });

  it('reopens a seller on a fresh device without an existing sell job', async () => {
    const h = harness();
    const sdk = new Annon({ ...h.config, rawStore: memoryStore<EncryptedRecord>() });
    const original = must(h.send.getMockImplementation());
    h.send.mockImplementation(async (method, args) => {
      if (method !== 'reopen_seller') return original(method, args);
      expect([...h.backups.keys()].some((k) => k.startsWith('seller-key:'))).toBe(true);
      const a = (args as { args: { key: string } }).args;
      const sig = hashPoint(pk, fileAppId(h.terms.contract, bytes(h.terms.file_id, 32))).multiply(
        msk,
      );
      return {
        big_y: `bls12381g1:${base58.encode(bls.G1.Point.BASE.multiply(77n).toBytes(true))}`,
        big_c: `bls12381g1:${base58.encode(sig.add(bls.G1.Point.fromBytes(bytes(a.key, 48)).multiply(77n)).toBytes(true))}`,
      };
    });
    expect(await sdk.reopenSeller({ fileId: h.terms.file_id, seller: wallet })).toHaveLength(48);
  });
  it('reports missing prepaid storage with an actionable refusal', async () => {
    const h = harness();
    h.send.mockRejectedValueOnce(
      new Error('attach at least 500 yoctoNEAR for storage, or call storage_deposit first'),
    );
    await expect(
      h.sdk.sell({
        data: body,
        name: 'x',
        mime: '',
        seller: wallet,
        near: {
          price: '200000',
          recipients: [{ identity: wallet.identity, bps: 10000 }],
          remainder: wallet.identity,
        },
        publish: h.publish,
      }),
    ).rejects.toMatchObject({ code: 'storage_required' });
  });
  it('requires a real price cap at the SDK runtime boundary', async () => {
    const h = harness();
    await expect(h.sdk.buy({ maxPrice: undefined } as never)).rejects.toThrow(/maxPrice/);
  });
  it('rejects a configured CKD pin that differs from the configured MPC domain', async () => {
    const h = harness();
    const sdk = new Annon({
      ...h.config,
      mpcKey: `bls12381g2:${base58.encode(bls.G2.Point.BASE.toBytes(true))}`,
    });
    await expect(
      sdk.sell({
        data: body,
        name: 'x',
        mime: '',
        seller: wallet,
        near: {
          price: '200000',
          recipients: [{ identity: wallet.identity, bps: 10000 }],
          remainder: wallet.identity,
        },
        publish: h.publish,
      }),
    ).rejects.toThrow(/configured MPC key/);
  });
  it('retains configured token support when saving and resuming seller registrations', async () => {
    const h = harness();
    h.nearToken = 'usdc.test.near';
    const fileId = `0x${'ac'.repeat(32)}`;
    const options = {
      fileId,
      data: body,
      name: 'x',
      mime: '',
      seller: wallet,
      near: {
        price: '200000',
        recipients: [{ identity: wallet.identity, bps: 10000 }],
        remainder: wallet.identity,
      },
      publish: h.publish,
    };
    await expect(
      h.sdk.sell({
        ...options,
        publish: async () => {
          throw new Error('host unavailable');
        },
      }),
    ).rejects.toThrow();
    const sold = await h.sdk.resumeSell({ fileId, data: body, seller: wallet, publish: h.publish });
    expect(sold.terms.near.token).toBe('usdc.test.near');
    expect(sold.file).toEqual(h.file);
    await expect(
      h.sdk.resumeSell({ fileId, data: body, seller: wallet, publish: h.publish }),
    ).rejects.toThrow(/published/);
  });
});
