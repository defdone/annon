// Retained format-independent Base RPC, signature, receipt and finality regression checks.
import { readFileSync } from 'node:fs';
import { bls12_381 as bls } from '@noble/curves/bls12-381.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  encodePacked,
  getAddress,
  hashTypedData,
  keccak256,
  parseAbi,
  recoverTypedDataAddress,
  sha256,
  verifyTypedData,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { purchase as sample } from '../../test/fixtures.js';
import { baseNonceV2, purchaseId } from '../settle-near/purchase.js';
import { blockHeader, type Expected, type PayError, paymentLogs } from './base.js';
import { type Authorization, digest, signer, typedData } from './eip3009.js';
import { status } from './pay.js';
import type { PurchaseRecord } from './purchase.js';
import type { PaymentRequired } from './x402.js';

const USDC_ABI = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function authorizationState(address,bytes32) view returns (bool)',
  'function transferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce,uint8 v,bytes32 r,bytes32 s)',
  'event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)',
  'event AuthorizationCanceled(address indexed authorizer, bytes32 indexed nonce)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
]);

const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const buyerAccount = privateKeyToAccount(`0x${'42'.repeat(32)}`);
const BUYER = buyerAccount.address.toLowerCase();
const hex = (b: Uint8Array) => `0x${Buffer.from(b).toString('hex')}`;
const randomAuth = (i: number): Authorization => ({
  from: BUYER,
  to: hex(Uint8Array.from({ length: 20 }, (_, j) => (i * 31 + j * 7) & 0xff)),
  value: BigInt(i) * 1_000_003n,
  validAfter: 0n,
  validBefore: 1_800_000_000n + BigInt(i),
  nonce: keccak256(encodePacked(['uint256'], [BigInt(i)])),
});
const asViem = (t: ReturnType<typeof typedData>) =>
  t as unknown as Parameters<typeof hashTypedData>[0];

describe('EIP-3009 typed data against viem', () => {
  it('hashes exactly as viem does', () => {
    for (let i = 0; i < 20; i++) {
      const a = randomAuth(i);
      expect(hex(digest(USDC, a))).toBe(hashTypedData(asViem(typedData(USDC, a))));
    }
  });

  it('recovers the viem signer, and nobody else after any single-bit change', async () => {
    const a = randomAuth(3);
    const d = digest(USDC, a);
    const sig = await buyerAccount.signTypedData(asViem(typedData(USDC, a)));
    expect(signer(d, sig)).toBe(BUYER);
    const bytes = Buffer.from(sig.slice(2), 'hex');
    const wrong: number[] = [];
    for (let bit = 0; bit < 65 * 8; bit++) {
      const f = Buffer.from(bytes);
      f[bit >> 3] = (f[bit >> 3] ?? 0) ^ (1 << (bit & 7));
      if (signer(d, `0x${f.toString('hex')}`) === BUYER) wrong.push(bit);
    }
    expect(wrong).toEqual([]);
  });

  it('refuses what USDC refuses: high s, v other than 27 or 28, wrong length', async () => {
    const a = randomAuth(4);
    const d = digest(USDC, a);
    const sig = await buyerAccount.signTypedData(asViem(typedData(USDC, a)));
    const r = sig.slice(2, 66);
    const s = BigInt(`0x${sig.slice(66, 130)}`);
    const v = Number.parseInt(sig.slice(130), 16);
    const highS = (secp256k1.Point.Fn.ORDER - s).toString(16).padStart(64, '0');
    const flipped = (v === 27 ? 28 : 27).toString(16);
    // The same signature in its high-s form still recovers the buyer in plain ECDSA.
    expect(
      await recoverTypedDataAddress({
        ...asViem(typedData(USDC, a)),
        signature: `0x${r}${highS}${flipped}`,
      }),
    ).toBe(buyerAccount.address);
    expect(signer(d, `0x${r}${highS}${flipped}`)).toBeNull();
    expect(
      signer(d, `0x${r}${sig.slice(66, 130)}${(v - 27).toString(16).padStart(2, '0')}`),
    ).toBeNull();
    expect(signer(d, sig.slice(0, -2))).toBeNull();
    expect(signer(d, `${sig}00`)).toBeNull();
  });
});

const BASE = 'https://base.rpc',
  CONTRACT = sample.contract,
  FILE = sample.file_id;
