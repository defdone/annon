import { bls12_381 as bls } from '@noble/curves/bls12-381.js';
import { expect, it, vi } from 'vitest';
import { concat, open, seal, sha256 } from '../envelope/pay2.js';
import { hex } from '../settle-near/codec.js';
import { BROWSER_DOWNLOAD_LIMIT, browserDownload } from './download.js';

const fileId = new Uint8Array(32).fill(7);
const contractId = 'synthetic.near';
const seller = { kind: 'near' as const, id: 'seller.synthetic.near' };
const ckdSecret = bls.G1.Point.BASE.multiply(5n).toBytes(true);
const plaintext = new TextEncoder().encode('synthetic plaintext kept only in memory');
const sealed = await seal(plaintext, {
  fileId,
  name: 'synthetic.txt',
  mime: 'text/plain',
  authKind: 2,
});
const file = await sealed.finish({ contractId, ckdSecret, seller });
const header = file.slice(0, new DataView(file.buffer).getUint32(8));
const listing = {
  fileId: hex(fileId),
  cipherHash: hex(sealed.cipherHash),
  seller,
  publishedHeaderHash: hex(await sha256(header.subarray(0, -65))),
  pay2Version: 2 as const,
};
const base = {
  url: 'https://files.example/synthetic',
  contractId,
  fileId: hex(fileId),
  header,
  listing,
  checkedHeaderHash: hex(await sha256(header)),
  proof: { secret: new Uint8Array(32).fill(1), purchase_id: hex(fileId), grant: 0 },
};
function host(bytes = file) {
  return vi.fn<typeof fetch>(async (_url, init) => {
    expect(new Headers(init?.headers).get('annon-buyer-proof')).toBeTruthy();
    expect(init?.credentials).toBe('omit');
    return new Response(bytes, { headers: { 'content-length': String(bytes.length) } });
  });
}
it('downloads checked ciphertext with a grant proof and decrypts to bytes and header metadata', async () => {
  const progress: unknown[] = [];
  const fetch = host();
  const wire = await browserDownload({
    ...base,
    fetch,
    onProgress: (event) => progress.push(event),
  });
  const result = await open(wire, { listing, contractId, ckdSecret: async () => ckdSecret });
  expect(result.data).toEqual(plaintext);
  expect(result.meta).toMatchObject({ name: 'synthetic.txt', mime: 'text/plain' });
  expect(progress).toContainEqual(
    expect.objectContaining({ phase: 'downloading', received: file.length }),
  );
  expect(fetch).toHaveBeenCalledTimes(1);
});
it('refuses a known size above the encrypted size cap before fetching', async () => {
  const fetch = host();
  await expect(
    browserDownload({ ...base, fetch, size: BROWSER_DOWNLOAD_LIMIT + 1 }),
  ).rejects.toMatchObject({ code: 'too_large', message: expect.stringMatching(/50 MB/) });
  expect(fetch).not.toHaveBeenCalled();
});
it.each(['length', 'range', 'stream'] as const)('aborts an oversized %s response', async (kind) => {
  let signal: AbortSignal | undefined;
  const cancel = vi.fn();
  const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
    signal = init?.signal as AbortSignal;
    let sent = false;
    return new Response(
      new ReadableStream({
        pull(c) {
          if (sent) return;
          sent = true;
          c.enqueue(new Uint8Array(kind === 'stream' ? BROWSER_DOWNLOAD_LIMIT + 1 : 1));
        },
        cancel,
      }),
      {
        status: kind === 'range' ? 206 : 200,
        headers:
          kind === 'length'
            ? { 'content-length': String(BROWSER_DOWNLOAD_LIMIT + 1) }
            : kind === 'range'
              ? {
                  'content-range': `bytes ${header.length}-${BROWSER_DOWNLOAD_LIMIT}/${BROWSER_DOWNLOAD_LIMIT + 1}`,
                }
              : {},
      },
    );
  });
  await expect(browserDownload({ ...base, fetch })).rejects.toMatchObject({ code: 'too_large' });
  expect(signal?.aborted).toBe(true);
  expect(cancel).toHaveBeenCalled();
  expect(fetch).toHaveBeenCalledTimes(1);
});
it.each(['header', 'cipher', 'wire-header', 'wire-cipher'] as const)(
  'rejects a wrong %s',
  async (kind) => {
    const bad = file.slice();
    const at = kind === 'wire-header' ? 20 : file.length - 1;
    bad[at] = (bad[at] ?? 0) ^ 1;
    const fetch = host(kind.startsWith('wire') ? bad : file);
    await expect(
      browserDownload({
        ...base,
        fetch,
        ...(kind === 'header' ? { checkedHeaderHash: `0x${'00'.repeat(32)}` } : {}),
        ...(kind === 'cipher'
          ? { listing: { ...listing, cipherHash: `0x${'00'.repeat(32)}` } }
          : {}),
      }),
    ).rejects.toMatchObject({ code: kind === 'cipher' ? 'cipher_hash_mismatch' : 'file_mismatch' });
    if (!kind.startsWith('wire')) expect(fetch).not.toHaveBeenCalled();
  },
);
it('cancels a pending response, removes listeners, and permits a fresh retry', async () => {
  const abort = new AbortController();
  let signal: AbortSignal | undefined;
  let requested!: () => void;
  const started = new Promise<void>((resolve) => {
    requested = resolve;
  });
  const cancel = vi.fn();
  const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
    signal = init?.signal as AbortSignal;
    requested();
    return new Response(new ReadableStream({ cancel }));
  });
  const pending = browserDownload({ ...base, fetch, signal: abort.signal });
  await started;
  abort.abort();
  await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
  expect(signal?.aborted).toBe(true);
  expect(cancel).toHaveBeenCalled();
  expect(await browserDownload({ ...base, fetch: host() })).toEqual(file);
});
it('refuses an already aborted download without fetching', async () => {
  const fetch = host();
  await expect(
    browserDownload({ ...base, fetch, signal: AbortSignal.abort() }),
  ).rejects.toMatchObject({ code: 'cancelled' });
  expect(fetch).not.toHaveBeenCalled();
});
it('does not retain extra bytes after the ciphertext', async () => {
  await expect(
    browserDownload({ ...base, fetch: host(concat(file, new Uint8Array([1]))) }),
  ).rejects.toThrow();
});

