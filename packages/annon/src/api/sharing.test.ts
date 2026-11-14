import { ed25519 } from '@noble/curves/ed25519.js';
import { base58, base64 } from '@scure/base';
import { privateKeyToAccount } from 'viem/accounts';
import { afterEach, expect, it, vi } from 'vitest';
import { terms as fixture, must } from '../../test/fixtures.js';
import { signNearUpload } from '../browser/wallets.js';
import { AnnonError } from '../errors.js';
import { nep413Hash } from '../near/nep413.js';
import * as rpc from '../near/rpc.js';
import { type EncryptedRecord, newBackupSecret } from '../pay/backup.js';
import { memoryStore } from '../pay/store.js';
import { termsHash } from '../settle-near/terms.js';
import { TransactionUncertain } from '../wallet/uncertain.js';
import { HostedSelling, type ShareHosting, type ShareOptions } from './sharing.js';

const account = privateKeyToAccount(`0x${'42'.repeat(32)}`);
const seller = {
  identity: { kind: 'evm' as const, id: account.address.toLowerCase() },
  authorize: vi.fn(async (message: string) => ({
    kind: 'evm' as const,
    sig: await account.signMessage({ message }),
  })),
};
const now = 1800000000;
function harness() {
  const raw = memoryStore<EncryptedRecord>();
  const backups: string[] = [];
  const writeBackup = vi.fn(async (_name: string, text: string) => {
    backups.push(text);
  });
  const send = vi.fn(async () => null);
  const file = vi.fn(async () => null);
  let clock = now;
  const options = {
    network: fixture.network,
    contractId: fixture.contract,
    nearRpc: 'https://near.example',
    baseRpc: 'https://base.example',
    rawStore: raw,
    backupSecret: newBackupSecret(),
    writeBackup,
    now: () => clock,
  };
  const engine = new HostedSelling(options, {
    config: async () => ({
      network: fixture.network,
      nearUsdc: fixture.near.token,
      usdc: must(fixture.base).usdc,
    }),
    file,
    call: send,
    answer: async () => new Uint8Array(48).fill(7),
    reopen: vi.fn(async () => new Uint8Array(48).fill(7)),
  });
  const input: ShareOptions = {
    data: new Uint8Array([1, 2, 3]),
    name: 'file.txt',
    mime: 'text/plain',
    seller,
    price: '100000',
    hosting: { origin: 'https://host.example' },
    title: 'A file',
    description: '',
  };
  return {
    engine,
    input,
    options,
    raw,
    backups,
    writeBackup,
    send,
    file,
    setNow: (n: number) => {
      clock = n;
    },
  };
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  seller.authorize.mockClear();
});
it('quotes without writes or signatures and privately retains the approved terms', async () => {
  const h = harness();
  const q = await h.engine.quote(h.input);
  expect(h.send).not.toHaveBeenCalled();
  expect(h.writeBackup).not.toHaveBeenCalled();
  expect(seller.authorize).not.toHaveBeenCalled();
  expect(q.terms.base).not.toBeNull();
  q.terms.near.price = '900000';
  const job = await h.engine.begin(q.quoteId);
  expect(job.terms.near.price).toBe('100000');
  expect(job.baseSplit?.salt).toBe(`0x${'00'.repeat(32)}`);
  expect(h.backups).toHaveLength(1);
  expect(h.backups[0]).not.toContain(job.fileKey);
});
it('requires a saved backup confirmation before even hosting signing', async () => {
  const h = harness();
  const q = await h.engine.quote(h.input);
  const job = await h.engine.begin(q.quoteId);
  await expect(h.engine.next(job.terms.file_id, h.input)).rejects.toMatchObject({
    code: 'backup_secret_required',
  });
  expect(seller.authorize).not.toHaveBeenCalled();
});
it('never enables Base terms for a non-EVM seller', async () => {
  const h = harness();
  const q = await h.engine.quote({
    ...h.input,
    seller: {
      identity: { kind: 'near', id: 'seller.synthetic.near' },
      authorize: vi.fn(async () => undefined),
    },
    listingStorage: 1n,
    storageBudget: 2n,
  });
  expect(q.terms.base).toBeNull();
  expect(q.steps).toEqual(['stage', 'deposit', 'register', 'fund', 'publish']);
  expect(q.listingStorage).toBe('1');
  expect(q.storageBudget).toBe('2');
});
it('a failed durable backup prevents every effect', async () => {
  const h = harness();
  h.writeBackup.mockRejectedValueOnce(new Error('disk'));
  const q = await h.engine.quote(h.input);
  await expect(h.engine.begin(q.quoteId)).rejects.toThrow('disk');
  expect(h.send).not.toHaveBeenCalled();
  expect(seller.authorize).not.toHaveBeenCalled();
});
it('rejects missing hosting, oversize plaintext and undisclosed NEAR funding before signing', async () => {
  const h = harness();
  await expect(h.engine.quote({ ...h.input, hosting: undefined } as never)).rejects.toMatchObject({
    code: 'transport_required',
  });
  await expect(
    h.engine.quote({
      ...h.input,
      data: {
        size: 50_000_001,
        read: () => {
          throw new Error('read');
        },
      },
    }),
  ).rejects.toMatchObject({ code: 'too_large' });
  await expect(
    h.engine.quote({
      ...h.input,
      seller: {
        identity: { kind: 'near', id: 'seller.synthetic.near' },
        authorize: vi.fn(async () => undefined),
      },
    }),
  ).rejects.toMatchObject({ code: 'storage_required' });
});
it('read failures and malformed encrypted records fail closed', async () => {
  const h = harness();
  const q = await h.engine.quote(h.input);
  const job = await h.engine.begin(q.quoteId);
  const key = `annon/sell/${job.terms.file_id}`;
  const saved = must(await h.raw.load(key));
  await h.raw.compareAndSet(key, saved, { ...saved, revision: saved.revision + 1 });
  await expect(h.engine.load(job.terms.file_id)).rejects.toMatchObject({ code: 'invalid_record' });
});
it('confirmation is idempotent and cannot roll progress backwards', async () => {
  const h = harness();
  const q = await h.engine.quote(h.input);
  const job = await h.engine.begin(q.quoteId);
  const confirmed = await h.engine.confirmBackup(job.terms.file_id);
  expect(confirmed.hosting?.backupConfirmed).toBe(true);
  expect(await h.engine.confirmBackup(job.terms.file_id)).toEqual(confirmed);
});
it('the stored intent binds the predicted terms, metadata and complete framing', async () => {
  const h = harness();
  const q = await h.engine.quote(h.input);
  const job = await h.engine.begin(q.quoteId);
  expect(job.hosting?.intent.termsHash).toBe(termsHash(job.terms));
  expect(must(job.hosting).intent.byteSize).toBe(
    must(job.hosting).intent.headerSize +
      3 +
      must(job.hosting).manifest.metaLen +
      16 * must(job.hosting).manifest.n,
  );
});