const SELLER = { kind: 'evm', id: BUYER } as const;
const PAY_TO = `0x${'5e'.repeat(20)}`,
  NOW = 1800000000,
  SIGNED = 0x3000000;
const buyerKey = bls.G1.Point.BASE.multiply(7n).toBytes(true);
const CIPHER_HASH = `0x${'22'.repeat(32)}`,
  HEADER = new Uint8Array(54);
const required = (): PaymentRequired => ({ x402Version: 2, accepts: [] });
const at = (n: number) => ({ number: n, timestamp: NOW + Math.floor((n - SIGNED) / 5) });
const file = () => null;
const codeOf = (p: Promise<unknown>) =>
  p.then(
    () => 'ok',
    (e: PayError) => e.code,
  );
type World = {
  /** The contract the simulated NEAR has; the default is CONTRACT. */
  contract?: string;
  file: Record<string, unknown> | null;
  config: Record<string, unknown>;
  chainId: string;
  head: { number: number; timestamp: number };
  finalized: { number: number; timestamp: number };
  /** Base `safe`; the head when not set. */
  safe?: { number: number; timestamp: number };
  /** Block hashes that differ from the logs' (a reorg); every other block is `0xbb…`. */
  blockHashes?: Record<number, string>;
  /** Runs when a block tag is read, before the answer: lets the chain move between reads. */
  onTag?: (tag: string) => void;
  /** An honest RPC answers eth_getLogs with what the query asked for; a lying one with everything. */
  honest: boolean;
  code: string;
  balance: bigint;
  authorizationState: boolean;
  dryRun: { error?: { code: number; message: string } };
  getLogs: unknown[];
  receipt: unknown;
  calls: { method: string; data?: string; from?: string }[];
  /** Runs on every NEAR view, e.g. to let time pass while one stalls. */
  onNear?: () => void;
};
let w: World;

const AUTH_FIELDS = [
  { name: 'from', type: 'address' },
  { name: 'to', type: 'address' },
  { name: 'value', type: 'uint256' },
  { name: 'validAfter', type: 'uint256' },
  { name: 'validBefore', type: 'uint256' },
  { name: 'nonce', type: 'bytes32' },
] as const;

async function respond(
  _url: string,
  body: { id: string; method: string; params: unknown[] | Record<string, unknown> },
) {
  const reply = (result: unknown) => ({ id: body.id, result });
  const params = body.params as unknown[];
  const p0 = (params[0] ?? {}) as { data?: string; from?: string };
  w.calls.push({ method: body.method, ...p0 });
  switch (body.method) {
    case 'eth_chainId':
      return reply(w.chainId);
    case 'eth_getBlockByNumber': {
      const tag = params[0];
      if (typeof tag === 'string' && !tag.startsWith('0x')) w.onTag?.(tag);
      const b =
        tag === 'latest'
          ? w.head
          : tag === 'finalized'
            ? w.finalized
            : tag === 'safe'
              ? (w.safe ?? w.head)
              : at(Number(tag as string));
      // Like a real node: no answer for a block past the head.
      if (b.number > w.head.number) return reply(null);
      return reply({
        number: `0x${b.number.toString(16)}`,
        timestamp: `0x${b.timestamp.toString(16)}`,
        hash: w.blockHashes?.[b.number] ?? `0x${'bb'.repeat(32)}`,
      });
    }
    case 'eth_getCode':
      return reply(w.code);
    case 'eth_getLogs': {
      const q = p0 as { address: string; fromBlock: string; toBlock: string; topics: unknown[] };
      const match = (l: RpcLog) =>
        l.address.toLowerCase() === q.address.toLowerCase() &&
        Number(l.blockNumber) >= Number(q.fromBlock) &&
        Number(l.blockNumber) <= Number(q.toBlock) &&
        q.topics.every((t, i) =>
          [t].flat().some((x) => String(x).toLowerCase() === l.topics[i]?.toLowerCase()),
        );
      return reply(w.honest ? (w.getLogs as RpcLog[]).filter(match) : w.getLogs);
    }
    case 'eth_getTransactionReceipt':
      return reply(w.receipt);
    case 'eth_getBlockByHash': {
      // Real Base blocks only: blockHeader checks the rebuilt header hashes to the asked hash.
      const c = headers.cases.find((h) => h.hash === params[0]);
      return reply(c ? { ...c.json, hash: c.hash } : null);
    }
    case 'eth_call': {
      // viem decodes what the SDK encoded: a wrong selector or argument fails here.
      const { functionName, args } = decodeFunctionData({
        abi: USDC_ABI,
        data: p0.data as `0x${string}`,
      });
      const forBuyer = String(args?.[0]).toLowerCase() === BUYER;
      if (functionName === 'balanceOf') {
        return reply(encodeAbiParameters([{ type: 'uint256' }], [forBuyer ? w.balance : 0n]));
      }
      if (functionName === 'authorizationState') {
        const set = w.authorizationState && forBuyer && args?.[1] === ANNON;
        return reply(encodeAbiParameters([{ type: 'bool' }], [set]));
      }
      if (w.dryRun.error) return { id: body.id, error: w.dryRun.error };
      // USDC's own check, modelled with viem: the signature must be `from` over this call.
      const [from, to, value, validAfter, validBefore, nonce, v, r, sg] = args as [
        `0x${string}`,
        `0x${string}`,
        bigint,
        bigint,
        bigint,
        `0x${string}`,
        number,
        `0x${string}`,
        `0x${string}`,
      ];
      const primaryType = 'TransferWithAuthorization';
      const ok = await verifyTypedData({
        address: from,
        domain: {
          name: 'USD Coin',
          version: '2',
          chainId: 8453,
          verifyingContract: getAddress(USDC),
        },
        types: { [primaryType]: AUTH_FIELDS },
        primaryType,
        message: { from, to, value, validAfter, validBefore, nonce },
        signature: `${r}${sg.slice(2)}${v.toString(16)}`,
      });
      return ok
        ? reply('0x')
        : {
            id: body.id,
            error: { code: 3, message: 'execution reverted: FiatTokenV2: invalid signature' },
          };
    }
  }
  throw new Error(`unexpected ${body.method}`);
}

