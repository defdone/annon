import type { Config } from '../near/rpc.js';
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
    ...t.recipients.map(
      (r, i) => `Recipient: ${recipient(i)} | ${r.bps / 100}% | ${usdc(amounts[i] ?? 0n)} USDC`,
    ),
    `Rounding remainder: ${usdc(rest)} USDC to ${recipient(t.remainder)}`,
    ...(t.route === 'base' && t.baseRecipient
      ? [`Base payment recipient: ${t.baseRecipient}`]
      : []),
  ].join('\n');
}
