import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { isDeepStrictEqual } from 'node:util';
import { bls12_381 as bls } from '@noble/curves/bls12-381.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { x402Client } from '@x402/core/client';
import {
  decodePaymentResponseHeader,
  decodePaymentSignatureHeader,
  encodePaymentRequiredHeader,
  encodePaymentResponseHeader,
} from '@x402/core/http';
import { parsePaymentPayload, parsePaymentRequired } from '@x402/core/schemas';
import type { SettleResponse as X402SettleResponse } from '@x402/core/types';
import { registerExactEvmScheme } from '@x402/evm/exact/client';
import { ExactEvmScheme } from '@x402/evm/exact/facilitator';
import {
  isValidIconUrl,
  sanitizeTags,
  validateDiscoveryExtension,
  validateDiscoveryExtensionSpec,
} from '@x402/extensions/bazaar';
import {
  BuilderCodeFacilitatorExtension,
  declareBuilderCodeExtension,
  parseBuilderCodeSuffixFromCalldata,
} from '@x402/extensions/builder-code';
import {
  declarePaymentIdentifierExtension,
  extractPaymentIdentifier,
  isValidPaymentId,
} from '@x402/extensions/payment-identifier';
import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  encodePacked,
  getAddress,
  hashTypedData,
  hexToBytes,
  keccak256,
  parseAbi,
  recoverTypedDataAddress,
  sha256,
  verifyTypedData,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { download } from '../download/download.js';
import { type HostRecord, serveFile } from '../download/host.js';
import { nodeHandler } from '../download/http.js';
import { buyerProof } from '../download/proof.js';
import { signInHeader, signInMessage } from '../download/siwx.js';
import { inspect, inspectHeader, publishText, seal } from '../envelope/pay2.js';
import { blockHeader, type Expected, PayError, paymentLogs } from './base.js';
import { type Authorization, annonNonce, digest, signer, typedData } from './eip3009.js';
import {
  authorize,
  MAX_CLOCK_SKEW_SECONDS,
  MAX_VALIDITY_SECONDS,
  preflight,
  status,
} from './pay.js';
import { type PurchaseRecord, purchaseKey } from './purchase.js';
import { nextStep } from './recover.js';
import { checkPayment, forFacilitator, offerFor, verifyPayment } from './seller.js';
import {
  paymentResponse,
  RETRY_SECONDS,
  type SellerRecord,
  type SettleResponse,
  settle,
} from './settle.js';
import { memoryStore } from './store.js';
import { discover, type PaymentRequired, paymentSignature, readPaymentRequired } from './x402.js';

const USDC_ABI = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function authorizationState(address,bytes32) view returns (bool)',
  'function transferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce,uint8 v,bytes32 r,bytes32 s)',
  'event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)',
  'event AuthorizationCanceled(address indexed authorizer, bytes32 indexed nonce)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
]);

const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
/** The real fetch, for the HTTP tests: the simulated chains replace the global one. */
const realFetch = globalThis.fetch;
const buyerAccount = privateKeyToAccount(`0x${'42'.repeat(32)}`);
const otherAccount = privateKeyToAccount(`0x${'43'.repeat(32)}`);
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

const nonces = JSON.parse(
  readFileSync(new URL('../../../../specs/vectors/nonce.json', import.meta.url), 'utf8'),
) as {
  cases: {
    contractId: string;
    fileId: string;
    buyerKey: string;
    annonNonce: string;
  }[];
};

describe('nonces against the shared vectors', () => {
  it('derives annonNonce as the contract does, and as viem computes it independently', () => {
    for (const c of nonces.cases) {
      const key = Uint8Array.from(Buffer.from(c.buyerKey.slice(2), 'hex'));
      expect(annonNonce(c.contractId, c.fileId, key)).toBe(c.annonNonce);
      expect(
        keccak256(
          encodePacked(
            ['string', 'string', 'bytes32', 'bytes'],
            ['annon/v1', c.contractId, c.fileId as `0x${string}`, c.buyerKey as `0x${string}`],
          ),
        ),
      ).toBe(c.annonNonce);
    }
  });
});

// ---------- a simulated NEAR and Base ----------

const NEAR = 'https://near.rpc';
const BASE = 'https://base.rpc';
const CONTRACT = 'v1.annon.defdone.near';
const FILE = `0x${'11'.repeat(32)}`;
const sellerAccount = privateKeyToAccount(`0x${'44'.repeat(32)}`);
const SELLER = sellerAccount.address.toLowerCase();
const PAY_TO = `0x${'5e'.repeat(20)}`;
const NOW = 1_800_000_000;
// A real PAY2 file for FILE, sealed and signed by the seller; the registration below carries its
// cipherHash, so the header check in preflight and authorize passes only for these bytes.
const headerLength = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset).getUint32(8);
const sealFor = async (contractId: string, signer = sellerAccount) => {
  const s = await seal(new TextEncoder().encode('the paid file'), {
    fileId: Uint8Array.from(Buffer.from(FILE.slice(2), 'hex')),
    name: 'f.txt',
    mime: 'text/plain',
  });
  const pay2 = await s.finish({
    contractId,
    ckdSecret: bls.G1.Point.BASE.multiply(5n).toBytes(true),
    seller: signer.address,
    sign: (message) => signer.signMessage({ message }),
  });
  return {
    pay2,
    header: pay2.subarray(0, headerLength(pay2)),
    cipherHash: `0x${Buffer.from(s.cipherHash).toString('hex')}`,
  };
};
const {
  pay2: PAY2,
  header: HEADER,
  cipherHash: CIPHER_HASH,
} = await sealFor('v1.annon.defdone.near');
const SIGNED = 0x3000000;
/** Base since Denim: five blocks a second. */
const at = (n: number) => ({ number: n, timestamp: NOW + Math.floor((n - SIGNED) / 5) });
const buyerKey = bls.G1.Point.BASE.multiply(7n).toBytes(true);

type World = {
  /** The contract the simulated NEAR has; the default is CONTRACT. */
  contract?: string;
  file: Record<string, unknown> | null;
  config: Record<string, unknown>;
  isBuyer: boolean;
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
  /** `is_payment_used` for the test payment (TX, log 3). */
  paymentUsed?: boolean;
};
let w: World;

