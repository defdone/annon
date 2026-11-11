import type { Config } from '../near/rpc.js';
import type { OneClickQuote } from '../oneclick/oneclick.js';
import type {
  PaymentSummary,
  PurchaseRecord,
  SourceAsset,
  SourcePayment,
} from '../pay/purchase.js';
import { usdc } from '../settle-near/codec.js';
import { BASE_USDC, NEAR_USDC, type NearTerms } from '../settle-near/terms.js';
import { AdapterError } from './errors.js';

type PaymentConfig = Pick<Config, 'network' | 'nearUsdc' | 'usdc'>;

export function validatePaymentToken(
  t: { network: string; route: string; token: string | undefined },
  config?: PaymentConfig,
): void {
  const deployment = config?.network ?? (t.route === 'base' ? 'near:mainnet' : t.network);
  const expected =
    t.route === 'base' && t.network === 'eip155:8453'
      ? (config?.usdc ?? (deployment === 'near:mainnet' ? BASE_USDC : undefined))
      : (t.route === 'near' || t.route === '1click') && t.network === deployment
        ? (config?.nearUsdc ?? (deployment === 'near:mainnet' ? NEAR_USDC : undefined))
        : undefined;
  const canonical =
    deployment === 'near:mainnet' ? (t.route === 'base' ? BASE_USDC : NEAR_USDC) : expected;
  if (
    !['near:mainnet', 'near:testnet', 'near:sandbox'].includes(deployment) ||
    !expected ||
    t.token !== expected ||
    t.token !== canonical
  )
    throw new AdapterError(
      'network_mismatch',
      'Payment requires the canonical USDC token for this network.',
      2,
    );
}

export type { SourceAsset, SourcePayment } from '../pay/purchase.js';

/** Saved summaries are optional metadata. Discard a malformed source rather than fail a purchase. */
function validSource(value: unknown): value is SourcePayment {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const s = value as Record<string, unknown>;
  const text = (value: unknown, max: number): value is string =>
    typeof value === 'string' && value.length > 0 && value.length <= max;
  const identifier = (value: unknown, max = 128) =>
    text(value, max) && /^[A-Za-z0-9._:-]+$/.test(value);
  return (
    identifier(s.chain) &&
    identifier(s.asset) &&
    (s.symbol === undefined || identifier(s.symbol, 32)) &&
    (s.contractAddress === undefined || identifier(s.contractAddress)) &&
    text(s.amount, 39) &&
    /^[1-9][0-9]*$/.test(s.amount) &&
    BigInt(s.amount) < 2n ** 128n &&
    (s.decimals === undefined ||
      (typeof s.decimals === 'number' &&
        Number.isInteger(s.decimals) &&
        s.decimals >= 0 &&
        s.decimals <= 255)) &&
    (s.amountFormatted === undefined ||
      (text(s.amountFormatted, 300) && /^(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(s.amountFormatted))) &&
    text(s.depositBefore, 64) &&
    Number.isFinite(Date.parse(s.depositBefore))
  );
}

/** Project only public facts from verified, encrypted purchase state, including legacy records. */
export function savedPayment(
  record: PurchaseRecord,
  source = record.payment?.source,
): PaymentSummary {
  const route = record.purchase.route === 'base-usdc' ? 'base' : record.quote ? '1click' : 'near';
  return {
    amountUsdc: usdc(BigInt(record.terms.price)),
    amountBaseUnits: record.terms.price,
    asset: { symbol: 'USDC', id: record.terms.usdc },
    network: record.terms.network,
    route,
    ...(route === '1click' && validSource(source)
      ? {
          source: {
            chain: source.chain,
            asset: source.asset,
            amount: source.amount,
            depositBefore: source.depositBefore,
            ...(source.symbol !== undefined ? { symbol: source.symbol } : {}),
            ...(source.decimals !== undefined ? { decimals: source.decimals } : {}),
            ...(source.contractAddress !== undefined
              ? { contractAddress: source.contractAddress }
              : {}),
            ...(source.amountFormatted !== undefined
              ? { amountFormatted: source.amountFormatted }
              : {}),
          },
        }
      : {}),
  };
}
export function quotedSource(quote: OneClickQuote, asset: SourceAsset): SourcePayment {
  const amount = quote.deposit.amount;
  const decimals = asset.decimals;
  const q = quote.response.quote as { amountInFormatted?: unknown } | undefined;
  let formatted: string | undefined;
  if (decimals !== undefined) {
    const digits = BigInt(amount)
      .toString()
      .padStart(decimals + 1, '0');
    const fraction = decimals === 0 ? '' : digits.slice(-decimals).replace(/0+$/, '');
    formatted =
      (decimals === 0 ? digits : digits.slice(0, -decimals)) + (fraction ? `.${fraction}` : '');
  } else if (
    typeof q?.amountInFormatted === 'string' &&
    /^(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(q.amountInFormatted)
  ) {
    formatted = q.amountInFormatted;
  }
  return {
    ...asset,
    amount,
    ...(formatted === undefined ? {} : { amountFormatted: formatted }),
    depositBefore: quote.deposit.depositBefore,
  };
}

export function humanPaymentTerms(
  t: {
    file: string;
    resource: string;
    network: string;
    route: string;
    token: string | undefined;
    price: string;
    recipients: NearTerms['recipients'];
    remainder: number;
    baseRecipient?: string | undefined;
    source?: SourcePayment;
  },
  config?: PaymentConfig,
): string {
  validatePaymentToken(t, config);
  const price = BigInt(t.price);
  const amounts = t.recipients.map((r) => (price * BigInt(r.bps)) / 10000n);
  const rest = price - amounts.reduce((sum, n) => sum + n, 0n);
  amounts[t.remainder] = (amounts[t.remainder] ?? 0n) + rest;
  const recipient = (i: number) => {
    const r = t.recipients[i];
    return r ? `${r.identity.kind}:${r.identity.id}` : '';
  };
  return [
    `File: ${t.file}`,
    `Resource: ${t.resource}`,
    `Network: ${t.network}`,
    `Route: ${t.route}`,
    `Token: USDC on ${t.route === 'base' ? 'Base' : 'NEAR'} (${t.token})`,
    `Price: ${usdc(price)} USDC`,
    ...(t.source
      ? [
          `Source chain: ${t.source.chain === 'sol' ? 'Solana (sol)' : t.source.chain === 'eth' ? 'Ethereum (eth)' : t.source.chain}`,
          `Source asset: ${t.source.symbol ?? t.source.asset}${t.source.contractAddress ? ` (${t.source.contractAddress})` : ''}`,
          `Source asset ID: ${t.source.asset}`,
          `Source amount: ${t.source.amountFormatted === undefined ? 'human units unavailable' : `${t.source.amountFormatted} ${t.source.symbol ?? 'tokens'}`} (${t.source.amount} base units)`,
          `Deposit before: ${t.source.depositBefore}`,
        ]
      : []),
    ...t.recipients.map(
      (r, i) => `Recipient: ${recipient(i)} | ${r.bps / 100}% | ${usdc(amounts[i] ?? 0n)} USDC`,
    ),
    `Rounding remainder: ${usdc(rest)} USDC to ${recipient(t.remainder)}`,
    ...(t.route === 'base' && t.baseRecipient
      ? [`Base payment recipient: ${t.baseRecipient}`]
      : []),
  ].join('\n');
}
