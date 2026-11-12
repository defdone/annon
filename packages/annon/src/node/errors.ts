import { SellError } from '../api/annon.js';
import { NearRpcRateLimited } from '../near/rpc.js';
import { OneClickRefused } from '../oneclick/oneclick.js';
import { BaseRpcRateLimited } from '../pay/base.js';
import { TransactionUncertain } from '../wallet/uncertain.js';
import { BudgetError } from './budget.js';

/** Only these adapter-owned messages cross the CLI/MCP boundary. Never print upstream errors. */
export class AdapterError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly exitCode = 1,
  ) {
    super(message);
  }
}
export const usage = () =>
  new AdapterError('invalid_arguments', 'Invalid arguments. Run annon --help.', 2);
const actions: Record<string, string> = {
  download_limited: 'Download limit reached. Wait before downloading again.',
  download_in_progress: 'Another download is active. Wait before retrying.',
  rate_limited: 'The host is busy. Wait before retrying.',
  unavailable: 'The service is temporarily unavailable. Wait before retrying.',
  transport_required: 'Configure a trusted relayer before a Base purchase.',
  relayer_unavailable: 'Base sponsorship checks are unavailable. Retry before paying.',
  not_sponsored:
    'This listing does not qualify for Base sponsorship. Do not pay through this route.',
  settlement_pending: 'The purchase is still settling. Wait before retrying the saved purchase.',
  protocol_fee_above_max:
    'The advertised protocol fee exceeds maxProtocolFee. Review the fee in human configuration.',
  funding_refused: 'File funding was refused. Correct the cause before retrying.',
  file_storage_low:
    'This file needs more purchase storage funding before a NEAR or 1Click payment.',
  source_changed: 'The source changed between passes. Restore the original file before retrying.',
  quote_expired: 'The 1Click quote expired. Run buy again.',
  settlement_processing: 'The purchase is still settling. Check status and resume before opening.',
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
  payment_not_safe:
    'Base safety usually takes one to three minutes. Call status again in about 30 seconds. Keep the saved purchase and never pay again.',
  settling:
    'The purchase is still settling. Keep the saved purchase and check status before opening again.',
  not_authorized:
    'The host has not accepted this final grant. Check final purchase status and the resource URL.',
};
function evidence(error: object) {
  const e = error as Record<string, unknown>;
  const id = (v: unknown): v is string => typeof v === 'string' && /^0x[0-9a-f]{64}$/.test(v);
  const seconds =
    typeof e.retryAfterSeconds === 'number' && e.retryAfterSeconds >= 0
      ? Math.ceil(e.retryAfterSeconds)
      : NaN;
  return {
    ...(id(e.fileId) ? { fileId: e.fileId } : {}),
    ...(id(e.purchaseId) ? { purchaseId: e.purchaseId } : {}),
    ...(typeof e.txHash === 'string' ? { txHash: e.txHash } : {}),
    ...(Number.isSafeInteger(seconds) && seconds >= 0 ? { retryAfterSeconds: seconds } : {}),
  };
}
const waiting = new Set([
  'download_limited',
  'download_in_progress',
  'rate_limited',
  'unavailable',
  'settlement_pending',
  'settlement_processing',
  'payment_not_safe',
  'settling',
  'relayer_unavailable',
  'relayer_rate_limited',
]);
export function publicError(error: unknown): {
  code: string;
  message: string;
  exitCode: number;
  fileId?: string;
  purchaseId?: string;
  txHash?: string;
  minimumAmountUsdc?: string;
  retryAfterSeconds?: number;
} {
  if (error instanceof BaseRpcRateLimited)
    return {
      code: 'base_rpc_rate_limited',
      message:
        'The Base RPC is rate limiting requests. Configure a Base RPC endpoint with an API key (baseRpc).',
      exitCode: 1,
    };
  if (error instanceof NearRpcRateLimited)
    return {
      code: 'near_rpc_rate_limited',
      message: 'Configure a NEAR RPC endpoint with an API key (nearRpc)',
      exitCode: 1,
    };
  if (error instanceof OneClickRefused)
    return {
      code: error.code,
      message: error.message,
      exitCode: 1,
      ...(error.minimumAmountUsdc ? { minimumAmountUsdc: error.minimumAmountUsdc } : {}),
    };
  if (error instanceof TransactionUncertain)
    return {
      code: error.code,
      message: error.message,
      txHash: error.txHash,
      ...(error.purchaseId ? { purchaseId: error.purchaseId } : {}),
      exitCode: 4,
    };
  if (error instanceof BudgetError)
    return {
      code: error.code,
      message: error.message,
      exitCode: 1,
    };
  if (error instanceof SellError)
    return {
      code: error.code && Object.hasOwn(actions, error.code) ? error.code : 'sell_incomplete',
      message: `${error.code && Object.hasOwn(actions, error.code) ? actions[error.code] : 'Sell incomplete.'} Resume with the original plaintext and this fileId using sell --resume.`,
      fileId: error.fileId,
      exitCode: 1,
    };
  if (error instanceof AdapterError)
    return {
      code: error.code,
      message: error.message,
      exitCode: waiting.has(error.code) ? 4 : error.exitCode,
      ...evidence(error),
      ...(['payment_not_safe', 'settlement_pending', 'settlement_processing', 'settling'].includes(
        error.code,
      ) && !('retryAfterSeconds' in evidence(error))
        ? { retryAfterSeconds: 30 }
        : {}),
    };
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') {
    const message = Object.hasOwn(actions, error.code) ? actions[error.code] : undefined;
    if (message)
      return {
        code: error.code,
        message,
        exitCode: error.code === 'network_mismatch' ? 2 : waiting.has(error.code) ? 4 : 1,
        ...evidence(error),
        ...([
          'payment_not_safe',
          'settlement_pending',
          'settlement_processing',
          'settling',
        ].includes(error.code) && !('retryAfterSeconds' in evidence(error))
          ? { retryAfterSeconds: 30 }
          : {}),
      };
  }
  return {
    code: 'operation_failed',
    message:
      'Operation failed. Check configuration, funding and final purchase status before retrying. Saved encrypted records are retained.',
    exitCode: 1,
  };
}