beforeEach(() => {
  w = {
    file: file(),
    config: {
      mpc: 'v1.signer',
      ckd_domain: 2,
      foreign_tx_domain: 3,
      usdc: USDC,
    },
    chainId: '0x2105',
    head: at(SIGNED),
    finalized: at(SIGNED - 5000),
    honest: true,
    code: '0x',
    balance: 10_000n,
    authorizationState: false,
    dryRun: {},
    getLogs: [],
    receipt: null,
    calls: [],
  };
  vi.spyOn(Date, 'now').mockReturnValue(NOW * 1000);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: { body: string }) => ({
      json: async () => await respond(url, JSON.parse(init.body)),
    })),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const TX = `0x${'cc'.repeat(32)}`;
type RpcLog = {
  address: string;
  topics: string[];
  data: string;
  blockNumber: string;
  blockHash: string;
  transactionHash: string;
  transactionIndex: string;
  logIndex: string;
  removed: boolean;
};
const rpcLog = (address: string, topics: string[], data: string, logIndex: number): RpcLog => ({
  address: getAddress(address),
  topics,
  data,
  blockNumber: '0x3000005',
  blockHash: `0x${'bb'.repeat(32)}`,
  transactionHash: TX,
  transactionIndex: '0x5',
  logIndex: `0x${logIndex.toString(16)}`,
  removed: false,
});
const used = (nonce: string, from = BUYER, i = 3) =>
  rpcLog(
    USDC,
    encodeEventTopics({
      abi: USDC_ABI,
      eventName: 'AuthorizationUsed',
      args: { authorizer: from as `0x${string}`, nonce: nonce as `0x${string}` },
    }) as string[],
    '0x',
    i,
  );
const transfer = (from: string, to: string, value: bigint, i: number) =>
  rpcLog(
    USDC,
    encodeEventTopics({
      abi: USDC_ABI,
      eventName: 'Transfer',
      args: { from: from as `0x${string}`, to: to as `0x${string}` },
    }) as string[],
    encodeAbiParameters([{ type: 'uint256' }], [value]),
    i,
  );
const receipt = (logs: RpcLog[], s = '0x1') => ({ status: s, transactionHash: TX, logs });

