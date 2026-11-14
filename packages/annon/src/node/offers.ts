/** Reads x402 offers and PAY2 headers over HTTPS for the CLI. */
import { readFile } from 'node:fs/promises';
import { secureUrl } from '../download/download.js';
import { sameResource } from '../download/proof.js';
import { MAX_HEADER, parseHeader } from '../envelope/pay2.js';
import { discover, type PaymentRequired, readPaymentRequired } from '../pay/x402.js';
import { hex } from '../settle-near/codec.js';
import type { Config } from './config.js';
import { usage } from './errors.js';
import { fail } from './fail.js';

const requestOptions = { redirect: 'error', credentials: 'omit', cache: 'no-store' } as const;
async function response(url: string, fetcher: typeof fetch, headers?: Record<string, string>) {
  const u = secureUrl(url);
  if (u.username || u.password) throw usage();
  return fetcher(u, {
    ...requestOptions,
    signal: AbortSignal.timeout(20000),
    ...(headers ? { headers } : {}),
  });
}
async function headerAt(
  url: string,
  fetcher: typeof fetch,
  initial?: Response,
): Promise<Uint8Array> {
  const r = initial ?? (await response(url, fetcher, { Range: `bytes=0-${MAX_HEADER - 1}` }));
  if (![200, 206].includes(r.status) || !r.body) throw new Error('header unavailable');
  const reader = r.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    while (size < MAX_HEADER) {
      const next = await reader.read();
      if (next.done) break;
      const part = next.value.subarray(0, MAX_HEADER - size);
      parts.push(part);
      size += part.length;
    }
  } finally {
    await reader.cancel();
  }
  const b = Buffer.concat(parts);
  if (b.length < 12) throw new Error('short header');
  const length = b.readUInt32BE(8);
  if (length > MAX_HEADER || length > b.length) throw new Error('bad header length');
  return new Uint8Array(b.subarray(0, length));
}
async function offer(
  target: string,
  c: Config,
  fetcher: typeof fetch,
  provided?: PaymentRequired,
  expectedUrl?: string,
) {
  let pr: PaymentRequired;
  if (provided) pr = provided;
  else if (/^https?:/.test(target)) {
    const r = await response(target, fetcher);
    await r.body?.cancel();
    const required = r.headers.get('PAYMENT-REQUIRED');
    if (!required)
      return fail('offer_required', 'The URL must advertise an Annon PAYMENT-REQUIRED offer.');
    pr = readPaymentRequired(required);
  } else {
    // A named file contains the decoded x402 JSON; SDK parsing remains authoritative.
    const text = await readFile(target, 'utf8');
    pr = readPaymentRequired(Buffer.from(text).toString('base64'));
  }
  const found = discover(pr, [c.contractId]);
  const url = (pr.resource as { url?: unknown } | undefined)?.url;
  if (
    typeof url !== 'string' ||
    !sameResource(url, /^https?:/.test(target) ? target : (expectedUrl ?? ''))
  )
    throw new Error('resource mismatch');
  secureUrl(url);
  const header = pr.extensions?.annon?.info.header;
  if (typeof header !== 'string') throw new Error('header missing');
  if (secureUrl(header).origin !== new URL(url).origin) throw new Error('header origin mismatch');
  return { pr, url, header: await headerAt(header, fetcher), fileId: found.fileId };
}
async function resourceHeader(url: string, c: Config, fetcher: typeof fetch) {
  const r = await response(url, fetcher, { Range: `bytes=0-${MAX_HEADER - 1}` });
  const required = r.headers.get('PAYMENT-REQUIRED');
  if (r.status === 402 && required) {
    await r.body?.cancel();
    const found = await offer(url, c, fetcher, readPaymentRequired(required));
    if (hex(parseHeader(new Uint8Array(found.header)).fileId) !== found.fileId)
      throw new Error('offer header mismatch');
    return found.header;
  }
  return headerAt(url, fetcher, r);
}

export { offer, requestOptions, resourceHeader, response };
