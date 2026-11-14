/**
 * Terminal lines and final errors for a browser approval. The page reports only a fixed reason
 * name (browser/login-status.ts); every line printed here is written by the CLI, never by the page
 * or a wallet.
 */

import { base58 } from '@scure/base';
import { clock, record } from '../browser/login-format.js';
import { isWalletFailure, type WalletFailure } from '../browser/login-status.js';
import { parsePurchaseMessage, purchaseId } from '../settle-near/purchase.js';
import { TransactionUncertain } from '../wallet/uncertain.js';
import { AdapterError } from './errors.js';

/**
 * What the page may report: a failed wallet attempt, a cancel, or that it is about to call the
 * wallet's send (after which the request can only end as sent or uncertain).
 */
export type PageReport = WalletFailure | 'cancelled' | 'send_started';
export const isPageReport = (v: unknown): v is PageReport =>
  v === 'cancelled' || v === 'send_started' || isWalletFailure(v);

export const openingLine = (url: string) =>
  `Opening your browser. If it does not open, visit ${url}`;
export const waitingLine = (ms: number) =>
  `Waiting for approval in the browser. Expires in ${clock(ms)}.`;
export const APPROVED_LINE = 'Approved in the browser.';

const FAILED: Record<WalletFailure, string> = {
  window_closed: 'The wallet window closed before signing.',
  popup_blocked: 'The browser blocked the wallet window. Allow pop-ups for the 127.0.0.1 page.',
  rejected: 'The wallet declined the request.',
  wallet_error: 'The wallet could not complete the request.',
  refused: 'The page refused the wallet, account or chain for this request.',
  send_uncertain: 'The wallet may have sent the transaction.',
};
export const failureLine = (reason: WalletFailure, ms: number) =>
  `${FAILED[reason]} You can try again on the page for ${clock(ms)}.`;

/** The command's error when the person cancels on the page. */
export const cancelledError = () =>
  new AdapterError('cancelled', 'You cancelled the approval in the browser.', 3);

/** The command's error when a request expires, naming the last wallet failure the page reported. */
export function expiredError(last?: WalletFailure): AdapterError {
  const again = 'Run the command again.';
  if (!last)
    return new AdapterError(
      'cancelled',
      `The browser approval expired before the wallet signed. ${again}`,
      3,
    );
  const code =
    last === 'rejected' ? 'rejected' : last === 'window_closed' ? 'cancelled' : 'wallet_error';
  return new AdapterError(code, `${FAILED[last]} The browser approval then expired. ${again}`, 3);
}

/** The purchase a NEAR USDC payment request pays for, when its transfer message names one. */
export function requestPurchase(action: unknown): string | undefined {
  const p = record(record(action).payload);
  const msg = record(p.args).msg;
  if (p.method !== 'ft_transfer_call' || typeof msg !== 'string') return undefined;
  try {
    return purchaseId(parsePurchaseMessage(msg));
  } catch {
    return undefined;
  }
}

/** A NEAR transaction hash as wallets return it: base58 of 32 bytes. Anything else is not evidence. */
export function usableHash(v: unknown): string | undefined {
  if (typeof v !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(v)) return undefined;
  try {
    return base58.decode(v).length === 32 ? v : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The line and error when a send may have reached the chain, keeping a usable hash when the
 * wallet returned one. The CLI never pays again by itself.
 */
export function sendUncertain(
  action: unknown,
  txHash?: string,
): { line: string; error: TransactionUncertain } {
  const purchase = requestPurchase(action);
  return {
    line: `The wallet may have sent the transaction. Do not pay again. ${
      purchase
        ? `Run annon status ${purchase} to check it.`
        : 'Check the transaction in your wallet before you run the command again.'
    }`,
    error: new TransactionUncertain(txHash, purchase),
  };
}
