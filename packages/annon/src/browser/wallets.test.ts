import { ed25519 } from '@noble/curves/ed25519.js';
import { base58, base64 } from '@scure/base';
import { privateKeyToAccount } from 'viem/accounts';
import { afterEach, expect, it, vi } from 'vitest';
import { purchase as fixture, must } from '../../test/fixtures.js';
import { nep413Hash } from '../near/nep413.js';
import * as rpc from '../near/rpc.js';
import { typedData } from '../pay/eip3009.js';
import { verifyAuthorization } from '../settle-near/identity.js';
import { buildPurchaseMessage } from '../settle-near/purchase.js';
import { NEAR_USDC } from '../settle-near/terms.js';
import { browserEvmWallet, browserNearWallet, browserSolanaWallet } from './wallets.js';

const account = privateKeyToAccount(`0x${'12'.repeat(32)}`);
const other = privateKeyToAccount(`0x${'13'.repeat(32)}`);
const solSecret = new Uint8Array(32).fill(14);
const solKey = ed25519.getPublicKey(solSecret);
const nearSecret = new Uint8Array(32).fill(15);
const nearKey = `ed25519:${base58.encode(ed25519.getPublicKey(nearSecret))}`;
const text = 'synthetic exact recovery text';
const data = typedData(`0x${'22'.repeat(20)}`, {
  from: account.address,
  to: `0x${'23'.repeat(20)}`,
  value: 1n,
  validAfter: 0n,
  validBefore: 1800000000n,
  nonce: `0x${'24'.repeat(32)}`,
});
afterEach(() => vi.restoreAllMocks());
function evm() {
  let chain = '0x2105';
  const request = vi.fn(async ({ method, params }: { method: string; params?: unknown }) => {
    if (method === 'eth_accounts') return [account.address];
    if (method === 'eth_chainId') return chain;
    if (method === 'wallet_switchEthereumChain') {
      chain = '0x2105';
      return null;
    }
    if (method === 'personal_sign') {
      const p = params as string[];
      return account.signMessage({ message: { raw: p[0] as `0x${string}` } });
    }
    if (method === 'eth_signTypedData_v4') return account.signTypedData(data as never);
    throw { code: -32601 };
  });
  return {
    request,
    setChain: (value: string) => {
      chain = value;
    },
    wallet: () => browserEvmWallet({ request }, account.address),
  };
}
function solana() {
  const provider = {
    publicKey: { toBytes: () => solKey },
    signMessage: vi.fn(async (message: Uint8Array) => ({
      signature: ed25519.sign(message, solSecret),
      publicKey: solKey,
    })),
  };
  return { provider, wallet: () => browserSolanaWallet(provider, base58.encode(solKey)) };
}
function near() {
  vi.spyOn(rpc, 'isFullAccessKey').mockResolvedValue(true);
  const provider = {
    getAccounts: vi.fn(async () => [{ accountId: 'buyer.synthetic.near' }]),
    signMessage: vi.fn(async (p: Parameters<typeof nep413Hash>[0]) => ({
      accountId: 'buyer.synthetic.near',
      publicKey: nearKey,
      signature: base64.encode(ed25519.sign(nep413Hash(p), nearSecret)),
    })),
    signAndSendTransaction: vi.fn(async (_tx: unknown) => ({
      transaction: { hash: 'synthetic-transaction', signer_id: 'buyer.synthetic.near' },
    })),
  };
  return { provider, wallet: () => browserNearWallet(provider, 'buyer.synthetic.near') };
}
const context = { contractId: 'contract.synthetic.near', nearRpc: 'https://near.example' };
it('EVM checks Base, validates both signatures, and preserves the identity', async () => {
  const h = evm();
  const wallet = h.wallet();
  const auth = await wallet.authorize(text);
  expect(verifyAuthorization(wallet.identity, text, auth)).toBe(true);
  expect(await wallet.signTypedData(data as never)).toBe(
    await account.signTypedData(data as never),
  );
});
it('EVM requests a Base switch and rechecks the chain', async () => {
  const h = evm();
  h.setChain('0x1');
  await h.wallet().signTypedData(data as never);
  expect(h.request).toHaveBeenCalledWith({
    method: 'wallet_switchEthereumChain',
    params: [{ chainId: '0x2105' }],
  });
});
it.each([
  'wrong-chain',
  'malformed-chain',
  'wrong-domain',
  'wrong-from',
  'wrong-account',
  'short-signature',
  'wrong-signature',
  'changed-chain',
  'changed-account',
] as const)('EVM refuses %s', async (fault) => {
  const h = evm();
  const original = must(h.request.getMockImplementation());
  let signed = false;
  h.request.mockImplementation(async (q) => {
    if (
      q.method === 'eth_chainId' &&
      (fault === 'wrong-chain' ||
        fault === 'malformed-chain' ||
        (fault === 'changed-chain' && signed))
    )
      return fault === 'malformed-chain' ? 'bad' : '0x1';
    if (
      q.method === 'eth_accounts' &&
      (fault === 'wrong-account' || (fault === 'changed-account' && signed))
    )
      return [other.address];
    if (q.method === 'eth_signTypedData_v4') {
      signed = true;
      if (fault === 'short-signature') return '0x00';
      if (fault === 'wrong-signature') return other.signTypedData(data as never);
    }
    return original(q);
  });
  const changed =
    fault === 'wrong-domain'
      ? { ...data, domain: { ...data.domain, chainId: 1 } }
      : fault === 'wrong-from'
        ? { ...data, message: { ...data.message, from: other.address } }
        : data;
  await expect(h.wallet().signTypedData(changed)).rejects.toMatchObject({
    code:
      fault.includes('chain') || fault === 'wrong-domain'
        ? 'wrong_chain'
        : fault.includes('account') || fault === 'wrong-from'
          ? 'wrong_identity'
          : 'invalid_signature',
  });
});
it.each(['short', 'wrong'] as const)('EVM recovery refuses a %s signature', async (fault) => {
  const h = evm();
  const original = must(h.request.getMockImplementation());
  h.request.mockImplementation((q) =>
    q.method === 'personal_sign'
      ? Promise.resolve(fault === 'short' ? '0x00' : other.signMessage({ message: text }))
      : original(q),
  );
  await expect(h.wallet().authorize(text)).rejects.toMatchObject({ code: 'invalid_signature' });
});
it('EVM recovery signs on any chain without asking the wallet to switch', async () => {
  const h = evm();
  h.setChain('0x1');
  const wallet = h.wallet();
  expect(verifyAuthorization(wallet.identity, text, await wallet.authorize(text))).toBe(true);
  expect(h.request.mock.calls.some(([q]) => q.method === 'wallet_switchEthereumChain')).toBe(false);
});
it('Solana injected message signatures verify over exact recovery bytes', async () => {
  const h = solana();
  const wallet = h.wallet();
  expect(verifyAuthorization(wallet.identity, text, await wallet.authorize(text))).toBe(true);
});
it.each(['identity', 'returned-key', 'short', 'wrong-message', 'changed-account'] as const)(
  'Solana refuses %s',
  async (fault) => {
    const h = solana();
    if (fault === 'identity') h.provider.publicKey = { toBytes: () => new Uint8Array(32).fill(8) };
    h.provider.signMessage.mockImplementation(async (message) => {
      if (fault === 'changed-account')
        h.provider.publicKey = { toBytes: () => new Uint8Array(32).fill(8) };
      return {
        signature:
          fault === 'short'
            ? new Uint8Array(5)
            : ed25519.sign(fault === 'wrong-message' ? new Uint8Array([1]) : message, solSecret),
        publicKey: fault === 'returned-key' ? new Uint8Array(32).fill(8) : solKey,
      };
    });
    await expect(h.wallet().authorize(text)).rejects.toMatchObject({
      code: ['identity', 'returned-key', 'changed-account'].includes(fault)
        ? 'wrong_identity'
        : 'invalid_signature',
    });
  },
);
it('NEAR verifies NEP-413 full-access ownership and maps a transfer to selector actions', async () => {
  const h = near();
  const wallet = h.wallet();
  await wallet.proveControl?.(text, context);
  expect(rpc.isFullAccessKey).toHaveBeenCalledWith(context.nearRpc, wallet.identity.id, nearKey);
  const p = {
    ...fixture,
    route: 'near-usdc' as const,
    network: 'near:mainnet',
    asset: NEAR_USDC,
    expires_at: String(Math.floor(Date.now() / 1000) + 3600),
  };
  const message = buildPurchaseMessage(p);
  await wallet.transferPurchase(message);
  expect(h.provider.signAndSendTransaction).toHaveBeenCalledWith({
    signerId: wallet.identity.id,
    receiverId: p.asset,
    actions: [
      {
        functionCall: {
          methodName: 'ft_transfer_call',
          args: new TextEncoder().encode(
            JSON.stringify({ receiver_id: p.contract, amount: p.price, msg: message }),
          ),
          gas: 150000000000000n,
          deposit: 1n,
        },
      },
    ],
  });
});
it.each(['selected-account', 'signed-account', 'short', 'wrong-message', 'access-key'] as const)(
  'NEAR rejects %s',
  async (fault) => {
    const h = near();
    if (fault === 'selected-account')
      h.provider.getAccounts.mockResolvedValue([{ accountId: 'other.synthetic.near' }]);
    if (fault === 'access-key') vi.mocked(rpc.isFullAccessKey).mockResolvedValue(false);
    const original = must(h.provider.signMessage.getMockImplementation());
    h.provider.signMessage.mockImplementation(async (p) => ({
      ...(await original(p)),
      ...(fault === 'signed-account' ? { accountId: 'other.synthetic.near' } : {}),
      ...(fault === 'short' ? { signature: base64.encode(new Uint8Array(5)) } : {}),
      ...(fault === 'wrong-message'
        ? { signature: base64.encode(ed25519.sign(new Uint8Array([1]), nearSecret)) }
        : {}),
    }));
    await expect(h.wallet().proveControl?.(text, context)).rejects.toMatchObject({
      code: fault.endsWith('account') ? 'wrong_identity' : 'invalid_signature',
    });
  },
);
it.each(['evm', 'solana', 'near'] as const)(
  '%s maps rejection and missing signing methods to typed errors',
  async (kind) => {
    const h = kind === 'evm' ? evm() : kind === 'solana' ? solana() : near();
    const sign =
      kind === 'evm'
        ? (h as ReturnType<typeof evm>).request
        : kind === 'solana'
          ? (h as ReturnType<typeof solana>).provider.signMessage
          : (h as ReturnType<typeof near>).provider.signMessage;
    const action = () =>
      kind === 'near'
        ? (h.wallet() as ReturnType<typeof browserNearWallet>).proveControl(text, context)
        : h.wallet().authorize(text);
    sign.mockRejectedValue({ code: 4001 });
    await expect(action()).rejects.toMatchObject({ code: 'rejected' });
    sign.mockRejectedValue({ code: -32601 });
    await expect(action()).rejects.toMatchObject({ code: 'missing_method' });
  },
);
it('NEAR maps transaction rejection and missing methods', async () => {
  const h = near();
  h.provider.signAndSendTransaction.mockRejectedValue({ code: 4001 });
  await expect(
    h.wallet().call({ receiverId: context.contractId, method: 'reopen', args: {} }),
  ).rejects.toMatchObject({ code: 'rejected' });
  h.provider.signAndSendTransaction.mockRejectedValue({ code: -32601 });
  await expect(
    h.wallet().call({ receiverId: context.contractId, method: 'reopen', args: {} }),
  ).rejects.toMatchObject({ code: 'missing_method' });
});

