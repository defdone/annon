/** Durable encrypted upload admission and atomic publication. */

import { createHash, createPrivateKey, randomBytes, sign } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, readdir, rename, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import {
  parseUpload,
  type UploadAuthorization,
  type UploadBaseSplit,
  type UploadCreated,
  type UploadErrorCode,
  type UploadPublished,
  type UploadRequest,
  type UploadReserved,
  type UploadStatus,
  uploadText,
  verifyUpload,
  verifyUploadAuthorization,
} from '../../packages/annon/src/download/upload.ts';
import {
  checkSigned,
  equal,
  NEAR_CKD,
  nearCkd,
  sha256,
} from '../../packages/annon/src/envelope/pay2.ts';
import { AnnonError, type AnnonErrorCode } from '../../packages/annon/src/errors.ts';
import type { FileInfo } from '../../packages/annon/src/near/rpc.ts';
import { syncDir } from '../../packages/annon/src/node/sync-dir.ts';
import { hostedSplitSalt } from '../../packages/annon/src/pay/split.ts';
import type { Versioned } from '../../packages/annon/src/pay/store.ts';
import { fileStore } from '../../packages/annon/src/pay/store-node.ts';
import {
  type HostingReservation,
  reservationText,
} from '../../packages/annon/src/relay/reservation.ts';
import { hex } from '../../packages/annon/src/settle-near/codec.ts';
import { identityJson } from '../../packages/annon/src/settle-near/identity.ts';
import { type SettlementAssets, termsHash } from '../../packages/annon/src/settle-near/terms.ts';
import { type Alert, emit } from './alerts.ts';
import type { hostCapacity } from './capacity.ts';
import type { facilitatorFor } from './facilitator.ts';
import type { Loaded } from './server.ts';
import { StartupError } from './startup-errors.ts';

export class UploadFault extends AnnonError<
  Extract<UploadErrorCode, AnnonErrorCode> | 'not_sponsored'
> {
  readonly status: number;
  constructor(code: Extract<UploadErrorCode, AnnonErrorCode> | 'not_sponsored', status = 400) {
    super(code);
    this.name = 'UploadFault';
    this.status = status;
  }
}
interface Record {
  id: string;
  request: UploadRequest;
  ip: string;
  listed: boolean;
  activityAt: number;
  stagedAt?: number;
  state: 'receiving' | 'reserved' | 'publishing' | 'published' | 'expired';
  reservation?: HostingReservation;
  result?: UploadPublished;
  finalHeader?: string;
  baseSplit?: UploadBaseSplit;
}
interface State extends Versioned {
  uploads: { [id: string]: Record };
}
interface Options {
  alert?: Alert;
  splits?: Pick<ReturnType<typeof facilitatorFor>, 'deploySplit' | 'splitStatus' | 'checkSplit'>;
  dir: string;
  capacity: Awaited<ReturnType<typeof hostCapacity>>;
  network: string;
  contract: string;
  hostOrigin: string;
  nearRpc: string;
  signingKey: Uint8Array;
  sellers: readonly string[];
  now?: () => number;
  getFile(id: string): Promise<FileInfo | null>;
  assets?: SettlementAssets;
  requireState?: boolean;
  openPoolEnabled?: boolean;
  authSeconds?: number;
  reservationSeconds?: number;
  idleSeconds?: number;
  stagingSeconds?: number;
  authHeaderBytes?: number;
  maxFileBytes?: number;
  maxPay2Bytes?: number;
  maxHeaderBytes?: number;
  filenameBytes?: number;
  titleBytes?: number;
  descriptionBytes?: number;
}
export async function initUploadState(dir: string, requireState = false) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const store = fileStore<State>(dir);
  const state = await store.load('uploads');
  if (!state) {
    if (
      requireState ||
      (await readdir(dir)).some((name) => !name.endsWith('.tmp') && !name.endsWith('.lock'))
    )
      throw new StartupError('state_missing');
    if (!(await store.compareAndSet('uploads', null, { id: 'uploads', revision: 0, uploads: {} })))
      throw new StartupError('state_invalid');
  } else if (
    state.id !== 'uploads' ||
    !Number.isSafeInteger(state.revision) ||
    state.revision < 0 ||
    !state.uploads ||
    typeof state.uploads !== 'object' ||
    Array.isArray(state.uploads)
  )
    throw new StartupError('state_invalid');
}
const reply = <T>(status: number, body: T) => ({ status, body });
const remove = async (path: string) =>
  unlink(path).catch((error) => {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  });

