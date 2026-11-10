import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Identity } from '../settle-near/identity.js';
import type { ReopenV2 } from '../settle-near/purchase.js';
import { getConfig, NearError, readOutcome, txOutcome, view } from './rpc.js';
import {
  type RegisterArgs,
  registerText,
  reopenSellerText,
  reopenText,
  type SellerArgs,
  stopSalesText,
} from './texts.js';

const CONTRACT = 'v1.annon.defdone.near';
const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64');
const event = (name: string, data: object) =>
  `EVENT_JSON:${JSON.stringify({ standard: 'annon', version: '2.0.0', event: name, data: [data] })}`;
const ok = { SuccessValue: '' };
const panic = (msg: string) => ({
  Failure: {
    ActionError: {
      index: 0,
      kind: { FunctionCallError: { ExecutionError: `Smart contract panicked: ${msg}` } },
    },
  },
});
type Receipt = { executor: string; logs: string[]; status?: object };
/** An `EXPERIMENTAL_tx_status` result in the shape NEAR returns it. */
const tx = (
  method: string | string[],
  status: unknown,
  receipts: Receipt[],
  receiver = CONTRACT,
) => ({
  transaction: {
    hash: 'TxHash',
    signer_id: 'relayer.annon.defdone.near',
    receiver_id: receiver,
    actions: [method].flat().map((m) => ({ FunctionCall: { method_name: m, args: '' } })),
  },
  status,
  receipts_outcome: receipts.map((r) => ({
    outcome: { executor_id: r.executor, logs: r.logs, status: r.status ?? ok },
  })),
});
const answer = { big_y: 'bls12381g1:aaa', big_c: 'bls12381g1:bbb' };
const verified = event('payment_verified', { file_id: '0x11', base_tx: '0xaa', log_index: 7 });
const released = event('key_released', { file_id: '0x11', reason: 'unlock' });

