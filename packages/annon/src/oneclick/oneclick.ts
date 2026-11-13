/** Native NEAR USDC delivery through 1Click. SUCCESS is delivery, not purchase acceptance. */
import { base58 } from '@scure/base';
import { isAddress } from 'viem/utils';
import { AnnonError, isTransient } from '../errors.js';
import { parseRetryAfterMs, sleep } from '../net/retry.js';
import { account, uint, usdc } from '../settle-near/codec.js';
import { parsePurchaseMessage } from '../settle-near/purchase.js';
import { NEAR_USDC } from '../settle-near/terms.js';
export interface Origin {
  asset: string;
  chain: 'evm' | 'solana' | 'near' | 'other';
  refundTo: string;
  refundType?: 'ORIGIN_CHAIN' | 'INTENTS';
  blockchain?: string;
  depositMode?: 'SIMPLE' | 'MEMO';
}
export interface Token {
  assetId: string;
  blockchain: string;
  symbol: string;
  decimals: number;
  [key: string]: unknown;
}
const evmChains = [
  'eth',
  'base',
  'arb',
  'arbitrum',
  'op',
  'optimism',
  'polygon',
  'pol',
  'bera',
  'scroll',
  'monad',
  'xlayer',
  'abs',
  'plasma',
  'bsc',
  'avax',
  'avalanche',
  'gnosis',
];
export function originFamily(blockchain: string): Origin['chain'] {
  if (evmChains.includes(blockchain)) return 'evm';
  if (blockchain === 'sol' || blockchain === 'solana') return 'solana';
  if (blockchain === 'near') return 'near';
  return 'other';
}
function chainFamily(blockchain: string): Exclude<Origin['chain'], 'other'> {
  const family = originFamily(blockchain);
  if (family === 'other') throw new TypeError('unsupported origin chain or purchase window');
  return family;
}
/** Exact catalog selection. Unsupported and slow chains are deliberately unavailable. */
export function originFromToken(
  tokens: readonly Token[],
  asset: string,
  blockchain: string,
  refundTo: string,
): Origin {
  if (tokens.filter((t) => t.assetId === asset && t.blockchain === blockchain).length !== 1)
    throw new TypeError('select an exact catalog asset and blockchain');
  const chain = chainFamily(blockchain);
  validateRefundAddress(chain, refundTo);
  return { asset, blockchain, chain, refundTo, refundType: 'ORIGIN_CHAIN' };
}
export function validateRefundAddress(chain: Origin['chain'], value: string): void {
  if (typeof value !== 'string' || !value || /\s/.test(value))
    throw new TypeError('invalid refund address');
  if (chain === 'evm') {
    if (!isAddress(value) || /^0x0{40}$/i.test(value))
      throw new TypeError('invalid EVM refund address');
  } else if (chain === 'solana') {
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value) || base58.decode(value).length !== 32)
      throw new TypeError('invalid Solana refund address');
  } else if (chain === 'near') account(value);
  else if (chain !== 'other') throw new TypeError('unsupported refund chain family');
}
/** Catalog origins bind an exact blockchain; other families use explicit refund syntax. */
export function validateOrigin(origin: Origin): void {
  if (
    !origin ||
    typeof origin.asset !== 'string' ||
    !origin.asset.startsWith('nep141:') ||
    !origin.asset.slice(7) ||
    /\s/.test(origin.asset)
  )
    throw new TypeError('invalid origin asset');
  if (origin.blockchain && chainFamily(origin.blockchain) !== origin.chain)
    throw new TypeError('origin chain family mismatch');
  if (origin.depositMode !== undefined && !['SIMPLE', 'MEMO'].includes(origin.depositMode))
    throw new TypeError('invalid deposit mode');
  if (origin.refundType !== undefined && !['ORIGIN_CHAIN', 'INTENTS'].includes(origin.refundType))
    throw new TypeError('invalid refund type');
  validateRefundAddress(origin.chain, origin.refundTo);
  if (origin.refundType === 'INTENTS') account(origin.refundTo);
}
export interface QuotePreview {
  request: QuoteRequest;
  amountIn: string;
  amountOut: string;
  timeEstimate: number;
}
export interface PollCheckpoint {
  address: string;
  memo?: string;
  attempts: number;
  errors: number;
  lastStatus?: SwapStatus;
  nextPollAt?: number;
}
export interface PollOptions {
  memo?: string;
  signal?: AbortSignal;
  maxPolls?: number;
  intervalMs?: number;
  checkpoint?: PollCheckpoint;
  /** Awaited so a durable checkpoint can be saved before polling again. */
  onProgress?: (checkpoint: PollCheckpoint) => void | Promise<void>;
}
class TransportError extends AnnonError {
  constructor(readonly retryAfterMs = 0) {
    super('transport', '1Click transport unavailable');
    this.name = 'TransportError';
  }
}
export interface QuoteRequest {
  dry: boolean;
  swapType: 'EXACT_OUTPUT';
  slippageTolerance: number;
  originAsset: string;
  depositType: 'ORIGIN_CHAIN';
  depositMode?: 'SIMPLE' | 'MEMO';
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
  /** Exact catalog blockchain, when supplied by a catalog-selected origin. */
  blockchain?: string;
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
export class OneClickQuoteExpired extends AnnonError {
  readonly code = 'quote_expired';
  constructor() {
    super('quote_expired', 'The 1Click quote expired. Run buy again.');
    this.name = 'OneClickQuoteExpired';
  }
}

/** Only recognized public service messages may cross the CLI/MCP boundary. */
export class OneClickRefused extends AnnonError {
  readonly code = 'quote_refused';
  readonly minimumAmountUsdc?: string;
  constructor(message: string) {
    super('quote_refused', message);
    this.name = 'OneClickRefused';
    const minimum = /^Amount is too low for bridge, try at least ([0-9]{1,39})[.]?$/i.exec(message);
    if (minimum?.[1]) this.minimumAmountUsdc = usdc(minimum[1]);
  }
}
function refusalMessage(value: unknown): value is string {
  // Do not expose arbitrary upstream text: it can echo requests, credentials or signed payloads.
  return (
    typeof value === 'string' &&
    (/^Amount is too low for bridge, try at least [0-9]{1,39}[.]?$/i.test(value) ||
      /^(No routes found|No liquidity available|Amount is too low|Amount is too high|Unsupported (origin|destination) asset)[.]?$/i.test(
        value,
      ))
  );
}
/** A dry response has no deposit destination or inactivity deadline. */
function parseQuotePreview(request: QuoteRequest, response: Record<string, unknown>): QuotePreview {
  const q = response.quote as Record<string, unknown> | undefined;
  if (
    !q ||
    q.amountOut !== request.amount ||
    (q.minAmountOut !== undefined && uint(q.minAmountOut as string, 128) < BigInt(request.amount))
  )
    throw new Error('1Click quote has wrong output');
  const echo = response.quoteRequest as Record<string, unknown> | undefined;
  if (!echo || Object.entries(request).some(([key, value]) => echo[key] !== value))
    throw new Error('1Click quoteRequest echo mismatch');
  if (
    typeof q.timeEstimate !== 'number' ||
    !Number.isFinite(q.timeEstimate) ||
    q.timeEstimate < 0 ||
    q.timeEstimate > 600
  )
    throw new Error('1Click delivery estimate exceeds purchase delivery window');
  if (typeof q.amountIn !== 'string' || uint(q.amountIn, 128) === 0n)
    throw new Error('invalid quote input amount');
  return {
    request,
    amountIn: q.amountIn as string,
    amountOut: request.amount,
    timeEstimate: q.timeEstimate as number,
  };
}
export class OneClick {
  constructor(private readonly options: OneClickOptions = {}) {}
  private async request(path: string, body?: unknown, signal?: AbortSignal): Promise<unknown> {
    signal?.throwIfAborted();
    let response: Response;
    try {
      response = await (this.options.fetch ?? fetch)(
        `${this.options.endpoint ?? 'https://1click.chaindefuser.com/v0'}${path}`,
        {
          method: body === undefined ? 'GET' : 'POST',
          ...(body === undefined
            ? {}
            : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
          signal: signal
            ? AbortSignal.any([signal, AbortSignal.timeout(20000)])
            : AbortSignal.timeout(20000),
        },
      );
    } catch {
      signal?.throwIfAborted();
      throw new TransportError();
    }
    if (response.status === 429 || response.status >= 500) {
      const delay = parseRetryAfterMs(response.headers.get('retry-after'), this.now() * 1000) ?? 0;
      throw new TransportError(Math.max(0, Math.min(300000, delay || 0)));
    }
    if (!response.ok) {
      if (path === '/quote' && response.status >= 400 && response.status < 500) {
        const body: unknown = await response.json().catch(() => null);
        const message = (body as { message?: unknown } | null)?.message;
        throw new OneClickRefused(
          refusalMessage(message) ? message : 'The 1Click quote was refused.',
        );
      }
      throw new Error(`1Click HTTP ${response.status}`);
    }
    const result: unknown = await response.json();
    if (!result || typeof result !== 'object' || (Array.isArray(result) && path !== '/tokens'))
      throw new Error('malformed 1Click response');
    return result;
  }
  private now() {
    return (this.options.now ?? (() => Math.floor(Date.now() / 1000)))();
  }
  async tokens(signal?: AbortSignal): Promise<Token[]> {
    const result = await this.request('/tokens', undefined, signal);
    if (!Array.isArray(result)) throw new Error('malformed token catalog');
    return result.filter(
      (t): t is Token =>
        !!t &&
        typeof t === 'object' &&
        typeof t.assetId === 'string' &&
        t.assetId.startsWith('nep141:') &&
        !!t.assetId.slice(7) &&
        typeof t.blockchain === 'string' &&
        !!t.blockchain &&
        typeof t.symbol === 'string' &&
        Number.isInteger(t.decimals) &&
        t.decimals >= 0 &&
        t.decimals <= 255,
    );
  }
  async preview(
    message: string,
    origin: Origin,
    options: { slippageTolerance?: number; signal?: AbortSignal } = {},
  ): Promise<QuotePreview> {
    return this.quote(message, origin, { ...options, dry: true });
  }
  quote(
    message: string,
    origin: Origin,
    options: { dry: true; slippageTolerance?: number; signal?: AbortSignal },
  ): Promise<QuotePreview>;
  quote(
    message: string,
    origin: Origin,
    options?: { dry?: false; slippageTolerance?: number; signal?: AbortSignal },
  ): Promise<OneClickQuote>;
  quote(
    message: string,
    origin: Origin,
    options: { dry?: boolean; slippageTolerance?: number; signal?: AbortSignal },
  ): Promise<OneClickQuote | QuotePreview>;
  async quote(
    message: string,
    origin: Origin,
    options: { dry?: boolean; slippageTolerance?: number; signal?: AbortSignal } = {},
  ): Promise<OneClickQuote | QuotePreview> {
    const p = parsePurchaseMessage(message);
    if (p.route !== 'near-usdc' || p.asset !== NEAR_USDC)
      throw new TypeError('1Click requires the NEAR USDC route');
    const now = (this.options.now ?? (() => Math.floor(Date.now() / 1000)))();
    const depositCutoff = Number(p.expires_at) - 600;
    if (!Number.isSafeInteger(depositCutoff) || depositCutoff <= now)
      throw new Error('purchase expired or insufficient delivery window');
    validateOrigin(origin);
    const refundType = origin.refundType ?? 'ORIGIN_CHAIN';
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
      ...(origin.depositMode ? { depositMode: origin.depositMode } : {}),
      destinationAsset: `nep141:${NEAR_USDC}`,
      amount: p.price,
      refundTo: origin.refundTo,
      refundType,
      recipient: p.contract,
      recipientType: 'DESTINATION_CHAIN',
      deadline: new Date(depositCutoff * 1000).toISOString(),
      customRecipientMsg: message,
    };
    const response = (await this.request('/quote', request, options.signal)) as Record<
      string,
      unknown
    >;
    const preview = parseQuotePreview(request, response);
    if (request.dry) return preview;
    const q = response.quote as Record<string, unknown>;
    const deadline = typeof q.deadline === 'string' ? Date.parse(q.deadline) : NaN;
    // The service's address-inactivity deadline is request.deadline + 72h in recorded
    // quotes. It is not the buyer's cutoff. Never extend the echoed request deadline.
    if (!Number.isFinite(deadline) || deadline < depositCutoff * 1000)
      throw new Error('1Click deposit address deadline expires before the deposit cutoff');
    if (typeof q.depositAddress !== 'string' || !q.depositAddress || q.depositAddress.length > 256)
      throw new Error('quote has no deposit address');
    const memo = q.depositMemo;
    if (
      (origin.depositMode === 'MEMO' && (typeof memo !== 'string' || !memo)) ||
      (memo !== undefined &&
        (typeof memo !== 'string' ||
          memo.length > 256 ||
          Array.from(memo).some((c) => c.charCodeAt(0) < 32)))
    )
      throw new Error('invalid deposit memo');
    const data = {
      address: q.depositAddress,
      amount: preview.amountIn,
      asset: origin.asset,
      chain: origin.chain,
      ...(origin.blockchain ? { blockchain: origin.blockchain } : {}),
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
    const result = (await this.request(
      `/status?depositAddress=${encodeURIComponent(depositAddress)}${options.memo === undefined ? '' : `&depositMemo=${encodeURIComponent(options.memo)}`}`,
      undefined,
      options.signal,
    )) as Record<string, unknown>;
    if (!states.includes(result.status as (typeof states)[number]))
      throw new Error('unknown 1Click status');
    return result as SwapStatus;
  }
  async poll(address: string, options: PollOptions = {}): Promise<SwapStatus> {
    const max = options.maxPolls ?? 1200;
    if (!Number.isInteger(max) || max < 1) throw new TypeError('invalid poll count');
    const ms = options.intervalMs ?? 3000;
    if (!Number.isFinite(ms) || ms < 0 || ms > 30000) throw new TypeError('invalid poll interval');
    let checkpoint: PollCheckpoint = options.checkpoint ?? {
      address,
      ...(options.memo === undefined ? {} : { memo: options.memo }),
      attempts: 0,
      errors: 0,
    };
    if (
      checkpoint.address !== address ||
      checkpoint.memo !== options.memo ||
      !Number.isSafeInteger(checkpoint.attempts) ||
      checkpoint.attempts < 0 ||
      !Number.isSafeInteger(checkpoint.errors) ||
      checkpoint.errors < 0 ||
      (checkpoint.nextPollAt !== undefined &&
        (!Number.isFinite(checkpoint.nextPollAt) || checkpoint.nextPollAt < 0))
    )
      throw new TypeError('invalid poll checkpoint');
    options.signal?.throwIfAborted();
    if (
      checkpoint.lastStatus &&
      ['SUCCESS', 'REFUNDED', 'FAILED'].includes(checkpoint.lastStatus.status)
    ) {
      await options.onProgress?.(structuredClone(checkpoint));
      return checkpoint.lastStatus;
    }
    if (checkpoint.nextPollAt && checkpoint.nextPollAt > this.now() * 1000)
      await (this.options.wait ?? sleep)(
        Math.min(300000, checkpoint.nextPollAt - this.now() * 1000),
        options.signal,
      );
    for (let i = 0; i < max; i++) {
      options.signal?.throwIfAborted();
      let result: SwapStatus | undefined;
      let delay = ms;
      try {
        result = await this.status(address, options);
      } catch (error) {
        if (!isTransient(error)) throw error;
        delay = Math.max(
          Math.min(30000, ms * 2 ** Math.min(checkpoint.errors, 8)),
          error instanceof TransportError ? error.retryAfterMs : 0,
        );
      }
      checkpoint = {
        ...checkpoint,
        attempts: checkpoint.attempts + 1,
        errors: result ? 0 : checkpoint.errors + 1,
        ...(result ? { lastStatus: result } : {}),
        nextPollAt: this.now() * 1000 + delay,
      };
      await options.onProgress?.(structuredClone(checkpoint));
      if (result && ['SUCCESS', 'REFUNDED', 'FAILED'].includes(result.status)) return result;
      if (i + 1 < max) await (this.options.wait ?? sleep)(delay, options.signal);
    }
    throw new AnnonError('settlement_pending', '1Click status still pending');
  }
}
