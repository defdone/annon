/** Durable sponsorship admission. A later policy change cannot revoke a checked listing. */
import { type FileInfo, getFile } from '../near/rpc.js';
import { readSplitState } from '../pay/split.js';
import { type Terms, termsHash } from '../settle-near/terms.js';
import { checkProtocolFee } from './fees.js';
import type { RelayLimits, SponsorshipDecision } from './ledger.js';
import { type CheckOptions, RelayError } from './relay.js';

export const ZERO_FEE = { fixed: '0', bps: 0, treasuryNear: null, treasuryEvm: null };
export const relayLimits = (o: CheckOptions): RelayLimits => ({
  perDay: 1000,
  unlock: 500,
  unlockReserved: 500,
  unlockListedReserved: 250,
  unlocksPerFile: o.policy.unlocksPerFile ?? 10,
  unlocksPerSeller: o.policy.unlocksPerSeller ?? 20,
  listedUnlocksPerFile: o.policy.listedUnlocksPerFile ?? 100,
  listedUnlocksPerSeller: o.policy.listedUnlocksPerSeller ?? 250,
  files: o.policy.sponsoredFilesPerDay ?? 100,
  filesPerIp: 5,
  registrationsPerSeller: o.policy.registrationsPerSeller ?? 5,
  listedRegistrationsPerSeller: o.policy.listedRegistrationsPerSeller ?? 20,
  ...o.admissionLimits,
});
const now = (o: CheckOptions) => o.now ?? Math.floor(Date.now() / 1000);
export const temporary = (paid = false, retryAt = Date.now() + 30000): never => {
  const e = new RelayError(
    paid ? 'settlement_pending' : 'relayer_unavailable',
    'Sponsorship is temporarily unavailable.',
  );
  e.retryAt = retryAt;
  throw e;
};
export async function admitTerms(
  terms: Terms,
  o: CheckOptions,
  tier: SponsorshipDecision['tier'],
  skipFee = false,
): Promise<SponsorshipDecision> {
  const hash = termsHash(terms, {
    baseUsdc: o.usdc,
    ...(o.nearUsdc ? { nearUsdc: o.nearUsdc } : {}),
  });
  if (
    terms.network !== (o.network ?? 'near:mainnet') ||
    terms.contract !== o.contractId ||
    BigInt(terms.near.price) < o.policy.minPrice ||
    (terms.base &&
      (o.policy.baseSponsorship === false || BigInt(terms.base.price) < o.policy.minPrice))
  )
    throw new RelayError('not_sponsored');
  try {
    if (!skipFee && o.policy.fee) checkProtocolFee(terms, o.policy.fee);
  } catch {
    throw new RelayError('not_sponsored');
  }
  if (terms.base) {
    if (terms.near.recipients.some((r) => r.identity.kind !== 'evm'))
      throw new RelayError('not_sponsored');
    try {
      await readSplitState(o.baseRpc, terms.base.pay_to, {
        recipients: terms.near.recipients.map((r) => r.identity.id),
        allocations: terms.near.recipients.map((r) => BigInt(r.bps)),
        totalAllocation: 10000n,
        distributionIncentive: 0,
      });
    } catch (e) {
      if ((e as { code?: string })?.code === 'transport') return temporary();
      throw new RelayError('not_sponsored');
    }
  }
  return {
    network: terms.network,
    contract: terms.contract,
    fileId: terms.file_id,
    termsHash: hash,
    terms: structuredClone(terms),
    eligible: true,
    tier,
    listed: tier === 'listed',
    policyVersion: 'v1',
    minPrice: String(o.policy.minPrice),
    fee: structuredClone(skipFee ? ZERO_FEE : (o.policy.fee ?? ZERO_FEE)),
    decidedAt: now(o),
    allocated: null,
    outcome: 'registered',
  };
}

export async function checkedDecision(
  file: FileInfo,
  o: CheckOptions,
  paid = false,
): Promise<SponsorshipDecision> {
  const ledger = o.ledger;
  if (!ledger) return temporary(paid);
  const existing = await ledger.decision(file.terms.file_id, file.termsHash);
  if (existing) {
    if (existing.outcome === 'prepared')
      await ledger.registered(file.terms.file_id, file.termsHash);
    return existing;
  }
  const cutover = await ledger.cutover();
  if (!cutover) return temporary(paid);
  let historical: FileInfo | null;
  try {
    if (!o.historicalFile) {
      o.alert?.('historical_unavailable');
      return temporary(paid);
    }
    historical = await o.historicalFile(file.terms.file_id, cutover.blockHash);
  } catch {
    o.alert?.('historical_unavailable');
    return temporary(paid);
  }
  if (historical && historical.termsHash === file.termsHash) {
    const inventory = cutover.inventory.includes(file.terms.file_id);
    let decision: SponsorshipDecision;
    try {
      decision = await admitTerms(
        historical.terms,
        {
          ...o,
          policy: {
            ...o.policy,
            baseSponsorship: true,
            minPrice: BigInt(cutover.minPrice),
            fee: cutover.fee,
          },
        },
        'legacy',
        inventory,
      );
    } catch (e) {
      // Historical paid evidence cannot become a permanent refusal due to a missing policy input.
      if (paid) return temporary(true);
      throw e;
    }
    decision.policyVersion = 'legacy-v0';
    decision.listed = inventory;
    return ledger.remember(decision);
  }
  if (o.policy.baseSponsorship === false || o.policy.openPoolEnabled === false)
    return temporary(paid);
  const decision = await admitTerms(file.terms, o, 'external');
  return ledger.remember(decision);
}

export async function baseEligibility(fileId: string, hash: string, o: CheckOptions, paid = false) {
  try {
    if (!paid && o.acceptingNewBasePayments === false) return temporary();
    const file = await getFile(o.nearRpc, o.contractId, fileId);
    if (
      !file ||
      file.termsHash !== hash ||
      !file.terms.base ||
      file.takenDown ||
      (!paid && file.salesStoppedAt !== null)
    )
      throw new RelayError('not_sponsored');
    const d = await checkedDecision(file, o, paid);
    if (!paid && !(await o.ledger?.unlockAvailable(d, relayLimits(o), now(o) * 1000)))
      return temporary(false, (Math.floor(now(o) / 86400) + 1) * 86400000);
    return {
      network: d.network,
      contract: d.contract,
      fileId,
      termsHash: hash,
      eligible: true as const,
      tier: d.tier,
      policyVersion: d.policyVersion,
      minPrice: d.minPrice,
      fee: d.fee,
      decidedAt: d.decidedAt,
      checkedAt: now(o),
    };
  } catch (e) {
    if (e instanceof RelayError && e.code === 'not_sponsored')
      return {
        network: o.network ?? 'near:mainnet',
        contract: o.contractId,
        fileId,
        termsHash: hash,
        eligible: false as const,
        reason: 'not_sponsored' as const,
        tier: 'external' as const,
        policyVersion: 'v1',
        minPrice: String(o.policy.minPrice),
        fee: o.policy.fee ?? ZERO_FEE,
        decidedAt: now(o),
        checkedAt: now(o),
      };
    if (e instanceof RelayError) throw e;
    return temporary(paid);
  }
}
