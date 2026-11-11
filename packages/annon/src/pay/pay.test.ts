import { readFileSync } from 'node:fs';
import { hashTypedData } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { must, purchase as sample, terms as sampleTerms } from '../../test/fixtures.js';
import { serveFile } from '../download/host.js';
import { purchaseProof } from '../download/proof.js';
import { seal, sha256 } from '../envelope/pay2.js';
import { keyFromSecret } from '../keys/near-ckd.js';
import { getFile, getGrant, getPurchase, purchasesOf } from '../near/rpc.js';
import {
  baseNonceV2,
  buildPurchaseMessage,
  type Purchase,
  purchaseId,
} from '../settle-near/purchase.js';
import { termsHash } from '../settle-near/terms.js';
import { blockHeader } from './base.js';
import { digest, signer, toHex, typedData } from './eip3009.js';
import { authorize, preflight } from './pay.js';
import { purchaseKey } from './purchase.js';
import {
  checkPayment,
  checkTerms,
  forFacilitator,
  paymentRequired,
  verifyPayment,
} from './seller.js';
import { memoryStore } from './store.js';
import { discover, paymentSignature } from './x402.js';

const payer = privateKeyToAccount(`0x${'42'.repeat(32)}`);
const seller = privateKeyToAccount(`0x${'44'.repeat(32)}`);
const terms = {
  ...sampleTerms,
  seller: { kind: 'evm', id: seller.address.toLowerCase() } as const,
};
const secret = new Uint8Array(32);
secret[31] = 7;
const key = keyFromSecret(secret);
const sealed = await seal(new TextEncoder().encode('hello'), {
  fileId: new Uint8Array(32).fill(0x22),
  name: 'x',
  mime: 'text/plain',
  chunkLog2: 16,
});
terms.cipher_hash = toHex(sealed.cipherHash);
const body = await sealed.finish({
  contractId: terms.contract,
  seller: terms.seller,
  ckdSecret: key.publicKeyBytes,
  sign: (text) => seller.signMessage({ message: text }),
});
const header = body.subarray(0, new DataView(body.buffer).getUint32(8));
const now = () => Math.floor(Date.now() / 1000);
const p = (): Purchase => ({
  ...sample,
  terms_hash: termsHash(terms),
  buyer_key: toHex(key.publicKeyBytes),
  expires_at: String(now() + 3600),
});
const file = {
  terms,
  terms_hash: termsHash(terms),
  header_hash: null,
  sales_stopped_at: null,
  taken_down: null,
};
const options = {
  nearRpc: 'https://near.rpc',
  baseRpc: 'https://base.rpc',
  contractId: terms.contract,
  fileId: terms.file_id,
  url: 'https://files.example/f',
  header: 'https://files.example/header',
};
let state: Record<string, unknown> = {};
function rpc() {
  state = {};
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      const req = JSON.parse(String(init.body));
      if (url === options.nearRpc) {
        const method = req.params.method_name;
        const value =
          method === 'get_file'
            ? file
            : method === 'get_config'
              ? {
                  network: 'near:mainnet',
                  near_usdc: terms.near.token,
                  intents: 'intents.near',
                  mpc: 'v1.signer',
                  ckd_domain: 2,
                  foreign_tx_domain: 3,
                  usdc: sample.asset,
                }
              : (state[method] ?? null);
        return {
          json: async () => ({
            id: req.id,
            result: { result: [...new TextEncoder().encode(JSON.stringify(value))] },
          }),
        };
      }
      const result =
        req.method === 'eth_chainId'
          ? '0x2105'
          : req.method === 'eth_getBlockByNumber'
            ? { number: '0x100', timestamp: `0x${now().toString(16)}` }
            : req.method === 'eth_getCode'
              ? '0x'
              : req.method === 'eth_call'
                ? `0x${1000000n.toString(16).padStart(64, '0')}`
                : req.method === 'eth_getLogs'
                  ? []
                  : null;
      return { json: async () => ({ id: req.id, result }) };
    }),
  );
}
afterEach(() => vi.unstubAllGlobals());
const requirements = async () =>
  paymentRequired(
    options,
    must(await getFile(options.nearRpc, terms.contract, terms.file_id)),
    sample.asset,
  );
