import type { FileInfo } from '../near/rpc.js';
import { PayError } from '../pay/base.js';
import { readSplitState } from '../pay/split.js';
import { parseIdentity } from '../settle-near/identity.js';
import { termsHash } from '../settle-near/terms.js';
import { checkProtocolFee, type ProtocolFee } from './fees.js';

const MAX_JSON_BYTES = 65536;
export const BASE_ELIGIBILITY_MAX_AGE_SECONDS = 30;
export interface BaseSponsorshipOptions {
  deployment: { network: string; contractId: string; nearUsdc: string; baseUsdc: string };
  file: FileInfo;
  baseRpc: string;
  relayer: string;
  fetch?: typeof fetch;
  now?: () => number;
}
export interface BaseSponsorship {
  network: string;
  contract: string;
  fileId: string;
  termsHash: string;
  eligible: true;
  tier: 'listed' | 'pool' | 'legacy' | 'external';
  policyVersion: string;
  minPrice: string;
  fee: ProtocolFee;
  decidedAt: number;
  checkedAt: number;
  splitCheckedAt: number;
}
const issued = new WeakMap<BaseSponsorship, { binding: string; value: string }>();
const binding = (o: BaseSponsorshipOptions) =>
  JSON.stringify([
    o.deployment,
    o.file.terms,
    o.file.termsHash,
    o.file.salesStoppedAt,
    o.file.takenDown,
    o.relayer,
    o.baseRpc,
  ]);
const nowOf = (o: BaseSponsorshipOptions) => (o.now ?? (() => Math.floor(Date.now() / 1000)))();
const fresh = (at: number, now: number) =>
  Number.isSafeInteger(at) && at >= 0 && Math.abs(now - at) <= BASE_ELIGIBILITY_MAX_AGE_SECONDS;
const error = (
  code: 'not_sponsored' | 'relayer_unavailable' | 'transport_required',
  retryAfterSeconds?: number,
) =>
  Object.assign(new Error(code), {
    code,
    ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
  });
const uint = (v: unknown): v is string =>
  typeof v === 'string' && /^(0|[1-9][0-9]*)$/.test(v) && v.length <= 39 && BigInt(v) < 2n ** 128n;
