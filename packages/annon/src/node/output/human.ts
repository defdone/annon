/**
 * What a person reads in a terminal in place of the JSON envelope. `--json`, pipes and agent mode
 * never come here, so scripts keep the envelope.
 */
import type { PublicError } from '../../errors.js';
import type { Input } from '../cli.js';
import { catalogText, shopAddedText, shopsText } from './discovery.js';
import { buyText, failure, loginText, openText, recoverText, statusText } from './purchase.js';
import { cleanText, fields } from './text.js';

type Result = Record<string, unknown>;

/** A seller accepts the shop's rules by sharing, so `share` shows them whole, with their source. */
function shareText(r: Result): string {
  const { rules, shop, ...rest } = r as Result & {
    rules?: { text: string };
    shop?: { manifest: string; name: string };
  };
  return [
    ...(rules ? [`Shop rules (${shop?.manifest}):\n${cleanText(rules.text, true)}`] : []),
    fields(rest),
  ].join('\n');
}

export function humanResult(input: Input, result: Result | undefined): string {
  const r = result ?? {};
  switch (input.command) {
    case 'login':
      return loginText(r);
    case 'shops':
      return shopsText(r as Parameters<typeof shopsText>[0]);
    case 'shop':
      return shopAddedText(r as Parameters<typeof shopAddedText>[0]);
    case 'catalog':
      return catalogText(input, r as Parameters<typeof catalogText>[1]);
    case 'buy':
      return buyText(r);
    case 'status':
      return statusText(r);
    case 'open':
      return openText(r);
    case 'recover':
      return recoverText(r);
    case 'share':
      return shareText(r);
    case 'verify':
      return `Verified file ${r.fileId} (${r.checked}) against ${r.contractId}.`;
    default:
      return fields(r);
  }
}

export function humanError(error: PublicError): string {
  const {
    code: _code,
    message: _message,
    exitCode: _exitCode,
    retryAfterSeconds,
    ...facts
  } = error;
  return [
    `Error: ${failure(error)}`,
    ...(Object.keys(facts).length > 0 ? [fields(facts)] : []),
    ...(retryAfterSeconds === undefined ? [] : [`Try again in ${retryAfterSeconds} seconds.`]),
  ].join('\n');
}
