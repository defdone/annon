import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { must, purchase, terms } from '../../test/fixtures.js';
import { canonicalRequest, contractArgs } from '../relay/relay.js';
import { utc } from '../settle-near/codec.js';
import type { Identity } from '../settle-near/identity.js';
import type { ReopenV2 } from '../settle-near/purchase.js';
import { buildPurchaseMessage, encodePurchase } from '../settle-near/purchase.js';
import { encodeTerms, termsHash } from '../settle-near/terms.js';
import {
  getConfig,
  getFile,
  getPurchase,
  NearError,
  readOutcome,
  rpcReply,
  txOutcome,
  view,
} from './rpc.js';
import {
  type FileFundingArgs,
  fileFundingText,
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

  it('checks the exact attached deposit only when requested, including refusals', () => {
    const expected = {
      txHash: 'TxHash',
      signer: 'relayer.annon.defdone.near',
      method: 'storage_deposit',
      args: { account_id: 'seller.synthetic.near' },
    };
    for (const status of [ok, panic('refused')]) {
      const sent = tx('storage_deposit', status, []);
      const call = { method_name: expected.method, args: b64(expected.args), deposit: '1000' };
      sent.transaction.actions[0] = { FunctionCall: call };
      const state = status === ok ? 'done' : 'refused';
      expect(readOutcome(sent, CONTRACT, expected).state).toBe(state);
      expect(readOutcome(sent, CONTRACT, { ...expected, deposit: '1000' }).state).toBe(state);
      for (const deposit of ['1', '0', '01000', 1000, undefined]) {
        Object.assign(call, { deposit });
        expect(() => readOutcome(sent, CONTRACT, { ...expected, deposit: '1000' })).toThrow(
          /another deposit/,
        );
        expect(readOutcome(sent, CONTRACT, expected).state).toBe(state);
      }
    }
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
      network: 'near:mainnet',
      near_usdc: 'usdc.near',
      intents: 'intents.near',
      mpc: 'v1.signer',
      ckd_domain: 2,
      foreign_tx_domain: 3,
      usdc: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
    };
    respond({ result: { result: bytes(config) } });
    expect(await getConfig('https://rpc', CONTRACT)).toEqual({
      mpc: 'v1.signer',
      network: 'near:mainnet',
      nearUsdc: 'usdc.near',
      intents: 'intents.near',
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

  it.each(['done', 'refused'] as const)(
    'binds a candidate %s outcome to the transaction inclusion block at the checkpoint',
    async (state) => {
      const sent = {
        ...tx('storage_deposit', state === 'done' ? ok : panic('refused'), []),
        transaction_outcome: { block_hash: 'included-block' },
      };
      const functionCall = { method_name: 'storage_deposit', args: b64({}), deposit: '1000' };
      sent.transaction.actions[0] = { FunctionCall: functionCall };
      let timestamp: unknown = '10000000000';
      const fetcher = vi.fn(async (_url: unknown, options?: RequestInit) => {
        const request = JSON.parse(String(options?.body));
        if (request.method === 'EXPERIMENTAL_tx_status')
          return Response.json({ id: request.id, result: sent });
        expect(request.method).toBe('block');
        expect(request.params).toEqual({ block_id: 'included-block' });
        return Response.json({
          id: request.id,
          result: { header: { timestamp_nanosec: timestamp } },
        });
      });
      vi.stubGlobal('fetch', fetcher);
      const read = (notBefore?: number) =>
        txOutcome('https://rpc', 'TxHash', 'relayer.annon.defdone.near', CONTRACT, 'FINAL', {
          method: 'storage_deposit',
          args: {},
          deposit: '1000',
          ...(notBefore === undefined ? {} : { notBefore }),
        });
      expect((await read(10)).state).toBe(state);
      timestamp = '9999999999';
      await expect(read(10)).rejects.toMatchObject({ code: 'transport' });
      for (const malformed of [undefined, 'bad', '-1', '01', 10000000000]) {
        timestamp = malformed;
        await expect(read(10)).rejects.toMatchObject({ code: 'transport' });
      }
      // Existing callers need no inclusion block read.
      fetcher.mockClear();
      expect((await read()).state).toBe(state);
      expect(fetcher).toHaveBeenCalledTimes(1);
    },
  );
});

describe('draft-3 authoritative texts', () => {
  const cases = JSON.parse(
    readFileSync(new URL('../../../../specs/vectors/texts.json', import.meta.url), 'utf8'),
  ).cases as {
    kind: string;
    network?: string;
    contractId: string;
    args: unknown;
    seller: Identity;
    text: string;
    id: string;
  }[];
  for (const v of cases)
    it(v.id, () => {
      const text =
        v.kind === 'fund_file_storage'
          ? fileFundingText({
              ...(v.args as FileFundingArgs),
              network: v.network ?? '',
              contract: v.contractId,
              seller: v.seller,
            })
          : v.kind === 'register'
            ? registerText(v.contractId, v.args as RegisterArgs)
            : v.kind === 'reopen'
              ? reopenText(v.args as ReopenV2)
              : v.kind === 'reopen_seller'
                ? reopenSellerText(v.contractId, v.args as SellerArgs, v.seller)
                : stopSalesText(v.contractId, v.args as SellerArgs, v.seller);
      expect(text).toBe(v.text);
      if (v.kind !== 'fund_file_storage') expect(text).not.toContain('\nnetwork:');
      expect(text.endsWith('\n')).toBe(false);
    });
});

it('names an RPC rate limit (429 without a request id) instead of a foreign reply', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Response.json(
        { jsonrpc: '2.0', error: { code: -429, message: 'Rate limits exceeded' } },
        { status: 429 },
      ),
    ),
  );
  await expect(view('https://rpc.example', 'annon.near', 'get_config', {})).rejects.toThrow(
    /rate limited/,
  );
  vi.unstubAllGlobals();
});

