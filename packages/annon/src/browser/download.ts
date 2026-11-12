/** Bounded, proof-authorized ciphertext download. Plaintext and released keys stay in memory. */
import { DownloadError, type DownloadOptions, download } from '../download/download.js';
import { concat, inspectHeader, type Listing } from '../envelope/pay2.js';
import { hex } from '../settle-near/codec.js';

/** The cap includes the PAY2 header and ciphertext overhead. Larger files use the CLI. */
export const BROWSER_DOWNLOAD_LIMIT = 50 * 1024 * 1024;
export interface BrowserDownloadProgress {
  phase: 'downloading' | 'decrypting' | 'ready';
  received: number;
  total?: number;
}
export interface BrowserDownloadOptions extends Omit<DownloadOptions, 'maxBytes'> {
  listing: Listing;
  checkedHeaderHash: string;
  /** Known encrypted file size, if the host advertises one. The stream cap always applies. */
  size?: number;
  onProgress?: (event: BrowserDownloadProgress) => void;
}
export function downloadProgress(
  callback: BrowserDownloadOptions['onProgress'],
  event: BrowserDownloadProgress,
): void {
  try {
    callback?.(event);
  } catch {
    /* Page observers cannot interrupt opening a purchase. */
  }
}
export async function browserDownload(o: BrowserDownloadOptions): Promise<Uint8Array> {
  if (o.size !== undefined && (!Number.isSafeInteger(o.size) || o.size < 0))
    throw new TypeError('invalid file size');
  if (o.size !== undefined && o.size > BROWSER_DOWNLOAD_LIMIT)
    throw new DownloadError('too_large', 'File exceeds 50 MiB. Use the CLI for larger files.');
  if (o.signal?.aborted) throw new DownloadError('cancelled');
  const inspected = await inspectHeader(o.header, o.listing, o.contractId);
  if (hex(inspected.headerHash) !== o.checkedHeaderHash)
    throw new DownloadError('file_mismatch', 'header differs from the checked purchase header');
  const reader = download({ ...o, maxBytes: BROWSER_DOWNLOAD_LIMIT }).getReader();
  const parts: Uint8Array[] = [];
  let received = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (o.signal?.aborted) throw new DownloadError('cancelled');
      if (next.done) return concat(...parts);
      received += next.value.length;
      // Defense in depth if the underlying downloader changes its buffering behavior.
      if (received > BROWSER_DOWNLOAD_LIMIT)
        throw new DownloadError('too_large', 'File exceeds 50 MiB. Use the CLI for larger files.');
      parts.push(next.value);
      downloadProgress(o.onProgress, {
        phase: 'downloading',
        received,
        ...(o.size === undefined ? {} : { total: o.size }),
      });
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
