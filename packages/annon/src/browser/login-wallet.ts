/**
 * The wallet side of the approval page: one user click runs at most one wallet window, so a
 * popup is never opened after an earlier popup has used up the click's user activation.
 *
 * - NEP-413 messages: `signMessage` directly, with the account chosen in the wallet. No sign-in.
 * - NEAR transactions: one click connects (account-only sign-in), the next click sends.
 * - EVM: the injected provider, which needs no popup from the page.
 */
import { Buffer } from 'buffer';
import type { SigningRequest, SigningResult } from '../node/signing.js';
import type { TypedData } from '../pay/eip3009.js';
import { signInAccountOnly } from '../wallet/account-only.js';
import { evmWallet } from '../wallet/wallet.js';
import { Refusal, SendUncertain } from './login-status.js';

type NearNetwork = 'mainnet' | 'testnet';
/** Signing-request chains the page can bind a NEAR wallet to. Anything else is refused. */
const NEAR_NETWORKS = new Map<string, NearNetwork>([
  ['near:mainnet', 'mainnet'],
  ['near:testnet', 'testnet'],
]);
/** The selector's only RPC per network. The page CSP allows exactly these (browser-login.ts). */
const NEAR_RPC: Record<NearNetwork, string> = {
  mainnet: 'https://free.rpc.fastnear.com',
  testnet: 'https://test.rpc.fastnear.com',
};
/**
 * NEAR wallets offered on this page and the networks each is bound to. MyNearWallet is retired
 * and no longer connects to apps. HOT's selector module sends no network with its requests, so
 * it is offered for mainnet only and never loaded for another network.
 */
const NEAR_WALLETS = new Map<string, { name: string; networks: readonly NearNetwork[] }>([
  ['meteor-wallet', { name: 'Meteor Wallet', networks: ['mainnet', 'testnet'] }],
  ['hot-wallet', { name: 'HOT Wallet', networks: ['mainnet'] }],
]);

export type Outcome =
  | { kind: 'result'; result: SigningResult }
  /** A redirect wallet returns a NEP-413 result through /callback. */
  | { kind: 'redirect' }
  /** The account-only sign-in for a transaction finished; the next click sends it. */
  | { kind: 'connected'; account: string };

type Selected = Awaited<
  ReturnType<
    Awaited<ReturnType<typeof import('@near-wallet-selector/core').setupWalletSelector>>['wallet']
  >
>;

/** The NEAR network and wallet a request may use, or a refusal before any wallet code loads. */
function nearTarget(q: SigningRequest, id: string) {
  const networkId = NEAR_NETWORKS.get(q.chain);
  if (!networkId)
    throw new Refusal(
      `Browser NEAR wallets support near:mainnet and near:testnet, not ${q.chain}.`,
    );
  const offered = NEAR_WALLETS.get(id);
  if (!offered) throw new Refusal('Unknown NEAR wallet');
  if (!offered.networks.includes(networkId))
    throw new Refusal(`${offered.name} is offered for near:mainnet only. Pick Meteor Wallet.`);
  return { networkId, key: `${id}:${networkId}` };
}

async function evmSign(q: SigningRequest): Promise<SigningResult> {
  const provider = (
    window as unknown as {
      ethereum?: { request(q: { method: string; params?: unknown }): Promise<unknown> };
    }
  ).ethereum;
  if (!provider) throw new Refusal('Install an injected EVM wallet.');
  const accounts = (await provider.request({ method: 'eth_requestAccounts' })) as string[];
  const address = q.account || accounts[0];
  if (!address) throw new Refusal('No account');
  const chain = await provider.request({ method: 'eth_chainId' });
  if (`eip155:${BigInt(String(chain))}` !== q.chain)
    throw new Refusal(`Select ${q.chain} in your wallet.`);
  const wallet = evmWallet(provider, address.toLowerCase());
  return q.operation === 'evm.personalSign'
    ? {
        signature: (await wallet.authorize((q.payload as { message: string }).message))?.sig ?? '',
        account: wallet.identity.id,
      }
    : { signature: await wallet.signTypedData(q.payload as TypedData) };
}