function origin(value: string) {
  const u = new URL(value);
  if (
    u.protocol !== 'https:' ||
    u.username ||
    u.password ||
    u.search ||
    u.hash ||
    u.pathname !== '/'
  )
    throw error('relayer_unavailable');
  return u.origin;
}
async function boundedJson(r: Response): Promise<Record<string, unknown>> {
  if (!r.body) throw error('relayer_unavailable');
  const reader = r.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.length;
      if (size > MAX_JSON_BYTES) throw error('relayer_unavailable');
      parts.push(next.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const part of parts) {
    all.set(part, at);
    at += part.length;
  }
  const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(all));
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw error('relayer_unavailable');
  return value as Record<string, unknown>;
}
/** Only records checked here, unchanged and still bound to the same deployment and final file, can be reused. */
export function validBaseSponsorship(
  record: BaseSponsorship | undefined,
  o: BaseSponsorshipOptions,
): boolean {
  if (!record) return false;
  const saved = issued.get(record);
  const now = nowOf(o);
  return (
    !!saved &&
    saved.binding === binding(o) &&
    saved.value === JSON.stringify(record) &&
    fresh(record.checkedAt, now) &&
    record.splitCheckedAt <= now &&
    fresh(record.splitCheckedAt, now)
  );
}
/** Verify the deployed immutable split even when the caller funds its own unlock. */
export async function checkBaseSplit(file: FileInfo, baseRpc: string): Promise<void> {
  if (!baseRpc) throw error('relayer_unavailable');
  const terms = file.terms;
  if (
    !terms.base ||
    file.takenDown !== null ||
    file.salesStoppedAt !== null ||
    terms.near.recipients.some((r) => r.identity.kind !== 'evm')
  )
    throw error('not_sponsored');
  try {
    await readSplitState(baseRpc, terms.base.pay_to, {
      recipients: terms.near.recipients.map((r) => r.identity.id),
      allocations: terms.near.recipients.map((r) => BigInt(r.bps)),
      totalAllocation: 10000n,
      distributionIncentive: 0,
    });
  } catch (e) {
    if (e instanceof PayError && e.code === 'network_mismatch') throw e;
    throw error(
      e instanceof PayError && e.code !== 'transport' ? 'not_sponsored' : 'relayer_unavailable',
    );
  }
}
/** Fail closed before signatures, payment submission or release of payment instructions. */
export async function checkBaseSponsorship(o: BaseSponsorshipOptions): Promise<BaseSponsorship> {
  if (!o.relayer) throw error('transport_required');
  let retryAfterSeconds: number | undefined;
  try {
    const url = origin(o.relayer);
    const d = o.deployment;
    const t = o.file.terms;
    if (t.near.recipients.some((r) => r.identity.kind !== 'evm')) throw error('not_sponsored');
    if (
      t.network !== d.network ||
      t.contract !== d.contractId ||
      t.near.token !== d.nearUsdc ||
      t.base?.usdc !== d.baseUsdc ||
      termsHash(t, { nearUsdc: d.nearUsdc, baseUsdc: d.baseUsdc }) !== o.file.termsHash
    )
      throw error('not_sponsored');
    const fetcher = o.fetch ?? globalThis.fetch;
    const request = async (path: string, body?: object) => {
      const r = await fetcher(new URL(path, url), {
        redirect: 'error',
        credentials: 'omit',
        cache: 'no-store',
        signal: AbortSignal.timeout(20000),
        ...(body
          ? {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(body),
            }
          : {}),
      });
      const hint = r.headers.get('Retry-After');
      const seconds =
        hint && /^\d+$/.test(hint)
          ? Number(hint)
          : hint
            ? Math.ceil((Date.parse(hint) - nowOf(o) * 1000) / 1000)
            : NaN;
      if (Number.isSafeInteger(seconds) && seconds >= 0) retryAfterSeconds = Math.max(1, seconds);
      if (!r.ok) {
        await r.body?.cancel();
        throw error('relayer_unavailable', retryAfterSeconds);
      }
      return boundedJson(r);
    };
    const cap = await request('/v1/capabilities');
    if (
      cap.network !== d.network ||
      cap.contract !== d.contractId ||
      cap.nearUsdc !== d.nearUsdc ||
      cap.baseUsdc !== d.baseUsdc ||
      !Array.isArray(cap.methods) ||
      !cap.methods.includes('unlock') ||
      typeof cap.disabled !== 'boolean' ||
      typeof cap.baseSponsorship !== 'boolean' ||
      typeof cap.acceptingNewBasePayments !== 'boolean'
    )
      throw error('relayer_unavailable');
    if (cap.disabled || !cap.baseSponsorship || !cap.acceptingNewBasePayments)
      throw error('relayer_unavailable', retryAfterSeconds ?? 5);
    const v = await request('/v1/base-eligibility', {
      fileId: t.file_id,
      termsHash: o.file.termsHash,
    });
    if (
      v.network !== d.network ||
      v.contract !== d.contractId ||
      v.fileId !== t.file_id ||
      v.termsHash !== o.file.termsHash ||
      typeof v.eligible !== 'boolean'
    )
      throw error('relayer_unavailable');
    if (!v.eligible) throw error('not_sponsored');
    if (
      !['listed', 'pool', 'legacy', 'external'].includes(String(v.tier)) ||
      typeof v.policyVersion !== 'string' ||
      !v.policyVersion ||
      !uint(v.minPrice) ||
      !v.fee ||
      typeof v.fee !== 'object' ||
      !fresh(v.checkedAt as number, nowOf(o)) ||
      !Number.isSafeInteger(v.decidedAt) ||
      (v.decidedAt as number) < 0 ||
      (v.decidedAt as number) > (v.checkedAt as number)
    )
      throw error('relayer_unavailable');
    const fee = v.fee as ProtocolFee;
    if (
      !uint(fee.fixed) ||
      !Number.isSafeInteger(fee.bps) ||
      fee.bps < 0 ||
      fee.bps > 10000 ||
      !Object.hasOwn(fee, 'treasuryNear') ||
      !Object.hasOwn(fee, 'treasuryEvm')
    )
      throw error('relayer_unavailable');
    try {
      if (!t.base || BigInt(t.base.price) < BigInt(v.minPrice)) throw new Error();
      checkProtocolFee(t, fee);
    } catch {
      throw error('not_sponsored');
    }
    await checkBaseSplit(o.file, o.baseRpc);
    const checked: BaseSponsorship = {
      network: d.network,
      contract: d.contractId,
      fileId: t.file_id,
      termsHash: o.file.termsHash,
      eligible: true,
      tier: v.tier as BaseSponsorship['tier'],
      policyVersion: v.policyVersion,
      minPrice: v.minPrice,
      fee: {
        fixed: fee.fixed,
        bps: fee.bps,
        treasuryNear: fee.treasuryNear === null ? null : parseIdentity(fee.treasuryNear),
        treasuryEvm: fee.treasuryEvm === null ? null : parseIdentity(fee.treasuryEvm),
      },
      decidedAt: v.decidedAt as number,
      checkedAt: v.checkedAt as number,
      splitCheckedAt: nowOf(o),
    };
    if (!fresh(checked.checkedAt, nowOf(o))) throw error('relayer_unavailable');
    issued.set(checked, { binding: binding(o), value: JSON.stringify(checked) });
    return checked;
  } catch (e) {
    if (
      e &&
      typeof e === 'object' &&
      'code' in e &&
      ['not_sponsored', 'relayer_unavailable', 'network_mismatch'].includes(String(e.code))
    )
      throw e;
    throw error('relayer_unavailable', retryAfterSeconds);
  }
}
