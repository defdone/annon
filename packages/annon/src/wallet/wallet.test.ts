import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { base58, base64 } from '@scure/base';
import { Account, JsonRpcProvider, KeyPairSigner } from 'near-api-js';
import { privateKeyToAccount } from 'viem/accounts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { must, purchase, terms } from '../../test/fixtures.js';
import { concat, le, str } from '../settle-near/codec.js';
import { buildPurchaseMessage } from '../settle-near/purchase.js';
import { NEAR_USDC } from '../settle-near/terms.js';
import { evmWallet, nearKeyPairWallet, nearSelectorWallet, solanaWallet } from './wallet.js';

const text = 'Annon: publish a file\ncontract: annon.near';
describe('small wallet adapters with Node doubles', () => {
  it('uses EIP-1193 personal_sign over UTF-8 and verifies the returned identity', async () => {
    const account = privateKeyToAccount(`0x${'42'.repeat(32)}`);
    const provider = {
      request: vi.fn(async ({ method, params }: { method: string; params?: unknown }) => {
        if (method === 'eth_accounts') return [account.address];
        if (method === 'personal_sign') {
          const hex = must((params as string[])[0]);
          return account.signMessage({ message: { raw: hex as `0x${string}` } });
        }
        throw new Error(method);
      }),
    };
    const wallet = evmWallet({ provider }, account.address);
    expect(must(await wallet.authorize(text)).kind).toBe('evm');
    expect(provider.request.mock.calls.some(([r]) => r.method === 'personal_sign')).toBe(true);
    await expect(evmWallet(provider, must(terms.base).pay_to).authorize(text)).rejects.toThrow();
  });
  it('accepts Wallet Standard signMessage only for the identical bytes', async () => {
    const seed = new Uint8Array(32).fill(9);
    const publicKey = ed25519.getPublicKey(seed);
    const account = { publicKey, address: 'display-address' };
    const signMessage = vi.fn(
      async (
        ...inputs: {
          message: Uint8Array;
        }[]
      ) =>
        inputs.map(({ message }) => ({
          signedMessage: message,
          signature: ed25519.sign(message, seed),
        })),
    );
    const wallet = solanaWallet({ features: { 'solana:signMessage': { signMessage } } }, account);
    expect(must(await wallet.authorize(text)).kind).toBe('solana');
    signMessage.mockImplementationOnce(async () => [
      { signedMessage: new TextEncoder().encode(`${text}\n`), signature: new Uint8Array(64) },
    ]);
    await expect(wallet.authorize(text)).rejects.toMatchObject({ code: 'invalid_signature' });
  });
  it('NEAR selects the account, calls directly without auth, and attaches one yocto to USDC', async () => {
    const signAndSendTransaction = vi.fn(async (tx) => tx);
    const wallet = nearSelectorWallet(
      { getAccounts: async () => [{ accountId: 'buyer.near' }], signAndSendTransaction },
      'buyer.near',
    );
    expect(await wallet.authorize(text)).toBeUndefined();
    const p = {
      ...purchase,
      route: 'near-usdc' as const,
      network: 'near:mainnet',
      asset: NEAR_USDC,
    };
    await wallet.transferPurchase(buildPurchaseMessage(p));
    expect(signAndSendTransaction).toHaveBeenCalledWith({
      signerId: 'buyer.near',
      receiverId: NEAR_USDC,
      actions: [
        {
          type: 'FunctionCall',
          params: {
            methodName: 'ft_transfer_call',
            args: { receiver_id: p.contract, amount: p.price, msg: buildPurchaseMessage(p) },
            gas: '150000000000000',
            deposit: '1',
          },
        },
      ],
    });
    await expect(
      nearSelectorWallet(
        { getAccounts: async () => [{ accountId: 'other.near' }], signAndSendTransaction },
        'buyer.near',
      ).authorize(text),
    ).rejects.toThrow();
  });
  it('NEAR KeyPair adapter uses the account signer and refuses Base messages', async () => {
    const callFunction = vi.fn(async () => ({ ok: true }));
    const wallet = nearKeyPairWallet({ accountId: 'buyer.near', callFunction });
    await wallet.call({
      receiverId: 'annon.near',
      method: 'claim_key',
      args: { purchase_id: terms.file_id, grant: 0 },
    });
    expect(callFunction).toHaveBeenCalledWith({
      contractId: 'annon.near',
      methodName: 'claim_key',
      args: { purchase_id: terms.file_id, grant: 0 },
      gas: 300000000000000n,
      deposit: 0n,
    });
    await expect(wallet.transferPurchase(buildPurchaseMessage(purchase))).rejects.toThrow();
  });
});

it('sends a configured NEAR token only when explicitly pinned for the deployment', async () => {
  const token = 'usdc.fakes.testnet';
  const p = { ...purchase, route: 'near-usdc' as const, network: 'near:mainnet', asset: token };
  const message = buildPurchaseMessage(p, { nearUsdc: token });
  const callFunction = vi.fn(async () => null);
  const wallet = nearKeyPairWallet({ accountId: 'buyer.near', callFunction });
  await expect(wallet.transferPurchase(message)).rejects.toThrow();
  await wallet.transferPurchase(message, { nearUsdc: token });
  expect(callFunction).toHaveBeenCalledWith(
    expect.objectContaining({
      contractId: token,
      args: { receiver_id: p.contract, amount: p.price, msg: message },
    }),
  );
});

it('offers an explicit prepaid storage helper with a positive human-selected amount', async () => {
  const { storageDeposit } = await import('./wallet.js');
  const call = vi.fn(async () => null);
  await storageDeposit({ call }, 'annon.near', 10000000000000000000000n);
  expect(call).toHaveBeenCalledWith({
    receiverId: 'annon.near',
    method: 'storage_deposit',
    args: {},
    deposit: 10000000000000000000000n,
    gas: 30000000000000n,
  });
  await expect(storageDeposit({ call }, 'annon.near', 0n)).rejects.toThrow();
});

it.each(['returned', 'thrown'] as const)('recognizes a %s final funding refusal', async (mode) => {
  const { fundFileStorage } = await import('./wallet.js');
  const args = { file_id: `0x${'12'.repeat(32)}`, amount: '5' };
  const result = {
    transaction: {
      hash: 'H',
      signer_id: 'sponsor.test',
      receiver_id: 'contract.test',
      actions: [
        {
          FunctionCall: {
            method_name: 'fund_file_storage',
            args: Buffer.from(JSON.stringify(args)).toString('base64'),
          },
        },
      ],
    },
    status: {
      Failure: { ActionError: { kind: { FunctionCallError: { ExecutionError: 'stopped' } } } },
    },
    receipts_outcome: [],
  };
  const call = async () => {
    if (mode === 'thrown') throw Object.assign(new Error('final'), { transactionResult: result });
    return result;
  };
  await expect(fundFileStorage({ call }, 'contract.test', args.file_id, 5n)).rejects.toMatchObject({
    code: 'funding_refused',
  });
});

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