const ANNON = baseNonceV2(purchaseId(sample));
const x402Expect: Expected = { usdc: USDC, to: PAY_TO, from: BUYER, nonce: ANNON, price: 10_000n };
/** A receipt with unrelated logs around the payment, as a real one has. */
const x402Receipt = () => [
  transfer(`0x${'77'.repeat(20)}`, `0x${'78'.repeat(20)}`, 5n, 2),
  used(ANNON),
  transfer(BUYER, PAY_TO, 10_000n, 4),
  transfer(PAY_TO, `0x${'79'.repeat(20)}`, 1n, 5),
];

describe('paymentLogs', () => {
  it('requires exactly the committed price, including for independently submitted authorizations', () => {
    for (const value of [9999n, 10001n])
      expect(
        paymentLogs(receipt([used(ANNON), transfer(BUYER, PAY_TO, value, 4)]), x402Expect),
      ).toBeNull();
  });

  it('picks AuthorizationUsed and its Transfer, in the form unlock takes', () => {
    const logs = paymentLogs(receipt(x402Receipt()), x402Expect);
    expect(logs).toHaveLength(2);
    expect(logs?.[1]).toEqual({
      address: USDC.slice(2),
      block_hash: 'bb'.repeat(32),
      block_number: 0x3000005,
      data: transfer(BUYER, PAY_TO, 10_000n, 4).data,
      log_index: 4,
      removed: false,
      topics: transfer(BUYER, PAY_TO, 10_000n, 4).topics.map((t) => t.slice(2)),
      transaction_hash: 'cc'.repeat(32),
      transaction_index: 5,
    });
  });

  it("is not misled by another payer's authorization with the same nonce in the same transaction", () => {
    // EIP-3009 nonces are per authorizer: a facilitator can put its own zero-value use of the
    // buyer's nonce first, in the same batch.
    const other = `0x${'66'.repeat(20)}`;
    const logs = [
      used(ANNON, other, 1),
      transfer(other, PAY_TO, 0n, 2),
      used(ANNON, BUYER, 3),
      transfer(BUYER, PAY_TO, 10_000n, 4),
    ];
    expect(paymentLogs(receipt(logs), x402Expect)?.map((l) => l.log_index)).toEqual([3, 4]);
  });

  // Each row is a receipt the contract would refuse; the SDK must not hand it to unlock.
  const refused: [string, Expected, RpcLog[], string?][] = [
    ['reverted transaction', x402Expect, x402Receipt(), '0x0'],
    [
      'removed authorization',
      x402Expect,
      [{ ...used(ANNON), removed: true }, transfer(BUYER, PAY_TO, 10_000n, 4)],
    ],
    [
      'removed transfer',
      x402Expect,
      [used(ANNON), { ...transfer(BUYER, PAY_TO, 10_000n, 4), removed: true }],
    ],
    [
      'x402 to another address',
      x402Expect,
      [used(ANNON), transfer(BUYER, `0x${'99'.repeat(20)}`, 10_000n, 4)],
    ],
    ['x402 below the price', x402Expect, [used(ANNON), transfer(BUYER, PAY_TO, 9_999n, 4)]],
    [
      'x402 with another nonce',
      x402Expect,
      [used(`0x${'ee'.repeat(32)}`), transfer(BUYER, PAY_TO, 10_000n, 4)],
    ],
    ['x402 transfer not adjacent', x402Expect, [used(ANNON), transfer(BUYER, PAY_TO, 10_000n, 5)]],
    [
      'x402 transfer from someone else',
      x402Expect,
      [used(ANNON), transfer(`0x${'ad'.repeat(20)}`, PAY_TO, 10_000n, 4)],
    ],
    [
      'x402 authorization by someone else',
      x402Expect,
      [used(ANNON, `0x${'ad'.repeat(20)}`), transfer(BUYER, PAY_TO, 10_000n, 4)],
    ],
    [
      'x402 logs from another token',
      x402Expect,
      [
        { ...used(ANNON), address: getAddress(`0x${'99'.repeat(20)}`) },
        transfer(BUYER, PAY_TO, 10_000n, 4),
      ],
    ],
    ['x402 without the Transfer', x402Expect, [used(ANNON)]],
    [
      'x402 followed by another event',
      x402Expect,
      [
        used(ANNON),
        {
          ...transfer(BUYER, PAY_TO, 10_000n, 4),
          topics: [
            keccak256(encodePacked(['string'], ['Approval(address,address,uint256)'])),
            ...transfer(BUYER, PAY_TO, 10_000n, 4).topics.slice(1),
          ],
        },
      ],
    ],
    [
      'x402 Transfer from another token',
      x402Expect,
      [
        used(ANNON),
        { ...transfer(BUYER, PAY_TO, 10_000n, 4), address: getAddress(`0x${'99'.repeat(20)}`) },
      ],
    ],
    [
      'x402 Transfer from another transaction',
      x402Expect,
      [
        used(ANNON),
        { ...transfer(BUYER, PAY_TO, 10_000n, 4), transactionHash: `0x${'dd'.repeat(32)}` },
      ],
    ],
    [
      'x402 transfer with extra data',
      x402Expect,
      [
        used(ANNON),
        {
          ...transfer(BUYER, PAY_TO, 10_000n, 4),
          data: `${transfer(BUYER, PAY_TO, 10_000n, 4).data}${'00'.repeat(32)}`,
        },
      ],
    ],
  ];
  for (const [name, e, logs, s] of refused) {
    it(`finds nothing in: ${name}`, () => {
      expect(paymentLogs(receipt(logs, s), e)).toBeNull();
    });
  }
});

