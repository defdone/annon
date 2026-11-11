import { bls12_381 as bls } from '@noble/curves/bls12-381.js';
import { privateKeyToAccount } from 'viem/accounts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { seal, sha256 } from '../envelope/pay2.js';
import { checksumAddress, DownloadError, download, secureUrl } from './download.js';
import { readPurchaseProof, verifyBuyerProof } from './proof.js';
import { type SignInChallenge, signInChallenge, signInExtension } from './siwx.js';

const CONTRACT = 'v1.annon.defdone.near';
const FILE = `0x${'11'.repeat(32)}`;
const buyer = privateKeyToAccount(`0x${'42'.repeat(32)}`);
const stranger = privateKeyToAccount(`0x${'43'.repeat(32)}`);
const seller = privateKeyToAccount(`0x${'44'.repeat(32)}`);
const hex = (b: Uint8Array) => `0x${Buffer.from(b).toString('hex')}`;

// A real PAY2 file of four data chunks (64 KiB each), so a download can break and resume.
const data = Uint8Array.from({ length: 3 * 65536 + 1000 }, (_, i) => (i * 7) & 0xff);
const sealed = await seal(data, {
  fileId: Uint8Array.from(Buffer.from(FILE.slice(2), 'hex')),
  name: 'x.bin',
  mime: '',
  chunkLog2: 16,
});
const PAY2 = await sealed.finish({
  contractId: CONTRACT,
  ckdSecret: bls.G1.Point.BASE.multiply(5n).toBytes(true),
  seller: seller.address,
  sign: (message) => seller.signMessage({ message }),
});
const HEADER = PAY2.subarray(0, new DataView(PAY2.buffer, PAY2.byteOffset).getUint32(8));
const HEADER_HASH = hex(await sha256(HEADER));
const URL_ = 'https://files.example.com/f/1';

afterEach(() => vi.unstubAllGlobals());

it.each([
  'https://files.example/file',
  'http://localhost:8790/file',
  'http://127.0.0.1:8790/file',
  'http://[::1]:8790/file',
])('accepts the documented secure or local URL %s without fetching', (url) => {
  expect(secureUrl(url).href).toBe(url);
});

it.each([
  'http://files.example/file',
  'http://localhost.example/file',
  'http://127.0.0.2/file',
  'http://[::2]/file',
  'ftp://localhost/file',
])('rejects the unsupported URL %s without fetching', (url) => {
  expect(() => secureUrl(url)).toThrow();
});

describe('checksumAddress', () => {
  it('checksums addresses as EIP-55 does', () => {
    expect(checksumAddress(buyer.address.toLowerCase())).toBe(buyer.address);
    expect(checksumAddress(stranger.address.toUpperCase().replace('0X', '0x'))).toBe(
      stranger.address,
    );
    expect(() => checksumAddress('0x1234')).toThrow(TypeError);
  });
});

