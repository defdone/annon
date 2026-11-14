/**
 * One line naming what a browser approval is for, printed before its waiting line in human mode.
 * Transactions are named by their contract method; signed texts take the title the approval page
 * shows for the same request, so the terminal and the page agree.
 */
import { describeRequest } from '../../browser/login-view.js';
import type { SigningRequest } from '../signing.js';
import { cleanText } from './text.js';

const METHODS: Record<string, string> = {
  register: 'register the file on NEAR',
  storage_deposit: 'fund listing storage',
  fund_file_storage: 'fund purchase storage',
  publish_header: 'publish the file header on NEAR',
  stop_sales: 'stop sales of the file',
  ft_transfer_call: 'pay in USDC on NEAR',
};

/** Signed texts the CLI names in its own words; any other text keeps the page's title. */
const TITLES: Record<string, string> = {
  'Reserve file hosting': 'sign the upload',
  'Sign the listing terms': 'sign the listing terms',
  'Publish a file': 'sign the file header',
  'Approve a payment': 'authorize the USDC payment',
};

export function approvalStep(q: SigningRequest): string {
  const p = q.payload as { method?: unknown } | null;
  if (q.operation === 'near.signTransaction') {
    const method = String(p?.method);
    return METHODS[method] ?? `send a NEAR transaction (${cleanText(method)})`;
  }
  let title = 'Approve a request';
  try {
    title = describeRequest(q).title;
  } catch {}
  return TITLES[title] ?? cleanText(title.charAt(0).toLowerCase() + title.slice(1));
}

/** Numbers each approval of one command run: `Approval 2: register the file on NEAR`. */
export function approvalCounter(): (q: SigningRequest) => string {
  let n = 0;
  return (q) => `Approval ${++n}: ${approvalStep(q)}`;
}
