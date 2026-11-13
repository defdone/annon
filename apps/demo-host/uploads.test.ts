import { createPrivateKey, sign } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ed25519 } from '@noble/curves/ed25519.js';
import { privateKeyToAccount } from 'viem/accounts';
import { afterEach, expect, it, vi } from 'vitest';
import {
  metadataHash,
  type UploadRequest,
  uploadText,
} from '../../packages/annon/src/download/upload.ts';
import { prepareSeal } from '../../packages/annon/src/envelope/replay.ts';
import { nep413Hash } from '../../packages/annon/src/near/nep413.ts';
import type { FileInfo } from '../../packages/annon/src/near/rpc.ts';
import * as nearRpc from '../../packages/annon/src/near/rpc.ts';
import { createSplit, hostedSplitSalt } from '../../packages/annon/src/pay/split.ts';
import { verifyReservation } from '../../packages/annon/src/relay/reservation.ts';
import { hex } from '../../packages/annon/src/settle-near/codec.ts';
import {
  BASE_USDC,
  NEAR_USDC,
  type Terms,
  termsHash,
} from '../../packages/annon/src/settle-near/terms.ts';
import { hostCapacity } from './capacity.ts';
import { type Chain, facilitatorFor } from './facilitator.ts';
import { uploadService } from './uploads.ts';

