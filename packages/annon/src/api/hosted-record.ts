/** The share steps per seller kind and the validation of a saved hosted sell record. */
import { parseUpload, uploadOrigin } from '../download/upload.js';
import type { SellRecord } from '../pay/backup.js';
import { checkProtocolFee } from '../relay/fees.js';
import { parseReservation } from '../relay/reservation.js';
import { bytes } from '../settle-near/codec.js';
import { type Identity, identityJson } from '../settle-near/identity.js';
import { type Terms, termsHash } from '../settle-near/terms.js';

import type { ShareStep } from './sharing-types.js';

const assets = (t: Terms) => ({
  nearUsdc: t.near.token,
  ...(t.base ? { baseUsdc: t.base.usdc } : {}),
});
const salt = `0x${'00'.repeat(32)}`;
export function shareSteps(seller: Identity): ShareStep[] {
  return seller.kind === 'near'
    ? ['stage', 'deposit', 'register', 'fund', 'publish']
    : seller.kind === 'evm'
      ? ['stage', 'split', 'register', 'publish']
      : ['stage', 'register', 'publish'];
}
/** Validate before any nested access by callers. Encryption authenticates the whole revision. */
export function validateHostedRecord(job: SellRecord): void {
  const h = job.hosting;
  if (!h) return;
  const t = job.terms;
  termsHash(t, assets(t));
  if (
    !h ||
    typeof h !== 'object' ||
    h.origin !== uploadOrigin(h.origin) ||
    !Array.isArray(h.steps) ||
    !Array.isArray(h.completed) ||
    JSON.stringify(h.steps) !== JSON.stringify(shareSteps(t.seller)) ||
    h.completed.some((s, i) => s !== h.steps[i]) ||
    h.completed.length > h.steps.length ||
    typeof h.backupConfirmed !== 'boolean'
  )
    throw new Error('Invalid hosted record.');
  if (
    t.seller.kind === 'evm' &&
    (!t.base ||
      !job.baseSplit ||
      job.baseSplit.kind !== 'push' ||
      job.baseSplit.salt !== salt ||
      job.baseSplit.address !== t.base.pay_to)
  )
    throw new Error('Invalid Base terms.');
  if (t.seller.kind === 'near' && h.fee !== null) throw new Error('Invalid direct fee.');
  if (h.fee !== null && h.fee === undefined) throw new Error('Missing fee.');
  if (h.fee) checkProtocolFee(t, h.fee);
  if (t.seller.kind !== 'evm' && (t.base !== null || job.baseSplit !== null))
    throw new Error('Invalid seller routes.');
  if (
    h.pending !== null &&
    (!h.pending ||
      h.pending.step !== h.steps[h.completed.length] ||
      typeof h.pending.token !== 'string')
  )
    throw new Error('Invalid pending operation.');
  if (h.pending?.operation && ['deposit', 'fund'].includes(h.pending.step)) {
    const { snapshot, validUntil } = h.pending;
    if (
      (h.pending.step === 'deposit' && typeof h.pending.storageAccountExisted !== 'boolean') ||
      typeof snapshot !== 'string' ||
      !/^(0|[1-9][0-9]*)$/.test(snapshot) ||
      BigInt(snapshot) >= 2n ** 128n ||
      !Number.isSafeInteger(validUntil) ||
      (validUntil ?? -1) < 0
    )
      throw new Error('Invalid funding snapshot.');
  }
  if (
    h.pending?.startedAt !== undefined &&
    (!Number.isSafeInteger(h.pending.startedAt) || h.pending.startedAt < 0)
  )
    throw new Error('Invalid operation checkpoint.');
  if (
    h.lease !== null &&
    (!h.lease || typeof h.lease.owner !== 'string' || !Number.isSafeInteger(h.lease.until))
  )
    throw new Error('Invalid lease.');
  if (h.completed.length && !h.backupConfirmed) throw new Error('Missing backup confirmation.');
  if (h.uploadId !== null && !/^[0-9a-f]{64}$/.test(h.uploadId)) throw new Error('Invalid upload.');
  const request = parseUpload({
    intent: h.intent,
    manifest: h.manifest,
    terms: t,
    metadata: h.metadata,
    auth:
      h.authorization?.auth ??
      (t.seller.kind === 'near'
        ? { kind: 'near', accountId: t.seller.id, publicKey: '', signature: '' }
        : { kind: t.seller.kind, sig: `0x${'00'.repeat(t.seller.kind === 'evm' ? 65 : 64)}` }),
  });
  if (
    request.intent.termsHash !== termsHash(t, assets(t)) ||
    request.intent.fileId !== t.file_id ||
    request.intent.cipherHash !== t.cipher_hash ||
    request.intent.hostOrigin !== h.origin ||
    identityJson(request.intent.seller) !== identityJson(t.seller)
  )
    throw new Error('Invalid hosted binding.');
  if (h.authorization && JSON.stringify(h.authorization.intent) !== JSON.stringify(h.intent))
    throw new Error('Invalid authorization binding.');
  if (
    t.seller.kind === 'near' &&
    (!h.listingStorage ||
      !job.storageBudget ||
      !/^[1-9][0-9]*$/.test(h.listingStorage) ||
      BigInt(h.listingStorage) >= 2n ** 128n)
  )
    throw new Error('Missing approved funding.');
  if (h.reservation) {
    const r = parseReservation(h.reservation);
    for (const k of [
      'fileId',
      'termsHash',
      'cipherHash',
      'metadataHash',
      'hostOrigin',
      'byteSize',
      'plaintextSize',
      'headerSize',
      'network',
      'contract',
    ] as const)
      if (r[k] !== h.intent[k]) throw new Error('Invalid reservation binding.');
    if (r.uploadId !== h.uploadId || identityJson(r.seller) !== identityJson(t.seller))
      throw new Error('Invalid reservation.');
  }
  if (
    h.split !== null &&
    (!h.split ||
      t.seller.kind !== 'evm' ||
      !['pending', 'ready'].includes(h.split.state) ||
      h.split.address.toLowerCase() !== t.base?.pay_to ||
      h.split.kind !== 'push' ||
      h.split.salt !== salt ||
      !(h.split.txHash === null || typeof h.split.txHash === 'string'))
  )
    throw new Error('Invalid split checkpoint.');
  if (h.completed.includes('split') && h.split?.state !== 'ready')
    throw new Error('Missing split confirmation.');
  if (h.result !== null) {
    const r = h.result;
    const url = `${h.origin}/f/${t.file_id.slice(2)}`;
    if (
      !r ||
      r.fileId !== t.file_id ||
      r.url !== url ||
      r.header !== `${url}/header` ||
      (r.expiresAt !== null && (!Number.isSafeInteger(r.expiresAt) || r.expiresAt <= 0)) ||
      h.completed.at(-1) !== 'publish' ||
      !h.header ||
      !job.published
    )
      throw new Error('Invalid publication.');
  }
  if (!!job.published !== (h.result !== null)) throw new Error('Invalid completion.');
  if (h.header !== null) bytes(h.header, (h.header.length - 2) / 2);
}
export { assets, salt };