it('accepts an injected Solana provider returning raw signature bytes', async () => {
  const wallet = browserSolanaWallet(
    {
      publicKey: base58.encode(solKey),
      signMessage: async (message) => ed25519.sign(message, solSecret),
    },
    base58.encode(solKey),
  );
  expect(verifyAuthorization(wallet.identity, text, await wallet.authorize(text))).toBe(true);
});
it.each(['evm', 'solana', 'near-message', 'near-accounts', 'near-transaction'] as const)(
  'reports an absent %s method',
  async (kind) => {
    const h = near();
    const provider: import('./wallets.js').BrowserNearProvider = { ...h.provider };
    const action = () => {
      if (kind === 'evm') return browserEvmWallet({} as never, account.address).authorize(text);
      if (kind === 'solana')
        return browserSolanaWallet({ publicKey: solKey }, base58.encode(solKey)).authorize(text);
      if (kind === 'near-message') delete provider.signMessage;
      if (kind === 'near-accounts') delete provider.getAccounts;
      if (kind === 'near-transaction') {
        delete provider.signAndSendTransaction;
        return browserNearWallet(provider, 'buyer.synthetic.near').call({
          receiverId: context.contractId,
          method: 'reopen',
          args: {},
        });
      }
      return browserNearWallet(provider, 'buyer.synthetic.near').proveControl(text, context);
    };
    await expect(action()).rejects.toMatchObject({ code: 'missing_method' });
  },
);
it('maps a rejected EVM switch and unsupported switch without signing', async () => {
  for (const code of [4001, -32601]) {
    const h = evm();
    h.setChain('0x1');
    const original = must(h.request.getMockImplementation());
    h.request.mockImplementation((q) =>
      q.method === 'wallet_switchEthereumChain' ? Promise.reject({ code }) : original(q),
    );
    await expect(h.wallet().signTypedData(data)).rejects.toMatchObject({
      code: code === 4001 ? 'rejected' : 'missing_method',
    });
    expect(h.request.mock.calls.some(([q]) => q.method === 'eth_signTypedData_v4')).toBe(false);
  }
});
it('maps a rejected Base payment signature and an unknown wallet failure', async () => {
  const h = evm();
  const original = must(h.request.getMockImplementation());
  h.request.mockImplementation((q) =>
    q.method === 'eth_signTypedData_v4' ? Promise.reject({ code: 4001 }) : original(q),
  );
  await expect(h.wallet().signTypedData(data)).rejects.toMatchObject({ code: 'rejected' });
  h.request.mockRejectedValue(new Error('synthetic failure'));
  await expect(h.wallet().authorize(text)).rejects.toMatchObject({ code: 'wallet_error' });
});
it('rejects an absent NEP-413 result and a transaction returned for another account', async () => {
  const h = near();
  const missing = { ...h.provider, signMessage: async () => undefined };
  await expect(
    browserNearWallet(missing, 'buyer.synthetic.near').proveControl(text, context),
  ).rejects.toMatchObject({ code: 'invalid_response' });
  h.provider.signAndSendTransaction.mockResolvedValue({
    transaction: { hash: 'synthetic-hash', signer_id: 'other.synthetic.near' },
  });
  await expect(
    h.wallet().call({ receiverId: context.contractId, method: 'reopen', args: {} }),
  ).rejects.toMatchObject({ code: 'wrong_identity' });
});

