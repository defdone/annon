import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { base58, base64 } from '@scure/base';
import { Account, JsonRpcProvider, KeyPairSigner } from 'near-api-js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { purchase, terms } from '../../test/fixtures.js';
import { canonicalRequest, contractArgs } from '../relay/relay.js';
import { concat, le, str, utc } from '../settle-near/codec.js';
import { buildPurchaseMessage, encodePurchase } from '../settle-near/purchase.js';
import { encodeTerms, termsHash } from '../settle-near/terms.js';
import { nearKeyPairWallet, nearSelectorWallet } from '../wallet/wallet.js';
import { getFile, getPurchase, getTerms } from './rpc.js';

const rpc = (value: unknown) => {
  const fetch = vi.fn(async (_url, init) => {
    const q = JSON.parse(init.body);
    return {
      json: async () => ({
        id: q.id,
        result:
          q.params.request_type === 'view_access_key'
            ? value
            : { result: [...new TextEncoder().encode(JSON.stringify(value))] },
      }),
    };
  });
  vi.stubGlobal('fetch', fetch);
  return fetch;
};
afterEach(() => vi.unstubAllGlobals());
describe('contract e08df29 wire shapes', () => {
  it('wraps unlock args with the canonical message and nullable header; claim grant is optional', () => {
    const args = { purchase: buildPurchaseMessage(purchase), logs: [], header: null };
    // Logs are validated separately; this checks the transaction shape.
    expect(contractArgs({ method: 'unlock', args })).toEqual({ args });
    expect(canonicalRequest({ method: 'claim_key', args: { purchase_id: terms.file_id } })).toEqual(
      { method: 'claim_key', args: { purchase_id: terms.file_id } },
    );
    expect(() => canonicalRequest({ method: 'unlock', args: { ...args, purchase } })).toThrow();
  });
  it('reads terms through get_file and validates its commitment', async () => {
    const f = {
      terms,
      terms_hash: termsHash(terms),
      header_hash: null,
      sales_stopped_at: null,
      taken_down: null,
    };
    const fetch = rpc(f);
    expect(await getTerms('https://rpc', terms.contract, terms.file_id)).toEqual(terms);
    expect(JSON.parse(fetch.mock.calls[0]?.[1].body).params.method_name).toBe('get_file');
    rpc({ ...f, terms_hash: terms.cipher_hash });
    await expect(getFile('https://rpc', terms.contract, terms.file_id)).rejects.toMatchObject({
      code: 'transport',
    });
  });
  it('validates all purchase view fields', async () => {
    const p = {
      purchase_id: terms.file_id,
      file_id: terms.file_id,
      terms_hash: termsHash(terms),
      buyer_key: purchase.buyer_key,
      recovery: purchase.recovery,
      route: 'base-usdc',
      delivery: null,
      accepted_at: 1800000000,
      grants: 1,
    };
    rpc(p);
    expect(await getPurchase('https://rpc', terms.contract, p.purchase_id)).toEqual(p);
    for (const bad of [
      { ...p, route: 'other' },
      { ...p, accepted_at: -1 },
      { ...p, delivery: '0' },
      { ...p, grants: 2 ** 32 },
      { ...p, route: 'near-usdc' },
    ]) {
      rpc(bad);
      await expect(getPurchase('https://rpc', terms.contract, p.purchase_id)).rejects.toMatchObject(
        { code: 'transport' },
      );
    }
  });
  it('supports configured NEAR tokens on testnet and sandbox and pins mainnet', () => {
    for (const network of ['near:testnet', 'near:sandbox']) {
      const t = { ...terms, network, near: { ...terms.near, token: 'usdc.fakes.testnet' } };
      expect(encodeTerms(t).length).toBeGreaterThan(0);
      expect(() => encodeTerms(t, { nearUsdc: 'other.testnet' })).toThrow();
      expect(
        encodePurchase({ ...purchase, route: 'near-usdc', network, asset: t.near.token }).length,
      ).toBeGreaterThan(0);
    }
    expect(() => encodeTerms({ ...terms, near: { ...terms.near, token: 'fake.near' } })).toThrow();
  });
  it('pins a configured Base asset when supplied', () => {
    const baseUsdc = `0x${'55'.repeat(20)}`;
    const p = { ...purchase, asset: baseUsdc };
    expect(() => encodePurchase(p)).toThrow();
    expect(encodePurchase(p, { baseUsdc }).length).toBeGreaterThan(0);
    expect(() => encodePurchase({ ...p, network: 'near:mainnet' }, { baseUsdc })).toThrow();
    expect(() => encodePurchase({ ...p, asset: baseUsdc.toUpperCase() }, { baseUsdc })).toThrow();
  });
  it('formats deadlines beyond Date and through u64 max like Rust', () => {
    expect(utc(253402300800)).toBe('10000-01-01 00:00:00 UTC');
    expect(utc(18446744073709551615n)).toBe('584554051223-11-09 07:00:15 UTC');
  });
});

