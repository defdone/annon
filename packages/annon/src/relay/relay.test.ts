import { readFileSync } from 'node:fs';
import { bls12_381 as bls } from '@noble/curves/bls12-381.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { base58 } from '@scure/base';
import { decodeSignedTransaction, KeyPair } from 'near-api-js';
import { encodeAbiParameters, encodeEventTopics, getAddress, parseAbi } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerText, reopenText, stopSalesText } from '../near/texts.js';
import { paymentLogs } from '../pay/base.js';
import { annonNonce } from '../pay/eip3009.js';
import {
  canonicalRequest,
  checkRelay,
  RelayError,
  type RelayRequest,
  relay,
  relayCounters,
  resetRelayState,
} from './relay.js';

const NEAR = 'https://near.rpc';
const BASE = 'https://base.rpc';
const CONTRACT = 'v1.annon.defdone.near';
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const FILE = `0x${'11'.repeat(32)}`;
const NOW = 1_800_000_000;
const seller = privateKeyToAccount(`0x${'44'.repeat(32)}`);
const buyer = privateKeyToAccount(`0x${'42'.repeat(32)}`);
const stranger = privateKeyToAccount(`0x${'43'.repeat(32)}`);
const SELLER = seller.address.toLowerCase();
const BUYER = buyer.address.toLowerCase();
const PAY_TO = `0x${'5e'.repeat(20)}`;
// One-time keys must be real G1 points: the relayer refuses anything MPC would.
const point = (k: bigint) =>
  `0x${Buffer.from(bls.G1.Point.BASE.multiply(k).toBytes(true)).toString('hex')}`;
const BUYER_KEY = point(7n);
const keyBytes = Uint8Array.from(Buffer.from(BUYER_KEY.slice(2), 'hex'));

// A real Base block: the relayer rebuilds its header and checks it hashes to the log's block.
const headers = JSON.parse(
  readFileSync(new URL('../../../../specs/vectors/base-headers.json', import.meta.url), 'utf8'),
) as { cases: { number: number; hash: string; json: Record<string, string>; rlp: string }[] };
const REAL = headers.cases[0] as (typeof headers.cases)[number];
const TX = `0x${'7a'.repeat(32)}`;

const USDC_ABI = parseAbi([
  'event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
]);
const log = (topics: string[], data: string, i: number) => ({
  address: getAddress(USDC),
  topics,
  data,
  blockNumber: `0x${REAL.number.toString(16)}`,
  blockHash: REAL.hash,
  transactionHash: TX,
  transactionIndex: '0x1',
  logIndex: `0x${i.toString(16)}`,
  removed: false,
});
const receiptFor = (value: bigint, nonce = annonNonce(CONTRACT, FILE, keyBytes)) => ({
  status: '0x1',
  transactionHash: TX,
  logs: [
    log(
      encodeEventTopics({
        abi: USDC_ABI,
        eventName: 'AuthorizationUsed',
        args: { authorizer: buyer.address, nonce: nonce as `0x${string}` },
      }) as string[],
      '0x',
      7,
    ),
    log(
      encodeEventTopics({
        abi: USDC_ABI,
        eventName: 'Transfer',
        args: { from: buyer.address, to: getAddress(PAY_TO) },
      }) as string[],
      encodeAbiParameters([{ type: 'uint256' }], [value]),
      8,
    ),
  ],
});
const LOGS = paymentLogs(receiptFor(10_000n), {
  usdc: USDC,
  to: PAY_TO,
  from: BUYER,
  nonce: annonNonce(CONTRACT, FILE, keyBytes),
  price: 10_000n,
});
if (!LOGS) throw new Error('fixture: no payment logs');

/** How send_tx answers without landing the transaction (see NEAR's RPC error guide). */
type Busy =
  | 'timeout'
  | 'oldTimeout'
  | 'congested'
  | 'stuck'
  | 'internal'
  | 'untracked'
  | 'pending'
  | 'later'
  | 'elsewhere'
  | 'badSignature';
