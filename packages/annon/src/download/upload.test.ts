import { ed25519 } from '@noble/curves/ed25519.js';
import { privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';
import { prepareSeal } from '../envelope/replay.js';
import { AnnonError, toPublicError } from '../errors.js';
import { hex } from '../settle-near/codec.js';
import { NEAR_USDC, termsHash } from '../settle-near/terms.js';
import { parseUpload, UploadClient, uploadText, verifyUpload } from './upload.js';

const utf8 = new TextEncoder();
const hash = (n: number) => `0x${n.toString(16).padStart(2, '0').repeat(32)}`;
const account = privateKeyToAccount(`0x${'01'.repeat(32)}`);
const seller = { kind: 'evm' as const, id: account.address.toLowerCase() };
async function fixture() {
  const data = new Uint8Array(1024).fill(8);
  const seal = await prepareSeal(new Uint8Array(32).fill(3), data, {
    fileId: new Uint8Array(32).fill(2),
    name: 'file.txt',
    mime: 'text/plain',
    version: 2,
    authKind: 0,
    chunkLog2: 22,
  });
  const manifest = seal.manifest;
  const terms = {
    network: 'near:mainnet',
    contract: 'market.synthetic.near',
    file_id: hash(2),
    seller,
    pay2_version: 2 as const,
    cipher_hash: hex(seal.cipherHash),
    moderator: null,
    near: {
      token: NEAR_USDC,
      price: '100000',
      recipients: [{ identity: seller, bps: 10000 }],
      remainder: 0,
    },
    base: null,
  };
  const metadata = {
    filename: 'file.txt',
    title: 'File',
    description: '<script>alert(1)</script>',
  };
  const { metadataHash } = await import('./upload.js');
  const intent = {
    network: terms.network,
    contract: terms.contract,
    seller,
    fileId: terms.file_id,
    cipherHash: terms.cipher_hash,
    termsHash: termsHash(terms),
    byteSize: 1635,
    plaintextSize: data.length,
    headerSize: seal.headerSize(terms.contract),
    hostOrigin: 'https://demo.annon.dev',
    metadataHash: await metadataHash(metadata),
    nonce: hash(6),
    expiresAt: 1600,
  };
  const auth = {
    kind: 'evm' as const,
    sig: await account.signMessage({ message: uploadText(intent) }),
  };
  return { request: { intent, terms, manifest, metadata, auth }, seal, data, account };
}

it('reproduces the frozen UTF-8 signing vector', async () => {
  const i = {
    network: 'near:mainnet',
    contract: 'market.synthetic.near',
    seller: { kind: 'evm' as const, id: `0x${'11'.repeat(20)}` },
    fileId: hash(0x22),
    cipherHash: hash(0x33),
    termsHash: hash(0x44),
    byteSize: 1635,
    plaintextSize: 1024,
    headerSize: 323,
    hostOrigin: 'https://demo.annon.dev',
    metadataHash: hash(0x55),
    nonce: hash(0x66),
    expiresAt: 1794528600,
  };
  const text = uploadText(i);
  expect(utf8.encode(text)).toHaveLength(620);
  const { sha256 } = await import('../envelope/pay2.js');
  expect(hex(await sha256(utf8.encode(text))).slice(2)).toBe(
    '3a55e8edcb0fc61f2c9ca3a03f347dd0b50247ac457f8eb80a777e5b4c6e5e9b',
  );
});
it('stages the encrypted body before CKD and produces the same final bytes', async () => {
  const f = await fixture();
  const body = new Uint8Array(await new Response(f.seal.body()).arrayBuffer());
  expect(body).toHaveLength(1312);
  const final = await f.seal.finish({
    contractId: f.request.terms.contract,
    seller,
    ckdSecret: new Uint8Array(48).fill(4),
    sign: (message) => account.signMessage({ message }),
  });
  expect(final.header).toHaveLength(323);
  expect((final.file as Uint8Array).subarray(323)).toEqual(body);
  await expect(
    verifyUpload(f.request, {
      network: 'near:mainnet',
      contract: f.request.terms.contract,
      hostOrigin: f.request.intent.hostOrigin,
      now: 1000,
      nearRpc: 'https://near.invalid',
    }),
  ).resolves.toBeUndefined();
});
it('rejects changed plaintext on encrypted replay', async () => {
  let value = new Uint8Array(100).fill(1);
  const p = await prepareSeal(
    new Uint8Array(32).fill(3),
    { size: 100, read: () => new Blob([value]).stream() },
    { fileId: new Uint8Array(32).fill(2), name: 'x', mime: '', version: 2, authKind: 0 },
  );
  value = new Uint8Array(100).fill(2);
  await expect(new Response(p.body()).arrayBuffer()).rejects.toMatchObject({
    code: 'source_changed',
  });
});
describe('upload admission binding', () => {
  it.each([
    'termsHash',
    'cipherHash',
    'fileId',
    'hostOrigin',
    'seller',
    'expiresAt',
    'plaintextSize',
    'headerSize',
    'metadataHash',
  ] as const)('rejects changed %s', async (field) => {
    const f = await fixture();
    const changed = structuredClone(f.request);
    Object.assign(changed.intent, {
      [field]:
        field === 'seller'
          ? { kind: 'near', id: 'other.near' }
          : field.endsWith('Size') || field === 'expiresAt'
            ? 1
            : field === 'hostOrigin'
              ? 'https://other.example'
              : hash(9),
    });
    await expect(
      verifyUpload(changed, {
        network: 'near:mainnet',
        contract: f.request.terms.contract,
        hostOrigin: f.request.intent.hostOrigin,
        now: 1000,
        nearRpc: 'https://near.invalid',
      }),
    ).rejects.toThrow();
  });
  it.each(['../x', 'a/b', 'a\\b', '.', '..', 'a\n', 'a\0'])(
    'rejects unsafe filename %s',
    async (filename) => {
      const f = await fixture();
      f.request.metadata.filename = filename;
      expect(() => parseUpload(f.request)).toThrow();
    },
  );
  it('rejects unknown fields, malformed manifests and size lies', async () => {
    const f = await fixture();
    expect(() => parseUpload({ ...f.request, key: 'forbidden' })).toThrow();
    f.request.manifest.n++;
    expect(() => parseUpload(f.request)).toThrow();
  });
  it('verifies a real Solana upload signature', async () => {
    const f = await fixture();
    const seed = new Uint8Array(32).fill(8);
    const id = { kind: 'solana' as const, id: hex(ed25519.getPublicKey(seed)).slice(2) };
    f.request.terms.seller = id as never;
    f.request.terms.near.recipients = [{ identity: id as never, bps: 10000 }];
    f.request.intent.seller = id as never;
    f.request.intent.termsHash = termsHash(f.request.terms);
    f.request.auth = {
      kind: 'solana',
      sig: hex(ed25519.sign(utf8.encode(uploadText(f.request.intent)), seed)),
    } as never;
    await expect(
      verifyUpload(f.request, {
        network: 'near:mainnet',
        contract: f.request.terms.contract,
        hostOrigin: f.request.intent.hostOrigin,
        now: 1000,
        nearRpc: 'https://near.invalid',
      }),
    ).resolves.toBeUndefined();
  });
});
it('uses the fixed origin, exact auth envelope and credential-free binary PUT', async () => {
  const f = await fixture();
  const calls: [string, RequestInit | undefined][] = [];
  const client = new UploadClient('https://demo.annon.dev', {
    fetch: (async (url, init) => {
      calls.push([String(url), init]);
      return Response.json(
        {
          uploadId: 'a'.repeat(64),
          state: 'receiving',
          expiresAt: 1600,
          bodyUrl: 'https://demo.annon.dev/v1/uploads/x/body',
          headerUrl: 'https://demo.annon.dev/v1/uploads/x/header',
        },
        { status: 201 },
      );
    }) as typeof fetch,
  });
  await client.create(f.request);
  await client.body(
    'a'.repeat(64),
    { intent: f.request.intent, auth: f.request.auth },
    f.seal.body(),
  );
  expect(calls[1]?.[0]).toBe(`https://demo.annon.dev/v1/uploads/${'a'.repeat(64)}/body`);
  expect(calls[1]?.[1]).toMatchObject({
    method: 'PUT',
    credentials: 'omit',
    redirect: 'error',
    headers: { 'Content-Type': 'application/octet-stream' },
  });
  expect(() => new UploadClient('http://localhost')).toThrow();
  await expect(
    client.status('../escape', { intent: f.request.intent, auth: f.request.auth }),
  ).rejects.toThrow();
});

it('checks all independent signature fixtures and finalized NEAR full-access membership', async () => {
  const vectors = (await import('../../../../specs/vectors/upload.json')).default;
  const { vi } = await import('vitest');
  const rpc = vi.fn(async (_url: unknown, init: RequestInit) => {
    const request = JSON.parse(init.body as string);
    expect(request.params.finality).toBe('final');
    expect(request.params.account_id).toBe('seller.synthetic.near');
    return Response.json({ jsonrpc: '2.0', id: request.id, result: { permission: 'FullAccess' } });
  });
  vi.stubGlobal('fetch', rpc);
  try {
    for (const vector of vectors.cases) {
      const request = parseUpload(vector.request);
      expect(uploadText(request.intent)).toBe(vector.text);
      expect(hex(utf8.encode(vector.text)).slice(2)).toBe(vector.utf8Hex);
      await verifyUpload(request, {
        network: request.intent.network,
        contract: request.intent.contract,
        hostOrigin: request.intent.hostOrigin,
        now: 1794528000,
        nearRpc: 'https://near.invalid',
      });
      const changed = structuredClone(request);
      changed.intent.expiresAt--;
      await expect(
        verifyUpload(changed, {
          network: request.intent.network,
          contract: request.intent.contract,
          hostOrigin: request.intent.hostOrigin,
          now: 1794528000,
          nearRpc: 'https://near.invalid',
        }),
      ).rejects.toThrow();
    }
    expect(rpc).toHaveBeenCalled();
    rpc.mockImplementationOnce(async (_url, init) =>
      Response.json({
        jsonrpc: '2.0',
        id: JSON.parse(init.body as string).id,
        result: { permission: { FunctionCall: {} } },
      }),
    );
    const near = parseUpload(vectors.cases[2]?.request);
    await expect(
      verifyUpload(near, {
        network: near.intent.network,
        contract: near.intent.contract,
        hostOrigin: near.intent.hostOrigin,
        now: 1794528000,
        nearRpc: 'https://near.invalid',
      }),
    ).rejects.toThrow('full-access');
  } finally {
    vi.unstubAllGlobals();
  }
});

it.each(['old-domain', 'crlf', 'trailing-lf', 'new-host'] as const)(
  'rejects %s signature replay',
  async (mode) => {
    const f = await fixture();
    let text = uploadText(f.request.intent);
    if (mode === 'old-domain')
      text = text.replace('reserve encrypted file hosting', 'upload a file');
    if (mode === 'crlf') text = text.replaceAll('\n', '\r\n');
    if (mode === 'trailing-lf') text += '\n';
    if (mode === 'new-host') text = text.replace('https://demo.annon.dev', 'https://other.example');
    f.request.auth.sig = await account.signMessage({ message: text });
    await expect(
      verifyUpload(f.request, {
        network: f.request.intent.network,
        contract: f.request.intent.contract,
        hostOrigin: f.request.intent.hostOrigin,
        now: 1000,
        nearRpc: 'https://near.invalid',
      }),
    ).rejects.toThrow();
  },
);

it('refuses malformed successful responses and sanitizes upstream HTTP failures', async () => {
  const f = await fixture();
  const invalid = new UploadClient('https://demo.annon.dev', {
    fetch: (async () =>
      Response.json({ uploadId: '../escape', state: 'receiving' })) as typeof fetch,
  });
  expect(await invalid.create(f.request)).toMatchObject({
    ok: false,
    error: { code: 'operation_failed' },
  });
  const failed = new UploadClient('https://demo.annon.dev', {
    fetch: (async () =>
      Response.json(
        { error: 'host_capacity', message: 'private upstream text', retryAfterSeconds: 7 },
        { status: 503 },
      )) as typeof fetch,
  });
  const result = await failed.create(f.request);
  expect(result).toMatchObject({
    ok: false,
    error: { code: 'host_capacity', retryAfterSeconds: 7 },
  });
  expect(JSON.stringify(result)).not.toContain('private');
});

it('rejects valid signatures outside the configured deployment or the 600-second window', async () => {
  const f = await fixture();
  const context = {
    network: f.request.intent.network,
    contract: f.request.intent.contract,
    hostOrigin: f.request.intent.hostOrigin,
    now: 1000,
    nearRpc: 'https://near.invalid',
  };
  for (const over of [
    { network: 'near:testnet' },
    { contract: 'other.near' },
    { hostOrigin: 'https://other.example' },
    { now: 1600 },
    { now: 999 },
  ]) {
    await expect(verifyUpload(f.request, { ...context, ...over })).rejects.toThrow();
  }
});
it('binds signed intent to actual terms, normalized metadata and the manifest commitment', async () => {
  for (const field of ['terms', 'metadata', 'manifest']) {
    const f = await fixture();
    if (field === 'terms') f.request.terms.near.price = '100001';
    if (field === 'metadata') f.request.metadata.title = 'Changed';
    if (field === 'manifest') f.request.manifest.chunkHashes[0] = hash(9);
    await expect(
      verifyUpload(f.request, {
        network: f.request.intent.network,
        contract: f.request.intent.contract,
        hostOrigin: f.request.intent.hostOrigin,
        now: 1000,
        nearRpc: 'https://near.invalid',
      }),
    ).rejects.toThrow();
  }
});

it('does not expose transport or malformed-response diagnostics', async () => {
  const f = await fixture();
  for (const fetcher of [
    async () => {
      throw new Error('private URL and signature');
    },
    async () => new Response('invalid', { headers: { 'Content-Type': 'application/json' } }),
  ]) {
    const client = new UploadClient('https://demo.annon.dev', { fetch: fetcher as typeof fetch });
    const result = await client.create(f.request);
    expect(result).toMatchObject({ ok: false, error: { code: 'operation_failed' } });
    expect(JSON.stringify(result)).not.toContain('private');
  }
});

it('rejects ill-formed Unicode filenames', async () => {
  const f = await fixture();
  f.request.metadata.filename = '\ud800';
  expect(() => parseUpload(f.request)).toThrow();
});

it('canonicalizes Identity values independently of JSON property order', async () => {
  const f = await fixture();
  f.request.intent.seller = { id: seller.id, kind: seller.kind };
  await expect(
    verifyUpload(f.request, {
      network: f.request.intent.network,
      contract: f.request.intent.contract,
      hostOrigin: f.request.intent.hostOrigin,
      now: 1000,
      nearRpc: 'https://near.invalid',
    }),
  ).resolves.toBeUndefined();
});

it.each(['stream', 'blob'] as const)(
  'sends a verified %s body with transport-specific request options',
  async (kind) => {
    const f = await fixture();
    const vectors = (await import('../../../../specs/vectors/upload.json')).default;
    const { parseUpload } = await import('./upload.js');
    const request = parseUpload(vectors.cases[0]?.request);
    const id = vectors.reservation.input.uploadId;
    const body = kind === 'blob' ? new Blob([new Uint8Array([1, 2, 3])]) : f.seal.body();
    const client = new UploadClient(request.intent.hostOrigin, {
      fetch: (async (_url, init) => {
        expect(init?.body).toBe(body);
        expect(init?.credentials).toBe('omit');
        expect(init?.redirect).toBe('error');
        expect(init?.headers).toMatchObject({
          'Content-Type': 'application/octet-stream',
          'Annon-Upload-Authorization': expect.any(String),
        });
        if (kind === 'stream') expect(init).toHaveProperty('duplex', 'half');
        else expect(init).not.toHaveProperty('duplex');
        return Response.json({
          uploadId: id,
          state: 'reserved',
          reservation: vectors.reservation.input,
        });
      }) as typeof fetch,
    });
    expect(await client.body(id, request, body)).toMatchObject({
      ok: true,
      value: { state: 'reserved' },
    });
  },
);

it.each([
  'host_capacity',
  'budget',
  'disabled',
  'settlement_pending',
  'base_rpc_rate_limited',
  'unknown_upstream',
])('maps HTTP %s into the shared safe error model', async (code) => {
  const f = await fixture();
  const client = new UploadClient(f.request.intent.hostOrigin, {
    fetch: (async () =>
      Response.json(
        { error: code, message: 'private diagnostics', retryAfterSeconds: 2.1 },
        { status: 503 },
      )) as typeof fetch,
  });
  const result = await client.create(f.request);
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error('Expected failure');
  expect(result.error).toBeInstanceOf(AnnonError);
  expect(result.error.name).toBe('AnnonError');
  expect(result.error.code).toBe(code === 'unknown_upstream' ? 'operation_failed' : code);
  const publicError = toPublicError(result.error);
  expect(publicError.code).toBe(code === 'unknown_upstream' ? 'operation_failed' : code);
  expect(publicError.retryAfterSeconds).toBe(code === 'unknown_upstream' ? undefined : 3);
  expect(result.error.retryAfterSeconds).toBe(code === 'unknown_upstream' ? undefined : 3);
  expect(publicError.message).not.toContain('private');
});

it('rejects malformed intent numbers, noncanonical identities, auth shapes and manifest bounds', async () => {
  const f = await fixture();
  const { parseUploadIntent, parseUploadAuth } = await import('./upload.js');
  for (const key of ['byteSize', 'plaintextSize', 'headerSize', 'expiresAt']) {
    for (const value of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1])
      expect(() => parseUploadIntent({ ...f.request.intent, [key]: value })).toThrow();
  }
  for (const over of [
    { byteSize: 323 },
    { headerSize: 0 },
    { headerSize: 65537 },
    { plaintextSize: 50000001 },
    { byteSize: 50086017 },
  ])
    expect(() => parseUploadIntent({ ...f.request.intent, ...over })).toThrow();
  expect(() =>
    parseUploadIntent({
      ...f.request.intent,
      seller: { ...seller, id: seller.id.toUpperCase().replace('0X', '0x') },
    }),
  ).toThrow();
  for (const auth of [
    null,
    1,
    { kind: 'other', sig: `0x${'00'.repeat(64)}` },
    { kind: 'near', accountId: 1, publicKey: '', signature: '' },
  ])
    expect(() => parseUploadAuth(auth)).toThrow();
  for (const over of [{ byteSize: 1636 }, { byteSize: 1636, headerSize: 324 }])
    expect(() => parseUpload({ ...f.request, intent: { ...f.request.intent, ...over } })).toThrow();
  for (const over of [
    { version: 1 },
    { chunkLog2: 15 },
    { chunkLog2: 25 },
    { metaLen: 0 },
    { metaLen: 4097 },
    { previewLen: -1 },
    { previewLen: 1025 },
    { n: 1 },
    { n: 1025 },
    { keyCommitments: [] },
    { chunkHashes: [] },
  ])
    expect(() =>
      parseUpload({ ...f.request, manifest: { ...f.request.manifest, ...over } }),
    ).toThrow();
});