describe('status', () => {
  /** A recorded purchase with one attempt: its search start and deadline. */
  const job = (
    over: { block?: number; validBefore?: string; payload?: string } = {},
  ): PurchaseRecord => ({
    schemaVersion: 2,
    purchase: sample,
    message: '',
    buyerSecret: '',
    quote: null,
    recovery: sample.recovery,
    checkedHeaderHash: sample.terms_hash,
    id: 'purchase-1',
    revision: 1,
    terms: {
      network: 'eip155:8453',
      contractId: CONTRACT,
      fileId: FILE,
      buyer: BUYER,
      seller: SELLER,
      to: PAY_TO,
      usdc: USDC,
      price: '10000',
      buyerKey: hex(buyerKey),
      nonce: ANNON,
      headerHash: sha256(HEADER),
      cipherHash: CIPHER_HASH,
      moderator: null,
    },
    attempts: [
      {
        attemptId: 'attempt-1',
        preparedAt: NOW,
        searchFromBlock: over.block ?? SIGNED,
        validBefore: over.validBefore ?? String(NOW + 300),
        paymentRequired: required(),
        ...(over.payload ? { payload: over.payload } : {}),
      },
    ],
  });
  const atBlock = (l: RpcLog, n: number) => ({ ...l, blockNumber: `0x${n.toString(16)}` });
  const getLogsQuery = () =>
    vi
      .mocked(fetch)
      .mock.calls.map(([, i]) => JSON.parse(String(i?.body)))
      .filter((b) => b.method === 'eth_getLogs')
      .at(-1)?.params[0];

  it('finds the payment by its nonce alone, without the transaction hash', async () => {
    w.head = at(SIGNED + 50);
    w.getLogs = [atBlock(used(ANNON), SIGNED + 20)];
    w.receipt = receipt(x402Receipt());
    expect(await status(BASE, job())).toMatchObject({ state: 'paid', txHash: TX, logIndex: 3 });
  });

  it('finds a payment that lands at the end of its window at five blocks a second', async () => {
    // 299 s after signing is block SIGNED + 1495; the old one-block-a-second bound missed it.
    w.head = at(SIGNED + 100_000);
    w.getLogs = [atBlock(used(ANNON), SIGNED + 1495)];
    w.receipt = receipt(x402Receipt());
    expect(await status(BASE, job())).toMatchObject({ state: 'paid' });
    const q = getLogsQuery();
    expect(q).toMatchObject({
      address: USDC,
      fromBlock: `0x${SIGNED.toString(16)}`,
      topics: [
        [expect.any(String), expect.any(String)],
        encodeAbiParameters([{ type: 'address' }], [BUYER as `0x${string}`]),
        ANNON,
      ],
    });
    // It stops at the first block at or past validBefore, not at the head.
    expect(at(Number(q.toBlock)).timestamp).toBeGreaterThanOrEqual(NOW + 300);
    expect(Number(q.toBlock)).toBeLessThan(SIGNED + 100_000);
  });

  it('searches further when Base runs faster than the first guess', async () => {
    // Twenty blocks a second: the window ends at block SIGNED + 6000.
    w.head = at(SIGNED + 100_000);
    const fast = (n: number) => ({ number: n, timestamp: NOW + Math.floor((n - SIGNED) / 20) });
    const respondFast = vi.mocked(fetch).getMockImplementation();
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      const b = JSON.parse(String(init?.body));
      if (
        b.method === 'eth_getBlockByNumber' &&
        typeof b.params[0] === 'string' &&
        b.params[0].startsWith('0x')
      ) {
        const f = fast(Number(b.params[0]));
        return {
          json: async () => ({
            id: b.id,
            result: { number: b.params[0], timestamp: `0x${f.timestamp.toString(16)}` },
          }),
        } as Response;
      }
      return (respondFast as typeof fetch)(url, init);
    });
    w.getLogs = [atBlock(used(ANNON), SIGNED + 5990)];
    w.receipt = receipt(x402Receipt());
    expect(await status(BASE, job())).toMatchObject({ state: 'paid' });
  });

  it('stays pending until the finalized chain is past validBefore, then expires', async () => {
    w.head = at(SIGNED + 1499);
    w.finalized = at(SIGNED - 100);
    expect(await status(BASE, job())).toEqual({ state: 'pending' });
    // The head is past validBefore, but a reorg could still bring the payment in.
    w.head = at(SIGNED + 1600);
    expect(await status(BASE, job())).toEqual({ state: 'pending' });
    w.finalized = at(SIGNED + 1499);
    expect(await status(BASE, job())).toEqual({ state: 'pending' });
    w.finalized = at(SIGNED + 1500);
    expect(await status(BASE, job())).toEqual({ state: 'expired' });
  });

  const canceledLog = (from = BUYER, nonce = ANNON) =>
    rpcLog(
      USDC,
      encodeEventTopics({
        abi: USDC_ABI,
        eventName: 'AuthorizationCanceled',
        args: { authorizer: from as `0x${string}`, nonce: nonce as `0x${string}` },
      }) as string[],
      '0x',
      1,
    );

  it('reports a cancellation only once it is finalized', async () => {
    w.head = at(SIGNED + 2000);
    w.getLogs = [atBlock(canceledLog(), SIGNED + 10)];
    w.finalized = at(SIGNED + 9);
    expect(await status(BASE, job())).toEqual({ state: 'pending' });
    w.finalized = at(SIGNED + 10);
    expect(await status(BASE, job())).toEqual({ state: 'canceled' });
  });

  it('searches every attempt: from the earliest block to the latest deadline', async () => {
    const two = job({ block: SIGNED + 50, validBefore: String(NOW + 100) });
    two.attempts.push({
      ...(two.attempts[0] as PurchaseRecord['attempts'][number]),
      attemptId: 'attempt-2',
      searchFromBlock: SIGNED,
      validBefore: String(NOW + 300),
    });
    w.head = at(SIGNED + 2000);
    // Past the first deadline, not the second: still pending.
    w.finalized = at(SIGNED + 1000);
    expect(await status(BASE, two)).toEqual({ state: 'pending' });
    expect(Number(getLogsQuery().fromBlock)).toBe(SIGNED);
    w.finalized = at(SIGNED + 1500);
    expect(await status(BASE, two)).toEqual({ state: 'expired' });
  });

  it('never calls a payment expired that landed while it was reading the chain', async () => {
    // The payment lands, and finalized passes the deadline, between the SDK's reads.
    let moved = false;
    w.onTag = (tag) => {
      if (tag !== 'finalized' || moved) return;
      moved = true;
      w.head = at(SIGNED + 2000);
      w.getLogs = [atBlock(used(ANNON), SIGNED + 1400)];
      w.receipt = receipt(x402Receipt().map((l) => atBlock(l, SIGNED + 1400)));
      w.finalized = at(SIGNED + 2000);
    };
    expect(await status(BASE, job())).toMatchObject({ state: 'paid' });
  });

  it('finds a cancellation made after the deadline, and counts it once finalized', async () => {
    const late = atBlock(canceledLog(), SIGNED + 1700);
    w.head = at(SIGNED + 2500);
    w.getLogs = [late];
    w.authorizationState = true;
    w.finalized = at(SIGNED + 1699);
    expect(await status(BASE, job())).toEqual({ state: 'pending' });
    w.finalized = at(SIGNED + 1700);
    expect(await status(BASE, job())).toEqual({ state: 'canceled' });
  });

  it('never calls a used authorization expired, even when the RPC misses its log', async () => {
    w.authorizationState = true;
    w.head = at(SIGNED + 2000);
    w.finalized = at(SIGNED + 2000);
    expect(await codeOf(status(BASE, job()))).toBe('transport');
  });

  it('refuses a used authorization whose transaction is not this purchase', async () => {
    w.head = at(SIGNED + 50);
    w.getLogs = [atBlock(used(ANNON), SIGNED + 20)];
    w.receipt = receipt([used(ANNON), transfer(BUYER, `0x${'99'.repeat(20)}`, 10_000n, 4)]);
    expect(await codeOf(status(BASE, job()))).toBe('transport');
    // The right logs, but in a receipt for another transaction.
    w.receipt = { ...receipt(x402Receipt()), transactionHash: `0x${'dd'.repeat(32)}` };
    expect(await codeOf(status(BASE, job()))).toBe('transport');
    // A whole, consistent receipt, but of another transaction than the log points at.
    const other = `0x${'dd'.repeat(32)}`;
    w.receipt = {
      ...receipt(x402Receipt().map((l) => ({ ...l, transactionHash: other }))),
      transactionHash: other,
    };
    expect(await codeOf(status(BASE, job()))).toBe('transport');
  });

  it('refuses logs the query did not ask for: another token, buyer, nonce, event or block', async () => {
    w.honest = false;
    w.head = at(SIGNED + 2000);
    w.finalized = at(SIGNED + 2000);
    for (const l of [
      atBlock({ ...used(ANNON), address: getAddress(`0x${'99'.repeat(20)}`) }, SIGNED + 10),
      atBlock(canceledLog(`0x${'ad'.repeat(20)}`), SIGNED + 10),
      atBlock(canceledLog(BUYER, `0x${'ee'.repeat(32)}`), SIGNED + 10),
      atBlock(transfer(BUYER, PAY_TO, 10_000n, 4), SIGNED + 10),
      atBlock({ ...canceledLog(), address: getAddress(`0x${'99'.repeat(20)}`) }, SIGNED + 10),
      atBlock(
        { ...canceledLog(), topics: [...canceledLog().topics, `0x${'00'.repeat(32)}`] },
        SIGNED + 10,
      ),
      atBlock(
        {
          ...canceledLog(),
          topics: [
            keccak256(encodePacked(['string'], ['Approval(address,address,uint256)'])),
            ...canceledLog().topics.slice(1),
          ],
        },
        SIGNED + 10,
      ),
      atBlock(canceledLog(), SIGNED - 1),
      atBlock(canceledLog(), SIGNED + 5000),
    ]) {
      w.getLogs = [l];
      expect(await codeOf(status(BASE, job()))).toBe('transport');
    }
  });
});

