import { setupWalletSelector } from '@near-wallet-selector/core';
import { setupMyNearWallet } from '@near-wallet-selector/my-near-wallet';
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
const fragment = new URLSearchParams(location.hash.slice(1));
const redirected = location.pathname === '/callback';
let capability = redirected ? '' : location.hash.slice(1);
history.replaceState(null, '', location.pathname);
const api = async (path: string, body?: unknown) => {
  const r = await fetch(path, {
    method: 'POST',
    headers: { authorization: `Bearer ${capability}`, 'content-type': 'application/json' },
    cache: 'no-store',
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
      const networkId = q.chain === 'near:mainnet' ? 'mainnet' : 'testnet';
      const selector = await setupWalletSelector({
        network: networkId,
        modules: [setupMyNearWallet()],
      });
      const wallet = await selector.wallet('my-near-wallet');
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
          callbackUrl: string;
        };
        const state = crypto.randomUUID();
        callbacks.set(state, q.id);
        const signed = await wallet.signMessage({
          ...p,
          nonce: Buffer.from(p.nonce),
          state,
        });
        if (!signed) return; // redirect wallet: /callback forwards fragment
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