describe('readOutcome', () => {
  it('reads a key release with its receipt events', () => {
    const o = readOutcome(
      tx('unlock', { SuccessValue: b64(answer) }, [
        { executor: CONTRACT, logs: ['unlock: checking', verified] },
        { executor: 'v1.signer', logs: ['verify_foreign_transaction: ...'] },
        { executor: CONTRACT, logs: [released] },
      ]),
      CONTRACT,
    );
    expect(o.state).toBe('released');
    expect(o.state === 'released' && o.answer).toEqual(answer);
    expect(o.events.map((e) => e.event)).toEqual(['payment_verified', 'key_released']);
  });

  it('with the expected call, refuses an outcome of another method or other arguments', () => {
    const args = { args: { file_id: '0x11', deadline: 1 }, sig: '0xab' };
    const sent = tx('stop_sales', { SuccessValue: '' }, []);
    sent.transaction.actions[0] = { FunctionCall: { method_name: 'stop_sales', args: b64(args) } };
    const expectCall = { txHash: 'TxHash', signer: 'relayer.annon.defdone.near' };
    // Same values, keys in another order: the same call.
    const reordered = { sig: '0xab', args: { deadline: 1, file_id: '0x11' } };
    expect(
      readOutcome(sent, CONTRACT, { ...expectCall, method: 'stop_sales', args: reordered }).state,
    ).toBe('done');
    // A field left undefined is not sent, as JSON goes: still the same call.
    const optional = { ...reordered, args: { ...reordered.args, header: undefined } };
    expect(
      readOutcome(sent, CONTRACT, { ...expectCall, method: 'stop_sales', args: optional }).state,
    ).toBe('done');
    for (const other of [
      { method: 'reopen', args },
      { method: 'stop_sales', args: { ...args, args: { file_id: '0x22', deadline: 1 } } },
    ]) {
      expect(() => readOutcome(sent, CONTRACT, { ...expectCall, ...other })).toThrow(/another/);
    }
  });

  it('reports every release without a key the same way, so state decides what comes next', () => {
    // MPC refused the payment, CKD failed after the payment was recorded, a callback panicked
    // after the payment was recorded: logs can't tell these apart reliably; get_purchase can.
    const cases = [
      tx('unlock', { SuccessValue: b64({ error: 'MPC verified a different payload' }) }, []),
      tx('unlock', { SuccessValue: b64({ error: 'MPC did not release the key; call reopen' }) }, [
        { executor: CONTRACT, logs: [verified] },
      ]),
      tx('unlock', panic('callback failed'), [
        { executor: CONTRACT, logs: [verified] },
        { executor: CONTRACT, logs: [], status: panic('callback failed') },
      ]),
      tx('reopen', panic('only the seller or a buyer can reopen'), []),
    ];
    for (const t of cases) expect(readOutcome(t, CONTRACT).state).toBe('not_released');
    expect(readOutcome(cases[3], CONTRACT)).toMatchObject({
      reason: 'only the seller or a buyer can reopen',
    });
  });

  it('keeps events only from successful receipts of the trusted contract', () => {
    const o = readOutcome(
      tx('unlock', { SuccessValue: b64({ error: 'x' }) }, [
        { executor: 'evil.near', logs: [verified] },
        { executor: CONTRACT, logs: [verified], status: panic('rolled back') },
        { executor: CONTRACT, logs: [released], status: { SuccessReceiptId: 'R' } },
      ]),
      CONTRACT,
    );
    expect(o.events.map((e) => e.event)).toEqual(['key_released']);
  });

  it('reads other calls as done or refused', () => {
    expect(readOutcome(tx('stop_sales', ok, []), CONTRACT)).toMatchObject({
      state: 'done',
      value: null,
    });
    expect(readOutcome(tx('stop_sales', panic('file taken down'), []), CONTRACT)).toMatchObject({
      state: 'refused',
      reason: 'file taken down',
    });
  });

  it('reports an unfinished transaction as pending', () => {
    for (const s of ['NotStarted', 'Started']) {
      expect(readOutcome(tx('unlock', s, []), CONTRACT).state).toBe('pending');
    }
  });

  it('refuses what it cannot read as one call to the trusted contract', () => {
    const codeOf = (t: unknown, e?: { txHash: string; signer: string }) => {
      try {
        readOutcome(t, CONTRACT, e);
        return 'read';
      } catch (err) {
        return err instanceof NearError ? err.code : 'crashed';
      }
    };
    const good = tx('unlock', { SuccessValue: b64(answer) }, []);
    expect(codeOf(tx('unlock', { SuccessValue: b64(answer) }, [], 'other.near'))).toBe('transport');
    expect(codeOf(tx(['storage_deposit', 'unlock'], ok, []))).toBe('transport');
    expect(codeOf(tx('unlock', {}, []))).toBe('transport');
    expect(codeOf(tx('unlock', 42, []))).toBe('transport');
    expect(codeOf(good, { txHash: 'OtherHash', signer: 'relayer.annon.defdone.near' })).toBe(
      'transport',
    );
    expect(codeOf(good, { txHash: 'TxHash', signer: 'someone.near' })).toBe('transport');
    expect(codeOf(good, { txHash: 'TxHash', signer: 'relayer.annon.defdone.near' })).toBe('read');
  });
});

