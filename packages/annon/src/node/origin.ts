/** Resolves the 1Click source chain, asset and refund address for a cross-chain purchase. */
import { type Origin, originFamily } from '../oneclick/oneclick.js';
import { bytes } from '../settle-near/codec.js';
import type { Input } from './cli.js';
import type { Config } from './config.js';
import { fail } from './fail.js';
import { response } from './offers.js';
import type { SourceAsset } from './payment-terms.js';
import type { Environment, LocalWallet } from './wallets.js';

const tokenIdentifier = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length >= 1 &&
  value.length <= 128 &&
  !/[^A-Za-z0-9._:-]/.test(value);
const chainAliases = new Map([
  ['solana', 'sol'],
  ['ethereum', 'eth'],
  ['arbitrum', 'arb'],
  ['polygon', 'pol'],
  ['optimism', 'op'],
  ['avalanche', 'avax'],
  ['berachain', 'bera'],
]);
async function originFor(
  o: Input,
  env: Environment,
  wallet: LocalWallet,
  fetcher: typeof fetch,
  c: Config,
): Promise<Origin & { sourceAsset: SourceAsset; maxSourceAmount?: string }> {
  const sourcePolicy = o.origin ? c.origins?.[o.origin] : undefined;
  if (o.origin) {
    if (!c.origins || !Object.hasOwn(c.origins, o.origin))
      return fail('origin_not_allowed', 'Choose a human-configured origin name.', 2);
    o = { ...o, ...c.origins[o.origin] };
  }
  const inputChain = o.fromChain ?? env.ANNON_FROM_CHAIN;
  const chain = inputChain ? (chainAliases.get(inputChain) ?? inputChain) : undefined;
  if (!chain)
    return fail(
      'origin_required',
      'Choose --from-chain and optionally --from-asset for 1Click.',
      2,
    );
  let asset = o.fromAsset ?? env.ANNON_FROM_ASSET;
  let token: { symbol: string; decimals?: number; contractAddress?: string } | undefined;
  if (!asset) {
    const r = await response('https://1click.chaindefuser.com/v0/tokens', fetcher);
    if (!r.ok) throw new Error('tokens unavailable');
    const tokens = (await r.json()) as {
      blockchain: string;
      symbol: string;
      assetId: string;
      decimals?: number;
      contractAddress?: string;
    }[];
    const matches = tokens.filter((t) => t.blockchain === chain && t.symbol === 'USDC');
    if (matches.length !== 1)
      return fail(
        'origin_asset_required',
        'Specify --from-asset with the exact 1Click nep141 asset ID for this chain.',
        2,
      );
    token = matches[0];
    asset = matches[0]?.assetId;
  }
  if (!tokenIdentifier(asset))
    return fail('origin_asset_required', 'Specify --from-asset with a valid 1Click asset ID.', 2);
  const kind = originFamily(chain);
  let refundTo = o.refundTo ?? env.ANNON_REFUND_TO;
  if (!refundTo && kind === wallet.identity.kind) {
    refundTo = wallet.identity.id;
    if (kind === 'solana') {
      const { base58 } = await import('@scure/base');
      refundTo = base58.encode(bytes(`0x${wallet.identity.id}`, 32));
    }
  }
  if (!asset || !refundTo)
    return fail('origin_required', 'Provide --from-asset and --refund-to for the source chain.', 2);
  const decimals = token?.decimals;
  const contractAddress = token?.contractAddress;
  return {
    asset,
    chain: kind,
    refundTo,
    ...(sourcePolicy?.maxSourceAmount ? { maxSourceAmount: sourcePolicy.maxSourceAmount } : {}),
    sourceAsset: {
      ...(sourcePolicy?.usdcDecimals !== undefined
        ? { symbol: 'USDC', decimals: sourcePolicy.usdcDecimals }
        : {}),
      chain,
      asset,
      ...(token ? { symbol: token.symbol } : {}),
      ...(typeof decimals === 'number' &&
      Number.isInteger(decimals) &&
      decimals >= 0 &&
      decimals <= 255
        ? { decimals }
        : {}),
      ...(tokenIdentifier(contractAddress) ? { contractAddress } : {}),
    },
  };
}

export { originFor };