const account = privateKeyToAccount(`0x${'01'.repeat(32)}`);
const seed = new Uint8Array(32).fill(7);
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function setup(
  options: {
    base?: boolean;
    sellerKind?: 'near' | 'solana';
    ingressPerDay?: number;
    idleSeconds?: number;
    stagingSeconds?: number;
    filesPerDay?: number;
    hostBytes?: number;
    concurrency?: number;
    filesPerIpDay?: number;
    listedPerSellerDay?: number;
    listed?: boolean;
    perSeller?: number;
    perIp?: number;
    size?: number;
    previewLen?: number;
    chunkLog2?: number;
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), 'host-uploads-'));
  roots.push(root);
  let now = 1_000_000;
  const capacity = await hostCapacity(join(root, 'capacity'), { now: () => now, ...options });
  const evm = { kind: 'evm' as const, id: account.address.toLowerCase() };
  const seller =
    options.sellerKind === 'near'
      ? { kind: 'near' as const, id: 'seller.synthetic.near' }
      : options.sellerKind === 'solana'
        ? {
            kind: 'solana' as const,
            id: hex(ed25519.getPublicKey(new Uint8Array(32).fill(8))).slice(2),
          }
        : evm;
  const seal = await prepareSeal(
    new Uint8Array(32).fill(3),
    new Uint8Array(options.size ?? 1024).fill(8),
    {
      fileId: new Uint8Array(32).fill(2),
      name: 'x.txt',
      mime: 'text/plain',
      version: 2,
      authKind: 0,
      chunkLog2: options.chunkLog2 ?? 22,
      previewLen: options.previewLen ?? 0,
    },
  );
  const terms: Terms = {
    network: 'near:mainnet',
    contract: 'market.synthetic.near',
    file_id: `0x${'02'.repeat(32)}`,
    seller,
    pay2_version: 2 as const,
    cipher_hash: hex(seal.cipherHash),
    moderator: null,
    near: {
      token: NEAR_USDC,
      price: '100000',
      recipients: [{ identity: evm, bps: 10000 }],
      remainder: 0,
    },
    base: null,
  };
  if (options.base)
    terms.base = {
      usdc: BASE_USDC,
      price: '100000',
      pay_to: createSplit(
        'push',
        {
          recipients: [evm.id],
          allocations: [10000n],
          totalAllocation: 10000n,
          distributionIncentive: 0,
        },
        hostedSplitSalt(),
      ).address,
    };
  const metadata = {
    filename: 'x.txt',
    title: '<b>Title</b>',
    description: '<script>alert(1)</script>',
  };
  const intent = {
    network: terms.network,
    contract: terms.contract,
    seller,
    fileId: terms.file_id,
    cipherHash: terms.cipher_hash,
    termsHash: termsHash(terms),
    byteSize:
      seal.headerSize(terms.contract) +
      (options.size ?? 1024) +
      seal.manifest.metaLen +
      16 * seal.manifest.n,
    plaintextSize: options.size ?? 1024,
    headerSize: seal.headerSize(terms.contract),
    hostOrigin: 'https://demo.annon.dev',
    metadataHash: await metadataHash(metadata),
    nonce: `0x${'06'.repeat(32)}`,
    expiresAt: 1600,
  };
  const auth = {
    kind: 'evm' as const,
    sig: await account.signMessage({ message: uploadText(intent) }),
  };
  const request: UploadRequest = { intent, terms, manifest: seal.manifest, metadata, auth };
  if (options.sellerKind) {
    const edKey = createPrivateKey({
      key: Buffer.concat([
        Buffer.from('302e020100300506032b657004220420', 'hex'),
        Buffer.alloc(32, 8),
      ]),
      format: 'der',
      type: 'pkcs8',
    });
    request.auth =
      options.sellerKind === 'solana'
        ? { kind: 'solana', sig: hex(sign(null, Buffer.from(uploadText(intent)), edKey)) }
        : {
            kind: 'near',
            accountId: seller.id,
            publicKey: (await import('../../specs/vectors/upload.json')).default.cases[2]?.request
              .auth.publicKey as string,
            signature: sign(
              null,
              nep413Hash({
                message: uploadText(intent),
                recipient: intent.hostOrigin,
                nonce: new Uint8Array(32).fill(6),
              }),
              edKey,
            ).toString('base64'),
          };
  }
  let info: FileInfo | null = null;
  let readFailed = false;
  const config = {
    dir: join(root, 'uploads'),
    capacity,
    network: terms.network,
    contract: terms.contract,
    hostOrigin: intent.hostOrigin,
    nearRpc: 'https://near.invalid',
    signingKey: seed,
    sellers: options.listed ? [`evm:${seller.id}`] : [],
    now: () => now,
    getFile: async () => {
      if (readFailed) throw new Error('private upstream');
      return info;
    },
  };
  const host = await uploadService(config);
  const signed = options.sellerKind
    ? { header: new Uint8Array() }
    : await seal.finish({
        seller,
        contractId: terms.contract,
        ckdSecret: new Uint8Array(48).fill(4),
        sign: (message) => account.signMessage({ message }),
      });
  const body = new Uint8Array(await new Response(seal.body()).arrayBuffer());
  const source = async function* (data = body) {
    const step = 7919;
    for (let at = 0; at < data.length; at += step) yield data.subarray(at, at + step);
  };
  return {
    root,
    capacity,
    host,
    config,
    request,
    body,
    source,
    header: signed.header,
    setNow: (value: number) => {
      now = value;
    },
    setInfo: (over: Partial<FileInfo> = {}) => {
      info = {
        terms,
        termsHash: intent.termsHash,
        seller,
        cipherHash: terms.cipher_hash,
        price: 100000n,
        purchaseStorageBalance: 0n,
        payTo: '',
        moderator: null,
        headerHash: null,
        salesStoppedAt: null,
        takenDown: null,
        ...over,
      };
    },
    failRead: () => {
      readFailed = true;
    },
    clearInfo: () => {
      info = null;
    },
  };
}
async function savedState(dir: string) {
  const name = (await readdir(dir)).find((name) => name.endsWith('.json'));
  if (!name) throw new Error('Missing state');
  const path = join(dir, name);
  const state = JSON.parse(await readFile(path, 'utf8')) as {
    uploads: { [id: string]: { state: string; reservation?: unknown; stagedAt?: number } };
  };
  return { path, state };
}
async function stage(f: Awaited<ReturnType<typeof setup>>) {
  const created = await f.host.create(f.request, 'ip');
  const uploadId = created.body.uploadId;
  const reserved = await f.host.body(uploadId, f.request, f.source());
  return { uploadId, reserved };
}
it('requires a verified body before issuing a relayer-compatible reservation and publishes only after final chain binding', async () => {
  const f = await setup();
  const created = await f.host.create(f.request, 'ip');
  const id = created.body.uploadId;
  expect(created.status).toBe(201);
  expect((await f.host.create(f.request, 'ip')).body.uploadId).toBe(id);
  await expect(f.host.reservation(id)).rejects.toMatchObject({ code: 'upload_incomplete' });
  expect(await f.host.files()).toEqual([]);
  const r = await f.host.body(id, f.request, f.source());
  expect(r.status).toBe(201);
  await expect(
    verifyReservation(r.body.reservation, f.request.terms, {
      hostOrigin: f.config.hostOrigin,
      publicKey: hex(ed25519.getPublicKey(seed)).slice(2),
      now: 1000,
      fetch: (async () => Response.json(await f.host.reservation(id))) as typeof fetch,
    }),
  ).resolves.toMatchObject({ uploadId: id });
  await expect(f.host.header(id, f.request, f.header)).rejects.toMatchObject({
    code: 'unknown_file',
  });
  f.setInfo({ termsHash: `0x${'01'.repeat(32)}` });
  await expect(f.host.header(id, f.request, f.header)).rejects.toMatchObject({
    code: 'file_invalid',
  });
  f.setInfo();
  const published = await f.host.header(id, f.request, f.header);
  expect(published.status).toBe(201);
  expect(published.body.url).toBe(`https://demo.annon.dev/f/${f.request.intent.fileId.slice(2)}`);
  expect((await f.host.header(id, f.request, f.header)).status).toBe(200);
  const files = await f.host.files();
  expect(files).toHaveLength(1);
  expect(await readFile(files[0]?.path ?? '')).toEqual(Buffer.concat([f.header, f.body]));
  f.setInfo({ salesStoppedAt: 1 });
  expect(await f.host.files()).toHaveLength(1);
});
it('persists reservations, ingress, publication and expiry tombstones through restart', async () => {
  const f = await setup();
  const { uploadId } = await stage(f);
  const second = await uploadService(f.config);
  expect(await second.reservation(uploadId)).toMatchObject({ state: 'reserved' });
  f.setNow(1_601_000);
  await expect(second.reservation(uploadId)).rejects.toMatchObject({ code: 'upload_expired' });
  const refreshed = structuredClone(f.request);
  refreshed.intent.expiresAt = 2200;
  refreshed.auth = {
    kind: 'evm',
    sig: await account.signMessage({ message: uploadText(refreshed.intent) }),
  };
  expect((await second.create(refreshed, 'different-ip')).body.uploadId).toBe(uploadId);
  expect((await second.status(uploadId, refreshed)).body).toMatchObject({
    state: 'reserved',
    reservation: { expiresAt: 2201 },
  });
  f.setInfo();
  await second.header(uploadId, refreshed, f.header);
  f.setNow(1_601_000 + 604800000);
  expect(await f.capacity.expired(f.request.intent.fileId)).toBe(true);
  await second.cleanup();
  expect(await second.files()).toEqual([]);
  expect(await (await uploadService(f.config)).files()).toEqual([]);
  await expect(second.status(uploadId, refreshed)).rejects.toMatchObject({
    code: 'upload_expired',
  });
});
it('enforces streaming length and hashes without Content-Length and charges failed ingress durably', async () => {
  const f = await setup({ ingressPerDay: 1700 });
  const id = (await f.host.create(f.request, 'ip')).body.uploadId;
  await expect(f.host.body(id, f.request, f.source(f.body.subarray(0, 100)))).rejects.toMatchObject(
    { code: 'upload_incomplete' },
  );
  const bad = f.body.slice();
  bad[100] = (bad[100] ?? 0) ^ 1;
  await expect(f.host.body(id, f.request, f.source(bad))).rejects.toMatchObject({
    code: 'cipher_hash_mismatch',
  });
  const again = await uploadService(f.config);
  await expect(again.body(id, f.request, f.source())).rejects.toMatchObject({
    code: 'host_capacity',
  });
  const g = await setup();
  const gid = (await g.host.create(g.request, 'ip')).body.uploadId;
  await expect(
    g.host.body(gid, g.request, g.source(new Uint8Array(g.body.length + 1))),
  ).rejects.toThrow();
  await expect(g.host.body(gid, g.request, g.source(), '1')).rejects.toMatchObject({
    code: 'too_large',
  });
  expect((await readdir(g.config.dir)).filter((x) => x.endsWith('.part'))).toEqual([]);
});
it('does not permit forged seller auth, cross-host replay, conflicting content or an unsigned refresh', async () => {
  const f = await setup();
  const id = (await f.host.create(f.request, 'ip')).body.uploadId;
  const bad = structuredClone(f.request);
  bad.intent.expiresAt--;
  await expect(f.host.body(id, bad, f.source())).rejects.toMatchObject({ code: 'bad_signature' });
  bad.intent.hostOrigin = 'https://other.example';
  await expect(f.host.create(bad, 'ip')).rejects.toThrow();
  await expect(
    f.host.status(id, {
      ...f.request,
      intent: { ...f.request.intent, nonce: `0x${'07'.repeat(32)}` },
    }),
  ).rejects.toThrow();
  const conflict = structuredClone(f.request);
  conflict.metadata.title = 'Other';
  conflict.intent.metadataHash = await metadataHash(conflict.metadata);
  conflict.auth = {
    kind: 'evm',
    sig: await account.signMessage({ message: uploadText(conflict.intent) }),
  };
  await expect(f.host.create(conflict, 'ip')).rejects.toMatchObject({ code: 'upload_conflict' });
});
it('refuses stopped and taken-down listings and tampered final headers', async () => {
  const f = await setup();
  const { uploadId } = await stage(f);
  f.setInfo({ salesStoppedAt: 1 });
  await expect(f.host.header(uploadId, f.request, f.header)).rejects.toMatchObject({
    code: 'sales_stopped',
  });
  f.setInfo({ takenDown: 'moderation' });
  await expect(f.host.header(uploadId, f.request, f.header)).rejects.toMatchObject({
    code: 'taken_down',
  });
  f.setInfo();
  const bad = f.header.slice();
  bad[100] = (bad[100] ?? 0) ^ 1;
  await expect(f.host.header(uploadId, f.request, bad)).rejects.toMatchObject({
    code: 'file_invalid',
  });
});
it('reserves simultaneous ingress, assembly space and open/listed quotas before any body is accepted', async () => {
  const f = await setup({ hostBytes: 3269 });
  await expect(f.host.create(f.request, 'ip')).rejects.toMatchObject({ code: 'host_capacity' });
  const g = await setup({ filesPerDay: 0 });
  await expect(g.host.create(g.request, 'ip')).rejects.toMatchObject({ code: 'rate_limited' });
  const h = await setup({ filesPerDay: 0, listed: true });
  expect((await h.host.create(h.request, 'ip')).status).toBe(201);
  const k = await setup({ filesPerDay: 0, listed: true, listedPerSellerDay: 0 });
  await expect(k.host.create(k.request, 'ip')).rejects.toMatchObject({ code: 'rate_limited' });
});
it('fails closed for missing staged bytes and corrupt upload state instead of recreating allowances', async () => {
  const f = await setup();
  const { uploadId } = await stage(f);
  await rm(join(f.config.dir, `${uploadId}.body`));
  await expect(uploadService(f.config)).rejects.toThrow();
  await writeFile(join(f.config.dir, 'uploads.json'), '{}');
  await expect(uploadService({ ...f.config, requireState: true })).rejects.toThrow();
});