const payload = async () => {
  const pr = await requirements();
  const purchase = p();
  const a = {
    from: payer.address.toLowerCase(),
    to: must(terms.base).pay_to,
    value: 200000n,
    validAfter: 0n,
    validBefore: BigInt(now() + 180),
    nonce: baseNonceV2(purchaseId(purchase)),
  };
  const signature = await payer.signTypedData(typedData(sample.asset, a) as never);
  return {
    pr,
    purchase,
    a,
    header: paymentSignature(pr, must(pr.accepts[1]), a, signature, purchase),
  };
};
describe('purchase settlement model', () => {
  it('EIP-3009 digest and recovered signature agree with viem', async () => {
    const a = {
      from: payer.address,
      to: must(terms.base).pay_to,
      value: 200000n,
      validAfter: 0n,
      validBefore: 1800000180n,
      nonce: baseNonceV2(purchaseId(p())),
    };
    expect(toHex(digest(sample.asset, a))).toBe(hashTypedData(typedData(sample.asset, a) as never));
    expect(
      signer(
        digest(sample.asset, a),
        await payer.signTypedData(typedData(sample.asset, a) as never),
      ),
    ).toBe(payer.address.toLowerCase());
  });
  it('advertises NEAR plus optional Base; rejects old extensions', async () => {
    rpc();
    const pr = await requirements();
    expect(pr.accepts.map((o) => o.scheme)).toEqual(['annon-near-usdc', 'annon-exact']);
    expect(must(pr.accepts[0]).extra).toEqual({
      contract: terms.contract,
      file_id: terms.file_id,
      terms_hash: termsHash(terms),
    });
    expect(must(must(pr.accepts[1]).extra).nonceVersion).toBe(2);
    expect(discover(pr, [terms.contract])).toEqual({
      contractId: terms.contract,
      fileId: terms.file_id,
    });
    for (const version of [1, 2])
      expect(() =>
        discover(
          {
            ...pr,
            extensions: { annon: { info: { ...must(must(pr.extensions).annon).info, version } } },
          },
          [terms.contract],
        ),
      ).toThrow();
    const f = must(await getFile(options.nearRpc, terms.contract, terms.file_id));
    expect(
      paymentRequired(options, { ...f, terms: { ...terms, base: null } }, sample.asset).accepts,
    ).toHaveLength(1);
  });
  it('binds the complete purchase to EIP-3009 and refuses edits to commitment/nonce', async () => {
    rpc();
    const x = await payload();
    expect(checkPayment(x.header, x.pr).purchaseId).toBe(purchaseId(x.purchase));
    const decoded = () => JSON.parse(Buffer.from(x.header, 'base64').toString());
    expect(decoded().extensions.annon.info.purchase).toBe(buildPurchaseMessage(x.purchase));
    for (const edit of [
      (o: ReturnType<typeof decoded>) =>
        (o.extensions.annon.info.purchase = o.extensions.annon.info.purchase.replace(
          '200000',
          '1',
        )),
      (o: ReturnType<typeof decoded>) => (o.payload.authorization.nonce = terms.file_id),
      (o: ReturnType<typeof decoded>) => (o.extensions.annon.info.version = 2),
    ]) {
      const o = decoded();
      edit(o);
      expect(() => checkPayment(Buffer.from(JSON.stringify(o)).toString('base64'), x.pr)).toThrow();
    }
    const checked = checkTerms(x.header, {
      contractId: terms.contract,
      fileId: terms.file_id,
      usdc: sample.asset,
      price: 200000n,
      payTo: must(terms.base).pay_to,
      termsHash: termsHash(terms),
    });
    expect(checked.nonce).toBe(baseNonceV2(purchaseId(x.purchase)));
    expect(forFacilitator(x.header, must(x.pr.accepts[1])).paymentRequirements.scheme).toBe(
      'exact',
    );
  });
  it('records the message and key before payment signing, then saves the signed payload before RPC dry run', async () => {
    rpc();
    const pr = await requirements();
    const store = memoryStore<import('./purchase.js').PurchaseRecord>();
    const purchase = p();
    const id = purchaseId(purchase);
    const q = await preflight({
      ...options,
      buyer: payer.address,
      paymentRequired: pr,
      pay2: header,
      maxPrice: 200000n,
    });
    const result = await authorize(q, {
      purchase,
      buyerSecret: secret,
      store,
      wallet: {
        address: payer.address,
        signTypedData: async (t) => {
          const record = await store.load(purchaseKey(id));
          expect(must(record).message).toBe(buildPurchaseMessage(purchase));
          expect(must(record).buyerSecret).toBe(toHex(secret));
          return payer.signTypedData(t as never);
        },
      },
    });
    expect(must(must(await store.load(purchaseKey(id))).attempts[0]).payload).toBe(result.header);
    expect(result.purchase.checkedHeaderHash).toBe(toHex(await sha256(header)));
    await expect(
      authorize(q, {
        purchase,
        buyerSecret: secret,
        store,
        wallet: { address: payer.address, signTypedData: vi.fn() },
      }),
    ).rejects.toMatchObject({ code: 'purchase_open' });
  });
  it('refuses malformed final views and checks purchase/grant coordinates', async () => {
    rpc();
    state.get_purchase = {
      purchase_id: terms.file_id,
      file_id: terms.file_id,
      terms_hash: termsHash(terms),
      recovery: sample.recovery,
      buyer_key: sample.buyer_key,
      route: 'base-usdc',
      delivery: null,
      accepted_at: now(),
      grants: 1,
    };
    await expect(
      getPurchase(options.nearRpc, terms.contract, purchaseId(p())),
    ).rejects.toMatchObject({ code: 'transport' });
    state.get_grant = { purchase_id: terms.file_id, grant: 1, buyer_key: sample.buyer_key };
    await expect(getGrant(options.nearRpc, terms.contract, terms.file_id, 0)).rejects.toMatchObject(
      { code: 'transport' },
    );
    state.purchases_of = [terms.file_id];
    expect(await purchasesOf(options.nearRpc, terms.contract, sample.recovery)).toEqual([
      terms.file_id,
    ]);
  });
  it('authorizes download by final purchase AND grant; stopped sales preserve earlier access', async () => {
    rpc();
    const purchase = p();
    const id = purchaseId(purchase);
    const o = {
      ...options,
      headerHash: toHex(await sha256(header)),
      store: memoryStore<import('./settle.js').SellerRecord>(),
      facilitator: vi.fn(),
      file: {
        size: body.length,
        read: (start: number) =>
          new ReadableStream<Uint8Array>({
            start(c) {
              c.enqueue(body.subarray(start));
              c.close();
            },
          }),
      },
    };
    const req = {
      headers: new Headers({
        'Annon-Buyer-Proof': purchaseProof(secret, options.url, id, 0),
        Range: 'bytes=10-',
      }),
    };
    expect((await serveFile(req, o)).status).toBe(402);
    state.get_purchase = {
      purchase_id: id,
      file_id: terms.file_id,
      terms_hash: termsHash(terms),
      recovery: purchase.recovery,
      buyer_key: purchase.buyer_key,
      route: 'base-usdc',
      delivery: null,
      accepted_at: now(),
      grants: 1,
    };
    state.get_grant = { purchase_id: id, grant: 0, buyer_key: purchase.buyer_key };
    expect((await serveFile(req, o)).status).toBe(206);
    state.get_grant = { purchase_id: id, grant: 0, buyer_key: sample.buyer_key };
    expect((await serveFile(req, o)).status).toBe(402);
    expect(o.facilitator).not.toHaveBeenCalled();
  });
  it('rebuilds independently recorded Base headers', async () => {
    const vectors = JSON.parse(
      readFileSync(new URL('../../../../specs/vectors/base-headers.json', import.meta.url), 'utf8'),
    );
    for (const v of vectors.cases) {
      vi.stubGlobal(
        'fetch',
        vi.fn(async (_u, init) => ({
          json: async () => ({ id: JSON.parse(String(init?.body)).id, result: v.json }),
        })),
      );
      expect(await blockHeader('https://base.rpc', v.hash)).toBe(v.rlp);
    }
  });
});

