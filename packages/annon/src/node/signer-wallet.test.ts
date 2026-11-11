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