type World = {
  file: Record<string, unknown> | null;
  buyers: string[];
  paymentUsed: boolean;
  receipt: unknown;
  safe: number;
  nearError?: boolean;
  calls: string[];
  sent: string[];
  /** Delays send_tx answers, to see that sends never interleave. */
  sendDelay?: number;
  /** The sender's prepaid storage on the contract, yoctoNEAR. */
  storage: string | null;
  /** Nonces of the transactions sent. */
  nonces: bigint[];
  /** The access key's nonce on chain. */
  akNonce: number;
  /** send_tx answers 502 (a gateway lost NEAR's answer). */
  gatewayDown?: boolean;
  /** How many sends NEAR refuses with InvalidNonce (another sender used the key). */
  nonceRefusals?: number;
  /** NEAR refuses every send: the key's gas allowance is spent. */
  refuseAllowance?: boolean;
  /** NEAR refuses every send with the string form `"Expired"`. */
  refuseExpired?: boolean;
  /** The transaction status RPC finds every transaction in a block. */
  seen?: boolean;
  /** Hashes of the transactions in a block. */
  landed: string[];
  /** send_tx lands the transaction, then answers 500 (NEAR's answer lost on the way back). */
  landThenLose?: boolean;
  /** The transaction status RPC answers 502. */
  statusDown?: boolean;
  /** send_tx lands the transaction, then answers ShardCongested from a later check. */
  landThenRefuse?: boolean;
  /** send_tx never answers. */
  sendHang?: boolean;
  /** storage_balance_of answers an RPC error. */
  storageDown?: boolean;
  /** Transaction status answers `result: null`. */
  statusNull?: boolean;
  /** send_tx answers `result: null` without landing the transaction. */
  sendNull?: boolean;
  /** These calls get a convincing reply to another request (another id) instead of their own. */
  wrongId?: string[];
  /** What the next sends answer without landing, one per send. */
  busy?: Busy[];
  /** Transaction status lookups answer this error: the node doesn't track the shard (as an error or
   * a timeout), or failed internally. */
  statusError?: 'untracked' | 'untrackedTimeout' | 'internal' | 'parse';
  /** How many transaction status lookups answer 502 before the RPC recovers. */
  statusFailures?: number;
  /** The transaction status RPC knows every transaction, not yet in a block (`NONE`). */
  statusNone?: boolean;
};
let w: World;
const fileView = (over: Record<string, unknown> = {}) => ({
  seller: SELLER,
  price: '10000',
  pay_to: PAY_TO,
  cipher_hash: `0x${'22'.repeat(32)}`,
  moderator: null,
  sales_stopped_at: null,
  taken_down: null,
  ...over,
});
beforeEach(() => {
  w = {
    file: fileView(),
    buyers: [BUYER],
    paymentUsed: false,
    receipt: receiptFor(10_000n),
    safe: REAL.number,
    calls: [],
    sent: [],
    storage: (10n ** 24n).toString(),
    nonces: [],
    akNonce: 5,
    landed: [],
  };
  resetRelayState();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: { body: string; signal?: AbortSignal }) => {
      const b = JSON.parse(init.body);
      const reply = (result: unknown) =>
        new Response(JSON.stringify({ jsonrpc: '2.0', id: b.id, result }));
      if (url === NEAR) {
        w.calls.push(
          b.method === 'query'
            ? `near:${b.params.method_name ?? b.params.request_type}`
            : `near:${b.method}`,
        );
        const call = b.method === 'query' ? b.params.request_type : b.method;
        const other = { jsonrpc: '2.0', id: 'someone-else' };
        if (call !== 'send_tx' && w.wrongId?.includes(call)) {
          const forged =
            call === 'tx'
              ? { error: { name: 'HANDLER_ERROR', cause: { name: 'UNKNOWN_TRANSACTION' } } }
              : { result: { nonce: 999, permission: 'FullAccess' } };
          return new Response(JSON.stringify({ ...other, ...forged }));
        }
        if (w.nearError)
          return new Response(
            JSON.stringify({ jsonrpc: '2.0', id: b.id, error: { message: 'down' } }),
          );
        if (b.method === 'block')
          return reply({ header: { hash: '11111111111111111111111111111111', height: 10 } });
        if (b.method === 'tx' || b.method === 'EXPERIMENTAL_tx_status') {
          // The transaction's status: in a block only when the test says so.
          if (w.statusDown) return new Response('bad gateway', { status: 502 });
          if (w.statusError)
            return new Response(
              JSON.stringify({
                jsonrpc: '2.0',
                id: b.id,
                error: {
                  name: 'HANDLER_ERROR',
                  code: -32000,
                  message: 'Server error',
                  ...{
                    untracked: { cause: { name: 'DOES_NOT_TRACK_SHARD', info: {} } },
                    untrackedTimeout: {
                      cause: { name: 'TIMEOUT_ERROR', info: { cause: 'DOES_NOT_TRACK_SHARD' } },
                    },
                    internal: {
                      name: 'INTERNAL_ERROR',
                      data: 'db busy',
                      message: 'Internal error',
                    },
                    parse: {
                      name: 'REQUEST_VALIDATION_ERROR',
                      cause: { name: 'PARSE_ERROR', info: {} },
                    },
                  }[w.statusError],
                },
              }),
            );
          if (w.statusFailures) {
            w.statusFailures--;
            return new Response('bad gateway', { status: 502 });
          }
          if (w.statusNone)
            return reply({
              final_execution_status: 'NONE',
              status: 'NotStarted',
              transaction: {},
              transaction_outcome: {},
              receipts_outcome: [],
            });
          if (w.statusNull) return reply(null);
          // As mainnet answers: NONE gives the status now or "unknown transaction"; a wait for a
          // status not reached times out.
          const want = b.params.wait_until;
          const inBlock = w.seen || w.landed.includes(b.params.tx_hash);
          const now = inBlock ? 'INCLUDED' : null;
          const order = ['NONE', 'INCLUDED', 'FINAL'];
          if (!now || order.indexOf(now) < order.indexOf(want)) {
            const cause =
              !now && want === 'NONE'
                ? {
                    name: 'UNKNOWN_TRANSACTION',
                    info: { requested_transaction_hash: b.params.tx_hash },
                  }
                : { name: 'TIMEOUT_ERROR', info: { cause: 'NOT_OBSERVED' } };
            return new Response(
              JSON.stringify({
                jsonrpc: '2.0',
                id: b.id,
                error: { name: 'HANDLER_ERROR', cause, code: -32000, message: 'Server error' },
              }),
            );
          }
          return reply({
            final_execution_status: now,
            status: { SuccessValue: '' },
            transaction: {},
            transaction_outcome: {},
            receipts_outcome: [],
          });
        }
        if (b.method === 'send_tx') {
          w.sent.push(b.params.signed_tx_base64);
          const tx = decodeSignedTransaction(
            Buffer.from(b.params.signed_tx_base64, 'base64'),
          ).transaction;
          w.nonces.push(tx.nonce);
          if (w.wrongId?.includes('send_tx'))
            return new Response(
              JSON.stringify({ ...other, result: { final_execution_status: 'INCLUDED' } }),
            );
          if (w.sendDelay) await new Promise((r) => setTimeout(r, w.sendDelay));
          if (w.sendHang)
            // As fetch does: no answer, until the caller aborts.
            await new Promise((_, no) =>
              init.signal?.addEventListener('abort', () => no(init.signal?.reason)),
            );
          if (w.gatewayDown) return new Response('bad gateway', { status: 502 });
          if (w.sendNull) return reply(null);
          const busy = w.busy?.shift();
          if (busy)
            return new Response(
              JSON.stringify({
                jsonrpc: '2.0',
                id: b.id,
                error: {
                  name: 'HANDLER_ERROR',
                  code: -32000,
                  message: 'Server error',
                  ...(busy === 'timeout'
                    ? { cause: { name: 'TIMEOUT_ERROR', info: { cause: 'NOT_OBSERVED' } } }
                    : busy === 'oldTimeout'
                      ? // Nodes before nearcore 2.14 say nothing about how far it got.
                        { cause: { name: 'TIMEOUT_ERROR' } }
                      : busy === 'pending' || busy === 'later' || busy === 'elsewhere'
                        ? {
                            cause: {
                              name: 'TIMEOUT_ERROR',
                              info: {
                                cause: {
                                  pending: 'PENDING',
                                  later: 'ERROR',
                                  elsewhere: 'DOES_NOT_TRACK_SHARD',
                                }[busy],
                              },
                            },
                          }
                        : busy === 'internal'
                          ? { name: 'INTERNAL_ERROR', data: 'db busy', message: 'Internal error' }
                          : busy === 'badSignature'
                            ? {
                                cause: { name: 'INVALID_TRANSACTION', info: {} },
                                data: { TxExecutionError: { InvalidTxError: 'InvalidSignature' } },
                              }
                            : busy === 'untracked'
                              ? { cause: { name: 'DOES_NOT_TRACK_SHARD', info: {} } }
                              : {
                                  cause: { name: 'INVALID_TRANSACTION', info: {} },
                                  data: {
                                    TxExecutionError: {
                                      InvalidTxError:
                                        busy === 'stuck'
                                          ? { ShardStuck: { shard_id: 0, missed_chunks: 6 } }
                                          : {
                                              ShardCongested: { shard_id: 0, congestion_level: 1 },
                                            },
                                    },
                                  },
                                }),
                },
              }),
            );
          if (w.refuseExpired)
            return new Response(
              JSON.stringify({
                jsonrpc: '2.0',
                id: b.id,
                error: {
                  name: 'HANDLER_ERROR',
                  code: -32000,
                  message: 'Server error',
                  cause: { name: 'INVALID_TRANSACTION', info: {} },
                  data: { TxExecutionError: { InvalidTxError: 'Expired' } },
                },
              }),
            );
          if (w.refuseAllowance) {
            return new Response(
              JSON.stringify({
                jsonrpc: '2.0',
                id: b.id,
                error: {
                  name: 'HANDLER_ERROR',
                  code: -32000,
                  message: 'Server error',
                  cause: { name: 'INVALID_TRANSACTION', info: {} },
                  data: {
                    TxExecutionError: {
                      InvalidTxError: {
                        InvalidAccessKeyError: {
                          NotEnoughAllowance: {
                            account_id: 'relayer.annon.defdone.near',
                            allowance: '1',
                            cost: '2',
                            public_key: KeyPair.fromRandom('ed25519').getPublicKey().toString(),
                          },
                        },
                      },
                    },
                  },
                },
              }),
            );
          }
          // NEAR refuses a nonce the key has reached, the transaction's own once it landed.
          const stale = tx.nonce <= BigInt(w.akNonce);
          if (w.nonceRefusals || stale) {
            if (w.nonceRefusals) {
              // Another sender used the key, up to this nonce at least.
              w.nonceRefusals--;
              w.akNonce = Math.max(100, Number(tx.nonce), w.akNonce);
            }
            return new Response(
              JSON.stringify({
                jsonrpc: '2.0',
                id: b.id,
                error: {
                  name: 'HANDLER_ERROR',
                  code: -32000,
                  message: 'Server error',
                  cause: { name: 'INVALID_TRANSACTION', info: {} },
                  data: {
                    TxExecutionError: {
                      InvalidTxError: { InvalidNonce: { ak_nonce: 100, tx_nonce: 6 } },
                    },
                  },
                },
              }),
            );
          }
          w.landed.push(base58.encode(sha256(tx.encode())));
          w.akNonce = Number(tx.nonce);
          if (w.landThenLose) return new Response('internal error', { status: 500 });
          if (w.landThenRefuse) {
            return new Response(
              JSON.stringify({
                jsonrpc: '2.0',
                id: b.id,
                error: {
                  name: 'HANDLER_ERROR',
                  code: -32000,
                  message: 'Server error',
                  cause: { name: 'INVALID_TRANSACTION', info: {} },
                  data: {
                    TxExecutionError: {
                      InvalidTxError: { ShardCongested: { shard_id: 0, congestion_level: 1 } },
                    },
                  },
                },
              }),
            );
          }
          return reply({ final_execution_status: 'INCLUDED' });
        }
        if (b.params.request_type === 'view_access_key') {
          return reply({
            nonce: w.akNonce,
            permission: 'FullAccess',
            block_hash: '11111111111111111111111111111111',
            block_height: 10,
          });
        }
        if (w.storageDown && b.params.method_name === 'storage_balance_of')
          return new Response(
            JSON.stringify({ jsonrpc: '2.0', id: b.id, error: { message: 'storage down' } }),
          );
        const args = JSON.parse(Buffer.from(b.params.args_base64, 'base64').toString());
        const views: Record<string, unknown> = {
          get_file: args.file_id === FILE ? w.file : null,
          is_buyer: w.buyers.includes(args.wallet),
          is_payment_used: w.paymentUsed,
          storage_balance_of: w.storage,
        };
        return reply({
          result: [...Buffer.from(JSON.stringify(views[b.params.method_name] ?? null))],
        });
      }
      w.calls.push(`base:${b.method}`);
      if (b.method === 'eth_getTransactionReceipt')
        return reply(b.params[0] === TX ? w.receipt : null);
      if (b.method === 'eth_getBlockByNumber') {
        // `safe` is the tag; a number is the payment's own block, with its real timestamp.
        if (b.params[0] === 'safe')
          return reply({ number: `0x${w.safe.toString(16)}`, timestamp: '0x1' });
        return reply({ number: b.params[0], timestamp: REAL.json.timestamp });
      }
      if (b.method === 'eth_getBlockByHash') {
        const c = headers.cases.find((h) => h.hash === b.params[0]);
        return reply(c ? { ...c.json, hash: c.hash } : null);
      }
      throw new Error(`unexpected ${b.method}`);
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

const opts = (over: Record<string, unknown> = {}) => ({
  nearRpc: NEAR,
  baseRpc: BASE,
  contractId: CONTRACT,
  usdc: USDC,
  policy: { minPrice: 10_000n, maxDeadlineSeconds: 600 },
  now: NOW,
  ...over,
});
const check = async (r: unknown, o: Parameters<typeof checkRelay>[1]) =>
  checkRelay(canonicalRequest(r), o);
const codeOf = (p: Promise<unknown>) =>
  p.then(
    () => 'ok',
    (e: unknown) =>
      e instanceof RelayError ? e.code : `${(e as Error).name}: ${(e as Error).message}`,
  );

const registerArgs = (over: Record<string, unknown> = {}) => ({
  file_id: FILE,
  seller: SELLER,
  price: '10000',
  pay_to: PAY_TO,
  cipher_hash: `0x${'22'.repeat(32)}`,
  moderator: null,
  seller_key: point(8n),
  deadline: NOW + 300,
  ...over,
});
const register = async (over: Record<string, unknown> = {}, signer = seller) => {
  const args = registerArgs(over);
  return {
    method: 'register',
    args,
    sig: await signer.signMessage({ message: registerText(CONTRACT, args) }),
  } as RelayRequest;
};
const reopen = async (signer = buyer, over: Record<string, unknown> = {}) => {
  const args = {
    file_id: FILE,
    wallet: signer.address.toLowerCase(),
    key: point(9n),
    deadline: NOW + 300,
    ...over,
  };
  return {
    method: 'reopen',
    args,
    sig: await signer.signMessage({ message: reopenText(CONTRACT, args) }),
  } as RelayRequest;
};
const stop = async (signer = seller) => {
  const args = { file_id: FILE, deadline: NOW + 300 };
  return {
    method: 'stop_sales',
    args,
    sig: await signer.signMessage({ message: stopSalesText(CONTRACT, args) }),
  } as RelayRequest;
};
const unlock = (over: Record<string, unknown> = {}) =>
  ({
    method: 'unlock',
    args: { file_id: FILE, buyer_key: BUYER_KEY, logs: LOGS, header: REAL.rlp, ...over },
  }) as RelayRequest;

describe('checkRelay: register', () => {
  it('accepts a listing signed by its seller, within the deadline and price the operator sponsors', async () => {
    w.file = null;
    expect(await codeOf(check(await register(), opts()))).toBe('ok');
  });

  it("refuses anyone else's signature, a stale or far deadline, a low price, an unlisted seller, a taken id", async () => {
    w.file = null;
    expect(await codeOf(check(await register({}, stranger), opts()))).toBe('bad_signature');
    expect(await codeOf(check(await register({ deadline: NOW - 1 }), opts()))).toBe('bad_deadline');
    expect(await codeOf(check(await register({ deadline: NOW + 601 }), opts()))).toBe(
      'bad_deadline',
    );
    expect(await codeOf(check(await register({ price: '9999' }), opts()))).toBe('not_sponsored');
    const only = opts({
      policy: { minPrice: 1n, maxDeadlineSeconds: 600, sellerAllowed: (s: string) => s === BUYER },
    });
    expect(await codeOf(check(await register(), only))).toBe('not_sponsored');
    const tampered = (await register()) as Extract<RelayRequest, { method: 'register' }>;
    expect(
      await codeOf(
        check({ ...tampered, args: { ...tampered.args, pay_to: `0x${'66'.repeat(20)}` } }, opts()),
      ),
    ).toBe('bad_signature');
    expect(await codeOf(check({ ...tampered, sig: '0x12' }, opts()))).toBe('bad_request');
    w.file = fileView();
    expect(await codeOf(check(await register(), opts()))).toBe('already_registered');
  });
});

describe('checkRelay: reopen and stop_sales', () => {
  it('reopens for a buyer or the seller, nobody else, and never a taken-down file', async () => {
    expect(await codeOf(check(await reopen(), opts()))).toBe('ok');
    expect(await codeOf(check(await reopen(seller), opts()))).toBe('ok');
    expect(await codeOf(check(await reopen(stranger), opts()))).toBe('not_buyer');
    const forged = (await reopen()) as Extract<RelayRequest, { method: 'reopen' }>;
    expect(
      await codeOf(check({ ...forged, args: { ...forged.args, wallet: SELLER } }, opts())),
    ).toBe('bad_signature');
    w.file = fileView({ taken_down: 'court_order' });
    expect(await codeOf(check(await reopen(), opts()))).toBe('taken_down');
    w.file = null;
    expect(await codeOf(check(await reopen(), opts()))).toBe('unknown_file');
  });

  it("stops sales only on the seller's signature, once", async () => {
    expect(await codeOf(check(await stop(), opts()))).toBe('ok');
    expect(await codeOf(check(await stop(buyer), opts()))).toBe('bad_signature');
    w.file = fileView({ sales_stopped_at: NOW - 10 });
    expect(await codeOf(check(await stop(), opts()))).toBe('sales_stopped');
  });
});

describe('checkRelay: unlock', () => {
  it('accepts the payment exactly as it is on Base, at safe, unused, with its block header', async () => {
    expect(await codeOf(check(unlock(), opts()))).toBe('ok');
    expect(w.calls).toContain('base:eth_getTransactionReceipt');
  });

  it('refuses logs that differ from the receipt, another key, an underpayment, an unknown transaction', async () => {
    const [a, t] = LOGS as [(typeof LOGS)[number], (typeof LOGS)[number]];
    expect(await codeOf(check(unlock({ logs: [a, { ...t, log_index: 9 }] }), opts()))).toBe(
      'payment_not_found',
    );
    expect(await codeOf(check(unlock({ logs: [a] }), opts()))).toBe('bad_request');
    expect(await codeOf(check(unlock({ buyer_key: point(11n) }), opts()))).toBe(
      'payment_not_found',
    );
    w.receipt = receiptFor(9_999n);
    expect(await codeOf(check(unlock(), opts()))).toBe('payment_not_found');
    w.receipt = null;
    expect(await codeOf(check(unlock(), opts()))).toBe('payment_not_found');
  });

  it('waits for Base safe, refuses a used payment, a wrong header, and a stopped file without a header', async () => {
    w.safe = REAL.number - 1;
    expect(await codeOf(check(unlock(), opts()))).toBe('payment_not_safe');
    w.safe = REAL.number;
    w.paymentUsed = true;
    expect(await codeOf(check(unlock(), opts()))).toBe('payment_used');
    w.paymentUsed = false;
    const other = headers.cases[1] as (typeof headers.cases)[number];
    expect(await codeOf(check(unlock({ header: other.rlp }), opts()))).toBe('bad_header');
    w.file = fileView({ sales_stopped_at: NOW - 10 });
    expect(await codeOf(check(unlock({ header: undefined }), opts()))).toBe('bad_header');
    expect(await codeOf(check(unlock(), opts()))).toBe('ok');
    w.file = fileView({ taken_down: 'illegal_content' });
    expect(await codeOf(check(unlock(), opts()))).toBe('taken_down');
  });

  it("refuses an underpayment even when the logs sent are that payment's own", async () => {
    w.receipt = receiptFor(9_999n);
    const underpaid = paymentLogs(w.receipt, {
      usdc: USDC,
      to: PAY_TO,
      from: BUYER,
      nonce: annonNonce(CONTRACT, FILE, keyBytes),
      price: 0n,
    });
    expect(await codeOf(check(unlock({ logs: underpaid }), opts()))).toBe('payment_not_found');
  });

  it('refuses a malformed file id before any RPC call', async () => {
    for (const file_id of [`0x${'gg'.repeat(32)}`, FILE.slice(0, 64), 7]) {
      expect(await codeOf(check(unlock({ file_id }), opts()))).toBe('bad_request');
    }
    expect(w.calls).toHaveLength(0);
  });

  it('says transport when an RPC fails, so the caller retries', async () => {
    w.nearError = true;
    expect(await codeOf(check(unlock(), opts()))).toBe('transport');
  });
});

describe("canonicalRequest and the contract's own rules", () => {
  it('refuses what the contract or MPC would refuse after spending gas', async () => {
    w.file = null;
    const r = (await register()) as Extract<RelayRequest, { method: 'register' }>;
    for (const args of [
      { ...r.args, price: 10000 },
      { ...r.args, moderator: 'Not An Account' },
      { ...r.args, seller_key: `0x${'00'.repeat(48)}` },
      { ...r.args, seller_key: `0x${'c0'}${'00'.repeat(47)}` },
    ]) {
      expect(await codeOf(check({ ...r, args }, opts())), JSON.stringify(args).slice(0, 80)).toBe(
        'bad_request',
      );
    }
    expect(await codeOf(check(unlock({ header: REAL.rlp.replace('0x', '0X') }), opts()))).toBe(
      'bad_request',
    );
    expect(await codeOf(check(unlock({ buyer_key: `0x${'a1'.repeat(48)}` }), opts()))).toBe(
      'bad_request',
    );
    expect(await codeOf(check(null, opts()))).toBe('bad_request');
  });

  it('sends exactly the fields it checked, in lowercase', () => {
    const r = canonicalRequest({
      method: 'reopen',
      args: {
        file_id: FILE.toUpperCase().replace('0X', '0x'),
        wallet: buyer.address,
        key: point(9n),
        deadline: NOW,
        extra: 'x',
      },
      sig: `0x${'AB'.repeat(65)}`,
    });
    expect(r).toEqual({
      method: 'reopen',
      args: { file_id: FILE, wallet: BUYER, key: point(9n), deadline: NOW },
      sig: `0x${'ab'.repeat(65)}`,
    });
  });

  it("applies the contract's stop window: a payment at most 300 s after the stop", async () => {
    const paidAt = Number.parseInt(REAL.json.timestamp as string, 16);
    w.file = fileView({ sales_stopped_at: paidAt - 300 });
    expect(await codeOf(check(unlock(), opts()))).toBe('ok');
    w.file = fileView({ sales_stopped_at: paidAt - 301 });
    expect(await codeOf(check(unlock(), opts()))).toBe('sales_stopped');
  });

  it("serves only the operator's sellers, for every method", async () => {
    const only = opts({
      policy: { minPrice: 1n, maxDeadlineSeconds: 600, sellerAllowed: () => false },
    });
    expect(await codeOf(check(unlock(), only))).toBe('not_sponsored');
    expect(await codeOf(check(await reopen(), only))).toBe('not_sponsored');
    expect(await codeOf(check(await stop(), only))).toBe('not_sponsored');
  });
});

describe('relay', () => {
  const key = KeyPair.fromRandom('ed25519');
  const sender = { accountId: 'relayer.annon.defdone.near', key: key.toString() };

  it('sends one function call to the contract, no deposit, 300 Tgas, and returns its hash', async () => {
    const req = unlock();
    const { txHash } = await relay(req, { ...opts(), sender });
    expect(w.sent).toHaveLength(1);
    const signed = decodeSignedTransaction(Buffer.from(w.sent[0] as string, 'base64'));
    const tx = signed.transaction;
    expect(tx.signerId).toBe(sender.accountId);
    expect(tx.receiverId).toBe(CONTRACT);
    expect(tx.publicKey.toString()).toBe(key.getPublicKey().toString());
    const call = tx.actions[0]?.functionCall;
    expect(tx.actions).toHaveLength(1);
    expect(call?.methodName).toBe('unlock');
    expect(JSON.parse(Buffer.from(call?.args as Uint8Array).toString())).toEqual({
      args: req.args,
    });
    expect(call?.gas).toBe(300_000_000_000_000n);
    expect(call?.deposit).toBe(0n);
    expect(txHash).toBe(base58.encode(sha256(tx.encode())));
    const sig = (signed.signature as unknown as { ed25519Signature: { data: number[] } })
      .ed25519Signature.data;
    expect(key.verify(sha256(tx.encode()), Uint8Array.from(sig))).toBe(true);
  });

  it('signs nothing when the check fails', async () => {
    w.paymentUsed = true;
    expect(await codeOf(relay(unlock(), { ...opts(), sender }))).toBe('payment_used');
    expect(w.sent).toHaveLength(0);
  });

  it('sends one transaction at a time, each with the next nonce, checking right before signing', async () => {
    w.sendDelay = 30;
    await Promise.all([
      relay(unlock(), { ...opts(), sender }),
      relay(await reopen(), { ...opts(), sender }),
    ]);
    // The access key always reports nonce 5: the kept account numbers 6 and 7 itself.
    expect(w.nonces).toEqual([6n, 7n]);
    // The reopen was checked after the unlock was sent, not before both.
    expect(w.calls.indexOf('near:send_tx')).toBeLessThan(w.calls.indexOf('near:is_buyer'));
  });

  it('refuses the same operation twice while it is on its way, but not after it failed before sending', async () => {
    w.sendDelay = 30;
    const both = await Promise.all([
      codeOf(relay(unlock(), { ...opts(), sender })),
      codeOf(relay(unlock(), { ...opts(), sender })),
    ]);
    expect(both.sort()).toEqual(['duplicate', 'ok']);
    expect(w.sent).toHaveLength(1);
    resetRelayState();
    w.paymentUsed = true;
    expect(await codeOf(relay(await reopen(stranger), { ...opts(), sender }))).toBe('not_buyer');
    w.buyers.push(stranger.address.toLowerCase());
    expect(await codeOf(relay(await reopen(stranger), { ...opts(), sender }))).toBe('ok');
  });

  it('charges limits on admission: ten concurrent reopens under a limit of one send one', async () => {
    w.sendDelay = 10;
    const limited = {
      ...opts({ policy: { minPrice: 1n, maxDeadlineSeconds: 600, reopensPerWalletFile: 1 } }),
      sender,
    };
    const all = await Promise.all(
      Array.from({ length: 10 }, async (_, i) =>
        codeOf(relay(await reopen(buyer, { key: point(BigInt(20 + i)) }), limited)),
      ),
    );
    expect(all.filter((c) => c === 'ok')).toHaveLength(1);
    expect(all.filter((c) => c === 'limited')).toHaveLength(9);
    expect(w.sent).toHaveLength(1);
  });

  it('counts every admission against a limit above one, and gives a refused request its share back', async () => {
    const two = {
      ...opts({ policy: { minPrice: 1n, maxDeadlineSeconds: 600, reopensPerWalletFile: 2 } }),
      sender,
    };
    const three = await Promise.all(
      [30n, 31n, 32n].map(async (k) => codeOf(relay(await reopen(buyer, { key: point(k) }), two))),
    );
    expect(three.sort()).toEqual(['limited', 'ok', 'ok']);
    resetRelayState();
    const one = {
      ...opts({ policy: { minPrice: 1n, maxDeadlineSeconds: 600, reopensPerWalletFile: 1 } }),
      sender,
    };
    w.file = fileView({ taken_down: 'court_order' });
    expect(await codeOf(relay(await reopen(), one))).toBe('taken_down');
    w.file = fileView();
    expect(await codeOf(relay(await reopen(buyer, { key: point(33n) }), one))).toBe('ok');
  });

  it("can't be blocked by forged requests: they take no limit and hold no operation", async () => {
    w.sendDelay = 20;
    const one = {
      ...opts({ policy: { minPrice: 1n, maxDeadlineSeconds: 600, reopensPerWalletFile: 1 } }),
      sender,
    };
    const valid = (await reopen()) as Extract<RelayRequest, { method: 'reopen' }>;
    // The attacker copies the wallet, file and key but can't sign; and sends a payment's public
    // logs with a key of its own.
    const forged = { ...valid, sig: await stranger.signMessage({ message: 'x' }) };
    const results = await Promise.all([
      codeOf(relay(forged, one)),
      codeOf(relay(forged, one)),
      codeOf(relay(unlock({ buyer_key: point(40n) }), one)),
      codeOf(relay(valid, one)),
      codeOf(relay(unlock(), one)),
    ]);
    expect(results).toEqual(['bad_signature', 'bad_signature', 'payment_not_found', 'ok', 'ok']);
  });

  it("a forged stop sent first doesn't block the seller's own stop", async () => {
    w.sendDelay = 20;
    const both = await Promise.all([
      codeOf(relay(await stop(buyer), { ...opts(), sender })),
      codeOf(relay(await stop(), { ...opts(), sender })),
    ]);
    expect(both).toEqual(['bad_signature', 'ok']);
  });

  it('sends one stop per seller and file, even when the seller signs two (other deadlines)', async () => {
    w.sendDelay = 20;
    const twice = async (deadline: number) => {
      const args = { file_id: FILE, deadline };
      return {
        method: 'stop_sales',
        args,
        sig: await seller.signMessage({ message: stopSalesText(CONTRACT, args) }),
      } as RelayRequest;
    };
    const both = await Promise.all([
      codeOf(relay(await twice(NOW + 300), { ...opts(), sender })),
      codeOf(relay(await twice(NOW + 301), { ...opts(), sender })),
    ]);
    expect(both).toEqual(['ok', 'duplicate']);
    expect(w.sent).toHaveLength(1);
  });

  it("when NEAR's answer is lost, sends the same bytes again, then says uncertain", async () => {
    w.gatewayDown = true;
    const out = await relay(unlock(), { ...opts(), sender });
    expect(out).toMatchObject({ uncertain: true });
    expect(out.txHash).toMatch(/^[1-9A-HJ-NP-Za-km-z]{43,44}$/);
    // Three tries, one transaction: identical bytes, so NEAR could run it once at most.
    expect(w.sent).toHaveLength(3);
    expect(new Set(w.sent).size).toBe(1);
    w.gatewayDown = false;
    // Held for a while, so a client retrying at once doesn't send it again.
    expect(await codeOf(relay(unlock(), { ...opts(), sender }))).toBe('duplicate');
    const start = Date.now();
    vi.setSystemTime(start + 14 * 60_000);
    try {
      expect(await codeOf(relay(unlock(), { ...opts(), sender }))).toBe('duplicate');
      // After 15 minutes the same request is sent again; if the first landed, the contract refuses it.
      vi.setSystemTime(start + 16 * 60_000);
      expect(await codeOf(relay(unlock(), { ...opts(), sender }))).toBe('ok');
    } finally {
      vi.useRealTimers();
    }
    expect(new Set(w.sent).size).toBe(2);
  });

  it('never signs an operation again when its first copy landed and every answer was lost', async () => {
    const one = {
      ...opts({ policy: { minPrice: 1n, maxDeadlineSeconds: 600, reopensPerWalletFile: 1 } }),
      sender,
    };
    // The first copy lands, its answer and the lookups are lost, the resend is refused for its
    // nonce: the refusal proves nothing, since the copy that landed used that nonce.
    w.landThenLose = true;
    w.statusDown = true;
    expect(await relay(await reopen(), one)).toMatchObject({ uncertain: true });
    expect(new Set(w.sent).size).toBe(1);
    expect(w.landed).toHaveLength(1);
    w.landThenLose = false;
    w.statusDown = false;
    // Found later: the operation landed, so its limit stays charged.
    expect(await codeOf(relay(await reopen(buyer, { key: point(12n) }), one))).toBe('limited');
    expect(w.landed).toHaveLength(1);
  });

  it('takes a lost answer as sent when the first copy landed and the lookup finds it', async () => {
    w.landThenLose = true;
    expect(await relay(unlock(), { ...opts(), sender })).not.toHaveProperty('uncertain');
    // One fetch per send: no copy went out again behind the relayer's back.
    expect(w.sent).toHaveLength(1);
  });

  it('keeps the limit charged once a transaction was sent, whatever its outcome', async () => {
    const one = {
      ...opts({ policy: { minPrice: 1n, maxDeadlineSeconds: 600, reopensPerWalletFile: 1 } }),
      sender,
    };
    w.gatewayDown = true;
    expect(await relay(await reopen(), one)).toMatchObject({ uncertain: true });
    w.gatewayDown = false;
    expect(await codeOf(relay(await reopen(buyer, { key: point(12n) }), one))).toBe('limited');
  });

  it("gives a refund back to the day it was charged to, not to today's", async () => {
    const one = {
      ...opts({ policy: { minPrice: 1n, maxDeadlineSeconds: 600, reopensPerWalletFile: 1 } }),
      sender,
    };
    w.sendDelay = 50;
    const ahead = relay(unlock(), { ...opts(), sender });
    // Charged today, then fails its checks (expired signature) only after midnight.
    const late = relay(await reopen(), { ...one, now: NOW + 1_000 });
    vi.setSystemTime(Date.now() + 86_400_000 + 1);
    try {
      const today = relay(await reopen(buyer, { key: point(12n) }), one);
      expect(await codeOf(late)).toBe('bad_deadline');
      expect(await codeOf(today)).toBe('ok');
      await ahead;
      // Today's window keeps today's request.
      expect(await codeOf(relay(await reopen(buyer, { key: point(13n) }), one))).toBe('limited');
    } finally {
      vi.useRealTimers();
    }
  });

  it('gives up on a stalled NEAR RPC instead of holding every request behind it', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      w.sendHang = true;
      const stalled = relay(unlock(), { ...opts(), sender });
      // Three sends, each given up on after 20 s: an unclear answer, not a refusal.
      await vi.advanceTimersByTimeAsync(3 * 20_000 + 1);
      expect(await stalled).toMatchObject({ uncertain: true });
      expect(new Set(w.sent).size).toBe(1);
    } finally {
      vi.useRealTimers();
    }
    w.sendHang = false;
    expect(await codeOf(relay(await reopen(), { ...opts(), sender }))).toBe('ok');
  });

  it('answers busy past 32 waiting requests, without charging them', async () => {
    w.sendDelay = 30;
    const many = {
      ...opts({ policy: { minPrice: 1n, maxDeadlineSeconds: 600, reopensPerWalletFile: 100 } }),
      sender,
    };
    const reqs = await Promise.all(
      Array.from({ length: 40 }, (_, i) => reopen(buyer, { key: point(BigInt(100 + i)) })),
    );
    const out = await Promise.all(reqs.map((r) => codeOf(relay(r, many))));
    expect(out.filter((c) => c === 'ok')).toHaveLength(32);
    expect(out.filter((c) => c === 'unavailable')).toHaveLength(8);
    // The busy ones took nothing: sent again, they go through.
    expect(await codeOf(relay(reqs[39] as RelayRequest, many))).toBe('ok');
  });

  it("keeps each contract's operations apart in one process", async () => {
    expect(await codeOf(relay(unlock(), { ...opts(), sender }))).toBe('ok');
    // The same unlock to another contract is its own operation (and its nonce doesn't match).
    expect(await codeOf(relay(unlock(), { ...opts({ contractId: 'other.near' }), sender }))).toBe(
      'payment_not_found',
    );
  });

  it('counts storage per payer, whichever of its keys signs', async () => {
    w.file = null;
    w.storage = (15n * 10n ** 21n).toString();
    const other = { ...sender, key: KeyPair.fromRandom('ed25519').toString() };
    const reg = async (i: number, s: typeof sender) =>
      codeOf(
        relay(await register({ file_id: `0x${String(i).repeat(64)}` }), { ...opts(), sender: s }),
      );
    expect(await reg(1, sender)).toBe('ok');
    expect(await reg(2, other)).toBe('unavailable');
  });

  it('answers transport, not an internal error, when the storage read fails', async () => {
    w.storageDown = true;
    expect(await codeOf(relay(unlock(), { ...opts(), sender }))).toBe('transport');
    w.storageDown = false;
    // Nothing was sent, so the same request may come again.
    expect(await codeOf(relay(unlock(), { ...opts(), sender }))).toBe('ok');
  });

  it('accepts the payment logs with their fields in any order', async () => {
    const reversed = LOGS.map((l) => Object.fromEntries(Object.entries(l).reverse()));
    expect(await codeOf(relay(unlock({ logs: reversed }), { ...opts(), sender }))).toBe('ok');
  });

  it('forgets expired holds and windows after successful requests too', async () => {
    for (let i = 0; i < 5; i++) {
      expect(
        await codeOf(
          relay(await reopen(buyer, { key: point(BigInt(60 + i)) }), { ...opts(), sender }),
        ),
      ).toBe('ok');
    }
    expect(relayCounters()).toBe(6);
    vi.setSystemTime(Date.now() + 86_400_000 + 1);
    try {
      w.file = null;
      expect(await codeOf(relay(await reopen(), { ...opts(), sender }))).toBe('unknown_file');
      expect(relayCounters()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('refuses a deadline past the year 9999 as a bad request', async () => {
    const r = await reopen();
    (r.args as { deadline: number }).deadline = Number.MAX_SAFE_INTEGER;
    expect(await codeOf(relay(r, { ...opts(), sender }))).toBe('bad_request');
  });

  it('takes a malformed status reply as no answer: never sent again, never refunded', async () => {
    const one = {
      ...opts({ policy: { minPrice: 1n, maxDeadlineSeconds: 600, reopensPerWalletFile: 1 } }),
      sender,
    };
    w.gatewayDown = true;
    w.statusNull = true;
    expect(await relay(await reopen(), one)).toMatchObject({ uncertain: true });
    expect(new Set(w.nonces)).toEqual(new Set([6n]));
    w.gatewayDown = false;
    expect(await codeOf(relay(await reopen(buyer, { key: point(12n) }), one))).toBe('limited');
  });

  it('takes a send_tx reply without a status as no answer, not as sent', async () => {
    w.sendNull = true;
    expect(await relay(unlock(), { ...opts(), sender })).toMatchObject({ uncertain: true });
    // The same bytes each time: the operation was never signed again.
    expect(new Set(w.sent).size).toBe(1);
    w.sendNull = false;
    expect(await codeOf(relay(unlock(), { ...opts(), sender }))).toBe('duplicate');
  });

  it('takes nothing from a reply to another request: a forged "in a block" is not "sent"', async () => {
    w.wrongId = ['send_tx'];
    expect(await relay(await reopen(), { ...opts(), sender })).toMatchObject({ uncertain: true });
    // The same bytes each time, and the operation stays held.
    expect(w.sent).toHaveLength(3);
    expect(new Set(w.sent).size).toBe(1);
    expect(await codeOf(relay(await reopen(), { ...opts(), sender }))).toBe('duplicate');
  });

  it('holds a queued operation until it is sent, however long the queue', async () => {
    w.sendDelay = 50;
    const ahead = relay(await reopen(), { ...opts(), sender });
    const queued = relay(unlock(), { ...opts(), sender });
    // Longer than the hold, while the unlock still waits for its turn.
    vi.setSystemTime(Date.now() + 16 * 60_000);
    try {
      expect(await codeOf(relay(unlock(), { ...opts(), sender }))).toBe('duplicate');
      await Promise.all([ahead, queued]);
    } finally {
      vi.useRealTimers();
    }
    expect(w.sent).toHaveLength(2);
  });

  it('takes a lost answer as sent when the transaction is found in a block', async () => {
    w.gatewayDown = true;
    w.seen = true;
    expect(await relay(unlock(), { ...opts(), sender })).not.toHaveProperty('uncertain');
    expect(w.sent).toHaveLength(1);
  });

  it('keeps no counter for refused requests, so junk cannot grow its memory', async () => {
    w.file = null;
    for (let i = 0; i < 100; i++) {
      expect(
        await codeOf(
          relay(await reopen(buyer, { key: point(BigInt(50 + i)) }), { ...opts(), sender }),
        ),
      ).toBe('unknown_file');
    }
    expect(relayCounters()).toBe(0);
  });

  it('takes even a first refusal as unclear, and keeps the limit charged', async () => {
    const one = {
      ...opts({ policy: { minPrice: 1n, maxDeadlineSeconds: 600, reopensPerWalletFile: 1 } }),
      sender,
    };
    w.refuseAllowance = true;
    expect(await relay(await reopen(), one)).toMatchObject({ uncertain: true });
    w.refuseAllowance = false;
    expect(await codeOf(relay(await reopen(buyer, { key: point(12n) }), one))).toBe('limited');
  });

  it("reports NEAR's refusal as the reason, and keeps the operation held", async () => {
    const one = {
      ...opts({ policy: { minPrice: 1n, maxDeadlineSeconds: 600, reopensPerWalletFile: 1 } }),
      sender,
    };
    w.refuseAllowance = true;
    const out = await relay(await reopen(), one);
    expect(out).toMatchObject({ uncertain: true });
    expect(out.reason).toMatch(/NotEnoughAllowance/);
    w.refuseAllowance = false;
    expect(await codeOf(relay(await reopen(), one))).toBe('duplicate');
  });

  it('takes a refusal in string form as unclear too, and never sends those bytes again', async () => {
    w.refuseExpired = true;
    expect(await relay(unlock(), { ...opts(), sender })).toMatchObject({
      uncertain: true,
      reason: 'NEAR answered the send: "Expired"',
    });
    expect(w.sent).toHaveLength(1);
    w.refuseExpired = false;
    w.busy = ['badSignature'];
    expect(await relay(await reopen(), { ...opts(), sender })).toMatchObject({
      uncertain: true,
      reason: 'NEAR answered the send: "InvalidSignature"',
    });
    expect(w.sent).toHaveLength(2);
  });

  it('refuses nothing a node accepted: a refusal after the copy landed is taken as sent', async () => {
    const one = {
      ...opts({ policy: { minPrice: 1n, maxDeadlineSeconds: 600, reopensPerWalletFile: 1 } }),
      sender,
    };
    w.landThenRefuse = true;
    expect(await relay(await reopen(), one)).not.toHaveProperty('uncertain');
    w.landThenRefuse = false;
    expect(await codeOf(relay(await reopen(), one))).toBe('duplicate');
    expect(await codeOf(relay(await reopen(buyer, { key: point(12n) }), one))).toBe('limited');
    expect(w.landed).toHaveLength(1);
  });

  it('counts recent writes against the prepaid balance for a couple of minutes', async () => {
    w.file = null;
    w.storage = (2n * 10n ** 22n).toString();
    const reg = async (i: number) =>
      codeOf(
        relay(await register({ file_id: `0x${String(i).repeat(64)}` }), { ...opts(), sender }),
      );
    expect(await reg(1)).toBe('ok');
    expect(await reg(2)).toBe('ok');
    // The balance read may not show the last two yet: a third would be over it.
    expect(await reg(3)).toBe('unavailable');
    vi.setSystemTime(Date.now() + 3 * 60_000);
    try {
      expect(await reg(4)).toBe('ok');
    } finally {
      vi.useRealTimers();
    }
  });

  it('counts a reopen as a write: it pays for its marker', async () => {
    w.storage = (10n ** 22n - 1n).toString();
    expect(await codeOf(relay(await reopen(), { ...opts(), sender }))).toBe('unavailable');
    expect(w.sent).toHaveLength(0);
  });

  it('when another sender used the key, reads the nonce afresh for later operations, never resigning this one', async () => {
    w.nonceRefusals = 1;
    // Refused for its nonce: it may be its own copy that landed, so this one stays unresolved.
    expect(await relay(unlock(), { ...opts(), sender })).toMatchObject({ uncertain: true });
    expect(w.nonces).toEqual([6n]);
    // The next operation reads the key's nonce from the chain instead of taking 7.
    expect(await codeOf(relay(await reopen(), { ...opts(), sender }))).toBe('ok');
    expect(w.nonces).toEqual([6n, 101n]);
  });

  it('reserves storage for transactions in flight, not only what final state shows', async () => {
    w.file = null;
    w.storage = (2n * 10n ** 22n).toString();
    const out = await Promise.all(
      [1, 2, 3].map(async (i) =>
        codeOf(
          relay(await register({ file_id: `0x${String(i).repeat(64)}` }), { ...opts(), sender }),
        ),
      ),
    );
    expect(out.sort()).toEqual(['ok', 'ok', 'unavailable']);
  });

  it('stops at the daily limits per wallet and file, and when its prepaid storage is low', async () => {
    const limited = {
      ...opts({ policy: { minPrice: 1n, maxDeadlineSeconds: 600, reopensPerWalletFile: 1 } }),
      sender,
    };
    expect(await codeOf(relay(await reopen(), limited))).toBe('ok');
    expect(await codeOf(relay(await reopen(buyer, { key: point(12n) }), limited))).toBe('limited');
    w.storage = (10n ** 22n - 1n).toString();
    expect(await codeOf(relay(unlock(), { ...opts(), sender }))).toBe('unavailable');
    expect(w.sent).toHaveLength(1);
  });

  it('sends the same bytes again when NEAR says to: a timeout, an internal error, a congested shard after a wait', async () => {
    w.busy = ['congested', 'timeout'];
    const start = Date.now();
    expect(await relay(unlock(), { ...opts(), sender })).toEqual({ txHash: expect.any(String) });
    expect(Date.now() - start).toBeGreaterThanOrEqual(1_000);
    expect(w.sent).toHaveLength(3);
    expect(new Set(w.sent).size).toBe(1);
    expect(w.landed).toHaveLength(1);
    // "Try again later": the next send waits too.
    w.busy = ['internal', 'later'];
    const again = Date.now();
    expect(await relay(await reopen(), { ...opts(), sender })).toEqual({
      txHash: expect.any(String),
    });
    expect(Date.now() - again).toBeGreaterThanOrEqual(3_000);
    expect(w.sent).toHaveLength(6);
  });

  it('waits when the lookup fails internally, and says so in the reason', async () => {
    w.busy = ['oldTimeout', 'oldTimeout', 'oldTimeout'];
    w.statusError = 'internal';
    const start = Date.now();
    const out = await relay(unlock(), { ...opts(), sender });
    expect(Date.now() - start).toBeGreaterThanOrEqual(3_000);
    expect(out.reason).toMatch(/lookup.*INTERNAL_ERROR/);
    expect(w.sent).toHaveLength(3);
    expect(new Set(w.sent).size).toBe(1);
  });

  it('goes on when a lookup fails in a way that says nothing about the transaction', async () => {
    w.busy = ['timeout'];
    w.statusError = 'parse';
    expect(await relay(unlock(), { ...opts(), sender })).toEqual({ txHash: expect.any(String) });
    expect(w.sent).toHaveLength(2);
  });

  it('waits for a stuck shard, then sends the same bytes again', async () => {
    w.busy = ['stuck'];
    const start = Date.now();
    expect(await relay(unlock(), { ...opts(), sender })).toEqual({ txHash: expect.any(String) });
    expect(Date.now() - start).toBeGreaterThanOrEqual(1_000);
    expect(w.sent).toHaveLength(2);
    expect(new Set(w.sent).size).toBe(1);
  });

  it("stops when the node can't look the transaction up: it doesn't track its shard", async () => {
    for (const how of ['untracked', 'untrackedTimeout'] as const) {
      resetRelayState();
      w.sent = [];
      w.calls = [];
      w.statusError = how;
      w.busy = ['oldTimeout'];
      const out = await relay(unlock(), { ...opts(), sender });
      expect(out).toMatchObject({
        uncertain: true,
        reason: expect.stringMatching(/tracks its shard/),
      });
      expect(w.sent).toHaveLength(1);
      // After PENDING too: no lookups in a loop against a node that can't answer.
      resetRelayState();
      w.calls = [];
      w.busy = ['pending'];
      const start = Date.now();
      expect(await relay(unlock(), { ...opts(), sender })).toMatchObject({ uncertain: true });
      expect(Date.now() - start).toBeLessThan(1_000);
      expect(w.calls.filter((c) => c === 'near:tx')).toHaveLength(1);
    }
  });

  it('after a pending timeout only looks the transaction up, and stops on a node without its shard', async () => {
    w.busy = ['pending'];
    const start = Date.now();
    expect(await relay(unlock(), { ...opts(), sender })).toMatchObject({ uncertain: true });
    expect(Date.now() - start).toBeGreaterThanOrEqual(3_000);
    expect(w.sent).toHaveLength(1);
    expect(w.calls.filter((c) => c === 'near:tx')).toHaveLength(3);
    w.busy = ['elsewhere'];
    const out = await relay(await reopen(), { ...opts(), sender });
    expect(out.reason).toMatch(/DOES_NOT_TRACK_SHARD/);
    expect(w.sent).toHaveLength(2);
  });

  it("sends once on an error resending can't fix, and keeps NEAR's name and data in the reason", async () => {
    w.busy = ['untracked'];
    const out = await relay(unlock(), { ...opts(), sender });
    expect(out).toMatchObject({ uncertain: true });
    expect(out.reason).toMatch(/DOES_NOT_TRACK_SHARD/);
    expect(w.sent).toHaveLength(1);
    w.busy = ['internal', 'internal', 'internal'];
    const lost = await relay(await reopen(), { ...opts(), sender });
    expect(lost.reason).toMatch(/INTERNAL_ERROR.*db busy/);
    expect(w.sent).toHaveLength(4);
  });

  it("keeps NEAR's last reason when every send timed out", async () => {
    w.busy = ['timeout', 'oldTimeout', 'timeout'];
    const out = await relay(unlock(), { ...opts(), sender });
    expect(out).toMatchObject({ uncertain: true });
    expect(out.reason).toMatch(/TIMEOUT_ERROR/);
    expect(w.sent).toHaveLength(3);
  });

  it('reads the nonce afresh after an InvalidNonce, even when the lookup then finds the copy that landed', async () => {
    // The first copy lands with nonce 6, its answer and the first lookup are lost; the resend is
    // refused for its nonce and the next lookup finds the first copy.
    w.landThenLose = true;
    w.statusFailures = 1;
    expect(await relay(unlock(), { ...opts(), sender })).toEqual({ txHash: expect.any(String) });
    expect(w.nonces).toEqual([6n, 6n]);
    w.landThenLose = false;
    // Another sender moved the key on meanwhile: the next operation reads it from the chain.
    w.akNonce = 100;
    expect(await codeOf(relay(await reopen(), { ...opts(), sender }))).toBe('ok');
    expect(w.nonces).toEqual([6n, 6n, 101n]);
  });

  it('takes a limit of zero as zero, and keeps registrations per seller', async () => {
    const none = {
      ...opts({ policy: { minPrice: 1n, maxDeadlineSeconds: 600, reopensPerWalletFile: 0 } }),
      sender,
    };
    expect(await codeOf(relay(await reopen(), none))).toBe('limited');
    w.file = null;
    const oneListing = {
      ...opts({ policy: { minPrice: 1n, maxDeadlineSeconds: 600, registrationsPerSeller: 1 } }),
      sender,
    };
    expect(await codeOf(relay(await register(), oneListing))).toBe('ok');
    expect(
      await codeOf(relay(await register({ file_id: `0x${'99'.repeat(32)}` }), oneListing)),
    ).toBe('limited');
    expect(w.sent).toHaveLength(1);
  });

  it('takes a transaction known but not in a block (NONE) as not landed', async () => {
    w.gatewayDown = true;
    w.statusNone = true;
    expect(await relay(unlock(), { ...opts(), sender })).toMatchObject({ uncertain: true });
  });

  it('stops sales with no prepaid storage: a stop writes nothing new', async () => {
    w.storage = '0';
    expect(await codeOf(relay(await stop(), { ...opts(), sender }))).toBe('ok');
    expect(w.calls).not.toContain('near:storage_balance_of');
  });
});