it.each([401, 403, 500, 503, 429])(
  'reports HTTP %s before parsing or checking a request id',
  async (status) => {
    for (const body of ['not JSON', JSON.stringify({ error: { message: 'unauthorized' } })]) {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response(body, { status })),
      );
      await expect(view('https://rpc.example', 'annon.near', 'get_config', {})).rejects.toThrow(
        status === 429 ? /NEAR RPC HTTP 429.*rate limited/ : `NEAR RPC HTTP ${status}`,
      );
    }
  },
);

it.each([
  [400, 'REQUEST_VALIDATION_ERROR', 'PENDING'],
  [400, 'REQUEST_VALIDATION_ERROR', 'NOT_OBSERVED'],
  [400, 'HANDLER_ERROR', 'DOES_NOT_TRACK_SHARD'],
  [408, 'TIMEOUT_ERROR', 'TIMEOUT_ERROR'],
  [500, 'INTERNAL_ERROR', 'INTERNAL_ERROR'],
] as const)('preserves a structured HTTP %s RPC error (%s / %s)', async (status, name, cause) => {
  const error = { name, cause: { name: cause, info: { detail: 'keep this' } } };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url, init) =>
      Response.json({ jsonrpc: '2.0', id: JSON.parse(String(init?.body)).id, error }, { status }),
    ),
  );
  await expect(rpcReply('https://rpc.example', 'tx', {})).resolves.toEqual({
    jsonrpc: '2.0',
    id: expect.any(String),
    error,
  });
});

it('checks the request id on a structured non-2xx RPC reply', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Response.json(
        { jsonrpc: '2.0', id: 'foreign', error: { name: 'INTERNAL_ERROR' } },
        { status: 500 },
      ),
    ),
  );
  await expect(rpcReply('https://rpc.example', 'tx', {})).rejects.toThrow('another request');
});

it('names any HTTP 429 as rate limited, even with a JSON-RPC body that lacks the request id', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Response.json({ jsonrpc: '2.0', error: { code: -32000, message: 'busy' } }, { status: 429 }),
    ),
  );
  await expect(view('https://rpc.example', 'annon.near', 'get_config', {})).rejects.toThrow(
    /rate limited/,
  );
  vi.unstubAllGlobals();
});

it('refuses a multi-action registration and funding batch', () => {
  const file = `0x${'12'.repeat(32)}`;
  const key = `0x${'34'.repeat(48)}`;
  const args = { args: { terms: { file_id: file }, seller_key: key } };
  const result = tx(['register', 'fund_file_storage'], ok, [
    {
      executor: CONTRACT,
      logs: [event('key_released', { file_id: file, key, reason: 'register' })],
      status: { SuccessValue: b64(answer) },
    },
  ]);
  must(result.transaction.actions[0]).FunctionCall.args = b64(args);
  must(result.transaction.actions[1]).FunctionCall.args = b64({
    file_id: file,
    amount: '50000000000000000000000',
  });
  expect(() => readOutcome(result, CONTRACT)).toThrow(/single function call/);
});