it('uses the header chunk lengths to refuse a file before the first request', async () => {
  const { download } = await import('../download/download.js');
  const fetch = host();
  expect(() => download({ ...base, fetch, maxBytes: header.length })).toThrowError(
    expect.objectContaining({ code: 'too_large' }),
  );
  expect(fetch).not.toHaveBeenCalled();
});
it('isolates throwing progress observers and validates known size hints', async () => {
  expect(
    await browserDownload({
      ...base,
      fetch: host(),
      onProgress: () => {
        throw new Error('synthetic observer');
      },
    }),
  ).toEqual(file);
  for (const size of [-1, Number.NaN, 1.5]) {
    const fetch = host();
    await expect(browserDownload({ ...base, fetch, size })).rejects.toThrow(/size/);
    expect(fetch).not.toHaveBeenCalled();
  }
});

it('cancels while waiting for a settling host without another request', async () => {
  const abort = new AbortController();
  let waiting!: () => void;
  const entered = new Promise<void>((resolve) => {
    waiting = resolve;
  });
  const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(null, { status: 503 }));
  const pending = browserDownload({
    ...base,
    fetch,
    signal: abort.signal,
    wait: async () => {
      waiting();
      await new Promise(() => {});
    },
  });
  await entered;
  abort.abort();
  await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
  expect(fetch).toHaveBeenCalledTimes(1);
});

it('refuses an oversized Content-Range even when the total length is unknown', async () => {
  const cancel = vi.fn();
  const fetch = vi.fn<typeof globalThis.fetch>(
    async () =>
      new Response(new ReadableStream({ cancel }), {
        status: 206,
        headers: { 'content-range': `bytes ${header.length}-${BROWSER_DOWNLOAD_LIMIT}/*` },
      }),
  );
  const pending = browserDownload({ ...base, fetch });
  await expect(pending).rejects.toMatchObject({ code: 'too_large' });
  expect(cancel).toHaveBeenCalled();
});
