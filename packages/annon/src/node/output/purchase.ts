/** Human output for `login`, `buy`, `status`, `open` and `recover`. */
import type { PublicError } from '../../errors.js';
import type { Deposit } from '../../oneclick/oneclick.js';
import type { PaymentSummary, SourcePayment } from '../../pay/purchase.js';
import { cleanText, networkName, table } from './text.js';

type Result = Record<string, unknown>;

export const loginText = (r: Result) => {
  const identity = r.identity as { id: string };
  return `Signed in as ${cleanText(identity.id)} on ${networkName(String(r.network))}.`;
};

const paid = (r: Result) => {
  const payment = r.payment as PaymentSummary | undefined;
  return payment ? `${payment.amountUsdc} USDC, ${payment.route} route` : `${r.route} route`;
};
export const failure = (e: PublicError) => `${cleanText(e.message)} (${e.code})`;

/** The 1Click deposit a person makes from their own wallet, with the cutoff and any memo. */
function depositText(deposit: Deposit, source: SourcePayment | undefined): string {
  const amount =
    source?.amountFormatted === undefined
      ? `${deposit.amount} base units`
      : `${source.amountFormatted} ${source.symbol ?? 'tokens'} (${deposit.amount} base units)`;
  return [
    'Send this deposit from your own wallet:',
    table(
      [
        ['  Amount', amount],
        ['  Asset', deposit.asset],
        ['  Chain', deposit.blockchain ?? deposit.chain],
        ['  To', deposit.address],
        ...(deposit.memo === undefined ? [] : [['  Memo', `${deposit.memo} (required)`]]),
        ['  Before', deposit.depositBefore],
      ].map((row) => row.map((cell) => cleanText(cell))),
    ),
  ].join('\n');
}

export function buyText(r: Result): string {
  const id = String(r.purchaseId);
  const lines = [`Purchase ${id} (${paid(r)})`];
  if (r.state === 'opened') {
    const opened = r.opened as { output: string; bytes: number };
    lines.push(`Accepted by NEAR. Saved ${opened.output} (${opened.bytes} bytes).`);
  } else if (r.openError)
    lines.push(
      `Accepted by NEAR, but the file was not saved: ${failure(r.openError as PublicError)}`,
      'The purchase is kept. Retry with: annon open --output <file>',
    );
  else if (r.state === 'accepted')
    lines.push('Accepted by NEAR.', 'Save the file with: annon open --output <file>');
  else {
    if (r.state === 'uncertain' && r.txHash) lines.push(`Transaction: ${cleanText(r.txHash)}`);
    if (r.statusError) lines.push(`Status check failed: ${failure(r.statusError as PublicError)}`);
    if (r.instructions)
      lines.push(depositText(r.instructions as Deposit, r.source as SourcePayment | undefined));
    lines.push(String(r.next));
    if (r.instructions)
      lines.push('Then: annon status, and annon open --output <file> (both use this purchase).');
  }
  lines.push(`Backup: ${r.backup}`);
  return lines.join('\n');
}

export function statusText(r: Result): string {
  const id = String(r.purchaseId);
  if (r.state === 'accepted')
    return `Purchase ${id} is accepted.\nSave the file with: annon open ${id} --output <file>`;
  return [
    `Purchase ${id} is ${r.state}${r.submission === 'uncertain' ? ' (the payment may have been sent)' : ''}.`,
    ...(r.txHash ? [`Transaction: ${cleanText(r.txHash)}`] : []),
    String(r.next),
    ...(r.retryAfterSeconds === undefined
      ? []
      : [`Check again in ${r.retryAfterSeconds} seconds.`]),
  ].join('\n');
}

export const openText = (r: Result) =>
  `Saved ${r.output} (${r.bytes} bytes) from purchase ${r.purchaseId}.`;

export function recoverText(r: Result): string {
  const recovered = r.recovered as { purchaseId: string; fileId: string; backup: string }[];
  const errors = r.errors as { purchaseId: string; code: string; message: string }[];
  return [
    recovered.length === 0
      ? 'No purchases recovered.'
      : `Recovered purchases (${recovered.length}):`,
    ...recovered.map((p) => `  ${p.purchaseId}  file ${p.fileId}\n    backup: ${p.backup}`),
    ...errors.map((e) => `  ${e.purchaseId}  failed: ${cleanText(e.message)} (${e.code})`),
    ...(recovered.length > 0 ? ['Open one with: annon open <purchase id> --output <file>'] : []),
  ].join('\n');
}