it('binds a single register action while allowing only a valid relayer budget injection', () => {
  const args = {
    args: { terms: { file_id: 'test' }, seller_key: 'test', deadline: 1 },
    auth: { kind: 'evm', sig: 'test' },
  };
  const result = tx(['register'], ok, []);
  must(result.transaction.actions[0]).FunctionCall.args = b64({
    ...args,
    args: { ...args.args, file_budget: '5' },
  });
  const expected = { txHash: 'H', signer: 'buyer.near', method: 'register', args };
  expected.txHash = result.transaction.hash;
  expected.signer = result.transaction.signer_id;
  expect(() => readOutcome(result, CONTRACT, expected)).not.toThrow();
  for (const file_budget of ['0', '-1', 'invalid', (2n ** 128n).toString()]) {
    must(result.transaction.actions[0]).FunctionCall.args = b64({
      ...args,
      args: { ...args.args, file_budget },
    });
    expect(() => readOutcome(result, CONTRACT, expected)).toThrow();
  }
  must(result.transaction.actions[0]).FunctionCall.args = b64({
    ...args,
    args: { ...args.args, file_budget: '5', deadline: 2 },
  });
  expect(() => readOutcome(result, CONTRACT, expected)).toThrow();
});

const rpc = (value: unknown) => {
  const fetch = vi.fn(async (_url, init) => {
    const q = JSON.parse(init.body);
    return {
      json: async () => ({
        id: q.id,
        result:
          q.params.request_type === 'view_access_key'
            ? value
            : { result: [...new TextEncoder().encode(JSON.stringify(value))] },
      }),
    };
  });
  vi.stubGlobal('fetch', fetch);
  return fetch;
};
afterEach(() => vi.unstubAllGlobals());
describe('contract wire shapes', () => {
  it('wraps unlock args with the canonical message and nullable header; omitted claim grant canonicalizes to zero', () => {
    const args = { purchase: buildPurchaseMessage(purchase), logs: [], header: null };
    // Logs are validated separately; this checks the transaction shape.
    expect(contractArgs({ method: 'unlock', args })).toEqual({ args });
    expect(canonicalRequest({ method: 'claim_key', args: { purchase_id: terms.file_id } })).toEqual(
      { method: 'claim_key', args: { purchase_id: terms.file_id, grant: 0 } },
    );
    expect(() => canonicalRequest({ method: 'unlock', args: { ...args, purchase } })).toThrow();
  });
  it('reads terms through get_file and validates its commitment', async () => {
    const f = {
      terms,
      terms_hash: termsHash(terms),
      header_hash: null,
      sales_stopped_at: null,
      taken_down: null,
    };
    const fetch = rpc(f);
    expect((await getFile('https://rpc', terms.contract, terms.file_id))?.terms).toEqual(terms);
    expect(JSON.parse(fetch.mock.calls[0]?.[1].body).params.method_name).toBe('get_file');
    rpc({ ...f, terms_hash: terms.cipher_hash });
    await expect(getFile('https://rpc', terms.contract, terms.file_id)).rejects.toMatchObject({
      code: 'transport',
    });
  });
  it('validates all purchase view fields', async () => {
    const p = {
      purchase_id: terms.file_id,
      file_id: terms.file_id,
      terms_hash: termsHash(terms),
      buyer_key: purchase.buyer_key,
      recovery: purchase.recovery,
      route: 'base-usdc',
      delivery: null,
      accepted_at: 1800000000,
      grants: 1,
    };
    rpc(p);
    expect(await getPurchase('https://rpc', terms.contract, p.purchase_id)).toEqual(p);
    for (const bad of [
      { ...p, route: 'other' },
      { ...p, accepted_at: -1 },
      { ...p, delivery: '0' },
      { ...p, grants: 2 ** 32 },
      { ...p, route: 'near-usdc' },
    ]) {
      rpc(bad);
      await expect(getPurchase('https://rpc', terms.contract, p.purchase_id)).rejects.toMatchObject(
        { code: 'transport' },
      );
    }
  });
  it('supports configured NEAR tokens on testnet and sandbox and pins mainnet', () => {
    for (const network of ['near:testnet', 'near:sandbox']) {
      const t = { ...terms, network, near: { ...terms.near, token: 'usdc.fakes.testnet' } };
      expect(encodeTerms(t).length).toBeGreaterThan(0);
      expect(() => encodeTerms(t, { nearUsdc: 'other.testnet' })).toThrow();
      expect(
        encodePurchase({ ...purchase, route: 'near-usdc', network, asset: t.near.token }).length,
      ).toBeGreaterThan(0);
    }
    expect(() => encodeTerms({ ...terms, near: { ...terms.near, token: 'fake.near' } })).toThrow();
  });
  it('pins a configured Base asset when supplied', () => {
    const baseUsdc = `0x${'55'.repeat(20)}`;
    const p = { ...purchase, asset: baseUsdc };
    expect(() => encodePurchase(p)).toThrow();
    expect(encodePurchase(p, { baseUsdc }).length).toBeGreaterThan(0);
    expect(() => encodePurchase({ ...p, network: 'near:mainnet' }, { baseUsdc })).toThrow();
    expect(() => encodePurchase({ ...p, asset: baseUsdc.toUpperCase() }, { baseUsdc })).toThrow();
  });
  it('formats deadlines beyond Date and through u64 max like Rust', () => {
    expect(utc(253402300800)).toBe('10000-01-01 00:00:00 UTC');
    expect(utc(18446744073709551615n)).toBe('584554051223-11-09 07:00:15 UTC');
  });
});