const file = (over: Record<string, unknown> = {}) => ({
  seller: SELLER,
  price: '10000',
  pay_to: PAY_TO,
  cipher_hash: CIPHER_HASH,
  moderator: null,
  sales_stopped_at: null,
  taken_down: null,
  ...over,
});
/** The offer a server makes for the test file: plain EIP-3009 to the registered pay_to. */
const offer = (over: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => ({
  scheme: 'annon-exact',
  network: 'eip155:8453',
  amount: '10000',
  payTo: getAddress(PAY_TO),
  maxTimeoutSeconds: 300,
  asset: getAddress(USDC),
  extra: { name: 'USD Coin', version: '2', ...extra },
  ...over,
});
const annonInfo = (over: Record<string, unknown> = {}) => ({
  version: 1,
  network: 'near:mainnet',
  contract: CONTRACT,
  fileId: FILE,
  ...over,
});
const required = (...accepts: unknown[]): PaymentRequired =>
  ({
    x402Version: 2,
    resource: { url: 'https://seller.example/f/1' },
    accepts: accepts.length ? accepts : [offer()],
    extensions: { annon: { info: annonInfo(), schema: { type: 'object' } } },
  }) as PaymentRequired;
const withInfo = (info: Record<string, unknown> | undefined, ...accepts: unknown[]) => {
  const pr = required(...accepts);
  return { ...pr, extensions: info ? { annon: { info, schema: {} } } : {} } as PaymentRequired;
};

const AUTH_FIELDS = [
  { name: 'from', type: 'address' },
  { name: 'to', type: 'address' },
  { name: 'value', type: 'uint256' },
  { name: 'validAfter', type: 'uint256' },
  { name: 'validBefore', type: 'uint256' },
  { name: 'nonce', type: 'bytes32' },
] as const;

async function respond(
  url: string,
  body: { id: string; method: string; params: unknown[] | Record<string, unknown> },
) {
  const reply = (result: unknown) => ({ id: body.id, result });
  if (url === NEAR) {
    const p = body.params as {
      method_name: string;
      args_base64: string;
      account_id: string;
      finality: string;
    };
    // Only the trusted contract, at final state, about this file, gets an answer.
    const args = JSON.parse(Buffer.from(p.args_base64, 'base64').toString());
    w.calls.push({ method: `near:${p.method_name}` });
    w.onNear?.();
    if (p.account_id !== (w.contract ?? CONTRACT) || p.finality !== 'final') {
      return { id: body.id, error: { cause: { name: 'UNKNOWN_ACCOUNT' } } };
    }
    if (p.method_name === 'is_payment_used') {
      const ours = args.base_tx === TX && args.log_index === 3;
      return reply({ result: [...Buffer.from(String(ours && w.paymentUsed === true))] });
    }
    if (p.method_name !== 'get_config' && args.file_id !== FILE) {
      return reply({ result: [...Buffer.from('null')] });
    }
    if (p.method_name === 'is_buyer' && args.wallet !== BUYER) {
      return reply({ result: [...Buffer.from('false')] });
    }
    const views: Record<string, unknown> = {
      get_file: w.file,
      get_config: w.config,
      is_buyer: w.isBuyer,
    };
    const bytes = [...Buffer.from(JSON.stringify(views[p.method_name] ?? null))];
    return reply({ result: bytes });
  }
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
    isBuyer: false,
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

const opts = (over: Record<string, unknown> = {}) => ({
  nearRpc: NEAR,
  baseRpc: BASE,
  contractId: CONTRACT,
  fileId: FILE,
  buyer: buyerAccount.address,
  paymentRequired: required(),
  pay2: HEADER,
  maxPrice: 10_000n,
  ...over,
  url:
    (over.url as string | undefined) ??
    (((over.paymentRequired ?? required()) as { resource?: { url?: string } }).resource
      ?.url as string),
});
const codeOf = (p: Promise<unknown>) =>
  p.then(
    () => 'ok',
    (e: unknown) =>
      e instanceof PayError ? e.code : `${(e as Error).name}: ${(e as Error).message}`,
  );

describe('preflight', () => {
  it('takes a 402 only for the URL that answered with it (download.md section 3)', async () => {
    const at = 'https://seller.example/f/1';
    expect((await preflight(opts({ url: 'HTTPS://SELLER.EXAMPLE:443/f/1#x' }))).fileId).toBe(FILE);
    for (const url of ['https://evil.example/f/1', 'https://seller.example/f/2', 'not a url']) {
      expect(await codeOf(preflight(opts({ url })))).toBe('bad_requirements');
    }
    const bare = { ...required(), resource: undefined };
    expect(await codeOf(preflight(opts({ paymentRequired: bare, url: at })))).toBe(
      'bad_requirements',
    );
  });

  it('quotes a file: a transfer to the registered pay_to, at the registered price', async () => {
    const q = await preflight(opts());
    expect(q).toMatchObject({
      to: PAY_TO,
      seller: SELLER,
      buyer: BUYER,
      usdc: USDC,
      price: 10_000n,
      validity: 180,
    });
  });

  // Each row breaks one thing; the purchase must stop with that code before anything is signed.
  const refusals: [string, string, () => unknown][] = [
    [
      'no Base offer',
      'network_mismatch',
      () => opts({ paymentRequired: required(offer({ network: 'eip155:84532' })) }),
    ],
    [
      'two Base offers',
      'network_mismatch',
      () => opts({ paymentRequired: required(offer(), offer()) }),
    ],
    [
      'another scheme',
      'network_mismatch',
      () => opts({ paymentRequired: required(offer({ scheme: 'upto' })) }),
    ],
    [
      'another contract',
      'file_mismatch',
      () => opts({ paymentRequired: withInfo(annonInfo({ contract: 'evil.near' })) }),
    ],
    [
      'another file',
      'file_mismatch',
      () => opts({ paymentRequired: withInfo(annonInfo({ fileId: `0x${'12'.repeat(32)}` })) }),
    ],
    [
      'an offer under another scheme',
      'network_mismatch',
      () => {
        w.file = file();
        return opts({ paymentRequired: required(offer({ scheme: 'upto' })) });
      },
    ],
    [
      'x402 offer through Permit2',
      'method_mismatch',
      () => {
        w.file = file();
        return opts({
          paymentRequired: required(offer({}, { assetTransferMethod: 'permit2' })),
        });
      },
    ],
    [
      'no timeout',
      'bad_requirements',
      () => opts({ paymentRequired: required(offer({ maxTimeoutSeconds: 0 })) }),
    ],
    [
      'amount not decimal',
      'bad_requirements',
      () => opts({ paymentRequired: required(offer({ amount: '0x2710' })) }),
    ],
    [
      'unregistered',
      'unknown_file',
      () => {
        w.file = null;
      },
    ],
    [
      'taken down',
      'taken_down',
      () => {
        w.file = file({ taken_down: 'court_order' });
      },
    ],
    [
      'sales stopped',
      'sales_stopped',
      () => {
        w.file = file({ sales_stopped_at: NOW - 10 });
      },
    ],
    [
      'unknown moderator',
      'unknown_moderator',
      () => {
        w.file = file({ moderator: 'mod.sputnik-dao.near' });
      },
    ],
    [
      'moderator trusted elsewhere',
      'unknown_moderator',
      () => {
        w.file = file({ moderator: 'mod.sputnik-dao.near' });
        return opts({ moderators: ['other.sputnik-dao.near'] });
      },
    ],
    [
      'another token',
      'token_mismatch',
      () => opts({ paymentRequired: required(offer({ asset: `0x${'99'.repeat(20)}` })) }),
    ],
    [
      'another EIP-712 name',
      'token_mismatch',
      () => opts({ paymentRequired: required(offer({}, { name: 'USDC' })) }),
    ],
    [
      'another EIP-712 version',
      'token_mismatch',
      () => opts({ paymentRequired: required(offer({}, { version: '1' })) }),
    ],
    [
      'Partner pays the seller directly',
      'recipient_mismatch',
      () => opts({ paymentRequired: required(offer({ payTo: SELLER })) }),
    ],
    [
      'x402 pays someone else',
      'recipient_mismatch',
      () => {
        w.file = file();
        return opts({ paymentRequired: required(offer({ payTo: `0x${'99'.repeat(20)}` })) });
      },
    ],
    [
      'no EIP-712 name',
      'token_mismatch',
      () => opts({ paymentRequired: required(offer({}, { name: undefined })) }),
    ],
    [
      'no EIP-712 version',
      'token_mismatch',
      () => opts({ paymentRequired: required(offer({}, { version: undefined })) }),
    ],
    [
      'an unknown payment flow',
      'method_mismatch',
      () => opts({ paymentRequired: required(offer({}, { paymentFlow: 'escrow' })) }),
    ],
    [
      'a v1 offer that settles before serving',
      'method_mismatch',
      () => opts({ paymentRequired: required(offer({}, { paymentFlow: 'upfront' })) }),
    ],
    [
      'a v1.1 offer without upfront',
      'method_mismatch',
      () => opts({ paymentRequired: withInfo(annonInfo({ version: 2 }), offer()) }),
    ],
    [
      'a v1.1 offer that settles after serving',
      'method_mismatch',
      () =>
        opts({
          paymentRequired: withInfo(
            annonInfo({ version: 2 }),
            offer({}, { paymentFlow: 'authorization' }),
          ),
        }),
    ],
    [
      'a split in the payment itself',
      'method_mismatch',
      () =>
        opts({
          paymentRequired: required(
            offer({}, { splits: [{ payTo: `0x${'99'.repeat(20)}`, bps: 500 }] }),
          ),
        }),
    ],
    [
      'higher price asked',
      'price_mismatch',
      () => opts({ paymentRequired: required(offer({ amount: '10001' })) }),
    ],
    [
      'lower price asked',
      'price_mismatch',
      () => opts({ paymentRequired: required(offer({ amount: '9999' })) }),
    ],
    ['above the limit', 'price_above_max', () => opts({ maxPrice: 9_999n })],
    [
      'already bought',
      'already_bought',
      () => {
        w.isBuyer = true;
      },
    ],
    [
      'RPC on another chain',
      'network_mismatch',
      () => {
        w.chainId = '0x14a34';
      },
    ],
    [
      'smart wallet',
      'smart_wallet_unsupported',
      () => {
        w.code = '0x6080';
      },
    ],
    [
      'EIP-7702 delegated',
      'smart_wallet_unsupported',
      () => {
        w.code = `0xef0100${'77'.repeat(20)}`;
      },
    ],
    [
      'not enough USDC',
      'insufficient_balance',
      () => {
        w.balance = 9_999n;
      },
    ],
  ];
  for (const [name, code, change] of refusals) {
    it(`refuses: ${name}`, async () => {
      const o = (change() as ReturnType<typeof opts> | undefined) ?? opts();
      expect(await codeOf(preflight(o))).toBe(code);
    });
  }

  it('takes a v1.1 offer that settles first, and an empty splits list', async () => {
    const v11 = withInfo(
      annonInfo({ version: 2 }),
      offer({}, { paymentFlow: 'upfront', splits: [] }),
    );
    expect(await codeOf(preflight(opts({ paymentRequired: v11 })))).toBe('ok');
  });

  it('reads the contract it was given, not the mainnet one', async () => {
    w.contract = 'annon-dev.synthetic.near';
    const dev = await sealFor('annon-dev.synthetic.near');
    w.file = file({ cipher_hash: dev.cipherHash });
    const pr = withInfo(annonInfo({ contract: 'annon-dev.synthetic.near' }));
    const q = await preflight(
      opts({ contractId: 'annon-dev.synthetic.near', paymentRequired: pr, pay2: dev.header }),
    );
    expect(q.contractId).toBe('annon-dev.synthetic.near');
  });

  it('accepts a moderator the buyer trusts, and caps the validity at 180 s', async () => {
    w.file = file({ moderator: 'mod.sputnik-dao.near' });
    const q = await preflight(
      opts({
        moderators: ['mod.sputnik-dao.near'],
        paymentRequired: required(offer({ maxTimeoutSeconds: 3600 })),
      }),
    );
    expect(q.validity).toBe(MAX_VALIDITY_SECONDS);
    w.file = file();
    expect(
      (await preflight(opts({ paymentRequired: required(offer({ maxTimeoutSeconds: 60 })) })))
        .validity,
    ).toBe(60);
  });

  it('takes the price and the recipient from the contract, whatever case the request uses', async () => {
    const q = await preflight(
      opts({
        paymentRequired: required(offer({ payTo: PAY_TO.toUpperCase().replace('0X', '0x') })),
      }),
    );
    expect(q).toMatchObject({ seller: SELLER, to: PAY_TO });
  });
});

/**
 * A server's check of PAYMENT-SIGNATURE under the Annon profile (specs/x402-annon.md, section 3),
 * written with viem and from the spec, not from the SDK: the offer echoed, the extension echoed
 * with a buyer key, the nonce recomputed from that key, the signature recovered.
 */
async function serverVerify(header: string, pr: PaymentRequired) {
  const p = JSON.parse(Buffer.from(header, 'base64').toString('utf8'));
  const req = pr.accepts[0] as ReturnType<typeof offer>;
  if (p.x402Version !== 2) return 'not_v2';
  if (!isDeepStrictEqual(p.accepted, JSON.parse(JSON.stringify(req)))) return 'offer_changed';
  const info = p.extensions?.annon?.info;
  const advertised = pr.extensions?.annon?.info ?? {};
  for (const [k, v] of Object.entries(advertised)) if (info?.[k] !== v) return 'extension_changed';
  if (!/^0x[0-9a-f]{96}$/.test(info?.buyerKey ?? '')) return 'no_buyer_key';
  const annon = keccak256(
    encodePacked(
      ['string', 'string', 'bytes32', 'bytes'],
      ['annon/v1', info.contract, info.fileId, info.buyerKey],
    ),
  );
  const a = p.payload.authorization;
  if (a.nonce !== annon) return 'nonce_not_annon';
  const primaryType = 'TransferWithAuthorization';
  const recovered = await recoverTypedDataAddress({
    domain: {
      name: req.extra.name,
      version: req.extra.version,
      chainId: 8453,
      verifyingContract: req.asset as `0x${string}`,
    },
    types: {
      [primaryType]: [
        { name: 'from', type: 'address' },
        { name: 'to', type: 'address' },
        { name: 'value', type: 'uint256' },
        { name: 'validAfter', type: 'uint256' },
        { name: 'validBefore', type: 'uint256' },
        { name: 'nonce', type: 'bytes32' },
      ],
    },
    primaryType,
    message: {
      ...a,
      value: BigInt(a.value),
      validAfter: BigInt(a.validAfter),
      validBefore: BigInt(a.validBefore),
    },
    signature: p.payload.signature,
  });
  if (recovered.toLowerCase() !== a.from.toLowerCase()) return 'invalid_signature';
  if (a.to.toLowerCase() !== req.payTo.toLowerCase()) return 'invalid_recipient';
  if (a.value !== req.amount) return 'amount_mismatch';
  return { ok: true, payload: p };
}

describe('the PAY2 check before signing (profile section 7)', () => {
  it('quotes the registered file with its exact header, and nothing else', async () => {
    const q = await preflight(opts());
    expect(Buffer.from(q.header).equals(Buffer.from(HEADER))).toBe(true);
  });

  it('hashes exactly the header, whether it gets the header or the whole file', async () => {
    const listing = { fileId: FILE, cipherHash: CIPHER_HASH, seller: SELLER };
    for (const r of [
      await inspect(PAY2, listing, CONTRACT),
      await inspectHeader(HEADER, listing, CONTRACT),
    ]) {
      expect(hex(r.headerHash)).toBe(sha256(HEADER));
      expect(Buffer.from(r.header).equals(Buffer.from(HEADER))).toBe(true);
    }
  });

  it('refuses a header with any byte changed', async () => {
    for (let i = 0; i < HEADER.length; i++) {
      const bad = Uint8Array.from(HEADER);
      bad[i] = (bad[i] as number) ^ (1 << (i % 8));
      expect(await codeOf(preflight(opts({ pay2: bad }))), `byte ${i}`).not.toBe('ok');
    }
  });

  it('refuses another file, another seller, a cut header, and body bytes after it', async () => {
    const other = await sealFor(CONTRACT);
    const stranger = await sealFor(CONTRACT, otherAccount);
    w.file = file({ cipher_hash: stranger.cipherHash });
    expect(await codeOf(preflight(opts({ pay2: stranger.header })))).toBe('file_invalid');
    w.file = file();
    for (const pay2 of [
      other.header,
      HEADER.subarray(0, HEADER.length - 1),
      PAY2,
      new Uint8Array(0),
    ]) {
      expect(await codeOf(preflight(opts({ pay2 })))).toBe('file_invalid');
    }
  });

  it('refuses a header whose only key is for another contract, even if signed for this one', async () => {
    const elsewhere = await sealFor('other.near');
    const h = Uint8Array.from(elsewhere.header);
    const signed = h.subarray(0, h.length - 65);
    const text = publishText(CONTRACT, h.subarray(12, 44), hexToBytes(sha256(signed)));
    h.set(hexToBytes(await sellerAccount.signMessage({ message: text })), h.length - 65);
    w.file = file({ cipher_hash: elsewhere.cipherHash });
    expect(await codeOf(preflight(opts({ pay2: h })))).toBe('file_invalid');
  });

  it('checks the whole file when the seller publishes the body', async () => {
    const pr = withInfo({ ...annonInfo(), public: true });
    const q = await preflight(opts({ paymentRequired: pr, pay2: PAY2 }));
    expect(Buffer.from(q.header).equals(Buffer.from(HEADER))).toBe(true);
    expect(await codeOf(preflight(opts({ paymentRequired: pr, pay2: HEADER })))).toBe(
      'file_invalid',
    );
    const bad = Uint8Array.from(PAY2);
    bad[bad.length - 1] = (bad[bad.length - 1] as number) ^ 1;
    expect(await codeOf(preflight(opts({ paymentRequired: pr, pay2: bad })))).toBe('file_invalid');
  });

  it('authorize checks the header again and never asks the wallet without it', async () => {
    const q = await preflight(opts());
    const wallet = {
      address: buyerAccount.address,
      signTypedData: vi.fn((t: ReturnType<typeof typedData>) =>
        buyerAccount.signTypedData(asViem(t)),
      ),
    };
    const bad = Uint8Array.from(HEADER);
    bad[60] = (bad[60] as number) ^ 1;
    // Only the seller's signature changed: the registration still matches.
    const badSig = Uint8Array.from(HEADER);
    badSig[HEADER.length - 10] = (badSig[HEADER.length - 10] as number) ^ 1;
    const store = memoryStore<PurchaseRecord>();
    const cas = vi.spyOn(store, 'compareAndSet');
    for (const header of [bad, badSig, new Uint8Array(0)]) {
      expect(await codeOf(authorize({ ...q, header }, { buyerKey, wallet, store }))).toBe(
        'file_invalid',
      );
    }
    // A quote built by hand around a header signed for this contract but keyed for another.
    const elsewhere = await sealFor('other.near');
    const h = Uint8Array.from(elsewhere.header);
    const text = publishText(
      CONTRACT,
      h.subarray(12, 44),
      hexToBytes(sha256(h.subarray(0, h.length - 65))),
    );
    h.set(hexToBytes(await sellerAccount.signMessage({ message: text })), h.length - 65);
    w.file = file({ cipher_hash: elsewhere.cipherHash });
    const keyless = { ...q, header: h, file: { ...q.file, cipherHash: elsewhere.cipherHash } };
    expect(await codeOf(authorize(keyless, { buyerKey, wallet, store }))).toBe('file_invalid');
    w.file = file({ cipher_hash: `0x${'22'.repeat(32)}` });
    expect(await codeOf(authorize(q, { buyerKey, wallet, store }))).toBe('price_mismatch');
    expect(wallet.signTypedData).not.toHaveBeenCalled();
    expect(cas).not.toHaveBeenCalled();
  });
});

describe('authorize', () => {
  const sign = (account = buyerAccount) => ({
    address: buyerAccount.address,
    signTypedData: vi.fn((t: ReturnType<typeof typedData>) => account.signTypedData(asViem(t))),
  });

  it('signs a payment a profile server accepts, bound to the file and the buyer key', async () => {
    const q = await preflight(opts());
    const wallet = sign();
    const { header, purchase } = await authorize(q, {
      buyerKey,
      wallet,
      store: memoryStore(),
    });
    const v = await serverVerify(header, required());
    expect(v).toMatchObject({ ok: true });
    const p = (
      v as {
        payload: {
          payload: { authorization: Record<string, string> };
          extensions: { annon: { info: Record<string, string> } };
        };
      }
    ).payload;
    expect(p.extensions.annon.info).toEqual({ ...annonInfo(), buyerKey: hex(buyerKey) });
    expect(p.payload.authorization).toMatchObject({
      from: BUYER,
      to: PAY_TO,
      value: '10000',
      validAfter: '0',
      validBefore: String(NOW + 180),
      nonce: annonNonce(CONTRACT, FILE, buyerKey),
    });
    // The search starts at the finalized block, not the head.
    expect(purchase.terms.buyerKey).toBe(hex(buyerKey));
    expect(purchase.attempts[0]).toMatchObject({ searchFromBlock: SIGNED - 5000, preparedAt: NOW });
  });

  it('dry-runs exactly the signed transferWithAuthorization against USDC', async () => {
    w.file = file();
    const req = offer();
    const q = await preflight(opts({ paymentRequired: required(req) }));
    const { header } = await authorize(q, {
      buyerKey,
      wallet: sign(),
      store: memoryStore(),
    });
    const v = await serverVerify(header, required(req));
    expect(v).toMatchObject({ ok: true });
    const p = (v as { payload: { payload: { authorization: Record<string, string> } } }).payload;
    expect(p.payload.authorization.nonce).toBe(annonNonce(CONTRACT, FILE, buyerKey));
    const dry = w.calls.filter((c) => c.method === 'eth_call').at(-1);
    expect(decodeFunctionData({ abi: USDC_ABI, data: dry?.data as `0x${string}` })).toMatchObject({
      functionName: 'transferWithAuthorization',
      args: [
        getAddress(BUYER),
        getAddress(PAY_TO),
        10_000n,
        0n,
        BigInt(NOW + 180),
        expect.any(String),
        expect.any(Number),
        expect.any(String),
        expect.any(String),
      ],
    });
  });

  it('records the purchase before the wallet is asked, and the payload before anything sees it', async () => {
    const q = await preflight(opts());
    const order: string[] = [];
    const wallet = sign();
    wallet.signTypedData.mockImplementation(async (t) => {
      order.push('sign');
      return buyerAccount.signTypedData(asViem(t));
    });
    const store = memoryStore<PurchaseRecord>();
    const cas = store.compareAndSet.bind(store);
    store.compareAndSet = async (key, expected, next) => {
      await new Promise((r) => setTimeout(r, 5));
      order.push(next?.attempts.at(-1)?.payload ? 'record payload' : 'record purchase');
      return cas(key, expected, next);
    };
    const realFetch = vi.mocked(fetch).getMockImplementation();
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      const b = JSON.parse(String((init as { body: string }).body));
      if (b.method === 'eth_call' && String(b.params[0].data).startsWith('0xe3ee160e'))
        order.push('dry run');
      return (realFetch as typeof fetch)(url, init);
    });
    const { header, purchase } = await authorize(q, { buyerKey, wallet, store });
    expect(order).toEqual(['record purchase', 'sign', 'record payload', 'dry run']);
    const saved = (await store.load(purchaseKey(CONTRACT, FILE, BUYER))) as PurchaseRecord;
    expect(saved).toEqual(purchase);
    expect(saved).toMatchObject({
      schemaVersion: 1,
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
    });
    expect(saved.attempts).toHaveLength(1);
    expect(saved.attempts[0]).toMatchObject({
      validBefore: String(NOW + 180),
      paymentRequired: required(),
      payload: header,
    });
    expect(saved.attempts[0]).not.toHaveProperty('paymentId');
  });

  it('refuses a quote that predates this wallet being recorded as a buyer (another tab)', async () => {
    const q = await preflight(opts());
    w.isBuyer = true;
    const wallet = sign();
    const store = memoryStore<PurchaseRecord>();
    expect(await codeOf(authorize(q, { buyerKey, wallet, store }))).toBe('already_bought');
    expect(wallet.signTypedData).not.toHaveBeenCalled();
    expect(await store.load(purchaseKey(CONTRACT, FILE, BUYER))).toBeNull();
  });

  it('checks the buyer again once it holds the slot: another tab may have just finished', async () => {
    const q = await preflight(opts());
    const wallet = sign();
    const store = memoryStore<PurchaseRecord>();
    const cas = store.compareAndSet.bind(store);
    store.compareAndSet = async (key, expected, next) => {
      const ok = await cas(key, expected, next);
      // The other tab's purchase is recorded on NEAR just as this tab claims the empty slot.
      if (expected === null && next) w.isBuyer = true;
      return ok;
    };
    expect(await codeOf(authorize(q, { buyerKey, wallet, store }))).toBe('already_bought');
    expect(wallet.signTypedData).not.toHaveBeenCalled();
    expect(await store.load(purchaseKey(CONTRACT, FILE, BUYER))).toBeNull();
  });

  it('never asks the wallet when the purchase cannot be recorded', async () => {
    const q = await preflight(opts());
    const never = sign();
    const store = memoryStore<PurchaseRecord>();
    store.compareAndSet = async () => {
      throw new Error('disk full');
    };
    await expect(authorize(q, { buyerKey, wallet: never, store })).rejects.toThrow('disk full');
    expect(never.signTypedData).not.toHaveBeenCalled();
  });

  it('keeps one open purchase per wallet and file: a second one is refused before the wallet', async () => {
    const q = await preflight(opts());
    const store = memoryStore<PurchaseRecord>();
    await authorize(q, { buyerKey, wallet: sign(), store });
    const second = sign();
    const otherKey = bls.G1.Point.BASE.multiply(8n).toBytes(true);
    expect(await codeOf(authorize(q, { buyerKey: otherKey, wallet: second, store }))).toBe(
      'purchase_open',
    );
    expect(second.signTypedData).not.toHaveBeenCalled();
  });

  it('returns no payload it could not record, and keeps the attempt as possibly signed', async () => {
    const q = await preflight(opts());
    const store = memoryStore<PurchaseRecord>();
    const cas = store.compareAndSet.bind(store);
    store.compareAndSet = async (key, expected, next) =>
      next?.attempts.at(-1)?.payload ? false : cas(key, expected, next);
    expect(await codeOf(authorize(q, { buyerKey, wallet: sign(), store }))).toBe('store_conflict');
    const kept = (await store.load(purchaseKey(CONTRACT, FILE, BUYER))) as PurchaseRecord;
    expect(kept.attempts).toHaveLength(1);
    expect(kept.attempts[0]).not.toHaveProperty('payload');
    // The dry run never saw it.
    expect(
      w.calls.some((c) => c.method === 'eth_call' && String(c.data).startsWith('0xe3ee160e')),
    ).toBe(false);
  });

  it('sends a payment-identifier id when the server advertises the extension, and records it', async () => {
    const pr = {
      ...required(),
      extensions: {
        ...required().extensions,
        'payment-identifier': declarePaymentIdentifierExtension(false),
      },
    } as PaymentRequired;
    const q = await preflight(opts({ paymentRequired: pr }));
    const { header, purchase } = await authorize(q, {
      buyerKey,
      wallet: sign(),
      store: memoryStore(),
    });
    const payload = decodePaymentSignatureHeader(header);
    const id = extractPaymentIdentifier(payload);
    expect(id).toMatch(/^pay_[0-9a-f]{32}$/);
    expect(isValidPaymentId(id as string)).toBe(true);
    expect(payload.extensions?.['payment-identifier']).toEqual({
      ...declarePaymentIdentifierExtension(false),
      info: { required: false, id },
    });
    expect(purchase.attempts[0]?.paymentId).toBe(id);
    // Two purchases never share an id.
    const again = await authorize(q, { buyerKey, wallet: sign(), store: memoryStore() });
    expect(again.purchase.attempts[0]?.paymentId).not.toBe(id);
  });

  it('refuses a signature that is not the buyer, or not in the form USDC takes', async () => {
    const q = await preflight(opts());
    const run = (wallet: ReturnType<typeof sign>) =>
      codeOf(authorize(q, { buyerKey, wallet, store: memoryStore() }));
    expect(await run(sign(otherAccount))).toBe('bad_signature');
    const smart = sign();
    smart.signTypedData.mockResolvedValue(`0x${'00'.repeat(200)}`); // an ERC-6492 style blob
    expect(await run(smart)).toBe('bad_signature');
    const highS = sign();
    highS.signTypedData.mockImplementation(async (t) => {
      const sig = await buyerAccount.signTypedData(asViem(t));
      const s = secp256k1.Point.Fn.ORDER - BigInt(`0x${sig.slice(66, 130)}`);
      const v = sig.endsWith('1b') ? '1c' : '1b';
      return `0x${sig.slice(2, 66)}${s.toString(16).padStart(64, '0')}${v}`;
    });
    expect(await run(highS)).toBe('bad_signature');
  });

  it('stops when USDC refuses the signed authorization, and tells a revert from a dead RPC', async () => {
    const q = await preflight(opts());
    const run = () => codeOf(authorize(q, { buyerKey, wallet: sign(), store: memoryStore() }));
    w.dryRun = {
      error: { code: 3, message: 'execution reverted: FiatTokenV2: invalid signature' },
    };
    expect(await run()).toBe('payment_rejected');
    w.dryRun = { error: { code: -32005, message: 'rate limited' } };
    expect(await run()).toBe('transport');
  });

  it('checks the registration again: a quote does not outlive a stop, takedown or change', async () => {
    const run = async (change: () => void) => {
      w.file = file();
      const q = await preflight(opts());
      change();
      const wallet = sign();
      const got = await codeOf(authorize(q, { buyerKey, wallet, store: memoryStore() }));
      expect(wallet.signTypedData).not.toHaveBeenCalled();
      return got;
    };
    expect(
      await run(() => {
        w.file = file({ sales_stopped_at: NOW });
      }),
    ).toBe('sales_stopped');
    expect(
      await run(() => {
        w.file = file({ taken_down: 'court_order' });
      }),
    ).toBe('taken_down');
    expect(
      await run(() => {
        w.file = null;
      }),
    ).toBe('unknown_file');
    expect(
      await run(() => {
        w.file = file({ price: '10001' });
      }),
    ).toBe('price_mismatch');
    expect(
      await run(() => {
        w.file = file({ seller: `0x${'ac'.repeat(20)}` });
      }),
    ).toBe('price_mismatch');
    expect(
      await run(() => {
        w.file = file({ pay_to: `0x${'5f'.repeat(20)}` });
      }),
    ).toBe('price_mismatch');
    expect(
      await run(() => {
        w.file = file({ moderator: 'mod.sputnik-dao.near' });
      }),
    ).toBe('price_mismatch');
  });

  it("keeps every authorization inside the contract's window after a stop", () => {
    // The contract's own constant, read from its source: the SDK's bound must stay below it.
    const rust = readFileSync(
      new URL('../../../../contracts/annon/src/moderation.rs', import.meta.url),
      'utf8',
    );
    const window = Number(/STOP_SETTLEMENT_SECONDS: u64 = (\d+);/.exec(rust)?.[1]);
    expect(window).toBe(300);
    expect(MAX_VALIDITY_SECONDS + MAX_CLOCK_SKEW_SECONDS).toBeLessThan(window);
  });

  it('takes the deadline from the earlier clock, so a fast RPC cannot stretch it', async () => {
    const q = await preflight(opts());
    w.head = { ...at(SIGNED), timestamp: NOW + 60 };
    const { purchase } = await authorize(q, { buyerKey, wallet: sign(), store: memoryStore() });
    expect(purchase.attempts[0]?.validBefore).toBe(String(NOW + 180));
    // And a fast local clock: Base is 60 s behind it.
    w.head = { ...at(SIGNED), timestamp: NOW - 60 };
    const slow = await authorize(q, { buyerKey, wallet: sign(), store: memoryStore() });
    expect(slow.purchase.attempts[0]?.validBefore).toBe(String(NOW - 60 + 180));
    expect(slow.purchase.attempts[0]?.preparedAt).toBe(NOW - 60);
  });

  it('takes the deadline from before the registration is read, however long the reads stall', async () => {
    const q = await preflight(opts());
    // The registration read stalls 400 s; afterwards both clocks agree on NOW + 400. A sales stop
    // in that time must still see the payment land within 300 s.
    w.onNear = () => {
      w.head = { ...at(SIGNED), timestamp: NOW + 400 };
      vi.mocked(Date.now).mockReturnValue((NOW + 400) * 1000);
    };
    const { purchase } = await authorize(q, { buyerKey, wallet: sign(), store: memoryStore() });
    expect(purchase.attempts[0]?.validBefore).toBe(String(NOW + 180));
    expect(purchase.attempts[0]?.preparedAt).toBe(NOW);
  });

  it('refuses a local clock that is off before the registration read, even if it is corrected during it', async () => {
    const q = await preflight(opts());
    vi.mocked(Date.now).mockReturnValue((NOW + 400) * 1000);
    w.onNear = () => vi.mocked(Date.now).mockReturnValue(NOW * 1000);
    expect(await codeOf(authorize(q, { buyerKey, wallet: sign(), store: memoryStore() }))).toBe(
      'transport',
    );
  });

  it('hands back the recorded purchase, payload included, when the dry run fails', async () => {
    const q = await preflight(opts());
    w.dryRun = {
      error: { code: 3, message: 'execution reverted: FiatTokenV2: invalid signature' },
    };
    const err = await authorize(q, { buyerKey, wallet: sign(), store: memoryStore() }).catch(
      (e: PayError) => e,
    );
    expect(err).toBeInstanceOf(PayError);
    expect((err as PayError).purchase?.terms.buyerKey).toBe(hex(buyerKey));
    expect((err as PayError).purchase?.attempts[0]).toMatchObject({
      validBefore: String(NOW + 180),
      payload: expect.any(String),
    });
  });

  it('does not take a deadline from a Base RPC whose clock is off', async () => {
    const q = await preflight(opts());
    for (const off of [-61, 61]) {
      w.head = { ...at(SIGNED), timestamp: NOW + off };
      expect(await codeOf(authorize(q, { buyerKey, wallet: sign(), store: memoryStore() }))).toBe(
        'transport',
      );
    }
    w.head = { ...at(SIGNED), timestamp: NOW + 60 };
    expect(await codeOf(authorize(q, { buyerKey, wallet: sign(), store: memoryStore() }))).toBe(
      'ok',
    );
  });

  it('refuses a wallet other than the quoted buyer and a key that is not a G1 point', async () => {
    const q = await preflight(opts());
    const other = { ...sign(otherAccount), address: otherAccount.address };
    expect(await codeOf(authorize(q, { buyerKey, wallet: other, store: memoryStore() }))).toMatch(
      /TypeError/,
    );
    expect(
      await codeOf(
        authorize(q, {
          buyerKey: new Uint8Array(48).fill(1),
          wallet: sign(),
          store: memoryStore(),
        }),
      ),
    ).toMatch(/TypeError/);
    // A valid point in its 96-byte form: the nonce would hash bytes unlock never accepts.
    expect(
      await codeOf(
        authorize(q, {
          buyerKey: bls.G1.Point.BASE.multiply(7n).toBytes(false),
          wallet: sign(),
          store: memoryStore(),
        }),
      ),
    ).toMatch(/TypeError/);
    // The identity point decodes, but NEAR's answer to it would be the key in the clear.
    expect(
      await codeOf(
        authorize(q, {
          buyerKey: bls.G1.Point.ZERO.toBytes(true),
          wallet: sign(),
          store: memoryStore(),
        }),
      ),
    ).toMatch(/TypeError/);
  });
});

