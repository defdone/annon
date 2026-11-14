/** How `status` and `open` name a saved purchase without its full ID: the latest one, or a prefix. */
import { mkdir, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { EncryptedRecord } from '../pay/backup.js';
import type { Versioned } from '../pay/store.js';
import { fileStore } from '../pay/store-node.js';
import { fail, isId } from './adapter-checks.js';
import type { Input } from './cli.js';
import type { Config } from './config.js';

/**
 * What this state directory knows about one deployment: the purchase `buy` saved last, and the ID
 * of every purchase or recovery saved for it. Public IDs only; no secret is kept here.
 */
type Latest = Versioned & { purchaseId?: string; ids?: string[] };
const LATEST = 'latest-purchase';
const latestStore = (c: Config) => fileStore<Latest>(join(c.stateDir, LATEST));
/** One entry per deployment, so another contract's or network's purchase is never picked up. */
const latestKey = (c: Config) => JSON.stringify([c.network, c.contractId]);

/** IDs of the records saved in a store directory. They are stored in the clear; no secret is read. */
export async function savedRecordIds(storeDir: string): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(storeDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const ids: string[] = [];
  for (const name of names) {
    if (!/^[0-9a-f]{64}\.json$/.test(name)) continue;
    ids.push((JSON.parse(await readFile(join(storeDir, name), 'utf8')) as EncryptedRecord).id);
  }
  return ids;
}

/**
 * Lists a purchase ID under the configured deployment, and with `latest` makes it the purchase
 * `status` and `open` mean without an ID. `buy` calls it before the purchase record is saved, so a
 * paid purchase is always listed and the latest; `recover` lists what it recovered.
 */
export async function rememberPurchase(c: Config, purchaseId: string, latest = true) {
  await mkdir(join(c.stateDir, LATEST), { recursive: true, mode: 0o700 });
  const store = latestStore(c);
  const id = latestKey(c);
  // Another command of the same deployment may write in between; adding an ID is safe to repeat.
  for (let attempt = 0; attempt < 5; attempt++) {
    const before = await store.load(id);
    const ids = before?.ids ?? [];
    const pointer = latest ? purchaseId : before?.purchaseId;
    if (ids.includes(purchaseId) && pointer === before?.purchaseId) return;
    const next: Latest = {
      id,
      revision: (before?.revision ?? -1) + 1,
      ...(pointer === undefined ? {} : { purchaseId: pointer }),
      ids: ids.includes(purchaseId) ? ids : [...ids, purchaseId],
    };
    if (await store.compareAndSet(id, before, next)) return;
  }
  throw new Error('latest purchase conflict');
}

const PREFIX = /^(0x)?[0-9a-f]{8,63}$/;

async function resolve(c: Config, ref: string | undefined): Promise<string | undefined> {
  if (ref === undefined) {
    const latest = await latestStore(c).load(latestKey(c));
    return (
      latest?.purchaseId ??
      fail(
        'purchase_required',
        'No purchase has been saved by buy for this contract yet. Pass a purchase ID.',
        2,
      )
    );
  }
  if (isId(ref) || !PREFIX.test(ref)) return ref;
  const prefix = ref.startsWith('0x') ? ref : `0x${ref}`;
  const saved = new Set(
    (await savedRecordIds(join(c.stateDir, 'records')))
      .map((id) => id.replace(/^recovery:/, ''))
      .filter((id) => isId(id) && id.startsWith(prefix)),
  );
  // A saved record does not say in the clear which deployment it belongs to, and an ID says
  // nothing about it. Only the IDs listed for this network and contract can be shortened.
  const listed = new Set((await latestStore(c).load(latestKey(c)))?.ids ?? []);
  const matches = [...saved].filter((id) => listed.has(id));
  if (matches.length > 1)
    return fail(
      'purchase_required',
      'This ID prefix matches more than one saved purchase. Use more digits.',
      2,
    );
  const [only] = matches;
  if (only) return only;
  return fail(
    'purchase_required',
    saved.size > 0
      ? 'A saved purchase starts with this ID prefix, but it is not listed for this contract and network. It was saved by an older version or for another contract or network. Use the full purchase ID.'
      : 'No saved purchase starts with this ID prefix.',
    2,
  );
}

/**
 * Fills in the purchase `status` or `open` refers to. A name of 8 to 63 hex digits is always read
 * as an ID prefix; write a file with such a name as `./name`.
 */
export async function withPurchaseRef(o: Input, c: Config): Promise<Input> {
  if (o.command === 'open' && o.purchase !== undefined) {
    const purchase = await resolve(c, o.purchase);
    return purchase === undefined ? o : { ...o, purchase };
  }
  const target = await resolve(c, o.target);
  return target === undefined ? o : { ...o, target };
}
