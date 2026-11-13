/** Browser-safe public failures. Upstream diagnostics never cross a public boundary. */
export const annonErrorCodes = [
  'invalid_arguments',
  'invalid_config',
  'invalid_record',
  'config_conflict',
  'agent_policy',
  'human_only',
  'confirmation_required',
  'sale_not_approved',
  'trust_required',
  'signer_required',
  'signer_init_only',
  'credentials_required',
  'backup_secret_required',
  'work_dir_required',
  'max_price_required',
  'budget_required',
  'budget_exceeded',
  'base_rpc_required',
  'transport_required',
  'near_wallet_required',
  'base_wallet_required',
  'base_unavailable',
  'route_unavailable',
  'file_required',
  'offer_required',
  'purchase_required',
  'origin_required',
  'origin_asset_required',
  'origin_not_allowed',
  'resource_not_allowed',
  'path_not_allowed',
  'output_exists',
  'unknown_file',
  'already_registered',
  'taken_down',
  'sales_stopped',
  'unknown_moderator',
  'storage_required',
  'funding_refused',
  'file_storage_low',
  'protocol_fee_above_max',
  'price_mismatch',
  'price_above_max',
  'recipient_mismatch',
  'file_mismatch',
  'network_mismatch',
  'token_mismatch',
  'method_mismatch',
  'untrusted_contract',
  'file_invalid',
  'bad_requirements',
  'insufficient_balance',
  'smart_wallet_unsupported',
  'bad_signature',
  'payment_rejected',
  'purchase_open',
  'payment_id_conflict',
  'payment_expired',
  'payment_not_found',
  'payment_used',
  'quote_refused',
  'quote_expired',
  'settlement_pending',
  'transaction_uncertain',
  'not_sponsored',
  'not_buyer',
  'bad_magic',
  'unsupported_version',
  'bad_chunk_size',
  'header_too_large',
  'bad_header',
  'bad_stanza',
  'file_id_mismatch',
  'cipher_hash_mismatch',
  'seller_signature_invalid',
  'bad_body_length',
  'chunk_hash_mismatch',
  'no_usable_stanza',
  'key_unwrap_failed',
  'header_mac_invalid',
  'chunk_invalid',
  'meta_invalid',
  'preview_invalid',
  'ckd_failed',
  'ckd_invalid',
  'rejected',
  'wrong_chain',
  'wrong_identity',
  'invalid_signature',
  'missing_method',
  'invalid_response',
  'wallet_error',
  'store_conflict',
  'lease_busy',
  'source_changed',
  'sell_incomplete',
  'recovery_not_final',
  'transport',
  'refused',
  'bad_request',
  'bad_deadline',
  'limited',
  'duplicate',
  'in_flight',
  'unavailable',
  'disabled',
  'rate_limited',
  'budget',
  'busy',
  'not_found',
  'internal',
  'relayer_unavailable',
  'relayer_rate_limited',
  'base_rpc_rate_limited',
  'near_rpc_rate_limited',
  'host_payment_failed',
  'facilitator_busy',
  'bad_response',
  'not_authorized',
  'cancelled',
  'too_large',
  'download_limited',
  'download_in_progress',
  'file_expired',
  'upload_expired',
  'upload_conflict',
  'upload_incomplete',
  'host_capacity',
  'operation_failed',
] as const;
export type AnnonErrorCode = (typeof annonErrorCodes)[number];
export interface PublicError {
  code: AnnonErrorCode;
  message: string;
  exitCode: 1 | 2 | 3 | 4;
  fileId?: string;
  purchaseId?: string;
  txHash?: string;
  minimumAmountUsdc?: string;
  retryAfterSeconds?: number;
}
const messages: Partial<Record<AnnonErrorCode, string>> = {
  route_unavailable: 'This file does not support the selected payment route.',
  host_payment_failed:
    'Payment submission failed. Keep the saved purchase and check final status before retrying.',
  bad_request: 'The request is invalid. Check its fields before retrying.',
  bad_deadline: 'The authorization deadline is invalid or expired.',
  invalid_arguments: 'Invalid arguments. Run annon --help.',
  invalid_record:
    'Invalid saved record. Export necessary test evidence and clear development state.',
  transport: 'The service could not be reached. Keep saved state and retry later.',
  recovery_not_final: 'The recovery grant is not final. Resume the saved recovery later.',
  invalid_signature: 'The wallet did not authorize the exact requested message.',
  operation_failed:
    'Operation failed. Check configuration, funding and final purchase status before retrying. Saved encrypted records are retained.',
  transaction_uncertain:
    'Transaction submission is uncertain. Check the saved purchase and transaction hash before retrying.',
  quote_refused:
    'The 1Click quote was refused. Review the source asset and amount before retrying.',
  base_rpc_rate_limited:
    'The Base RPC is rate limiting requests. Configure a Base RPC endpoint with an API key (baseRpc).',
  near_rpc_rate_limited: 'Configure a NEAR RPC endpoint with an API key (nearRpc).',
  budget_exceeded: 'The persisted spending budget is exhausted.',
  download_limited: 'Download limit reached. Wait before downloading again.',
  download_in_progress: 'Another download is active. Wait before retrying.',
  rate_limited: 'The host is busy. Wait before retrying.',
  unavailable: 'The service is temporarily unavailable. Wait before retrying.',
  transport_required: 'Configure a trusted relayer before a Base purchase.',
  relayer_unavailable: 'Base sponsorship checks are unavailable. Retry before paying.',
  not_sponsored:
    'This listing does not qualify for Base sponsorship. Do not pay through this route.',
  wrong_identity: 'The wallet does not control the required identity.',
  settlement_pending: 'The purchase is still settling. Wait before retrying the saved purchase.',
  protocol_fee_above_max:
    'The advertised protocol fee exceeds maxProtocolFee. Review the fee in human configuration.',
  funding_refused: 'File funding was refused. Correct the cause before retrying.',
  file_storage_low:
    'This file needs more purchase storage funding before a NEAR or 1Click payment.',
  source_changed:
    'The source changed between passes. Resume sell with the original plaintext and saved fileId.',
  quote_expired: 'The 1Click quote expired. Run buy again.',
  storage_required:
    'Prepay storage with storageDeposit before register or reopen, then resume the saved operation.',
  unknown_file: 'The configured contract has no such file. Check the file ID and deployment.',
  taken_down: 'The moderator has taken down this file; key release is blocked.',
  sales_stopped:
    'The seller has stopped new sales. Use a saved purchase to open an earlier purchase.',
  unknown_moderator:
    "Review this file's moderator and explicitly accept it with the moderator option before buying.",
  price_above_max: 'The registered price exceeds maxPrice. Review the current terms before buying.',
  untrusted_contract:
    'The offer names a different contract. Review that deployment and configure it explicitly.',
  network_mismatch:
    'The deployment network or USDC asset differs from the configured network. Check the configuration.',
  store_conflict:
    'Another process updated this purchase. Keep the encrypted state and check status before retrying.',
  file_invalid: 'The file failed SDK verification. Obtain the registered file from its host.',
  file_mismatch:
    'The file or offer differs from its registered commitment. Obtain the correct file or offer.',
  bad_requirements: 'The host offer failed SDK validation. Obtain an updated Annon offer.',
  not_authorized:
    'The host has not accepted this final grant. Check final purchase status and the resource URL.',
};
export function isAnnonErrorCode(code: unknown): code is AnnonErrorCode {
  return typeof code === 'string' && (annonErrorCodes as readonly string[]).includes(code);
}
export function isTransient(error: unknown): boolean {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  return (
    code === 'transport' || code === 'base_rpc_rate_limited' || code === 'near_rpc_rate_limited'
  );
}
export class AnnonError<C extends AnnonErrorCode = AnnonErrorCode> extends Error {
  readonly code: C;
  constructor(
    code: C,
    message = messages[code] ?? `${code.replaceAll('_', ' ')}.`,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.code = code;
    this.name = 'AnnonError';
  }
}
const waiting = new Set<AnnonErrorCode>([
  'settlement_pending',
  'transaction_uncertain',
  'transport',
  'base_rpc_rate_limited',
  'near_rpc_rate_limited',
  'relayer_unavailable',
  'relayer_rate_limited',
  'download_limited',
  'download_in_progress',
  'rate_limited',
  'unavailable',
  'in_flight',
  'busy',
  'facilitator_busy',
  'lease_busy',
  'recovery_not_final',
  'host_capacity',
  'limited',
]);
const approval = new Set<AnnonErrorCode>([
  'agent_policy',
  'human_only',
  'confirmation_required',
  'sale_not_approved',
  'trust_required',
]);
const input = new Set<AnnonErrorCode>([
  'invalid_arguments',
  'invalid_config',
  'invalid_record',
  'config_conflict',
  'agent_policy',
  'human_only',
  'confirmation_required',
  'sale_not_approved',
  'trust_required',
  'signer_required',
  'signer_init_only',
  'credentials_required',
  'backup_secret_required',
  'work_dir_required',
  'max_price_required',
  'budget_required',
  'base_rpc_required',
  'transport_required',
  'near_wallet_required',
  'base_wallet_required',
  'base_unavailable',
  'route_unavailable',
  'file_required',
  'offer_required',
  'purchase_required',
  'origin_required',
  'origin_asset_required',
  'origin_not_allowed',
  'resource_not_allowed',
  'path_not_allowed',
  'output_exists',
  'network_mismatch',
  'bad_request',
  'bad_deadline',
]);
export function toPublicError(error: unknown): PublicError {
  const e = error && typeof error === 'object' ? (error as Record<string, unknown>) : {};
  if (!isAnnonErrorCode(e.code))
    return {
      code: 'operation_failed',
      message: messages.operation_failed ?? 'Operation failed.',
      exitCode: 1,
    };
  const code = e.code;
  const adapter =
    error instanceof AnnonError && error.name === 'AdapterError'
      ? (error as AnnonError & { exitCode: PublicError['exitCode'] })
      : undefined;
  const id = (v: unknown): v is string => typeof v === 'string' && /^0x[0-9a-f]{64}$/.test(v);
  const seconds =
    typeof e.retryAfterSeconds === 'number' && e.retryAfterSeconds >= 0
      ? Math.ceil(e.retryAfterSeconds)
      : NaN;
  const retryAfterSeconds = Number.isSafeInteger(seconds)
    ? seconds
    : code === 'settlement_pending'
      ? 30
      : undefined;
  return {
    code,
    message:
      (code === 'route_unavailable' ? messages.route_unavailable : adapter?.message) ??
      (messages[code] ?? `${code.replaceAll('_', ' ')}.`) +
        (error instanceof AnnonError && error.name === 'SellError' && code !== 'source_changed'
          ? ' Resume sell with the original plaintext and saved fileId.'
          : ''),
    exitCode:
      (code === 'route_unavailable' ? 2 : adapter?.exitCode) ??
      (waiting.has(code) ? 4 : approval.has(code) ? 3 : input.has(code) ? 2 : 1),
    ...(id(e.fileId) ? { fileId: e.fileId } : {}),
    ...(id(e.purchaseId) ? { purchaseId: e.purchaseId } : {}),
    ...(typeof e.txHash === 'string' ? { txHash: e.txHash } : {}),
    ...(typeof e.minimumAmountUsdc === 'string' &&
    /^(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(e.minimumAmountUsdc)
      ? { minimumAmountUsdc: e.minimumAmountUsdc }
      : {}),
    ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
  };
}
