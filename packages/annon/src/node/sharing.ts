import { AnnonError } from '../errors.js';
import { readShop } from '../shops/discovery.js';
import type { Config } from './config.js';

/** Hosting comes only from a selected, locally approved deployment profile. */
export async function shareHost(
  config: Config,
  id: string | undefined,
  fetcher: typeof fetch,
): Promise<string> {
  const selected = id ?? config.defaultShop;
  const shop = config.shops?.find((s) => s.id === selected || s.manifest === selected);
  if (!shop) throw new AnnonError('invalid_config');
  const endpoint = (a: string, b: string) => {
    try {
      return new URL(a).href === new URL(b).href;
    } catch {
      return false;
    }
  };
  const p = shop.profile;
  if (!p) throw new AnnonError('trust_required');
  if (
    p.contract !== config.contractId ||
    p.network !== config.network ||
    !endpoint(p.nearRpc, config.nearRpc) ||
    (p.baseRpc ? !endpoint(p.baseRpc, config.baseRpc) : config.baseRpc !== '') ||
    p.relayer !== config.relayer
  )
    throw new AnnonError('config_conflict');
  const checked = await readShop(shop, fetcher);
  return checked.info.host;
}