it('caps the buyer authorization at purchase expiry and rejects longer signed payloads', async () => {
  rpc();
  const pr = await requirements();
  const purchase = { ...p(), expires_at: String(now() + 30) };
  const q = await preflight({
    ...options,
    buyer: payer.address,
    paymentRequired: pr,
    pay2: header,
    maxPrice: 200000n,
  });
  const result = await authorize(q, {
    purchase,
    buyerSecret: secret,
    store: memoryStore(),
    wallet: { address: payer.address, signTypedData: (t) => payer.signTypedData(t as never) },
  });
  const signed = checkPayment(result.header, pr);
  expect(signed.validBefore).toBeLessThanOrEqual(BigInt(purchase.expires_at));
  const a = {
    from: payer.address.toLowerCase(),
    to: must(terms.base).pay_to,
    value: 200000n,
    validAfter: 0n,
    validBefore: BigInt(purchase.expires_at) + 1n,
    nonce: baseNonceV2(purchaseId(purchase)),
  };
  const signature = await payer.signTypedData(typedData(sample.asset, a) as never);
  const invalid = paymentSignature(pr, must(pr.accepts[1]), a, signature, purchase);
  expect(() => checkPayment(invalid, pr)).toThrow();
  expect(() =>
    checkTerms(invalid, {
      contractId: terms.contract,
      fileId: terms.file_id,
      usdc: sample.asset,
      price: 200000n,
      payTo: must(terms.base).pay_to,
      termsHash: termsHash(terms),
    }),
  ).toThrow();
});

it('the seller refuses an EVM contract payer before handing the payment to a facilitator', async () => {
  rpc();
  const { header } = await payload();
  const original = globalThis.fetch;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url, init) => {
      const q = JSON.parse(String(init?.body));
      if (q.method === 'eth_getCode') return { json: async () => ({ id: q.id, result: '0x6000' }) };
      return original(url, init);
    }),
  );
  await expect(verifyPayment(header, options)).rejects.toMatchObject({ code: 'bad_signature' });
});
