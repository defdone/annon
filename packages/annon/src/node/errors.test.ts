import { expect, it } from 'vitest';
import { AnnonError, toPublicError } from '../errors.js';
import { NearError } from '../near/rpc.js';
import { PayError } from '../pay/base.js';
import { AdapterError, publicError } from './errors.js';

it.each([
  { code: 'settlement_pending' },
  new AdapterError('settlement_pending', 'safe message', 4),
])('gives agents a retry interval for unsafe payments', (error) => {
  expect(publicError(error)).toMatchObject({ code: 'settlement_pending', retryAfterSeconds: 30 });
  const message = publicError({ code: 'settlement_pending' }).message;
  expect(message).toContain('saved purchase');
});

it.each([
  new PayError('transport', 'Base RPC rate limited (429)'),
  new NearError('transport', 'NEAR RPC rate limited (429)'),
])('does not identify a rate limit from message text alone', (error) => {
  expect(publicError(error).code).toBe('transport');
  expect(publicError(error).message).not.toContain(error.message);
});

it.each([
  ['budget exhausted', 'The persisted spending budget is exhausted.', false],
  ['clock rollback', 'Clock moved backwards; spending is paused.', true],
] as const)('preserves the exact public message for %s', async (_name, message, rollback) => {
  const { reserveSpend } = await import('./budget.js');
  const { memoryStore } = await import('../pay/store.js');
  const store = memoryStore<import('./budget.js').BudgetRecord>();
  const at = 86400000;
  await reserveSpend(store, 'synthetic-budget', 10n, { daily: 10n }, at);
  const error = await reserveSpend(
    store,
    'synthetic-budget',
    1n,
    { daily: 10n },
    rollback ? 0 : at,
  ).catch((error) => error);
  expect(error.message).toBe(message);
  expect(publicError(error)).toEqual({
    code: 'budget_exceeded',
    message: 'The persisted spending budget is exhausted.',
    exitCode: 1,
  });
});