describe('NEP-413 recovery ownership', () => {
  const seed = new Uint8Array(32).fill(9);
  const publicKey = `ed25519:${base58.encode(ed25519.getPublicKey(seed))}`;
  const message =
    'Annon: verify purchase recovery\ncontract: annon.near\npurchase: 0x01\nrecovery: NEAR buyer.near';
  // Independent NEP-413 encoder: u32 tag, string, fixed nonce, string, Option<string>.
  const signMessage = vi.fn(
    async (p: { message: string; nonce: Uint8Array; recipient: string }) => ({
      accountId: 'buyer.near',
      publicKey,
      signature: base64.encode(
        ed25519.sign(
          sha256(
            concat(
              le(2147484061, 4),
              str(p.message),
              p.nonce,
              str(p.recipient),
              new Uint8Array([0]),
            ),
          ),
          seed,
        ),
      ),
    }),
  );
  it('verifies a known keypair and requires final full access for this account', async () => {
    const fetch = rpc({ permission: 'FullAccess', nonce: 1 });
    const wallet = nearSelectorWallet(
      {
        getAccounts: async () => [{ accountId: 'buyer.near' }],
        signAndSendTransaction: vi.fn(),
        signMessage,
      },
      'buyer.near',
    );
    await wallet.proveControl?.(message, { contractId: 'annon.near', nearRpc: 'https://rpc' });
    expect(signMessage).toHaveBeenCalledWith(
      expect.objectContaining({ message, recipient: 'annon.near', nonce: expect.any(Uint8Array) }),
    );
    expect(JSON.parse(fetch.mock.calls[0]?.[1].body).params).toEqual({
      request_type: 'view_access_key',
      finality: 'final',
      account_id: 'buyer.near',
      public_key: publicKey,
    });
    const first = signMessage.mock.calls.at(-1)?.[0].nonce;
    await wallet.proveControl?.(message, { contractId: 'annon.near', nearRpc: 'https://rpc' });
    expect(signMessage.mock.calls.at(-1)?.[0].nonce).not.toEqual(first);
    rpc({ permission: { FunctionCall: { receiver_id: 'buyer.near', method_names: [] } } });
    await expect(
      wallet.proveControl?.(message, { contractId: 'annon.near', nearRpc: 'https://rpc' }),
    ).rejects.toThrow(/full.access/i);
  });
  it('supports the actual near-api-js signMessage adapter with a known keypair', async () => {
    rpc({ permission: 'FullAccess' });
    const account = new Account(
      'buyer.near',
      new JsonRpcProvider({ url: 'https://rpc' }),
      KeyPairSigner.fromSecretKey(
        `ed25519:${base58.encode(concat(seed, ed25519.getPublicKey(seed)))}`,
      ),
    );
    await nearKeyPairWallet(account).proveControl?.(message, {
      contractId: 'annon.near',
      nearRpc: 'https://rpc',
    });
  });
  it('binds the challenge text, recipient, nonce and tag independently', async () => {
    for (const edit of [
      (p: { message: string; recipient: string; nonce: Uint8Array }) => ({
        ...p,
        message: `${p.message}!`,
      }),
      (p: { message: string; recipient: string; nonce: Uint8Array }) => ({
        ...p,
        recipient: 'other.near',
      }),
      (p: { message: string; recipient: string; nonce: Uint8Array }) => ({
        ...p,
        nonce: new Uint8Array(32),
      }),
    ]) {
      rpc({ permission: 'FullAccess' });
      const wallet = nearSelectorWallet(
        {
          getAccounts: async () => [{ accountId: 'buyer.near' }],
          signAndSendTransaction: vi.fn(),
          signMessage: (p) => signMessage(edit(p)),
        },
        'buyer.near',
      );
      await expect(
        wallet.proveControl?.(message, { contractId: 'annon.near', nearRpc: 'https://rpc' }),
      ).rejects.toThrow(/signature/);
    }
  });
  it('rejects altered text, recipient, nonce, signature, account and missing RPC key', async () => {
    const good = await signMessage({ message, recipient: 'annon.near', nonce: new Uint8Array(32) });
    for (const result of [
      good,
      { ...good, accountId: 'other.near' },
      { ...good, signature: base64.encode(new Uint8Array(64)) },
      { ...good, publicKey: `ed25519:${base58.encode(new Uint8Array(32))}` },
    ]) {
      rpc({ permission: 'FullAccess' });
      const wallet = nearSelectorWallet(
        {
          getAccounts: async () => [{ accountId: 'buyer.near' }],
          signAndSendTransaction: vi.fn(),
          signMessage: async () => result,
        },
        'buyer.near',
      );
      await expect(
        wallet.proveControl?.(message, { contractId: 'annon.near', nearRpc: 'https://rpc' }),
      ).rejects.toThrow();
    }
    const wallet = nearKeyPairWallet(
      new Account(
        'buyer.near',
        new JsonRpcProvider({ url: 'https://rpc' }),
        KeyPairSigner.fromSecretKey(
          `ed25519:${base58.encode(concat(seed, ed25519.getPublicKey(seed)))}`,
        ),
      ),
    );
    rpc(null);
    await expect(
      wallet.proveControl?.(message, { contractId: 'annon.near', nearRpc: 'https://rpc' }),
    ).rejects.toThrow();
  });
});

it('classifies absent access keys as refusal, never as a retryable transport failure', async () => {
  const { isFullAccessKey } = await import('./rpc.js');
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_u, init) => {
      const q = JSON.parse(String(init?.body));
      return {
        json: async () => ({
          id: q.id,
          error: { cause: { name: 'UNKNOWN_ACCESS_KEY', info: {} } },
        }),
      };
    }),
  );
  await expect(
    isFullAccessKey('https://rpc', 'buyer.near', 'ed25519:missing'),
  ).rejects.toMatchObject({ code: 'refused' });
});