it('serves the HTTP protocol with binary content types, safe filenames, chain catalog and CORS on failures', async () => {
  const { createServer, request: httpRequest } = await import('node:http');
  const { handler } = await import('./server.ts');
  const { memoryStore } = await import('../../packages/annon/src/pay/store.ts');
  const { encodeUploadAuthorization } = await import('../../packages/annon/src/download/upload.ts');
  const f = await setup();
  f.setInfo();
  const server = createServer(
    handler(
      {
        contractId: f.config.contract,
        nearRpc: f.config.nearRpc,
        baseRpc: 'https://base.invalid',
        publicUrl: f.config.hostOrigin,
        files: [],
        capacity: f.capacity,
        uploads: f.host,
        getFile: f.config.getFile,
        store: memoryStore(),
        perIpMinute: 600,
        paymentsPerClientMinute: 60,
      },
      async (_req, options) => ({
        status: 200,
        headers: { 'Content-Type': 'application/octet-stream' },
        body: options.file.read(0),
      }),
    ),
  );
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No address');
  const base = `http://127.0.0.1:${address.port}`;
  const control = { 'Content-Type': 'application/json', Origin: 'https://annon.dev' };
  try {
    const oversized = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(
        `${base}/v1/uploads`,
        { method: 'POST', headers: control },
        (response) => {
          response.resume();
          response.on('end', () => {
            resolve(response.statusCode ?? 0);
            req.end();
          });
        },
      );
      req.on('error', reject);
      req.setTimeout(3000, () => req.destroy(new Error('No rejection response')));
      req.write('x'.repeat(131073));
    });
    expect(oversized).toBe(413);
    const created = await fetch(`${base}/v1/uploads`, {
      method: 'POST',
      headers: control,
      body: JSON.stringify(f.request),
    });
    expect(created.status).toBe(201);
    const { uploadId } = await created.json();
    const authorization = encodeUploadAuthorization(f.request);
    const status = await fetch(`${base}/v1/uploads/${uploadId}`, {
      headers: { 'Annon-Upload-Authorization': authorization },
    });
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({ uploadId, state: 'receiving' });
    expect((await fetch(`${base}/v1/uploads/${uploadId}`)).status).toBe(403);
    const headers = {
      ...control,
      'Content-Type': 'application/octet-stream',
      'Annon-Upload-Authorization': authorization,
    };
    const wrong = await fetch(`${base}/v1/uploads/${uploadId}/body`, {
      method: 'PUT',
      headers: control,
      body: 'x',
    });
    expect(wrong.status).toBe(415);
    expect(wrong.headers.get('Access-Control-Allow-Origin')).toBe('https://annon.dev');
    const badBody = f.body.slice();
    badBody[100] = (badBody[100] ?? 0) ^ 1;
    const invalid = await fetch(`${base}/v1/uploads/${uploadId}/body`, {
      method: 'PUT',
      headers,
      body: badBody,
    });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({
      error: 'cipher_hash_mismatch',
      message: expect.any(String),
    });
    const reserved = await fetch(`${base}/v1/uploads/${uploadId}/body`, {
      method: 'PUT',
      headers,
      body: f.body,
    });
    expect(reserved.status).toBe(201);
    expect((await fetch(`${base}/v1/upload-reservations/${uploadId}`)).status).toBe(200);
    const saved = await savedState(f.config.dir);
    const record = saved.state.uploads[uploadId];
    if (!record) throw new Error('Missing fixture');
    record.state = 'publishing';
    await writeFile(saved.path, JSON.stringify(saved.state));
    const half = await fetch(`${base}/v1/upload-reservations/${uploadId}`);
    expect(half.status).toBe(400);
    expect(await half.json()).toMatchObject({ error: 'upload_incomplete' });
    record.state = 'reserved';
    await writeFile(saved.path, JSON.stringify(saved.state));
    const published = await fetch(`${base}/v1/uploads/${uploadId}/header`, {
      method: 'PUT',
      headers,
      body: f.header,
    });
    expect(published.status).toBe(201);
    const unavailableReservation = await fetch(`${base}/v1/upload-reservations/${uploadId}`);
    expect(unavailableReservation.status).toBe(400);
    expect(await unavailableReservation.json()).toMatchObject({ error: 'upload_incomplete' });
    const catalog = await (await fetch(`${base}/files.json`)).json();
    expect(catalog).toHaveLength(1);
    expect(catalog[0]).toMatchObject({
      terms: f.request.terms,
      termsHash: f.request.intent.termsHash,
      byteSize: 1635,
      plaintextSize: 1024,
      createdAt: 1000,
      expiresAt: 605800,
    });
    expect(Object.keys(catalog[0]).sort()).toEqual(
      [
        'name',
        'fileId',
        'title',
        'description',
        'url',
        'header',
        'byteSize',
        'plaintextSize',
        'createdAt',
        'expiresAt',
        'termsHash',
        'terms',
        'salesStopped',
        'takenDown',
      ].sort(),
    );
    const html = await (await fetch(base)).text();
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>');
    const file = await fetch(`${base}/f/${f.request.intent.fileId.slice(2)}`);
    expect(file.status).toBe(200);
    expect(file.headers.get('Content-Disposition')).toBe("attachment; filename*=UTF-8''x.txt");
    await file.arrayBuffer();
    f.setInfo({ salesStoppedAt: 1 });
    expect(await (await fetch(`${base}/files.json`)).json()).toEqual([]);
    f.setInfo({ takenDown: 'moderation' });
    expect(await (await fetch(`${base}/files.json`)).json()).toEqual([]);
    f.clearInfo();
    expect(await (await fetch(`${base}/files.json`)).json()).toEqual([]);
    f.failRead();
    const unavailable = await fetch(`${base}/files.json`);
    expect(unavailable.status).toBe(503);
    expect(await unavailable.text()).not.toContain('private');
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

it('reconciles body verification and publication crashes without another quota reservation or TTL extension', async () => {
  const f = await setup();
  const { uploadId } = await stage(f);
  const { state: old, path: statePath } = await savedState(f.config.dir);
  const record = old.uploads[uploadId];
  if (!record) throw new Error('Missing record');
  record.state = 'receiving';
  delete record.reservation;
  delete record.stagedAt;
  await writeFile(statePath, JSON.stringify(old));
  const recovered = await uploadService(f.config);
  expect(await recovered.reservation(uploadId)).toMatchObject({
    state: 'reserved',
    expiresAt: 1600,
  });
  f.setInfo();
  await recovered.header(uploadId, f.request, f.header);
  const first = (await recovered.status(uploadId, f.request)).body;
  const { state: saved } = await savedState(f.config.dir);
  const publishing = saved.uploads[uploadId];
  if (!publishing) throw new Error('Missing record');
  publishing.state = 'publishing';
  await writeFile(join(f.config.dir, `${uploadId}.body`), f.body);
  await writeFile(statePath, JSON.stringify(saved));
  f.setNow(1_100_000);
  const next = await uploadService(f.config);
  await next.cleanup();
  expect((await next.status(uploadId, f.request)).body).toEqual(first);
});
it('refuses corrupted published headers, broken state and missing initialized upload state', async () => {
  const f = await setup();
  const { uploadId } = await stage(f);
  f.setInfo();
  await f.host.header(uploadId, f.request, f.header);
  const bad = Buffer.concat([f.header, f.body]);
  bad[100] = (bad[100] ?? 0) ^ 1;
  await writeFile(join(f.config.dir, `${uploadId}.pay2`), bad);
  await expect(uploadService(f.config)).rejects.toMatchObject({ reason: 'state_invalid' });
  const g = await setup();
  const { state, path: statePath } = await savedState(g.config.dir);
  await writeFile(statePath, JSON.stringify({ ...state, uploads: null }));
  await expect(uploadService(g.config)).rejects.toMatchObject({ reason: 'state_invalid' });
  const h = await setup();
  for (const name of await readdir(h.config.dir))
    if (name.endsWith('.json')) await rm(join(h.config.dir, name));
  await expect(uploadService({ ...h.config, requireState: true })).rejects.toMatchObject({
    reason: 'state_missing',
  });
});
it('does not extend the 24-hour staging lifetime when a reservation is refreshed', async () => {
  const f = await setup();
  const { uploadId } = await stage(f);
  const refresh = async (time: number) => {
    f.setNow(time);
    const request = structuredClone(f.request);
    request.intent.expiresAt = Math.floor(time / 1000) + 600;
    request.auth = {
      kind: 'evm',
      sig: await account.signMessage({ message: uploadText(request.intent) }),
    };
    await f.host.create(request, 'ip');
    return request;
  };
  await refresh(1_000_000 + 86399000);
  f.setNow(1_000_000 + 86400000);
  await f.host.cleanup();
  await expect(f.host.reservation(uploadId)).rejects.toMatchObject({ code: 'upload_expired' });
  const fresh = await refresh(1_000_000 + 86401000);
  expect((await f.host.body(uploadId, fresh, f.source())).status).toBe(201);
});
it('releases a failed stream slot and preserves the original verified body after a bad retry', async () => {
  const f = await setup();
  const { uploadId } = await stage(f);
  const bad = f.body.slice();
  bad[100] = (bad[100] ?? 0) ^ 1;
  await expect(f.host.body(uploadId, f.request, f.source(bad))).rejects.toMatchObject({
    code: 'cipher_hash_mismatch',
  });
  expect((await f.host.body(uploadId, f.request, f.source())).status).toBe(200);
  f.setInfo();
  expect((await f.host.header(uploadId, f.request, f.header)).status).toBe(201);
});

it('verifies preview and multiple data chunk boundaries without buffering the complete body', async () => {
  const f = await setup({ size: 196613, previewLen: 10, chunkLog2: 16 });
  const { uploadId } = await stage(f);
  f.setInfo();
  expect(f.request.manifest.n).toBe(5);
  expect((await f.host.header(uploadId, f.request, f.header)).status).toBe(201);
});

it('requires a finalized published header hash for a NEAR seller after NEP-413 authorization', async () => {
  const { vi } = await import('vitest');
  const vectors = (await import('../../specs/vectors/upload.json')).default;
  const { parseUpload } = await import('../../packages/annon/src/download/upload.ts');
  const { sha256 } = await import('../../packages/annon/src/envelope/pay2.ts');
  const request = parseUpload(vectors.cases[2]?.request);
  const f = await setup();
  f.setNow(1794528000000);
  let headerHash: string | null = null;
  const getFile = async () =>
    ({
      terms: request.terms,
      termsHash: request.intent.termsHash,
      takenDown: null,
      salesStoppedAt: null,
      headerHash,
    }) as FileInfo;
  const host = await uploadService({ ...f.config, getFile });
  vi.stubGlobal('fetch', async (_url: unknown, init: RequestInit) =>
    Response.json({
      jsonrpc: '2.0',
      id: JSON.parse(init.body as string).id,
      result: { permission: 'FullAccess' },
    }),
  );
  try {
    const id = (await host.create(request, 'ip')).body.uploadId;
    await host.body(id, request, f.source(Buffer.from(vectors.bodyHex, 'hex')));
    const seal = await prepareSeal(new Uint8Array(32).fill(3), new Uint8Array(1024).fill(8), {
      fileId: new Uint8Array(32).fill(2),
      name: 'file.txt',
      mime: 'text/plain',
      version: 2,
      authKind: 2,
      chunkLog2: 22,
    });
    const final = await seal.finish({
      seller: request.intent.seller,
      contractId: request.intent.contract,
      ckdSecret: new Uint8Array(48).fill(4),
    });
    await expect(host.header(id, request, final.header)).rejects.toMatchObject({
      code: 'file_invalid',
    });
    headerHash = hex(await sha256(final.header.subarray(0, final.header.length - 65)));
    expect((await host.header(id, request, final.header)).status).toBe(201);
  } finally {
    vi.unstubAllGlobals();
  }
});

it('returns too_large for oversized declarations before allocation and bad_request for unknown JSON fields', async () => {
  const f = await setup();
  await expect(f.host.create({ ...f.request, extra: 'rejected' }, 'ip')).rejects.toMatchObject({
    code: 'bad_request',
    status: 400,
  });
  for (const [field, value] of [
    ['byteSize', 50086017],
    ['plaintextSize', 50000001],
    ['headerSize', 65537],
  ] as const) {
    await expect(
      f.host.create({ ...f.request, intent: { ...f.request.intent, [field]: value } }, 'ip'),
    ).rejects.toMatchObject({ code: 'too_large', status: 413 });
  }
});

it('sweeps expired partial-upload metadata as well as temporary bytes', async () => {
  const f = await setup();
  const id = (await f.host.create(f.request, 'ip')).body.uploadId;
  f.setNow(1_601_000);
  await f.host.cleanup();
  expect((await savedState(f.config.dir)).state.uploads[id]).toBeUndefined();
  const fresh = structuredClone(f.request);
  fresh.intent.expiresAt = 2201;
  fresh.auth = {
    kind: 'evm',
    sig: await account.signMessage({ message: uploadText(fresh.intent) }),
  };
  expect((await f.host.create(fresh, 'ip')).status).toBe(201);
});

it('never initializes an empty upload ledger over existing staged bytes', async () => {
  const f = await setup();
  await stage(f);
  const { path } = await savedState(f.config.dir);
  await rm(path);
  await expect(uploadService(f.config)).rejects.toMatchObject({ reason: 'state_missing' });
});

it('uses the shared base for host admission and capacity failures', async () => {
  const { AnnonError } = await import('../../packages/annon/src/errors.ts');
  const { UploadFault } = await import('./uploads.ts');
  const { CapacityError } = await import('./capacity.ts');
  expect(new UploadFault('bad_signature')).toBeInstanceOf(AnnonError);
  expect(new CapacityError('host_capacity')).toBeInstanceOf(AnnonError);
});

it('rejects invalid service settings, identifiers and immutable authorization changes', async () => {
  const f = await setup();
  for (const length of [31, 33])
    await expect(
      uploadService({ ...f.config, signingKey: new Uint8Array(length) }),
    ).rejects.toThrow();
  await expect(f.host.status('../escape', f.request)).rejects.toMatchObject({
    code: 'bad_request',
  });
  await expect(f.host.status('aa'.repeat(32), f.request)).rejects.toMatchObject({
    code: 'upload_expired',
  });
  const id = (await f.host.create(f.request, 'ip')).body.uploadId;
  const changed = structuredClone(f.request);
  changed.intent.nonce = `0x${'07'.repeat(32)}`;
  changed.auth = {
    kind: 'evm',
    sig: await account.signMessage({ message: uploadText(changed.intent) }),
  };
  await expect(f.host.status(id, changed)).rejects.toMatchObject({ code: 'upload_conflict' });
  await expect(f.host.create(changed, 'ip')).rejects.toMatchObject({ code: 'upload_conflict' });
  await expect(f.host.header(id, f.request, f.header)).rejects.toMatchObject({
    code: 'upload_incomplete',
  });
  const disabled = await uploadService({ ...f.config, openPoolEnabled: false });
  await expect(disabled.create(changed, 'ip')).rejects.toMatchObject({ code: 'host_capacity' });
  const g = await setup();
  await expect(
    (await uploadService({ ...g.config, openPoolEnabled: false })).create(g.request, 'ip'),
  ).rejects.toMatchObject({ code: 'host_capacity' });
  expect(
    (
      await (
        await uploadService({
          ...g.config,
          openPoolEnabled: false,
          sellers: [`evm:${g.request.intent.seller.id}`],
        })
      ).create(g.request, 'ip')
    ).status,
  ).toBe(201);
});

it('refuses changed publication retries and further bodies after publication', async () => {
  const f = await setup();
  const { uploadId } = await stage(f);
  await expect(f.host.header(uploadId, f.request, f.header.subarray(1))).rejects.toMatchObject({
    code: 'too_large',
  });
  f.setInfo();
  await f.host.header(uploadId, f.request, f.header);
  const bad = f.header.slice();
  bad[100] = (bad[100] ?? 0) ^ 1;
  await expect(f.host.header(uploadId, f.request, bad)).rejects.toMatchObject({
    code: 'upload_conflict',
  });
  await expect(f.host.body(uploadId, f.request, f.source())).rejects.toMatchObject({
    code: 'upload_conflict',
  });
});

it.each([false, true])(
  'keeps one writer and refuses refresh while a body is active, reserved=%s',
  async (reserved) => {
    const f = await setup();
    const id = (await f.host.create(f.request, 'ip')).body.uploadId;
    if (reserved) await f.host.body(id, f.request, f.source());
    let release = () => {};
    let entered = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const source = async function* () {
      yield f.body;
      entered();
      await held;
    };
    const pending = f.host.body(id, f.request, source());
    try {
      await started;
      await expect(f.host.body(id, f.request, f.source())).rejects.toMatchObject({
        code: 'upload_conflict',
      });
      const refresh = structuredClone(f.request);
      if (reserved) {
        f.setNow(87_400_000);
        refresh.intent.expiresAt = 88000;
        refresh.auth = {
          kind: 'evm',
          sig: await account.signMessage({ message: uploadText(refresh.intent) }),
        };
      }
      await expect(f.host.create(refresh, 'ip')).rejects.toMatchObject({ code: 'upload_conflict' });
      expect((await f.capacity.info(id))?.state).toBe(reserved ? 'reserved' : 'receiving');
    } finally {
      release();
      await pending;
    }
  },
);

it('rejects forged POST admission before creating a record or charging capacity', async () => {
  const f = await setup();
  const bad = structuredClone(f.request);
  bad.intent.expiresAt--;
  await expect(f.host.create(bad, 'ip')).rejects.toMatchObject({ code: 'bad_signature' });
  expect(Object.keys((await savedState(f.config.dir)).state.uploads)).toHaveLength(0);
  expect((await f.host.create(f.request, 'ip')).status).toBe(201);
});

it('checks live receiving, staging and published expiry before cleanup runs', async () => {
  for (const state of ['receiving', 'reserved', 'published']) {
    const f = await setup();
    const id = (await f.host.create(f.request, 'ip')).body.uploadId;
    if (state !== 'receiving') await f.host.body(id, f.request, f.source());
    if (state === 'published') {
      f.setInfo();
      await f.host.header(id, f.request, f.header);
    }
    const at = 1000 + (state === 'receiving' ? 600 : state === 'reserved' ? 86400 : 604800);
    f.setNow(at * 1000);
    const fresh = structuredClone(f.request);
    fresh.intent.expiresAt = at + 600;
    fresh.auth = {
      kind: 'evm',
      sig: await account.signMessage({ message: uploadText(fresh.intent) }),
    };
    await expect(f.host.status(id, fresh)).rejects.toMatchObject({ code: 'upload_expired' });
    if (state === 'published') {
      await expect(f.host.create(fresh, 'ip')).rejects.toMatchObject({ code: 'upload_expired' });
      const other = structuredClone(fresh);
      other.intent.nonce = `0x${'09'.repeat(32)}`;
      other.auth = {
        kind: 'evm',
        sig: await account.signMessage({ message: uploadText(other.intent) }),
      };
      await expect(f.host.create(other, 'ip')).rejects.toMatchObject({ code: 'upload_expired' });
    }
  }
});

it('rejects truncated reserved bytes and malformed durable records on restart', async () => {
  const f = await setup();
  const { uploadId } = await stage(f);
  await writeFile(join(f.config.dir, `${uploadId}.body`), f.body.subarray(0, f.body.length - 1));
  await expect(uploadService(f.config)).rejects.toMatchObject({ reason: 'state_invalid' });
  await writeFile(join(f.config.dir, `${uploadId}.body`), f.body);
  const { state, path } = await savedState(f.config.dir);
  const record = state.uploads[uploadId];
  if (!record) throw new Error('Missing fixture');
  Object.assign(record, { ip: 1 });
  await writeFile(path, JSON.stringify(state));
  await expect(uploadService(f.config)).rejects.toMatchObject({ reason: 'state_invalid' });
});

it('rejects changed published bytes while reconciling publication crashes', async () => {
  const f = await setup();
  const { uploadId } = await stage(f);
  f.setInfo();
  await f.host.header(uploadId, f.request, f.header);
  const { state, path } = await savedState(f.config.dir);
  const record = state.uploads[uploadId];
  if (!record) throw new Error('Missing fixture');
  record.state = 'publishing';
  await writeFile(join(f.config.dir, `${uploadId}.body`), f.body);
  const file = Buffer.concat([f.header, f.body]);
  file[100] = (file[100] ?? 0) ^ 1;
  await writeFile(join(f.config.dir, `${uploadId}.pay2`), file);
  await writeFile(path, JSON.stringify(state));
  const next = await uploadService(f.config);
  await next.cleanup();
  expect(await next.files()).toEqual([]);
  expect((await savedState(f.config.dir)).state.uploads[uploadId]?.state).toBe('publishing');
});

it('enforces tightened metadata admission limits after signature verification', async () => {
  const f = await setup();
  const host = await uploadService({ ...f.config, filenameBytes: 4 });
  await expect(host.create(f.request, 'ip')).rejects.toMatchObject({ code: 'too_large' });
});

it('refuses a missing ledger after service startup and invalid reservation lifetimes', async () => {
  const f = await setup();
  const { path } = await savedState(f.config.dir);
  await rm(path);
  await expect(f.host.status('ab'.repeat(32), f.request)).rejects.toMatchObject({
    reason: 'state_missing',
  });
  const g = await setup();
  const host = await uploadService({ ...g.config, reservationSeconds: 599 });
  const id = (await host.create(g.request, 'ip')).body.uploadId;
  await expect(host.body(id, g.request, g.source())).rejects.toMatchObject({ code: 'unavailable' });
});

it.each(['contract', 'stanza'] as const)(
  'rejects a seller-signed unusable final header: %s',
  async (field) => {
    const f = await setup();
    const { uploadId } = await stage(f);
    f.setInfo();
    const { sha256 } = await import('../../packages/annon/src/envelope/pay2.ts');
    const { publishTextV2 } = await import('../../packages/annon/src/settle-near/terms.ts');
    const header = f.header.slice();
    const from = Buffer.from(field === 'contract' ? f.config.contract : 'near-ckd/v1');
    const to = Buffer.from(field === 'contract' ? 'broken.synthetic.near' : 'mock-ckd/v1');
    const offset = Buffer.from(header).indexOf(from);
    expect(offset).toBeGreaterThan(0);
    expect(to.length).toBe(from.length);
    header.set(to, offset);
    const hash = hex(await sha256(header.subarray(0, header.length - 65)));
    const signature = await account.signMessage({
      message: publishTextV2(f.config.contract, f.request.intent.fileId, hash),
    });
    header.set(Buffer.from(signature.slice(2), 'hex'), header.length - 65);
    await expect(f.host.header(uploadId, f.request, header)).rejects.toMatchObject({
      code: 'file_invalid',
    });
  },
);

it('refreshes an expired reservation on a fresh signed body retry without another POST', async () => {
  const f = await setup();
  const { uploadId } = await stage(f);
  f.setNow(1601000);
  const fresh = structuredClone(f.request);
  fresh.intent.expiresAt = 2201;
  fresh.auth = {
    kind: 'evm',
    sig: await account.signMessage({ message: uploadText(fresh.intent) }),
  };
  const reply = await f.host.body(uploadId, fresh, f.source());
  expect(reply.status).toBe(200);
  expect(reply.body.reservation.expiresAt).toBe(2201);
});

it('keeps expired ciphertext for active downloads until they finish', async () => {
  const f = await setup();
  const { uploadId } = await stage(f);
  f.setInfo();
  await f.host.header(uploadId, f.request, f.header);
  f.setNow(1000000 + 604800000);
  await f.host.cleanup(new Map([[f.request.intent.fileId, 1]]));
  expect(await f.host.files()).toEqual([]);
  expect(await readFile(join(f.config.dir, `${uploadId}.pay2`))).toEqual(
    Buffer.concat([f.header, f.body]),
  );
  const before = await savedState(f.config.dir);
  await f.host.cleanup(new Map([[f.request.intent.fileId, 1]]));
  expect((await savedState(f.config.dir)).state).toEqual(before.state);
  await f.host.cleanup();
  await expect(readFile(join(f.config.dir, `${uploadId}.pay2`))).rejects.toMatchObject({
    code: 'ENOENT',
  });
});

it('discards an abandoned receiving stage before accepting new uploads after restart', async () => {
  const f = await setup();
  const id = (await f.host.create(f.request, 'ip')).body.uploadId;
  await f.capacity.received(id, 100);
  await writeFile(join(f.config.dir, `${id}.part`), f.body.subarray(0, 100));
  const restart = await uploadService(f.config);
  expect((await savedState(f.config.dir)).state.uploads[id]).toBeUndefined();
  expect((await restart.create(f.request, 'ip')).status).toBe(201);
});

it('keeps an active partial writer intact until its request aborts', async () => {
  const f = await setup();
  const id = (await f.host.create(f.request, 'ip')).body.uploadId;
  let release = () => {};
  let entered = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const source = async function* () {
    yield f.body.subarray(0, 100);
    entered();
    await held;
    throw new Error('aborted');
  };
  const pending = f.host.body(id, f.request, source());
  try {
    await started;
    f.setNow(1601000);
    await f.host.cleanup();
    expect((await savedState(f.config.dir)).state.uploads[id]).toBeDefined();
    expect(await readFile(join(f.config.dir, `${id}.part`))).toHaveLength(100);
  } finally {
    release();
    await expect(pending).rejects.toThrow('aborted');
  }
  await f.host.cleanup();
  expect((await savedState(f.config.dir)).state.uploads[id]).toBeUndefined();
});

it.each(['takedown', 'rpc'] as const)(
  'boots published files with %s using disk only',
  async (mode) => {
    const f = await setup();
    const { uploadId } = await stage(f);
    f.setInfo();
    await f.host.header(uploadId, f.request, f.header);
    if (mode === 'takedown') f.setInfo({ takenDown: 'moderation' });
    else f.failRead();
    const getFile = vi.fn(f.config.getFile);
    const next = await uploadService({ ...f.config, getFile });
    expect(await next.files()).toHaveLength(1);
    expect(getFile).not.toHaveBeenCalled();
  },
);
it.each(['takedown', 'unknown', 'stopped', 'rpc'] as const)(
  'retries half publication after boot with %s',
  async (mode) => {
    const f = await setup();
    const { uploadId } = await stage(f);
    const { path, state } = await savedState(f.config.dir);
    const record = state.uploads[uploadId] as { state: string; finalHeader?: string };
    record.state = 'publishing';
    record.finalHeader = Buffer.from(f.header).toString('base64');
    await writeFile(path, JSON.stringify(state));
    f.setInfo();
    if (mode === 'takedown') f.setInfo({ takenDown: 'moderation' });
    if (mode === 'stopped') f.setInfo({ salesStoppedAt: 1 });
    if (mode === 'unknown') f.clearInfo();
    if (mode === 'rpc') f.failRead();
    const getFile = vi.fn(f.config.getFile);
    const next = await uploadService({ ...f.config, getFile });
    expect(getFile).not.toHaveBeenCalled();
    await expect(next.reservation(uploadId)).rejects.toMatchObject({ code: 'upload_incomplete' });
    await next.cleanup();
    expect((await savedState(f.config.dir)).state.uploads[uploadId]?.state).toBe(
      mode === 'rpc' ? 'publishing' : 'reserved',
    );
    if (mode !== 'rpc') {
      f.setInfo();
      await expect(next.header(uploadId, f.request, f.header)).resolves.toMatchObject({
        status: 201,
      });
    }
  },
);
it('checks published body hashes lazily once before serving', async () => {
  const f = await setup();
  const { uploadId } = await stage(f);
  f.setInfo();
  await f.host.header(uploadId, f.request, f.header);
  const bytes = Buffer.concat([f.header, f.body]);
  bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 1;
  await writeFile(join(f.config.dir, `${uploadId}.pay2`), bytes);
  const next = await uploadService(f.config);
  const [file] = await next.files();
  await expect(file?.verify?.()).rejects.toMatchObject({ code: 'unavailable' });
  await writeFile(join(f.config.dir, `${uploadId}.pay2`), Buffer.concat([f.header, f.body]));
  await expect(file?.verify?.()).rejects.toMatchObject({ code: 'unavailable', status: 503 });
  await writeFile(join(f.config.dir, `${uploadId}.pay2`), bytes);
  await expect(file?.verify?.()).rejects.toMatchObject({ code: 'unavailable', status: 503 });
});
it('loads capacity once and caches the header for a catalog request', async () => {
  const f = await setup();
  const { uploadId } = await stage(f);
  f.setInfo();
  await f.host.header(uploadId, f.request, f.header);
  const saved = await savedState(f.config.dir);
  for (let n = 0; n < 100; n++) {
    const id = n.toString(16).padStart(64, '0');
    saved.state.uploads[id] = { ...saved.state.uploads[uploadId], id } as never;
  }
  await writeFile(saved.path, JSON.stringify(saved.state));
  const expired = vi.spyOn(f.capacity, 'expired');
  const snapshot = vi.spyOn(f.capacity, 'snapshot');
  const first = await f.host.files();
  const second = await f.host.files();
  expect(expired).not.toHaveBeenCalled();
  expect(snapshot).toHaveBeenCalledTimes(2);
  expect(first).toHaveLength(101);
  expect(first[0]).toBe(second[0]);
});
it('refuses reservation reads after publication', async () => {
  const f = await setup();
  const { uploadId } = await stage(f);
  f.setInfo();
  await f.host.header(uploadId, f.request, f.header);
  await expect(f.host.reservation(uploadId)).rejects.toMatchObject({ code: 'upload_incomplete' });
});
it('refreshes an idle receiving upload before cleanup and reports reserved retries accurately', async () => {
  const f = await setup();
  const id = (await f.host.create(f.request, 'ip')).body.uploadId;
  f.setNow(1_601_000);
  await f.capacity.sweep();
  const req = structuredClone(f.request);
  req.intent.expiresAt = 2200;
  req.auth = { kind: 'evm', sig: await account.signMessage({ message: uploadText(req.intent) }) };
  expect((await f.host.create(req, 'ip')).body.state).toBe('receiving');
  await f.host.body(id, req, f.source());
  expect((await f.host.create(req, 'ip')).body.state).toBe('reserved');
});
it('uses tightened idle and staging lifetimes and skips expired record rewrites', async () => {
  const f = await setup({ idleSeconds: 1, stagingSeconds: 2 });
  const host = await uploadService({ ...f.config, idleSeconds: 1, stagingSeconds: 2 });
  const created = await host.create(f.request, 'ip');
  const id = created.body.uploadId;
  expect(created.body).toMatchObject({ expiresAt: 1001 });
  f.setNow(1_001_000);
  await expect(host.status(id, f.request)).rejects.toMatchObject({ code: 'upload_expired' });
  await host.create(f.request, 'ip');
  await host.body(id, f.request, f.source());
  f.setNow(1_003_000);
  await expect(host.status(id, f.request)).rejects.toMatchObject({ code: 'upload_expired' });
  await host.cleanup();
  const before = await savedState(f.config.dir);
  const removed = vi.spyOn(f.capacity, 'removed');
  await host.cleanup();
  expect(removed).not.toHaveBeenCalled();
  expect((await savedState(f.config.dir)).state).toEqual(before.state);
});

it('reaps a stalled download so cleanup can remove expired bytes', async () => {
  const { createServer, request } = await import('node:http');
  const { handler } = await import('./server.ts');
  const { memoryStore } = await import('../../packages/annon/src/pay/store.ts');
  const f = await setup();
  const { uploadId } = await stage(f);
  f.setInfo();
  await f.host.header(uploadId, f.request, f.header);
  const active = new Map<string, number>();
  const server = createServer(
    handler(
      {
        contractId: f.config.contract,
        nearRpc: f.config.nearRpc,
        baseRpc: 'https://base.invalid',
        publicUrl: f.config.hostOrigin,
        files: [],
        store: memoryStore(),
        uploads: f.host,
        capacity: f.capacity,
        active,
        perIpMinute: 600,
        paymentsPerClientMinute: 60,
      },
      async () => ({
        status: 200,
        headers: {},
        body: new ReadableStream({
          pull(c) {
            c.enqueue(new Uint8Array(65536));
          },
        }),
      }),
    ),
  );
  let downloadSocket: import('node:net').Socket | undefined;
  server.on('connection', (socket) => {
    downloadSocket = socket;
  });
  server.timeout = 120000;
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing address');
  const req = request(`http://127.0.0.1:${address.port}/f/${f.request.intent.fileId.slice(2)}`);
  req.on('error', () => {});
  let response: import('node:http').IncomingMessage | undefined;
  try {
    await new Promise<void>((r) => {
      req.on('response', (res) => {
        response = res;
        res.pause();
        r();
      });
      req.end();
    });
    await vi.waitFor(() => expect(active.get(f.request.intent.fileId)).toBe(1));
    f.setNow(1_000_000 + 604800000);
    await f.host.cleanup(active);
    expect(await readFile(join(f.config.dir, `${uploadId}.pay2`))).toBeDefined();
    downloadSocket?.setTimeout(40);
    await vi.waitFor(() => expect(active.get(f.request.intent.fileId)).toBe(0), { timeout: 3000 });
    await f.host.cleanup(active);
    await expect(readFile(join(f.config.dir, `${uploadId}.pay2`))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  } finally {
    response?.destroy();
    req.destroy();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});

it('returns a half publication from the capacity ledger to a resumable reservation without extending TTL', async () => {
  const f = await setup();
  const { uploadId } = await stage(f);
  await f.capacity.publish(uploadId);
  const saved = await savedState(f.config.dir);
  Object.assign(saved.state.uploads[uploadId] ?? {}, {
    state: 'publishing',
    finalHeader: Buffer.from(f.header).toString('base64'),
  });
  await writeFile(saved.path, JSON.stringify(saved.state));
  f.setInfo({ takenDown: 'moderation' });
  const next = await uploadService(f.config);
  await next.cleanup();
  expect(await f.capacity.info(uploadId)).toMatchObject({
    state: 'reserved',
    createdAt: 1_000_000,
  });
  f.setInfo();
  f.setNow(1_100_000);
  expect(await next.header(uploadId, f.request, f.header)).toMatchObject({
    status: 201,
    body: { expiresAt: 605800 },
  });
});

it('caches corrupted hosted body failures and emits one fixed alert', async () => {
  const f = await setup();
  const alert = vi.fn();
  const host = await uploadService({ ...f.config, alert });
  const created = await host.create(f.request, 'ip');
  const id = (created.body as { uploadId: string }).uploadId;
  await host.body(id, f.request, f.source());
  f.setInfo();
  await host.header(id, f.request, f.header);
  const file = (await host.files())[0];
  if (!file) throw new Error('missing published file');
  const bytes = await readFile(file.path);
  bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 1;
  await writeFile(file.path, bytes);
  await expect(file.verify?.()).rejects.toMatchObject({ code: 'unavailable', status: 503 });
  await writeFile(file.path, new Uint8Array());
  await expect(file.verify?.()).rejects.toMatchObject({ code: 'unavailable', status: 503 });
  expect(alert).toHaveBeenCalledExactlyOnceWith({ type: 'host_file_invalid' });
});
it.each(['receiving', 'expired', 'authorization', 'fields', 'salt', 'no-base'])(
  'refuses split %s before deployment',
  async (guard) => {
    const f = await setup({ base: guard !== 'no-base' });
    const deploySplit = vi.fn();
    const host = await uploadService({
      ...f.config,
      splits: { checkSplit: () => {}, deploySplit, splitStatus: async () => null },
    });
    const c = await host.create(f.request, 'ip');
    const id = (c.body as { uploadId: string }).uploadId;
    if (guard !== 'receiving') await host.body(id, f.request, f.source());
    if (guard === 'expired') f.setNow(88_000_000);
    const auth = structuredClone(f.request);
    if (guard === 'authorization') auth.auth = { kind: 'evm', sig: `0x${'00'.repeat(65)}` };
    const input = {
      kind: 'push',
      salt: `0x${'00'.repeat(32)}`,
      ...(guard === 'fields' ? { to: 'arbitrary' } : {}),
    };
    if (guard === 'salt') input.salt = `0x${'01'.repeat(32)}`;
    await expect(host.baseSplit(id, auth, input)).rejects.toMatchObject({
      code:
        guard === 'receiving'
          ? 'upload_incomplete'
          : guard === 'expired'
            ? 'upload_expired'
            : guard === 'authorization'
              ? 'bad_signature'
              : guard === 'no-base'
                ? 'not_sponsored'
                : 'bad_request',
    });
    expect(deploySplit).not.toHaveBeenCalled();
  },
);

it('returns exact pending and verified split responses and reconciles an unsaved response through authenticated GET', async () => {
  const f = await setup({ base: true });
  let state: 'pending' | 'ready' = 'pending';
  let known = false;
  const provenance = () => ({
    state,
    address: f.request.terms.base?.pay_to as string,
    kind: 'push' as const,
    salt: hostedSplitSalt(),
    txHash: `0x${'11'.repeat(32)}`,
  });
  const splits = {
    checkSplit: () => {},
    deploySplit: vi.fn(async () => {
      known = true;
      return provenance();
    }),
    splitStatus: vi.fn(async () => (known ? provenance() : null)),
  };
  const host = await uploadService({ ...f.config, splits });
  const id = ((await host.create(f.request, 'ip')).body as { uploadId: string }).uploadId;
  await host.body(id, f.request, f.source());
  expect(await host.baseSplit(id, f.request, { kind: 'push', salt: hostedSplitSalt() })).toEqual({
    status: 202,
    body: { baseSplit: provenance() },
  });
  state = 'ready';
  const restarted = await uploadService({ ...f.config, splits });
  expect(await restarted.status(id, f.request)).toMatchObject({
    body: { baseSplit: provenance() },
  });
  expect(
    await restarted.baseSplit(id, f.request, { kind: 'push', salt: hostedSplitSalt() }),
  ).toEqual({ status: 200, body: { baseSplit: provenance() } });
});
it('requires intact staged bytes and a live reservation before deploying a split', async () => {
  const f = await setup({ base: true });
  const splits = { checkSplit: () => {}, deploySplit: vi.fn(), splitStatus: async () => null };
  const host = await uploadService({ ...f.config, splits });
  const id = ((await host.create(f.request, 'ip')).body as { uploadId: string }).uploadId;
  await host.body(id, f.request, f.source());
  const input = { kind: 'push', salt: hostedSplitSalt() };
  await writeFile(join(f.config.dir, `${id}.body`), new Uint8Array(f.body.length));
  await expect(host.baseSplit(id, f.request, input)).rejects.toMatchObject({
    code: 'cipher_hash_mismatch',
  });
  await writeFile(join(f.config.dir, `${id}.body`), f.body);
  f.setNow(1_600_000);
  const auth = structuredClone(f.request);
  auth.intent.expiresAt = 2200;
  auth.auth = { kind: 'evm', sig: await account.signMessage({ message: uploadText(auth.intent) }) };
  await expect(host.baseSplit(id, auth, input)).rejects.toMatchObject({ code: 'upload_expired' });
  expect(splits.deploySplit).not.toHaveBeenCalled();
});

it('rechecks reservation expiry after waiting for the shared wallet queue', async () => {
  const f = await setup({ base: true });
  const splits = {
    checkSplit: () => {},
    deploySplit: vi.fn(async (_terms: Terms, beforeSend?: () => Promise<void>) => {
      f.setNow(1_600_000);
      await beforeSend?.();
      throw new Error('send should not be reached');
    }),
    splitStatus: async () => null,
  };
  const host = await uploadService({ ...f.config, splits });
  const id = ((await host.create(f.request, 'ip')).body as { uploadId: string }).uploadId;
  await host.body(id, f.request, f.source());
  await expect(
    host.baseSplit(id, f.request, { kind: 'push', salt: hostedSplitSalt() }),
  ).rejects.toMatchObject({ code: 'upload_expired' });
});

function statusFacilitator(enabled: boolean) {
  const chain: Chain = {
    timestamp: async () => 1000,
    used: async () => false,
    balance: async () => 1n,
    simulate: async () => true,
    sign: vi.fn(async () => null),
    send: vi.fn(async () => ''),
    receipt: async () => null,
    transaction: async () => false,
    ethBalance: async () => 10n ** 18n,
    nonceClear: async () => true,
    minedNonce: async () => 0,
    readSplit: vi.fn(async () => true),
  };
  const splits = facilitatorFor(chain, 10, () => 1000000, {
    split: enabled
      ? {
          enabled: true,
          deploymentsPerDay: 60,
          sendsPerMinute: 2,
          revertsPerDay: 1,
          gasLimit: 1000000n,
          maxFeeGwei: 1,
          l1FeeAllowanceWei: 5n,
          dailyBudgetWei: 100n,
          walletDailyBudgetWei: 200n,
        }
      : { enabled: false },
    splitFee: { fixed: '0', bps: 0, treasuryNear: null, treasuryEvm: null },
  });
  return { chain, splits };
}
it.each(['near', 'solana'] as const)(
  'refuses authenticated %s sellers before rehashing staged bytes',
  async (sellerKind) => {
    const rpc = vi.spyOn(nearRpc, 'isFullAccessKey').mockResolvedValue(true);
    try {
      const f = await setup({ base: true, sellerKind });
      const { chain, splits } = statusFacilitator(true);
      vi.spyOn(splits, 'checkSplit').mockImplementation(() => {});
      const host = await uploadService({ ...f.config, splits });
      const id = ((await host.create(f.request, 'ip')).body as { uploadId: string }).uploadId;
      await host.body(id, f.request, f.source());
      await writeFile(join(f.config.dir, `${id}.body`), new Uint8Array(f.body.length));
      await expect(
        host.baseSplit(id, f.request, { kind: 'push', salt: hostedSplitSalt() }),
      ).rejects.toMatchObject({ code: 'not_sponsored' });
      expect(chain.sign).not.toHaveBeenCalled();
      expect(chain.send).not.toHaveBeenCalled();
    } finally {
      rpc.mockRestore();
    }
  },
);
it.each(['disabled', 'policy'] as const)(
  'checks split %s before rehashing staged bytes',
  async (guard) => {
    const f = await setup({ base: true });
    const { chain, splits } = statusFacilitator(guard !== 'disabled');
    // No treasury fee configuration can authorize a deployment.
    const service =
      guard === 'policy'
        ? facilitatorFor(chain, 10, () => 1000000, {
            split: {
              enabled: true,
              deploymentsPerDay: 60,
              sendsPerMinute: 2,
              revertsPerDay: 1,
              gasLimit: 1000000n,
              maxFeeGwei: 1,
              l1FeeAllowanceWei: 5n,
              dailyBudgetWei: 100n,
              walletDailyBudgetWei: 200n,
            },
          })
        : splits;
    const host = await uploadService({ ...f.config, splits: service });
    const id = ((await host.create(f.request, 'ip')).body as { uploadId: string }).uploadId;
    await host.body(id, f.request, f.source());
    await writeFile(join(f.config.dir, `${id}.body`), new Uint8Array(f.body.length));
    await expect(
      host.baseSplit(id, f.request, { kind: 'push', salt: hostedSplitSalt() }),
    ).rejects.toMatchObject({ code: guard === 'disabled' ? 'disabled' : 'not_sponsored' });
    expect(chain.sign).not.toHaveBeenCalled();
    expect(chain.send).not.toHaveBeenCalled();
  },
);
it('returns authenticated upload status with the real facilitator when splits are disabled', async () => {
  const f = await setup({ base: true });
  const { splits } = statusFacilitator(false);
  const host = await uploadService({ ...f.config, splits });
  const id = ((await host.create(f.request, 'ip')).body as { uploadId: string }).uploadId;
  await host.body(id, f.request, f.source());
  await expect(host.status(id, f.request)).resolves.toMatchObject({
    status: 200,
    body: { state: 'reserved', baseSplit: null },
  });
});
it.each(['unavailable', 'disabled'] as const)(
  'keeps stored split provenance when its current status is %s',
  async (mode) => {
    const f = await setup({ base: true });
    const { splits } = statusFacilitator(true);
    const host = await uploadService({ ...f.config, splits });
    const id = ((await host.create(f.request, 'ip')).body as { uploadId: string }).uploadId;
    await host.body(id, f.request, f.source());
    const result = await host.baseSplit(id, f.request, { kind: 'push', salt: hostedSplitSalt() });
    if (mode === 'unavailable')
      vi.spyOn(splits, 'splitStatus').mockRejectedValue(new Error('policy changed'));
    const restarted =
      mode === 'disabled'
        ? await uploadService({ ...f.config, splits: statusFacilitator(false).splits })
        : host;
    await expect(restarted.status(id, f.request)).resolves.toMatchObject({
      status: 200,
      body: { baseSplit: result.body.baseSplit },
    });
  },
);