// ---------- block headers: real Base blocks, checked against their real hashes ----------

const headers = JSON.parse(
  readFileSync(new URL('../../../../specs/vectors/base-headers.json', import.meta.url), 'utf8'),
) as { cases: { number: number; hash: string; json: Record<string, string>; rlp: string }[] };

describe('blockHeader', () => {
  it('rebuilds real Base headers, before and after Denim, byte for byte', async () => {
    for (const c of headers.cases) {
      vi.mocked(fetch).mockImplementationOnce(async (_u, init) => {
        const b = JSON.parse(String(init?.body));
        expect(b).toMatchObject({ method: 'eth_getBlockByHash', params: [c.hash, false] });
        // The RPC also returns fields that are not hashed, like timestampMs since Denim.
        const result = {
          ...c.json,
          hash: c.hash,
          size: '0x1',
          timestampMs: '0x1',
          transactions: [],
        };
        return { json: async () => ({ id: b.id, result }) } as Response;
      });
      expect(await blockHeader(BASE, c.hash)).toBe(c.rlp);
    }
  });

  it('refuses a header it cannot rebuild exactly', async () => {
    const c = headers.cases[4];
    if (!c) throw new Error('vectors');
    for (const json of [
      { ...c.json, gasUsed: '0x1' },
      { ...c.json, requestsHash: undefined },
      { ...c.json, extraData: '0x00' },
    ]) {
      vi.mocked(fetch).mockImplementationOnce(async (_u, init) => {
        const b = JSON.parse(String(init?.body));
        return { json: async () => ({ id: b.id, result: json }) } as Response;
      });
      expect(await codeOf(blockHeader(BASE, c.hash))).toBe('transport');
    }
  });
});

// ---------- x402 v2 envelope ----------
