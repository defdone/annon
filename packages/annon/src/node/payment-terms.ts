import type { Config } from '../near/rpc.js';
import type { OneClickQuote } from '../oneclick/oneclick.js';
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

export interface SourceAsset {
  chain: string;
  asset: string;
  symbol?: string;
  decimals?: number;
  contractAddress?: string;
}
export interface SourcePayment extends SourceAsset {
  amount: string;
  amountFormatted?: string;
  depositBefore: string;
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
