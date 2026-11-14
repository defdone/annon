import { expect, it } from 'vitest';
import {
  accessKey,
  approveNear,
  expectNoSecretLogged,
  meteorPopup,
  nearAction,
  nearRpc,
} from '../../test/login-page.js';
import { signingRequest } from '../node/signing.js';
import { typedData } from '../pay/eip3009.js';
import { BASE_USDC } from '../settle-near/terms.js';

it.each(['near.nep413', 'near.signTransaction'])(
  'Meteor %s: every popup opens inside its own click, never after an awaited popup',
  async (operation) => {
    // A browser allows window.open only with a fresh user activation, and window.open uses it up.
    let activation = false;
    let blocked = 0;
    const opened: string[] = [];
    const listeners = new Set<(e: unknown) => void>();
    const open = meteorPopup(listeners, {
      opened,
      canOpen: () => {
        if (!activation) {
          blocked++;
          return false;
        }
        activation = false;
        return true;
      },
    });
    const nep413 = operation === 'near.nep413';
    const { status, results, elements } = await approveNear(
      nearAction(operation),
      'meteor-wallet',
      { rpc: nearRpc, listeners, open },
      nep413 ? 1 : 2,
      (page) => {
        activation = true;
        if (!nep413 && opened.length === 0)
          expect(page.get('approve')?.textContent).toBe('Connect wallet');
      },
    );
    expect(blocked).toBe(0);
    expect(opened).toEqual(
      nep413
        ? ['/connect/testnet/sign_message']
        : ['/connect/testnet/login', '/connect/testnet/sign'],
    );
    expect(status).toContain('Signed. Return to the terminal.');
    expect(results).toHaveLength(1);
    expect(elements.get('approve')?.disabled).toBe(true);
  },
);

it('after a closed wallet window the page explains it, reports only the reason and lets the person retry', async () => {
  const listeners = new Set<(e: unknown) => void>();
  let attempts = 0;
  const open = meteorPopup(listeners, {
    reply: () => (++attempts === 1 ? 'closed_window' : 'closed_success'),
  });
  let enabledBeforeRetry: boolean | undefined;
  const { statuses, results, reports } = await approveNear(
    nearAction('near.nep413'),
    'meteor-wallet',
    { rpc: nearRpc, listeners, open },
    2,
    (page) => {
      if (attempts === 1) enabledBeforeRetry = page.get('approve')?.disabled === false;
    },
  );
  expect(statuses[0]).toBe(
    'The wallet window closed before signing. Try again or pick another wallet.',
  );
  expect(enabledBeforeRetry).toBe(true);
  expect(reports).toEqual(['window_closed']);
  expect(statuses[1]).toContain('Signed. Return to the terminal.');
  expect(results).toHaveLength(1);
});

it('renders the request summary, pairing code and a cancel that reports only "cancelled"', async () => {
  const listeners = new Set<(e: unknown) => void>();
  const { elements, reports, results } = await approveNear(
    nearAction('near.signTransaction'),
    'meteor-wallet',
    { rpc: nearRpc, listeners, open: meteorPopup(listeners) },
    0,
  );
  expect(elements.get('title')?.textContent).toBe('Approve a payment');
  expect(elements.get('amount')?.textContent).toBe('1 base units of usdc.near');
  expect(elements.get('pair')?.textContent).toBe('123');
  expect(elements.get('wallet-field')?.hidden).toBe(false);
  expect(elements.get('approve')?.textContent).toBe('Connect wallet');
  expect(elements.get('cancel')?.hidden).toBe(false);
  await elements.get('cancel')?.onclick?.();
  expect(reports).toEqual(['cancelled']);
  expect(elements.get('approve')?.disabled).toBe(true);
  expect(elements.get('status')?.textContent).toBe('Cancelled. Return to the terminal.');
  expect(results).toEqual([]);
});