async function staged(kind: 'evm' | 'near' | 'solana' = 'evm') {
  const h = harness();
  const secret = new Uint8Array(32).fill(8);
  const publicKey = ed25519.getPublicKey(secret);
  const nearCall = vi.fn(async (_call: unknown): Promise<unknown> => null);
  if (kind === 'solana')
    h.input.seller = {
      identity: { kind, id: Buffer.from(publicKey).toString('hex') },
      authorize: vi.fn(async (text) => ({
        kind,
        sig: `0x${Buffer.from(ed25519.sign(new TextEncoder().encode(text), secret)).toString('hex')}`,
      })),
    };
  if (kind === 'near') {
    vi.spyOn(rpc, 'isFullAccessKey').mockResolvedValue(true);
    vi.spyOn(rpc, 'view').mockResolvedValue('100');
    h.file.mockImplementation(async () =>
      (await h.engine.load(q.fileId)).hosting.completed.includes('register')
        ? ({ purchaseStorageBalance: 100n, termsHash: must(job.hosting).intent.termsHash } as never)
        : null,
    );
    h.input.seller = {
      identity: { kind, id: 'seller.synthetic.near' },
      authorize: vi.fn(async () => undefined),
      call: nearCall,
      transferPurchase: vi.fn(),
    } as never;
    h.input.listingStorage = 10n ** 22n;
    h.input.storageBudget = 5n * 10n ** 22n;
    h.input.hosting.signUpload = (intent) =>
      signNearUpload(
        {
          getAccounts: async () => [{ accountId: 'seller.synthetic.near' }],
          signMessage: async (payload) => ({
            accountId: 'seller.synthetic.near',
            publicKey: `ed25519:${base58.encode(publicKey)}`,
            signature: base64.encode(ed25519.sign(nep413Hash(payload), secret)),
          }),
        },
        intent,
        h.options.nearRpc,
      );
  }
  const { blobSource } = await import('../envelope/replay.js');
  h.input.hosting = {
    ...h.input.hosting,
    spool: async (stream, use) => use(blobSource(await new Response(stream).blob())),
  } as ShareHosting;
  const q = await h.engine.quote(h.input);
  const job = await h.engine.begin(q.quoteId);
  const uploadId = 'aa'.repeat(32);
  const reservation = {
    v: 1,
    uploadId,
    ...must(job.hosting).intent,
    issuedAt: now,
    expiresAt: now + 600,
    signature: 'a'.repeat(86),
  } as Record<string, unknown>;
  delete reservation.nonce;
  const split = {
    state: 'ready',
    address: job.terms.base?.pay_to ?? `0x${'11'.repeat(20)}`,
    kind: 'push',
    salt: job.baseSplit?.salt ?? `0x${'00'.repeat(32)}`,
    txHash: `0x${'ab'.repeat(32)}`,
  };
  let status: Record<string, unknown> = {
    uploadId,
    state: 'receiving',
    expiresAt: now + 600,
    bodyUrl: `https://host.example/v1/uploads/${uploadId}/body`,
    headerUrl: `https://host.example/v1/uploads/${uploadId}/header`,
  };
  const published = {
    fileId: q.fileId,
    url: `https://host.example/f/${q.fileId.slice(2)}`,
    header: `https://host.example/f/${q.fileId.slice(2)}/header`,
    expiresAt: now + 604800,
  };
  const fetcher = vi.fn(async (url: string | URL | Request, options?: RequestInit) => {
    const path = String(url);
    if (path.endsWith('/body')) {
      if (options?.body instanceof ReadableStream) await new Response(options.body).arrayBuffer();
      status = { uploadId, state: 'reserved', reservation };
      return Response.json(status);
    }
    if (path.endsWith('/base-split'))
      return Response.json(
        { baseSplit: job.terms.base ? split : null },
        { status: split.state === 'pending' ? 202 : 200 },
      );
    if (path.endsWith('/header')) {
      status = { uploadId, state: 'published', result: published };
      return Response.json(published);
    }
    return Response.json(
      options?.method === 'GET' || status.state !== 'receiving'
        ? { ...status, baseSplit: job.terms.base ? split : null }
        : status,
    );
  });
  vi.stubGlobal('fetch', fetcher);
  await h.engine.confirmBackup(q.fileId);
  return {
    ...h,
    nearCall,
    q,
    job,
    reservation,
    split,
    published,
    fetcher,
    setStatus: (s: Record<string, unknown>) => {
      status = s;
    },
  };
}
it('stages before the split, sends the exact split contract, and includes reservation in register', async () => {
  const h = await staged();
  await h.engine.next(h.q.fileId, h.input);
  expect((await h.engine.load(h.q.fileId)).hosting?.completed).toEqual(['stage']);
  await h.engine.next(h.q.fileId, h.input);
  expect((await h.engine.load(h.q.fileId)).hosting.split?.txHash).toBe(`0x${'ab'.repeat(32)}`);
  const request = must(h.fetcher.mock.calls.find(([url]) => String(url).endsWith('/base-split')));
  expect(JSON.parse(String(request[1]?.body))).toEqual({
    kind: 'push',
    salt: `0x${'00'.repeat(32)}`,
  });
  await h.engine.next(h.q.fileId, h.input);
  expect(h.send).toHaveBeenCalledWith(
    'register',
    expect.objectContaining({
      hostingReservation: h.reservation,
      baseSplit: { kind: 'push', salt: must(h.job.baseSplit).salt },
      args: expect.objectContaining({ terms: h.job.terms }),
    }),
    h.input.seller,
  );
  expect(seller.authorize.mock.calls.map(([t]) => t.split('\n')[0])).toEqual([
    'Annon: reserve encrypted file hosting',
    'Annon: list a file for sale',
  ]);
});
it('a lost registration response reconciles final terms without signing register twice', async () => {
  const h = await staged();
  await h.engine.next(h.q.fileId, h.input);
  await h.engine.next(h.q.fileId, h.input);
  h.send.mockRejectedValueOnce(new AnnonError('transaction_uncertain'));
  await expect(h.engine.next(h.q.fileId, h.input)).rejects.toMatchObject({
    code: 'transaction_uncertain',
  });
  h.file.mockResolvedValueOnce({ termsHash: must(h.job.hosting).intent.termsHash } as never);
  await h.engine.next(h.q.fileId, h.input);
  expect(h.send).toHaveBeenCalledTimes(1);
  expect((await h.engine.load(h.q.fileId)).hosting?.completed).toEqual([
    'stage',
    'split',
    'register',
  ]);
});
it('one lease fences a second click and an expired signer cannot upload or complete', async () => {
  const h = await staged();
  let release!: () => void;
  const pause = new Promise<void>((resolve) => {
    release = resolve;
  });
  const original = must(seller.authorize.getMockImplementation());
  seller.authorize.mockImplementationOnce(async (text) => {
    await pause;
    return original(text);
  });
  const first = h.engine.next(h.q.fileId, h.input);
  void first.catch(() => {});
  while (!seller.authorize.mock.calls.length)
    await new Promise((resolve) => setTimeout(resolve, 1));
  await expect(h.engine.next(h.q.fileId, h.input)).rejects.toMatchObject({
    code: 'lease_busy',
    retryAfterSeconds: 5,
  });
  h.setNow(now + 121);
  release();
  await expect(first).rejects.toMatchObject({ code: 'lease_busy' });
  expect(h.fetcher).not.toHaveBeenCalled();
  expect((await h.engine.load(h.q.fileId)).hosting?.completed).toEqual([]);
});
it('expired reservations cannot authorize a split or a registration', async () => {
  const h = await staged();
  await h.engine.next(h.q.fileId, h.input);
  h.setNow(now + 601);
  await expect(h.engine.next(h.q.fileId, h.input)).rejects.toMatchObject({
    code: 'upload_expired',
  });
  expect(h.fetcher.mock.calls.filter(([url]) => String(url).endsWith('/base-split'))).toHaveLength(
    0,
  );
  expect(h.send).not.toHaveBeenCalled();
});
it('checks a split response against the predicted address before registering', async () => {
  const h = await staged();
  await h.engine.next(h.q.fileId, h.input);
  h.split.address = `0x${'11'.repeat(20)}`;
  await expect(h.engine.next(h.q.fileId, h.input)).rejects.toMatchObject({ code: 'bad_response' });
  expect(h.send).not.toHaveBeenCalled();
});
it('publication is checked, persisted and stable after a lost answer', async () => {
  const h = await staged();
  for (let i = 0; i < 3; i++) await h.engine.next(h.q.fileId, h.input);
  const original = must(h.fetcher.getMockImplementation());
  h.fetcher.mockImplementation(async (url, options) => {
    const response = await original(url, options);
    if (String(url).endsWith('/header')) throw new Error('lost answer');
    return response;
  });
  await expect(h.engine.next(h.q.fileId, h.input)).rejects.toMatchObject({
    code: 'operation_failed',
  });
  const count = seller.authorize.mock.calls.length;
  await h.engine.next(h.q.fileId, h.input);
  const final = await h.engine.load(h.q.fileId);
  expect(final.hosting?.result).toEqual(h.published);
  expect(final.fileKey).toBeNull();
  expect(final.sellerSecret).toBeNull();
  expect(final.ckdSecret).toBeNull();
  await h.engine.next(h.q.fileId, h.input);
  expect(seller.authorize).toHaveBeenCalledTimes(count);
});

it('retries an interrupted body with the saved signature and upload identity', async () => {
  const h = await staged();
  const original = must(h.fetcher.getMockImplementation());
  let fail = true;
  h.fetcher.mockImplementation(async (url, options) => {
    if (String(url).endsWith('/body') && fail) {
      fail = false;
      throw new Error('lost body');
    }
    return original(url, options);
  });
  await expect(h.engine.next(h.q.fileId, h.input)).rejects.toMatchObject({
    code: 'operation_failed',
  });
  await h.engine.next(h.q.fileId, h.input);
  expect((await h.engine.load(h.q.fileId)).hosting?.completed).toEqual(['stage']);
  expect(seller.authorize).toHaveBeenCalledTimes(1);
});
it('refreshes expired upload authorization without changing content, nonce or terms', async () => {
  const h = await staged();
  await h.engine.next(h.q.fileId, h.input);
  h.setNow(now + 601);
  h.reservation.issuedAt = now + 601;
  h.reservation.expiresAt = now + 1201;
  await h.engine.next(h.q.fileId, h.input);
  const saved = await h.engine.load(h.q.fileId);
  expect(saved.hosting?.intent.nonce).toBe(h.job.hosting?.intent.nonce);
  expect(saved.hosting?.intent.expiresAt).toBe(now + 1201);
  expect(saved.terms).toEqual(h.job.terms);
  expect(seller.authorize).toHaveBeenCalledTimes(2);
});

it('a rolled-back primary checkpoint cannot repeat an already completed stage', async () => {
  const h = await staged();
  await h.engine.next(h.q.fileId, h.input);
  const { encryptedSellStore } = await import('../pay/backup.js');
  const store = encryptedSellStore(h.raw, h.options.backupSecret);
  const saved = must(await store.load(`annon/sell/${h.q.fileId}`));
  await store.compareAndSet(`annon/sell/${h.q.fileId}`, saved, {
    ...saved,
    revision: saved.revision + 1,
    hosting: { ...must(saved.hosting), completed: [], pending: null },
  });
  await h.engine.next(h.q.fileId, h.input);
  expect(seller.authorize).toHaveBeenCalledTimes(1);
  expect((await h.engine.load(h.q.fileId)).hosting?.completed).toEqual(['stage']);
});

it.each(['near', 'solana'] as const)(
  '%s selling has no Base terms or split request and publishes fully',
  async (kind) => {
    const h = await staged(kind);
    expect(h.job.terms.base).toBeNull();
    expect(h.job.baseSplit).toBeNull();
    for (const _step of must(h.job.hosting).steps) await h.engine.next(h.q.fileId, h.input);
    const saved = await h.engine.load(h.q.fileId);
    expect(saved.hosting.result).toEqual(h.published);
    expect(h.fetcher.mock.calls.some(([url]) => String(url).endsWith('/base-split'))).toBe(false);
    if (kind === 'near') {
      expect(h.nearCall.mock.calls.map(([c]) => c)).toEqual([
        expect.objectContaining({ method: 'storage_deposit', deposit: 10n ** 22n }),
        expect.objectContaining({
          method: 'register',
          deposit: 0n,
          args: expect.objectContaining({ args: expect.objectContaining({ terms: h.job.terms }) }),
        }),
        expect.objectContaining({
          method: 'fund_file_storage',
          deposit: 5n * 10n ** 22n,
          args: { file_id: h.q.fileId },
        }),
        expect.objectContaining({ method: 'publish_header', deposit: 0n }),
      ]);
      expect(h.send).not.toHaveBeenCalled();
    }
  },
);
it('uncertain NEAR funding preserves its hash and reconciles without allocating twice', async () => {
  const h = await staged('near');
  for (let i = 0; i < 3; i++) await h.engine.next(h.q.fileId, h.input);
  h.nearCall.mockRejectedValueOnce(new TransactionUncertain('synthetic-funding'));
  await expect(h.engine.next(h.q.fileId, h.input)).rejects.toMatchObject({
    code: 'transaction_uncertain',
  });
  expect((await h.engine.load(h.q.fileId)).hosting.pending?.txHash).toBe('synthetic-funding');
  vi.spyOn(rpc, 'txOutcome').mockResolvedValue({
    state: 'done',
    method: 'fund_file_storage',
    value: null,
    events: [],
  });
  await h.engine.next(h.q.fileId, h.input);
  expect(
    h.nearCall.mock.calls.filter(([c]) => (c as { method: string }).method === 'fund_file_storage'),
  ).toHaveLength(1);
  expect((await h.engine.load(h.q.fileId)).hosting.completed).toContain('fund');
});

