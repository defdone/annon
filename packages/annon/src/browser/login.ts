import { Buffer } from 'buffer';
import type { SigningRequest } from '../node/signing.js';
import { pageElements, renderSummary, showStatus } from './login-dom.js';
import { walletPicker } from './login-dropdown.js';
import { expiryText } from './login-format.js';
import { connected, SendUncertain, STATUS, type Status, walletFailure } from './login-status.js';
import { describeRequest, technicalDetails } from './login-view.js';
import { pageWallets } from './login-wallet.js';

Object.assign(globalThis, { Buffer });
const el = pageElements(document);
const approve = el.approve as HTMLButtonElement;
const cancel = document.getElementById('cancel') as HTMLButtonElement | null;
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
/** Requests whose result went to the CLI, or that ended here: never signed again. */
const done = new Set<string>();
const callbacks = new Map<string, string>();
const wallets = pageWallets({
  expect: (state, id) => callbacks.set(state, id),
  forget: (state) => callbacks.delete(state),
  sending: async (id) => {
    // The wallet may broadcast from now on: this request is never attempted again here, and the
    // CLI records it before the wallet is called.
    done.add(id);
    await api('/api/report', { id, reason: 'send_started' });
  },
});
let current: SigningRequest | undefined;
let expiry: HTMLElement | undefined;
let busy = false;

const status = (s: Status) => showStatus(el, s);
const picker = walletPicker(document, () => controls());
const walletId = () => picker.value();
/** Buttons and wallet choice follow the request: usable only while it is open and idle. */
function controls() {
  const q = current;
  const open = !!q && !done.has(q.id) && Date.now() < q.expiresAt;
  approve.disabled = !open || busy;
  if (cancel) {
    cancel.hidden = !open;
    cancel.disabled = busy;
  }
  // No wallet switch while a wallet is open or once the request is finished or sent.
  picker.setLocked(!open || busy);
  approve.textContent =
    q && wallets.needsConnect(q, walletId()) ? 'Connect wallet' : 'Review in wallet';
}
async function submit(id: string, result: unknown) {
  done.add(id);
  status(STATUS.verifying);
  controls();
  try {
    await api('/api/result', { id, result });
    status(STATUS.signed);
  } catch {
    status(STATUS.rejected);
  }
}

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
  status(STATUS.redirected);
} else {
  window.addEventListener('message', (event) => {
    if (event.origin !== location.origin || event.data?.type !== 'annon-wallet-result') return;
    const id = callbacks.get(event.data.state);
    if (!id) return;
    callbacks.delete(event.data.state);
    void submit(id, event.data.result);
  });
}

/** Shows the CLI's current request; a finished one stays on screen with its outcome. */
function show(q: SigningRequest | undefined, sendStarted = false) {
  if (q && q.id !== current?.id) {
    current = q;
    expiry = renderSummary(document, el, describeRequest(q), technicalDetails(q));
    el['wallet-field'].hidden = !q.operation.startsWith('near.');
    picker.setDisabled('hot-wallet', q.chain !== 'near:mainnet');
    status(wallets.needsConnect(q, walletId()) ? STATUS.connect : STATUS.ready);
  }
  const last = current;
  // A send started from an earlier load of this page: the wallet may have broadcast it.
  if (last && q && sendStarted && !done.has(last.id)) {
    done.add(last.id);
    status({ tone: 'error', text: walletFailure(new SendUncertain()).text });
  }
  if (!last || !expiry) {
    status(STATUS.waitingCli);
  } else {
    expiry.textContent = expiryText(last.expiresAt, Date.now());
    const expired = Date.now() >= last.expiresAt;
    // The CLI dropped the request (expired, cancelled or session over) before a result was sent.
    if (!done.has(last.id) && (!q || expired)) {
      done.add(last.id);
      status(expired ? STATUS.expired : STATUS.ended);
    }
  }
  controls();
}

async function poll() {
  if (!capability) {
    status(STATUS.noCapability);
    return;
  }
  try {
    const r = await api('/api/action');
    el.pair.textContent = String(r.pairingCode);
    show(r.action ?? undefined, r.sendStarted === true);
    setTimeout(() => {
      void poll();
    }, 1000);
  } catch (e) {
    status({ tone: 'error', text: (e as Error).message });
    capability = '';
    approve.disabled = true;
  }
}

approve.onclick = async () => {
  const q = current;
  if (!q || busy || done.has(q.id) || Date.now() >= q.expiresAt) return;
  busy = true;
  controls();
  status(STATUS.wallet);
  try {
    const outcome = await wallets.run(q, walletId());
    busy = false;
    if (outcome.kind === 'connected') status(connected(outcome.account));
    else if (outcome.kind === 'result') await submit(q.id, outcome.result);
  } catch (e) {
    // One click per attempt, never retried here: the person may try this request again until it
    // expires. The CLI hears only a fixed reason name.
    const failure = walletFailure(e);
    status({ tone: 'error', text: failure.text });
    void api('/api/report', { id: q.id, reason: failure.reason }).catch(() => {});
  } finally {
    busy = false;
    controls();
  }
};
if (cancel)
  cancel.onclick = () => {
    const q = current;
    if (!q || busy || done.has(q.id)) return;
    done.add(q.id);
    controls();
    status({ tone: 'error', text: 'Cancelled. Return to the terminal.' });
    void api('/api/report', { id: q.id, reason: 'cancelled' }).catch(() => {});
  };
if (!redirected) {
  void (async () => {
    if (!capability) capability = (await api('/api/bootstrap')).capability;
    await poll();
  })().catch((e) => {
    status({ tone: 'error', text: e.message });
  });
}