describe('download (buyer)', () => {
  type Host = {
    file: Uint8Array;
    /** Break the body of the first response after this many bytes. */
    breakAfter?: number;
    /** Ignore Range and answer 200 with everything. */
    noRange?: boolean;
    contentRange?: (offset: number) => string;
    piece?: number;
    /** The sign-in challenge of the 402, instead of a fresh one. */
    challenge?: () => SignInChallenge;
    /** End the first response cleanly after this many bytes (no network error). */
    cleanCutAt?: number;
    /** The header hash the host binds, when it serves another header than HEADER. */
    headerHash?: string;
    /** Answer this many paid requests with settlement_pending (or 503 when `busy`) first. */
    settling?: number;
    busy?: boolean;
    /** The host's configured `resource.url`, when it is spelled unlike the request URL. */
    resourceUrl?: string;
    /** The sign-in extension of the 402, instead of the one for `signInChallenge`. */
    siwx?: (c: SignInChallenge) => unknown;
  };
  const ranges: string[] = [];
  const asked: Record<string, string>[] = [];
  let bodiesCancelled = 0;
  const signals: AbortSignal[] = [];
  const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64');
  const host = (o: Host) => {
    const challenges = new Map<string, SignInChallenge>();
    let responses = 0;
    let settling = o.settling ?? 0;
    return (async (
      url: string,
      init?: { headers?: Record<string, string>; signal?: AbortSignal },
    ) => {
      if (init?.signal) signals.push(init.signal);
      const h = new Headers(init?.headers);
      const seen: Record<string, string> = {};
      h.forEach((v, k) => {
        seen[k] = v;
      });
      asked.push(seen);
      const extra: Record<string, string> = {};
      const proof = readPurchaseProof(h.get('annon-buyer-proof'));
      let ok =
        !!proof &&
        verifyBuyerProof(
          hex(bls.G1.Point.BASE.multiply(7n).toBytes(true)),
          o.resourceUrl ?? url,
          proof.signature,
        );
      const pay = h.get('payment-signature');
      if (pay) {
        if (settling > 0) {
          settling--;
          return o.busy
            ? new Response(null, { status: 503, headers: { 'retry-after': '1' } })
            : new Response(null, {
                status: 402,
                headers: {
                  'payment-response': b64({
                    success: false,
                    errorReason: 'settlement_pending',
                    transaction: `0x${'cc'.repeat(32)}`,
                    network: 'eip155:8453',
                  }),
                },
              });
        }
        const key = JSON.parse(Buffer.from(pay, 'base64').toString()).extensions.annon.info
          .buyerKey;
        ok = !!proof && verifyBuyerProof(key, o.resourceUrl ?? url, proof.signature);
      }
      if (!ok) {
        const c =
          o.challenge?.() ??
          signInChallenge(url, {
            contractId: CONTRACT,
            fileId: FILE,
            headerHash: o.headerHash ?? HEADER_HASH,
          });
        challenges.set(c.nonce, c);
        return new Response(null, {
          status: 402,
          headers: {
            ...extra,
            'payment-required': b64({
              x402Version: 2,
              accepts: [],
              extensions: { 'sign-in-with-x': o.siwx?.(c) ?? signInExtension(c) },
            }),
          },
        });
      }
      ranges.push(h.get('range') ?? '');
      const offset = Number(/^bytes=(\d+)-$/.exec(h.get('range') ?? '')?.[1] ?? 0);
      const body = o.noRange ? o.file : o.file.subarray(offset);
      const piece = o.piece ?? 5000;
      const first = responses++ === 0;
      const cut = first ? o.breakAfter : undefined;
      const clean = first ? o.cleanCutAt : undefined;
      let at = 0;
      const stream = new ReadableStream<Uint8Array>({
        cancel() {
          bodiesCancelled++;
        },
        pull(c) {
          if (cut !== undefined && at >= cut) return c.error(new TypeError('network error'));
          if (at >= body.length || (clean !== undefined && at >= clean)) return c.close();
          const end = Math.min(
            body.length,
            at + piece,
            cut ?? Number.POSITIVE_INFINITY,
            clean ?? Number.POSITIVE_INFINITY,
          );
          c.enqueue(body.slice(at, end));
          at = end;
        },
      });
      return new Response(stream, {
        status: o.noRange ? 200 : 206,
        headers: {
          ...extra,
          ...(o.noRange
            ? {}
            : {
                'content-range':
                  o.contentRange?.(offset) ??
                  `bytes ${offset}-${o.file.length - 1}/${o.file.length}`,
              }),
        },
      });
    }) as unknown as typeof fetch;
  };
  let signatures = 0;
  const drain = async (s: ReadableStream<Uint8Array>) => {
    const got: Uint8Array[] = [];
    const r = s.getReader();
    try {
      for (;;) {
        const x = await r.read();
        if (x.done) return { got, error: undefined };
        got.push(x.value);
      }
    } catch (e) {
      return { got, error: e instanceof DownloadError ? e.code : (e as Error).message };
    }
  };
  const get = async (o: Host, retries?: number, header = HEADER) => {
    signatures = 0;
    return drain(
      download({
        url: URL_,
        contractId: CONTRACT,
        fileId: FILE,
        header,
        proof: { secret: SECRET, purchase_id: FILE, grant: 0 },
        fetch: host(o),
        ...(retries === undefined ? {} : { retries }),
      }),
    );
  };
  const joined = (parts: Uint8Array[]) => Buffer.concat(parts.map((p) => Buffer.from(p)));
  beforeEach(() => {
    ranges.length = 0;
    asked.length = 0;
  });

  it('gets the exact file, header first, with a Range from the end of the header', async () => {
    const r = await get({ file: PAY2 });
    expect(r.error).toBeUndefined();
    expect(joined(r.got).equals(Buffer.from(PAY2))).toBe(true);
    expect(ranges).toEqual([`bytes=${HEADER.length}-`]);
  });

  it('resumes a broken connection from the last checked chunk', async () => {
    const r = await get({ file: PAY2, breakAfter: 70_000 });
    expect(r.error).toBeUndefined();
    expect(joined(r.got).equals(Buffer.from(PAY2))).toBe(true);
    // The metadata chunk (256 + 16) and the first data chunk (65536 + 16) were checked.
    expect(ranges).toEqual([`bytes=${HEADER.length}-`, `bytes=${HEADER.length + 272 + 65552}-`]);
    // The resume used the session of the first sign-in: one signature for the whole download.
    expect(signatures).toBe(0);
  });

  it('resumes from a host without Range by skipping what it has, even mid-read', async () => {
    const r = await get({
      file: PAY2,
      breakAfter: HEADER.length + 70_000,
      noRange: true,
      piece: 7777,
    });
    expect(r.error).toBeUndefined();
    expect(joined(r.got).equals(Buffer.from(PAY2))).toBe(true);
  });

  it('never passes on a chunk that is not the one the header names', async () => {
    for (const at of [HEADER.length + 10, HEADER.length + 272 + 100, PAY2.length - 1]) {
      const bad = Uint8Array.from(PAY2);
      bad[at] = (bad[at] as number) ^ 1;
      bodiesCancelled = 0;
      const r = await get({ file: bad });
      expect(r.error).toBe('file_mismatch');
      // The response is not left open after a final error (in the last chunk it already ended).
      expect(bodiesCancelled).toBe(at === PAY2.length - 1 ? 0 : 1);
      // A mismatch is final: no retry, no second signature request.
      expect(signatures).toBe(0);
      const good = joined(r.got);
      // Everything passed on is a prefix of the real file, ending before the bad chunk.
      expect(good.equals(Buffer.from(PAY2.subarray(0, good.length)))).toBe(true);
      expect(good.length).toBeLessThanOrEqual(at);
    }
  });

  it('resumes a response that ends cleanly before the end it announced, also in the last chunk', async () => {
    const r = await get({ file: PAY2, cleanCutAt: PAY2.length - HEADER.length - 100 });
    expect(r.error).toBeUndefined();
    expect(joined(r.got).equals(Buffer.from(PAY2))).toBe(true);
    expect(ranges).toHaveLength(2);
  });

  it('refuses a last chunk the seller signed with a wrong length, and the bytes after it', async () => {
    // The seller's own header names the hash of a last chunk one byte longer than PAY2 allows.
    const n = new DataView(HEADER.buffer, HEADER.byteOffset).getUint32(50);
    const lastAt = HEADER.length + 272 + 3 * 65552;
    const longLast = new Uint8Array(65536 + 17).fill(9);
    const header = Uint8Array.from(HEADER);
    header.set(await sha256(longLast), 54 + 32 * (1 + n - 1));
    const file = Buffer.concat([
      header,
      PAY2.subarray(HEADER.length, lastAt),
      longLast,
      new Uint8Array(20),
    ]);
    const r = await get(
      { file: new Uint8Array(file), headerHash: hex(await sha256(header)) },
      3,
      header,
    );
    expect(r.error).toBe('file_mismatch');
  });

  const SECRET = Uint8Array.from(Buffer.from(7n.toString(16).padStart(64, '0'), 'hex'));
  const payment = (url = URL_) => ({
    header: b64({
      x402Version: 2,
      resource: { url },
      extensions: {
        annon: { info: { buyerKey: hex(bls.G1.Point.BASE.multiply(7n).toBytes(true)) } },
      },
    }),
    secret: SECRET,
  });
  const quick = { wait: async () => {} };

  it('gets the file with the payment, proving the one-time key, and no wallet prompt', async () => {
    signatures = 0;
    const r = await drain(
      download({
        url: URL_,
        contractId: CONTRACT,
        fileId: FILE,
        header: HEADER,
        proof: { secret: SECRET, purchase_id: FILE, grant: 0 },
        payment: payment(),
        fetch: host({ file: PAY2 }),
      }),
    );
    expect(r.error).toBeUndefined();
    expect(joined(r.got).equals(Buffer.from(PAY2))).toBe(true);
    expect(signatures).toBe(0);
    expect(asked[0]?.['annon-buyer-proof']).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('signs the advertised resource.url as written, when it names the request URL another way', async () => {
    const advertised = 'HTTPS://FILES.EXAMPLE.COM:443/f/1';
    const r = await drain(
      download({
        url: URL_,
        contractId: CONTRACT,
        fileId: FILE,
        header: HEADER,
        proof: { secret: SECRET, purchase_id: FILE, grant: 0 },
        payment: payment(advertised),
        fetch: host({ file: PAY2, resourceUrl: advertised }),
      }),
    );
    expect(r.error).toBeUndefined();
    expect(joined(r.got).equals(Buffer.from(PAY2))).toBe(true);
  });

  it('never proves the key for another resource than the file URL', () => {
    expect(() =>
      download({
        url: URL_,
        contractId: CONTRACT,
        fileId: FILE,
        header: HEADER,
        proof: { secret: SECRET, purchase_id: FILE, grant: 0 },
        payment: payment('https://evil.example/f/1'),
      }),
    ).toThrow(/another resource/);
  });

  it('asks again while the payment settles (402 pending or 503), then gets the file', async () => {
    for (const busy of [false, true]) {
      const r = await drain(
        download({
          url: URL_,
          contractId: CONTRACT,
          fileId: FILE,
          header: HEADER,
          proof: { secret: SECRET, purchase_id: FILE, grant: 0 },
          payment: payment(),
          fetch: host({ file: PAY2, settling: 3, busy }),
          ...quick,
        }),
      );
      expect(r.error).toBeUndefined();
      expect(joined(r.got).equals(Buffer.from(PAY2))).toBe(true);
    }
    // It waits as long as the host says (Retry-After), else 3 s.
    for (const [busy, ms] of [
      [true, 1000],
      [false, 3000],
    ] as const) {
      const waits: number[] = [];
      await drain(
        download({
          url: URL_,
          contractId: CONTRACT,
          fileId: FILE,
          header: HEADER,
          proof: { secret: SECRET, purchase_id: FILE, grant: 0 },
          payment: payment(),
          fetch: host({ file: PAY2, settling: 2, busy }),
          wait: async (w) => {
            waits.push(w);
          },
        }),
      );
      expect(waits).toEqual([ms, ms]);
    }
    const stuck = await drain(
      download({
        url: URL_,
        contractId: CONTRACT,
        fileId: FILE,
        header: HEADER,
        proof: { secret: SECRET, purchase_id: FILE, grant: 0 },
        payment: payment(),
        fetch: host({ file: PAY2, settling: 100 }),
        settleTries: 4,
        ...quick,
      }),
    );
    expect(stuck.error).toBe('settling');
  });

  it('stops everything when cancelled, even while the first request is pending', async () => {
    // A fetch that honours the abort signal, and one that ignores it: neither may lead to a signature.
    for (const honours of [true, false]) {
      let release: () => void = () => {};
      let requests = 0;
      const inner = host({ file: PAY2 });
      const fetcher = (async (u: string, init?: { signal?: AbortSignal }) => {
        requests++;
        await new Promise<void>((r) => {
          release = r;
        });
        if (honours && init?.signal?.aborted) throw new DOMException('aborted', 'AbortError');
        return inner(u, init as never);
      }) as unknown as typeof fetch;
      signatures = 0;
      const s = download({
        url: URL_,
        contractId: CONTRACT,
        fileId: FILE,
        header: HEADER,
        proof: { secret: SECRET, purchase_id: FILE, grant: 0 },
        fetch: fetcher,
      });
      const reader = s.getReader();
      await reader.read();
      const next = reader.read().catch((e: unknown) => e);
      await new Promise((r) => setTimeout(r, 10));
      await reader.cancel();
      release();
      await next;
      await new Promise((r) => setTimeout(r, 50));
      expect([requests, signatures]).toEqual([1, 0]);
    }
  });

  it('refuses a last chunk shorter than its tag, even one the seller signed', async () => {
    const n = new DataView(HEADER.buffer, HEADER.byteOffset).getUint32(50);
    const lastAt = HEADER.length + 272 + 3 * 65552;
    const shortLast = new Uint8Array(5).fill(9);
    const header = Uint8Array.from(HEADER);
    header.set(await sha256(shortLast), 54 + 32 * (1 + n - 1));
    const file = Buffer.concat([header, PAY2.subarray(HEADER.length, lastAt), shortLast]);
    const r = await get(
      { file: new Uint8Array(file), headerHash: hex(await sha256(header)) },
      3,
      header,
    );
    expect(r.error).toBe('file_mismatch');
  });

  it('refuses a Content-Range whose end comes before its start or at its complete length', async () => {
    for (const cr of [
      (o: number) => `bytes ${o}-0/1`,
      (o: number) => `bytes ${o}-${o + 9}/${o + 9}`,
    ]) {
      expect((await get({ file: PAY2, contentRange: cr })).error).toBe('bad_response');
    }
  });

  it('asks without cookies and never follows a redirect', async () => {
    const inits: RequestInit[] = [];
    const h = host({ file: PAY2 });
    const r = await drain(
      download({
        url: URL_,
        contractId: CONTRACT,
        fileId: FILE,
        header: HEADER,
        proof: { secret: SECRET, purchase_id: FILE, grant: 0 },
        payment: payment(),
        fetch: ((u: string, i: RequestInit) => {
          inits.push(i);
          return h(u, i as never);
        }) as never,
      }),
    );
    expect(r.error).toBeUndefined();
    expect(inits.length).toBeGreaterThan(0);
    expect(inits.every((i) => i.redirect === 'error' && i.credentials === 'omit')).toBe(true);
  });

  it('refuses bytes after the file, a cut file, and a resume from another offset', async () => {
    const longer = Buffer.concat([Buffer.from(PAY2), Buffer.from([0])]);
    expect((await get({ file: longer })).error).toBe('file_mismatch');
    const cut = PAY2.subarray(0, PAY2.length - 100);
    expect((await get({ file: cut })).error).toBe('file_mismatch');
    const shorter = PAY2.subarray(0, HEADER.length + 1000);
    expect((await get({ file: shorter }, 1)).error).toMatch(/ended/);
    signals.length = 0;
    expect((await get({ file: PAY2, contentRange: () => 'bytes 0-9/10' })).error).toBe(
      'bad_response',
    );
    // The rejected response is not left open: every request of the download is aborted.
    expect(signals.length).toBeGreaterThan(0);
    expect(signals.every((sg) => sg.aborted)).toBe(true);
    const broken = (async () => new Response('oops', { status: 500 })) as unknown as typeof fetch;
    const r = await drain(
      download({
        url: URL_,
        contractId: CONTRACT,
        fileId: FILE,
        header: HEADER,
        proof: { secret: SECRET, purchase_id: FILE, grant: 0 },
        fetch: broken,
      }),
    );
    expect(r.error).toBe('not_authorized');
  });
});