it('a caller-approved revision cannot be swapped before signing', async () => {
  const h = await staged();
  await expect(
    h.engine.next(h.q.fileId, { ...h.input, expectedRevision: 0 }),
  ).rejects.toMatchObject({ code: 'store_conflict' });
  expect(seller.authorize).not.toHaveBeenCalled();
});
it('a definite wallet rejection permits an explicit retry without forgetting uncertain failures', async () => {
  const h = await staged();
  seller.authorize.mockRejectedValueOnce(new AnnonError('rejected'));
  await expect(h.engine.next(h.q.fileId, h.input)).rejects.toMatchObject({ code: 'rejected' });
  expect((await h.engine.load(h.q.fileId)).hosting.pending).toBeNull();
  await h.engine.next(h.q.fileId, h.input);
  expect(seller.authorize).toHaveBeenCalledTimes(2);
  expect((await h.engine.load(h.q.fileId)).hosting.completed).toEqual(['stage']);
});

it('checks the durable pending checkpoint and backup before invoking the signer', async () => {
  const h = await staged();
  const original = must(seller.authorize.getMockImplementation());
  seller.authorize.mockImplementationOnce(async (text) => {
    const job = await h.engine.load(h.q.fileId);
    expect(job.hosting.pending?.step).toBe('stage');
    expect(h.writeBackup.mock.calls.length).toBeGreaterThanOrEqual(4);
    expect(await h.raw.load(`annon/share-operation/${h.q.fileId}/stage`)).not.toBeNull();
    return original(text);
  });
  await h.engine.next(h.q.fileId, h.input);
});
it('enforces the canonical wallet identity and selected host before any effect', async () => {
  const h = await staged();
  await expect(
    h.engine.next(h.q.fileId, {
      ...h.input,
      seller: { ...seller, identity: { kind: 'evm', id: `0x${'11'.repeat(20)}` } },
    }),
  ).rejects.toMatchObject({ code: 'wrong_identity' });
  await expect(
    h.engine.next(h.q.fileId, {
      ...h.input,
      hosting: { ...h.input.hosting, origin: 'https://other.example' },
    }),
  ).rejects.toMatchObject({ code: 'config_conflict' });
  expect(seller.authorize).not.toHaveBeenCalled();
});
it('lease expiry alone stops a delayed approval even when no other tab takes over', async () => {
  const h = await staged();
  const original = must(seller.authorize.getMockImplementation());
  seller.authorize.mockImplementationOnce(async (text) => {
    const auth = await original(text);
    h.setNow(now + 121);
    return auth;
  });
  await expect(h.engine.next(h.q.fileId, h.input)).rejects.toMatchObject({ code: 'lease_busy' });
  expect(h.fetcher).not.toHaveBeenCalled();
});
it('an account switch after signing cannot upload or complete', async () => {
  const h = await staged();
  const original = must(seller.authorize.getMockImplementation());
  const initial = seller.identity;
  seller.authorize.mockImplementationOnce(async (text) => {
    const auth = await original(text);
    seller.identity = { kind: 'evm', id: `0x${'11'.repeat(20)}` };
    return auth;
  });
  try {
    await expect(h.engine.next(h.q.fileId, h.input)).rejects.toMatchObject({
      code: 'wrong_identity',
    });
    expect(h.fetcher).not.toHaveBeenCalled();
  } finally {
    seller.identity = initial;
  }
});
it('backup confirmation after progress is idempotent', async () => {
  const h = await staged();
  await h.engine.next(h.q.fileId, h.input);
  await h.engine.confirmBackup(h.q.fileId);
  expect((await h.engine.load(h.q.fileId)).hosting.completed).toEqual(['stage']);
  expect(seller.authorize).toHaveBeenCalledTimes(1);
});
it('sponsored terms include the reviewed fee before predicting the Base split', async () => {
  const h = harness();
  Object.assign(h.options, {
    sponsorship: async () => ({
      fee: {
        fixed: '30000',
        bps: 100,
        treasuryNear: null,
        treasuryEvm: { kind: 'evm', id: `0x${'55'.repeat(20)}` },
      },
    }),
  });
  const q = await h.engine.quote(h.input);
  expect(q.terms.near.recipients.map((r) => r.bps).sort()).toEqual([3100, 6900]);
  Object.assign(h.options, { maxProtocolFee: { fixed: '0', bps: 0 } });
  await expect(h.engine.quote(h.input)).rejects.toMatchObject({ code: 'protocol_fee_above_max' });
});
it('a hosted publication with an expired lifetime cannot count as done', async () => {
  const h = await staged();
  for (let i = 0; i < 3; i++) await h.engine.next(h.q.fileId, h.input);
  h.published.expiresAt = now - 1;
  await expect(h.engine.next(h.q.fileId, h.input)).rejects.toMatchObject({ code: 'file_expired' });
  expect((await h.engine.load(h.q.fileId)).published).not.toBe(true);
});
it('a forged off-host publication URL cannot count as done', async () => {
  const h = await staged();
  for (let i = 0; i < 3; i++) await h.engine.next(h.q.fileId, h.input);
  h.published.url = 'https://other.example/file';
  await expect(h.engine.next(h.q.fileId, h.input)).rejects.toMatchObject({
    code: 'operation_failed',
  });
  expect((await h.engine.load(h.q.fileId)).hosting.result).toBeNull();
});

it.each([
  ['steps', null],
  ['steps', ['split']],
  ['completed', ['publish']],
  ['completed', 'stage'],
  ['pending', { step: 'fund', token: 'synthetic' }],
  ['pending', { step: 'stage', token: 1 }],
  ['lease', { owner: 1, until: now }],
  ['lease', { owner: 'synthetic', until: 0.5 }],
  ['backupConfirmed', 'yes'],
  ['uploadId', 'not-an-upload'],
  ['fee', undefined],
  [
    'split',
    {
      state: 'ready',
      address: `0x${'11'.repeat(20)}`,
      kind: 'push',
      salt: `0x${'00'.repeat(32)}`,
      txHash: null,
    },
  ],
  ['header', 'invalid'],
  ['result', { fileId: 'forged', url: 'javascript:invalid', header: '', expiresAt: 1 }],
] as const)(
  'rejects malformed hosted field %s = %j before encryption or signing',
  async (field, value) => {
    const h = harness(),
      q = await h.engine.quote(h.input),
      job = await h.engine.begin(q.quoteId);
    const changed = structuredClone(job);
    Object.assign(must(changed.hosting), { [field]: value });
    const { exportSell } = await import('../pay/backup.js');
    await expect(exportSell(changed, h.options.backupSecret)).rejects.toMatchObject({
      code: 'invalid_record',
    });
    expect(seller.authorize).not.toHaveBeenCalled();
  },
);
it.each(['termsHash', 'fileId', 'cipherHash', 'hostOrigin', 'seller'] as const)(
  'rejects a mismatched hosted intent %s',
  async (field) => {
    const h = harness(),
      q = await h.engine.quote(h.input),
      job = await h.engine.begin(q.quoteId);
    const changed = structuredClone(job);
    Object.assign(must(changed.hosting).intent, {
      [field]:
        field === 'hostOrigin'
          ? 'https://other.example'
          : field === 'seller'
            ? { kind: 'near', id: 'other.synthetic.near' }
            : `0x${'11'.repeat(32)}`,
    });
    const { exportSell } = await import('../pay/backup.js');
    await expect(exportSell(changed, h.options.backupSecret)).rejects.toMatchObject({
      code: 'invalid_record',
    });
  },
);
it('checks metadata content against the stored intent when reading', async () => {
  const h = harness(),
    q = await h.engine.quote(h.input),
    job = await h.engine.begin(q.quoteId);
  const { encryptedSellStore } = await import('../pay/backup.js');
  const store = encryptedSellStore(h.raw, h.options.backupSecret);
  const changed = structuredClone(job);
  changed.revision++;
  must(changed.hosting).metadata.title = 'Changed';
  await store.compareAndSet(`annon/sell/${q.fileId}`, job, changed);
  await expect(h.engine.load(q.fileId)).rejects.toMatchObject({ code: 'invalid_record' });
});

it('saves the exact register operation and signature before calling its transport', async () => {
  const h = await staged();
  await h.engine.next(h.q.fileId, h.input);
  await h.engine.next(h.q.fileId, h.input);
  h.send.mockImplementationOnce(async () => {
    const job = await h.engine.load(h.q.fileId);
    expect(job.hosting.pending?.operation?.method).toBe('register');
    expect(job.hosting.pending?.operation?.args).toMatchObject({ args: { terms: h.job.terms } });
    expect(job.hosting.pending?.auth?.kind).toBe('evm');
    return null;
  });
  await h.engine.next(h.q.fileId, h.input);
});
it('a lost split response reconciles the same canonical host operation without a new signature', async () => {
  const h = await staged();
  await h.engine.next(h.q.fileId, h.input);
  h.split.state = 'pending';
  await expect(h.engine.next(h.q.fileId, h.input)).rejects.toMatchObject({
    code: 'settlement_pending',
  });
  expect((await h.engine.load(h.q.fileId)).hosting.split?.txHash).toBe(`0x${'ab'.repeat(32)}`);
  h.split.state = 'ready';
  await h.engine.next(h.q.fileId, h.input);
  expect(seller.authorize).toHaveBeenCalledTimes(1);
  expect(h.fetcher.mock.calls.filter(([url]) => String(url).endsWith('/base-split'))).toHaveLength(
    1,
  );
});
it('lease ownership is checked even when the record revision is unchanged', async () => {
  const h = await staged(),
    original = h.engine.load.bind(h.engine);
  const sign = must(seller.authorize.getMockImplementation());
  let stolen = false;
  vi.spyOn(h.engine, 'load').mockImplementation(async (id) => {
    const job = await original(id);
    if (stolen && job.hosting.lease) job.hosting.lease.owner = 'another-owner';
    return job;
  });
  seller.authorize.mockImplementationOnce(async (text) => {
    const auth = await sign(text);
    stolen = true;
    return auth;
  });
  await expect(h.engine.next(h.q.fileId, h.input)).rejects.toMatchObject({ code: 'lease_busy' });
  expect(h.fetcher).not.toHaveBeenCalled();
});
it('a stale authenticated revision cannot proceed through an approval', async () => {
  const h = await staged(),
    sign = must(seller.authorize.getMockImplementation());
  const { encryptedSellStore } = await import('../pay/backup.js');
  const store = encryptedSellStore(h.raw, h.options.backupSecret);
  seller.authorize.mockImplementationOnce(async (text) => {
    const job = must(await store.load(`annon/sell/${h.q.fileId}`));
    await store.compareAndSet(`annon/sell/${h.q.fileId}`, job, {
      ...job,
      revision: job.revision + 1,
    });
    return sign(text);
  });
  await expect(h.engine.next(h.q.fileId, h.input)).rejects.toMatchObject({ code: 'lease_busy' });
  expect(h.fetcher).not.toHaveBeenCalled();
});

