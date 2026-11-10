import { ed25519 } from '@noble/curves/ed25519.js';
import { privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it, vi } from 'vitest';
import { must, purchase, terms } from '../../test/fixtures.js';
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
    await expect(wallet.authorize(text)).rejects.toThrow(/signed bytes/);
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