it('enforces UTF-8 metadata and authorization header bounds', async () => {
  const f = await fixture();
  const { normalizeMetadata, encodeUploadAuthorization, decodeUploadAuthorization } = await import(
    './upload.js'
  );
  for (const over of [
    { filename: 1 },
    { filename: '' },
    { title: '' },
    { title: 'é'.repeat(61) },
    { description: 'x'.repeat(501) },
  ])
    expect(() => normalizeMetadata({ ...f.request.metadata, ...over })).toThrow();
  const encoded = encodeUploadAuthorization(f.request);
  expect(() => decodeUploadAuthorization(encoded, encoded.length - 1)).toThrow();
  expect(decodeUploadAuthorization(encoded)).toMatchObject({ intent: f.request.intent });
  for (const value of [`${encoded}=`, '!', 'a'.repeat(8193)])
    expect(() => decodeUploadAuthorization(value)).toThrow();
  expect(() =>
    encodeUploadAuthorization({
      intent: f.request.intent,
      auth: { kind: 'near', accountId: 'seller.near', publicKey: 'x'.repeat(8193), signature: '' },
    }),
  ).toThrow();
});

it('checks every successful reservation and publication binding and response byte cap', async () => {
  const vectors = (await import('../../../../specs/vectors/upload.json')).default;
  const request = parseUpload(vectors.cases[0]?.request);
  const reservation = vectors.reservation.input;
  const id = reservation.uploadId;
  let response: unknown = {
    uploadId: id,
    state: 'receiving',
    expiresAt: 2000,
    bodyUrl: 'https://other.example',
    headerUrl: `${request.intent.hostOrigin}/v1/uploads/${id}/header`,
  };
  const client = new UploadClient(request.intent.hostOrigin, {
    fetch: (async () => Response.json(response)) as typeof fetch,
  });
  expect(await client.create(request)).toMatchObject({ ok: false });
  for (const over of [
    { uploadId: 'cd'.repeat(32) },
    { state: 'receiving' },
    { reservation: { ...reservation, seller: { kind: 'near', id: 'other.near' } } },
    { reservation: { ...reservation, fileId: hash(9) } },
  ]) {
    response = { uploadId: id, state: 'reserved', reservation, ...over };
    expect(await client.body(id, request, new Blob([]))).toMatchObject({ ok: false });
  }
  const url = `${request.intent.hostOrigin}/f/${request.intent.fileId.slice(2)}`;
  const published = {
    fileId: request.intent.fileId,
    url,
    header: `${url}/header`,
    expiresAt: 2000,
  };
  response = published;
  expect(await client.header(id, request, new Uint8Array())).toMatchObject({ ok: true });
  for (const over of [
    { fileId: hash(9) },
    { url: 'https://other.example' },
    { header: 'https://other.example' },
    { expiresAt: -1 },
  ]) {
    response = { ...published, ...over };
    expect(await client.header(id, request, new Uint8Array())).toMatchObject({ ok: false });
  }
  response = { uploadId: 'cd'.repeat(32), state: 'published', result: published, baseSplit: null };
  expect(await client.status(id, request)).toMatchObject({ ok: false });
  response = { padding: 'x'.repeat(131073) };
  expect(await client.status(id, request)).toMatchObject({ ok: false });
});

