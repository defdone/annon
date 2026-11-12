import { parseIdentity } from '../../packages/annon/src/settle-near/identity.ts';
import { settings } from './settings.ts';

export function hostSettings(e: Record<string, string | undefined>) {
  const parsed = settings(e);
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
  return {
    ...parsed,
    publicUrl: origin('PUBLIC_URL'),
    relayerOrigin: origin('RELAYER_ORIGIN'),
    sellers,
    canonicalFileId,
    capacity: { ...parsed.capacity, canonicalFileId },
  };
}
export type HostSettings = ReturnType<typeof hostSettings>;
