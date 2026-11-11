/** Native NEAR USDC delivery through 1Click. SUCCESS is delivery, not purchase acceptance. */
import { account, uint } from '../settle-near/codec.js';
import { parsePurchaseMessage } from '../settle-near/purchase.js';
import { NEAR_USDC } from '../settle-near/terms.js';
export interface Origin {
  asset: string;
  chain: 'evm' | 'solana' | 'near' | 'other';
  refundTo: string;
  refundType?: 'ORIGIN_CHAIN' | 'INTENTS';
}
export interface QuoteRequest {
  dry: boolean;
  swapType: 'EXACT_OUTPUT';
  slippageTolerance: number;
  originAsset: string;
  depositType: 'ORIGIN_CHAIN';
  destinationAsset: string;
  amount: string;
  refundTo: string;
  refundType: 'ORIGIN_CHAIN' | 'INTENTS';
  recipient: string;
  recipientType: 'DESTINATION_CHAIN';
  deadline: string;
  customRecipientMsg: string;
}
export interface Deposit {
  address: string;
  amount: string;
  asset: string;
  chain: Origin['chain'];
  memo?: string;
  qrData: string;
  /** Deposit must be confirmed by this earlier cutoff; delivery has a ten-minute buffer. */
  depositBefore: string;
  purchaseExpiresAt: string;
}
export interface OneClickQuote {
  request: QuoteRequest;
  response: Record<string, unknown>;
  deposit: Deposit;
}
const states = [
  'PENDING_DEPOSIT',
  'KNOWN_DEPOSIT_TX',
  'PROCESSING',
  'SUCCESS',
  'REFUNDED',
  'FAILED',
  'INCOMPLETE_DEPOSIT',
] as const;
export interface SwapStatus {
  status: (typeof states)[number];
  [key: string]: unknown;
}
export interface OneClickOptions {
  endpoint?: string;
  fetch?: typeof fetch;
  now?: () => number;
  wait?: (ms: number, signal?: AbortSignal) => Promise<void>;
}
function pause(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const stop = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', stop);
      resolve();
    }, ms);
    signal?.addEventListener('abort', stop, { once: true });
  });
}
export class OneClick {
  constructor(private readonly options: OneClickOptions = {}) {}
  private async request(
    path: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    signal?.throwIfAborted();
    const response = await (this.options.fetch ?? fetch)(
      `${this.options.endpoint ?? 'https://1click.chaindefuser.com/v0'}${path}`,
      {
        method: body === undefined ? 'GET' : 'POST',
        headers: { 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(20000)])
          : AbortSignal.timeout(20000),
      },
    );
    if (!response.ok) throw new Error(`1Click HTTP ${response.status}`);
    const result: unknown = await response.json();
    if (!result || typeof result !== 'object' || Array.isArray(result))
      throw new Error('malformed 1Click response');
    return result as Record<string, unknown>;
  }
  async quote(
    message: string,
    origin: Origin,
    options: { dry?: boolean; slippageTolerance?: number; signal?: AbortSignal } = {},
  ): Promise<OneClickQuote> {
    const p = parsePurchaseMessage(message);
    if (p.route !== 'near-usdc' || p.asset !== NEAR_USDC)
      throw new TypeError('1Click requires the NEAR USDC route');
    const now = (this.options.now ?? (() => Math.floor(Date.now() / 1000)))();
    const depositCutoff = Number(p.expires_at) - 600;
    if (!Number.isSafeInteger(depositCutoff) || depositCutoff <= now)
      throw new Error('purchase expired or insufficient delivery window');
    if (!origin.asset.startsWith('nep141:') || !origin.refundTo || /\s/.test(origin.refundTo))
      throw new TypeError('invalid origin/refund');
    const refundType = origin.refundType ?? (origin.chain === 'near' ? 'INTENTS' : 'ORIGIN_CHAIN');
    if (refundType === 'INTENTS') account(origin.refundTo);
    const tolerance = options.slippageTolerance ?? 100;
    if (!Number.isInteger(tolerance) || tolerance < 0 || tolerance > 10000)
      throw new TypeError('invalid slippage');
    const request: QuoteRequest = {
      dry: options.dry ?? false,
      swapType: 'EXACT_OUTPUT',
      slippageTolerance: tolerance,
      originAsset: origin.asset,
      depositType: 'ORIGIN_CHAIN',
      destinationAsset: `nep141:${NEAR_USDC}`,
      amount: p.price,
      refundTo: origin.refundTo,
      refundType,
      recipient: p.contract,
      recipientType: 'DESTINATION_CHAIN',
      deadline: new Date(depositCutoff * 1000).toISOString(),
      customRecipientMsg: message,
    };
    const response = await this.request('/quote', request, options.signal);
    const q = response.quote as Record<string, unknown> | undefined;
    if (
      !q ||
      q.amountOut !== p.price ||
      (q.minAmountOut !== undefined && uint(q.minAmountOut as string, 128) < BigInt(p.price))
    )
      throw new Error('1Click quote has wrong output');
    const echo = response.quoteRequest as Record<string, unknown> | undefined;
    if (!echo || Object.entries(request).some(([key, value]) => echo[key] !== value))
      throw new Error('1Click quoteRequest echo mismatch');
    const deadline = typeof q.deadline === 'string' ? Date.parse(q.deadline) : NaN;
    // The service's address-inactivity deadline is request.deadline + 72h in recorded
    // quotes. It is not the buyer's cutoff. Never extend the echoed request deadline.
    if (!Number.isFinite(deadline) || deadline < depositCutoff * 1000)
      throw new Error('1Click deposit address deadline expires before the deposit cutoff');
    if (
      typeof q.timeEstimate !== 'number' ||
      !Number.isFinite(q.timeEstimate) ||
      q.timeEstimate < 0 ||
      q.timeEstimate > 600
    )
      throw new Error('1Click delivery estimate exceeds purchase delivery window');
    if (typeof q.amountIn !== 'string' || uint(q.amountIn, 128) === 0n)
      throw new Error('invalid quote input amount');
    if (typeof q.depositAddress !== 'string' || !q.depositAddress || q.depositAddress.length > 256)
      throw new Error('quote has no deposit address');
    const memo = q.depositMemo;
    if (memo !== undefined && typeof memo !== 'string') throw new Error('invalid deposit memo');
    const data = {
      address: q.depositAddress,
      amount: q.amountIn,
      asset: origin.asset,
      chain: origin.chain,
      depositBefore: request.deadline,
      purchaseExpiresAt: new Date(Number(p.expires_at) * 1000).toISOString(),
      ...(memo === undefined ? {} : { memo }),
    };
    return { request, response, deposit: { ...data, qrData: JSON.stringify(data) } };
  }
  async status(
    depositAddress: string,
    options: { memo?: string; signal?: AbortSignal } = {},
  ): Promise<SwapStatus> {
    if (!depositAddress || depositAddress.length > 256)
      throw new TypeError('invalid deposit address');
    const result = await this.request(
      `/status?depositAddress=${encodeURIComponent(depositAddress)}${options.memo === undefined ? '' : `&depositMemo=${encodeURIComponent(options.memo)}`}`,
      undefined,
      options.signal,
    );
    if (!states.includes(result.status as (typeof states)[number]))
      throw new Error('unknown 1Click status');
    return result as SwapStatus;
  }
  async poll(
    address: string,
    options: { memo?: string; signal?: AbortSignal; maxPolls?: number; intervalMs?: number } = {},
  ): Promise<SwapStatus> {
    const max = options.maxPolls ?? 1200;
    if (!Number.isInteger(max) || max < 1) throw new TypeError('invalid poll count');
    const ms = options.intervalMs ?? 3000;
    if (!Number.isFinite(ms) || ms < 0 || ms > 30000) throw new TypeError('invalid poll interval');
    for (let i = 0; i < max; i++) {
      const result = await this.status(address, options);
      if (['SUCCESS', 'REFUNDED', 'FAILED'].includes(result.status)) return result;
      if (i + 1 < max) await (this.options.wait ?? pause)(ms, options.signal);
    }
    throw new Error('1Click status still pending');
  }
}