describe('views', () => {
  afterEach(() => vi.unstubAllGlobals());
  // Answers with the request's own JSON-RPC id unless told otherwise.
  const respond = (body: unknown, id?: string) =>
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: { body: string }) => ({
        json: async () =>
          body === null ? null : { id: id ?? JSON.parse(init.body).id, ...(body as object) },
      })),
    );
  const bytes = (v: unknown) => [...Buffer.from(JSON.stringify(v))];
  const codeOf = (p: Promise<unknown>) =>
    p.then(
      () => 'ok',
      (e: NearError) => e.code,
    );
  it('reads get_config and refuses an answer that is not what the contract returns', async () => {
    const config = {
      mpc: 'v1.signer',
      ckd_domain: 2,
      foreign_tx_domain: 3,
      usdc: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
    };
    respond({ result: { result: bytes(config) } });
    expect(await getConfig('https://rpc', CONTRACT)).toEqual({
      mpc: 'v1.signer',
      ckdDomain: 2,
      foreignTxDomain: 3,
      usdc: config.usdc,
    });
    for (const bad of [
      { ...config, mpc: 'Not An Account' },
      { ...config, ckd_domain: '2' },
      { ...config, foreign_tx_domain: 1.5 },
      { ...config, usdc: '0x833589FCD6EDB6E08F4C7C32D4F71B54BDA02913' },
      { ...config, usdc: `0x${'83'.repeat(19)}` },
      { ...config, usdc: undefined },
      null,
    ]) {
      respond({ result: { result: bytes(bad) } });
      expect(await codeOf(getConfig('https://rpc', CONTRACT))).toBe('transport');
    }
  });

  it("txOutcome passes the expected call on, so a relayer can't answer with another", async () => {
    const args = { args: { file_id: '0x11', deadline: 1 }, sig: '0xab' };
    const sent = tx('stop_sales', { SuccessValue: '' }, []);
    sent.transaction.actions[0] = { FunctionCall: { method_name: 'stop_sales', args: b64(args) } };
    respond({ result: sent });
    const read = (call: { method: string; args: unknown }) =>
      txOutcome('https://rpc', 'TxHash', 'relayer.annon.defdone.near', CONTRACT, 'FINAL', call);
    expect((await read({ method: 'stop_sales', args })).state).toBe('done');
    respond({ result: sent });
    expect(await codeOf(read({ method: 'reopen', args }))).toBe('transport');
  });

  it('tells a contract panic from a transport failure', async () => {
    respond({ result: { error: 'wasm execution failed: file_id must be 32 bytes of hex' } });
    expect(await codeOf(view('https://rpc', CONTRACT, 'get_file', {}))).toBe('refused');
    respond({ error: { cause: { name: 'CONTRACT_EXECUTION_ERROR', info: {} } } });
    expect(await codeOf(view('https://rpc', CONTRACT, 'get_file', {}))).toBe('refused');
    respond({ error: { cause: { name: 'UNKNOWN_BLOCK' } } });
    expect(await codeOf(view('https://rpc', CONTRACT, 'get_file', {}))).toBe('transport');
    respond(null);
    expect(await codeOf(view('https://rpc', CONTRACT, 'get_file', {}))).toBe('transport');
    respond({ result: { result: bytes(true) } }, 'annon-0');
    expect(await codeOf(view('https://rpc', CONTRACT, 'get_file', {}))).toBe('transport');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline');
      }),
    );
    expect(await codeOf(view('https://rpc', CONTRACT, 'get_file', {}))).toBe('transport');
  });
});

describe('draft-3 authoritative texts', () => {
  const cases = JSON.parse(
    readFileSync(new URL('../../../../specs/vectors/texts.json', import.meta.url), 'utf8'),
  ).cases as {
    kind: string;
    contractId: string;
    args: unknown;
    seller: Identity;
    text: string;
    id: string;
  }[];
  for (const v of cases)
    it(v.id, () => {
      const text =
        v.kind === 'register'
          ? registerText(v.contractId, v.args as RegisterArgs)
          : v.kind === 'reopen'
            ? reopenText(v.args as ReopenV2)
            : v.kind === 'reopen_seller'
              ? reopenSellerText(v.contractId, v.args as SellerArgs, v.seller)
              : stopSalesText(v.contractId, v.args as SellerArgs, v.seller);
      expect(text).toBe(v.text);
      expect(text).not.toContain('\nnetwork:');
      expect(text.endsWith('\n')).toBe(false);
    });
});
