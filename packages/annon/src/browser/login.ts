import { Buffer } from 'buffer';
import type { SigningRequest, SigningResult } from '../node/signing.js';
import type { TypedData } from '../pay/eip3009.js';
import { signInAccountOnly } from '../wallet/account-only.js';
import { evmWallet } from '../wallet/wallet.js';

Object.assign(globalThis, { Buffer });
const pair = document.getElementById('pair') as HTMLElement;
const display = document.getElementById('action') as HTMLElement;
const status = document.getElementById('status') as HTMLElement;
const approve = document.getElementById('approve') as HTMLButtonElement;
const nearChoice = document.getElementById('near-wallet') as HTMLSelectElement | null;
const hotChoice = document.getElementById('near-wallet-hot') as HTMLOptionElement | null;
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
const fragment = new URLSearchParams(location.hash.slice(1));
const redirected = location.pathname === '/callback';
let capability = redirected ? '' : location.hash.slice(1);
history.replaceState(null, '', location.pathname);
const api = async (path: string, body?: unknown) => {
  const r = await fetch(path, {
    method: 'POST',
    headers: { authorization: `Bearer ${capability}`, 'content-type': 'application/json' },
    cache: 'no-store',
    credentials: 'omit',
    redirect: 'error',
    body: JSON.stringify(body ?? {}),
  });
  if (!r.ok) throw new Error('Session expired or wallet result rejected. Return to the terminal.');
  return r.json();
};
const used = new Set<string>();
const callbacks = new Map<string, string>();
let current: SigningRequest | undefined;
if (redirected) {
  // Only a per-action opaque nonce leaves this origin. The capability stays in the opener.
  window.opener?.postMessage(
    {
      type: 'annon-wallet-result',
      state: fragment.get('state'),
      result: {
        accountId: fragment.get('accountId'),
        publicKey: fragment.get('publicKey'),
        signature: fragment.get('signature'),
      },
    },
    location.origin,
  );
  status.textContent = 'Proof returned to the approval window. Return to your terminal.';
} else {
  window.addEventListener('message', (event) => {
    if (event.origin !== location.origin || event.data?.type !== 'annon-wallet-result') return;
    const id = callbacks.get(event.data.state);
    if (!id) return;
    callbacks.delete(event.data.state);
    void api('/api/result', { id, result: event.data.result })
      .then(() => {
        status.textContent = 'Proof verified. Return to your terminal.';
      })
      .catch((e) => {
        status.textContent = e.message;
      });
  });
}
async function poll() {
  if (!capability) {
    status.textContent = 'Open the exact URL printed by your CLI.';
    return;
  }
  try {
    const r = await api('/api/action');
    pair.textContent = `Pairing code: ${r.pairingCode}. Match this with your terminal.`;
    current = r.action ?? undefined;
    display.textContent = current ? JSON.stringify(current, null, 2) : 'Waiting for the CLI…';
    approve.disabled = !current || used.has(current.id);
    if (hotChoice)
      hotChoice.disabled =
        current?.chain?.startsWith('near:') === true && current.chain !== 'near:mainnet';
    setTimeout(() => {
      void poll();
    }, 1000);
  } catch (e) {
    status.textContent = (e as Error).message;
    capability = '';
    approve.disabled = true;
  }
}
approve.onclick = async () => {
  const q = current;
  if (!q || used.has(q.id) || Date.now() >= q.expiresAt) return;
  used.add(q.id);
  approve.disabled = true;
  try {
    let result: SigningResult;
    if (q.operation.startsWith('evm.')) {
      const provider = (
        window as unknown as {
          ethereum?: { request(q: { method: string; params?: unknown }): Promise<unknown> };
        }
      ).ethereum;
      if (!provider) throw new Error('Install an injected EVM wallet.');
      const accounts = (await provider.request({ method: 'eth_requestAccounts' })) as string[];
      const address = q.account || accounts[0];
      if (!address) throw new Error('No account');
      const chain = await provider.request({ method: 'eth_chainId' });
      if (`eip155:${BigInt(String(chain))}` !== q.chain)
        throw new Error(`Select ${q.chain} in your wallet.`);
      const wallet = evmWallet(provider, address.toLowerCase());
      result =
        q.operation === 'evm.personalSign'
          ? {
              signature:
                (await wallet.authorize((q.payload as { message: string }).message))?.sig ?? '',
              account: wallet.identity.id,
            }
          : { signature: await wallet.signTypedData(q.payload as TypedData) };
    } else {
      const networkId = NEAR_NETWORKS.get(q.chain);
      if (!networkId)
        throw new Error(
          `Browser NEAR wallets support near:mainnet and near:testnet, not ${q.chain}.`,
        );
      const id = nearChoice?.value || 'meteor-wallet';
      const offered = NEAR_WALLETS.get(id);
      if (!offered) throw new Error('Unknown NEAR wallet');
      if (!offered.networks.includes(networkId))
        throw new Error(`${offered.name} is offered for near:mainnet only. Pick Meteor Wallet.`);
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
      const accounts = await signInAccountOnly(wallet);
      const account = q.account || accounts[0]?.accountId;
      if (!account || !accounts.some((a) => a.accountId === account))
        throw new Error('Select the requested NEAR account.');
      if (q.operation === 'near.nep413') {
        if (!wallet.signMessage) throw new Error('NEP-413 unavailable');
        const p = q.payload as {
          message: string;
          recipient: string;
          nonce: number[];
          callbackUrl?: string;
        };
        const state = crypto.randomUUID();
        callbacks.set(state, q.id);
        const signed = await wallet.signMessage({
          ...p,
          nonce: Buffer.from(p.nonce),
          state,
        });
        if (!signed) return; // redirect wallets: /callback forwards the fragment
        callbacks.delete(state);
        result = signed;
      } else {
        const p = q.payload as {
          receiverId: string;
          method: string;
          args: object;
          gas: string;
          deposit: string;
        };
        const outcome = await wallet.signAndSendTransaction({
          signerId: account,
          receiverId: p.receiverId,
          // Selector v10 passes Borsh Action structs through to its transaction encoder.
          actions: [
            {
              functionCall: {
                methodName: p.method,
                args: Buffer.from(JSON.stringify(p.args)),
                gas: BigInt(p.gas),
                deposit: BigInt(p.deposit),
              },
            },
          ] as never,
        });
        if (!outcome) return;
        result = { txHash: outcome.transaction.hash };
      }
    }
    await api('/api/result', { id: q.id, result });
    status.textContent = 'Verified. Return to the terminal.';
  } catch (e) {
    status.textContent = (e as Error).message;
  } finally {
    approve.disabled = true;
  }
};
if (!redirected) {
  void (async () => {
    if (!capability) capability = (await api('/api/bootstrap')).capability;
    await poll();
  })().catch((e) => {
    status.textContent = e.message;
  });
}