it.each(['near', 'solana'] as const)(
  'generic sell refuses Base terms for a %s seller before creating a split',
  async (kind) => {
    const h = harness();
    vi.spyOn(rpc, 'getConfig').mockResolvedValue({
      network: fixture.network,
      nearUsdc: fixture.near.token,
      usdc: must(fixture.base).usdc,
    } as never);
    const { Annon } = await import('./annon.js');
    const sdk = new Annon(h.options),
      sendTransaction = vi.fn();
    const nonEvm = {
      identity: { kind, id: kind === 'near' ? 'seller.synthetic.near' : '08'.repeat(32) },
      authorize: vi.fn(async () => undefined),
    };
    await expect(
      sdk.sell({
        data: h.input.data,
        name: h.input.name,
        mime: h.input.mime,
        seller: nonEvm,
        near: {
          price: '100000',
          recipients: [{ identity: seller.identity, bps: 10000 }],
          remainder: seller.identity,
        },
        base: { price: '100000', sendTransaction },
        publish: async () => {},
      }),
    ).rejects.toMatchObject({ code: 'route_unavailable' });
    expect(sendTransaction).not.toHaveBeenCalled();
  },
);
it('returns the final persisted revision after releasing the operation lease', async () => {
  const h = await staged();
  const returned = await h.engine.next(h.q.fileId, h.input);
  expect(returned).toEqual(await h.engine.load(h.q.fileId));
  expect(returned.hosting?.lease).toBeNull();
});

it('SellOptions.hosting uses the hosted sequence and keeps the post-registration publish callback', async () => {
  const h = await staged();
  const { Annon } = await import('./annon.js');
  const sdk = new Annon(h.options);
  vi.spyOn(sdk.hosted, 'quote').mockResolvedValue(h.q);
  vi.spyOn(sdk.hosted, 'begin').mockResolvedValue(h.job);
  vi.spyOn(sdk.hosted, 'load').mockImplementation(h.engine.load.bind(h.engine));
  vi.spyOn(sdk.hosted, 'next').mockImplementation(h.engine.next.bind(h.engine));
  vi.spyOn(sdk.hosted, 'backup').mockImplementation(h.engine.backup.bind(h.engine));
  vi.spyOn(sdk.hosted, 'confirmBackup').mockImplementation(h.engine.confirmBackup.bind(h.engine));
  const sendTransaction = vi.fn(),
    publish = vi.fn(async ({ file, header }: { file: Uint8Array; header: Uint8Array }) => {
      expect((await h.engine.load(h.q.fileId)).published).toBe(true);
      expect(file).toBeInstanceOf(Uint8Array);
      expect(file.subarray(0, header.length)).toEqual(header);
      const { open } = await import('../envelope/pay2.js');
      const opened = await open(file, {
        contractId: fixture.contract,
        listing: {
          fileId: h.q.fileId,
          cipherHash: h.job.terms.cipher_hash,
          seller: h.job.terms.seller,
        },
        ckdSecret: async () => new Uint8Array(48).fill(7),
      });
      expect(opened.data).toEqual(h.input.data);
    });
  const options = {
    data: h.input.data as Uint8Array,
    name: h.input.name,
    mime: h.input.mime,
    seller: h.input.seller,
    near: {
      price: h.input.price,
      recipients: [{ identity: h.input.seller.identity, bps: 10000 }],
      remainder: h.input.seller.identity,
    },
    base: { price: h.input.price, sendTransaction },
    hosting: { ...h.input.hosting, confirmBackup: async () => {} },
    publish,
  };
  const output = await sdk.sell(options);
  expect(output.terms).toEqual(h.job.terms);
  expect(sendTransaction).not.toHaveBeenCalled();
  expect(publish).toHaveBeenCalledTimes(1);
});

it.each([-1n, 2n ** 128n])('rejects an out-of-range approved funding amount %s', async (amount) => {
  const h = harness();
  await expect(
    h.engine.quote({
      ...h.input,
      seller: {
        identity: { kind: 'near', id: 'seller.synthetic.near' },
        authorize: vi.fn(async () => undefined),
      },
      listingStorage: amount,
      storageBudget: 1n,
    }),
  ).rejects.toMatchObject({ code: 'invalid_arguments' });
});
it('rejects self-funding options on a sponsored wallet and deployment substitution', async () => {
  const h = harness();
  await expect(h.engine.quote({ ...h.input, storageBudget: 1n })).rejects.toMatchObject({
    code: 'near_wallet_required',
  });
  h.options.network = 'near:testnet';
  await expect(h.engine.quote(h.input)).rejects.toMatchObject({ code: 'network_mismatch' });
});
it('rejects non-EVM recipients for a hosted EVM Base split before any effect', async () => {
  const h = harness();
  const identity = { kind: 'near' as const, id: 'seller.synthetic.near' };
  await expect(
    h.engine.quote({
      ...h.input,
      near: { recipients: [{ identity, bps: 10000 }], remainder: identity },
    }),
  ).rejects.toMatchObject({ code: 'bad_requirements' });
  expect(h.send).not.toHaveBeenCalled();
});
it('CAS failures cannot manufacture a durable sale or erase one', async () => {
  const h = harness(),
    q = await h.engine.quote(h.input);
  const write = vi.spyOn(h.raw, 'compareAndSet').mockResolvedValueOnce(false);
  await expect(h.engine.begin(q.quoteId)).rejects.toMatchObject({ code: 'store_conflict' });
  expect(h.writeBackup).not.toHaveBeenCalled();
  const job = await h.engine.begin(q.quoteId);
  write.mockResolvedValueOnce(false);
  await expect(h.engine.discard(job.terms.file_id)).rejects.toMatchObject({
    code: 'store_conflict',
  });
  expect(await h.engine.load(q.fileId)).not.toBeNull();
});
it('rollback cannot repeat an already allocated NEAR file budget', async () => {
  const h = await staged('near');
  for (let i = 0; i < 4; i++) await h.engine.next(h.q.fileId, h.input);
  const { encryptedSellStore } = await import('../pay/backup.js');
  const store = encryptedSellStore(h.raw, h.options.backupSecret),
    saved = must(await store.load(`annon/sell/${h.q.fileId}`));
  await store.compareAndSet(`annon/sell/${h.q.fileId}`, saved, {
    ...saved,
    revision: saved.revision + 1,
    hosting: { ...must(saved.hosting), completed: ['stage', 'deposit', 'register'], pending: null },
  });
  await h.engine.next(h.q.fileId, h.input);
  expect(
    h.nearCall.mock.calls.filter(([c]) => (c as { method: string }).method === 'fund_file_storage'),
  ).toHaveLength(1);
  expect((await h.engine.load(h.q.fileId)).hosting.completed).toContain('fund');
});

it('resumed sources enforce the plaintext cap before reading or signing', async () => {
  const h = await staged(),
    read = vi.fn(() => {
      throw new Error('oversize read');
    });
  const data = { size: 50_000_001, read };
  await expect(h.engine.verifySource(h.q.fileId, data)).rejects.toMatchObject({
    code: 'too_large',
  });
  await expect(h.engine.next(h.q.fileId, { ...h.input, data })).rejects.toMatchObject({
    code: 'too_large',
  });
  expect(read).not.toHaveBeenCalled();
  expect(seller.authorize).not.toHaveBeenCalled();
});
it('completed share resume still validates the supplied plaintext size', async () => {
  const h = await staged();
  for (let i = 0; i < 4; i++) await h.engine.next(h.q.fileId, h.input);
  const { Annon } = await import('./annon.js');
  const sdk = new Annon(h.options);
  vi.spyOn(sdk.hosted, 'load').mockImplementation(h.engine.load.bind(h.engine));
  await expect(
    sdk.resumeShare({
      fileId: h.q.fileId,
      ...h.input,
      data: {
        size: 50_000_001,
        read: () => {
          throw new Error('read');
        },
      },
    }),
  ).rejects.toMatchObject({ code: 'too_large' });
});

it('validates saved Base provenance, upload authorization and reservation bindings', async () => {
  const h = await staged(),
    { exportSell } = await import('../pay/backup.js');
  const provenance = structuredClone(h.job);
  must(provenance.baseSplit).address = `0x${'11'.repeat(20)}`;
  await expect(exportSell(provenance, h.options.backupSecret)).rejects.toMatchObject({
    code: 'invalid_record',
  });
  const auth = structuredClone(h.job);
  must(auth.hosting).authorization = {
    intent: { ...must(auth.hosting).intent, expiresAt: now + 599 },
    auth: { kind: 'evm', sig: `0x${'00'.repeat(65)}` },
  };
  await expect(exportSell(auth, h.options.backupSecret)).rejects.toMatchObject({
    code: 'invalid_record',
  });
  for (const field of ['fileId', 'uploadId'] as const) {
    const reserved = structuredClone(h.job);
    must(reserved.hosting).uploadId = 'aa'.repeat(32);
    must(reserved.hosting).reservation = {
      ...h.reservation,
      [field]: field === 'fileId' ? `0x${'11'.repeat(32)}` : 'bb'.repeat(32),
    } as never;
    await expect(exportSell(reserved, h.options.backupSecret)).rejects.toMatchObject({
      code: 'invalid_record',
    });
  }
});
it('validates approved NEAR listing funding in saved records', async () => {
  const h = await staged('near'),
    { exportSell } = await import('../pay/backup.js');
  const changed = structuredClone(h.job);
  must(changed.hosting).listingStorage = null;
  await expect(exportSell(changed, h.options.backupSecret)).rejects.toMatchObject({
    code: 'invalid_record',
  });
});
it('completed split progress requires a ready split checkpoint and confirmed backup', async () => {
  const h = await staged(),
    { exportSell } = await import('../pay/backup.js');
  for (let i = 0; i < 2; i++) await h.engine.next(h.q.fileId, h.input);
  const split = await h.engine.load(h.q.fileId);
  must(split.hosting.split).state = 'pending';
  await expect(exportSell(split, h.options.backupSecret)).rejects.toMatchObject({
    code: 'invalid_record',
  });
  must(split.hosting.split).state = 'ready';
  split.hosting.backupConfirmed = false;
  await expect(exportSell(split, h.options.backupSecret)).rejects.toMatchObject({
    code: 'invalid_record',
  });
});
it('only a checked publication result can accompany a completed record', async () => {
  const h = await staged(),
    { exportSell } = await import('../pay/backup.js');
  for (let i = 0; i < 4; i++) await h.engine.next(h.q.fileId, h.input);
  const done = await h.engine.load(h.q.fileId);
  for (const [field, value] of [
    ['fileId', `0x${'11'.repeat(32)}`],
    ['url', 'https://other.example/file'],
    ['header', 'https://other.example/header'],
    ['expiresAt', -1],
  ] as const) {
    const changed = structuredClone(done);
    Object.assign(must(changed.hosting.result), { [field]: value });
    await expect(exportSell(changed, h.options.backupSecret)).rejects.toMatchObject({
      code: 'invalid_record',
    });
  }
  done.hosting.result = null;
  await expect(exportSell(done, h.options.backupSecret)).rejects.toMatchObject({
    code: 'invalid_record',
  });
});
it('refuses hosted publication lifetimes longer than seven days or null', async () => {
  for (const expiresAt of [now + 604801, null]) {
    const h = await staged();
    for (let i = 0; i < 3; i++) await h.engine.next(h.q.fileId, h.input);
    Object.assign(h.published, { expiresAt });
    await expect(h.engine.next(h.q.fileId, h.input)).rejects.toMatchObject({
      code: 'bad_response',
    });
    expect((await h.engine.load(h.q.fileId)).published).not.toBe(true);
  }
});
it.each([-1, 0.5, Number.NaN])(
  'rejects invalid replayable source size %s before reading',
  async (size) => {
    const h = harness(),
      read = vi.fn(() => {
        throw new Error('read');
      });
    await expect(h.engine.quote({ ...h.input, data: { size, read } })).rejects.toMatchObject({
      code: 'invalid_arguments',
    });
    expect(read).not.toHaveBeenCalled();
  },
);

