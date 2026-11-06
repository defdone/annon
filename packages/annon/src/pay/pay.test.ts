import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { bls12_381 as bls } from '@noble/curves/bls12-381.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { x402Client } from '@x402/core/client';
import { decodePaymentSignatureHeader, encodePaymentRequiredHeader } from '@x402/core/http';
import { parsePaymentPayload, parsePaymentRequired } from '@x402/core/schemas';
import { registerExactEvmScheme } from '@x402/evm/exact/client';
import { ExactEvmScheme } from '@x402/evm/exact/facilitator';
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
  verifyTypedData,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { blockHeader, type Expected, PayError, paymentLogs } from './base.js';
import { type Authorization, annonNonce, digest, signer, typedData } from './eip3009.js';
import {
  authorize,
  MAX_CLOCK_SKEW_SECONDS,
  MAX_VALIDITY_SECONDS,
  type PaymentJob,
  preflight,
  status,
} from './pay.js';
import { checkPayment, forFacilitator, offerFor, verifyPayment } from './seller.js';
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
const SELLER = `0x${'ab'.repeat(20)}`;
const PAY_TO = `0x${'5e'.repeat(20)}`;
const NOW = 1_800_000_000;
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

const file = (over: Record<string, unknown> = {}) => ({
  seller: SELLER,
  price: '10000',
  pay_to: PAY_TO,
  cipher_hash: `0x${'22'.repeat(32)}`,
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
      const b =
        tag === 'latest' ? w.head : tag === 'finalized' ? w.finalized : at(Number(tag as string));
      // Like a real node: no answer for a block past the head.
      if (b.number > w.head.number) return reply(null);
      return reply({
        number: `0x${b.number.toString(16)}`,
        timestamp: `0x${b.timestamp.toString(16)}`,
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
  maxPrice: 10_000n,
  ...over,
});
const codeOf = (p: Promise<unknown>) =>
  p.then(
    () => 'ok',
    (e: unknown) =>
      e instanceof PayError ? e.code : `${(e as Error).name}: ${(e as Error).message}`,
  );

describe('preflight', () => {
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
        return opts({ paymentRequired: required(offer({ scheme: 'annon-receive' })) });
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

  it('reads the contract it was given, not the mainnet one', async () => {
    w.contract = 'annon-dev.synthetic.near';
    const pr = withInfo(annonInfo({ contract: 'annon-dev.synthetic.near' }));
    const q = await preflight(opts({ contractId: 'annon-dev.synthetic.near', paymentRequired: pr }));
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

describe('authorize', () => {
  const sign = (account = buyerAccount) => ({
    address: buyerAccount.address,
    signTypedData: vi.fn((t: ReturnType<typeof typedData>) => account.signTypedData(asViem(t))),
  });

  it('signs a payment a profile server accepts, bound to the file and the buyer key', async () => {
    const q = await preflight(opts());
    const wallet = sign();
    const { header, job } = await authorize(q, {
      buyerKey,
      wallet,
      persist: async () => {},
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
    expect(job).toMatchObject({ block: SIGNED - 5000, signedAt: NOW, buyerKey: hex(buyerKey) });
  });

  it('dry-runs exactly the signed transferWithAuthorization against USDC', async () => {
    w.file = file();
    const req = offer();
    const q = await preflight(opts({ paymentRequired: required(req) }));
    const { header } = await authorize(q, {
      buyerKey,
      wallet: sign(),
      persist: async () => {},
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

  it('saves the job before the wallet is asked, and never asks if saving fails', async () => {
    const q = await preflight(opts());
    const order: string[] = [];
    const wallet = sign();
    wallet.signTypedData.mockImplementation(async (t) => {
      order.push('sign');
      return buyerAccount.signTypedData(asViem(t));
    });
    await authorize(q, {
      buyerKey,
      wallet,
      persist: async (job: PaymentJob) => {
        await new Promise((r) => setTimeout(r, 5));
        order.push(`persist ${job.nonce}`);
      },
    });
    expect(order).toEqual([`persist ${annonNonce(CONTRACT, FILE, buyerKey)}`, 'sign']);

    const never = sign();
    const failed = authorize(q, {
      buyerKey,
      wallet: never,
      persist: async () => {
        throw new Error('disk full');
      },
    });
    await expect(failed).rejects.toThrow('disk full');
    expect(never.signTypedData).not.toHaveBeenCalled();
  });

  it('refuses a signature that is not the buyer, or not in the form USDC takes', async () => {
    const q = await preflight(opts());
    const run = (wallet: ReturnType<typeof sign>) =>
      codeOf(authorize(q, { buyerKey, wallet, persist: async () => {} }));
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
    const run = () => codeOf(authorize(q, { buyerKey, wallet: sign(), persist: async () => {} }));
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
      const got = await codeOf(authorize(q, { buyerKey, wallet, persist: async () => {} }));
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
    const { job } = await authorize(q, { buyerKey, wallet: sign(), persist: async () => {} });
    expect(job.validBefore).toBe(String(NOW + 180));
    // And a fast local clock: Base is 60 s behind it.
    w.head = { ...at(SIGNED), timestamp: NOW - 60 };
    const slow = await authorize(q, { buyerKey, wallet: sign(), persist: async () => {} });
    expect(slow.job.validBefore).toBe(String(NOW - 60 + 180));
    expect(slow.job.signedAt).toBe(NOW - 60);
  });

  it('takes the deadline from before the registration is read, however long the reads stall', async () => {
    const q = await preflight(opts());
    // The registration read stalls 400 s; afterwards both clocks agree on NOW + 400. A sales stop
    // in that time must still see the payment land within 300 s.
    w.onNear = () => {
      w.head = { ...at(SIGNED), timestamp: NOW + 400 };
      vi.mocked(Date.now).mockReturnValue((NOW + 400) * 1000);
    };
    const { job } = await authorize(q, { buyerKey, wallet: sign(), persist: async () => {} });
    expect(job.validBefore).toBe(String(NOW + 180));
    expect(job.signedAt).toBe(NOW);
  });

  it('refuses a local clock that is off before the registration read, even if it is corrected during it', async () => {
    const q = await preflight(opts());
    vi.mocked(Date.now).mockReturnValue((NOW + 400) * 1000);
    w.onNear = () => vi.mocked(Date.now).mockReturnValue(NOW * 1000);
    expect(await codeOf(authorize(q, { buyerKey, wallet: sign(), persist: async () => {} }))).toBe(
      'transport',
    );
  });

  it('hands back the job when a signed authorization fails afterwards', async () => {
    const q = await preflight(opts());
    w.dryRun = {
      error: { code: 3, message: 'execution reverted: FiatTokenV2: invalid signature' },
    };
    const err = await authorize(q, { buyerKey, wallet: sign(), persist: async () => {} }).catch(
      (e: PayError) => e,
    );
    expect(err).toBeInstanceOf(PayError);
    expect((err as PayError).job).toMatchObject({
      buyerKey: hex(buyerKey),
      validBefore: String(NOW + 180),
    });
  });

  it('does not take a deadline from a Base RPC whose clock is off', async () => {
    const q = await preflight(opts());
    for (const off of [-61, 61]) {
      w.head = { ...at(SIGNED), timestamp: NOW + off };
      expect(
        await codeOf(authorize(q, { buyerKey, wallet: sign(), persist: async () => {} })),
      ).toBe('transport');
    }
    w.head = { ...at(SIGNED), timestamp: NOW + 60 };
    expect(await codeOf(authorize(q, { buyerKey, wallet: sign(), persist: async () => {} }))).toBe(
      'ok',
    );
  });

  it('refuses a wallet other than the quoted buyer and a key that is not a G1 point', async () => {
    const q = await preflight(opts());
    const other = { ...sign(otherAccount), address: otherAccount.address };
    expect(
      await codeOf(authorize(q, { buyerKey, wallet: other, persist: async () => {} })),
    ).toMatch(/TypeError/);
    expect(
      await codeOf(
        authorize(q, {
          buyerKey: new Uint8Array(48).fill(1),
          wallet: sign(),
          persist: async () => {},
        }),
      ),
    ).toMatch(/TypeError/);
    // A valid point in its 96-byte form: the nonce would hash bytes unlock never accepts.
    expect(
      await codeOf(
        authorize(q, {
          buyerKey: bls.G1.Point.BASE.multiply(7n).toBytes(false),
          wallet: sign(),
          persist: async () => {},
        }),
      ),
    ).toMatch(/TypeError/);
    // The identity point decodes, but NEAR's answer to it would be the key in the clear.
    expect(
      await codeOf(
        authorize(q, {
          buyerKey: bls.G1.Point.ZERO.toBytes(true),
          wallet: sign(),
          persist: async () => {},
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
  const job = (over: Partial<PaymentJob> = {}): PaymentJob => ({
    contractId: CONTRACT,
    fileId: FILE,
    buyer: BUYER,
    seller: SELLER,
    to: PAY_TO,
    usdc: USDC,
    price: '10000',
    buyerKey: hex(buyerKey),
    nonce: ANNON,
    validBefore: String(NOW + 300),
    block: SIGNED,
    signedAt: NOW,
    ...over,
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
    expect(code(withInfo(annonInfo({ version: 2 })), [CONTRACT])).toBe('file_mismatch');
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
      persist: async () => {},
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
      persist: async () => {},
    });
    const { signer, calls } = facilitatorSigner();
    const scheme = new ExactEvmScheme(signer as never);
    // The seller's adapter: the same signed payment, named `exact` for a standard facilitator.
    const { paymentPayload, paymentRequirements } = forFacilitator(header, pr.accepts[0] as never);
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
      persist: async () => {},
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
  };
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

  it('names the public header and the buyers-only download in the extension', async () => {
    w.file = file();
    const pr = await offerFor({
      ...offerOpts,
      header: 'https://seller.example/f/1/header',
      download: 'https://seller.example/f/1/download',
    });
    expect(pr.extensions?.annon?.info).toEqual({
      ...annonInfo(),
      header: 'https://seller.example/f/1/header',
      download: 'https://seller.example/f/1/download',
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
      persist: async () => {},
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
    w.file = file();
    const splitter = await offerFor(offerOpts);
    // Neither Annon scheme has a handler in a plain client: it signs nothing.
    expect(await signs(pr)).toBe('refused');
    expect(await signs(splitter)).toBe('refused');
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
    const { header } = await authorize(q, { buyerKey, wallet: wallet(), persist: async () => {} });
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
    const { header } = await authorize(q, { buyerKey, wallet: wallet(), persist: async () => {} });
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
    const { header } = await authorize(q, { buyerKey, wallet: wallet(), persist: async () => {} });
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
    const { header } = await authorize(q, { buyerKey, wallet: wallet(), persist: async () => {} });
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