it.each([-0.1, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
  'omits invalid download retry hints %s',
  async (hint) => {
    const { DownloadError } = await import('../download/download.js');
    const error = Object.assign(new DownloadError('download_limited'), {
      retryAfterSeconds: hint,
      fileId: 'private',
      purchaseId: 'private',
    });
    const result = publicError(error);
    expect(result).not.toHaveProperty('retryAfterSeconds');
    expect(result).not.toHaveProperty('fileId');
    expect(result).not.toHaveProperty('purchaseId');
    expect(result.exitCode).toBe(4);
  },
);
it('preserves rounded download retry evidence and pending exit code', async () => {
  const { DownloadError } = await import('../download/download.js');
  const id = `0x${'11'.repeat(32)}`;
  expect(
    publicError(
      Object.assign(new DownloadError('download_limited'), {
        retryAfterSeconds: 1.1,
        fileId: id,
        purchaseId: id,
      }),
    ),
  ).toMatchObject({
    code: 'download_limited',
    retryAfterSeconds: 2,
    fileId: id,
    purchaseId: id,
    exitCode: 4,
  });
});

it('reports a split RPC network mismatch as a configuration error', () => {
  expect(publicError(new PayError('network_mismatch'))).toMatchObject({
    code: 'network_mismatch',
    exitCode: 2,
  });
});

it('preserves the funding wallet identity error in public output', () => {
  expect(publicError(new PayError('wrong_identity'))).toEqual({
    code: 'wrong_identity',
    message: 'The wallet does not control the required identity.',
    exitCode: 1,
  });
});

// Adapter messages are authored locally and carry command-specific recovery instructions.
it.each([
  [
    'origin_asset_required',
    'Specify --from-asset with the exact 1Click nep141 asset ID for this chain.',
    2,
  ],
  ['origin_required', 'Provide --from-asset and --refund-to for the source chain.', 2],
  ['unknown_file', 'No registered file exists at this contract.', 1],
  ['taken_down', 'The file has been taken down.', 1],
  [
    'transport_required',
    'Configure a relayer URL or select a NEAR wallet for transaction calls.',
    2,
  ],
  ['base_rpc_required', 'Configure baseRpc before creating a Base listing.', 2],
  ['base_wallet_required', 'Base listings require an EVM wallet and EVM split recipients.', 2],
  ['invalid_arguments', '--storage-budget requires a self-registered NEAR sell.', 2],
  [
    'resource_not_allowed',
    'Agent purchases require a secure resource URL; offer files are refused.',
    2,
  ],
  [
    'max_price_required',
    'Set --max-price, ANNON_MAX_PRICE or maxPrice in human configuration before buying.',
    2,
  ],
  ['price_above_max', 'The requested cap exceeds the configured maximum.', 2],
  ['resource_not_allowed', 'The resource URL is outside the configured agent policy.', 2],
  ['origin_not_allowed', 'Use a human-configured origin name.', 2],
  [
    'near_wallet_required',
    'The direct NEAR route requires a NEAR wallet; use 1click for another chain.',
    2,
  ],
  ['base_unavailable', 'The Base route requires an EVM wallet and a Base offer.', 2],
  ['base_rpc_required', 'Configure baseRpc before a Base purchase.', 2],
  ['price_above_max', 'The registered price exceeds maxPrice.', 1],
  ['network_mismatch', 'The contract network differs from the configured network.', 2],
  [
    'file_storage_low',
    'This file needs more purchase storage funding before a NEAR or 1Click payment.',
    2,
  ],
  ['confirmation_required', 'Review and confirm the exact payment terms before paying.', 3],
  ['price_above_max', 'The quoted source amount exceeds the configured origin cap.', 2],
  ['price_above_max', 'The quoted source USDC amount exceeds maxPrice.', 2],
  [
    'origin_not_allowed',
    'Configure maxSourceAmount in source base units for this origin before buying.',
    2,
  ],
  ['purchase_required', 'Provide a saved purchase ID or encrypted purchase/recovery backup.', 2],
  ['signer_init_only', 'Signer and credential references can only be set by init.', 2],
  ['wrong_identity', 'Recovery must match the configured signer.', 2],
  [
    'config_conflict',
    'ANNON_AGENT=true always uses ~/.config/annon/config.json; unset ANNON_CONFIG or point it there.',
    2,
  ],
  [
    'config_conflict',
    'The home config enables agent mode. Unset ANNON_CONFIG or point it there.',
    2,
  ],
  ['budget_required', 'init --agent requires --daily-budget in USDC.', 2],
  ['signer_required', 'Choose exactly one key reference, new keychain key or remote signer.', 2],
  [
    'signer_required',
    'Remote signing requires an identity and exactly one credential reference.',
    2,
  ],
  ['origin_not_allowed', 'Choose a human-configured origin name.', 2],
  ['budget_required', 'Configure a daily budget before buying.', 2],
  ['base_rpc_required', 'Configure baseRpc before resuming a Base purchase.', 2],
  ['resource_not_allowed', 'The resource URL is outside the configured policy.', 2],
  ['sale_not_approved', 'Sale split was not approved.', 3],
  ['origin_required', 'Choose --from-chain and optionally --from-asset for 1Click.', 2],
  ['origin_asset_required', 'Specify --from-asset with a valid 1Click asset ID.', 2],
  ['offer_required', 'The URL must advertise an Annon PAYMENT-REQUIRED offer.', 1],
  ['no_usable_stanza', 'The file has no key stanza for the trusted contract.', 1],
  ['near_wallet_required', 'File funding requires a NEAR wallet.', 2],
  ['in_flight', 'Relayer operation is pending.', 4],
  ['human_only', 'File funding requires a human CLI session.', 2],
  ['file_required', 'Provide --file or --url to open this saved purchase.', 2],
  ['agent_policy', 'Agent mode refuses interactive login.', 2],
  [
    'agent_policy',
    'Agent mode pins deployment, trust, price and state policy; per-call overrides, init and login are refused.',
    2,
  ],
  [
    'agent_policy',
    'Set the trusted ANNON_CONFIG and ANNON_STATE_DIR launcher environment before init; per-call agent paths are refused.',
    2,
  ],
  [
    'protocol_fee_above_max',
    'The advertised protocol fee exceeds maxProtocolFee. Review the fee in human configuration.',
    2,
  ],
  [
    'storage_required',
    'Prepay Annon storage with the SDK storageDeposit helper, then resume the saved operation.',
    1,
  ],
  ['invalid_arguments', 'Provide the NEAR amount to allocate.', 2],
] as const)('preserves adapter guidance and exit code for %s', (code, message, exitCode) => {
  const error = new AdapterError(code, message, exitCode);
  expect(toPublicError(error)).toEqual({ code, message, exitCode });
  expect(publicError(error)).toEqual({ code, message, exitCode });
});
it('does not trust an upstream object claiming to be an adapter error', () => {
  const result = toPublicError({
    name: 'AdapterError',
    code: 'human_only',
    message: 'UPSTREAM',
    exitCode: 2,
  });
  expect(result.message).not.toContain('UPSTREAM');
  expect(toPublicError(new AnnonError('human_only', 'UPSTREAM')).message).not.toContain('UPSTREAM');
});