// ---------- after the payment: logs built by viem, read by the SDK ----------

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

const ANNON = annonNonce(CONTRACT, FILE, buyerKey);
const x402Expect: Expected = { usdc: USDC, to: PAY_TO, from: BUYER, nonce: ANNON, price: 10_000n };
/** A receipt with unrelated logs around the payment, as a real one has. */
const x402Receipt = () => [
  transfer(`0x${'77'.repeat(20)}`, `0x${'78'.repeat(20)}`, 5n, 2),
  used(ANNON),
  transfer(BUYER, PAY_TO, 10_000n, 4),
  transfer(PAY_TO, `0x${'79'.repeat(20)}`, 1n, 5),
];

describe('paymentLogs', () => {
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
    schemaVersion: 1,
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
  const opened = async (r: PurchaseRecord) => {
    const store = memoryStore<PurchaseRecord>();
    await store.compareAndSet(purchaseKey(CONTRACT, FILE, BUYER), null, { ...r, revision: 0 });
    return { store, record: { ...r, revision: 0 } };
  };

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

  it("after a restart, says unlock with the job's own key, logs and block header, then reopen once recorded", async () => {
    // The payment sits in a real Base block, so the header is that block's and its number is the
    // logs' block number, as the contract checks.
    const real = headers.cases[0] as (typeof headers.cases)[number];
    const inBlock = (l: RpcLog) => ({ ...atBlock(l, real.number), blockHash: real.hash });
    w.head = at(real.number + 30);
    w.getLogs = [inBlock(used(ANNON))];
    w.receipt = receipt(x402Receipt().map(inBlock));
    const paidJob = job({
      block: real.number - 20,
      validBefore: String(at(real.number + 30).timestamp + 300),
    });
    const { store, record } = await opened(paidJob);
    const step = await nextStep(record, { nearRpc: NEAR, baseRpc: BASE, store });
    expect(step).toMatchObject({
      step: 'unlock',
      args: { file_id: FILE, buyer_key: hex(buyerKey), header: real.rlp },
    });
    if (step.step !== 'unlock') throw new Error('unreachable');
    expect(step.args.logs.map((l) => l.log_index)).toEqual([3, 4]);
    expect(step.args.logs.map((l) => l.block_number)).toEqual([real.number, real.number]);
    // Paid, not yet recorded on NEAR: the purchase stays open, so no new one can start.
    expect(await store.load(purchaseKey(CONTRACT, FILE, BUYER))).not.toBeNull();
    w.paymentUsed = true;
    expect(await nextStep(record, { nearRpc: NEAR, baseRpc: BASE, store })).toEqual({
      step: 'reopen',
      txHash: TX,
    });
    // Recorded on NEAR: the purchase is closed.
    expect(await store.load(purchaseKey(CONTRACT, FILE, BUYER))).toBeNull();
  });

  it('says wait while a signed payment can still settle, and buy only once it never can', async () => {
    w.head = at(SIGNED + 2000);
    w.getLogs = [atBlock(canceledLog(), SIGNED + 10)];
    w.finalized = at(SIGNED + 9);
    const { store, record } = await opened(job());
    expect(await nextStep(record, { nearRpc: NEAR, baseRpc: BASE, store })).toEqual({
      step: 'wait',
    });
    expect(await store.load(purchaseKey(CONTRACT, FILE, BUYER))).not.toBeNull();
    w.finalized = at(SIGNED + 10);
    expect(await nextStep(record, { nearRpc: NEAR, baseRpc: BASE, store })).toEqual({
      step: 'buy',
    });
    // Closed: a new purchase can start.
    expect(await store.load(purchaseKey(CONTRACT, FILE, BUYER))).toBeNull();
  });

  it('says resend with the recorded payload, byte for byte, while it can still settle', async () => {
    w.head = at(SIGNED + 100);
    const { store, record } = await opened(job({ payload: 'eyJyZWNvcmRlZCI6dHJ1ZX0=' }));
    expect(await nextStep(record, { nearRpc: NEAR, baseRpc: BASE, store })).toEqual({
      step: 'resend',
      header: 'eyJyZWNvcmRlZCI6dHJ1ZX0=',
    });
    // Past its deadline by this clock: nothing to resend, wait for Base to say.
    vi.mocked(Date.now).mockReturnValue((NOW + 301) * 1000);
    expect(await nextStep(record, { nearRpc: NEAR, baseRpc: BASE, store })).toEqual({
      step: 'wait',
    });
  });

  it('closes the purchase and says reopen once NEAR has this wallet as a buyer by another payment', async () => {
    w.head = at(SIGNED + 100);
    w.isBuyer = true;
    const { store, record } = await opened(job({ payload: 'eyJyZWNvcmRlZCI6dHJ1ZX0=' }));
    expect(await nextStep(record, { nearRpc: NEAR, baseRpc: BASE, store })).toEqual({
      step: 'reopen',
    });
    expect(await store.load(purchaseKey(CONTRACT, FILE, BUYER))).toBeNull();
  });

  it('closes a paid purchase not yet unlocked once the wallet is a buyer by another payment', async () => {
    const real = headers.cases[0] as (typeof headers.cases)[number];
    const inBlock = (l: RpcLog) => ({ ...atBlock(l, real.number), blockHash: real.hash });
    w.head = at(real.number + 30);
    w.getLogs = [inBlock(used(ANNON))];
    w.receipt = receipt(x402Receipt().map(inBlock));
    w.isBuyer = true;
    const { store, record } = await opened(
      job({ block: real.number - 20, validBefore: String(at(real.number + 30).timestamp + 300) }),
    );
    expect(await nextStep(record, { nearRpc: NEAR, baseRpc: BASE, store })).toEqual({
      step: 'reopen',
      txHash: TX,
    });
    expect(await store.load(purchaseKey(CONTRACT, FILE, BUYER))).toBeNull();
  });

  it('refuses to close a purchase another tab changed meanwhile', async () => {
    w.head = at(SIGNED + 2000);
    w.finalized = at(SIGNED + 2000);
    const { store, record } = await opened(job());
    const newer = { ...record, revision: 1 };
    await store.compareAndSet(purchaseKey(CONTRACT, FILE, BUYER), record, newer);
    expect(await codeOf(nextStep(record, { nearRpc: NEAR, baseRpc: BASE, store }))).toBe(
      'store_conflict',
    );
    expect(await store.load(purchaseKey(CONTRACT, FILE, BUYER))).toEqual(newer);
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

  it('two tabs at once on one store: only one signs', async () => {
    const store = memoryStore<PurchaseRecord>();
    const wallet = {
      address: buyerAccount.address,
      signTypedData: vi.fn((t: ReturnType<typeof typedData>) =>
        buyerAccount.signTypedData(asViem(t)),
      ),
    };
    const q = await preflight(opts());
    const tabs = await Promise.allSettled([
      authorize(q, { buyerKey, wallet, store }),
      authorize(q, { buyerKey: bls.G1.Point.BASE.multiply(8n).toBytes(true), wallet, store }),
    ]);
    expect(tabs.map((t) => t.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(wallet.signTypedData).toHaveBeenCalledTimes(1);
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

describe('x402 v2 envelope', () => {
  const b64 = (v: unknown) => Buffer.from(JSON.stringify(v), 'utf8').toString('base64');

  it('reads PAYMENT-REQUIRED, unicode included, and refuses v1 or garbage', () => {
    const pr = { ...required(), resource: { url: 'https://x', description: 'Zażółć raport' } };
    expect(readPaymentRequired(b64(pr))).toEqual(pr);
    expect(() => readPaymentRequired(b64({ ...pr, x402Version: 1 }))).toThrow(PayError);
    expect(() => readPaymentRequired('not base64!')).toThrow(PayError);
    expect(() => readPaymentRequired(b64({ x402Version: 2 }))).toThrow(PayError);
  });

  it('finds the file from the annon extension, only for a trusted contract', () => {
    expect(discover(required(), [CONTRACT])).toEqual({ contractId: CONTRACT, fileId: FILE });
    const code = (pr: PaymentRequired, trusted?: string[]) => {
      try {
        discover(pr, trusted);
        return 'ok';
      } catch (e) {
        return (e as PayError).code;
      }
    };
    // The SDK's own list holds only the mainnet deployment.
    expect(code(withInfo(annonInfo({ contract: 'v1.annon.defdone.near' })))).toBe('ok');
    expect(code(withInfo(annonInfo({ contract: 'annon-dev.synthetic.near' })))).toBe(
      'untrusted_contract',
    );
    expect(code(withInfo(annonInfo({ contract: 'evil.near' })), [CONTRACT])).toBe(
      'untrusted_contract',
    );
    expect(code(withInfo(undefined), [CONTRACT])).toBe('file_mismatch');
    // v1.1 servers say 2, v1 servers 1; anything else is a profile this client does not know.
    expect(code(withInfo(annonInfo({ version: 2 })), [CONTRACT])).toBe('ok');
    expect(code(withInfo(annonInfo({ version: 3 })), [CONTRACT])).toBe('file_mismatch');
    expect(code(withInfo(annonInfo({ version: '2' })), [CONTRACT])).toBe('file_mismatch');
    expect(code(withInfo(annonInfo({ network: 'near:testnet' })), [CONTRACT])).toBe(
      'file_mismatch',
    );
    expect(code(withInfo(annonInfo({ fileId: FILE.toUpperCase() })), [CONTRACT])).toBe(
      'file_mismatch',
    );
  });

  it('buys from a server that sends no annon extension when the caller names the file', async () => {
    expect(await preflight(opts({ paymentRequired: withInfo(undefined) }))).toMatchObject({
      to: PAY_TO,
    });
  });

  it('echoes every advertised extension and adds the buyer key, or names the file itself', () => {
    const a = {
      from: BUYER,
      to: PAY_TO,
      value: 1n,
      validAfter: 0n,
      validBefore: 2n,
      nonce: ANNON,
    };
    const pr = {
      ...required(),
      extensions: { ...required().extensions, bazaar: { info: { x: 1 }, schema: {} } },
    } as PaymentRequired;
    const annon = { contractId: CONTRACT, fileId: FILE, buyerKey: hex(buyerKey) };
    const sent = JSON.parse(
      Buffer.from(
        paymentSignature(pr, pr.accepts[0] as never, a, '0x00', annon),
        'base64',
      ).toString(),
    );
    expect(sent.extensions.bazaar).toEqual({ info: { x: 1 }, schema: {} });
    expect(sent.extensions.annon).toEqual({
      info: { ...annonInfo(), buyerKey: hex(buyerKey) },
      schema: { type: 'object' },
    });
    expect(sent.resource).toEqual(pr.resource);
    const bare = JSON.parse(
      Buffer.from(
        paymentSignature(withInfo(undefined), pr.accepts[0] as never, a, '0x00', annon),
        'base64',
      ).toString(),
    );
    expect(bare.extensions.annon.info).toEqual({ ...annonInfo(), buyerKey: hex(buyerKey) });
  });
});

// ---------- against the official x402 library (test-only oracle) ----------

describe('the official x402 library accepts what the SDK sends', () => {
  /** A facilitator signer with real signature checks (viem) and the test world's chain state. */
  const facilitatorSigner = () => {
    const calls: string[] = [];
    return {
      calls,
      signer: {
        getAddresses: () => [`0x${'fa'.repeat(20)}`] as const,
        readContract: async (a: { functionName: string; args?: readonly unknown[] }) => {
          calls.push(`readContract:${a.functionName}`);
          if (a.functionName === 'balanceOf') return w.balance;
          if (a.functionName === 'authorizationState') return false;
          if (a.functionName === 'name') return 'USD Coin';
          if (a.functionName === 'version') return '2';
          // The library leaves the signature to this simulation of USDC's transferWithAuthorization,
          // so it checks the signature as USDC does (viem, USDC's domain). Real USDC runs the same
          // call on mainnet.
          if (a.functionName === 'transferWithAuthorization') {
            const [from, to, value, validAfter, validBefore, nonce, ...sig] = a.args as [
              `0x${string}`,
              `0x${string}`,
              bigint,
              bigint,
              bigint,
              `0x${string}`,
              ...unknown[],
            ];
            const signature = (
              sig.length === 1
                ? sig[0]
                : `${sig[1]}${String(sig[2]).slice(2)}${Number(sig[0]).toString(16)}`
            ) as `0x${string}`;
            const ok = await verifyTypedData({
              address: from,
              domain: {
                name: 'USD Coin',
                version: '2',
                chainId: 8453,
                verifyingContract: getAddress(USDC),
              },
              types: {
                TransferWithAuthorization: [
                  { name: 'from', type: 'address' },
                  { name: 'to', type: 'address' },
                  { name: 'value', type: 'uint256' },
                  { name: 'validAfter', type: 'uint256' },
                  { name: 'validBefore', type: 'uint256' },
                  { name: 'nonce', type: 'bytes32' },
                ],
              },
              primaryType: 'TransferWithAuthorization',
              message: { from, to, value, validAfter, validBefore, nonce },
              signature,
            });
            calls.push(`simulate:${ok}`);
            if (!ok) throw new Error('FiatTokenV2: invalid signature');
            return undefined;
          }
          throw new Error(`readContract ${a.functionName} not modelled`);
        },
        verifyTypedData: async (a: Parameters<typeof verifyTypedData>[0]) => {
          calls.push('verifyTypedData');
          return verifyTypedData(a);
        },
        writeContract: async () => {
          throw new Error('no writes in verify');
        },
        sendTransaction: async () => {
          throw new Error('no writes in verify');
        },
        waitForTransactionReceipt: async () => {
          throw new Error('no writes in verify');
        },
        getCode: async (a: { address: string }) => {
          calls.push('getCode');
          return a.address.toLowerCase() === USDC ? '0x6080' : undefined;
        },
      },
    };
  };

  it('parses our PAYMENT-REQUIRED and PAYMENT-SIGNATURE with its own decoders and schemas', async () => {
    w.file = file();
    const pr = required(offer());
    // Their encoder, our reader; our header, their decoder.
    expect(readPaymentRequired(encodePaymentRequiredHeader(pr as never))).toEqual(pr);
    const q = await preflight(opts({ paymentRequired: pr }));
    const { header } = await authorize(q, {
      buyerKey,
      wallet: {
        address: buyerAccount.address,
        signTypedData: (t) => buyerAccount.signTypedData(asViem(t)),
      },
      store: memoryStore(),
    });
    const payload = decodePaymentSignatureHeader(header);
    expect(parsePaymentPayload(payload).success).toBe(true);
    expect(parsePaymentRequired(pr).success).toBe(true);
  });

  it('verifies our direct x402 payment with its exact EVM facilitator', async () => {
    w.file = file();
    const pr = required(offer());
    const q = await preflight(opts({ paymentRequired: pr }));
    const { header } = await authorize(q, {
      buyerKey,
      wallet: {
        address: buyerAccount.address,
        signTypedData: (t) => buyerAccount.signTypedData(asViem(t)),
      },
      store: memoryStore(),
    });
    const { signer, calls } = facilitatorSigner();
    const scheme = new ExactEvmScheme(signer as never);
    // The seller's adapter: the same signed payment, named `exact` for a standard facilitator.
    const body = forFacilitator(header, pr.accepts[0] as never);
    // The request body a facilitator's /verify and /settle take (x402 v2 section 7).
    expect(body.x402Version).toBe(2);
    const { paymentPayload, paymentRequirements } = body;
    const v = await scheme.verify(paymentPayload as never, paymentRequirements as never);
    expect(v).toMatchObject({ isValid: true, payer: BUYER });
    expect(calls).toContain('simulate:true');
  });

  it('is refused by a plain facilitator as long as the offer says annon-exact (forFacilitator renames it)', async () => {
    const pr = required();
    const q = await preflight(opts({ paymentRequired: pr }));
    const { header } = await authorize(q, {
      buyerKey,
      wallet: {
        address: buyerAccount.address,
        signTypedData: (t) => buyerAccount.signTypedData(asViem(t)),
      },
      store: memoryStore(),
    });
    const { signer } = facilitatorSigner();
    const v = await new ExactEvmScheme(signer as never)
      .verify(decodePaymentSignatureHeader(header), pr.accepts[0] as never)
      .catch((e: Error) => ({ isValid: false, invalidReason: e.message }));
    expect(v.isValid).toBe(false);
  });
});

// ---------- the seller's side ----------

describe('offerFor and checkPayment', () => {
  const wallet = () => ({
    address: buyerAccount.address,
    signTypedData: (t: ReturnType<typeof typedData>) => buyerAccount.signTypedData(asViem(t)),
  });
  const offerOpts = {
    nearRpc: NEAR,
    contractId: CONTRACT,
    fileId: FILE,
    url: 'https://seller.example/f/1',
    header: 'https://seller.example/f/1/header',
  };
  it('needs the header URL and an https file URL', async () => {
    for (const over of [
      { header: undefined },
      { url: undefined },
      { header: '/f/1/header' },
      { url: '' },
      { url: 'http://seller.example/f/1' },
    ]) {
      await expect(offerFor({ ...offerOpts, ...over } as never)).rejects.toThrow(TypeError);
    }
    const pr = await offerFor(offerOpts);
    expect(pr.extensions?.annon?.info).toMatchObject({ header: offerOpts.header });
    expect(pr.extensions?.annon?.info).not.toHaveProperty('download');
    expect(pr.resource).toEqual({ url: offerOpts.url });
  });
  const reject = (f: () => unknown) => {
    try {
      f();
      return 'accepted';
    } catch (e) {
      return e instanceof PayError ? `${e.code}: ${e.message}` : `crashed: ${(e as Error).message}`;
    }
  };

  it('builds a 402 from the registration that the official schema and the SDK buyer both accept', async () => {
    for (const f of [file(), file()]) {
      w.file = f;
      const pr = await offerFor(offerOpts);
      expect(parsePaymentRequired(pr).success).toBe(true);
      expect(readPaymentRequired(encodePaymentRequiredHeader(pr as never))).toEqual(pr);
      const q = await preflight(opts({ paymentRequired: pr }));
      expect(q.price).toBe(10_000n);
    }
  });

  it('names the public header in the extension; the file is the resource', async () => {
    w.file = file();
    const pr = await offerFor({ ...offerOpts, header: 'https://seller.example/f/1/header' });
    expect(pr.extensions?.annon?.info).toEqual({
      ...annonInfo({ version: 2 }),
      header: 'https://seller.example/f/1/header',
    });
    expect(parsePaymentRequired(pr).success).toBe(true);
    expect((await offerFor({ ...offerOpts, public: true })).extensions?.annon?.info).toMatchObject({
      public: true,
    });
  });

  it('offers nothing for a stopped, taken-down or unknown file', async () => {
    const code = (p: Promise<unknown>) =>
      p.then(
        () => 'ok',
        (e: PayError) => e.code,
      );
    w.file = file({ sales_stopped_at: NOW });
    expect(await code(offerFor(offerOpts))).toBe('sales_stopped');
    w.file = file({ taken_down: 'court_order' });
    expect(await code(offerFor(offerOpts))).toBe('taken_down');
    w.file = null;
    expect(await code(offerFor(offerOpts))).toBe('unknown_file');
  });

  it('accepts what the SDK buyer sends and returns what settlement needs', async () => {
    const pr = await offerFor(offerOpts);
    const q = await preflight(opts({ paymentRequired: pr }));
    const { header } = await authorize(q, {
      buyerKey,
      wallet: wallet(),
      store: memoryStore(),
    });
    expect(checkPayment(header, pr)).toMatchObject({
      payer: BUYER,
      buyerKey: hex(buyerKey),
      nonce: annonNonce(CONTRACT, FILE, buyerKey),
    });
  });

  it('gives the official x402 client nothing to sign, and refuses its random nonce anyway', async () => {
    const client = registerExactEvmScheme(new x402Client(), { signer: buyerAccount });
    const signs = (pr: PaymentRequired) =>
      client.createPaymentPayload(pr as never).then(
        () => 'signed',
        () => 'refused',
      );
    w.file = file();
    const pr = await offerFor(offerOpts);
    // `annon-exact` has no handler in a plain client: it signs nothing.
    expect(await signs(pr)).toBe('refused');
    // Shown the same offer as plain `exact`, it signs a random nonce; the seller check refuses it.
    const asExact = { ...pr, accepts: [{ ...pr.accepts[0], scheme: 'exact' }] } as PaymentRequired;
    const payload = await client.createPaymentPayload(asExact as never);
    const echoed = {
      ...payload,
      accepted: pr.accepts[0],
      extensions: { annon: { info: { ...pr.extensions?.annon?.info, buyerKey: hex(buyerKey) } } },
    };
    const header = Buffer.from(JSON.stringify(echoed)).toString('base64');
    expect(reject(() => checkPayment(header, pr))).toMatch(/not the Annon nonce/);
    const bare = Buffer.from(JSON.stringify({ ...payload, accepted: pr.accepts[0] })).toString(
      'base64',
    );
    expect(reject(() => checkPayment(bare, pr))).toMatch(/no buyer key/);
  });

  it('hands a standard facilitator only annon-exact payments, renamed exact', async () => {
    const pr = await offerFor(offerOpts);
    const other = { ...pr.accepts[0], scheme: 'exact' };
    expect(reject(() => forFacilitator('e30=', other as never))).toMatch(/^method_mismatch/);
    const { paymentRequirements } = forFacilitator('e30=', pr.accepts[0] as never);
    expect(paymentRequirements.scheme).toBe('exact');
  });

  it('keeps every extension of the payload for the facilitator, the payment id included', async () => {
    const pr = await offerFor(offerOpts);
    const q = await preflight(opts({ paymentRequired: pr }));
    const { header } = await authorize(q, { buyerKey, wallet: wallet(), store: memoryStore() });
    const sent = decodePaymentSignatureHeader(header);
    const { paymentPayload } = forFacilitator(header, pr.accepts[0] as never);
    expect((paymentPayload as unknown as { extensions: unknown }).extensions).toEqual(
      sent.extensions,
    );
    expect(extractPaymentIdentifier(paymentPayload as never)).toBe(extractPaymentIdentifier(sent));
  });

  it("declares the app's builder code as x402 does, and the client adds the Annon SDK's code", async () => {
    const pr = await offerFor({ ...offerOpts, appCode: 'partner' });
    expect(pr.extensions?.['builder-code']).toEqual(declareBuilderCodeExtension('partner'));
    const q = await preflight(opts({ paymentRequired: pr }));
    const { header } = await authorize(q, { buyerKey, wallet: wallet(), store: memoryStore() });
    const payload = decodePaymentSignatureHeader(header) as unknown as {
      extensions: Record<string, { info: Record<string, unknown> }>;
    };
    expect(payload.extensions['builder-code']?.info).toEqual({ a: 'partner', s: ['bc_lq0mq0v9'] });
    // x402's own facilitator turns exactly these codes into the ERC-8021 settlement suffix.
    const { paymentPayload } = forFacilitator(header, pr.accepts[0] as never);
    const suffix = new BuilderCodeFacilitatorExtension().buildDataSuffix({
      paymentPayload: paymentPayload as never,
    } as never);
    expect(
      parseBuilderCodeSuffixFromCalldata(
        `0x${'ab'.repeat(4)}${(suffix as string).slice(2)}` as never,
      ),
    ).toMatchObject({
      a: 'partner',
      s: ['bc_lq0mq0v9'],
    });
    expect(checkPayment(header, pr, NOW).payer).toBe(BUYER);
    // Without a declared app code the client sends only its service code.
    const plain = await offerFor(offerOpts);
    const q2 = await preflight(opts({ paymentRequired: plain }));
    const h2 = (await authorize(q2, { buyerKey, wallet: wallet(), store: memoryStore() })).header;
    expect(
      (
        decodePaymentSignatureHeader(h2) as unknown as {
          extensions: Record<string, { info: unknown }>;
        }
      ).extensions['builder-code']?.info,
    ).toEqual({ s: ['bc_lq0mq0v9'] });
    await expect(offerFor({ ...offerOpts, appCode: 'Not Valid' })).rejects.toThrow(TypeError);
  });

  it("merges declared service codes as x402's client does, and takes them in that order", async () => {
    const base = await offerFor({ ...offerOpts, appCode: 'partner' });
    const declared = { info: { a: 'partner', s: ['server_sdk', 'bc_lq0mq0v9'] } };
    const pr = { ...base, extensions: { ...base.extensions, 'builder-code': declared } };
    const q = await preflight(opts({ paymentRequired: pr as never }));
    const { header } = await authorize(q, { buyerKey, wallet: wallet(), store: memoryStore() });
    const sent = (
      decodePaymentSignatureHeader(header) as unknown as {
        extensions: Record<string, { info: unknown }>;
      }
    ).extensions['builder-code'];
    const merged = (
      new x402Client() as unknown as { mergeExtensions(a: object, b: object): unknown }
    ).mergeExtensions(
      { 'builder-code': declared },
      {
        'builder-code': { info: { s: ['bc_lq0mq0v9'] } },
      },
    ) as Record<string, { info: unknown }>;
    expect(sent?.info).toEqual(merged['builder-code']?.info);
    expect(sent?.info).toEqual({ a: 'partner', s: ['bc_lq0mq0v9', 'server_sdk'] });
    expect(checkPayment(header, pr as never, NOW).payer).toBe(BUYER);
    // A declared code left out is refused.
    const p = decodePaymentSignatureHeader(header) as unknown as {
      extensions: Record<string, unknown>;
    };
    p.extensions['builder-code'] = { info: { a: 'partner', s: ['bc_lq0mq0v9'] } };
    expect(
      reject(() =>
        checkPayment(Buffer.from(JSON.stringify(p)).toString('base64'), pr as never, NOW),
      ),
    ).toMatch(/extension_echo_mismatch/);
    // The whole extension left out is refused too.
    delete p.extensions['builder-code'];
    expect(
      reject(() =>
        checkPayment(Buffer.from(JSON.stringify(p)).toString('base64'), pr as never, NOW),
      ),
    ).toMatch(/extension_echo_mismatch/);
  });

  it('keeps a declared service code given as one string, as the extension allows', async () => {
    const base = await offerFor({ ...offerOpts, appCode: 'partner' });
    const declared = { info: { a: 'partner', s: 'server_sdk' } };
    const pr = { ...base, extensions: { ...base.extensions, 'builder-code': declared } };
    const q = await preflight(opts({ paymentRequired: pr as never }));
    const { header } = await authorize(q, { buyerKey, wallet: wallet(), store: memoryStore() });
    const p = decodePaymentSignatureHeader(header) as unknown as {
      extensions: Record<string, { info: unknown }>;
    };
    const merged = (
      new x402Client() as unknown as { mergeExtensions(a: object, b: object): unknown }
    ).mergeExtensions(
      { 'builder-code': declared },
      {
        'builder-code': { info: { s: ['bc_lq0mq0v9'] } },
      },
    ) as Record<string, { info: unknown }>;
    expect(p.extensions['builder-code']?.info).toEqual(merged['builder-code']?.info);
    expect(p.extensions['builder-code']?.info).toEqual({
      a: 'partner',
      s: ['bc_lq0mq0v9', 'server_sdk'],
    });
    expect(checkPayment(header, pr as never, NOW).payer).toBe(BUYER);
    // A scalar echo is the same list; one that drops the declared code is refused.
    for (const [s, ok] of [
      ['server_sdk', true],
      ['bc_lq0mq0v9', false],
    ] as const) {
      p.extensions['builder-code'] = { info: { a: 'partner', s } };
      const h = Buffer.from(JSON.stringify(p)).toString('base64');
      if (ok) expect(checkPayment(h, pr as never, NOW).payer).toBe(BUYER);
      else
        expect(reject(() => checkPayment(h, pr as never, NOW))).toMatch(/extension_echo_mismatch/);
    }
  });

  it('refuses a builder code echo that does not match what the server declared', async () => {
    const pr = await offerFor({ ...offerOpts, appCode: 'partner' });
    const q = await preflight(opts({ paymentRequired: pr }));
    const { header } = await authorize(q, { buyerKey, wallet: wallet(), store: memoryStore() });
    const edit = (info: Record<string, unknown>) => {
      const p = decodePaymentSignatureHeader(header) as unknown as {
        extensions: Record<string, unknown>;
      };
      p.extensions['builder-code'] = { info };
      return Buffer.from(JSON.stringify(p)).toString('base64');
    };
    for (const info of [
      { a: 'other_app', s: ['bc_lq0mq0v9'] },
      { s: ['bc_lq0mq0v9'] },
      { a: 'partner', s: ['Bad Code'] },
      { a: 'partner', s: Array.from({ length: 11 }, (_, i) => `c${i}`) },
      { a: 'partner', s: 'Bad Code' },
      { a: 'partner', w: 'wallet', s: [] },
    ]) {
      expect(
        reject(() => checkPayment(edit(info), pr, NOW)),
        JSON.stringify(info),
      ).toMatch(/extension_echo_mismatch/);
    }
    // An app code the server never declared.
    const plain = await offerFor(offerOpts);
    const q2 = await preflight(opts({ paymentRequired: plain }));
    const h2 = (await authorize(q2, { buyerKey, wallet: wallet(), store: memoryStore() })).header;
    const p2 = decodePaymentSignatureHeader(h2) as unknown as {
      extensions: Record<string, unknown>;
    };
    p2.extensions['builder-code'] = { info: { a: 'sneaky', s: [] } };
    expect(
      reject(() => checkPayment(Buffer.from(JSON.stringify(p2)).toString('base64'), plain, NOW)),
    ).toMatch(/extension_echo_mismatch/);
  });

  it("keeps discovery within x402's resource limits: at the limits accepted, past them refused", async () => {
    const edge = await offerFor({
      ...offerOpts,
      discovery: {
        serviceName: 'n'.repeat(32),
        tags: ['a', 'b', 'c', 'd', 't'.repeat(32)],
        iconUrl: `https://i.example/${'x'.repeat(2000)}`,
      },
    });
    expect(parsePaymentRequired(edge).success).toBe(true);
    for (const discovery of [
      { serviceName: 'n'.repeat(33) },
      { serviceName: '' },
      { tags: ['a', 'b', 'c', 'd', 'e', 'f'] },
      { tags: ['ż'] },
      { iconUrl: `https://i.example/${'x'.repeat(2048)}` },
    ]) {
      await expect(
        offerFor({ ...offerOpts, discovery }),
        JSON.stringify(discovery),
      ).rejects.toThrow(TypeError);
      const loose = (await offerFor(offerOpts)) as unknown as { resource: object };
      loose.resource = { ...loose.resource, ...discovery };
      expect(parsePaymentRequired(loose).success, JSON.stringify(discovery)).toBe(false);
    }
  });

  it('refuses tags bazaar would merge as one, case aside', async () => {
    expect(sanitizeTags(['File', 'file'])).toEqual(['File']);
    await expect(offerFor({ ...offerOpts, discovery: { tags: ['File', 'file'] } })).rejects.toThrow(
      TypeError,
    );
    expect(
      (await offerFor({ ...offerOpts, discovery: { tags: ['File', 'Song'] } })).resource,
    ).toMatchObject({ tags: ['File', 'Song'] });
  });

  it("takes an icon URL only where bazaar's own check keeps it, and https only", async () => {
    const urls = [
      'https://cdn.example/i.png',
      'https://bücher.example/i.png',
      'http://cdn.example/i.png',
      'file:///etc/passwd',
      'https://user:pw@cdn.example/i.png',
      'https://user@cdn.example/i.png',
      'https://:pw@cdn.example/i.png',
      'https://0x7g/i.png',
      'https://[::1]/i.png',
      'https://localhost/i.png',
      'https://127.0.0.1/i.png',
      'https://0x7f000001/i.png',
      'https://2130706433/i.png',
      'https://cdn.example/\u0001',
      'not a url',
    ];
    for (const iconUrl of urls) {
      const ours = await offerFor({ ...offerOpts, discovery: { iconUrl } }).then(
        () => true,
        () => false,
      );
      // Kept only where bazaar keeps it; http is bazaar's, never an Annon offer's.
      expect(ours, iconUrl).toBe(isValidIconUrl(iconUrl) && iconUrl.startsWith('https:'));
    }
  });

  it('describes the file for x402 discovery as its validators accept, and keeps it from the facilitator', async () => {
    const pr = await offerFor({
      ...offerOpts,
      discovery: {
        description: 'A song',
        mimeType: 'audio/mpeg',
        serviceName: 'Partner',
        tags: ['music'],
      },
    });
    const bazaar = pr.extensions?.bazaar as never;
    expect(validateDiscoveryExtension(bazaar)).toMatchObject({ valid: true });
    expect(validateDiscoveryExtensionSpec(bazaar)).toMatchObject({ valid: true });
    expect(pr.resource).toMatchObject({
      description: 'A song',
      mimeType: 'audio/mpeg',
      serviceName: 'Partner',
      tags: ['music'],
    });
    const q = await preflight(opts({ paymentRequired: pr }));
    const { header } = await authorize(q, { buyerKey, wallet: wallet(), store: memoryStore() });
    expect(
      (decodePaymentSignatureHeader(header) as unknown as { extensions: object }).extensions,
    ).toHaveProperty('bazaar');
    const { paymentPayload } = forFacilitator(header, pr.accepts[0] as never);
    const ext = (paymentPayload as unknown as { extensions: Record<string, unknown> }).extensions;
    expect(ext).not.toHaveProperty('bazaar');
    expect(ext).toHaveProperty('annon');
    expect(ext).toHaveProperty('builder-code');
  });

  it('advertises profile v1.1: annon version 2, and payment-identifier as the official helper declares it', async () => {
    const pr = await offerFor(offerOpts);
    expect(pr.extensions?.annon?.info.version).toBe(2);
    expect(pr.extensions?.annon?.schema).toMatchObject({ properties: { version: { const: 2 } } });
    expect(pr.extensions?.['payment-identifier']).toEqual(declarePaymentIdentifierExtension(false));
  });

  it('takes a payment id only as advertised, and only a valid one', async () => {
    const pr = await offerFor(offerOpts);
    const q = await preflight(opts({ paymentRequired: pr }));
    const { header } = await authorize(q, { buyerKey, wallet: wallet(), store: memoryStore() });
    expect(checkPayment(header, pr, NOW).paymentId).toMatch(/^pay_[0-9a-f]{32}$/);
    const edit = (
      f: (ext: { info: Record<string, unknown> } & Record<string, unknown>) => void,
    ) => {
      const p = decodePaymentSignatureHeader(header) as unknown as {
        extensions: Record<string, { info: Record<string, unknown> } & Record<string, unknown>>;
      };
      f(p.extensions['payment-identifier'] as never);
      return Buffer.from(JSON.stringify(p)).toString('base64');
    };
    for (const bad of ['short', 'has space in it!!', 'x'.repeat(129), 7]) {
      expect(
        reject(() =>
          checkPayment(
            edit((e) => {
              e.info.id = bad;
            }),
            pr,
            NOW,
          ),
        ),
      ).toMatch(/^bad_requirements/);
    }
    expect(
      reject(() =>
        checkPayment(
          edit((e) => {
            e.info.required = true;
          }),
          pr,
          NOW,
        ),
      ),
    ).toMatch(/^bad_requirements/);
    expect(
      reject(() =>
        checkPayment(
          edit((e) => {
            e.schema = {};
          }),
          pr,
          NOW,
        ),
      ),
    ).toMatch(/^bad_requirements/);
    // Echoed without an id: fine while optional, refused when the server requires one.
    const bare = edit((e) => {
      delete e.info.id;
    });
    expect(checkPayment(bare, pr, NOW).paymentId).toBeUndefined();
    const requiring = {
      ...pr,
      extensions: {
        ...pr.extensions,
        'payment-identifier': declarePaymentIdentifierExtension(true),
      },
    } as PaymentRequired;
    const bareRequired = (() => {
      const p = decodePaymentSignatureHeader(bare) as unknown as {
        extensions: Record<string, { info: Record<string, unknown> }>;
      };
      (p.extensions['payment-identifier'] as { info: Record<string, unknown> }).info.required =
        true;
      return Buffer.from(JSON.stringify(p)).toString('base64');
    })();
    expect(reject(() => checkPayment(bareRequired, requiring, NOW))).toMatch(/^bad_requirements/);
    // Optional: a payload without it is a payment like any other.
    const without = (() => {
      const p = decodePaymentSignatureHeader(header) as unknown as {
        extensions: Record<string, unknown>;
      };
      delete p.extensions['payment-identifier'];
      return Buffer.from(JSON.stringify(p)).toString('base64');
    })();
    expect(checkPayment(without, pr, NOW).paymentId).toBeUndefined();
  });

  it('refuses a payment signed for the identity key, which would put the key in the clear', async () => {
    w.file = file();
    const pr = await offerFor(offerOpts);
    const zero = bls.G1.Point.ZERO.toBytes(true);
    const a = {
      from: BUYER,
      to: PAY_TO,
      value: 10_000n,
      validAfter: 0n,
      validBefore: BigInt(NOW + 300),
      nonce: annonNonce(CONTRACT, FILE, zero),
    };
    const sig = await buyerAccount.signTypedData(asViem(typedData(USDC, a)));
    const header = paymentSignature(pr, pr.accepts[0] as never, a, sig, {
      contractId: CONTRACT,
      fileId: FILE,
      buyerKey: hex(zero),
    });
    expect(reject(() => checkPayment(header, pr))).toMatch(/not a one-time G1 key/);
    // A key that isn't 48 bytes of a point at all.
    const bad = paymentSignature(pr, pr.accepts[0] as never, a, sig, {
      contractId: CONTRACT,
      fileId: FILE,
      buyerKey: '0x1234',
    });
    expect(reject(() => checkPayment(bad, pr))).toMatch(/not a one-time G1 key/);
  });

  it('does not care about the order of keys in the echoed offer', async () => {
    w.file = file();
    const pr = await offerFor(offerOpts);
    const q = await preflight(opts({ paymentRequired: pr }));
    const { header } = await authorize(q, { buyerKey, wallet: wallet(), store: memoryStore() });
    const p = JSON.parse(Buffer.from(header, 'base64').toString());
    p.accepted = Object.fromEntries(Object.entries(p.accepted).reverse());
    p.extensions.annon.info = Object.fromEntries(Object.entries(p.extensions.annon.info).reverse());
    const reordered = Buffer.from(JSON.stringify(p)).toString('base64');
    expect(checkPayment(reordered, pr)).toMatchObject({ payer: BUYER });
  });

  it('settles no authorization valid for longer than the stop window allows, whoever signed it', async () => {
    w.file = file();
    const pr = await offerFor(offerOpts);
    const signFor = async (seconds: number) => {
      const a = {
        from: BUYER,
        to: PAY_TO,
        value: 10_000n,
        validAfter: 0n,
        validBefore: BigInt(NOW + seconds),
        nonce: annonNonce(CONTRACT, FILE, buyerKey),
      };
      const sig = await buyerAccount.signTypedData(asViem(typedData(USDC, a)));
      return paymentSignature(pr, pr.accepts[0] as never, a, sig, {
        contractId: CONTRACT,
        fileId: FILE,
        buyerKey: hex(buyerKey),
      });
    };
    // 180 s plus 60 s of clock margin is the most it settles; an hour is refused.
    expect(checkPayment(await signFor(240), pr)).toMatchObject({ payer: BUYER });
    const hour = await signFor(3600);
    expect(reject(() => checkPayment(hour, pr))).toMatch(/valid for too long/);
    const justOver = await signFor(241);
    expect(reject(() => checkPayment(justOver, pr))).toMatch(/valid for too long/);
  });

  it('reads the registration again before settling: a stop after the 402 refuses the payment', async () => {
    w.file = file();
    const pr = await offerFor(offerOpts);
    const q = await preflight(opts({ paymentRequired: pr }));
    const { header } = await authorize(q, { buyerKey, wallet: wallet(), store: memoryStore() });
    expect(await verifyPayment(header, { ...offerOpts, baseRpc: BASE })).toMatchObject({
      payer: BUYER,
    });
    const code = (p: Promise<unknown>) =>
      p.then(
        () => 'ok',
        (e: PayError) => e.code,
      );
    w.file = { ...file(), sales_stopped_at: NOW };
    expect(await code(verifyPayment(header, { ...offerOpts, baseRpc: BASE }))).toBe(
      'sales_stopped',
    );
    w.file = { ...file(), taken_down: 'court_order' };
    expect(await code(verifyPayment(header, { ...offerOpts, baseRpc: BASE }))).toBe('taken_down');
    // The stale 402 alone would still pass: that is why servers call verifyPayment.
    expect(checkPayment(header, pr)).toMatchObject({ payer: BUYER });
  });

  it("measures the bound in Base time, so a server whose clock runs fast can't stretch it", async () => {
    w.file = file();
    const pr = await offerFor(offerOpts);
    const a = {
      from: BUYER,
      to: PAY_TO,
      value: 10_000n,
      validAfter: 0n,
      validBefore: BigInt(NOW + 250),
      nonce: annonNonce(CONTRACT, FILE, buyerKey),
    };
    const sig = await buyerAccount.signTypedData(asViem(typedData(USDC, a)));
    const header = paymentSignature(pr, pr.accepts[0] as never, a, sig, {
      contractId: CONTRACT,
      fileId: FILE,
      buyerKey: hex(buyerKey),
    });
    const code = (p: Promise<unknown>) =>
      p.then(
        () => 'ok',
        (e: PayError) => `${e.code}: ${e.message}`,
      );
    // Base says NOW; the server's clock runs 50 s fast. 250 s from Base time is too long.
    vi.mocked(Date.now).mockReturnValue((NOW + 50) * 1000);
    expect(await code(verifyPayment(header, { ...offerOpts, baseRpc: BASE }))).toMatch(/too long/);
    // A server and Base more than 60 s apart settle nothing.
    vi.mocked(Date.now).mockReturnValue((NOW + 61) * 1000);
    expect(await code(verifyPayment(header, { ...offerOpts, baseRpc: BASE }))).toMatch(
      /^transport/,
    );
  });

  it('takes the time before it reads the registration, so a slow read cannot stretch the window', async () => {
    w.file = file();
    const pr = await offerFor(offerOpts);
    const q = await preflight(opts({ paymentRequired: pr }));
    const { header } = await authorize(q, { buyerKey, wallet: wallet(), store: memoryStore() });
    w.calls = [];
    await verifyPayment(header, { ...offerOpts, baseRpc: BASE });
    const order = w.calls.map((c) => c.method);
    expect(order.indexOf('eth_getBlockByNumber')).toBeLessThan(order.indexOf('near:get_file'));
    expect(order.indexOf('eth_getBlockByNumber')).toBeGreaterThanOrEqual(0);
  });

  it('refuses every tampered field before anything is settled', async () => {
    w.file = file();
    const pr = await offerFor(offerOpts);
    const q = await preflight(opts({ paymentRequired: pr }));
    const { header } = await authorize(q, { buyerKey, wallet: wallet(), store: memoryStore() });
    const base = JSON.parse(Buffer.from(header, 'base64').toString());
    const edit = (f: (p: typeof base) => void) => {
      const p = structuredClone(base);
      f(p);
      return Buffer.from(JSON.stringify(p)).toString('base64');
    };
    const other = hex(bls.G1.Point.BASE.multiply(8n).toBytes(true));
    for (const [name, h] of [
      [
        'v1',
        edit((p) => {
          p.x402Version = 1;
        }),
      ],
      [
        'another amount offered',
        edit((p) => {
          p.accepted.amount = '1';
        }),
      ],
      [
        'another buyer key',
        edit((p) => {
          p.extensions.annon.info.buyerKey = other;
        }),
      ],
      [
        'identity key',
        edit((p) => {
          p.extensions.annon.info.buyerKey = hex(bls.G1.Point.ZERO.toBytes(true));
        }),
      ],
      [
        'no buyer key',
        edit((p) => {
          delete p.extensions.annon.info.buyerKey;
        }),
      ],
      [
        'no extension',
        edit((p) => {
          delete p.extensions;
        }),
      ],
      [
        'another file in the extension',
        edit((p) => {
          p.extensions.annon.info.fileId = `0x${'12'.repeat(32)}`;
        }),
      ],
      [
        'value below the offer',
        edit((p) => {
          p.payload.authorization.value = '9999';
        }),
      ],
      [
        'another recipient',
        edit((p) => {
          p.payload.authorization.to = SELLER;
        }),
      ],
      [
        'validAfter in the future',
        edit((p) => {
          p.payload.authorization.validAfter = '1';
        }),
      ],
      [
        'a later validBefore than signed',
        edit((p) => {
          p.payload.authorization.validBefore = String(NOW + 9999);
        }),
      ],
      [
        'a signature from someone else',
        edit((p) => {
          p.payload.authorization.from = otherAccount.address;
        }),
      ],
      ['garbage', 'not base64'],
    ] as const) {
      expect(
        reject(() => checkPayment(h, pr)),
        name,
      ).toMatch(/^(bad_requirements|bad_signature)/);
    }
  });
});

// ---------- profile section 10: a seller settles each purchase once ----------

describe('settle (profile section 10)', () => {
  const offerOpts = {
    nearRpc: NEAR,
    baseRpc: BASE,
    contractId: CONTRACT,
    fileId: FILE,
    url: 'https://seller.example/f/1',
    header: 'https://seller.example/f/1/header',
  };
  const wallet = () => ({
    address: buyerAccount.address,
    signTypedData: (t: ReturnType<typeof typedData>) => buyerAccount.signTypedData(asViem(t)),
  });
  const PAID_AT = SIGNED + 20;
  const landPayment = (block = PAID_AT, nonce = ANNON) => {
    const atB = (l: RpcLog) => ({ ...l, blockNumber: `0x${block.toString(16)}` });
    w.getLogs = [atB(used(nonce))];
    w.receipt = receipt(
      [
        transfer(`0x${'77'.repeat(20)}`, `0x${'78'.repeat(20)}`, 5n, 2),
        used(nonce),
        transfer(BUYER, PAY_TO, 10_000n, 4),
      ].map(atB),
    );
  };
  /** A standard facilitator that settles on Base and answers with the transaction. */
  const facilitator = (answer?: SettleResponse) =>
    vi.fn(async (_body: unknown) => {
      if (!answer) landPayment();
      return answer ?? { success: true, transaction: TX, network: 'eip155:8453', payer: BUYER };
    });
  const buy = async (key = buyerKey) => {
    const pr = await offerFor(offerOpts);
    const q = await preflight(opts({ paymentRequired: pr }));
    return (await authorize(q, { buyerKey: key, wallet: wallet(), store: memoryStore() })).header;
  };
  const sellerStore = () => memoryStore<SellerRecord>();
  const run = (
    header: string,
    store: ReturnType<typeof sellerStore>,
    f: ReturnType<typeof facilitator>,
  ) => settle(header, { ...offerOpts, store, facilitator: f });
  beforeEach(() => {
    w.head = at(SIGNED + 50);
  });

  it('settles a new payment once, through a standard facilitator request', async () => {
    const header = await buy();
    const store = sellerStore();
    const f = facilitator();
    const out = await run(header, store, f);
    expect(out).toMatchObject({
      state: 'settled',
      transaction: TX,
      network: 'eip155:8453',
      payer: BUYER,
      nonce: ANNON,
      buyerKey: hex(buyerKey),
    });
    expect(f).toHaveBeenCalledTimes(1);
    const body = f.mock.calls[0]?.[0] as {
      x402Version: number;
      paymentPayload: { accepted: { scheme: string } };
      paymentRequirements: { scheme: string };
    };
    expect(body.x402Version).toBe(2);
    expect(body.paymentRequirements.scheme).toBe('exact');
    expect(body.paymentPayload.accepted.scheme).toBe('exact');
  });

  it('records the purchase as processing before calling the facilitator', async () => {
    const header = await buy();
    const store = sellerStore();
    const seen: (string | undefined)[] = [];
    const cas = store.compareAndSet.bind(store);
    store.compareAndSet = async (key, expected, next) => {
      if (next && 'state' in next) seen.push(next.state);
      return cas(key, expected, next);
    };
    const f = vi.fn(async () => {
      seen.push('facilitator');
      landPayment();
      return { success: true, transaction: TX, network: 'eip155:8453' };
    });
    await run(header, store, f);
    expect(seen.slice(0, 2)).toEqual(['processing', 'facilitator']);
    expect(seen.at(-1)).toBe('settled');
  });

  it('answers a retry of a settled purchase from its state, after a stop and past the deadline, settling nothing again', async () => {
    const header = await buy();
    const store = sellerStore();
    const f = facilitator();
    await run(header, store, f);
    w.file = file({ sales_stopped_at: NOW + 1 });
    vi.mocked(Date.now).mockReturnValue((NOW + 3600) * 1000);
    w.head = at(SIGNED + 5 * 3600);
    expect(await run(header, store, f)).toMatchObject({ state: 'settled', transaction: TX });
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("does not refuse a paid buyer because the seller's settings changed since", async () => {
    const header = await buy();
    const store = sellerStore();
    const f = facilitator();
    await run(header, store, f);
    const changed = { ...offerOpts, maxTimeoutSeconds: 60, header: 'https://cdn.example/h' };
    expect(await settle(header, { ...changed, store, facilitator: f })).toMatchObject({
      state: 'settled',
    });
  });

  it('refuses a taken-down file first, whatever the state, a settled purchase included', async () => {
    const header = await buy();
    const store = sellerStore();
    const f = facilitator();
    await run(header, store, f);
    w.file = file({ taken_down: 'court_order' });
    expect(await codeOf(run(header, store, f))).toBe('taken_down');
  });

  it('binds an id to its payload: the same payload gets the same answer, another payload 409', async () => {
    const first = await buy();
    const store = sellerStore();
    const f = facilitator();
    expect(await run(first, store, f)).toMatchObject({ state: 'settled' });
    expect(await run(first, store, f)).toMatchObject({ state: 'settled' });
    const id = extractPaymentIdentifier(decodePaymentSignatureHeader(first));
    // Another valid payment (another one-time key) sent under the first one's id.
    w.getLogs = [];
    w.receipt = null;
    const second = decodePaymentSignatureHeader(
      await buy(bls.G1.Point.BASE.multiply(8n).toBytes(true)),
    ) as unknown as {
      extensions: Record<string, { info: Record<string, unknown> }>;
    };
    (second.extensions['payment-identifier'] as { info: Record<string, unknown> }).info.id = id;
    const reused = Buffer.from(JSON.stringify(second)).toString('base64');
    expect(await codeOf(run(reused, store, f))).toBe('payment_id_conflict');
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('keeps an id per seller scope: another route may see the same id with another payload', async () => {
    const first = await buy();
    const f = facilitator();
    const store = sellerStore();
    await settle(first, { ...offerOpts, store, facilitator: f, scope: 'route-a' });
    const id = extractPaymentIdentifier(decodePaymentSignatureHeader(first));
    w.getLogs = [];
    w.receipt = null;
    const second = decodePaymentSignatureHeader(
      await buy(bls.G1.Point.BASE.multiply(8n).toBytes(true)),
    ) as unknown as { extensions: Record<string, { info: Record<string, unknown> }> };
    (second.extensions['payment-identifier'] as { info: Record<string, unknown> }).info.id = id;
    const reused = Buffer.from(JSON.stringify(second)).toString('base64');
    const g = vi.fn(async () => ({ success: false, errorReason: 'insufficient_funds' }));
    // Not a conflict on route b: its own purchase, settled (or not) on its own.
    expect(
      await codeOf(settle(reused, { ...offerOpts, store, facilitator: g, scope: 'route-b' })),
    ).toBe('settlement_processing');
    expect(
      await codeOf(settle(reused, { ...offerOpts, store, facilitator: g, scope: 'route-a' })),
    ).toBe('payment_id_conflict');
  });

  it('answers pending with the hash when the facilitator says settlement_pending, and settled once Base shows it', async () => {
    const header = await buy();
    const store = sellerStore();
    const f = facilitator({
      success: false,
      errorReason: 'settlement_pending',
      transaction: TX,
      network: 'eip155:8453',
    });
    expect(await run(header, store, f)).toEqual({
      state: 'pending',
      transaction: TX,
      network: 'eip155:8453',
    });
    landPayment();
    expect(await run(header, store, f)).toMatchObject({ state: 'settled', transaction: TX });
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('counts a payment as settled only at Base safe; before that it is pending with its hash', async () => {
    const header = await buy();
    const store = sellerStore();
    const f = facilitator();
    w.safe = at(PAID_AT - 1);
    expect(await run(header, store, f)).toEqual({
      state: 'pending',
      transaction: TX,
      network: 'eip155:8453',
    });
    w.safe = at(PAID_AT);
    expect(await run(header, store, f)).toMatchObject({ state: 'settled' });
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('after a crash with the call in flight: finds the payment on Base by its nonce, never calling again', async () => {
    const header = await buy();
    const store = sellerStore();
    const crash = vi.fn(async () => {
      landPayment();
      throw new Error('connection reset');
    });
    expect(await codeOf(run(header, store, crash))).toBe('settlement_processing');
    const f = facilitator();
    expect(await run(header, store, f)).toMatchObject({ state: 'settled', transaction: TX });
    expect(f).not.toHaveBeenCalled();
  });

  it('after a crash with nothing on Base: sends the same payload again while it can still settle', async () => {
    const header = await buy();
    const store = sellerStore();
    const lost = vi.fn(async () => {
      throw new Error('connection reset');
    });
    expect(await codeOf(run(header, store, lost))).toBe('settlement_processing');
    // Within RETRY_SECONDS nobody calls the facilitator again; after it, the next payload does.
    const early = facilitator();
    expect(await codeOf(run(header, store, early))).toBe('settlement_processing');
    expect(early).not.toHaveBeenCalled();
    vi.mocked(Date.now).mockReturnValue((NOW + RETRY_SECONDS) * 1000);
    const f = facilitator();
    expect(await run(header, store, f)).toMatchObject({ state: 'settled' });
    expect(f).toHaveBeenCalledTimes(1);
    const [body] = f.mock.calls[0] ?? [];
    const sent = (body as { paymentPayload: unknown }).paymentPayload;
    expect(sent).toEqual(
      forFacilitator(header, (await offerFor(offerOpts)).accepts[0] as never).paymentPayload,
    );
  });

  it('a seller that lost its state finds a payment settled elsewhere and answers it, sales stopped or not', async () => {
    const header = await buy();
    landPayment();
    w.file = file({ sales_stopped_at: NOW + 1 });
    const f = facilitator();
    expect(await run(header, sellerStore(), f)).toMatchObject({
      state: 'settled',
      transaction: TX,
    });
    expect(f).not.toHaveBeenCalled();
  });

  it('takes no payment from authorizationState or a cancellation: canceled is unpaid, and refused', async () => {
    const header = await buy();
    const canceled = rpcLog(
      USDC,
      encodeEventTopics({
        abi: USDC_ABI,
        eventName: 'AuthorizationCanceled',
        args: { authorizer: BUYER as `0x${string}`, nonce: ANNON as `0x${string}` },
      }) as string[],
      '0x',
      3,
    );
    w.getLogs = [canceled];
    w.authorizationState = true;
    w.head = at(SIGNED + 2000);
    w.finalized = at(SIGNED + 2000);
    const f = facilitator();
    expect(await codeOf(run(header, sellerStore(), f))).toBe('payment_expired');
    expect(f).not.toHaveBeenCalled();
  });

  it('two payloads of one purchase at once: the facilitator is called once', async () => {
    const header = await buy();
    const store = sellerStore();
    const f = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 20));
      landPayment();
      return { success: true, transaction: TX, network: 'eip155:8453' };
    });
    const both = await Promise.all([codeOf(run(header, store, f)), codeOf(run(header, store, f))]);
    expect(f).toHaveBeenCalledTimes(1);
    expect(both).toContain('ok');
  });

  it('refuses before recording anything: another file, a forged signature, a wrong nonce', async () => {
    const header = await buy();
    type P = {
      payload: { signature: string; authorization: { nonce: string } };
      extensions: { annon: { info: { fileId: string } } };
      accepted: { amount: string };
    };
    const p = decodePaymentSignatureHeader(header) as unknown as P;
    const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64');
    const store = sellerStore();
    const cas = vi.spyOn(store, 'compareAndSet');
    const f = facilitator();
    const forged = structuredClone(p);
    forged.payload.signature = `0x${'11'.repeat(65)}`;
    const wrongNonce = structuredClone(p);
    wrongNonce.payload.authorization.nonce = `0x${'ab'.repeat(32)}`;
    const otherFile = structuredClone(p);
    otherFile.extensions.annon.info.fileId = `0x${'12'.repeat(32)}`;
    const otherPrice = structuredClone(p);
    otherPrice.accepted.amount = '9999';
    for (const bad of [forged, wrongNonce, otherFile, otherPrice]) {
      expect(await codeOf(run(enc(bad), store, f))).toMatch(/^(bad_signature|bad_requirements)$/);
    }
    expect(cas).not.toHaveBeenCalled();
    expect(f).not.toHaveBeenCalled();
  });

  it('refuses a payment signed for less than the registered price, even when its offer says so', async () => {
    const header = await buy();
    const p = decodePaymentSignatureHeader(header) as unknown as {
      accepted: { amount: string };
      payload: { signature: string; authorization: Record<string, string> };
    };
    // A valid signature by the buyer over 9999, with the echoed offer asking 9999 too.
    const a: Record<string, string> = { ...p.payload.authorization, value: '9999' };
    p.accepted.amount = '9999';
    p.payload.authorization = a;
    p.payload.signature = await buyerAccount.signTypedData(
      asViem(
        typedData(USDC, {
          from: a.from as string,
          to: a.to as string,
          value: 9999n,
          validAfter: 0n,
          validBefore: BigInt(a.validBefore as string),
          nonce: a.nonce as string,
        }),
      ),
    );
    const store = sellerStore();
    const f = facilitator();
    const under = () => Buffer.from(JSON.stringify(p)).toString('base64');
    expect(await codeOf(run(under(), store, f))).toBe('bad_requirements');
    expect(f).not.toHaveBeenCalled();
    // The same purchase waiting to be settled again: the underpayment, valid one second longer,
    // must not be the payload sent.
    await codeOf(run(header, store, facilitator({ success: false, errorReason: 'x' })));
    const later: Record<string, string> = {
      ...a,
      validBefore: String(BigInt(a.validBefore as string) + 1n),
    };
    p.payload.authorization = later;
    p.payload.signature = await buyerAccount.signTypedData(
      asViem(
        typedData(USDC, {
          from: later.from as string,
          to: later.to as string,
          value: 9999n,
          validAfter: 0n,
          validBefore: BigInt(later.validBefore as string),
          nonce: later.nonce as string,
        }),
      ),
    );
    expect(await codeOf(run(under(), store, f))).toBe('bad_requirements');
    expect(f).not.toHaveBeenCalled();
  });

  it('settles a recorded purchase only with its recorded payload, never a longer one sent later', async () => {
    const header = await buy();
    const store = sellerStore();
    await codeOf(run(header, store, facilitator({ success: false, errorReason: 'x' })));
    const pr = await offerFor(offerOpts);
    // Sales stop; 399 s later the buyer's key signs the same nonce again, valid for a day.
    w.file = file({ sales_stopped_at: NOW + 1 });
    vi.mocked(Date.now).mockReturnValue((NOW + 399) * 1000);
    w.head = at(SIGNED + 5 * 399);
    const p = decodePaymentSignatureHeader(header) as unknown as {
      payload: { signature: string; authorization: Record<string, string> };
    };
    const long: Record<string, string> = {
      ...p.payload.authorization,
      validBefore: String(NOW + 399 + 86_400),
    };
    p.payload.authorization = long;
    (p as unknown as { accepted: { maxTimeoutSeconds: number } }).accepted.maxTimeoutSeconds =
      86_400;
    p.payload.signature = await buyerAccount.signTypedData(
      asViem(
        typedData(USDC, {
          from: long.from as string,
          to: long.to as string,
          value: 10_000n,
          validAfter: 0n,
          validBefore: BigInt(long.validBefore as string),
          nonce: long.nonce as string,
        }),
      ),
    );
    const f = facilitator({
      success: false,
      errorReason: 'invalid_exact_evm_payload_authorization_valid_before',
    });
    // A changed payload carries a new id (the old one would be a 409 at once).
    (p as unknown as { extensions: Record<string, { info: Record<string, unknown> }> }).extensions[
      'payment-identifier'
    ] = {
      ...declarePaymentIdentifierExtension(false),
      info: { required: false, id: 'pay_0123456789abcdef0123456789abcdef' },
    };
    await codeOf(run(Buffer.from(JSON.stringify(p)).toString('base64'), store, f));
    expect(f).toHaveBeenCalled();
    for (const [body] of f.mock.calls) {
      expect((body as { paymentPayload: unknown }).paymentPayload).toEqual(
        forFacilitator(header, pr.accepts[0] as never).paymentPayload,
      );
    }
  });

  it('runs the new-payment checks for a purchase never settled: a stop refuses it', async () => {
    const header = await buy();
    w.file = file({ sales_stopped_at: NOW });
    const f = facilitator();
    const store = sellerStore();
    expect(await codeOf(run(header, store, f))).toBe('sales_stopped');
    expect(f).not.toHaveBeenCalled();
  });

  it('keeps a refused settlement processing and retryable, and tries again on the next payload', async () => {
    const header = await buy();
    const store = sellerStore();
    const refused = facilitator({ success: false, errorReason: 'insufficient_funds' });
    expect(await codeOf(run(header, store, refused))).toBe('settlement_processing');
    // Within RETRY_SECONDS nobody calls the facilitator again; after it, the next payload does.
    const early = facilitator();
    expect(await codeOf(run(header, store, early))).toBe('settlement_processing');
    expect(early).not.toHaveBeenCalled();
    vi.mocked(Date.now).mockReturnValue((NOW + RETRY_SECONDS) * 1000);
    const f = facilitator();
    expect(await run(header, store, f)).toMatchObject({ state: 'settled' });
  });

  it('does not count a payment at a safe height whose block a reorg replaced', async () => {
    const header = await buy();
    const store = sellerStore();
    const f = facilitator();
    w.blockHashes = { [PAID_AT]: `0x${'cd'.repeat(32)}` };
    expect(await run(header, store, f)).toEqual({
      state: 'pending',
      transaction: TX,
      network: 'eip155:8453',
    });
    w.blockHashes = {};
    expect(await run(header, store, f)).toMatchObject({ state: 'settled' });
  });

  it('keeps answering pending with the hash when a later call for a broadcast purchase fails', async () => {
    const header = await buy();
    const store = sellerStore();
    const pending = facilitator({
      success: false,
      errorReason: 'settlement_pending',
      transaction: TX,
      network: 'eip155:8453',
    });
    expect(await run(header, store, pending)).toMatchObject({ state: 'pending' });
    vi.mocked(Date.now).mockReturnValue((NOW + 61) * 1000);
    const broken = vi.fn(async () => {
      throw new Error('connection reset');
    });
    expect(await run(header, store, broken)).toEqual({
      state: 'pending',
      transaction: TX,
      network: 'eip155:8453',
    });
  });

  it('aborts a facilitator call that hangs, before another request may call again', async () => {
    const header = await buy();
    const store = sellerStore();
    let aborted = false;
    const hang = vi.fn(
      (_body: unknown, o: { signal: AbortSignal }) =>
        new Promise<SettleResponse>((_, no) =>
          o.signal.addEventListener('abort', () => {
            aborted = true;
            no(o.signal.reason);
          }),
        ),
    );
    expect(
      await codeOf(
        settle(header, { ...offerOpts, store, facilitator: hang, facilitatorTimeoutMs: 30 }),
      ),
    ).toBe('settlement_processing');
    expect(aborted).toBe(true);
    // Given up and aborted: the next payload may call again, after RETRY_SECONDS.
    const early = facilitator();
    expect(await codeOf(run(header, store, early))).toBe('settlement_processing');
    expect(early).not.toHaveBeenCalled();
    vi.mocked(Date.now).mockReturnValue((NOW + RETRY_SECONDS) * 1000);
    const f = facilitator();
    expect(await run(header, store, f)).toMatchObject({ state: 'settled' });
  });

  it('never answers settled for a payment on Base below the registered price', async () => {
    const header = await buy();
    const atB = (l: RpcLog) => ({ ...l, blockNumber: `0x${PAID_AT.toString(16)}` });
    w.getLogs = [atB(used(ANNON))];
    w.receipt = receipt([used(ANNON), transfer(BUYER, PAY_TO, 9_999n, 4)].map(atB));
    const f = facilitator();
    expect(await codeOf(run(header, sellerStore(), f))).not.toBe('ok');
    expect(f).not.toHaveBeenCalled();
  });

  it('scopes payment ids by contract, file and url unless told otherwise', async () => {
    const header = await buy();
    const store = sellerStore();
    await run(header, store, facilitator());
    const id = extractPaymentIdentifier(decodePaymentSignatureHeader(header));
    expect(
      await store.load(`annon/seller/id/${CONTRACT}/${FILE}/${offerOpts.url}/${id}`),
    ).toMatchObject({ kind: 'id' });
  });

  it('gives the x402 PAYMENT-RESPONSE for both answers, as the official codec reads it', () => {
    const settled: X402SettleResponse = paymentResponse({
      state: 'settled',
      transaction: TX,
      network: 'eip155:8453',
      payer: BUYER,
      buyerKey: hex(buyerKey),
      nonce: ANNON,
    }) as X402SettleResponse;
    expect(decodePaymentResponseHeader(encodePaymentResponseHeader(settled))).toEqual({
      success: true,
      transaction: TX,
      network: 'eip155:8453',
      payer: BUYER,
    });
    const pending = paymentResponse({ state: 'pending', transaction: TX, network: 'eip155:8453' });
    expect(pending).toEqual({
      success: false,
      errorReason: 'settlement_pending',
      transaction: TX,
      network: 'eip155:8453',
    });
  });

  it('never calls the facilitator once a slow write has used up the lease', async () => {
    const header = await buy();
    const store = sellerStore();
    const cas = store.compareAndSet.bind(store);
    store.compareAndSet = async (key, expected, next) => {
      // The write that claims the purchase takes longer than the lease.
      if (next && 'state' in next && next.leaseUntil > 0) {
        vi.mocked(Date.now).mockReturnValue((NOW + 3600) * 1000);
      }
      return cas(key, expected, next);
    };
    const f = facilitator();
    expect(await codeOf(run(header, store, f))).toBe('settlement_processing');
    expect(f).not.toHaveBeenCalled();
  });

  it('answers from the record that won when another request recorded the payment meanwhile', async () => {
    const header = await buy();
    const store = sellerStore();
    const f = vi.fn(async () => {
      // While this call runs, another request finds the transaction and records it.
      const key = `annon/seller/purchase/eip155:8453/${USDC}/${BUYER}/${ANNON}`;
      const r = (await store.load(key)) as SellerRecord & { revision: number };
      await store.compareAndSet(key, r, {
        ...(r as object),
        revision: r.revision + 1,
        state: 'submitted',
        transaction: TX,
      } as SellerRecord);
      throw new Error('connection reset');
    });
    expect(await run(header, store, f)).toEqual({
      state: 'pending',
      transaction: TX,
      network: 'eip155:8453',
    });
  });

  const purchaseKeyOf = () => `annon/seller/purchase/eip155:8453/${USDC}/${BUYER}/${ANNON}`;
  /** Another request writes the purchase record while this one's facilitator call runs. */
  const meanwhile = (store: ReturnType<typeof sellerStore>, change: Record<string, unknown>) =>
    (async () => {
      const r = (await store.load(purchaseKeyOf())) as SellerRecord & { revision: number };
      await store.compareAndSet(purchaseKeyOf(), r, {
        ...(r as object),
        ...change,
        revision: r.revision + 1,
      } as SellerRecord);
    })();

  it('answers settled when another request recorded the settlement while its own call succeeded', async () => {
    const header = await buy();
    const store = sellerStore();
    const f = vi.fn(async () => {
      await meanwhile(store, { state: 'settled', transaction: TX });
      return { success: true, transaction: TX, network: 'eip155:8453' };
    });
    expect(await run(header, store, f)).toMatchObject({ state: 'settled', transaction: TX });
  });

  it('answers expired when another request found the purchase unpaid while its own call failed', async () => {
    const header = await buy();
    const store = sellerStore();
    const f = vi.fn(async () => {
      await meanwhile(store, { state: 'unpaid' });
      throw new Error('connection reset');
    });
    expect(await codeOf(run(header, store, f))).toBe('payment_expired');
  });

  it('keeps the pending answer of a broadcast purchase when a slow write leaves no time to call', async () => {
    const header = await buy();
    const store = sellerStore();
    const pending = facilitator({
      success: false,
      errorReason: 'settlement_pending',
      transaction: TX,
      network: 'eip155:8453',
    });
    await run(header, store, pending);
    vi.mocked(Date.now).mockReturnValue((NOW + 61) * 1000);
    const cas = store.compareAndSet.bind(store);
    store.compareAndSet = async (key, expected, next) => {
      if (next && 'state' in next && next.leaseUntil > 0) {
        vi.mocked(Date.now).mockReturnValue((NOW + 3600) * 1000);
      }
      return cas(key, expected, next);
    };
    const f = facilitator();
    expect(await run(header, store, f)).toEqual({
      state: 'pending',
      transaction: TX,
      network: 'eip155:8453',
    });
    expect(f).not.toHaveBeenCalled();
  });

  it('gives the facilitator only what is left of the lease after a slow write', async () => {
    const header = await buy();
    const store = sellerStore();
    const cas = store.compareAndSet.bind(store);
    store.compareAndSet = async (key, expected, next) => {
      // The claim takes 4 of the 15 s lease (5 s timeout + 10 s margin): 1 s is left for the call.
      if (next && 'state' in next && next.leaseUntil > 0) {
        vi.mocked(Date.now).mockReturnValue((NOW + 4) * 1000);
      }
      return cas(key, expected, next);
    };
    const hang = vi.fn(
      (_body: unknown, o: { signal: AbortSignal }) =>
        new Promise<SettleResponse>((_, no) =>
          o.signal.addEventListener('abort', () => no(o.signal.reason)),
        ),
    );
    const start = performance.now();
    expect(
      await codeOf(
        settle(header, { ...offerOpts, store, facilitator: hang, facilitatorTimeoutMs: 5_000 }),
      ),
    ).toBe('settlement_processing');
    expect(performance.now() - start).toBeLessThan(3_000);
  });

  it('answers from the winning record when every write of its own keeps losing', async () => {
    const header = await buy();
    const store = sellerStore();
    // Broadcast earlier: submitted with its hash; the lease has run out since.
    await run(
      header,
      store,
      facilitator({
        success: false,
        errorReason: 'settlement_pending',
        transaction: TX,
        network: 'eip155:8453',
      }),
    );
    vi.mocked(Date.now).mockReturnValue((NOW + 61) * 1000);
    landPayment();
    w.safe = at(PAID_AT - 1);
    // Another request wins every write from now on.
    store.compareAndSet = async () => false;
    expect(await run(header, store, facilitator())).toEqual({
      state: 'pending',
      transaction: TX,
      network: 'eip155:8453',
    });
  });

  it('answers settled when another request recorded it right after this one recorded the broadcast', async () => {
    const header = await buy();
    const store = sellerStore();
    const cas = store.compareAndSet.bind(store);
    store.compareAndSet = async (key, expected, next) => {
      const ok = await cas(key, expected, next);
      if (ok && next && 'state' in next && next.state === 'submitted') {
        await meanwhile(store, { state: 'settled', transaction: TX });
      }
      return ok;
    };
    expect(await run(header, store, facilitator())).toMatchObject({
      state: 'settled',
      transaction: TX,
    });
  });
});

// ---------- download.md section 1: one URL sells, returns and serves the file ----------

describe('serveFile (download.md section 1)', () => {
  const URL1 = 'https://seller.example/f/1';
  const BODY = new Uint8Array(100).map((_, i) => i);
  const hostOpts = (store = memoryStore<HostRecord>(), f = facilitatorOf()) => ({
    nearRpc: NEAR,
    baseRpc: BASE,
    contractId: CONTRACT,
    fileId: FILE,
    url: URL1,
    header: 'https://seller.example/f/1/header',
    headerHash: sha256(HEADER),
    store,
    facilitator: f,
    file: {
      size: BODY.length,
      read: (start: number) => new Blob([BODY.subarray(start)]).stream(),
    },
  });
  const PAID_AT = SIGNED + 20;
  const land = () => {
    const atB = (l: RpcLog) => ({ ...l, blockNumber: `0x${PAID_AT.toString(16)}` });
    w.getLogs = [atB(used(ANNON))];
    w.receipt = receipt([used(ANNON), transfer(BUYER, PAY_TO, 10_000n, 4)].map(atB));
  };
  function facilitatorOf(answer?: SettleResponse) {
    return vi.fn(async () => {
      if (!answer) land();
      return answer ?? { success: true, transaction: TX, network: 'eip155:8453', payer: BUYER };
    });
  }
  const SECRET = Uint8Array.from(Buffer.from(7n.toString(16).padStart(64, '0'), 'hex'));
  const paid = async () => {
    const o = hostOpts();
    const pr = await offerFor(o);
    const q = await preflight(opts({ paymentRequired: pr }));
    const wallet = {
      address: buyerAccount.address,
      signTypedData: (t: ReturnType<typeof typedData>) => buyerAccount.signTypedData(asViem(t)),
    };
    return (await authorize(q, { buyerKey, wallet, store: memoryStore() })).header;
  };
  const req = (h: Record<string, string>) => ({ headers: new Headers(h) });
  const body = async (r: { body?: ReadableStream<Uint8Array> }) =>
    new Uint8Array(await new Response(r.body).arrayBuffer());
  const decode = (h: string) => JSON.parse(Buffer.from(h, 'base64').toString());
  beforeEach(() => {
    w.head = at(SIGNED + 50);
  });

  it('answers a bare request with the offer, upfront, and a stored sign-in challenge', async () => {
    const o = hostOpts();
    const r = await serveFile(req({}), o);
    expect(r.status).toBe(402);
    const pr = decode(r.headers['PAYMENT-REQUIRED'] as string);
    expect(pr.resource).toEqual({ url: URL1 });
    expect(pr.accepts[0].extra.paymentFlow).toBe('upfront');
    const c = pr.extensions['sign-in-with-x'].info;
    expect(c).toMatchObject({ domain: 'seller.example', uri: URL1 });
    expect(await o.store.load(`annon/host/challenge/${c.nonce}`)).toMatchObject({
      kind: 'challenge',
    });
  });

  it('answers 410 for a taken-down file, whatever the request carries', async () => {
    const header = await paid();
    w.file = file({ taken_down: 'court_order' });
    const gone = await serveFile(req({ 'PAYMENT-SIGNATURE': header }), hostOpts());
    expect(gone.status).toBe(410);
    expect(gone.headers['Cache-Control']).toBe('no-store');
    w.file = null as never;
    const missing = await serveFile(req({}), hostOpts());
    expect(missing.status).toBe(404);
    expect(missing.headers['Cache-Control']).toBe('no-store');
  });

  it('returns the file with the payment to the request that proves the one-time key', async () => {
    const header = await paid();
    const o = hostOpts();
    const r = await serveFile(
      req({ 'PAYMENT-SIGNATURE': header, 'Annon-Buyer-Proof': buyerProof(SECRET, URL1) }),
      o,
    );
    expect(r.status).toBe(200);
    expect(decode(r.headers['PAYMENT-RESPONSE'] as string)).toMatchObject({
      success: true,
      transaction: TX,
    });
    expect(r.headers['Cache-Control']).toBe('private, no-store');
    expect(await body(r)).toEqual(BODY);
  });

  it('never returns the body for the payload alone, or a proof for another URL or key', async () => {
    const header = await paid();
    const o = hostOpts();
    const other = Uint8Array.from(Buffer.from(8n.toString(16).padStart(64, '0'), 'hex'));
    for (const proof of [
      undefined,
      buyerProof(SECRET, 'https://other.example/f/1'),
      buyerProof(other, URL1),
    ]) {
      const r = await serveFile(
        req({ 'PAYMENT-SIGNATURE': header, ...(proof ? { 'Annon-Buyer-Proof': proof } : {}) }),
        o,
      );
      expect(r.status).toBe(402);
      expect(r.body).toBeUndefined();
      expect(decode(r.headers['PAYMENT-RESPONSE'] as string)).toMatchObject({ success: true });
      expect(r.headers['PAYMENT-REQUIRED']).toBeDefined();
    }
  });

  it('answers pending with its hash, then the file once settled', async () => {
    const header = await paid();
    const store = memoryStore<HostRecord>();
    const pending = facilitatorOf({
      success: false,
      errorReason: 'settlement_pending',
      transaction: TX,
      network: 'eip155:8453',
    });
    const h = { 'PAYMENT-SIGNATURE': header, 'Annon-Buyer-Proof': buyerProof(SECRET, URL1) };
    const first = await serveFile(req(h), hostOpts(store, pending));
    expect(first.status).toBe(402);
    expect(decode(first.headers['PAYMENT-RESPONSE'] as string)).toMatchObject({
      success: false,
      errorReason: 'settlement_pending',
      transaction: TX,
    });
    expect(first.body).toBeUndefined();
    land();
    const second = await serveFile(req(h), hostOpts(store, pending));
    expect(second.status).toBe(200);
    expect(await body(second)).toEqual(BODY);
  });

  it('answers 503 with Retry-After while settling with no transaction known', async () => {
    const header = await paid();
    const lost = vi.fn(async () => {
      throw new Error('connection reset');
    });
    const r = await serveFile(
      req({ 'PAYMENT-SIGNATURE': header, 'Annon-Buyer-Proof': buyerProof(SECRET, URL1) }),
      hostOpts(memoryStore(), lost as never),
    );
    expect(r.status).toBe(503);
    expect(r.headers['Retry-After']).toBeDefined();
    expect(r.headers['PAYMENT-RESPONSE']).toBeUndefined();
  });

  it('answers 400 for a bad payload and 409 for a payment id reused with another payload', async () => {
    const o = hostOpts();
    expect((await serveFile(req({ 'PAYMENT-SIGNATURE': 'e30=' }), o)).status).toBe(400);
    const header = await paid();
    await serveFile(req({ 'PAYMENT-SIGNATURE': header }), o);
    const p = decodePaymentSignatureHeader(header) as unknown as {
      payload: { signature: string };
    };
    p.payload.signature = `0x${'11'.repeat(65)}`;
    const forged = Buffer.from(JSON.stringify(p)).toString('base64');
    expect((await serveFile(req({ 'PAYMENT-SIGNATURE': forged }), o)).status).toBe(400);
  });

  const signIn = async (o: ReturnType<typeof hostOpts>, who = buyerAccount) => {
    const r = await serveFile(req({}), o);
    const c = decode(r.headers['PAYMENT-REQUIRED'] as string).extensions['sign-in-with-x'].info;
    const sig = await who.signMessage({ message: signInMessage(c, who.address) });
    return signInHeader(c, who.address, sig);
  };

  it('serves a buyer who signs in, gives a session, and takes each challenge once', async () => {
    w.isBuyer = true;
    const o = hostOpts();
    const proof = await signIn(o);
    const r = await serveFile(req({ 'SIGN-IN-WITH-X': proof }), o);
    expect(r.status).toBe(200);
    expect(await body(r)).toEqual(BODY);
    const token = r.headers['Annon-Session'] as string;
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    // The same proof again: its challenge is gone.
    expect((await serveFile(req({ 'SIGN-IN-WITH-X': proof }), o)).status).toBe(402);
    // The session resumes with Range, for any number of requests.
    for (let i = 0; i < 2; i++) {
      const part = await serveFile(
        req({ Authorization: `Bearer ${token}`, Range: 'bytes=60-' }),
        o,
      );
      expect(part.status).toBe(206);
      expect(part.headers['Content-Range']).toBe('bytes 60-99/100');
      expect(await body(part)).toEqual(BODY.subarray(60));
    }
    // Two hours later the session is over.
    vi.mocked(Date.now).mockReturnValue((NOW + 7_200) * 1000);
    expect((await serveFile(req({ Authorization: `Bearer ${token}` }), o)).status).toBe(402);
    // The store never holds the token itself.
    expect(JSON.stringify(await o.store.load(`annon/host/session/${token}`))).toBe('null');
  });

  it('serves a wallet whose purchase this host settled, before NEAR records it', async () => {
    const header = await paid();
    const o = hostOpts();
    await serveFile(req({ 'PAYMENT-SIGNATURE': header }), o);
    w.isBuyer = false;
    const r = await serveFile(req({ 'SIGN-IN-WITH-X': await signIn(o) }), o);
    expect(r.status).toBe(200);
  });

  it('asks a signed-in wallet that did not buy to pay while on sale, and says 403 once stopped', async () => {
    const o = hostOpts();
    const open = await serveFile(req({ 'SIGN-IN-WITH-X': await signIn(o, otherAccount) }), o);
    expect(open.status).toBe(402);
    expect(decode(open.headers['PAYMENT-REQUIRED'] as string).accepts).toHaveLength(1);
    const proof = await signIn(o, otherAccount);
    w.file = file({ sales_stopped_at: NOW });
    const stopped = await serveFile(req({ 'SIGN-IN-WITH-X': proof }), o);
    expect(stopped.status).toBe(403);
    // A bare request after a stop: no offer, the sign-in only.
    const bare = await serveFile(req({}), o);
    expect(decode(bare.headers['PAYMENT-REQUIRED'] as string).accepts).toEqual([]);
  });

  it('after a stop, does not tell a wallet with a purchase under way that nothing can be done', async () => {
    const header = await paid();
    const store = memoryStore<HostRecord>();
    const pending = facilitatorOf({
      success: false,
      errorReason: 'settlement_pending',
      transaction: TX,
      network: 'eip155:8453',
    });
    await serveFile(req({ 'PAYMENT-SIGNATURE': header }), hostOpts(store, pending));
    const proof = await signIn(hostOpts(store, pending));
    w.file = file({ sales_stopped_at: NOW });
    const r = await serveFile(req({ 'SIGN-IN-WITH-X': proof }), hostOpts(store, pending));
    // That purchase's answer: pending, with its hash.
    expect(r.status).toBe(402);
    expect(decode(r.headers['PAYMENT-RESPONSE'] as string)).toMatchObject({
      errorReason: 'settlement_pending',
      transaction: TX,
    });
    const token = r.headers['Annon-Session'] as string;
    // Still so past its validBefore, while Base does not show it yet.
    vi.mocked(Date.now).mockReturnValue((NOW + 3_000) * 1000);
    const later = await serveFile(
      req({ Authorization: `Bearer ${token}` }),
      hostOpts(store, pending),
    );
    expect(later.status).toBe(402);
    expect(decode(later.headers['PAYMENT-RESPONSE'] as string).transaction).toBe(TX);
    // Once it lands, the host finds it on Base from the recorded payload: the file, no payload sent.
    land();
    const landed = await serveFile(
      req({ Authorization: `Bearer ${token}` }),
      hostOpts(store, pending),
    );
    expect(landed.status).toBe(200);
    expect(decode(landed.headers['PAYMENT-RESPONSE'] as string)).toMatchObject({
      success: true,
      transaction: TX,
    });
  });

  it('after a stop, answers 503 for a purchase still being settled, and 403 once it is unpaid', async () => {
    const header = await paid();
    const store = memoryStore<HostRecord>();
    const lost = vi.fn(async () => {
      throw new Error('connection reset');
    });
    await serveFile(req({ 'PAYMENT-SIGNATURE': header }), hostOpts(store, lost as never));
    const proof = await signIn(hostOpts(store));
    w.file = file({ sales_stopped_at: NOW });
    const r = await serveFile(req({ 'SIGN-IN-WITH-X': proof }), hostOpts(store, lost as never));
    expect(r.status).toBe(503);
    expect(r.headers['Retry-After']).toBeDefined();
    const token = r.headers['Annon-Session'] as string;
    // Base, finalized past its validBefore, shows no payment: nothing left to do.
    w.finalized = at(SIGNED + 100_000);
    w.head = at(SIGNED + 100_000);
    vi.mocked(Date.now).mockReturnValue((NOW + 3_000) * 1000);
    expect(
      (await serveFile(req({ Authorization: `Bearer ${token}` }), hostOpts(store, lost as never)))
        .status,
    ).toBe(403);
    // The payment only: the sign-in came within RETRY_SECONDS, and later Base ruled it out.
    expect(lost).toHaveBeenCalledTimes(1);
  });

  it('after a stop, answers 503 to a sign-in while the payment is inside its facilitator call, then serves', async () => {
    const header = await paid();
    const store = memoryStore<HostRecord>();
    let release = () => {};
    let called = () => {};
    const inCall = new Promise<void>((r) => {
      called = r;
    });
    const slow = vi.fn(async () => {
      called();
      await new Promise<void>((r) => {
        release = r;
      });
      land();
      return { success: true, transaction: TX, network: 'eip155:8453', payer: BUYER };
    });
    const paying = serveFile(req({ 'PAYMENT-SIGNATURE': header }), hostOpts(store, slow as never));
    await inCall;
    const proof = await signIn(hostOpts(store, slow as never));
    w.file = file({ sales_stopped_at: NOW });
    const r = await serveFile(req({ 'SIGN-IN-WITH-X': proof }), hostOpts(store, slow as never));
    expect(r.status).toBe(503);
    expect(slow).toHaveBeenCalledTimes(1);
    release();
    expect((await paying).status).toBe(402);
    // Settled at Base safe: the wallet's session gets the file, NEAR not needed yet.
    w.isBuyer = false;
    const token = r.headers['Annon-Session'] as string;
    const after = await serveFile(
      req({ Authorization: `Bearer ${token}` }),
      hostOpts(store, slow as never),
    );
    expect(after.status).toBe(200);
  });

  it('serves a sign-in after a payload the host first saw already paid on Base', async () => {
    const header = await paid();
    const store = memoryStore<HostRecord>();
    const f = facilitatorOf();
    land();
    const first = await serveFile(req({ 'PAYMENT-SIGNATURE': header }), hostOpts(store, f));
    expect(decode(first.headers['PAYMENT-RESPONSE'] as string)).toMatchObject({ success: true });
    expect(f).not.toHaveBeenCalled();
    w.isBuyer = false;
    const r = await serveFile(
      req({ 'SIGN-IN-WITH-X': await signIn(hostOpts(store, f)) }),
      hostOpts(store, f),
    );
    expect(r.status).toBe(200);
  });

  it('serves a settled purchase without asking Base again, even when Base is unreachable', async () => {
    const header = await paid();
    const store = memoryStore<HostRecord>();
    await serveFile(req({ 'PAYMENT-SIGNATURE': header }), hostOpts(store));
    w.isBuyer = false;
    const proof = await signIn(hostOpts(store));
    w.onTag = () => {
      throw new Error('Base is down');
    };
    w.calls = [];
    const r = await serveFile(req({ 'SIGN-IN-WITH-X': proof }), hostOpts(store));
    // The record decides: no settle again, so only the request's own reads of the file.
    expect(w.calls.filter((c) => c.method === 'near:get_file')).toHaveLength(1);
    expect(w.calls.filter((c) => !c.method.startsWith('near:'))).toEqual([]);
    expect(r.status).toBe(200);
    expect(decode(r.headers['PAYMENT-RESPONSE'] as string)).toMatchObject({
      success: true,
      transaction: TX,
      payer: BUYER,
    });
  });

  it('after a stop, answers 503, not 500, while Base cannot be asked about an open purchase', async () => {
    const header = await paid();
    const store = memoryStore<HostRecord>();
    const lost = vi.fn(async () => {
      throw new Error('connection reset');
    });
    await serveFile(req({ 'PAYMENT-SIGNATURE': header }), hostOpts(store, lost as never));
    const proof = await signIn(hostOpts(store));
    w.file = file({ sales_stopped_at: NOW });
    w.onTag = () => {
      throw new Error('Base is down');
    };
    expect(
      (await serveFile(req({ 'SIGN-IN-WITH-X': proof }), hostOpts(store, lost as never))).status,
    ).toBe(503);
  });

  it('serves a sign-in once a pending payment lands, with sales open and no payload resent', async () => {
    const header = await paid();
    const store = memoryStore<HostRecord>();
    const pending = facilitatorOf({
      success: false,
      errorReason: 'settlement_pending',
      transaction: TX,
      network: 'eip155:8453',
    });
    expect(
      (await serveFile(req({ 'PAYMENT-SIGNATURE': header }), hostOpts(store, pending))).status,
    ).toBe(402);
    // Not landed yet: the wallet is asked to pay, as section 1 step 6 says while on sale.
    const early = await serveFile(
      req({ 'SIGN-IN-WITH-X': await signIn(hostOpts(store, pending)) }),
      hostOpts(store, pending),
    );
    expect(early.status).toBe(402);
    land();
    w.isBuyer = false;
    const r = await serveFile(
      req({ 'SIGN-IN-WITH-X': await signIn(hostOpts(store, pending)) }),
      hostOpts(store, pending),
    );
    expect(r.status).toBe(200);
    expect(decode(r.headers['PAYMENT-RESPONSE'] as string)).toMatchObject({
      success: true,
      transaction: TX,
    });
    expect(await body(r)).toEqual(BODY);
  });

  it("serves a buyer's sign-in sent with another wallet's session", async () => {
    const header = await paid();
    const o = hostOpts();
    await serveFile(req({ 'PAYMENT-SIGNATURE': header }), o);
    w.isBuyer = false;
    const token = (await serveFile(req({ 'SIGN-IN-WITH-X': await signIn(o, otherAccount) }), o))
      .headers['Annon-Session'] as string;
    expect((await serveFile(req({ Authorization: `Bearer ${token}` }), o)).status).toBe(402);
    const r = await serveFile(
      req({ Authorization: `Bearer ${token}`, 'SIGN-IN-WITH-X': await signIn(o) }),
      o,
    );
    expect(r.status).toBe(200);
  });

  it('serves a session buyer even when the payload sent along is still pending', async () => {
    const header = await paid();
    w.isBuyer = true;
    const store = memoryStore<HostRecord>();
    const o = hostOpts(store);
    const token = (await serveFile(req({ 'SIGN-IN-WITH-X': await signIn(o) }), o)).headers[
      'Annon-Session'
    ] as string;
    const pending = facilitatorOf({
      success: false,
      errorReason: 'settlement_pending',
      transaction: TX,
      network: 'eip155:8453',
    });
    const r = await serveFile(
      req({ 'PAYMENT-SIGNATURE': header, Authorization: `Bearer ${token}` }),
      hostOpts(store, pending),
    );
    expect(r.status).toBe(200);
    // Each request asks NEAR again: a session is a wallet, not a standing permission.
    w.isBuyer = false;
    expect((await serveFile(req({ Authorization: `Bearer ${token}` }), o)).status).toBe(402);
  });

  it('never takes a challenge another host issued, even from a shared store', async () => {
    w.isBuyer = true;
    const store = memoryStore<HostRecord>();
    const a = hostOpts(store);
    const proof = await signIn(a);
    for (const b of [
      { ...hostOpts(store), url: 'https://mirror.example/f/1' },
      { ...hostOpts(store), url: 'https://seller.example/f/2' },
      { ...hostOpts(store), headerHash: `0x${'99'.repeat(32)}` },
    ]) {
      const r = await serveFile(req({ 'SIGN-IN-WITH-X': proof }), b);
      expect(r.status).toBe(402);
      expect(r.headers['Annon-Session']).toBeUndefined();
    }
    // Still good where it was issued.
    expect((await serveFile(req({ 'SIGN-IN-WITH-X': proof }), a)).status).toBe(200);
  });

  it('marks every answer uncached, and treats an empty payment header as a bad payload', async () => {
    const header = await paid();
    const pending = facilitatorOf({
      success: false,
      errorReason: 'settlement_pending',
      transaction: TX,
      network: 'eip155:8453',
    });
    const r = await serveFile(req({ 'PAYMENT-SIGNATURE': header }), hostOpts(undefined, pending));
    expect(r.status).toBe(402);
    expect(r.headers['Cache-Control']).toBe('no-store');
    w.isBuyer = true;
    const o = hostOpts();
    const empty = await serveFile(
      req({ 'PAYMENT-SIGNATURE': '', 'SIGN-IN-WITH-X': await signIn(o) }),
      o,
    );
    expect(empty.status).toBe(400);
    expect(empty.headers['Cache-Control']).toBe('no-store');
  });

  it('answers 416 for a range past the end', async () => {
    w.isBuyer = true;
    const o = hostOpts();
    const r = await serveFile(req({ 'SIGN-IN-WITH-X': await signIn(o), Range: 'bytes=100-' }), o);
    expect(r.status).toBe(416);
    expect(r.headers['Content-Range']).toBe('bytes */100');
  });

  it('answers 410 after a takedown to a signed-in buyer and a session too', async () => {
    w.isBuyer = true;
    const o = hostOpts();
    const proof = await signIn(o);
    const first = await serveFile(req({ 'SIGN-IN-WITH-X': await signIn(o) }), o);
    const token = first.headers['Annon-Session'] as string;
    w.file = file({ taken_down: 'court_order' });
    for (const h of [{ 'SIGN-IN-WITH-X': proof }, { Authorization: `Bearer ${token}` }, {}]) {
      expect((await serveFile(req(h), o)).status).toBe(410);
    }
  });

  it('takes a session only on the origin that issued it, even with a shared store', async () => {
    w.isBuyer = true;
    const store = memoryStore<HostRecord>();
    const a = hostOpts(store);
    const token = (await serveFile(req({ 'SIGN-IN-WITH-X': await signIn(a) }), a)).headers[
      'Annon-Session'
    ] as string;
    const b = { ...hostOpts(store), url: 'https://mirror.example/f/1' };
    expect((await serveFile(req({ Authorization: `Bearer ${token}` }), b)).status).toBe(402);
    expect((await serveFile(req({ Authorization: `Bearer ${token}` }), a)).status).toBe(200);
  });
});

// ---------- profile section 9: the file URL over real HTTP, with the browser rules ----------

describe('the HTTP host (profile section 9)', () => {
  const PAGE = 'https://market.example';
  const serve = async (over: Record<string, unknown> = {}) => {
    const server = createServer();
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    const url = `http://localhost:${port}/f/1`;
    const store = memoryStore<HostRecord>();
    server.on(
      'request',
      nodeHandler({
        nearRpc: NEAR,
        baseRpc: BASE,
        contractId: CONTRACT,
        fileId: FILE,
        url,
        header: `http://localhost:${port}/h/1`,
        headerHash: sha256(HEADER),
        store,
        facilitator: async () => ({ success: false, errorReason: 'unused' }),
        file: {
          size: PAY2.length,
          read: (start: number) => new Blob([PAY2.subarray(start)]).stream(),
        },
        allowedOrigins: [PAGE],
        ...over,
      }),
    );
    return { url, close: () => new Promise<void>((r) => server.close(() => r())) };
  };

  it('answers the preflight without payment, for listed origins only', async () => {
    const { url, close } = await serve();
    try {
      const ok = await realFetch(url, { method: 'OPTIONS', headers: { Origin: PAGE } });
      expect(ok.status).toBe(204);
      expect(ok.headers.get('access-control-allow-origin')).toBe(PAGE);
      expect(ok.headers.get('access-control-allow-methods')).toBe('GET');
      expect(ok.headers.get('access-control-allow-headers')).toBe(
        'PAYMENT-SIGNATURE, Annon-Buyer-Proof, SIGN-IN-WITH-X, Authorization, Range, Content-Type',
      );
      expect(Number(ok.headers.get('access-control-max-age'))).toBeGreaterThan(0);
      const other = await realFetch(url, {
        method: 'OPTIONS',
        headers: { Origin: 'https://evil.example' },
      });
      expect(other.headers.get('access-control-allow-origin')).toBeNull();
      const post = await realFetch(url, { method: 'POST' });
      expect(post.status).toBe(405);
      for (const r of [ok, other, post]) expect(r.headers.get('cache-control')).toBe('no-store');
    } finally {
      await close();
    }
  });

  it('lets a listed page read the 402 and its headers, uncached, never with credentials', async () => {
    const { url, close } = await serve();
    try {
      const r = await realFetch(url, { headers: { Origin: PAGE } });
      expect(r.status).toBe(402);
      expect(r.headers.get('access-control-allow-origin')).toBe(PAGE);
      expect(r.headers.get('access-control-expose-headers')).toContain('PAYMENT-REQUIRED');
      expect(r.headers.get('access-control-expose-headers')).toContain('Annon-Session');
      expect(r.headers.get('access-control-expose-headers')).toContain('Retry-After');
      expect(r.headers.get('vary')).toBe('Origin');
      expect(r.headers.get('cache-control')).toBe('no-store');
      expect(r.headers.get('access-control-allow-credentials')).toBeNull();
      expect(r.headers.get('set-cookie')).toBeNull();
    } finally {
      await close();
    }
  });

  /** A session from the host, by a sign-in over HTTP. */
  const signInOver = async (url: string) => {
    const first = await realFetch(url);
    const c = JSON.parse(
      Buffer.from(first.headers.get('payment-required') as string, 'base64').toString(),
    ).extensions['sign-in-with-x'].info;
    const sig = await buyerAccount.signMessage({
      message: signInMessage(c, buyerAccount.address),
    });
    const r = await realFetch(url, {
      headers: { 'SIGN-IN-WITH-X': signInHeader(c, buyerAccount.address, sig), Range: 'bytes=0-' },
    });
    await r.body?.cancel();
    return r.headers.get('annon-session') as string;
  };

  it('answers 500, uncached and with CORS, when the host itself fails', async () => {
    const { url, close } = await serve({ nearRpc: 'https://unknown-rpc.example' });
    try {
      const r = await realFetch(url, { headers: { Origin: PAGE } });
      expect(r.status).toBe(500);
      expect(r.headers.get('cache-control')).toBe('no-store');
      expect(r.headers.get('access-control-allow-origin')).toBe(PAGE);
    } finally {
      await close();
    }
  });

  it('merges the exposed headers and Vary that middleware set before, never replacing them', async () => {
    const server = createServer();
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    const url = `http://localhost:${port}/f/1`;
    const handler = nodeHandler({
      nearRpc: NEAR,
      baseRpc: BASE,
      contractId: CONTRACT,
      fileId: FILE,
      url,
      header: `http://localhost:${port}/h/1`,
      headerHash: sha256(HEADER),
      store: memoryStore<HostRecord>(),
      facilitator: async () => ({ success: false, errorReason: 'unused' }),
      file: {
        size: PAY2.length,
        read: (start: number) => new Blob([PAY2.subarray(start)]).stream(),
      },
      allowedOrigins: [PAGE],
    });
    server.on('request', (req, res) => {
      res.setHeader('Access-Control-Expose-Headers', 'X-Trace, payment-required');
      res.setHeader('Vary', 'Accept-Encoding');
      return handler(req, res);
    });
    try {
      const r = await realFetch(url, { headers: { Origin: PAGE } });
      expect(r.status).toBe(402);
      const exposed = (r.headers.get('access-control-expose-headers') ?? '').split(', ');
      expect(exposed).toContain('X-Trace');
      expect(exposed).toContain('Annon-Session');
      expect(exposed.filter((h) => h.toLowerCase() === 'payment-required')).toHaveLength(1);
      expect(r.headers.get('vary')).toBe('Accept-Encoding, Origin');
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('says Vary: Origin to a request without one too, so a cache never mixes the two', async () => {
    const { url, close } = await serve();
    try {
      const r = await realFetch(url);
      expect(r.headers.get('vary')).toBe('Origin');
      expect(r.headers.get('access-control-allow-origin')).toBeNull();
    } finally {
      await close();
    }
  });

  it('cuts the response when the file fails mid-read, and the server keeps running', async () => {
    w.isBuyer = true;
    const failing = {
      size: 1_000_000,
      read: () =>
        new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(new Uint8Array(1000));
          },
          pull() {
            throw new Error('disk gone');
          },
        }),
    };
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    const { url, close } = await serve({ file: failing });
    try {
      const sid = await signInOver(url);
      const r = await realFetch(url, { headers: { Authorization: `Bearer ${sid}` } });
      expect(r.status).toBe(200);
      await expect(r.arrayBuffer()).rejects.toThrow();
      // The next request is answered: nothing escaped the handler.
      expect((await realFetch(url)).status).toBe(402);
      await new Promise((r) => setTimeout(r, 20));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
      await close();
    }
  });

  it('reads the file only as fast as the client takes it, and stops when the client goes', async () => {
    w.isBuyer = true;
    let pulled = 0;
    let cancelled = false;
    const big = {
      size: 256 * 65536,
      read: () =>
        new ReadableStream<Uint8Array>(
          {
            pull(c) {
              if (pulled === 256) return c.close();
              pulled++;
              c.enqueue(new Uint8Array(65536));
            },
            cancel() {
              cancelled = true;
            },
          },
          { highWaterMark: 0 },
        ),
    };
    const { url, close } = await serve({ file: big });
    try {
      const sid = await signInOver(url);
      const abort = new AbortController();
      const r = await realFetch(url, {
        headers: { Authorization: `Bearer ${sid}` },
        signal: abort.signal,
      });
      expect(r.status).toBe(200);
      // The client reads nothing: socket buffers fill and the server stops pulling well short.
      await new Promise((r) => setTimeout(r, 300));
      expect(pulled).toBeLessThan(200);
      abort.abort();
      await new Promise((r) => setTimeout(r, 200));
      expect(cancelled).toBe(true);
    } finally {
      await close();
    }
  });

  it('serves a buyer who signs in, end to end, every chunk checked by the client', async () => {
    w.isBuyer = true;
    const { url, close } = await serve();
    try {
      let token = '';
      const s = download({
        url,
        contractId: CONTRACT,
        fileId: FILE,
        header: HEADER,
        wallet: {
          address: buyerAccount.address,
          signMessage: (message) => buyerAccount.signMessage({ message }),
        },
        onSession: (t) => {
          token = t;
        },
        fetch: realFetch,
      });
      const got = new Uint8Array(await new Response(s).arrayBuffer());
      expect(Buffer.from(got).equals(Buffer.from(PAY2))).toBe(true);
      expect(token).toMatch(/^[0-9a-f]{64}$/);
      // The session over HTTP, from the middle of the file.
      const part = await realFetch(url, {
        headers: { Authorization: `Bearer ${token}`, Range: 'bytes=100-' },
      });
      expect(part.status).toBe(206);
      expect(part.headers.get('content-range')).toBe(`bytes 100-${PAY2.length - 1}/${PAY2.length}`);
      expect(Buffer.from(await part.arrayBuffer()).equals(Buffer.from(PAY2.subarray(100)))).toBe(
        true,
      );
    } finally {
      await close();
    }
  });

  it('sells and returns the file in the paid response, end to end over HTTP', async () => {
    w.head = at(SIGNED + 50);
    const landed = vi.fn(async () => {
      const atB = (l: RpcLog) => ({ ...l, blockNumber: `0x${(SIGNED + 20).toString(16)}` });
      w.getLogs = [atB(used(ANNON))];
      w.receipt = receipt([used(ANNON), transfer(BUYER, PAY_TO, 10_000n, 4)].map(atB));
      return { success: true, transaction: TX, network: 'eip155:8453', payer: BUYER };
    });
    const { url, close } = await serve({ facilitator: landed });
    try {
      // The buyer reads the 402 from the host itself and checks it against the contract.
      const first = await realFetch(url);
      const pr = readPaymentRequired(first.headers.get('payment-required') as string);
      const q = await preflight(opts({ paymentRequired: pr }));
      const wallet = {
        address: buyerAccount.address,
        signTypedData: (t: ReturnType<typeof typedData>) => buyerAccount.signTypedData(asViem(t)),
      };
      const { header } = await authorize(q, { buyerKey, wallet, store: memoryStore() });
      const secret = Uint8Array.from(Buffer.from(7n.toString(16).padStart(64, '0'), 'hex'));
      const s = download({
        url,
        contractId: CONTRACT,
        fileId: FILE,
        header: HEADER,
        payment: { header, secret },
        fetch: realFetch,
      });
      const got = new Uint8Array(await new Response(s).arrayBuffer());
      expect(Buffer.from(got).equals(Buffer.from(PAY2))).toBe(true);
      expect(landed).toHaveBeenCalledTimes(1);
    } finally {
      await close();
    }
  });
});
