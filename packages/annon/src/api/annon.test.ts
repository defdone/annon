import { bls12_381 as bls } from '@noble/curves/bls12-381.js';
import { base58 } from '@scure/base';
import { privateKeyToAccount } from 'viem/accounts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { terms as initial, must } from '../../test/fixtures.js';
import { sealWithKey } from '../envelope/pay2.js';
import { blobSource } from '../envelope/replay.js';
import { fileAppId, hashPoint } from '../keys/near-ckd.js';
import { getFile } from '../near/rpc.js';
import {
  type EncryptedRecord,
  encryptedSellerKeyStore,
  encryptedSellStore,
  exportSell,
  importPurchase,
  importRecovery,
  importSell,
  importSellerKey,
  newBackupSecret,
  type SellerKeyRecord,
} from '../pay/backup.js';
import type { typedData } from '../pay/eip3009.js';
import { purchaseKey } from '../pay/purchase.js';
import * as recoverySteps from '../pay/recover.js';
import { paymentRequired } from '../pay/seller.js';
import { createSplit, type Split } from '../pay/split.js';
import { memoryStore } from '../pay/store.js';
import { bytes, hex } from '../settle-near/codec.js';
import type { Identity } from '../settle-near/identity.js';
import { parsePurchaseMessage, purchaseId } from '../settle-near/purchase.js';
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
  let storageBalance = 10n ** 24n;
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
        q.params.method_name === 'file_storage_balance'
          ? {
              available: storageBalance.toString(),
              admission_requirement: '40960000000000000000000',
            }
          : q.params.method_name === 'public_key'
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
    set storageBalance(value: bigint) {
      storageBalance = value;
    },
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
    answer,
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
  it.each(['push', 'pull'] as const)(
    'retains %s split provenance in results and encrypted sell backups',
    async (kind) => {
      const h = harness();
      const sendTransaction = vi.fn(async (_call: import('../pay/split.js').SplitCall) => {});
      const publish = vi.fn(async () => {
        throw new Error('publication unavailable');
      });
      const fileId = initial.file_id;
      await expect(
        h.sdk.sell({
          fileId,
          data: body,
          name: 'f',
          mime: '',
          seller: wallet,
          near: {
            price: '200000',
            recipients: [{ identity: wallet.identity, bps: 10000 }],
            remainder: wallet.identity,
          },
          base: { price: '200000', kind, sendTransaction },
          publish,
        }),
      ).rejects.toThrow('publication unavailable');
      const job = await importSell(must(h.backups.get(`sell:${fileId}`)), h.backupSecret);
      const provenance = must(job.baseSplit);
      expect(provenance).toEqual({
        address: must(job.terms.base).pay_to,
        kind,
        salt: expect.stringMatching(/^0x[0-9a-f]{64}$/),
      });
      const split: Split = {
        recipients: job.terms.near.recipients.map((r) => r.identity.id),
        allocations: job.terms.near.recipients.map((r) => BigInt(r.bps)),
        totalAllocation: 10000n,
        distributionIncentive: 0,
      };
      expect(createSplit(kind, split, provenance.salt)).toEqual(sendTransaction.mock.calls[0]?.[0]);
      const hash = termsHash(job.terms);
      const sold = await h.sdk.resumeSell({
        fileId,
        data: body,
        seller: wallet,
        publish: h.publish,
      });
      expect(sold.baseSplit).toEqual(provenance);
      expect(termsHash(sold.terms)).toBe(hash);
      const saved = await importSell(must(h.backups.get(`sell:${fileId}`)), h.backupSecret);
      expect(saved.published).toBe(true);
      expect(saved.baseSplit).toEqual(provenance);
      expect(sendTransaction).toHaveBeenCalledTimes(1);
    },
  );
  it('imports and resumes an old Base sell record without split provenance', async () => {
    const h = harness();
    const fileId = initial.file_id;
    await expect(
      h.sdk.sell({
        fileId,
        data: body,
        name: 'f',
        mime: '',
        seller: wallet,
        near: {
          price: '200000',
          recipients: [{ identity: wallet.identity, bps: 10000 }],
          remainder: wallet.identity,
        },
        base: { price: '200000', sendTransaction: async () => {} },
        publish: async () => {
          throw new Error('publication unavailable');
        },
      }),
    ).rejects.toThrow('publication unavailable');
    const job = await importSell(must(h.backups.get(`sell:${fileId}`)), h.backupSecret);
    const { baseSplit: _baseSplit, ...old } = job;
    const legacy = await importSell(await exportSell(old, h.backupSecret), h.backupSecret);
    expect(Object.hasOwn(legacy, 'baseSplit')).toBe(false);
    expect(legacy.terms.base).not.toBeNull();
    const store = encryptedSellStore(h.raw, h.backupSecret);
    expect(
      await store.compareAndSet(`annon/sell/${fileId}`, job, {
        ...legacy,
        revision: legacy.revision + 1,
      }),
    ).toBe(true);
    const sold = await new Annon(h.config).resumeSell({
      fileId,
      data: body,
      seller: wallet,
      publish: h.publish,
    });
    expect(sold.terms).toEqual(old.terms);
    expect(Object.hasOwn(sold, 'baseSplit')).toBe(false);
    const saved = await importSell(must(h.backups.get(`sell:${fileId}`)), h.backupSecret);
    expect(saved.published).toBe(true);
    expect(Object.hasOwn(saved, 'baseSplit')).toBe(false);
  });
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
  it.each(['accepted', 'declined', 'expired', 'short', 'exact-margin', 'proof-short'])(
    'saves the live 1Click quote before confirmation and recovery proof (%s)',
    async (mode) => {
      const h = harness();
      await h.sdk.sell({
        data: body,
        name: 'f',
        mime: '',
        seller: wallet,
        near: {
          price: '200000',
          recipients: [{ identity: wallet.identity, bps: 10000 }],
          remainder: wallet.identity,
        },
        publish: h.publish,
      });
      let current = now;
      const sdk = new Annon({ ...h.config, now: () => current });
      const order: string[] = [];
      const recovery = {
        ...wallet,
        authorize: vi.fn(async (text: string) => {
          order.push('proof');
          if (mode === 'proof-short') current = now + 2401;
          return wallet.authorize(text);
        }),
      };
      const quote = vi.fn(async (message: string) => {
        order.push('quote');
        const purchase = parsePurchaseMessage(message);
        const id = purchaseId(purchase);
        expect(await h.sdk.store.load(purchaseKey(id))).not.toBeNull();
        return {
          request: { customRecipientMsg: message },
          response: {},
          deposit: {
            address: 'test-deposit',
            amount: '202064',
            asset: 'nep141:source',
            chain: 'solana',
            qrData: 'test',
            depositBefore: new Date((now + 3000) * 1000).toISOString(),
          },
        };
      });
      const onQuote = vi.fn(async (q: import('../oneclick/oneclick.js').OneClickQuote) => {
        order.push('confirm');
        const p = parsePurchaseMessage(q.request.customRecipientMsg);
        const saved = await importPurchase(must(h.backups.get(purchaseId(p))), h.backupSecret);
        expect(saved.quote).toEqual(q);
        if (mode === 'declined') throw new Error('declined');
        if (mode === 'expired') current = now + 3001;
        if (mode === 'short') current = now + 2401;
        if (mode === 'exact-margin') current = now + 2400;
      });
      const operation = sdk.buy({
        fileId: h.terms.file_id,
        header: h.header,
        recovery,
        refund: wallet.identity,
        maxPrice: 200000n,
        origin: {
          asset: 'nep141:source',
          chain: 'solana',
          refundTo: base58.encode(new Uint8Array(32).fill(9)),
        },
        oneClick: { quote } as never,
        onQuote,
      });
      if (mode === 'accepted' || mode === 'exact-margin')
        await expect(operation).resolves.toMatchObject({ instructions: { amount: '202064' } });
      else if (mode === 'declined') await expect(operation).rejects.toThrow('declined');
      else await expect(operation).rejects.toMatchObject({ code: 'quote_expired' });
      expect(order).toEqual(
        ['accepted', 'exact-margin', 'proof-short'].includes(mode)
          ? ['quote', 'confirm', 'proof']
          : ['quote', 'confirm'],
      );
      expect(h.send.mock.calls.map(([method]) => method)).toEqual(['register']);
    },
  );
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
  it('persists and returns purchaseId and txHash as uncertain after an ambiguous NEAR submission', async () => {
    const { TransactionUncertain } = await import('../wallet/uncertain.js');
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
    const payer = {
      identity: { kind: 'near' as const, id: 'buyer.near' },
      authorize: async () => undefined,
      call: vi.fn(),
      transferPurchase: vi.fn(async () => {
        throw new TransactionUncertain('KNOWN-HASH');
      }),
    };
    const bought = await h.sdk.buy({
      fileId: h.terms.file_id,
      header: h.header,
      recovery: wallet,
      refund: payer.identity,
      payer,
      maxPrice: 200000n,
    });
    expect(bought.uncertain).toEqual({ purchaseId: bought.record.id, txHash: 'KNOWN-HASH' });
    const restored = await importPurchase(must(h.backups.get(bought.record.id)), h.backupSecret);
    expect(restored.nearSubmission).toEqual({ state: 'uncertain', txHash: 'KNOWN-HASH' });
    expect(payer.transferPurchase).toHaveBeenCalledTimes(1);
  });
  it.each(['receiver', 'method', 'args', 'gas', 'deposit', 'failed'])(
    'never saves forged nearSubmission evidence after a definite %s rejection',
    async (mismatch) => {
      const { configuredWallet } = await import('../node/signer-wallet.js');
      const { signingRequest } = await import('../node/signing.js');
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
      const existingBackups = new Set(h.backups.keys());
      const originalFetch = globalThis.fetch;
      const payer = await configuredWallet(
        { mode: 'browser', identity: { kind: 'near', id: 'buyer.near' } },
        {
          nearRpc: 'https://fake.rpc',
          baseRpc: '',
          contractId: 'annon.near',
          network: 'near:testnet',
          stateDir: '/unused',
        },
        { command: 'buy' },
        {},
        { read: vi.fn(), create: vi.fn() },
        async () => ({
          url: 'http://127.0.0.1:1234/#FAKE',
          pairingCode: 'FAKE',
          close: async () => {},
          async request<T>(
            action: { id: string; expiresAt: number },
            verify: (r: T) => Promise<void>,
          ) {
            const q = action as ReturnType<typeof signingRequest>;
            const p = q.payload as {
              receiverId: string;
              method: string;
              args: object;
              gas: string;
              deposit: string;
            };
            vi.stubGlobal(
              'fetch',
              vi.fn(async (url, init) => {
                const rpc = JSON.parse(String(init?.body));
                if (rpc.method !== 'tx' && rpc.method !== 'EXPERIMENTAL_tx_status')
                  return originalFetch(url, init);
                return Response.json({
                  id: rpc.id,
                  result: {
                    final_execution_status: 'FINAL',
                    transaction: {
                      hash: 'FORGED',
                      signer_id: q.account,
                      receiver_id: mismatch === 'receiver' ? 'evil.near' : p.receiverId,
                      actions: [
                        {
                          FunctionCall: {
                            method_name: mismatch === 'method' ? 'other' : p.method,
                            args: Buffer.from(
                              JSON.stringify(mismatch === 'args' ? {} : p.args),
                            ).toString('base64'),
                            gas: mismatch === 'gas' ? '1' : p.gas,
                            deposit: mismatch === 'deposit' ? '0' : p.deposit,
                          },
                        },
                      ],
                    },
                    status: mismatch === 'failed' ? { Failure: 'rejected' } : { SuccessValue: '' },
                    receipts_outcome: [],
                  },
                });
              }),
            );
            const result = { txHash: 'FORGED' } as T;
            await verify(result);
            return result;
          },
        }),
        () => null,
      );
      await expect(
        h.sdk.buy({
          fileId: h.terms.file_id,
          header: h.header,
          recovery: wallet,
          refund: payer.identity,
          payer: payer as import('../wallet/wallet.js').NearWallet,
          maxPrice: 200000n,
        }),
      ).rejects.toThrow();
      const purchaseBackups = [...h.backups].filter(([id]) => !existingBackups.has(id));
      expect(purchaseBackups).toHaveLength(1);
      for (const [, backup] of purchaseBackups)
        expect((await importPurchase(backup, h.backupSecret)).nearSubmission).toBeUndefined();
    },
  );
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
    const expected = await sealWithKey(bytes(must(pending.fileKey), 32), body, {
      fileId: bytes(fileId, 32),
      name: pending.name,
      mime: pending.mime,
      authKind: 0,
      previewLen: pending.previewLen,
    });
    const expectedFile = await expected.finish({
      contractId: h.terms.contract,
      ckdSecret: bytes(must(pending.ckdSecret), 48),
      seller: wallet.identity,
      sign: async (text) => (await wallet.authorize(text)).sig,
    });
    const sold = await resumed.resumeSell({
      fileId,
      data: blobSource(new Blob([body])),
      seller: wallet,
      publish: async ({ file, header }) => {
        await h.publish({ file: new Uint8Array(await new Response(file).arrayBuffer()), header });
      },
    });
    expect(h.file).toEqual(expectedFile);
    expect(hex(expected.cipherHash)).toBe(sold.terms.cipher_hash);
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
  it('reopenSeller clears its one-time secret in current state and backup before returning', async () => {
    const h = harness();
    const store = encryptedSellerKeyStore(h.raw, h.backupSecret);
    const keyName = `annon/seller-key/${h.terms.file_id}`;
    h.send.mockImplementationOnce(async (method, args) => {
      expect(method).toBe('reopen_seller');
      const pending = must(await store.load(keyName));
      expect(pending.buyerSecret).toBeTruthy();
      expect(await importSellerKey(must(h.backups.get(pending.id)), h.backupSecret)).toEqual(
        pending,
      );
      const { key } = (args as { args: { key: string } }).args;
      const sig = hashPoint(pk, fileAppId(h.terms.contract, bytes(h.terms.file_id, 32))).multiply(
        msk,
      );
      return {
        big_y: `bls12381g1:${base58.encode(bls.G1.Point.BASE.multiply(77n).toBytes(true))}`,
        big_c: `bls12381g1:${base58.encode(sig.add(bls.G1.Point.fromBytes(bytes(key, 48)).multiply(77n)).toBytes(true))}`,
      };
    });
    expect(await h.sdk.reopenSeller({ fileId: h.terms.file_id, seller: wallet })).toHaveLength(48);
    const cleaned = must(await store.load(keyName));
    expect(cleaned).toMatchObject({ buyerSecret: null, revision: 1 });
    expect(await importSellerKey(must(h.backups.get(cleaned.id)), h.backupSecret)).toEqual(cleaned);
  });

  it('finishSell clears a retained seller-key secret independently of reopenSeller', async () => {
    const h = harness();
    const fileId = h.terms.file_id;
    const store = encryptedSellerKeyStore(h.raw, h.backupSecret);
    const keyName = `annon/seller-key/${fileId}`;
    const retained: SellerKeyRecord = {
      kind: 'seller-key',
      id: `seller-key:${fileId}`,
      file_id: fileId,
      seller: wallet.identity,
      revision: 0,
      buyerSecret: hex(new Uint8Array(32).fill(7)),
      deadline: now + 540,
    };
    expect(await store.compareAndSet(keyName, null, retained)).toBe(true);
    const reopen = vi.spyOn(h.sdk, 'reopenSeller');
    await h.sdk.sell({
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
      publish: async (file) => {
        expect((await store.load(keyName))?.buyerSecret).toBe(retained.buyerSecret);
        await h.publish(file);
      },
    });
    expect(reopen).not.toHaveBeenCalled();
    const cleaned = must(await store.load(keyName));
    expect(cleaned).toMatchObject({ buyerSecret: null, revision: 1 });
    expect(await importSellerKey(must(h.backups.get(cleaned.id)), h.backupSecret)).toEqual(cleaned);
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

  it('reopens a seller on a fresh device after published sell cleanup', async () => {
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
    expect(
      await importSell(must(h.backups.get(`sell:${h.terms.file_id}`)), h.backupSecret),
    ).toMatchObject({
      published: true,
      fileKey: null,
      sellerSecret: null,
      ckdSecret: null,
    });
    const freshStore = memoryStore<EncryptedRecord>();
    const sdk = new Annon({ ...h.config, rawStore: freshStore });
    expect(await freshStore.load(`annon/sell/${h.terms.file_id}`)).toBeNull();
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

it.each(['valid', 'absent', 'invalid'] as const)(
  'reuses only a verified unlock answer on first open: %s',
  async (mode) => {
    vi.spyOn(Date, 'now').mockReturnValue(now * 1000);
    const h = harness();
    const { mpcKey: _pin, ...unpinned } = h.config;
    const sdk = new Annon(unpinned);
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
      signTypedData: async (data: ReturnType<typeof typedData>) =>
        account.signTypedData(data as never),
    };
    const bought = await sdk.buy({
      fileId: h.terms.file_id,
      header: h.header,
      recovery: wallet,
      refund: wallet.identity,
      payer,
      maxPrice: 200000n,
      paymentRequired: required,
      url: 'https://files.example/f',
      submitBase: async () => {},
    });
    vi.spyOn(recoverySteps, 'nextStep').mockResolvedValue({
      step: 'unlock',
      args: { purchase: bought.record.message, logs: [], header: null },
    });
    const original = must(h.send.getMockImplementation());
    h.send.mockImplementation(async (method, args) => {
      if (method !== 'unlock') return original(method, args);
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
      const answer = h.answer(p.file_id, p.buyer_key);
      return mode === 'absent'
        ? null
        : mode === 'invalid'
          ? { ...answer, big_c: answer.big_y }
          : answer;
    });
    // The adapter accepts before downloading, then calls open on the same SDK instance.
    expect(await sdk.accept(bought.record)).toBe(true);
    expect((await sdk.open({ record: bought.record, file: h.file })).data).toEqual(body);
    expect(h.send.mock.calls.filter(([method]) => method === 'claim_key')).toHaveLength(
      mode === 'valid' ? 0 : 1,
    );
    expect((await sdk.open({ record: bought.record, file: h.file })).data).toEqual(body);
    expect(h.send.mock.calls.filter(([method]) => method === 'claim_key')).toHaveLength(
      mode === 'valid' ? 1 : 2,
    );
  },
);

for (const route of ['near', '1click'] as const)
  it(`refuses ${route} payment before recovery or payment when the file budget is low`, async () => {
    const h = harness();
    await h.sdk.sell({
      data: body,
      name: 'test',
      mime: 'text/plain',
      seller: wallet,
      near: {
        price: initial.near.price,
        recipients: initial.near.recipients,
        remainder: must(initial.near.recipients[0]).identity,
      },
      publish: h.publish,
    });
    h.storageBalance = 0n;
    const proveControl = vi.fn();
    const transferPurchase = vi.fn();
    const quote = vi.fn();
    const payer = {
      identity: { kind: 'near' as const, id: 'buyer.test' },
      authorize: vi.fn(),
      proveControl,
      call: vi.fn(),
      transferPurchase,
    };
    await expect(
      h.sdk.buy({
        fileId: h.terms.file_id,
        header: h.header,
        recovery: { identity: { kind: 'near', id: 'buyer.test' }, authorize: vi.fn() },
        refund: wallet.identity,
        maxPrice: 1000000n,
        ...(route === 'near'
          ? { payer }
          : {
              origin: { asset: 'nep141:origin', chain: 'near' as const, refundTo: 'buyer.test' },
              oneClick: { quote },
            }),
      }),
    ).rejects.toMatchObject({ code: 'file_storage_low' });
    expect(proveControl).not.toHaveBeenCalled();
    expect(transferPurchase).not.toHaveBeenCalled();
    expect(quote).not.toHaveBeenCalled();
  });

it('adds the advertised treasury fee before seller review and registration', async () => {
  const h = harness();
  const treasury = { kind: 'evm', id: `0x${'77'.repeat(20)}` } as const;
  const fee = { fixed: '30000', bps: 100, treasuryNear: treasury, treasuryEvm: treasury };
  const sdk = new Annon({ ...h.config, sponsorship: async () => ({ fee }) });
  const onSplit = vi.fn(async (split) => {
    expect(h.calls).toHaveLength(0);
    expect(
      split.recipients.find(
        (r: { identity: Identity; bps: number }) => r.identity.id === treasury.id,
      )?.bps,
    ).toBe(1600);
  });
  const result = await sdk.sell({
    data: body,
    name: 'test',
    mime: 'text/plain',
    seller: wallet,
    near: {
      price: initial.near.price,
      recipients: initial.near.recipients,
      remainder: must(initial.near.recipients[0]).identity,
    },
    onSplit,
    publish: h.publish,
  });
  expect(onSplit).toHaveBeenCalledTimes(1);
  expect(result.terms.near.recipients).toEqual(onSplit.mock.calls[0]?.[0].recipients);
  expect(result.terms.near.recipients.reduce((n, r) => n + r.bps, 0)).toBe(10000);
});

it('never automatically replenishes a spent file after an uncertain sell funding call', async () => {
  const identity = { kind: 'near', id: 'seller.test' } as const;
  const h = harness(identity);
  h.storageBalance = 0n;
  const call = vi.fn(async () => {
    throw new Error('funding response lost');
  });
  const seller = { identity, authorize: async () => undefined, call, transferPurchase: vi.fn() };
  await expect(
    h.sdk.sell({
      fileId: initial.file_id,
      data: body,
      name: 'test',
      mime: 'text/plain',
      seller,
      near: {
        price: initial.near.price,
        recipients: initial.near.recipients,
        remainder: must(initial.near.recipients[0]).identity,
      },
      storageBudget: 5n * 10n ** 22n,
      publish: h.publish,
    }),
  ).rejects.toThrow('funding response lost');
  expect(call).toHaveBeenCalledTimes(1);
  h.storageBalance = 0n;
  await expect(
    h.sdk.resumeSell({ fileId: initial.file_id, data: body, seller, publish: h.publish }),
  ).rejects.toBeDefined();
  expect(call).toHaveBeenCalledTimes(1);
  h.storageBalance = 5n * 10n ** 22n; // explicit operator resolution, without an automatic second allocation
  await expect(
    h.sdk.resumeSell({ fileId: initial.file_id, data: body, seller, publish: h.publish }),
  ).resolves.toMatchObject({ terms: { file_id: initial.file_id } });
  expect(call).toHaveBeenCalledTimes(1);
});

it('refuses above-ceiling sponsored SDK sales before any signature or transaction', async () => {
  const h = harness();
  const treasury = { kind: 'evm' as const, id: `0x${'77'.repeat(20)}` };
  const sdk = new Annon({
    ...h.config,
    sponsorship: async () => ({
      fee: { fixed: '30001', bps: 100, treasuryNear: treasury, treasuryEvm: treasury },
    }),
  });
  await expect(
    sdk.sell({
      data: body,
      name: 'test',
      mime: 'text/plain',
      seller: wallet,
      near: {
        price: '100000',
        recipients: initial.near.recipients,
        remainder: must(initial.near.recipients[0]).identity,
      },
      publish: h.publish,
    }),
  ).rejects.toMatchObject({ code: 'protocol_fee_above_max' });
  expect(h.calls).toHaveLength(0);
});

it('supplies Base split provenance with a sponsored registration', async () => {
  const h = harness();
  const sold = await h.sdk.sell({
    data: body,
    name: 'test',
    mime: 'text/plain',
    seller: wallet,
    near: {
      price: initial.near.price,
      recipients: initial.near.recipients,
      remainder: must(initial.near.recipients[0]).identity,
    },
    base: { price: initial.near.price, sendTransaction: vi.fn() },
    publish: h.publish,
  });
  expect(h.calls.find((c) => c.method === 'register')?.args).toMatchObject({
    baseSplit: { kind: sold.baseSplit?.kind, salt: sold.baseSplit?.salt },
  });
});

it('allows resuming after a definite funding failure without an uncertainty hold', async () => {
  const identity = { kind: 'near', id: 'seller.test' } as const;
  const h = harness(identity);
  const { FileFundingRefused } = await import('../wallet/wallet.js');
  const call = vi.fn().mockRejectedValueOnce(new FileFundingRefused()).mockResolvedValue(null);
  const seller = { identity, authorize: async () => undefined, call, transferPurchase: vi.fn() };
  await expect(
    h.sdk.sell({
      fileId: initial.file_id,
      data: body,
      name: 'test',
      mime: 'text/plain',
      seller,
      near: {
        price: initial.near.price,
        recipients: initial.near.recipients,
        remainder: must(initial.near.recipients[0]).identity,
      },
      storageBudget: 5n * 10n ** 22n,
      publish: h.publish,
    }),
  ).rejects.toMatchObject({ code: 'funding_refused' });
  h.storageBalance = 0n;
  await expect(
    h.sdk.resumeSell({ fileId: initial.file_id, data: body, seller, publish: h.publish }),
  ).resolves.toBeDefined();
  expect(call).toHaveBeenCalledTimes(2);
});

it.each(['none', 'header', 'locked header', 'cancel', 'swallow failure'] as const)(
  'keeps streamed sell and resume recoverable when publish consumes %s',
  async (mode) => {
    const h = harness();
    let reads = 0;
    let cancelled = 0;
    const data = {
      size: body.length,
      read() {
        const pass = ++reads;
        return new ReadableStream<Uint8Array>(
          {
            start(c) {
              c.enqueue(
                mode === 'swallow failure' && pass % 2 === 0 ? body.map((b) => b ^ 1) : body,
              );
            },
            pull(c) {
              c.close();
            },
            cancel() {
              cancelled++;
            },
          },
          { highWaterMark: 0 },
        );
      },
    };
    const publish = async ({ file }: { file: ReadableStream<Uint8Array> }) => {
      if (mode === 'none') return;
      const reader = file.getReader();
      if (mode === 'header' || mode === 'locked header') await reader.read();
      if (mode === 'locked header') return;
      if (mode === 'cancel') await reader.cancel();
      if (mode === 'swallow failure') {
        try {
          while (!(await reader.read()).done) {}
        } catch {
          /* A host swallowed the source error. */
        }
      }
      reader.releaseLock();
    };
    const fileId = initial.file_id;
    const check = async () => {
      const saved = await encryptedSellStore(h.raw, h.backupSecret).load(`annon/sell/${fileId}`);
      expect(saved?.published).toBeFalsy();
      for (const key of ['fileKey', 'sellerSecret', 'ckdSecret'] as const)
        expect(typeof saved?.[key]).toBe('string');
    };
    await expect(
      h.sdk.sell({
        fileId,
        data,
        name: 'f',
        mime: '',
        seller: wallet,
        near: {
          price: '200000',
          recipients: [{ identity: wallet.identity, bps: 10000 }],
          remainder: wallet.identity,
        },
        publish,
      }),
    ).rejects.toThrow();
    await check();
    await expect(h.sdk.resumeSell({ fileId, data, seller: wallet, publish })).rejects.toThrow();
    await check();
    if (mode !== 'swallow failure') expect(cancelled).toBeGreaterThan(0);
    await h.sdk.resumeSell({
      fileId,
      data: blobSource(new Blob([body])),
      seller: wallet,
      publish: async ({ file, header }) =>
        h.publish({ file: new Uint8Array(await new Response(file).arrayBuffer()), header }),
    });
    expect(
      await encryptedSellStore(h.raw, h.backupSecret).load(`annon/sell/${fileId}`),
    ).toMatchObject({ published: true, fileKey: null, sellerSecret: null, ckdSecret: null });
  },
);

it.each(['near-usdc', 'base-usdc', 'oneclick'] as const)(
  'honors explicit %s selection without fallback',
  async (route) => {
    const h = harness();
    await h.sdk.sell({
      data: body,
      name: 'route-test',
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
    const quote = vi.fn(async () => ({
      request: {},
      response: {},
      deposit: { address: 'synthetic-deposit' },
    }));
    const transferPurchase = vi.fn();
    const payer =
      route === 'near-usdc'
        ? {
            identity: { kind: 'near', id: 'synthetic-buyer.test' },
            authorize: vi.fn(),
            call: vi.fn(),
            transferPurchase,
          }
        : { ...wallet, signTypedData: vi.fn() };
    const operation = h.sdk.buy({
      route,
      fileId: h.terms.file_id,
      header: h.header,
      payer: payer as never,
      recovery: wallet,
      refund: wallet.identity,
      maxPrice: 200000n,
      origin: { asset: 'nep141:synthetic', chain: 'evm', refundTo: wallet.identity.id },
      oneClick: { quote } as never,
    });
    if (route === 'base-usdc') await expect(operation).rejects.toThrow(/Base requires/);
    else {
      await expect(operation).resolves.toMatchObject({ route: 'near-usdc' });
      const result = await operation;
      expect(result.route).toBe('near-usdc');
      expect(quote).toHaveBeenCalledTimes(route === 'oneclick' ? 1 : 0);
      expect(transferPurchase).toHaveBeenCalledTimes(route === 'near-usdc' ? 1 : 0);
    }
  },
);
it('rejects explicit direct NEAR without a NEAR wallet instead of using 1Click', async () => {
  const h = harness();
  await h.sdk.sell({
    data: body,
    name: 'route-test',
    mime: '',
    seller: wallet,
    near: {
      price: '200000',
      recipients: [{ identity: wallet.identity, bps: 10000 }],
      remainder: wallet.identity,
    },
    publish: h.publish,
  });
  const quote = vi.fn();
  await expect(
    h.sdk.buy({
      route: 'near-usdc',
      fileId: h.terms.file_id,
      header: h.header,
      recovery: wallet,
      refund: wallet.identity,
      maxPrice: 200000n,
      origin: { asset: 'nep141:synthetic', chain: 'evm', refundTo: wallet.identity.id },
      oneClick: { quote },
    }),
  ).rejects.toThrow(/NEAR.*wallet/);
  expect(quote).not.toHaveBeenCalled();
});

it.each(['record', 'before-payment', 'proof-record'] as const)(
  'blocks direct payment when %s persistence fails',
  async (failure) => {
    const h = harness();
    await h.sdk.sell({
      data: body,
      name: 'guard-test',
      mime: '',
      seller: wallet,
      near: {
        price: '200000',
        recipients: [{ identity: wallet.identity, bps: 10000 }],
        remainder: wallet.identity,
      },
      publish: h.publish,
    });
    const transferPurchase = vi.fn();
    const payer = {
      identity: { kind: 'near', id: 'synthetic-buyer.test' } as const,
      authorize: vi.fn(),
      call: vi.fn(),
      transferPurchase,
    };
    await expect(
      h.sdk.buy({
        route: 'near-usdc',
        fileId: h.terms.file_id,
        header: h.header,
        payer,
        recovery: wallet,
        refund: wallet.identity,
        maxPrice: 200000n,
        onSaved: async (record) => {
          if (failure === 'record' || (failure === 'proof-record' && record.recoveryProved))
            throw new Error('quota');
        },
        beforePayment: async () => {
          if (failure === 'before-payment') throw new Error('quota');
        },
      }),
    ).rejects.toThrow('quota');
    expect(transferPurchase).not.toHaveBeenCalled();
  },
);
it('saves recovery proof before releasing 1Click instructions and can reprove a saved purchase', async () => {
  const h = harness();
  await h.sdk.sell({
    data: body,
    name: 'guard-test',
    mime: '',
    seller: wallet,
    near: {
      price: '200000',
      recipients: [{ identity: wallet.identity, bps: 10000 }],
      remainder: wallet.identity,
    },
    publish: h.publish,
  });
  const saved: import('../pay/purchase.js').PurchaseRecord[] = [];
  const result = await h.sdk.buy({
    route: 'oneclick',
    fileId: h.terms.file_id,
    header: h.header,
    recovery: wallet,
    refund: wallet.identity,
    maxPrice: 200000n,
    origin: { asset: 'nep141:synthetic', chain: 'evm', refundTo: wallet.identity.id },
    oneClick: {
      quote: async () => ({
        request: {},
        response: {},
        deposit: {
          address: 'synthetic',
          depositBefore: new Date((now + 3000) * 1000).toISOString(),
        },
      }),
    } as never,
    onQuote: async () => {},
    onSaved: async (r) => {
      saved.push(r);
    },
    beforePayment: async (r) => {
      expect(r.recoveryProved).toBe(true);
      expect(saved.at(-1)).toEqual(r);
    },
  });
  expect(result.record.recoveryProved).toBe(true);
  const unproved = {
    ...result.record,
    revision: result.record.revision + 1,
    recoveryProved: false,
  };
  await h.sdk.store.compareAndSet(purchaseKey(unproved.id), result.record, unproved);
  const restored = await h.sdk.proveRecovery(unproved, wallet);
  expect(restored.recoveryProved).toBe(true);
  expect(restored.id).toBe(result.record.id);
  const otherContract = new Annon({ ...h.config, contractId: 'different.test' });
  await expect(otherContract.proveRecovery(restored, wallet)).rejects.toThrow(/scope/);
});

it.each(['near-usdc', 'base-usdc', 'oneclick'] as const)(
  'runs the browser controller through %s, acceptance and file readiness with contract stubs',
  async (route) => {
    vi.spyOn(Date, 'now').mockReturnValue(now * 1000);
    const { IDBFactory } = await import('fake-indexeddb');
    const { browserAnnon, browserPurchaseStorage, BrowserPurchaseController } = await import(
      '../browser/purchases.js'
    );
    const h = harness();
    await h.sdk.sell({
      data: body,
      name: 'browser-fixture',
      mime: 'text/plain',
      seller: wallet,
      near: {
        price: '200000',
        recipients: [{ identity: wallet.identity, bps: 10000 }],
        remainder: wallet.identity,
      },
      base: { price: '200000', sendTransaction: async () => {} },
      publish: h.publish,
    });
    const options = { factory: new IDBFactory(), name: 'synthetic-integration' };
    const storage = await browserPurchaseStorage(options);
    const sdk = browserAnnon(storage, h.config);
    const controller = await BrowserPurchaseController.create(
      { storage, sdk, now: () => now },
      {
        id: 'synthetic-checkout',
        fileId: h.terms.file_id,
        header: h.header,
        resourceUrl: 'https://files.example/f',
        route,
        maxPrice: 200000n,
      },
    );
    const transferPurchase = vi.fn();
    const submitBase = vi.fn(async () => {});
    const payer =
      route === 'near-usdc'
        ? {
            identity: { kind: 'near', id: 'synthetic-buyer.test' },
            authorize: vi.fn(),
            call: vi.fn(),
            transferPurchase,
          }
        : {
            ...wallet,
            signTypedData: (data: ReturnType<typeof typedData>) =>
              account.signTypedData(data as never),
          };
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
    await controller.start({
      recovery: wallet,
      refund: wallet.identity,
      payer: payer as never,
      paymentRequired: required,
      submitBase,
      origin: { asset: 'nep141:synthetic', chain: 'evm', refundTo: wallet.identity.id },
      oneClick: {
        quote: async (message: string) => ({
          request: { customRecipientMsg: message },
          response: {},
          deposit: {
            address: 'synthetic-deposit',
            memo: 'synthetic-memo',
            amount: '250000',
            asset: 'nep141:synthetic',
            chain: 'evm',
            qrData: '{}',
            depositBefore: new Date((now + 3000) * 1000).toISOString(),
            purchaseExpiresAt: new Date((now + 3600) * 1000).toISOString(),
          },
        }),
      } as never,
    });
    const stored = must((await storage.load('synthetic-checkout'))?.purchase);
    expect(stored.recoveryProved).toBe(true);
    expect(await sdk.store.load(purchaseKey(stored.id))).toEqual(stored);
    const restoredStorage = await browserPurchaseStorage(options);
    const restoredSdk = browserAnnon(restoredStorage, h.config);
    const restored = new BrowserPurchaseController({
      storage: restoredStorage,
      sdk: restoredSdk,
      id: 'synthetic-checkout',
      now: () => now,
    });
    expect((await restored.snapshot()).state).toBe(
      route === 'oneclick' ? 'awaiting_deposit' : 'payment_uncertain',
    );
    await expect(restored.start({ recovery: wallet, refund: wallet.identity })).rejects.toThrow(
      /resume/,
    );
    h.purchases.set(stored.id, {
      purchase_id: stored.id,
      file_id: stored.purchase.file_id,
      terms_hash: stored.purchase.terms_hash,
      recovery: stored.recovery,
      buyer_key: stored.purchase.buyer_key,
      grants: 1,
    });
    h.grants.set(`${stored.id}:0`, stored.purchase.buyer_key);
    await restored.resume();
    expect((await restored.snapshot()).state).toBe('accepted');
    expect((await restored.open(h.file)).data).toEqual(body);
    expect((await restored.snapshot()).state).toBe('file_ready');
    expect(transferPurchase).toHaveBeenCalledTimes(route === 'near-usdc' ? 1 : 0);
    expect(submitBase).toHaveBeenCalledTimes(route === 'base-usdc' ? 1 : 0);
  },
);

it.each(['insufficient balance', 'smart wallet'] as const)(
  'explicit Base refuses %s without switching to 1Click',
  async (reason) => {
    vi.spyOn(Date, 'now').mockReturnValue(now * 1000);
    const h = harness();
    await h.sdk.sell({
      data: body,
      name: 'route-test',
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
    if (reason === 'smart wallet') h.baseCode = '0x1234';
    else h.baseBalance = 0n;
    const quote = vi.fn();
    const signTypedData = vi.fn();
    await expect(
      h.sdk.buy({
        route: 'base-usdc',
        fileId: h.terms.file_id,
        header: h.header,
        recovery: wallet,
        refund: wallet.identity,
        payer: { ...wallet, signTypedData } as never,
        maxPrice: 200000n,
        paymentRequired: required,
        url: 'https://files.example/f',
        oneClick: { quote },
        origin: { asset: 'nep141:synthetic', chain: 'evm', refundTo: wallet.identity.id },
      }),
    ).rejects.toMatchObject({
      code: reason === 'smart wallet' ? 'smart_wallet_unsupported' : 'insufficient_balance',
    });
    expect(quote).not.toHaveBeenCalled();
    expect(signTypedData).not.toHaveBeenCalled();
  },
);

async function round2Listing() {
  const h = harness();
  await h.sdk.sell({
    data: body,
    name: 'round-two',
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
  return h;
}
it.each([
  { chain: 'evm', refundTo: 'bad' },
  { chain: 'solana', refundTo: 'bad' },
  { chain: 'near', refundTo: 'Bad Account' },
  { chain: 'other', refundTo: 'bad refund' },
  { chain: 'evm', refundTo: wallet.identity.id, depositMode: 'invalid' },
  { chain: 'evm', refundTo: wallet.identity.id, blockchain: 'btc' },
] as const)('rejects an invalid origin before proof or purchase writes: %j', async (invalid) => {
  const h = await round2Listing();
  const beforeSave = vi.fn();
  const authorize = vi.fn(wallet.authorize);
  const quote = vi.fn();
  await expect(
    h.sdk.buy({
      route: 'oneclick',
      fileId: h.terms.file_id,
      header: h.header,
      recovery: { ...wallet, authorize },
      refund: wallet.identity,
      maxPrice: 200000n,
      origin: { asset: 'nep141:synthetic', ...invalid } as never,
      oneClick: { quote },
      beforeSave,
    }),
  ).rejects.toThrow();
  expect(beforeSave).not.toHaveBeenCalled();
  expect(authorize).not.toHaveBeenCalled();
  expect(quote).not.toHaveBeenCalled();
  expect([...h.backups.keys()].filter((k) => !k.startsWith('sell:'))).toHaveLength(0);
});
it('keeps a bad refund retryable in the real browser controller without a saved purchase', async () => {
  const h = await round2Listing();
  const { IDBFactory } = await import('fake-indexeddb');
  const { browserAnnon, browserPurchaseStorage, BrowserPurchaseController } = await import(
    '../browser/purchases.js'
  );
  const storage = await browserPurchaseStorage({
    factory: new IDBFactory(),
    name: 'synthetic-validation',
  });
  const sdk = browserAnnon(storage, h.config);
  const controller = await BrowserPurchaseController.create(
    { storage, sdk, now: () => now },
    {
      id: 'synthetic-checkout',
      fileId: h.terms.file_id,
      header: h.header,
      resourceUrl: 'https://files.example/f',
      route: 'oneclick',
      maxPrice: 200000n,
    },
  );
  const authorize = vi.fn(wallet.authorize);
  const quote = vi.fn();
  await expect(
    controller.start({
      recovery: { ...wallet, authorize },
      refund: wallet.identity,
      origin: { asset: 'nep141:synthetic', chain: 'evm', refundTo: 'bad' },
      oneClick: { quote },
    }),
  ).rejects.toThrow();
  expect((await controller.snapshot()).state).toBe('terms_review');
  expect((await storage.load('synthetic-checkout'))?.purchase).toBeUndefined();
  expect(authorize).not.toHaveBeenCalled();
  expect(quote).not.toHaveBeenCalled();
});
it('M7 honors explicit oneclick with a NEAR payer without a direct transfer', async () => {
  const h = await round2Listing();
  const transferPurchase = vi.fn();
  const quote = vi.fn(async () => ({
    request: {},
    response: {},
    deposit: { address: 'synthetic', depositBefore: new Date((now + 3000) * 1000).toISOString() },
  }));
  const result = await h.sdk.buy({
    route: 'oneclick',
    fileId: h.terms.file_id,
    header: h.header,
    recovery: wallet,
    refund: wallet.identity,
    maxPrice: 200000n,
    payer: {
      identity: { kind: 'near', id: 'synthetic-buyer.test' },
      authorize: vi.fn(),
      call: vi.fn(),
      transferPurchase,
    } as never,
    origin: { asset: 'nep141:synthetic', chain: 'evm', refundTo: wallet.identity.id },
    oneClick: { quote } as never,
  });
  expect(quote).toHaveBeenCalledTimes(1);
  expect(transferPurchase).not.toHaveBeenCalled();
  expect(result.instructions).toBeDefined();
});
it('M10 awaits the Base checkpoint before submitBase and blocks submission when it fails', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(now * 1000);
  const h = await round2Listing();
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
  const beforePayment = vi.fn(async () => {
    throw new Error('checkpoint quota');
  });
  const submitBase = vi.fn();
  await expect(
    h.sdk.buy({
      route: 'base-usdc',
      fileId: h.terms.file_id,
      header: h.header,
      recovery: wallet,
      refund: wallet.identity,
      maxPrice: 200000n,
      payer: {
        ...wallet,
        signTypedData: (data: ReturnType<typeof typedData>) => account.signTypedData(data as never),
      } as never,
      url: 'https://files.example/f',
      paymentRequired: required,
      beforePayment,
      submitBase,
    }),
  ).rejects.toThrow('checkpoint quota');
  expect(beforePayment).toHaveBeenCalledTimes(1);
  expect(submitBase).not.toHaveBeenCalled();
});
it('M11 refuses reproof from a different recovery identity before authorization', async () => {
  const h = await round2Listing();
  const result = await h.sdk.buy({
    route: 'oneclick',
    fileId: h.terms.file_id,
    header: h.header,
    recovery: wallet,
    refund: wallet.identity,
    maxPrice: 200000n,
    origin: { asset: 'nep141:synthetic', chain: 'evm', refundTo: wallet.identity.id },
    oneClick: {
      quote: async () => ({ request: {}, response: {}, deposit: { address: 'synthetic' } }),
    } as never,
  });
  const authorize = vi.fn();
  await expect(
    h.sdk.proveRecovery(result.record, {
      identity: { kind: 'near', id: 'different.test' },
      authorize,
    }),
  ).rejects.toThrow(/identity mismatch/);
  expect(authorize).not.toHaveBeenCalled();
});

it('keeps automatic Base selection working when an unused fallback origin is invalid', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(now * 1000);
  const h = await round2Listing();
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
  await expect(
    h.sdk.buy({
      fileId: h.terms.file_id,
      header: h.header,
      recovery: wallet,
      refund: wallet.identity,
      maxPrice: 200000n,
      payer: {
        ...wallet,
        signTypedData: (data: ReturnType<typeof typedData>) => account.signTypedData(data as never),
      } as never,
      url: 'https://files.example/f',
      paymentRequired: required,
      origin: { asset: 'nep141:synthetic', chain: 'solana', refundTo: 'bad' },
    }),
  ).resolves.toMatchObject({ route: 'base-usdc' });
});

it('retains r0 through rotation to r1 and opens a late final grant for r0', async () => {
  const h = await round2Listing();
  const { IDBFactory } = await import('fake-indexeddb');
  const { browserAnnon, browserPurchaseStorage } = await import('../browser/purchases.js');
  const { encryptedRecoveryStore } = await import('../pay/backup.js');
  const { keyFromSecret } = await import('../keys/near-ckd.js');
  const storage = await browserPurchaseStorage({
    factory: new IDBFactory(),
    name: 'synthetic-rotation',
  });
  const sdk = browserAnnon(storage, {
    ...h.config,
    send: async (method, args) => {
      if (method === 'reopen') throw new Error('synthetic offline');
      return h.send(method, args);
    },
  });
  const id = `0x${'93'.repeat(32)}`;
  const key = keyFromSecret(new Uint8Array(32).fill(3));
  h.purchases.set(id, {
    purchase_id: id,
    file_id: h.terms.file_id,
    terms_hash: termsHash(h.terms),
    recovery: wallet.identity,
    buyer_key: hex(bls.G1.Point.BASE.toBytes(true)),
    grants: 1,
  });
  const r0 = {
    kind: 'recovery' as const,
    id: `recovery:${id}`,
    revision: 0,
    purchase_id: id,
    file_id: h.terms.file_id,
    recovery: wallet.identity,
    buyerSecret: hex(key.secret),
    fresh_key: hex(key.publicKeyBytes),
    nonce: `0x${'35'.repeat(32)}`,
    deadline: now - 1,
    grant: null,
  };
  const recoveryStore = encryptedRecoveryStore(storage.rawStore, storage.backupSecret);
  await recoveryStore.compareAndSet(`annon/recovery/${id}`, null, r0);
  await expect(sdk.recover({ wallet, purchaseId: id })).rejects.toThrow('synthetic offline');
  const r1 = must(await recoveryStore.load(`annon/recovery/${id}`));
  expect(r1.buyerSecret).not.toBe(r0.buyerSecret);
  const archive = must(await storage.rawStore.load(`annon/browser/backup/${r0.id}:revision:0`));
  const restored = await importRecovery(archive.backup, storage.backupSecret);
  expect(restored.buyerSecret).toBe(r0.buyerSecret);
  const accepted = must(h.purchases.get(id));
  accepted.grants = 2;
  h.grants.set(`${id}:1`, r0.fresh_key);
  expect((await sdk.open({ file: h.file, recovery: { ...restored, grant: 1 } })).data).toEqual(
    body,
  );
});
it('marks signed Base payloads uncertain before dryRun and accepts a payment that lands after its error', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(now * 1000);
  const h = await round2Listing();
  const { IDBFactory } = await import('fake-indexeddb');
  const { browserAnnon, browserPurchaseStorage, BrowserPurchaseController } = await import(
    '../browser/purchases.js'
  );
  const storageOptions = { factory: new IDBFactory(), name: 'synthetic-dry-run' };
  const storage = await browserPurchaseStorage(storageOptions);
  const sdk = browserAnnon(storage, h.config);
  const controller = await BrowserPurchaseController.create(
    { storage, sdk, now: () => now },
    {
      id: 'synthetic-checkout',
      fileId: h.terms.file_id,
      header: h.header,
      resourceUrl: 'https://files.example/f',
      route: 'base-usdc',
      maxPrice: 200000n,
    },
  );
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
  const transport = globalThis.fetch;
  const observed: string[] = [];
  const submitBase = vi.fn();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url, init) => {
      const request = JSON.parse(String(init?.body));
      if (request.method === 'eth_call' && request.params[0]?.from) {
        const saved = must(await storage.load('synthetic-checkout'));
        expect(saved.purchase?.attempts[0]?.payload).toBeTruthy();
        observed.push(saved.submission ?? 'missing');
        throw new Error('synthetic dry-run response lost');
      }
      return transport(url, init);
    }),
  );
  await expect(
    controller.start({
      recovery: wallet,
      refund: wallet.identity,
      payer: {
        ...wallet,
        signTypedData: (data: ReturnType<typeof typedData>) => account.signTypedData(data as never),
      } as never,
      paymentRequired: required,
      submitBase,
    }),
  ).rejects.toThrow();
  expect(observed).toEqual(['uncertain']);
  expect(submitBase).not.toHaveBeenCalled();
  const saved = must((await storage.load('synthetic-checkout'))?.purchase);
  expect(saved.attempts[0]?.payload).toBeTruthy();
  h.purchases.set(saved.id, {
    purchase_id: saved.id,
    file_id: saved.purchase.file_id,
    terms_hash: saved.purchase.terms_hash,
    recovery: saved.recovery,
    buyer_key: saved.purchase.buyer_key,
    grants: 1,
  });
  const freshStorage = await browserPurchaseStorage(storageOptions);
  const freshSdk = browserAnnon(freshStorage, h.config);
  const accept = vi.spyOn(freshSdk, 'accept');
  const reload = new BrowserPurchaseController({
    storage: freshStorage,
    sdk: freshSdk,
    id: 'synthetic-checkout',
    now: () => now,
  });
  await reload.resume();
  expect(accept).toHaveBeenCalledTimes(1);
  expect((await reload.snapshot()).state).toBe('accepted');
});

it.each(['evm', 'solana', 'near'] as const)(
  'browser %s connector recovers on a fresh device, reopens, and decrypts without another payment',
  async (kind) => {
    const { browserEvmWallet, browserSolanaWallet, browserNearWallet } = await import(
      '../browser/wallets.js'
    );
    const { ed25519 } = await import('@noble/curves/ed25519.js');
    const { base64 } = await import('@scure/base');
    const { nep413Hash } = await import('../near/nep413.js');
    const rpc = await import('../near/rpc.js');
    const { verifyAuthorization } = await import('../settle-near/identity.js');
    const { reopenText } = await import('../near/texts.js');
    const h = harness();
    await h.sdk.sell({
      data: body,
      name: 'synthetic.txt',
      mime: 'text/plain',
      seller: wallet,
      near: {
        price: '200000',
        recipients: [{ identity: wallet.identity, bps: 10000 }],
        remainder: wallet.identity,
      },
      publish: h.publish,
    });
    const secret = new Uint8Array(32).fill(9);
    const publicKey = ed25519.getPublicKey(secret);
    const signMessage = vi.fn(async (message: Uint8Array) => ({
      signature: ed25519.sign(message, secret),
    }));
    let reply: unknown;
    const transaction = vi.fn(
      async (tx: import('../browser/wallets.js').BrowserNearTransaction) => {
        const action = must(tx.actions[0]).functionCall;
        const args = JSON.parse(new TextDecoder().decode(action.args));
        reply = await h.send(action.methodName, args);
        return { transaction: { signer_id: 'buyer.synthetic.near', hash: 'synthetic-reopen' } };
      },
    );
    const nep413 = vi.fn(async (payload: import('../near/nep413.js').NearMessage) => ({
      accountId: 'buyer.synthetic.near',
      publicKey: `ed25519:${base58.encode(publicKey)}`,
      signature: base64.encode(ed25519.sign(nep413Hash(payload), secret)),
    }));
    const recovery =
      kind === 'evm'
        ? browserEvmWallet(
            {
              request: async (q) => {
                if (q.method === 'eth_chainId') return '0x2105';
                if (q.method === 'eth_accounts') return [account.address];
                if (q.method === 'personal_sign')
                  return account.signMessage({
                    message: { raw: must((q.params as `0x${string}`[])[0]) },
                  });
                throw new Error('unexpected provider call');
              },
            },
            account.address,
          )
        : kind === 'solana'
          ? browserSolanaWallet(
              { publicKey: { toBytes: () => publicKey }, signMessage },
              base58.encode(publicKey),
            )
          : browserNearWallet(
              {
                getAccounts: async () => [{ accountId: 'buyer.synthetic.near' }],
                signMessage: nep413,
                signAndSendTransaction: transaction,
              },
              'buyer.synthetic.near',
            );
    if (kind === 'near') {
      vi.spyOn(rpc, 'isFullAccessKey').mockResolvedValue(true);
      await must((recovery as import('../wallet/wallet.js').NearWallet).proveControl)(
        'synthetic ownership proof',
        { contractId: h.terms.contract, nearRpc: h.config.nearRpc },
      );
      expect(nep413).toHaveBeenCalledTimes(1);
    }
    const id = `0x${'78'.repeat(32)}`;
    h.purchases.set(id, {
      purchase_id: id,
      file_id: h.terms.file_id,
      terms_hash: termsHash(h.terms),
      recovery: recovery.identity,
      buyer_key: hex(bls.G1.Point.BASE.toBytes(true)),
      grants: 1,
    });
    h.grants.set(`${id}:0`, hex(bls.G1.Point.BASE.toBytes(true)));
    const send = vi.fn(
      async (method: string, args: object, near?: import('../wallet/wallet.js').NearWallet) => {
        if (method === 'reopen') {
          const request = args as {
            args: { purchase_id: string; fresh_key: string; nonce: string; deadline: number };
            auth?: import('../settle-near/identity.js').Authorization;
          };
          if (kind !== 'near')
            expect(
              verifyAuthorization(
                recovery.identity,
                reopenText({
                  ...request.args,
                  contract: h.terms.contract,
                  file_id: h.terms.file_id,
                  recovery: recovery.identity,
                }),
                request.auth,
              ),
            ).toBe(true);
          else {
            await must(near).call({ receiverId: h.terms.contract, method, args });
            return reply;
          }
        }
        return h.send(method, args);
      },
    );
    const fresh = new Annon({
      ...h.config,
      rawStore: memoryStore<EncryptedRecord>(),
      backupSecret: newBackupSecret(),
      send,
    });
    const recovered = must((await fresh.recover({ wallet: recovery, purchaseId: id }))[0]);
    expect(recovered.grant).toBe(1);
    expect((await fresh.open({ recovery: recovered, file: h.file })).data).toEqual(body);
    await fresh.recover({ wallet: recovery, purchaseId: id });
    expect(send.mock.calls.filter(([method]) => method === 'reopen')).toHaveLength(1);
    expect(
      send.mock.calls.some(([method]) => method === 'unlock' || method === 'ft_transfer_call'),
    ).toBe(false);
    if (kind === 'near') expect(transaction).toHaveBeenCalledTimes(1);
    if (kind === 'solana') expect(signMessage).toHaveBeenCalledTimes(1);
  },
);

it('browser controller downloads a granted file and verifies final terms and CKD release before returning plaintext', async () => {
  const { IDBFactory } = await import('fake-indexeddb');
  const { BrowserPurchaseController, browserPurchaseStorage, browserAnnon } = await import(
    '../browser/purchases.js'
  );
  const { readPurchaseProof, verifyBuyerProof } = await import('../download/proof.js');
  const h = harness();
  await h.sdk.sell({
    data: body,
    name: 'synthetic.txt',
    mime: 'text/plain',
    seller: wallet,
    near: {
      price: '200000',
      recipients: [{ identity: wallet.identity, bps: 10000 }],
      remainder: wallet.identity,
    },
    publish: h.publish,
  });
  const storage = await browserPurchaseStorage({
    factory: new IDBFactory(),
    name: 'synthetic-download',
  });
  const sdk = browserAnnon(storage, h.config);
  const payer = {
    identity: { kind: 'near' as const, id: 'buyer.synthetic.near' },
    authorize: async () => undefined,
    call: vi.fn(),
    transferPurchase: vi.fn(async (message: string) => {
      const p = parsePurchaseMessage(message);
      const id = purchaseId(p);
      h.purchases.set(id, {
        purchase_id: id,
        file_id: p.file_id,
        terms_hash: p.terms_hash,
        recovery: p.recovery,
        buyer_key: p.buyer_key,
        grants: 1,
      });
      h.grants.set(`${id}:0`, p.buyer_key);
    }),
  };
  const controller = await BrowserPurchaseController.create(
    { storage, sdk, now: () => now },
    {
      id: 'synthetic-granted-file',
      fileId: h.terms.file_id,
      header: h.header,
      resourceUrl: 'https://files.example/synthetic',
      route: 'near-usdc',
      maxPrice: 200000n,
    },
  );
  await controller.start({ recovery: wallet, payer, refund: payer.identity });
  await controller.resume();
  expect((await controller.snapshot()).state).toBe('accepted');
  const record = must((await storage.load('synthetic-granted-file'))?.purchase);
  const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
    expect(url).toBe('https://files.example/synthetic');
    const proof = must(readPurchaseProof(new Headers(init?.headers).get('annon-buyer-proof')));
    expect(
      verifyBuyerProof(
        proof.grant === 0
          ? record.purchase.buyer_key
          : must(h.grants.get(`${record.id}:${proof.grant}`)),
        String(url),
        proof.signature,
      ),
    ).toBe(true);
    expect(proof.purchase_id).toBe(record.id);
    return new Response(new Uint8Array(h.file));
  });
  const result = await controller.open({ fetch });
  expect(result).toMatchObject({ data: body, meta: { name: 'synthetic.txt', mime: 'text/plain' } });
  expect((await controller.snapshot()).state).toBe('file_ready');
  expect(h.calls.filter((c) => c.method === 'claim_key')).toHaveLength(1);
  expect(payer.transferPurchase).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(await storage.load('synthetic-granted-file'))).not.toContain('"data"');
  // Final chain terms remain authoritative even after a successful download.
  const old = h.grants.get(`${record.id}:0`);
  h.grants.set(`${record.id}:0`, hex(bls.G1.Point.BASE.toBytes(true)));
  await expect(controller.open({ fetch })).rejects.toThrow(/final grant/);
  h.grants.set(`${record.id}:0`, must(old));
  expect((await controller.open({ fetch })).data).toEqual(body);
  await controller.recover(wallet);
  expect((await storage.load('synthetic-granted-file'))?.recovery?.grant).toBe(1);
  expect((await controller.open({ fetch })).data).toEqual(body);
  expect(payer.transferPurchase).toHaveBeenCalledTimes(1);
});
