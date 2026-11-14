/**
 * Terminal lines and final errors for a browser approval. The page reports only a fixed reason
 * name (browser/login-status.ts); every line printed here is written by the CLI, never by the page
 * or a wallet.
 */

import { clock } from '../browser/login-format.js';
import { isWalletFailure, type WalletFailure } from '../browser/login-status.js';
import { AdapterError } from './errors.js';

/** What the page may report: a failed wallet attempt, or that the person cancelled the request. */
export type PageReport = WalletFailure | 'cancelled';
export const isPageReport = (v: unknown): v is PageReport =>
  v === 'cancelled' || isWalletFailure(v);

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