it('rejects oversized otherwise valid error JSON before accepting its retry evidence', async () => {
  const f = await fixture();
  const client = new UploadClient(f.request.intent.hostOrigin, {
    fetch: (async () =>
      Response.json(
        { error: 'host_capacity', message: 'x'.repeat(131073) },
        { status: 503 },
      )) as typeof fetch,
  });
  expect(await client.create(f.request)).toMatchObject({
    ok: false,
    error: { code: 'operation_failed' },
  });
});

it('keeps buffered plaintext immutable while staging and finishing the encrypted body', async () => {
  const f = await fixture();
  const before = new Uint8Array(await new Response(f.seal.body()).arrayBuffer());
  f.data.fill(9);
  expect(new Uint8Array(await new Response(f.seal.body()).arrayBuffer())).toEqual(before);
  await f.seal.stage(
    async (wire, use) => {
      const body = new Blob([await new Response(wire).arrayBuffer()]);
      return use({ size: body.size, read: () => body.stream() });
    },
    async (source) => {
      expect(new Uint8Array(await new Response(source.read()).arrayBuffer())).toEqual(before);
    },
  );
});

it('rejects redirected or non-JSON upload responses before accepting a successful body', async () => {
  const f = await fixture();
  const id = 'ab'.repeat(32);
  for (const mode of ['redirect', 'content-type']) {
    const client = new UploadClient(f.request.intent.hostOrigin, {
      fetch: (async () => {
        const response = Response.json({
          uploadId: id,
          state: 'receiving',
          expiresAt: 1600,
          bodyUrl: `${f.request.intent.hostOrigin}/v1/uploads/${id}/body`,
          headerUrl: `${f.request.intent.hostOrigin}/v1/uploads/${id}/header`,
        });
        if (mode === 'redirect') Object.defineProperty(response, 'redirected', { value: true });
        else response.headers.set('Content-Type', 'text/plain');
        return response;
      }) as typeof fetch,
    });
    expect(await client.create(f.request)).toMatchObject({
      ok: false,
      error: { code: 'operation_failed' },
    });
  }
});