it('share errors retain known transaction evidence through the public wrapper', async () => {
  const h = await staged(),
    { Annon } = await import('./annon.js');
  const { toPublicError } = await import('../errors.js');
  const sdk = new Annon(h.options);
  vi.spyOn(sdk.hosted, 'load').mockImplementation(h.engine.load.bind(h.engine));
  vi.spyOn(sdk.hosted, 'next').mockRejectedValueOnce(
    new TransactionUncertain('synthetic-share-transaction'),
  );
  const error = await sdk.resumeShare({ ...h.input, fileId: h.q.fileId }).catch((e) => e);
  expect(toPublicError(error)).toMatchObject({
    code: 'transaction_uncertain',
    fileId: h.q.fileId,
    txHash: 'synthetic-share-transaction',
    exitCode: 4,
  });
});

it('stores transaction evidence carried by a checked refusal without changing its code', async () => {
  const h = await staged();
  await h.engine.next(h.q.fileId, h.input);
  await h.engine.next(h.q.fileId, h.input);
  h.send.mockRejectedValueOnce(
    Object.assign(new AnnonError('storage_required'), { txHash: 'synthetic-refused-register' }),
  );
  await expect(h.engine.next(h.q.fileId, h.input)).rejects.toMatchObject({
    code: 'storage_required',
  });
  expect((await h.engine.load(h.q.fileId)).hosting.pending?.txHash).toBe(
    'synthetic-refused-register',
  );
});

it.each([false, true])(
  'renews a long upload lease and stops on renewal persistence failure: %s',
  async (failJournal) => {
    const h = await staged();
    let enter!: () => void, release!: () => void, renewed!: () => void;
    const inside = new Promise<void>((resolve) => {
        enter = resolve;
      }),
      paused = new Promise<void>((resolve) => {
        release = resolve;
      });
    const renewal = new Promise<void>((resolve) => {
      renewed = resolve;
    });
    const fetcher = must(h.fetcher.getMockImplementation());
    h.fetcher.mockImplementation(async (url, options) => {
      const answer = await fetcher(url, options);
      if (String(url).endsWith('/body')) {
        enter();
        await paused;
      }
      return answer;
    });
    const cas = h.raw.compareAndSet.bind(h.raw);
    let armed = false;
    vi.spyOn(h.raw, 'compareAndSet').mockImplementation(async (key, before, next) => {
      if (armed && key.endsWith('/stage')) {
        armed = false;
        if (failJournal) {
          renewed();
          return false;
        }
        const saved = await cas(key, before, next);
        renewed();
        return saved;
      }
      return cas(key, before, next);
    });
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const first = h.engine.next(h.q.fileId, h.input);
    void first.catch(() => {});
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      await inside;
      armed = true;
      h.setNow(now + 60);
      await vi.advanceTimersByTimeAsync(30000);
      const persisted = await Promise.race([
        renewal.then(() => true),
        new Promise<boolean>((resolve) => {
          deadline = setTimeout(() => resolve(false), 1000);
        }),
      ]);
      clearTimeout(deadline);
      expect(persisted).toBe(true);
      if (!failJournal) h.setNow(now + 121);
      release();
      if (failJournal) {
        await expect(first).rejects.toMatchObject({ code: 'lease_busy' });
        expect((await h.engine.load(h.q.fileId)).hosting.pending?.step).toBe('stage');
      } else {
        await first;
        expect((await h.engine.load(h.q.fileId)).hosting.completed).toEqual(['stage']);
      }
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      clearTimeout(deadline);
      release();
      await first.catch(() => {});
      vi.useRealTimers();
    }
  },
);

it.each([200, 202, 429])(
  'preserves typed split refusal and retry evidence through the SDK (HTTP %s)',
  async (status) => {
    const h = await staged();
    await h.engine.next(h.q.fileId, h.input);
    const original = must(h.fetcher.getMockImplementation());
    h.fetcher.mockImplementation(async (url, options) =>
      String(url).endsWith('/base-split')
        ? Response.json(
            { error: 'budget', retryAfterSeconds: 123, message: 'PRIVATE_UPSTREAM' },
            { status },
          )
        : original(url, options),
    );
    const { Annon } = await import('./annon.js');
    const sdk = new Annon(h.options);
    vi.spyOn(sdk.hosted, 'load').mockImplementation(h.engine.load.bind(h.engine));
    vi.spyOn(sdk.hosted, 'next').mockImplementation(h.engine.next.bind(h.engine));
    const error = await sdk.resumeShare({ ...h.input, fileId: h.q.fileId }).catch((error) => error);
    const { toPublicError } = await import('../errors.js');
    expect(toPublicError(error)).toMatchObject({
      code: 'budget',
      retryAfterSeconds: 123,
      exitCode: 4,
      fileId: h.q.fileId,
    });
    expect(JSON.stringify(toPublicError(error))).not.toContain('PRIVATE_UPSTREAM');
    expect((await h.engine.load(h.q.fileId)).hosting.completed).toEqual(['stage']);
    expect((await h.engine.load(h.q.fileId)).hosting.pending?.step).toBe('split');
    expect(h.send).not.toHaveBeenCalled();
  },
);
it.each([
  ['pending', 200],
  ['ready', 202],
] as const)(
  'refuses split state/status mismatch %s/%s before registration',
  async (state, status) => {
    const h = await staged();
    await h.engine.next(h.q.fileId, h.input);
    const original = must(h.fetcher.getMockImplementation());
    h.fetcher.mockImplementation(async (url, options) =>
      String(url).endsWith('/base-split')
        ? Response.json({ baseSplit: { ...h.split, state } }, { status })
        : original(url, options),
    );
    await expect(h.engine.next(h.q.fileId, h.input)).rejects.toMatchObject({
      code: 'operation_failed',
    });
    expect(h.send).not.toHaveBeenCalled();
    expect((await h.engine.load(h.q.fileId)).hosting.completed).toEqual(['stage']);
  },
);

it('retries a definitely refused registration after the budget wait without changing its terms', async () => {
  const h = await staged();
  await h.engine.next(h.q.fileId, h.input);
  await h.engine.next(h.q.fileId, h.input);
  h.send.mockRejectedValueOnce(Object.assign(new AnnonError('budget'), { retryAfterSeconds: 37 }));
  await expect(h.engine.next(h.q.fileId, h.input)).rejects.toMatchObject({
    code: 'budget',
    retryAfterSeconds: 37,
  });
  const refused = await h.engine.load(h.q.fileId);
  expect(refused.hosting.pending).toBeNull();
  expect(refused.hosting.completed).toEqual(['stage', 'split']);
  expect(refused.terms).toEqual(h.job.terms);
  await h.engine.next(h.q.fileId, h.input);
  expect((await h.engine.load(h.q.fileId)).hosting.completed).toEqual([
    'stage',
    'split',
    'register',
  ]);
  expect(h.send).toHaveBeenCalledTimes(2);
});
it('keeps registration evidence when a budget error has a submitted transaction hash', async () => {
  const h = await staged();
  await h.engine.next(h.q.fileId, h.input);
  await h.engine.next(h.q.fileId, h.input);
  h.send.mockRejectedValueOnce(
    Object.assign(new AnnonError('budget'), {
      txHash: 'synthetic-register',
      retryAfterSeconds: 37,
    }),
  );
  await expect(h.engine.next(h.q.fileId, h.input)).rejects.toMatchObject({ code: 'budget' });
  expect((await h.engine.load(h.q.fileId)).hosting.pending).toMatchObject({
    step: 'register',
    txHash: 'synthetic-register',
  });
  h.send.mockRejectedValueOnce(new TransactionUncertain('synthetic-register'));
  await expect(h.engine.next(h.q.fileId, h.input)).rejects.toMatchObject({
    code: 'transaction_uncertain',
  });
  expect(h.send).toHaveBeenCalledTimes(2);
});
it('keeps an older uncertain register pending even when its reconciliation returns a budget refusal', async () => {
  const h = await staged();
  await h.engine.next(h.q.fileId, h.input);
  await h.engine.next(h.q.fileId, h.input);
  h.send.mockRejectedValueOnce(new AnnonError('transport'));
  await expect(h.engine.next(h.q.fileId, h.input)).rejects.toMatchObject({ code: 'transport' });
  h.file.mockRejectedValueOnce(new AnnonError('budget'));
  await expect(h.engine.next(h.q.fileId, h.input)).rejects.toMatchObject({ code: 'budget' });
  expect((await h.engine.load(h.q.fileId)).hosting.pending).toMatchObject({ step: 'register' });
  expect(h.send).toHaveBeenCalledTimes(1);
});
it.each([
  [-1, undefined],
  [1.2, 2],
  [Number.POSITIVE_INFINITY, undefined],
  [0, 0],
])('validates seller retry evidence %s', async (hint, expected) => {
  const { SellError } = await import('./annon.js');
  const error = new SellError(fixture.file_id, {
    cause: Object.assign(new AnnonError('budget'), { retryAfterSeconds: hint }),
  });
  expect(error.retryAfterSeconds).toBe(expected);
});

