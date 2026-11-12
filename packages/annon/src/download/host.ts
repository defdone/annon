/** Downloads are authorized only by a final purchase grant (§9). */
import { getFile, getGrant, getPurchase } from '../near/rpc.js';
import { PayError } from '../pay/base.js';
import { paymentRequired } from '../pay/seller.js';
import { paymentResponse, type SettleOptions, settle } from '../pay/settle.js';
import { BUYER_PROOF_HEADER, readPurchaseProof, verifyBuyerProof } from './proof.js';

export type HostRecord = import('../pay/settle.js').SellerRecord;
export interface DownloadInput {
  network: string;
  contract: string;
  purchaseId: string;
  fileId: string;
  version: string;
  size: number;
  headerLength: number;
  start: number;
  range: boolean;
}
export interface DownloadDelivery {
  wrote(offset: number): Promise<void>;
  prepare(): Promise<void>;
  finish(): Promise<void>;
  interrupt(): Promise<void>;
}
export type DownloadReservation =
  | { ok: true; delivery: DownloadDelivery }
  | {
      ok: false;
      status: 416 | 429;
      code: 'bad_request' | 'download_limited' | 'download_in_progress';
      retryAfterSeconds?: number;
    };
export interface DownloadAccounting {
  reserve(input: DownloadInput): Promise<DownloadReservation>;
}
export interface FileHostOptions extends SettleOptions {
  /** Host-only diagnostics; never included in the HTTP response. */
  onPaymentError?(error: PayError): void | Promise<void>;
  headerHash: string;
  downloads?: DownloadAccounting;
  settlementPollSeconds?: number;
  file: { size: number; headerLength?: number; read(start: number): ReadableStream<Uint8Array> };
}
export interface HostRequest {
  headers: { get(name: string): string | null };
}
export interface HostResponse {
  status: number;
  headers: Record<string, string>;
  body?: ReadableStream<Uint8Array>;
  delivery?: DownloadDelivery;
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
      const settled = await settle(payload, o);
      headers['PAYMENT-RESPONSE'] = b64json(paymentResponse(settled));
      if (settled.state === 'pending')
        headers['Retry-After'] = String(o.settlementPollSeconds ?? 10);
    } catch (e) {
      if (!(e instanceof PayError)) throw e;
      try {
        void Promise.resolve(o.onPaymentError?.(e)).catch(() => {});
      } catch {
        // Diagnostics must not change the payment response.
      }
      const code = e.code === 'settlement_processing' ? 'settlement_pending' : e.code;
      const retry =
        e.retryAfterSeconds ??
        (code === 'settlement_pending' || code === 'facilitator_busy' || code === 'unavailable'
          ? (o.settlementPollSeconds ?? 10)
          : code === 'relayer_unavailable'
            ? 30
            : undefined);
      const status =
        code === 'not_sponsored'
          ? 403
          : code === 'settlement_pending' ||
              code === 'facilitator_busy' ||
              code === 'unavailable' ||
              code === 'relayer_unavailable'
            ? 503
            : code === 'transport'
              ? 502
              : code === 'payment_id_conflict'
                ? 409
                : 400;
      const message =
        code === 'settlement_pending'
          ? 'Settlement is pending. Try again later.'
          : code === 'not_sponsored'
            ? 'This file is not sponsored.'
            : code === 'relayer_unavailable'
              ? 'Relayer is temporarily unavailable.'
              : 'Payment could not be completed.';
      return {
        status,
        headers: {
          ...headers,
          'Content-Type': 'application/json',
          ...(retry === undefined ? {} : { 'Retry-After': String(retry) }),
        },
        body: new Response(
          JSON.stringify({
            error: code,
            message,
            ...(retry === undefined ? {} : { retryAfterSeconds: retry }),
          }),
        ).body as ReadableStream<Uint8Array>,
      };
    }
  }
  const proof = readPurchaseProof(req.headers.get(BUYER_PROOF_HEADER));
  if (proof) {
    const p = await getPurchase(o.nearRpc, o.contractId, proof.purchase_id);
    if (p && p.file_id === o.fileId && proof.grant < p.grants) {
      const g = await getGrant(o.nearRpc, o.contractId, proof.purchase_id, proof.grant);
      if (g && verifyBuyerProof(g.buyer_key, o.url, proof.signature))
        return serve(req, o, headers, proof.purchase_id, file.terms?.network ?? 'near:mainnet');
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
async function serve(
  req: HostRequest,
  o: FileHostOptions,
  headers: Record<string, string>,
  purchaseId: string,
  network: string,
): Promise<HostResponse> {
  const size = o.file.size;
  const rawRange = req.headers.get('Range');
  const range = /^bytes=(\d+)-$/.exec(rawRange ?? '');
  const start = range ? Number(range[1]) : 0;
  const base = {
    ...headers,
    'Cache-Control': 'private, no-store',
    'Content-Type': 'application/octet-stream',
    'Accept-Ranges': 'bytes',
  };
  if ((rawRange !== null && !range) || !Number.isSafeInteger(start) || start >= size) {
    return { status: 416, headers: { ...base, 'Content-Range': `bytes */${size}` } };
  }
  const reservation = await o.downloads?.reserve({
    network,
    contract: o.contractId,
    purchaseId,
    fileId: o.fileId,
    version: o.headerHash,
    size,
    headerLength: o.file.headerLength ?? 0,
    start,
    range: !!range,
  });
  if (reservation && !reservation.ok) {
    if (reservation.status === 416)
      return { status: 416, headers: { ...base, 'Content-Range': `bytes */${size}` } };
    const retry = reservation.retryAfterSeconds;
    const message =
      reservation.code === 'download_limited'
        ? 'Download limit reached. Wait before downloading again.'
        : 'A download is already in progress.';
    return {
      status: 429,
      headers: {
        ...headers,
        'Content-Type': 'application/json',
        ...(retry === undefined ? {} : { 'Retry-After': String(retry) }),
      },
      body: new Response(
        JSON.stringify({
          error: reservation.code,
          message,
          purchaseId,
          fileId: o.fileId,
          ...(retry === undefined ? {} : { retryAfterSeconds: retry }),
        }),
      ).body as ReadableStream<Uint8Array>,
    };
  }
  let body: ReadableStream<Uint8Array>;
  try {
    body = o.file.read(start);
  } catch (error) {
    if (reservation?.ok) await reservation.delivery.interrupt();
    throw error;
  }
  return {
    ...(reservation?.ok ? { delivery: reservation.delivery } : {}),
    status: range ? 206 : 200,
    headers: {
      ...base,
      'Content-Length': String(size - start),
      ...(range ? { 'Content-Range': `bytes ${start}-${size - 1}/${size}` } : {}),
    },
    body,
  };
}