it('validates authenticated status responses for every upload state', async () => {
  const vectors = (await import('../../../../specs/vectors/upload.json')).default;
  const request = parseUpload(vectors.cases[0]?.request);
  const id = vectors.reservation.input.uploadId;
  let response: unknown;
  const client = new UploadClient(request.intent.hostOrigin, {
    fetch: (async () => Response.json(response)) as typeof fetch,
  });
  for (const value of [
    {
      uploadId: id,
      state: 'receiving',
      expiresAt: 1600,
      bodyUrl: `${request.intent.hostOrigin}/v1/uploads/${id}/body`,
      headerUrl: `${request.intent.hostOrigin}/v1/uploads/${id}/header`,
    },
    { uploadId: id, state: 'reserved', reservation: vectors.reservation.input },
    {
      uploadId: id,
      state: 'published',
      result: {
        fileId: request.intent.fileId,
        url: `${request.intent.hostOrigin}/f/${request.intent.fileId.slice(2)}`,
        header: `${request.intent.hostOrigin}/f/${request.intent.fileId.slice(2)}/header`,
        expiresAt: 2000,
      },
    },
  ]) {
    response = { ...value, baseSplit: null };
    expect(await client.status(id, request)).toMatchObject({ ok: true, value });
  }
});

it.each(['filename', 'title', 'description'] as const)(
  'rejects invisible and directional characters in %s',
  async (field) => {
    const f = await fixture();
    for (const char of ['\u202e', '\u200b', '\u2028', '\u2029']) {
      expect(() =>
        parseUpload({ ...f.request, metadata: { ...f.request.metadata, [field]: `text${char}` } }),
      ).toThrow();
    }
  },
);
it('accepts checked base split status and sends the exact authenticated JSON request', async () => {
  const vectors = (await import('../../../../specs/vectors/upload.json')).default;
  const req = parseUpload(vectors.cases[0]?.request);
  const id = vectors.reservation.input.uploadId;
  const split = {
    state: 'pending',
    address: `0x${'11'.repeat(20)}`,
    kind: 'push',
    salt: `0x${'00'.repeat(32)}`,
    txHash: null,
  };
  let response: unknown;
  const client = new UploadClient(req.intent.hostOrigin, {
    fetch: (async (url, init) => {
      if (init?.method === 'POST') {
        expect(String(url)).toBe(`${req.intent.hostOrigin}/v1/uploads/${id}/base-split`);
        expect(init.headers).toMatchObject({
          'Content-Type': 'application/json',
          'Annon-Upload-Authorization': expect.any(String),
        });
        expect(JSON.parse(init.body as string)).toEqual({
          kind: 'push',
          salt: `0x${'00'.repeat(32)}`,
        });
      }
      return Response.json(response, { status: 202 });
    }) as typeof fetch,
  });
  for (const baseSplit of [
    null,
    split,
    { ...split, state: 'ready', txHash: `0x${'11'.repeat(32)}` },
  ]) {
    response = {
      uploadId: id,
      state: 'reserved',
      reservation: vectors.reservation.input,
      baseSplit,
    };
    expect(await client.status(id, req)).toMatchObject({ ok: true, value: { baseSplit } });
  }
  response = { baseSplit: split };
  expect(
    await client.baseSplit(id, req, { kind: 'push', salt: `0x${'00'.repeat(32)}` }),
  ).toMatchObject({ ok: true, value: { baseSplit: split } });
  for (const over of [
    { kind: 'pull' },
    { address: 'bad' },
    { salt: 'bad' },
    { state: 'broken' },
    { txHash: 1 },
    { txHash: 'synthetic-transaction' },
    { txHash: `0x${'AB'.repeat(32)}` },
    { txHash: `0x${'11'.repeat(31)}` },
    { extra: true },
  ]) {
    response = {
      uploadId: id,
      state: 'reserved',
      reservation: vectors.reservation.input,
      baseSplit: { ...split, ...over },
    };
    expect(await client.status(id, req)).toMatchObject({ ok: false });
  }
});