it('retains registration uncertainty for an untyped exception carrying a budget-like field', async () => {
  const h = await staged();
  await h.engine.next(h.q.fileId, h.input);
  await h.engine.next(h.q.fileId, h.input);
  h.send.mockRejectedValueOnce(Object.assign(new Error('PRIVATE_UPSTREAM'), { code: 'budget' }));
  await expect(h.engine.next(h.q.fileId, h.input)).rejects.toThrow('PRIVATE_UPSTREAM');
  expect((await h.engine.load(h.q.fileId)).hosting.pending?.step).toBe('register');
});

it('PROBE-A resumes an upload signature interrupted by a closed tab after lease expiry', async () => {
  const h = await staged();
  let enter: () => void = () => {},
    release: () => void = () => {};
  const inside = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const paused = new Promise<void>((resolve) => {
    release = resolve;
  });
  const original = must(seller.authorize.getMockImplementation());
  seller.authorize.mockImplementationOnce(async (text) => {
    enter();
    await paused;
    return original(text);
  });
  const first = h.engine.next(h.q.fileId, h.input);
  void first.catch(() => {});
  try {
    await inside;
    h.setNow(now + 121);
    await h.engine.next(h.q.fileId, h.input);
    expect((await h.engine.load(h.q.fileId)).hosting.completed).toEqual(['stage']);
  } finally {
    release();
    await expect(first).rejects.toMatchObject({ code: 'lease_busy' });
  }
});
it('PROBE-B retries a rejected publication signature without stranding the sale', async () => {
  const h = await staged();
  for (let i = 0; i < 3; i++) await h.engine.next(h.q.fileId, h.input);
  seller.authorize.mockRejectedValueOnce(new AnnonError('rejected'));
  await expect(h.engine.next(h.q.fileId, h.input)).rejects.toMatchObject({ code: 'rejected' });
  expect((await h.engine.load(h.q.fileId)).hosting.header).toBeNull();
  await h.engine.next(h.q.fileId, h.input);
  expect((await h.engine.load(h.q.fileId)).hosting.result).toEqual(h.published);
});
it.each(['deposit', 'register', 'fund', 'publish'] as const)(
  'PROBE-C retries a definitely rejected NEAR %s transaction',
  async (step) => {
    const h = await staged('near');
    const steps = must(h.job.hosting).steps;
    for (let i = 0; i < steps.indexOf(step); i++) await h.engine.next(h.q.fileId, h.input);
    h.nearCall.mockRejectedValueOnce(new AnnonError('rejected'));
    await expect(h.engine.next(h.q.fileId, h.input)).rejects.toMatchObject({ code: 'rejected' });
    expect((await h.engine.load(h.q.fileId)).hosting.pending).toBeNull();
    expect(await h.raw.load(`annon/share-operation/${h.q.fileId}/${step}`)).toBeNull();
    await h.engine.next(h.q.fileId, h.input);
    expect((await h.engine.load(h.q.fileId)).hosting.completed).toContain(step);
    await h.engine.discard(h.q.fileId);
  },
);
it.each([
  'limited',
  'rate_limited',
  'not_sponsored',
  'bad_request',
  'bad_signature',
  'bad_deadline',
  'upload_expired',
] as const)(
  'PROBE-D retries the definite relayer refusal %s with its retry hint intact',
  async (code) => {
    const h = await staged('solana');
    await h.engine.next(h.q.fileId, h.input);
    h.send.mockRejectedValueOnce(Object.assign(new AnnonError(code), { retryAfterSeconds: 37 }));
    await expect(h.engine.next(h.q.fileId, h.input)).rejects.toMatchObject({
      code,
      retryAfterSeconds: 37,
    });
    expect((await h.engine.load(h.q.fileId)).hosting.pending).toBeNull();
    expect(await h.raw.load(`annon/share-operation/${h.q.fileId}/register`)).toBeNull();
    await h.engine.next(h.q.fileId, h.input);
    expect((await h.engine.load(h.q.fileId)).hosting.completed).toContain('register');
    expect(h.send).toHaveBeenCalledTimes(2);
  },
);
it.each([undefined, 'synthetic-saved-register'])(
  'replays the identical saved register envelope after a lost response without another signature: %s',
  async (txHash) => {
    const h = await staged('solana');
    await h.engine.next(h.q.fileId, h.input);
    h.send.mockRejectedValueOnce(
      txHash ? new TransactionUncertain(txHash) : new AnnonError('transport'),
    );
    await expect(h.engine.next(h.q.fileId, h.input)).rejects.toMatchObject({
      code: txHash ? 'transaction_uncertain' : 'transport',
    });
    const envelope = structuredClone((must(h.send.mock.calls[0]) as unknown[])[1]);
    const signatures = vi.mocked(h.input.seller.authorize).mock.calls.length;
    h.setNow(now + 20);
    await h.engine.next(h.q.fileId, h.input);
    expect(h.send).toHaveBeenCalledTimes(2);
    expect((must(h.send.mock.calls[1]) as unknown[])[1]).toEqual(envelope);
    expect(vi.mocked(h.input.seller.authorize)).toHaveBeenCalledTimes(signatures);
    expect((await h.engine.load(h.q.fileId)).hosting.completed).toContain('register');
  },
);
it('clears an expired register only after its deadline and finality margin with no final file', async () => {
  const h = await staged('solana');
  await h.engine.next(h.q.fileId, h.input);
  h.send.mockRejectedValue(new AnnonError('transport'));
  await expect(h.engine.next(h.q.fileId, h.input)).rejects.toMatchObject({ code: 'transport' });
  h.setNow(now + 541);
  await expect(h.engine.next(h.q.fileId, h.input)).rejects.toMatchObject({ code: 'transport' });
  expect((await h.engine.load(h.q.fileId)).hosting.pending).not.toBeNull();
  h.setNow(now + 601);
  await h.engine.next(h.q.fileId, h.input);
  expect((await h.engine.load(h.q.fileId)).hosting.pending).toBeNull();
  expect(await h.raw.load(`annon/share-operation/${h.q.fileId}/register`)).toBeNull();
  expect(h.send).toHaveBeenCalledTimes(2);
});
it('discards a pending sale while retaining its backup and operation journal', async () => {
  const h = await staged('solana');
  await h.engine.next(h.q.fileId, h.input);
  h.send.mockRejectedValueOnce(new TransactionUncertain('synthetic-register'));
  await expect(h.engine.next(h.q.fileId, h.input)).rejects.toMatchObject({
    code: 'transaction_uncertain',
  });
  const journal = await h.raw.load(`annon/share-operation/${h.q.fileId}/register`);
  const backups = [...h.backups];
  await h.engine.discard(h.q.fileId);
  expect(await h.raw.load(`annon/sell/${h.q.fileId}`)).toBeNull();
  expect(await h.raw.load(`annon/share-operation/${h.q.fileId}/register`)).toEqual(journal);
  expect(h.backups).toEqual(backups);
});
it.each(['reserved', 'receiving'] as const)(
  'M9 refuses a Solana register with an expired or %s reservation',
  async (state) => {
    const h = await staged('solana');
    await h.engine.next(h.q.fileId, h.input);
    h.reservation.expiresAt = now;
    h.reservation.issuedAt = now - 600;
    h.setStatus(
      state === 'reserved'
        ? { uploadId: h.reservation.uploadId, state, reservation: h.reservation }
        : {
            uploadId: h.reservation.uploadId,
            state,
            expiresAt: now + 600,
            bodyUrl: `https://host.example/v1/uploads/${h.reservation.uploadId}/body`,
            headerUrl: `https://host.example/v1/uploads/${h.reservation.uploadId}/header`,
          },
    );
    await expect(h.engine.next(h.q.fileId, h.input)).rejects.toMatchObject({
      code: 'upload_expired',
    });
    expect(h.send).not.toHaveBeenCalled();
    expect(vi.mocked(h.input.seller.authorize)).toHaveBeenCalledTimes(1);
  },
);
it('M6 refuses mismatching final terms while reconciling a pending register', async () => {
  const h = await staged('solana');
  await h.engine.next(h.q.fileId, h.input);
  h.send.mockRejectedValueOnce(new AnnonError('transport'));
  await expect(h.engine.next(h.q.fileId, h.input)).rejects.toMatchObject({ code: 'transport' });
  h.file.mockResolvedValueOnce({ termsHash: `0x${'11'.repeat(32)}` } as never);
  await expect(h.engine.next(h.q.fileId, h.input)).rejects.toMatchObject({ code: 'file_mismatch' });
  expect((await h.engine.load(h.q.fileId)).hosting.completed).toEqual(['stage']);
  expect(h.send).toHaveBeenCalledTimes(1);
});
it('M13 refuses an EVM account switch between upload and register signatures', async () => {
  const h = await staged();
  await h.engine.next(h.q.fileId, h.input);
  await h.engine.next(h.q.fileId, h.input);
  const other = privateKeyToAccount(`0x${'43'.repeat(32)}`);
  seller.authorize.mockImplementationOnce(async (message) => ({
    kind: 'evm',
    sig: await other.signMessage({ message }),
  }));
  await expect(h.engine.next(h.q.fileId, h.input)).rejects.toMatchObject({
    code: 'invalid_signature',
  });
  expect(h.send).not.toHaveBeenCalled();
});
it.each(['near', 'solana'] as const)(
  'M15 refuses encrypted %s records with Base terms and provenance',
  async (kind) => {
    const h = await staged(kind);
    const evm = await harness().engine.quote(harness().input);
    const { encryptedSellStore } = await import('../pay/backup.js');
    const store = encryptedSellStore(h.raw, h.options.backupSecret);
    const saved = must(await store.load(`annon/sell/${h.q.fileId}`));
    const changed = structuredClone(saved);
    changed.revision++;
    changed.terms.base = evm.terms.base;
    changed.baseSplit = {
      address: must(evm.terms.base).pay_to,
      kind: 'push',
      salt: `0x${'00'.repeat(32)}`,
    };
    must(changed.hosting).intent.termsHash = termsHash(changed.terms);
    // Bypass the validator only to create an authenticated hostile storage fixture.
    const spy = vi
      .spyOn(await import('./sharing.js'), 'validateHostedRecord')
      .mockImplementationOnce(() => {});
    try {
      await store.compareAndSet(`annon/sell/${h.q.fileId}`, saved, changed);
    } finally {
      spy.mockRestore();
    }
    await expect(h.engine.load(h.q.fileId)).rejects.toMatchObject({ code: 'invalid_record' });
    expect(vi.mocked(h.input.seller.authorize)).not.toHaveBeenCalled();
  },
);

