import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getConfig, getFile, isBuyer, isPaymentUsed, NearError, readOutcome, view } from './rpc.js';
import {
  hex0x,
  type RegisterArgs,
  type ReopenArgs,
  registerText,
  reopenText,
  type StopSalesArgs,
  stopSalesText,
  usdc,
  utc,
} from './texts.js';

// Written by the contract's own unit test (contracts/annon/src/register.rs).
const texts = JSON.parse(
  readFileSync(new URL('../../../../specs/vectors/texts.json', import.meta.url), 'utf8'),
) as { cases: { id: string; contractId: string; kind: string; args: unknown; text: string }[] };

describe('signing texts against the contract', () => {
  for (const c of texts.cases) {
    it(`builds ${c.id} exactly as the contract does`, () => {
      const text =
        c.kind === 'register'
          ? registerText(c.contractId, c.args as RegisterArgs)
          : c.kind === 'reopen'
            ? reopenText(c.contractId, c.args as ReopenArgs)
            : stopSalesText(c.contractId, c.args as StopSalesArgs);
      expect(text).toBe(c.text);
    });
  }

  it('refuses what the contract refuses', () => {
    expect(() => hex0x(`0X${'11'.repeat(32)}`, 32, 'file_id')).toThrow(TypeError);
    expect(() => hex0x('11'.repeat(31), 32, 'file_id')).toThrow(TypeError);
    expect(() => usdc(-1n)).toThrow(RangeError);
    expect(() => usdc(2n ** 128n)).toThrow(RangeError);
    expect(() => utc(-1)).toThrow(RangeError);
    expect(() => utc(1.5)).toThrow(RangeError);
  });
});

const CONTRACT = 'v1.annon.defdone.near';
const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64');
const event = (name: string, data: object) =>
  `EVENT_JSON:${JSON.stringify({ standard: 'annon', version: '1.0.0', event: name, data: [data] })}`;
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

  it('reports every release without a key the same way, so state decides what comes next', () => {
    // MPC refused the payment, CKD failed after the payment was recorded, a callback panicked
    // after the payment was recorded: logs can't tell these apart reliably; is_payment_used can.
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
  const file = {
    seller: `0x${'ab'.repeat(20)}`,
    price: '340282366920938463463374607431768211455',
    source: { kind: 'partner' },
    cipher_hash: `0x${'22'.repeat(32)}`,
    moderator: null,
    sales_stopped_at: null,
    taken_down: null,
  };

  it('decodes get_file, with the price as a bigint', async () => {
    respond({ result: { result: bytes(file) } });
    const f = await getFile('https://rpc', CONTRACT, '0x11');
    expect(f?.price).toBe(2n ** 128n - 1n);
    expect(f?.moderator).toBeNull();
    respond({ result: { result: bytes(null) } });
    expect(await getFile('https://rpc', CONTRACT, '0x11')).toBeNull();
  });

  it('reads an x402 listing in whatever hex form it was registered', async () => {
    const payTo = '58DA990A8F4A3A6CA7CB6315D68A140105917352';
    respond({ result: { result: bytes({ ...file, source: { kind: 'x402', pay_to: payTo } }) } });
    const f = await getFile('https://rpc', CONTRACT, '0x11');
    expect(f?.source).toEqual({ kind: 'x402', pay_to: `0x${payTo.toLowerCase()}` });
  });

  it('refuses a get_file answer that is not what the contract returns', async () => {
    for (const bad of [
      { ...file, price: 10000 },
      { ...file, price: '1e6' },
      { ...file, price: '0' },
      { ...file, price: (2n ** 128n).toString() },
      { ...file, moderator: 'Not An Account' },
      { ...file, sales_stopped_at: -1 },
      { ...file, sales_stopped_at: 0 },
      { ...file, seller: '0xAB' },
      { ...file, source: { kind: 'x402' } },
      { ...file, taken_down: 'other' },
      'file',
    ]) {
      respond({ result: { result: bytes(bad) } });
      expect(await codeOf(getFile('https://rpc', CONTRACT, '0x11'))).toBe('transport');
    }
  });

  it('reads get_config and refuses an answer that is not what the contract returns', async () => {
    const config = {
      mpc: 'v1.signer',
      ckd_domain: 2,
      foreign_tx_domain: 3,
      partner_splitter: `0x${'51'.repeat(20)}`,
      usdc: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
    };
    respond({ result: { result: bytes(config) } });
    expect(await getConfig('https://rpc', CONTRACT)).toEqual({
      mpc: 'v1.signer',
      ckdDomain: 2,
      foreignTxDomain: 3,
      partnerSplitter: config.partner_splitter,
      usdc: config.usdc,
    });
    for (const bad of [
      { ...config, mpc: 'Not An Account' },
      { ...config, ckd_domain: '2' },
      { ...config, foreign_tx_domain: 1.5 },
      { ...config, partner_splitter: '0x833589FCD6EDB6E08F4C7C32D4F71B54BDA02913' },
      { ...config, partner_splitter: `0x${'51'.repeat(19)}` },
      { ...config, usdc: undefined },
      null,
    ]) {
      respond({ result: { result: bytes(bad) } });
      expect(await codeOf(getConfig('https://rpc', CONTRACT))).toBe('transport');
    }
  });

  it('accepts only real booleans for is_buyer and is_payment_used', async () => {
    respond({ result: { result: bytes(true) } });
    expect(await isBuyer('https://rpc', CONTRACT, '0x11', '0xab')).toBe(true);
    respond({ result: { result: bytes('false') } });
    expect(await codeOf(isBuyer('https://rpc', CONTRACT, '0x11', '0xab'))).toBe('transport');
    respond({ result: { result: [999] } });
    expect(await codeOf(isPaymentUsed('https://rpc', CONTRACT, '0xaa', 7))).toBe('transport');
  });

  it('sends the method and base64 arguments NEAR expects', async () => {
    respond({ result: { result: bytes(true) } });
    await isBuyer('https://rpc', CONTRACT, '0x11', '0xab');
    const [, init] = vi.mocked(fetch).mock.calls[0] ?? [];
    const body = JSON.parse(String(init?.body));
    expect(body.params).toMatchObject({
      request_type: 'call_function',
      account_id: CONTRACT,
      method_name: 'is_buyer',
      finality: 'final',
    });
    expect(JSON.parse(Buffer.from(body.params.args_base64, 'base64').toString())).toEqual({
      file_id: '0x11',
      wallet: '0xab',
    });
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
    expect(await codeOf(isBuyer('https://rpc', CONTRACT, '0x11', '0xab'))).toBe('transport');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline');
      }),
    );
    expect(await codeOf(view('https://rpc', CONTRACT, 'get_file', {}))).toBe('transport');
  });
});
