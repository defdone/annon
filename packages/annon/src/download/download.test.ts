import { bls12_381 as bls } from '@noble/curves/bls12-381.js';
import { getAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { createSiweMessage, parseSiweMessage } from 'viem/siwe';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { seal, sha256 } from '../envelope/pay2.js';
import {
  AUTH_SCHEME,
  type Challenge,
  checksumAddress,
  DownloadError,
  type DownloadTerms,
  download,
  downloadMessage,
  newChallenge,
  verifyDownload,
} from './download.js';

const CONTRACT = 'v1.annon.defdone.near';
const FILE = `0x${'11'.repeat(32)}`;
const buyer = privateKeyToAccount(`0x${'42'.repeat(32)}`);
const stranger = privateKeyToAccount(`0x${'43'.repeat(32)}`);
const seller = privateKeyToAccount(`0x${'44'.repeat(32)}`);
const NOW = 1_800_000_000;
const hex = (b: Uint8Array) => `0x${Buffer.from(b).toString('hex')}`;
const NOW_REAL = () => Math.floor(Date.now() / 1000);

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
const terms: DownloadTerms = {
  domain: 'files.example.com',
  uri: URL_,
  contractId: CONTRACT,
  fileId: FILE,
  headerHash: HEADER_HASH,
};

// NEAR: is_buyer answers from this set, as the contract would at final state.
let buyers: Set<string>;
const nearCalls: unknown[] = [];
beforeEach(() => {
  buyers = new Set([buyer.address.toLowerCase()]);
  nearCalls.length = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: { body: string }) => {
      const b = JSON.parse(init.body);
      const args = JSON.parse(Buffer.from(b.params.args_base64, 'base64').toString());
      nearCalls.push({ ...b.params, args });
      const answer = b.params.method_name === 'is_buyer' && buyers.has(args.wallet);
      return {
        ok: true,
        json: async () => ({
          jsonrpc: '2.0',
          id: b.id,
          result: { result: [...Buffer.from(JSON.stringify(answer))] },
        }),
      };
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

const codeOf = (p: Promise<unknown>) =>
  p.then(
    () => 'ok',
    (e: unknown) => (e instanceof DownloadError ? e.code : `${(e as Error).message}`),
  );

describe('the EIP-4361 message against viem', () => {
  it('is exactly the message viem builds, and parses back to the same fields', () => {
    for (let i = 0; i < 20; i++) {
      const address = privateKeyToAccount(`0x${(i + 1).toString(16).padStart(64, '0')}`).address;
      const c: Challenge = {
        nonce: `n0nce${i}abcdef`,
        issuedAt: NOW + i,
        expiresAt: NOW + i + 120,
      };
      const fileId = `0x${i.toString(16).padStart(64, '0')}`;
      const t = { ...terms, fileId, uri: `https://files.example.com/f/${i}?x=${i}` };
      const ours = downloadMessage(t, address.toLowerCase(), c);
      expect(ours).toBe(
        createSiweMessage({
          domain: t.domain,
          address,
          statement: 'Download an Annon file you bought.',
          uri: t.uri,
          version: '1',
          chainId: 8453,
          nonce: c.nonce,
          issuedAt: new Date(c.issuedAt * 1000),
          expirationTime: new Date(c.expiresAt * 1000),
          resources: [`urn:annon:v1:${CONTRACT}:${fileId}:${HEADER_HASH}`],
        }),
      );
      expect(parseSiweMessage(ours)).toMatchObject({ address, domain: t.domain, nonce: c.nonce });
    }
  });

  it('checksums addresses as EIP-55 does', () => {
    for (let i = 0; i < 50; i++) {
      const a = hex(Uint8Array.from({ length: 20 }, (_, j) => (i * 37 + j * 11) & 0xff));
      expect(checksumAddress(a)).toBe(getAddress(a));
    }
  });

  it('refuses terms it cannot bind', () => {
    const c = newChallenge(NOW);
    for (const t of [
      { ...terms, fileId: FILE.toUpperCase() },
      { ...terms, headerHash: '0x12' },
      { ...terms, contractId: 'Bad Account' },
      { ...terms, uri: 'https://other.example.com/f/1' },
      { ...terms, uri: '/f/1' },
    ]) {
      expect(() => downloadMessage(t, buyer.address, c)).toThrow(TypeError);
    }
    expect(() => downloadMessage(terms, buyer.address, { ...c, nonce: 'short' })).toThrow();
  });
});

describe('verifyDownload (host)', () => {
  let store: Map<string, Challenge>;
  const take = async (n: string) => {
    const c = store.get(n) ?? null;
    store.delete(n);
    return c;
  };
  const issue = () => {
    const c = newChallenge(NOW);
    store.set(c.nonce, c);
    return c;
  };
  const auth = async (c: Challenge, signer = buyer, claimed = signer.address, t = terms) =>
    `${AUTH_SCHEME} ${Buffer.from(
      JSON.stringify({
        address: claimed,
        nonce: c.nonce,
        signature: await signer.signMessage({ message: downloadMessage(t, claimed, c) }),
      }),
    ).toString('base64url')}`;
  const verify = (h: string | null, now = NOW + 1) =>
    verifyDownload(h, { ...terms, nearRpc: 'https://near.rpc', take, now });
  beforeEach(() => {
    store = new Map();
  });

  it('lets the buyer in, once per challenge, after reading is_buyer at final state', async () => {
    const c = issue();
    const h = await auth(c);
    expect(await verify(h)).toEqual({ wallet: buyer.address.toLowerCase() });
    expect(nearCalls).toMatchObject([
      { method_name: 'is_buyer', account_id: CONTRACT, finality: 'final', args: { file_id: FILE } },
    ]);
    expect(await codeOf(verify(h))).toBe('challenge_invalid');
  });

  it('refuses a wallet that did not buy', async () => {
    buyers.clear();
    expect(await codeOf(verify(await auth(issue())))).toBe('not_buyer');
  });

  it('refuses missing, malformed, expired, early and unknown authorizations', async () => {
    for (const h of [
      null,
      '',
      'Bearer abc',
      `${AUTH_SCHEME}`,
      `${AUTH_SCHEME} %%%`,
      `${AUTH_SCHEME} ${Buffer.from('{"address":1}').toString('base64url')}`,
      `${AUTH_SCHEME} a b`,
    ]) {
      expect(await codeOf(verify(h)), String(h)).toBe('no_authorization');
    }
    const valid = (await auth(issue())).split(' ')[1] as string;
    expect(await codeOf(verify(`Bearer ${valid}`))).toBe('no_authorization');
    expect(await codeOf(verify(`${AUTH_SCHEME} ${valid} x`))).toBe('no_authorization');
    expect(await codeOf(verify(await auth(issue()), NOW + 120))).toBe('challenge_invalid');
    // A stored challenge that lives longer than 120 s is refused, even inside its window.
    const long = { nonce: 'longlived1', issuedAt: NOW, expiresAt: NOW + 86_400 };
    store.set(long.nonce, long);
    const signed = `${AUTH_SCHEME} ${Buffer.from(
      JSON.stringify({
        address: buyer.address,
        nonce: long.nonce,
        signature: await buyer.signMessage({
          message: downloadMessage(terms, buyer.address, { ...long, expiresAt: NOW + 120 }),
        }),
      }),
    ).toString('base64url')}`;
    expect(await codeOf(verify(signed, NOW + 3600))).toBe('challenge_invalid');
    expect(await codeOf(verify(await auth(issue()), NOW - 1))).toBe('challenge_invalid');
    const forged = { nonce: 'neverissued1', issuedAt: NOW, expiresAt: NOW + 120 };
    expect(await codeOf(verify(await auth(forged)))).toBe('challenge_invalid');
  });

  it('refuses a signature for anything else: other wallet, host, file, header or contract', async () => {
    expect(await codeOf(verify(await auth(issue(), stranger, buyer.address)))).toBe(
      'bad_signature',
    );
    for (const t of [
      { ...terms, domain: 'evil.example.com', uri: 'https://evil.example.com/f/1' },
      { ...terms, uri: 'https://files.example.com/f/2' },
      { ...terms, fileId: `0x${'12'.repeat(32)}` },
      { ...terms, headerHash: `0x${'00'.repeat(32)}` },
      { ...terms, contractId: 'annon-dev.synthetic.near' },
    ]) {
      expect(await codeOf(verify(await auth(issue(), buyer, buyer.address, t)))).toBe(
        'bad_signature',
      );
    }
    const c = issue();
    const good = JSON.parse(
      Buffer.from((await auth(c)).split(' ')[1] as string, 'base64url').toString(),
    );
    const flipped = {
      ...good,
      signature: `${good.signature.slice(0, -4)}00${good.signature.slice(-2)}`,
    };
    store.set(c.nonce, c);
    expect(
      await codeOf(
        verify(`${AUTH_SCHEME} ${Buffer.from(JSON.stringify(flipped)).toString('base64url')}`),
      ),
    ).toBe('bad_signature');
    expect(nearCalls).toHaveLength(0);
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
    /** The 401 body, instead of a fresh challenge. */
    challenge?: () => string;
    /** End the first response cleanly after this many bytes (no network error). */
    cleanCutAt?: number;
    /** The header hash the host binds, when it serves another header than HEADER. */
    headerHash?: string;
  };
  const ranges: string[] = [];
  let bodiesCancelled = 0;
  const signals: AbortSignal[] = [];
  const host = (o: Host) => {
    const store = new Map<string, Challenge>();
    let responses = 0;
    return (async (
      url: string,
      init?: { headers?: Record<string, string>; signal?: AbortSignal },
    ) => {
      if (init?.signal) signals.push(init.signal);
      const h = init?.headers ?? {};
      if (!h.authorization) {
        const c = newChallenge();
        store.set(c.nonce, c);
        return new Response(o.challenge?.() ?? JSON.stringify(c), { status: 401 });
      }
      await verifyDownload(h.authorization, {
        ...terms,
        headerHash: o.headerHash ?? HEADER_HASH,
        uri: url,
        nearRpc: 'https://near.rpc',
        take: async (n) => {
          const c = store.get(n) ?? null;
          store.delete(n);
          return c;
        },
      });
      ranges.push(h.range ?? '');
      const offset = Number(/^bytes=(\d+)-$/.exec(h.range ?? '')?.[1] ?? 0);
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
        headers: o.noRange
          ? {}
          : {
              'content-range':
                o.contentRange?.(offset) ?? `bytes ${offset}-${o.file.length - 1}/${o.file.length}`,
            },
      });
    }) as unknown as typeof fetch;
  };
  let signatures = 0;
  const get = async (o: Host, retries?: number, header = HEADER) => {
    const got: Uint8Array[] = [];
    signatures = 0;
    const s = download({
      url: URL_,
      contractId: CONTRACT,
      fileId: FILE,
      header,
      wallet: {
        address: buyer.address,
        signMessage: (message) => {
          signatures++;
          return buyer.signMessage({ message });
        },
      },
      fetch: host(o),
      ...(retries === undefined ? {} : { retries }),
    });
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
  const joined = (parts: Uint8Array[]) => Buffer.concat(parts.map((p) => Buffer.from(p)));
  beforeEach(() => {
    ranges.length = 0;
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
      expect(signatures).toBe(1);
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

  it('refuses a challenge that is too large, too long-lived, expired or with a huge nonce', async () => {
    const t = NOW_REAL();
    for (const body of [
      // A valid challenge, padded past 1 KiB: refused before it is parsed or signed.
      `${JSON.stringify({ nonce: 'abcdefgh', issuedAt: t, expiresAt: t + 60 })}${' '.repeat(2000)}`,
      JSON.stringify({ nonce: 'abcdefgh', issuedAt: t, expiresAt: t + 86_400 }),
      JSON.stringify({ nonce: 'abcdefgh', issuedAt: t - 300, expiresAt: t - 200 }),
      JSON.stringify({ nonce: 'a'.repeat(65), issuedAt: t, expiresAt: t + 60 }),
      'not json',
    ]) {
      const r = await get({ file: PAY2, challenge: () => body });
      expect(r.error, body.slice(0, 40)).toBe('bad_response');
      expect(signatures).toBe(0);
    }
  });

  it('does not retry when the wallet refuses, and refuses a challenge issued in the future', async () => {
    let asks = 0;
    let requests = 0;
    const fetcher = host({ file: PAY2 });
    const s = download({
      url: URL_,
      contractId: CONTRACT,
      fileId: FILE,
      header: HEADER,
      wallet: {
        address: buyer.address,
        signMessage: async () => {
          asks++;
          throw new Error('User rejected request');
        },
      },
      fetch: ((...a: Parameters<typeof fetch>) => {
        requests++;
        return fetcher(...a);
      }) as typeof fetch,
    });
    const reader = s.getReader();
    await reader.read();
    await expect(reader.read()).rejects.toMatchObject({ code: 'wallet_refused' });
    expect([asks, requests]).toEqual([1, 1]);
    const t = NOW_REAL();
    const future = JSON.stringify({ nonce: 'abcdefgh', issuedAt: t + 600, expiresAt: t + 660 });
    const r = await get({ file: PAY2, challenge: () => future });
    expect(r.error).toBe('bad_response');
    expect(signatures).toBe(0);
  });

  it('stops everything when cancelled, even while the challenge request is pending', async () => {
    // A fetch that honours the abort signal, and one that ignores it: neither may lead to a signature.
    for (const honours of [true, false]) {
      let release: () => void = () => {};
      let requests = 0;
      let asks = 0;
      const fetcher = (async (_u: string, init?: { signal?: AbortSignal }) => {
        requests++;
        await new Promise<void>((r) => {
          release = r;
        });
        if (honours && init?.signal?.aborted) throw new DOMException('aborted', 'AbortError');
        return new Response(JSON.stringify(newChallenge()), { status: 401 });
      }) as unknown as typeof fetch;
      const s = download({
        url: URL_,
        contractId: CONTRACT,
        fileId: FILE,
        header: HEADER,
        wallet: {
          address: buyer.address,
          signMessage: async (message) => {
            asks++;
            return buyer.signMessage({ message });
          },
        },
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
      expect([requests, asks]).toEqual([1, 0]);
    }
  });

  it('downloads only over https, plain http only on this machine', () => {
    const opts = {
      contractId: CONTRACT,
      fileId: FILE,
      header: HEADER,
      wallet: { address: buyer.address, signMessage: async () => '0x' },
    };
    expect(() => download({ ...opts, url: 'http://files.example.com/f/1' })).toThrow(/https/);
    expect(() => download({ ...opts, url: 'http://localhost:8080/f/1' })).not.toThrow();
    vi.stubGlobal('location', { host: 'market.example.com' });
    expect(() => download({ ...opts, url: URL_ })).toThrow(/page's host/);
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
    const open = (async () =>
      new Response(JSON.stringify(newChallenge()), { status: 200 })) as unknown as typeof fetch;
    const s = download({
      url: URL_,
      contractId: CONTRACT,
      fileId: FILE,
      header: HEADER,
      wallet: { address: buyer.address, signMessage: (message) => buyer.signMessage({ message }) },
      fetch: open,
    });
    const reader = s.getReader();
    await reader.read();
    await expect(reader.read()).rejects.toMatchObject({ code: 'bad_response' });
  });
});