it('reports an unavailable Base chain as wrong_chain', async () => {
  const h = evm();
  h.setChain('0x1');
  const original = must(h.request.getMockImplementation());
  h.request.mockImplementation((q) =>
    q.method === 'wallet_switchEthereumChain' ? Promise.reject({ code: 4902 }) : original(q),
  );
  await expect(h.wallet().signTypedData(data)).rejects.toMatchObject({ code: 'wrong_chain' });
});
it.each(['key-type', 'key-encoding', 'signature-encoding'] as const)(
  'NEAR types malformed %s results as invalid_signature',
  async (fault) => {
    const h = near();
    const original = must(h.provider.signMessage.getMockImplementation());
    h.provider.signMessage.mockImplementation(async (p) => ({
      ...(await original(p)),
      ...(fault === 'key-type'
        ? { publicKey: 'secp256k1:synthetic' }
        : fault === 'key-encoding'
          ? { publicKey: 'ed25519:!' }
          : { signature: '!' }),
    }));
    await expect(h.wallet().proveControl(text, context)).rejects.toMatchObject({
      code: 'invalid_signature',
    });
  },
);

it('accepts the existing selector wallet as a structural provider', () => {
  const accept = (
    provider: import('@near-wallet-selector/core').Wallet,
  ): import('./wallets.js').BrowserNearProvider => provider;
  expect(accept).toBeTypeOf('function');
});

it.each(['recovery', 'payment'] as const)(
  'types an account change immediately before %s signing',
  async (operation) => {
    const h = evm();
    const original = must(h.request.getMockImplementation());
    let reads = 0;
    h.request.mockImplementation((q) =>
      q.method === 'eth_accounts' && ++reads > 1 ? Promise.resolve([other.address]) : original(q),
    );
    await expect(
      operation === 'recovery' ? h.wallet().authorize(text) : h.wallet().signTypedData(data),
    ).rejects.toMatchObject({ code: 'wrong_identity' });
    expect(
      h.request.mock.calls.some(
        ([q]) => q.method === 'personal_sign' || q.method === 'eth_signTypedData_v4',
      ),
    ).toBe(false);
  },
);
