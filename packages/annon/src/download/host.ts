/** Downloads are authorized only by a final purchase grant (§9). */
import { getFile, getGrant, getPurchase } from '../near/rpc.js';
import { PayError } from '../pay/base.js';
import { paymentRequired } from '../pay/seller.js';
import { paymentResponse, type SettleOptions, settle } from '../pay/settle.js';
import { BUYER_PROOF_HEADER, readPurchaseProof, verifyBuyerProof } from './proof.js';

export type HostRecord = import('../pay/settle.js').SellerRecord;
export interface FileHostOptions extends SettleOptions {
  headerHash: string;
  file: { size: number; read(start: number): ReadableStream<Uint8Array> };
}
export interface HostRequest {
  headers: { get(name: string): string | null };
}
export interface HostResponse {
  status: number;
  headers: Record<string, string>;
  body?: ReadableStream<Uint8Array>;
}
const b64json = (v: unknown) =>
  btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(v))));
export async function serveFile(req: HostRequest, o: FileHostOptions): Promise<HostResponse> {
  const headers: Record<string, string> = { 'Cache-Control': 'no-store' };
  const file = await getFile(o.nearRpc, o.contractId, o.fileId);
  if (!file) return { status: 404, headers };
  if (file.takenDown !== null) return { status: 410, headers };
  const payload = req.headers.get('PAYMENT-SIGNATURE');
  if (payload) {
    try {
      headers['PAYMENT-RESPONSE'] = b64json(paymentResponse(await settle(payload, o)));
    } catch (e) {
      if (!(e instanceof PayError)) throw e;
      if (e.code === 'settlement_processing')
        return { status: 503, headers: { ...headers, 'Retry-After': '5' } };
      return {
        status: e.code === 'transport' ? 502 : e.code === 'payment_id_conflict' ? 409 : 400,
        headers,
      };
    }
  }
  const proof = readPurchaseProof(req.headers.get(BUYER_PROOF_HEADER));
  if (proof) {
    const p = await getPurchase(o.nearRpc, o.contractId, proof.purchase_id);
    if (p && p.file_id === o.fileId && proof.grant < p.grants) {
      const g = await getGrant(o.nearRpc, o.contractId, proof.purchase_id, proof.grant);
      if (g && verifyBuyerProof(g.buyer_key, o.url, proof.signature)) return serve(req, o, headers);
    }
  }
  return {
    status: 402,
    headers: {
      ...headers,
      'PAYMENT-REQUIRED': b64json(paymentRequired(o, file, file.terms.base?.usdc ?? '')),
    },
  };
}

/** `200` with the whole file, or `206` from a `Range: bytes=<start>-` offset. */
function serve(
  req: HostRequest,
  o: FileHostOptions,
  headers: Record<string, string>,
): HostResponse {
  const size = o.file.size;
  const range = /^bytes=(\d+)-$/.exec(req.headers.get('Range') ?? '');
  const start = range ? Number(range[1]) : 0;
  const base = {
    ...headers,
    'Cache-Control': 'private, no-store',
    'Content-Type': 'application/octet-stream',
    'Accept-Ranges': 'bytes',
  };
  if (range && (!Number.isSafeInteger(start) || start >= size)) {
    return { status: 416, headers: { ...base, 'Content-Range': `bytes */${size}` } };
  }
  return {
    status: range ? 206 : 200,
    headers: {
      ...base,
      'Content-Length': String(size - start),
      ...(range ? { 'Content-Range': `bytes ${start}-${size - 1}/${size}` } : {}),
    },
    body: o.file.read(start),
  };
}