it('once the wallet send ran, any failure ends the request: no retry, no wallet switch, no second send', async () => {
  const listeners = new Set<(e: unknown) => void>();
  const opened: string[] = [];
  const open = meteorPopup(listeners, {
    opened,
    reply: (type) => (type === 'sign' ? 'closed_window' : 'closed_success'),
  });
  const { statuses, results, reports, elements } = await approveNear(
    nearAction('near.signTransaction'),
    'meteor-wallet',
    { rpc: nearRpc, listeners, open },
    3,
  );
  expect(statuses[0]).toContain('Connected as bot.near');
  expect(statuses[1]).toBe(
    'The wallet may have sent the transaction. Do not approve it again. Return to the terminal.',
  );
  expect(statuses[2]).toBe(statuses[1]);
  expect(opened).toEqual(['/connect/testnet/login', '/connect/testnet/sign']);
  expect(reports).toEqual(['send_started', 'send_uncertain']);
  expect(results).toEqual([]);
  expect(elements.get('approve')?.disabled).toBe(true);
  expect(elements.get('cancel')?.hidden).toBe(true);
  expect(elements.get('near-wallet')?.getAttribute('aria-disabled')).toBe('true');
});

it('a failure before the send (the connect window closed) can be retried', async () => {
  const listeners = new Set<(e: unknown) => void>();
  const opened: string[] = [];
  let logins = 0;
  const open = meteorPopup(listeners, {
    opened,
    reply: (type) => (type === 'login' && ++logins === 1 ? 'closed_window' : 'closed_success'),
  });
  const { statuses, results, reports } = await approveNear(
    nearAction('near.signTransaction'),
    'meteor-wallet',
    { rpc: nearRpc, listeners, open },
    3,
  );
  expect(statuses[0]).toBe(
    'The wallet window closed before signing. Try again or pick another wallet.',
  );
  expect(statuses[1]).toContain('Connected as bot.near');
  expect(statuses[2]).toContain('Signed. Return to the terminal.');
  expect(opened).toEqual([
    '/connect/testnet/login',
    '/connect/testnet/login',
    '/connect/testnet/sign',
  ]);
  expect(reports).toEqual(['window_closed', 'send_started']);
  expect(results).toEqual([{ txHash: 'FAKE-TX-HASH' }]);
});

// Independent reproductions from the verification review: one send, whatever the wallet answers.
it('no second send after a transaction window closes without a result', async () => {
  const listeners = new Set<(e: unknown) => void>();
  let sends = 0;
  const open = meteorPopup(listeners, {
    reply: (kind) => (kind === 'sign' && ++sends === 1 ? 'closed_window' : 'closed_success'),
  });
  const { elements, results } = await approveNear(
    nearAction('near.signTransaction'),
    'meteor-wallet',
    { rpc: nearRpc, listeners, open },
    3,
  );
  expect(sends).toBe(1);
  expect(results).toEqual([]);
  expect(elements.get('approve')?.disabled).toBe(true);
});

it('a missing transaction outcome is a possible send: no retry and no result', async () => {
  const listeners = new Set<(e: unknown) => void>();
  let sends = 0;
  const open = () => ({
    closed: false,
    focus() {},
    postMessage(data: { uid: string; status: string; actionType: string; inputs?: unknown }) {
      if (data.status !== 'initializing' || !data.inputs) return;
      if (data.actionType === 'sign') sends++;
      const payload =
        data.actionType === 'login'
          ? { accountId: 'bot.near', allKeys: [accessKey] }
          : { executionOutcomes: [] };
      setTimeout(() => {
        for (const fn of listeners)
          fn({
            origin: 'https://wallet.meteorwallet.app',
            data: { uid: data.uid, status: 'closed_success', payload, endTags: [] },
          });
      }, 0);
    },
  });
  const { results, reports, elements, statuses } = await approveNear(
    nearAction('near.signTransaction'),
    'meteor-wallet',
    { rpc: nearRpc, listeners, open },
    3,
  );
  expect(sends).toBe(1);
  expect(results).toEqual([]);
  expect(reports).toEqual(['send_started', 'send_uncertain']);
  expect(statuses[1]).toContain('The wallet may have sent the transaction.');
  expect(elements.get('approve')?.disabled).toBe(true);
});

it('a wallet error thrown after the send started is uncertain, whatever its shape', async () => {
  const listeners = new Set<(e: unknown) => void>();
  let sends = 0;
  const open = meteorPopup(listeners, {
    reply: (kind) => {
      if (kind !== 'sign') return 'closed_success';
      sends++;
      return 'closed_fail';
    },
  });
  const { reports, statuses } = await approveNear(
    nearAction('near.signTransaction'),
    'meteor-wallet',
    { rpc: nearRpc, listeners, open },
    3,
  );
  expect(sends).toBe(1);
  expect(reports).toEqual(['send_started', 'send_uncertain']);
  expect(statuses[1]).not.toMatch(/Try again|declined|closed before signing/);
});