it('retries NEAR publication when a saved header has no submitted hash and is absent on chain', async () => {
  const h = await staged('near');
  for (let i = 0; i < 4; i++) await h.engine.next(h.q.fileId, h.input);
  h.nearCall.mockRejectedValueOnce(new AnnonError('transport'));
  await expect(h.engine.next(h.q.fileId, h.input)).rejects.toMatchObject({ code: 'transport' });
  expect((await h.engine.load(h.q.fileId)).hosting.header).not.toBeNull();
  await h.engine.next(h.q.fileId, h.input);
  expect((await h.engine.load(h.q.fileId)).hosting.pending).toBeNull();
  await h.engine.next(h.q.fileId, h.input);
  expect((await h.engine.load(h.q.fileId)).hosting.result).toEqual(h.published);
});

it('PROBE-F persists the sent deposit hash after the NEAR wallet changes account', async () => {
  const h = await staged('near');
  await h.engine.next(h.q.fileId, h.input);
  const { browserNearWallet } = await import('../browser/wallets.js');
  let sent = false;
  h.input.seller = browserNearWallet(
    {
      getAccounts: async () => [
        { accountId: sent ? 'other.synthetic.near' : 'seller.synthetic.near' },
      ],
      signAndSendTransaction: async () => {
        sent = true;
        return { transaction: { hash: 'synthetic-deposit', signer_id: 'seller.synthetic.near' } };
      },
    },
    'seller.synthetic.near',
  );
  await expect(h.engine.next(h.q.fileId, h.input)).rejects.toMatchObject({
    code: 'transaction_uncertain',
    txHash: 'synthetic-deposit',
  });
  expect((await h.engine.load(h.q.fileId)).hosting.pending?.txHash).toBe('synthetic-deposit');
  vi.spyOn(rpc, 'txOutcome').mockResolvedValue({
    state: 'done',
    method: 'storage_deposit',
    value: null,
    events: [],
  });
  await h.engine.next(h.q.fileId, h.input);
  expect((await h.engine.load(h.q.fileId)).hosting.completed).toEqual(['stage', 'deposit']);
});
it('keeps a returned NEAR transaction hash when its outcome is still pending', async () => {
  const h = await staged('near');
  await h.engine.next(h.q.fileId, h.input);
  h.nearCall.mockResolvedValueOnce({
    transaction: { hash: 'synthetic-pending-deposit', signer_id: 'seller.synthetic.near' },
  });
  vi.spyOn(rpc, 'readOutcome').mockReturnValueOnce({
    state: 'pending',
    method: 'storage_deposit',
    events: [],
  });
  await expect(h.engine.next(h.q.fileId, h.input)).rejects.toMatchObject({
    code: 'transaction_uncertain',
    txHash: 'synthetic-pending-deposit',
  });
  expect((await h.engine.load(h.q.fileId)).hosting.pending?.txHash).toBe(
    'synthetic-pending-deposit',
  );
});

it('retains pending evidence for a typed registration failure without a definite admission refusal', async () => {
  const h = await staged('solana');
  await h.engine.next(h.q.fileId, h.input);
  h.send.mockRejectedValueOnce(new AnnonError('unavailable'));
  await expect(h.engine.next(h.q.fileId, h.input)).rejects.toMatchObject({ code: 'unavailable' });
  expect((await h.engine.load(h.q.fileId)).hosting.pending?.auth).toBeDefined();
});

it('resumes an interrupted publication signature with no saved header', async () => {
  const h = await staged();
  for (let i = 0; i < 3; i++) await h.engine.next(h.q.fileId, h.input);
  seller.authorize.mockRejectedValueOnce(new AnnonError('wallet_error'));
  await expect(h.engine.next(h.q.fileId, h.input)).rejects.toMatchObject({ code: 'wallet_error' });
  const interrupted = await h.engine.load(h.q.fileId);
  expect(interrupted.hosting.pending?.step).toBe('publish');
  expect(interrupted.hosting.header).toBeNull();
  await h.engine.next(h.q.fileId, h.input);
  expect((await h.engine.load(h.q.fileId)).hosting.result).toEqual(h.published);
  expect(h.send).toHaveBeenCalledTimes(1);
});