it('checks split request fields and pending versus ready HTTP status', async () => {
  const f = await fixture();
  const id = 'ab'.repeat(32);
  let status = 200;
  let state = 'pending';
  const client = new UploadClient(f.request.intent.hostOrigin, {
    fetch: (async () =>
      Response.json(
        {
          baseSplit: {
            state,
            address: `0x${'11'.repeat(20)}`,
            kind: 'push',
            salt: `0x${'00'.repeat(32)}`,
            txHash: null,
          },
        },
        { status },
      )) as typeof fetch,
  });
  const input = { kind: 'push' as const, salt: `0x${'00'.repeat(32)}` };
  for (const over of [{ kind: 'pull' }, { salt: `0x${'01'.repeat(32)}` }, { extra: true }])
    await expect(client.baseSplit(id, f.request, { ...input, ...over } as never)).rejects.toThrow();
  expect(await client.baseSplit(id, f.request, input)).toMatchObject({ ok: false });
  status = 202;
  expect(await client.baseSplit(id, f.request, input)).toMatchObject({ ok: true });
  state = 'ready';
  expect(await client.baseSplit(id, f.request, input)).toMatchObject({ ok: false });
  status = 200;
  expect(await client.baseSplit(id, f.request, input)).toMatchObject({ ok: true });
});

it.each([200, 202])(
  'rejects a successful split POST with null provenance at %s',
  async (status) => {
    const f = await fixture();
    const client = new UploadClient(f.request.intent.hostOrigin, {
      fetch: (async () => Response.json({ baseSplit: null }, { status })) as typeof fetch,
    });
    expect(
      await client.baseSplit('ab'.repeat(32), f.request, {
        kind: 'push',
        salt: `0x${'00'.repeat(32)}`,
      }),
    ).toMatchObject({ ok: false });
  },
);

it.each([200, 202])(
  'preserves a typed failure and retry hint in a %s upload response',
  async (status) => {
    const f = await fixture();
    const client = new UploadClient(f.request.intent.hostOrigin, {
      fetch: (async () =>
        Response.json(
          {
            error: 'settlement_pending',
            message: 'private upstream text',
            retryAfterSeconds: 37.2,
          },
          { status },
        )) as typeof fetch,
    });
    expect(
      await client.baseSplit('ab'.repeat(32), f.request, {
        kind: 'push',
        salt: `0x${'00'.repeat(32)}`,
      }),
    ).toMatchObject({ ok: false, error: { code: 'settlement_pending', retryAfterSeconds: 38 } });
  },
);
