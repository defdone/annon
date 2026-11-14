import { expect, it, vi } from 'vitest';
import { purchase } from '../../test/fixtures.js';
import { buildPurchaseMessage, purchaseId } from '../settle-near/purchase.js';
import type { NearWallet } from '../wallet/wallet.js';
import { publicError } from './errors.js';
import { configuredWallet } from './signer-wallet.js';

const send = vi.hoisted(() => vi.fn());
vi.mock('../near/rpc.js', async (original) => ({
  ...(await original<typeof import('../near/rpc.js')>()),
  rpcReply: send,
}));
vi.mock('./signing.js', async (original) => ({
  ...(await original<typeof import('./signing.js')>()),
  remoteSigner: () => async () => ({ signedTransaction: 'AQID' }),
}));
vi.mock('near-api-js', async (original) => ({
  ...(await original<typeof import('near-api-js')>()),
  Account: class {
    createTransaction = async () => ({ encode: () => new Uint8Array([1, 2, 3]) });
  },
  decodeSignedTransaction: () => ({ transaction: { encode: () => new Uint8Array([1, 2, 3]) } }),
}));
it.each(['transport', 'rpc-error'])(
  'preserves the locally computed hash and purchase on %s after signed-byte submission',
  async (mode) => {
    send.mockImplementation(async () => {
      if (mode === 'transport') throw new Error('lost response');
      return { error: { message: 'timeout' } };
    });
    const wallet = await configuredWallet(
      {
        mode: 'remote',
        url: 'https://fake.signer',
        credential: { env: 'FAKE' },
        identity: { kind: 'near', id: 'buyer.near' },
        publicKey: 'ed25519:11111111111111111111111111111111',
      },
      {
        nearRpc: 'https://fake.rpc',
        baseRpc: '',
        contractId: purchase.contract,
        network: 'near:testnet',
        stateDir: '/unused',
      },
      { command: 'buy' },
      { FAKE: 'fake' },
      { read: vi.fn(), create: vi.fn() },
      vi.fn(),
      () => null,
    );
    const p = {
      ...purchase,
      route: 'near-usdc' as const,
      asset: 'usdc.near',
      network: 'near:testnet',
      expires_at: String(Math.floor(Date.now() / 1000) + 10000),
    };
    try {
      if (!('transferPurchase' in wallet)) throw new Error('missing NEAR wallet');
      await (wallet as NearWallet).transferPurchase(buildPurchaseMessage(p));
      expect.fail('must preserve uncertainty');
    } catch (error) {
      expect(error).toMatchObject({
        code: 'transaction_uncertain',
        txHash: expect.any(String),
        purchaseId: purchaseId(p),
      });
      expect(publicError(error)).toMatchObject({
        code: 'transaction_uncertain',
        purchaseId: purchaseId(p),
        txHash: expect.any(String),
        exitCode: 4,
      });
    }
  },
);

it.each(['evmKeyFile', 'nearKeyFile', 'solanaKeyFile'] as const)(
  'refuses per-call %s with a configured signer before opening or reading credentials',
  async (flag) => {
    const keychain = { read: vi.fn(), create: vi.fn() };
    const browser = vi.fn(async () => {
      throw new Error('must not open');
    });
    await expect(
      configuredWallet(
        { mode: 'browser', identity: { kind: 'evm', id: `0x${'11'.repeat(20)}` } },
        {
          nearRpc: 'https://fake.rpc',
          baseRpc: '',
          contractId: 'annon.near',
          network: 'near:testnet',
          stateDir: '/unused',
        },
        { command: 'buy', [flag]: '/fake-key' },
        {},
        keychain,
        browser,
        () => null,
      ),
    ).rejects.toThrow(/key.file|configured signer/i);
    expect(browser).not.toHaveBeenCalled();
    expect(keychain.read).not.toHaveBeenCalled();
  },
);

it('browser NEAR recovery requests a NEP-413 signature without a callbackUrl, as in-page wallets sign it', async () => {
  const { ed25519 } = await import('@noble/curves/ed25519.js');
  const { base58, base64 } = await import('@scure/base');
  const { nep413Hash } = await import('../near/nep413.js');
  const secret = new Uint8Array(32).fill(5);
  const publicKey = `ed25519:${base58.encode(ed25519.getPublicKey(secret))}`;
  const requested: Record<string, unknown>[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init?: RequestInit) => {
      const q = JSON.parse(String(init?.body));
      return Response.json({ jsonrpc: '2.0', id: q.id, result: { permission: 'FullAccess' } });
    }),
  );
  try {
    const wallet = (await configuredWallet(
      { mode: 'browser', identity: { kind: 'near', id: 'buyer.near' } },
      {
        nearRpc: 'https://fake.rpc',
        baseRpc: '',
        contractId: purchase.contract,
        network: 'near:testnet',
        stateDir: '/unused',
      },
      { command: 'buy' },
      {},
      { read: vi.fn(), create: vi.fn() },
      async () => ({
        url: 'http://127.0.0.1:1234/#CAPABILITY',
        pairingCode: '123456',
        close: async () => {},
        async request<T>(q: { id: string; expiresAt: number }, verify: (r: T) => Promise<void>) {
          const p = (q as unknown as { payload: Record<string, unknown> }).payload;
          requested.push(p);
          const hash = nep413Hash({
            message: String(p.message),
            recipient: String(p.recipient),
            nonce: Uint8Array.from(p.nonce as Uint8Array),
          });
          const result = {
            accountId: 'buyer.near',
            publicKey,
            signature: base64.encode(ed25519.sign(hash, secret)),
          } as T;
          await verify(result);
          return result;
        },
      }),
      () => null,
    )) as NearWallet;
    await wallet.proveControl?.('recover', {
      contractId: purchase.contract,
      nearRpc: 'https://fake.rpc',
    });
    expect(requested).toHaveLength(1);
    expect(Object.keys(requested[0] ?? {}).sort()).toEqual(['message', 'nonce', 'recipient']);
  } finally {
    vi.unstubAllGlobals();
  }
});