export function pageWallets(callbacks: {
  /** Remember which request a redirect wallet's opaque `state` belongs to. */
  expect(state: string, id: string): void;
  forget(state: string): void;
  /**
   * Called just before the wallet's send for request `id`: marks it sent for good and resolves
   * only once the CLI acknowledged it. A rejection means the wallet is never called.
   */
  sending(id: string): Promise<void>;
}) {
  /** Wallets this page has loaded and signed out of any older connection, per wallet and network. */
  const loaded = new Map<string, Selected>();
  /** Accounts from this page's own account-only sign-in, per wallet and network. */
  const connected = new Map<string, readonly { accountId: string }[]>();

  async function load(id: string, networkId: NearNetwork, key: string) {
    const cached = loaded.get(key);
    if (cached) return cached;
    // Only the chosen wallet is loaded, on first use: the page starts without wallet code
    // touching storage or listeners, and a refused wallet never runs.
    const [{ setupWalletSelector }, module] = await Promise.all([
      import('@near-wallet-selector/core'),
      id === 'hot-wallet'
        ? import('@near-wallet-selector/hot-wallet').then((m) => m.setupHotWallet())
        : import('@near-wallet-selector/meteor-wallet').then((m) => m.setupMeteorWallet()),
    ]);
    const selector = await setupWalletSelector({
      network: networkId,
      fallbackRpcUrls: [NEAR_RPC[networkId]],
      modules: [module],
    });
    const wallet = await selector.wallet(id);
    // A reused loopback origin may hold an older connection. Never let it sign silently.
    await wallet.signOut();
    loaded.set(key, wallet);
    return wallet;
  }

  async function nearSign(q: SigningRequest, id: string): Promise<Outcome> {
    const { networkId, key } = nearTarget(q, id);
    const wallet = await load(id, networkId, key);
    if (q.operation === 'near.nep413') {
      if (!wallet.signMessage) throw new Refusal('This wallet cannot sign NEP-413 messages.');
      const p = q.payload as { message: string; recipient: string; nonce: number[] };
      const state = crypto.randomUUID();
      callbacks.expect(state, q.id);
      let signed: Awaited<ReturnType<NonNullable<typeof wallet.signMessage>>>;
      try {
        signed = await wallet.signMessage({ ...p, nonce: Buffer.from(p.nonce), state });
      } catch (error) {
        callbacks.forget(state);
        throw error;
      }
      if (!signed) return { kind: 'redirect' }; // /callback forwards the fragment
      callbacks.forget(state);
      if (q.account && signed.accountId !== q.account)
        throw new Refusal(`The wallet signed as ${signed.accountId}. Sign with ${q.account}.`);
      return { kind: 'result', result: signed };
    }
    let accounts = connected.get(key);
    if (!accounts) {
      accounts = await signInAccountOnly(wallet);
      const account = q.account || accounts[0]?.accountId;
      if (!account || !accounts.some((a) => a.accountId === account))
        throw new Refusal('Select the requested NEAR account.');
      connected.set(key, accounts);
      return { kind: 'connected', account };
    }
    const account = q.account || accounts[0]?.accountId;
    if (!account || !accounts.some((a) => a.accountId === account)) {
      connected.delete(key);
      throw new Refusal('Select the requested NEAR account.');
    }
    const p = q.payload as {
      receiverId: string;
      method: string;
      args: object;
      gas: string;
      deposit: string;
    };
    const actions = [
      {
        // Selector v10 passes Borsh Action structs through to its transaction encoder.
        functionCall: {
          methodName: p.method,
          args: Buffer.from(JSON.stringify(p.args)),
          gas: BigInt(p.gas),
          deposit: BigInt(p.deposit),
        },
      },
    ] as never;
    // From here on the wallet may broadcast: any failure is uncertain and this request is never
    // tried again from the page. The CLI must know before the wallet is called.
    try {
      await callbacks.sending(q.id);
    } catch {
      throw new Refusal(
        'The CLI did not accept this send, so nothing was sent. Return to the terminal.',
      );
    }
    let hash: unknown;
    try {
      const outcome = await wallet.signAndSendTransaction({
        signerId: account,
        receiverId: p.receiverId,
        actions,
      });
      hash = outcome?.transaction?.hash;
    } catch (error) {
      throw new SendUncertain('wallet send failed', { cause: error });
    }
    if (typeof hash !== 'string' || !hash) throw new SendUncertain('no transaction hash');
    return { kind: 'result', result: { txHash: hash } };
  }

  return {
    /** True when the next click on this request only connects the wallet. */
    needsConnect(q: SigningRequest, id: string): boolean {
      const networkId = NEAR_NETWORKS.get(q.chain);
      return (
        q.operation === 'near.signTransaction' &&
        networkId !== undefined &&
        !connected.has(`${id}:${networkId}`)
      );
    },
    async run(q: SigningRequest, id: string): Promise<Outcome> {
      if (q.operation.startsWith('evm.')) return { kind: 'result', result: await evmSign(q) };
      return nearSign(q, id);
    },
  };
}