it.each(['deposit', 'fund'] as const)(
  'PROBE-J reconciles a hashless NEAR %s by its saved balance or validity bound',
  async (step) => {
    const h = await staged('near');
    const index = must(h.job.hosting).steps.indexOf(step);
    for (let i = 0; i < index; i++) await h.engine.next(h.q.fileId, h.input);
    h.nearCall.mockRejectedValueOnce(new AnnonError('transport'));
    await expect(h.engine.next(h.q.fileId, h.input)).rejects.toMatchObject({ code: 'transport' });
    const pending = must((await h.engine.load(h.q.fileId)).hosting.pending);
    expect(pending).toMatchObject({ snapshot: '100', validUntil: now + 172800 });
    const calls = h.nearCall.mock.calls.length;
    await expect(h.engine.next(h.q.fileId, h.input)).rejects.toMatchObject({
      code: 'transaction_uncertain',
      retryAfterSeconds: 172800,
    });
    h.setNow(now + 172800);
    await expect(h.engine.next(h.q.fileId, h.input)).rejects.toMatchObject({
      code: 'transaction_uncertain',
      retryAfterSeconds: 1,
    });
    h.setNow(now + 172801);
    await h.engine.next(h.q.fileId, h.input);
    expect((await h.engine.load(h.q.fileId)).hosting.pending).toBeNull();
    expect((await h.engine.load(h.q.fileId)).hosting.completed).not.toContain(step);
    expect(await h.raw.load(`annon/share-operation/${h.q.fileId}/${step}`)).toBeNull();
    expect(h.nearCall).toHaveBeenCalledTimes(calls);
  },
);
it.each([
  ['deposit', 0],
  ['fund', 0],
  ['deposit', 172801],
  ['fund', 172801],
] as const)(
  'PROBE-J completes a hashless NEAR %s after the full approved balance rise at %s seconds',
  async (step, elapsed) => {
    const h = await staged('near');
    for (let i = 0; i < must(h.job.hosting).steps.indexOf(step); i++)
      await h.engine.next(h.q.fileId, h.input);
    h.nearCall.mockRejectedValueOnce(new AnnonError('transport'));
    await expect(h.engine.next(h.q.fileId, h.input)).rejects.toMatchObject({ code: 'transport' });
    h.setNow(now + elapsed);
    const amount = step === 'deposit' ? must(h.input.listingStorage) : must(h.input.storageBudget);
    const balance = async (n: bigint) => {
      vi.mocked(rpc.view).mockResolvedValue(n.toString());
      h.file.mockResolvedValue({ purchaseStorageBalance: n } as never);
    };
    if (elapsed === 0) {
      await balance(100n + amount - 1n);
      await expect(h.engine.next(h.q.fileId, h.input)).rejects.toMatchObject({
        code: 'transaction_uncertain',
      });
    }
    await balance(100n + amount);
    await h.engine.next(h.q.fileId, h.input);
    expect((await h.engine.load(h.q.fileId)).hosting.completed).toContain(step);
    expect(h.nearCall).toHaveBeenCalledTimes(step === 'deposit' ? 1 : 3);
  },
);
it.each(['signer', 'receiver', 'method', 'args', 'unreadable'] as const)(
  'R12 keeps an uncertain NEAR funding hash for a mismatched %s outcome',
  async (mismatch) => {
    const h = await staged('near');
    for (let i = 0; i < 3; i++) await h.engine.next(h.q.fileId, h.input);
    const args = { file_id: h.q.fileId };
    h.nearCall.mockResolvedValueOnce({
      transaction: {
        hash: 'synthetic-fund',
        signer_id: mismatch === 'signer' ? 'other.synthetic.near' : h.input.seller.identity.id,
        receiver_id: mismatch === 'receiver' ? 'other.synthetic.near' : fixture.contract,
        actions: [
          {
            FunctionCall: {
              method_name: mismatch === 'method' ? 'storage_deposit' : 'fund_file_storage',
              args: Buffer.from(JSON.stringify(mismatch === 'args' ? {} : args)).toString('base64'),
            },
          },
        ],
      },
      status: mismatch === 'unreadable' ? {} : { SuccessValue: '' },
    });
    await expect(h.engine.next(h.q.fileId, h.input)).rejects.toMatchObject({
      code: 'transaction_uncertain',
      txHash: 'synthetic-fund',
    });
    const saved = await h.engine.load(h.q.fileId);
    expect(saved.hosting.pending?.txHash).toBe('synthetic-fund');
    expect(saved.hosting.completed).not.toContain('fund');
  },
);
it.each(['deposit', 'fund', 'publish'] as const)(
  'PROBE-N keeps a pending NEAR %s hash and clears a final refusal',
  async (step) => {
    const h = await staged('near');
    for (let i = 0; i < must(h.job.hosting).steps.indexOf(step); i++)
      await h.engine.next(h.q.fileId, h.input);
    h.nearCall.mockRejectedValueOnce(new TransactionUncertain('synthetic-saved'));
    await expect(h.engine.next(h.q.fileId, h.input)).rejects.toMatchObject({
      code: 'transaction_uncertain',
    });
    const method =
      step === 'deposit'
        ? 'storage_deposit'
        : step === 'fund'
          ? 'fund_file_storage'
          : 'publish_header';
    const outcome = vi
      .spyOn(rpc, 'txOutcome')
      .mockResolvedValue({ state: 'pending', method, events: [] });
    await expect(h.engine.next(h.q.fileId, h.input)).rejects.toMatchObject({
      code: 'transaction_uncertain',
    });
    expect((await h.engine.load(h.q.fileId)).hosting.completed).not.toContain(step);
    expect((await h.engine.load(h.q.fileId)).hosting.pending?.txHash).toBe('synthetic-saved');
    outcome.mockResolvedValue({
      state: 'refused',
      method,
      events: [],
      reason: 'synthetic refusal',
    } as never);
    await h.engine.next(h.q.fileId, h.input);
    expect((await h.engine.load(h.q.fileId)).hosting.completed).not.toContain(step);
    expect((await h.engine.load(h.q.fileId)).hosting.pending).toBeNull();
    expect(await h.raw.load(`annon/share-operation/${h.q.fileId}/${step}`)).toBeNull();
  },
);
it('R10 preserves a rejected wallet error that carries sent transaction evidence', async () => {
  const h = await staged('near');
  await h.engine.next(h.q.fileId, h.input);
  h.nearCall.mockRejectedValueOnce(
    Object.assign(new AnnonError('rejected'), { txHash: 'synthetic-sent' }),
  );
  await expect(h.engine.next(h.q.fileId, h.input)).rejects.toMatchObject({ code: 'rejected' });
  expect((await h.engine.load(h.q.fileId)).hosting.pending).toMatchObject({
    step: 'deposit',
    txHash: 'synthetic-sent',
  });
  expect(await h.raw.load(`annon/share-operation/${h.q.fileId}/deposit`)).not.toBeNull();
});
it('R18 refuses discard while another tab is signing under a live lease', async () => {
  const h = await staged();
  let release: () => void = () => {},
    enter: () => void = () => {};
  const inside = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const pause = new Promise<void>((resolve) => {
    release = resolve;
  });
  seller.authorize.mockImplementationOnce(async () => {
    enter();
    await pause;
    throw new AnnonError('rejected');
  });
  const running = h.engine.next(h.q.fileId, h.input);
  void running.catch(() => {});
  try {
    await inside;
    await expect(h.engine.discard(h.q.fileId)).rejects.toMatchObject({ code: 'lease_busy' });
    expect((await h.engine.load(h.q.fileId)).hosting.pending?.step).toBe('stage');
  } finally {
    release();
    await expect(running).rejects.toMatchObject({ code: 'rejected' });
  }
});
it.each(['done', 'pending', 'mismatch'] as const)(
  'checks a redirect wallet hash against its saved operation: %s',
  async (state) => {
    const h = await staged('near');
    await h.engine.next(h.q.fileId, h.input);
    h.nearCall.mockRejectedValueOnce(new AnnonError('transport'));
    await expect(h.engine.next(h.q.fileId, h.input)).rejects.toMatchObject({ code: 'transport' });
    const check = vi.spyOn(rpc, 'txOutcome');
    if (state === 'mismatch') check.mockRejectedValue(new AnnonError('invalid_response'));
    else
      check.mockResolvedValue({
        state,
        method: 'storage_deposit',
        events: [],
        value: null,
      } as never);
    const resumed = h.engine.next(h.q.fileId, { ...h.input, txHash: 'synthetic-redirect' });
    if (state === 'done') await resumed;
    else
      await expect(resumed).rejects.toMatchObject({
        code: state === 'pending' ? 'transaction_uncertain' : 'invalid_response',
      });
    expect(check).toHaveBeenCalledWith(
      h.options.nearRpc,
      'synthetic-redirect',
      h.input.seller.identity.id,
      fixture.contract,
      'FINAL',
      { method: 'storage_deposit', args: { account_id: h.input.seller.identity.id } },
    );
    const saved = await h.engine.load(h.q.fileId);
    expect(saved.hosting.completed.includes('deposit')).toBe(state === 'done');
    if (state !== 'done')
      expect(saved.hosting.pending?.txHash).toBe(
        state === 'pending' ? 'synthetic-redirect' : undefined,
      );
    expect(h.nearCall).toHaveBeenCalledTimes(1);
  },
);
it.each([undefined, '-1', '01', (2n ** 128n).toString(), 'bad'])(
  'refuses a saved funding operation with an invalid balance snapshot %s',
  async (snapshot) => {
    const h = await staged('near');
    await h.engine.next(h.q.fileId, h.input);
    h.nearCall.mockRejectedValueOnce(new AnnonError('transport'));
    await expect(h.engine.next(h.q.fileId, h.input)).rejects.toMatchObject({ code: 'transport' });
    const { encryptedSellStore } = await import('../pay/backup.js');
    const store = encryptedSellStore(h.raw, h.options.backupSecret),
      key = `annon/sell/${h.q.fileId}`;
    const saved = must(await store.load(key)),
      changed = structuredClone(saved);
    changed.revision++;
    if (snapshot === undefined) delete must(must(changed.hosting).pending).snapshot;
    else must(must(changed.hosting).pending).snapshot = snapshot;
    const spy = vi
      .spyOn(await import('./sharing.js'), 'validateHostedRecord')
      .mockImplementationOnce(() => {});
    try {
      await store.compareAndSet(key, saved, changed);
    } finally {
      spy.mockRestore();
    }
    await expect(h.engine.load(h.q.fileId)).rejects.toMatchObject({ code: 'invalid_record' });
  },
);
it.each([undefined, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
  'refuses a saved funding operation with an invalid validity bound %s',
  async (validUntil) => {
    const h = await staged('near');
    await h.engine.next(h.q.fileId, h.input);
    h.nearCall.mockRejectedValueOnce(new AnnonError('transport'));
    await expect(h.engine.next(h.q.fileId, h.input)).rejects.toMatchObject({ code: 'transport' });
    const { encryptedSellStore } = await import('../pay/backup.js');
    const store = encryptedSellStore(h.raw, h.options.backupSecret),
      key = `annon/sell/${h.q.fileId}`;
    const saved = must(await store.load(key)),
      changed = structuredClone(saved);
    changed.revision++;
    if (validUntil === undefined) delete must(must(changed.hosting).pending).validUntil;
    else must(must(changed.hosting).pending).validUntil = validUntil;
    const spy = vi
      .spyOn(await import('./sharing.js'), 'validateHostedRecord')
      .mockImplementationOnce(() => {});
    try {
      await store.compareAndSet(key, saved, changed);
    } finally {
      spy.mockRestore();
    }
    await expect(h.engine.load(h.q.fileId)).rejects.toMatchObject({ code: 'invalid_record' });
  },
);
it.each(['deposit', 'fund'] as const)(
  'validates the final %s snapshot before opening the wallet',
  async (step) => {
    const h = await staged('near');
    for (let i = 0; i < must(h.job.hosting).steps.indexOf(step); i++)
      await h.engine.next(h.q.fileId, h.input);
    const calls = h.nearCall.mock.calls.length;
    if (step === 'deposit') vi.mocked(rpc.view).mockResolvedValue('-1');
    else h.file.mockResolvedValueOnce(null);
    await expect(h.engine.next(h.q.fileId, h.input)).rejects.toMatchObject({
      code: 'invalid_response',
    });
    expect(h.nearCall).toHaveBeenCalledTimes(calls);
    await h.engine.next(h.q.fileId, h.input);
    expect((await h.engine.load(h.q.fileId)).hosting.pending).toBeNull();
  },
);
it('a new seller snapshots an absent storage balance as zero before sending', async () => {
  const h = await staged('near');
  await h.engine.next(h.q.fileId, h.input);
  vi.mocked(rpc.view).mockResolvedValue(null);
  h.nearCall.mockImplementationOnce(async () => {
    expect((await h.engine.load(h.q.fileId)).hosting.pending).toMatchObject({
      snapshot: '0',
      validUntil: now + 172800,
    });
    expect(vi.mocked(rpc.view)).toHaveBeenCalledWith(
      h.options.nearRpc,
      fixture.contract,
      'storage_balance_of',
      { account_id: h.input.seller.identity.id },
    );
    throw new AnnonError('transport');
  });
  await expect(h.engine.next(h.q.fileId, h.input)).rejects.toMatchObject({ code: 'transport' });
});

it.each([null, '0', '100'])(
  'PROBE-O reconciles a first deposit only for an absent account (%s)',
  async (before) => {
    const h = await staged('near');
    await h.engine.next(h.q.fileId, h.input);
    vi.mocked(rpc.view).mockResolvedValue(before);
    h.nearCall.mockRejectedValueOnce(new AnnonError('transport'));
    await expect(h.engine.next(h.q.fileId, h.input)).rejects.toMatchObject({ code: 'transport' });
    expect((await h.engine.load(h.q.fileId)).hosting.pending).toMatchObject({
      storageAccountExisted: before !== null,
    });
    const calls = h.nearCall.mock.calls.length;
    for (const balance of [null, '0']) {
      vi.mocked(rpc.view).mockResolvedValue(balance);
      await expect(h.engine.next(h.q.fileId, h.input)).rejects.toMatchObject({
        code: 'transaction_uncertain',
      });
    }
    vi.mocked(rpc.view).mockResolvedValue((10n ** 22n - 10n ** 21n).toString());
    if (before === null) {
      await h.engine.next(h.q.fileId, h.input);
      expect((await h.engine.load(h.q.fileId)).hosting.completed).toContain('deposit');
      expect((await h.engine.load(h.q.fileId)).hosting.pending).toBeNull();
    } else {
      await expect(h.engine.next(h.q.fileId, h.input)).rejects.toMatchObject({
        code: 'transaction_uncertain',
      });
    }
    expect(h.nearCall).toHaveBeenCalledTimes(calls);
  },
);

it.each([undefined, null, 0, 'false'])(
  'refuses a saved funding operation with an invalid account existence snapshot %s',
  async (storageAccountExisted) => {
    const h = await staged('near');
    await h.engine.next(h.q.fileId, h.input);
    h.nearCall.mockRejectedValueOnce(new AnnonError('transport'));
    await expect(h.engine.next(h.q.fileId, h.input)).rejects.toMatchObject({ code: 'transport' });
    const { encryptedSellStore } = await import('../pay/backup.js');
    const store = encryptedSellStore(h.raw, h.options.backupSecret),
      key = `annon/sell/${h.q.fileId}`;
    const saved = must(await store.load(key)),
      changed = structuredClone(saved);
    changed.revision++;
    if (storageAccountExisted === undefined)
      delete must(must(changed.hosting).pending).storageAccountExisted;
    else Object.assign(must(must(changed.hosting).pending), { storageAccountExisted });
    const spy = vi
      .spyOn(await import('./sharing.js'), 'validateHostedRecord')
      .mockImplementationOnce(() => {});
    try {
      await store.compareAndSet(key, saved, changed);
    } finally {
      spy.mockRestore();
    }
    await expect(h.engine.load(h.q.fileId)).rejects.toMatchObject({ code: 'invalid_record' });
  },
);
