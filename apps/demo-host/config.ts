import { parseIdentity } from '../../packages/annon/src/settle-near/identity.ts';
import { settings } from './settings.ts';

export function hostSettings(e: Record<string, string | undefined>) {
  const parsed = settings(e);
  if (
    e.DEMO_RESERVATION_SIGNING_KEY !== undefined &&
    !/^[a-f0-9]{64}$/.test(e.DEMO_RESERVATION_SIGNING_KEY)
  )
    throw new Error('invalid reservation signing key');
  const origin = (key: string) => {
    const raw = e[key]?.trim();
    if (!raw) throw new Error(`${key} is required`);
    const u = new URL(raw);
    if (u.protocol !== 'https:' || u.origin !== raw || u.username || u.password)
      throw new Error(`invalid ${key}`);
    return raw;
  };
  const list = (key: string) =>
    e[key]
      ?.split(',')
      .map((v) => v.trim())
      .filter(Boolean);
  const sellers = list('SELLERS');
  if (!sellers?.length) throw new Error('SELLERS is required');
  for (const seller of sellers) {
    const index = seller.indexOf(':');
    const id = parseIdentity({ kind: seller.slice(0, index), id: seller.slice(index + 1) });
    if (`${id.kind}:${id.id}` !== seller) throw new Error('invalid SELLERS');
  }
  const canonicalFileId = e.CANONICAL_DEMO_FILE_ID;
  if (!canonicalFileId || !/^0x[0-9a-f]{64}$/.test(canonicalFileId))
    throw new Error('CANONICAL_DEMO_FILE_ID is required');
  if (e.CANONICAL_DEMO_SLUG !== undefined && e.CANONICAL_DEMO_SLUG !== 'what-we-are-building')
    throw new Error('invalid CANONICAL_DEMO_SLUG');
  const splitFee = parsed.split.enabled
    ? (() => {
        const raw = e.TREASURY_EVM?.trim();
        if (!raw) throw new Error('TREASURY_EVM is required');
        const treasuryEvm = parseIdentity({
          kind: 'evm',
          id: raw.startsWith('evm:') ? raw.slice(4) : raw,
        });
        const fixed = e.FEE_FIXED ?? '30000';
        const bps = parsed.int('FEE_BPS', 100, 100, 9999);
        if (!/^\d{1,78}$/.test(fixed) || BigInt(fixed) < 30000n)
          throw new Error('invalid FEE_FIXED');
        return { fixed, bps, treasuryNear: null, treasuryEvm };
      })()
    : undefined;
  return {
    ...parsed,
    splitFee,
    publicUrl: origin('PUBLIC_URL'),
    relayerOrigin: origin('RELAYER_ORIGIN'),
    sellers,
    canonicalFileId,
    capacity: { ...parsed.capacity, canonicalFileId },
  };
}
export type HostSettings = ReturnType<typeof hostSettings>;