export async function uploadService(o: Options) {
  if (o.signingKey.length !== 32) throw new TypeError('Invalid reservation signing key.');
  await initUploadState(o.dir, o.requireState);
  const privateKey = createPrivateKey({
    key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), o.signingKey]),
    format: 'der',
    type: 'pkcs8',
  });
  const store = fileStore<State>(o.dir),
    now = o.now ?? Date.now;
  const seconds = () => Math.floor(now() / 1000);
  const path = (id: string, suffix: string) => {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new UploadFault('bad_request');
    return join(o.dir, `${id}.${suffix}`);
  };
  const context = () => ({
    network: o.network,
    contract: o.contract,
    hostOrigin: o.hostOrigin,
    now: seconds(),
    nearRpc: o.nearRpc,
    ...(o.assets ? { assets: o.assets } : {}),
    ...(o.authSeconds === undefined ? {} : { authSeconds: o.authSeconds }),
  });
  const read = async () => {
    const s = await store.load('uploads');
    if (!s) throw new StartupError('state_missing');
    return s;
  };
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const p = queue.then(fn, fn);
    queue = p.catch(() => {});
    return p;
  };
  const save = async (record: Record) => {
    for (let i = 0; i < 32; i++) {
      const old = await read(),
        state = structuredClone(old);
      state.revision++;
      state.uploads[record.id] = structuredClone(record);
      if (await store.compareAndSet('uploads', old, state)) return;
    }
    throw new UploadFault('host_capacity', 503);
  };
  const erase = async (id: string) => {
    for (let i = 0; i < 32; i++) {
      const old = await read(),
        state = structuredClone(old);
      state.revision++;
      delete state.uploads[id];
      if (await store.compareAndSet('uploads', old, state)) return;
    }
    throw new UploadFault('host_capacity', 503);
  };
  const get = async (id: string) => {
    path(id, 'body');
    const r = (await read()).uploads[id];
    if (!r) throw new UploadFault('upload_expired', 410);
    return structuredClone(r);
  };
  const live = async (r: Record) => {
    if (r.state === 'expired' || (await o.capacity.expired(r.request.intent.fileId)))
      throw new UploadFault('upload_expired', 410);
    if (
      r.stagedAt !== undefined &&
      r.state !== 'published' &&
      seconds() >= r.stagedAt + (o.stagingSeconds ?? 86400)
    )
      throw new UploadFault('upload_expired', 410);
    if (r.state === 'receiving' && now() - r.activityAt >= (o.idleSeconds ?? 600) * 1000)
      throw new UploadFault('upload_expired', 410);
  };
  const immutable = (r: UploadRequest) => uploadText({ ...r.intent, expiresAt: 0 });
  const authorize = async (r: Record, auth: UploadAuthorization) => {
    await live(r);
    try {
      await verifyUploadAuthorization(auth, context());
    } catch {
      throw new UploadFault('bad_signature', 403);
    }
    if (immutable(r.request) !== immutable({ ...r.request, ...auth }))
      throw new UploadFault('upload_conflict', 409);
    return r;
  };
  const admission = (r: Record) => ({
    id: r.id,
    fileId: r.request.intent.fileId,
    slug: r.request.intent.fileId.slice(2),
    seller: identityJson(r.request.intent.seller),
    ip: r.ip,
    listed: r.listed,
    byteSize: r.request.intent.byteSize,
    bodyBytes: r.request.intent.byteSize - r.request.intent.headerSize,
    plaintextSize: r.request.intent.plaintextSize,
  });
  const reservation = async (r: Record, issuedAt = seconds()) => {
    const i = r.request.intent;
    const unsigned = {
      v: 1 as const,
      uploadId: r.id,
      network: i.network,
      contract: i.contract,
      fileId: i.fileId,
      termsHash: i.termsHash,
      seller: i.seller,
      cipherHash: i.cipherHash,
      byteSize: i.byteSize,
      plaintextSize: i.plaintextSize,
      headerSize: i.headerSize,
      metadataHash: i.metadataHash,
      hostOrigin: o.hostOrigin,
      issuedAt,
      expiresAt: issuedAt + (o.reservationSeconds ?? 600),
    };
    // Reservation lifetime is fixed by the relayer's signed format.
    if (unsigned.expiresAt !== unsigned.issuedAt + 600) throw new UploadFault('unavailable', 503);
    return {
      ...unsigned,
      signature: sign(null, Buffer.from(reservationText(unsigned), 'utf8'), privateKey).toString(
        'base64url',
      ),
    };
  };
  const created = (r: Record): UploadCreated => ({
    uploadId: r.id,
    state: 'receiving',
    expiresAt: Math.floor(r.activityAt / 1000) + (o.idleSeconds ?? 600),
    bodyUrl: `${o.hostOrigin}/v1/uploads/${r.id}/body`,
    headerUrl: `${o.hostOrigin}/v1/uploads/${r.id}/header`,
  });
  const status = (r: Record): UploadStatus =>
    r.state === 'published'
      ? {
          uploadId: r.id,
          state: 'published',
          result: r.result as UploadPublished,
          baseSplit: r.baseSplit ?? null,
        }
      : r.reservation
        ? {
            uploadId: r.id,
            state: 'reserved',
            reservation: r.reservation,
            baseSplit: r.baseSplit ?? null,
          }
        : { ...created(r), baseSplit: r.baseSplit ?? null };
  const busy = new Set<string>();
  const claim = (id: string) => {
    if (busy.has(id)) throw new UploadFault('upload_conflict', 409);
    busy.add(id);
  };
  const verifyBody = async (
    r: Record,
    source: AsyncIterable<Uint8Array>,
    write?: (piece: Uint8Array) => Promise<void>,
  ) => {
    const m = r.request.manifest,
      expected = r.request.intent.byteSize - r.request.intent.headerSize;
    let total = 0,
      index = 0,
      chunkBytes = 0,
      hash = createHash('sha256');
    const length = (i: number) =>
      i === 0
        ? m.metaLen + 16
        : i === 1 && m.previewLen > 0
          ? m.previewLen + 16
          : i === m.n - 1
            ? expected -
              m.metaLen -
              16 -
              (m.previewLen > 0 ? m.previewLen + 16 : 0) -
              Math.max(0, m.n - (m.previewLen > 0 ? 3 : 2)) * (2 ** m.chunkLog2 + 16)
            : 2 ** m.chunkLog2 + 16;
    for await (const piece of source) {
      if (write) await o.capacity.received(r.id, piece.length);
      total += piece.length;
      if (total > expected) throw new UploadFault('too_large', 413);
      let at = 0;
      while (at < piece.length) {
        const take = Math.min(piece.length - at, length(index) - chunkBytes);
        hash.update(piece.subarray(at, at + take));
        chunkBytes += take;
        at += take;
        if (chunkBytes === length(index)) {
          if (`0x${hash.digest('hex')}` !== m.chunkHashes[index])
            throw new UploadFault('cipher_hash_mismatch');
          index++;
          chunkBytes = 0;
          hash = createHash('sha256');
        }
      }
      if (write) await write(piece);
    }
    if (total !== expected || index !== m.n) throw new UploadFault('upload_incomplete');
  };
  const checkedHeader = async (r: Record, header: Uint8Array, first: boolean) => {
    const i = r.request.intent,
      m = r.request.manifest;
    if (header.length !== i.headerSize || header.length > (o.maxHeaderBytes ?? 65536))
      throw new UploadFault('too_large', 413);
    const info = await o.getFile(i.fileId);
    if (!info) throw new UploadFault('unknown_file', 404);
    if (info.takenDown !== null) throw new UploadFault('taken_down', 410);
    if (first && info.salesStoppedAt !== null) throw new UploadFault('sales_stopped', 409);
    try {
      if (
        info.termsHash !== i.termsHash ||
        termsHash(info.terms, o.assets) !== i.termsHash ||
        info.terms.file_id !== i.fileId ||
        info.terms.network !== o.network ||
        info.terms.contract !== o.contract ||
        info.terms.cipher_hash !== i.cipherHash ||
        identityJson(info.terms.seller) !== identityJson(i.seller)
      )
        throw new Error();
      const h = await checkSigned(
        new Uint8Array(header),
        {
          fileId: i.fileId,
          cipherHash: i.cipherHash,
          seller: info.terms.seller,
          pay2Version: 2,
          ...(info.headerHash ? { publishedHeaderHash: info.headerHash } : {}),
        },
        o.contract,
      );
      if (
        h.headerLen !== header.length ||
        h.chunkLog2 !== m.chunkLog2 ||
        h.metaLen !== m.metaLen ||
        h.previewLen !== m.previewLen ||
        h.n !== m.n ||
        JSON.stringify(h.commits.map(hex)) !== JSON.stringify(m.keyCommitments) ||
        JSON.stringify(h.hashes.map(hex)) !== JSON.stringify(m.chunkHashes) ||
        h.stanzas.length !== 1 ||
        h.stanzas[0]?.type !== NEAR_CKD ||
        nearCkd(h.stanzas[0].body)?.contractId !== o.contract
      )
        throw new Error();
    } catch {
      throw new UploadFault('file_invalid');
    }
    return info;
  };
  const loadedCache = new Map<string, Promise<Loaded>>();
  const loaded = (r: Record): Promise<Loaded> => {
    let entry = loadedCache.get(r.id);
    if (!entry) {
      entry = loadFile(r);
      loadedCache.set(r.id, entry);
    }
    return entry;
  };
  const loadFile = async (r: Record): Promise<Loaded> => {
    const header = Uint8Array.from(Buffer.from(r.finalHeader as string, 'base64'));
    let verification: Promise<void> | undefined;
    return {
      verify: () => {
        verification ??= verifyBody(
          r,
          createReadStream(path(r.id, 'pay2'), { start: header.length }),
        ).catch(() => {
          emit(o.alert, { type: 'host_file_invalid' });
          throw new UploadFault('unavailable', 503);
        });
        return verification;
      },
      name: r.request.intent.fileId.slice(2),
      fileId: r.request.intent.fileId,
      title: r.request.metadata.title,
      description: r.request.metadata.description,
      filename: r.request.metadata.filename,
      path: path(r.id, 'pay2'),
      size: r.request.intent.byteSize,
      plaintextSize: r.request.intent.plaintextSize,
      header,
      headerHash: hex(await sha256(header.subarray(0, header.length - 65))),
      lifecycleId: r.id,
    };
  };
  const publish = async (r: Record, header: Uint8Array) => {
    await checkedHeader(r, header, true);
    await verifyBody(r, createReadStream(path(r.id, 'body')));
    const target = path(r.id, 'pay2'),
      tmp = path(r.id, 'assembly');
    r.state = 'publishing';
    r.finalHeader = Buffer.from(header).toString('base64');
    await save(r);
    // A previous rename is reconciled only if every byte matches the checked object.
    let exists = false;
    try {
      exists = (await stat(target)).isFile();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (exists) {
      const file = await open(target, 'r');
      try {
        const prior = new Uint8Array(header.length);
        const read = await file.read(prior, 0, prior.length, 0);
        if (
          read.bytesRead !== header.length ||
          !equal(prior, header) ||
          (await file.stat()).size !== r.request.intent.byteSize
        )
          throw new UploadFault('upload_conflict', 409);
      } finally {
        await file.close();
      }
      await verifyBody(r, createReadStream(target, { start: header.length }));
    } else {
      await remove(tmp);
      const file = await open(tmp, 'wx', 0o600);
      try {
        await file.writeFile(header);
        for await (const piece of createReadStream(path(r.id, 'body'))) await file.writeFile(piece);
        if ((await file.stat()).size !== r.request.intent.byteSize)
          throw new UploadFault('upload_incomplete');
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(tmp, target);
      await syncDir(o.dir);
    }
    await o.capacity.publish(r.id);
    const life = await o.capacity.info(r.id);
    r.state = 'published';
    r.result = {
      fileId: r.request.intent.fileId,
      url: `${o.hostOrigin}/f/${r.request.intent.fileId.slice(2)}`,
      header: `${o.hostOrigin}/f/${r.request.intent.fileId.slice(2)}/header`,
      expiresAt: life?.expiresAt === null ? null : Math.floor((life?.expiresAt as number) / 1000),
    };
    await save(r);
    await remove(path(r.id, 'body'));
    await syncDir(o.dir);
    await o.capacity.releaseAssembly(r.id);
    return r.result;
  };
  const reconcile = async (r: Record) => {
    try {
      await publish(r, Uint8Array.from(Buffer.from(r.finalHeader as string, 'base64')));
    } catch (error) {
      if (
        error instanceof UploadFault &&
        ['taken_down', 'unknown_file', 'sales_stopped'].includes(error.code)
      ) {
        await o.capacity.resumePublication(r.id);
        r.state = 'reserved';
        await save(r);
      }
      // Uncertain chain reads retain the durable operation for the next sweep.
    }
  };
  const cleanup = async (active: ReadonlyMap<string, number> = new Map(), retry = true) =>
    serial(async () => {
      const removed = new Set(await o.capacity.sweep());
      const snapshot = await o.capacity.snapshot();
      for (const r of Object.values((await read()).uploads)) {
        if (busy.has(r.id)) continue;
        if (r.state === 'expired' && (!snapshot.objects[r.id] || snapshot.objects[r.id]?.removed))
          continue;
        const expired =
          removed.has(r.id) ||
          r.state === 'expired' ||
          snapshot.expiredIds.has(r.request.intent.fileId) ||
          (r.state === 'receiving' && now() - r.activityAt >= (o.idleSeconds ?? 600) * 1000) ||
          (r.stagedAt !== undefined &&
            (r.state === 'reserved' || r.state === 'publishing') &&
            seconds() >= r.stagedAt + (o.stagingSeconds ?? 86400));
        if (!expired) {
          if (retry && r.state === 'publishing') await reconcile(r);
          continue;
        }
        if (r.state !== 'expired') {
          r.state = 'expired';
          await save(r);
        }
        loadedCache.delete(r.id);
        if ((active.get(r.request.intent.fileId) ?? 0) > 0) continue;
        for (const suffix of ['body', 'part', 'assembly', 'pay2']) await remove(path(r.id, suffix));
        await o.capacity.removed(r.id);
        if (!r.reservation && !r.result && r.stagedAt === undefined) await erase(r.id);
      }
    });
  // Exclusive volume ownership is acquired by the caller before any recovery work.
  for (const [id, r] of Object.entries((await read()).uploads)) {
    if (
      !/^[a-f0-9]{64}$/.test(id) ||
      r.id !== id ||
      !['receiving', 'reserved', 'publishing', 'published', 'expired'].includes(r.state) ||
      typeof r.ip !== 'string' ||
      typeof r.listed !== 'boolean' ||
      !Number.isSafeInteger(r.activityAt) ||
      r.activityAt < 0
    )
      throw new StartupError('state_invalid');
    try {
      parseUpload(r.request);
    } catch {
      throw new StartupError('state_invalid');
    }
    if (r.state === 'receiving') {
      const hold = await o.capacity.info(id);
      if (hold?.state === 'reserved') {
        await verifyBody(r, createReadStream(path(id, 'body')));
        r.state = 'reserved';
        r.stagedAt = Math.floor((hold.issuedAt as number) / 1000);
        r.reservation = await reservation(r, r.stagedAt);
        await save(r);
      }
    }
  }
  await o.capacity.recover();
  await cleanup(new Map(), false);
  const states = Object.values((await read()).uploads);
  for (const r of states) {
    if (r.state === 'expired') continue;
    try {
      parseUpload(r.request);
    } catch {
      throw new StartupError('state_invalid');
    }
    if (r.state === 'reserved' || r.state === 'publishing') {
      try {
        await verifyBody(r, createReadStream(path(r.id, 'body')));
      } catch {
        throw new StartupError('state_invalid');
      }
    } else if (r.state === 'published') {
      const file = await loaded(r);
      const disk = await open(file.path, 'r');
      try {
        const header = new Uint8Array(file.header.length);
        const result = await disk.read(header, 0, header.length, 0);
        if (
          result.bytesRead !== header.length ||
          !equal(header, file.header) ||
          (await disk.stat()).size !== file.size
        )
          throw new StartupError('state_invalid');
      } finally {
        await disk.close();
      }
      await remove(path(r.id, 'body'));
      await syncDir(o.dir);
      await o.capacity.releaseAssembly(r.id);
    }
  }
  const known = new Set(
    states.filter((r) => r.state !== 'expired').flatMap((r) => [`${r.id}.body`, `${r.id}.pay2`]),
  );
  for (const name of await readdir(o.dir))
    if (/^[a-f0-9]{64}\.(part|assembly|body|pay2)$/.test(name) && !known.has(name))
      await remove(join(o.dir, name));
  return {
    async create(input: unknown, ip: string) {
      if (
        input &&
        typeof input === 'object' &&
        'intent' in input &&
        input.intent &&
        typeof input.intent === 'object'
      ) {
        const sizes = input.intent as {
          byteSize?: unknown;
          plaintextSize?: unknown;
          headerSize?: unknown;
        };
        for (const [key, max] of [
          ['byteSize', o.maxPay2Bytes ?? 50_086_016],
          ['plaintextSize', o.maxFileBytes ?? 50_000_000],
          ['headerSize', o.maxHeaderBytes ?? 65536],
        ] as const)
          if (typeof sizes[key] === 'number' && (sizes[key] as number) > max)
            throw new UploadFault('too_large', 413);
      }
      let req: UploadRequest;
      try {
        req = parseUpload(input);
      } catch {
        throw new UploadFault('bad_request');
      }
      try {
        await verifyUpload(req, context());
      } catch {
        throw new UploadFault('bad_signature', 403);
      }
      const i = req.intent,
        metadata = req.metadata;
      if (
        i.plaintextSize > (o.maxFileBytes ?? 50_000_000) ||
        i.byteSize > (o.maxPay2Bytes ?? 50_086_016) ||
        i.headerSize > (o.maxHeaderBytes ?? 65536) ||
        new TextEncoder().encode(metadata.filename).length > (o.filenameBytes ?? 255) ||
        new TextEncoder().encode(metadata.title).length > (o.titleBytes ?? 120) ||
        new TextEncoder().encode(metadata.description).length > (o.descriptionBytes ?? 500)
      )
        throw new UploadFault('too_large', 413);
      return serial(async () => {
        const all = Object.values((await read()).uploads);
        const key = (r: UploadRequest) =>
          JSON.stringify([
            r.intent.network,
            r.intent.contract,
            r.intent.fileId,
            r.intent.termsHash,
            r.intent.seller,
            r.intent.nonce,
          ]);
        const old = all.find((r) => key(r.request) === key(req));
        if (old) {
          if (immutable(old.request) !== immutable(req))
            throw new UploadFault('upload_conflict', 409);
          if (await o.capacity.expired(i.fileId)) throw new UploadFault('upload_expired', 410);
          if (
            (old.state === 'expired' ||
              (old.stagedAt !== undefined &&
                seconds() >= old.stagedAt + (o.stagingSeconds ?? 86400)) ||
              (old.state === 'receiving' &&
                now() - old.activityAt >= (o.idleSeconds ?? 600) * 1000)) &&
            !old.result
          ) {
            if (busy.has(old.id)) throw new UploadFault('upload_conflict', 409);
            old.state = 'receiving';
            delete old.reservation;
            delete old.stagedAt;
            delete old.finalHeader;
            old.activityAt = now();
            await o.capacity.close(old.id);
            const removed = await o.capacity.sweep();
            if (removed.includes(old.id) || (await o.capacity.info(old.id))?.state === 'expired') {
              for (const suffix of ['part', 'body', 'assembly', 'pay2'])
                await remove(path(old.id, suffix));
              await o.capacity.removed(old.id);
            }
            await o.capacity.reserve(admission(old));
          } else await live(old);
          if (busy.has(old.id)) throw new UploadFault('upload_conflict', 409);
          old.request = req;
          old.activityAt = now();
          if (old.state === 'reserved' && (old.reservation?.expiresAt ?? 0) <= seconds())
            old.reservation = await reservation(old);
          await save(old);
          return reply(200, old.state === 'receiving' ? created(old) : status(old));
        }
        if (await o.capacity.expired(i.fileId)) throw new UploadFault('upload_expired', 410);
        if (
          all.some(
            (r) => r.request.intent.fileId === i.fileId && (r.state !== 'expired' || r.result),
          )
        )
          throw new UploadFault('upload_conflict', 409);
        const listed = o.sellers.includes(`${i.seller.kind}:${i.seller.id}`);
        if (!listed && o.openPoolEnabled === false) throw new UploadFault('host_capacity', 503);
        const r: Record = {
          id: randomBytes(32).toString('hex'),
          request: req,
          ip,
          listed,
          activityAt: now(),
          state: 'receiving',
        };
        await o.capacity.reserve(admission(r));
        try {
          await save(r);
        } catch (error) {
          await o.capacity.close(r.id);
          throw error;
        }
        return reply(201, created(r));
      });
    },
    async body(
      id: string,
      auth: UploadAuthorization,
      source: AsyncIterable<Uint8Array>,
      contentLength?: string,
    ) {
      const r = await authorize(await get(id), auth);
      if (r.state === 'published') throw new UploadFault('upload_conflict', 409);
      const expected = r.request.intent.byteSize - r.request.intent.headerSize;
      if (
        contentLength !== undefined &&
        (!/^(0|[1-9][0-9]*)$/.test(contentLength) || Number(contentLength) !== expected)
      )
        throw new UploadFault('too_large', 413);
      claim(id);
      const prior = r.state === 'reserved';
      const tmp = path(id, 'part');
      try {
        if (prior) await o.capacity.begin(id, true);
        else await o.capacity.reserve(admission(r));
        await remove(tmp);
        const file = await open(tmp, 'wx', 0o600);
        try {
          await verifyBody(r, source, (piece) => file.writeFile(piece));
          await file.sync();
        } finally {
          await file.close();
        }
        if (prior) {
          await remove(tmp);
          if ((r.reservation?.expiresAt ?? 0) <= seconds()) {
            r.reservation = await reservation(r);
            await save(r);
          }
          return reply(200, {
            uploadId: id,
            state: 'reserved' as const,
            reservation: r.reservation as HostingReservation,
          });
        }
        await rename(tmp, path(id, 'body'));
        await syncDir(o.dir);
        await o.capacity.verified(id);
        r.state = 'reserved';
        r.stagedAt = seconds();
        r.reservation = await reservation(r);
        r.activityAt = now();
        await save(r);
        return reply(201, {
          uploadId: id,
          state: 'reserved' as const,
          reservation: r.reservation,
        } satisfies UploadReserved);
      } finally {
        try {
          await remove(tmp);
          if (prior) await o.capacity.end(id);
          else await o.capacity.close(id);
        } finally {
          busy.delete(id);
        }
      }
    },
    async header(id: string, auth: UploadAuthorization, header: Uint8Array) {
      const r = await authorize(await get(id), auth);
      claim(id);
      try {
        if (r.state === 'published') {
          if (r.finalHeader !== Buffer.from(header).toString('base64'))
            throw new UploadFault('upload_conflict', 409);
          return reply(200, r.result as UploadPublished);
        }
        if (r.state !== 'reserved') throw new UploadFault('upload_incomplete');
        await o.capacity.begin(id, false);
        return reply(201, await publish(r, header));
      } finally {
        try {
          await o.capacity.end(id);
        } finally {
          busy.delete(id);
        }
      }
    },
    async baseSplit(id: string, auth: UploadAuthorization, input: unknown) {
      return serial(async () => {
        const r = await authorize(await get(id), auth);
        if (
          !input ||
          typeof input !== 'object' ||
          Array.isArray(input) ||
          Object.keys(input).length !== 2 ||
          !('kind' in input) ||
          input.kind !== 'push' ||
          !('salt' in input) ||
          input.salt !== hostedSplitSalt()
        )
          throw new UploadFault('bad_request');
        if (r.state !== 'reserved' || !r.reservation) throw new UploadFault('upload_incomplete');
        if (r.reservation.expiresAt <= seconds()) throw new UploadFault('upload_expired', 410);
        if (r.request.terms.seller.kind !== 'evm' || !r.request.terms.base)
          throw new UploadFault('not_sponsored', 403);
        if (!o.splits) throw new UploadFault('disabled', 503);
        o.splits.checkSplit(r.request.terms);
        // No sponsored gas is spent unless the staged ciphertext still verifies.
        await verifyBody(r, createReadStream(path(r.id, 'body')));
        r.baseSplit = await o.splits.deploySplit(r.request.terms, async () => {
          const current = await get(id);
          await live(current);
          if (
            current.state !== 'reserved' ||
            !current.reservation ||
            current.reservation.expiresAt <= seconds()
          )
            throw new UploadFault('upload_expired', 410);
        });
        await save(r);
        return reply(r.baseSplit.state === 'ready' ? 200 : 202, { baseSplit: r.baseSplit });
      });
    },
    async status(id: string, auth: UploadAuthorization) {
      const r = await authorize(await get(id), auth);
      if (r.request.terms.base && r.state !== 'receiving' && o.splits) {
        try {
          const checked = await o.splits.splitStatus(r.request.terms);
          if (checked) r.baseSplit = checked;
        } catch {
          // Preserve saved deployment evidence when current policy or chain reads refuse it.
        }
      }
      return reply(200, status(r));
    },
    async reservation(id: string) {
      const r = await get(id);
      await live(r);
      if (r.state !== 'reserved' || !r.reservation) throw new UploadFault('upload_incomplete');
      if (r.reservation.expiresAt <= seconds()) throw new UploadFault('upload_expired', 410);
      return {
        state: 'reserved',
        fileId: r.request.intent.fileId,
        termsHash: r.request.intent.termsHash,
        expiresAt: r.reservation.expiresAt,
        reservation: r.reservation,
      };
    },
    async files(snapshot?: Awaited<ReturnType<typeof o.capacity.snapshot>>) {
      const expired = (snapshot ?? (await o.capacity.snapshot())).expiredIds;
      return Promise.all(
        Object.values((await read()).uploads)
          .filter((r) => r.state === 'published')
          .map(async (r) => (expired.has(r.request.intent.fileId) ? null : loaded(r))),
      ).then((files) => files.filter((f) => f !== null));
    },
    cleanup,
  };
}