it('classifies absent access keys as refusal, never as a retryable transport failure', async () => {
  const { isFullAccessKey } = await import('./rpc.js');
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_u, init) => {
      const q = JSON.parse(String(init?.body));
      return {
        json: async () => ({
          id: q.id,
          error: { cause: { name: 'UNKNOWN_ACCESS_KEY', info: {} } },
        }),
      };
    }),
  );
  await expect(
    isFullAccessKey('https://rpc', 'buyer.near', 'ed25519:missing'),
  ).rejects.toMatchObject({ code: 'refused' });
});

it('pins get_file to a requested cutover block and keeps validation', async () => {
  const fetch = vi.fn(async (_url: unknown, init: RequestInit | undefined) => {
    const q = JSON.parse(String(init?.body));
    return Response.json({
      id: q.id,
      result: {
        result: [
          ...Buffer.from(
            JSON.stringify({
              terms,
              terms_hash: termsHash(terms),
              header_hash: null,
              sales_stopped_at: null,
              taken_down: null,
            }),
          ),
        ],
      },
    });
  });
  vi.stubGlobal('fetch', fetch);
  expect(
    (await getFile('https://rpc.test', terms.contract, terms.file_id, 'cutover'))?.termsHash,
  ).toBe(termsHash(terms));
  expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body)).params).toMatchObject({
    block_id: 'cutover',
  });
  expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body)).params.finality).toBeUndefined();
});

it('serializes a seller storage request with an exact domain and no trailing newline', async () => {
  const { fileFundingText } = await import('./texts.js');
  expect(
    fileFundingText({
      network: 'near:mainnet',
      contract: 'market.synthetic.near',
      seller: { kind: 'evm', id: `0x${'11'.repeat(20)}` },
      file_id: `0x${'22'.repeat(32)}`,
      amount: '41000000000000000000000',
      nonce: `0x${'33'.repeat(32)}`,
      deadline: 1794528600,
    }),
  ).toBe(
    `Annon: request sponsored file storage\nnetwork: near:mainnet\ncontract: market.synthetic.near\nseller: EVM 0x${'11'.repeat(20)}\nfile: 0x${'22'.repeat(32)}\namount: 41000000000000000000000\nnonce: 0x${'33'.repeat(32)}\nexpires: 1794528600`,
  );
});

it('binds sponsored funding to deployment, registered seller, amount, nonce and expiry', () => {
  const request = {
    network: terms.network,
    contract: terms.contract,
    seller: terms.seller,
    file_id: terms.file_id,
    amount: '41000000000000000000000',
    nonce: `0x${'66'.repeat(32)}`,
    deadline: 1800000600,
  };
  const text = fileFundingText(request);
  expect(text).toContain('Annon: request sponsored file storage\nnetwork: near:mainnet\n');
  expect(text).toContain('\namount: 41000000000000000000000\nnonce: 0x');
  expect(text.endsWith('\n')).toBe(false);
  expect(text).toContain('\nexpires: 1800000600');
  for (const amount of ['0', '-1', '01', '1e3'])
    expect(() => fileFundingText({ ...request, amount })).toThrow();
});

it('classifies only decoded contract storage refusal reasons', async () => {
  const { isStorageRequired } = await import('./rpc.js');
  expect(
    isStorageRequired(
      JSON.stringify({
        ActionError: {
          kind: { FunctionCallError: { ExecutionError: 'not enough prepaid balance' } },
        },
      }),
    ),
  ).toBe(true);
  expect(isStorageRequired('call storage_deposit first')).toBe(true);
  expect(isStorageRequired('network unavailable')).toBe(false);
  expect(isStorageRequired(new Error('not enough prepaid balance'))).toBe(false);
});
