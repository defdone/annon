/**
 * Why a wallet attempt failed, as a fixed reason the page shows and may report to the CLI. Only
 * these reason names cross to the terminal, so no wallet- or page-supplied text is ever printed.
 */
export const WALLET_FAILURES = [
  'window_closed',
  'popup_blocked',
  'rejected',
  'wallet_error',
  'refused',
  /** The wallet's send call ran and then failed: the transaction may be on chain. Never retried. */
  'send_uncertain',
] as const;
export type WalletFailure = (typeof WALLET_FAILURES)[number];
export const isWalletFailure = (v: unknown): v is WalletFailure =>
  (WALLET_FAILURES as readonly unknown[]).includes(v);

/** A refusal written by the page itself (wrong chain, wallet not offered); its message is shown as is. */
export class Refusal extends Error {}
/** Any failure after the wallet's send call started, whatever the wallet says: it may have broadcast. */
export class SendUncertain extends Error {}

const AGAIN = 'Try again or pick another wallet.';

/** The reason and the page text for a failed wallet attempt. */
export function walletFailure(error: unknown): { reason: WalletFailure; text: string } {
  if (error instanceof Refusal) return { reason: 'refused', text: error.message };
  if (error instanceof SendUncertain)
    return {
      reason: 'send_uncertain',
      text: 'The wallet may have sent the transaction. Do not approve it again. Return to the terminal.',
    };
  const e = (error && typeof error === 'object' ? error : {}) as {
    message?: unknown;
    code?: unknown;
    endTags?: unknown;
  };
  const message = typeof error === 'string' ? error : String(e.message ?? '');
  const tags = Array.isArray(e.endTags) ? e.endTags : [];
  // Meteor's SDK: closed_window from its popup, WINDOW_CLOSED when the opener sees it closed, and
  // POPUP_WINDOW_OPEN_FAILED when window.open returned nothing.
  if (tags.includes('POPUP_WINDOW_OPEN_FAILED') || /open popup/i.test(message))
    return {
      reason: 'popup_blocked',
      text: 'Your browser blocked the wallet window. Allow pop-ups for this page, then try again.',
    };
  if (tags.includes('WINDOW_CLOSED') || /closed the window|window closed/i.test(message))
    return { reason: 'window_closed', text: `The wallet window closed before signing. ${AGAIN}` };
  // EIP-1193 4001 is a user rejection.
  if (e.code === 4001 || /reject|denied|declined|cancel/i.test(message))
    return { reason: 'rejected', text: `The wallet declined the request. ${AGAIN}` };
  return {
    reason: 'wallet_error',
    text: `The wallet could not complete the request${message ? ` (${message.slice(0, 200)})` : ''}. ${AGAIN}`,
  };
}

export type Tone = 'idle' | 'wait' | 'ok' | 'error';
export interface Status {
  tone: Tone;
  text: string;
}
export const STATUS = {
  noCapability: { tone: 'error', text: 'Open the exact URL printed by your CLI.' },
  waitingCli: { tone: 'idle', text: 'Waiting for the CLI to send a request.' },
  ready: { tone: 'idle', text: 'Check the details, then continue in your wallet.' },
  connect: {
    tone: 'idle',
    text: 'Transactions take two steps: connect your wallet first, then review the transaction.',
  },
  wallet: { tone: 'wait', text: 'Waiting for your wallet. Finish or cancel there.' },
  verifying: { tone: 'wait', text: 'Signed. The CLI is checking the result.' },
  signed: {
    tone: 'ok',
    text: 'Signed. Return to the terminal. Keep this tab open until the command finishes.',
  },
  redirected: {
    tone: 'ok',
    text: 'Proof returned to the approval window. Return to your terminal.',
  },
  rejected: {
    tone: 'error',
    text: 'The CLI did not accept the wallet result. Check the terminal for the reason.',
  },
  expired: {
    tone: 'error',
    text: 'This request expired. Run the command again in the terminal.',
  },
  ended: {
    tone: 'error',
    text: 'The approval session has ended. Return to the terminal.',
  },
} as const satisfies Record<string, Status>;

export const connected = (account: string): Status => ({
  tone: 'idle',
  text: `Connected as ${account}. Now review the transaction in your wallet.`,
});