it('the wallet is never called when the CLI does not acknowledge the send start', async () => {
  const listeners = new Set<(e: unknown) => void>();
  const opened: string[] = [];
  const { results, statuses, elements } = await approveNear(
    nearAction('near.signTransaction'),
    'meteor-wallet',
    {
      rpc: nearRpc,
      listeners,
      open: meteorPopup(listeners, { opened }),
      // The CLI refuses the send start, e.g. because another page already started one.
      refuse: (url: string, body: { reason?: string }) =>
        url === '/api/report' && body.reason === 'send_started',
    },
    2,
  );
  expect(opened).toEqual(['/connect/testnet/login']);
  expect(results).toEqual([]);
  expect(statuses[1]).toBe(
    'The CLI did not accept this send, so nothing was sent. Return to the terminal.',
  );
  expect(elements.get('approve')?.disabled).toBe(true);
});

it('a reloaded page whose request already started a send shows it as uncertain and cannot send', async () => {
  const listeners = new Set<(e: unknown) => void>();
  const opened: string[] = [];
  const { elements, statuses } = await approveNear(
    nearAction('near.signTransaction'),
    'meteor-wallet',
    {
      rpc: nearRpc,
      listeners,
      open: meteorPopup(listeners, { opened }),
      server: { sendStarted: true },
    },
    2,
  );
  expect(opened).toEqual([]);
  expect(statuses).toEqual([
    'The wallet may have sent the transaction. Do not approve it again. Return to the terminal.',
    'The wallet may have sent the transaction. Do not approve it again. Return to the terminal.',
  ]);
  expect(elements.get('approve')?.disabled).toBe(true);
  expect(elements.get('near-wallet')?.getAttribute('aria-disabled')).toBe('true');
});

it('an expected NEP-413 account cannot be replaced by the wallet', async () => {
  const listeners = new Set<(e: unknown) => void>();
  const action = nearAction('near.nep413');
  action.account = 'expected.near';
  const { results, reports, status } = await approveNear(action, 'meteor-wallet', {
    rpc: nearRpc,
    listeners,
    open: meteorPopup(listeners),
  });
  expect(results).toEqual([]);
  expect(reports).toEqual(['refused']);
  expect(status).toContain('The wallet signed as bot.near. Sign with expected.near.');
});

it('direct Meteor message signing takes the identity chosen in the wallet and stores no connector key', async () => {
  const listeners = new Set<(e: unknown) => void>();
  const action = nearAction('near.nep413');
  action.account = '';
  const { results, stored } = await approveNear(action, 'meteor-wallet', {
    rpc: nearRpc,
    listeners,
    open: meteorPopup(listeners),
  });
  expect(results).toEqual([expect.objectContaining({ accountId: 'bot.near' })]);
  expect(expectNoSecretLogged([], stored)).toHaveLength(0);
});

it('an EVM typed-data retry signs the same authorization and sends no transaction', async () => {
  const address = `0x${'11'.repeat(20)}`;
  const action = signingRequest(
    'evm.signTypedData',
    'eip155:8453',
    address,
    typedData(BASE_USDC, {
      from: address,
      to: `0x${'22'.repeat(20)}`,
      value: 1n,
      validAfter: 0n,
      validBefore: 2000000000n,
      nonce: `0x${'33'.repeat(32)}`,
    }),
  );
  const signed: unknown[] = [];
  const methods: string[] = [];
  const ethereum = {
    request: async (q: { method: string; params?: unknown }) => {
      methods.push(q.method);
      if (q.method === 'eth_chainId') return '0x2105';
      if (q.method === 'eth_requestAccounts' || q.method === 'eth_accounts') return [address];
      if (q.method === 'eth_signTypedData_v4') {
        signed.push(q.params);
        if (signed.length === 1) throw new Error('timeout after signing');
        return '0x1234';
      }
      throw new Error(`unexpected EVM method ${q.method}`);
    },
  };
  const { results } = await approveNear(
    action as unknown as ReturnType<typeof nearAction>,
    'meteor-wallet',
    { rpc: nearRpc, ethereum },
    2,
  );
  expect(signed).toHaveLength(2);
  expect(signed[0]).toEqual(signed[1]);
  expect(methods.some((m) => /sendTransaction|sendRawTransaction/.test(m))).toBe(false);
  expect(results).toEqual([{ signature: '0x1234' }]);
});
