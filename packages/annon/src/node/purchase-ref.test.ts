import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import {
  backupSecret,
  backupSecretHex,
  buyer,
  contract,
  fileId,
  purchaseRecord,
  recoveryRecord,
  workspace,
} from '../../test/commands.js';
import { Annon } from '../api/annon.js';
import {
  type EncryptedRecord,
  encryptedPurchaseStore,
  encryptedRecoveryStore,
} from '../pay/backup.js';
import { purchaseKey } from '../pay/purchase.js';
import { fileStore } from '../pay/store-node.js';
import { createAdapter } from './adapter.js';
import type { Config } from './config.js';
import { publicError } from './errors.js';
import { rememberPurchase, withPurchaseRef } from './purchase-ref.js';

const config = (dir: string, contractId = contract, network = 'near:mainnet') =>
  ({ stateDir: dir, network, contractId }) as Config;

/**
 * Saves encrypted purchase records with the given nonces and returns their IDs. They are listed
 * under `listed` as a buy lists them, without becoming the latest; null saves them unlisted, as
 * a version before the list did.
 */
async function saved(
  dir: string,
  nonces: string[],
  listed: Config | null = config(dir),
  base = false,
) {
  await mkdir(join(dir, 'records'), { recursive: true });
  const store = encryptedPurchaseStore(
    fileStore<EncryptedRecord>(join(dir, 'records')),
    backupSecret,
  );
  const ids: string[] = [];
  for (const nonce of nonces) {
    const record = purchaseRecord({ nonce, base });
    await store.compareAndSet(purchaseKey(record.id), null, record);
    if (listed) await rememberPurchase(listed, record.id, false);
    ids.push(record.id);
  }
  return ids;
}
/** Saves an encrypted recovery record for a purchase ID and lists it as `recover` does. */
async function recovered(dir: string, purchase: string, listed: Config) {
  const store = encryptedRecoveryStore(
    fileStore<EncryptedRecord>(join(dir, 'records')),
    backupSecret,
  );
  await store.compareAndSet(`annon/recovery/${purchase}`, null, recoveryRecord(purchase));
  await rememberPurchase(listed, purchase, false);
}
/** A different ID that shares the first `digits` hex digits. */
const twin = (id: string, fill: string, digits = 8) =>
  `${id.slice(0, 2 + digits)}${fill.repeat(64 - digits)}`;
const nonce = (byte: string) => `0x${byte.repeat(32)}`;

it('status accepts a unique ID prefix with or without 0x and answers with the full ID', async () => {
  const ws = await workspace('ref-prefix');
  const purchase = vi.fn(async () => ({ file_id: fileId, grants: [] }) as never);
  try {
    const [first] = (await saved(ws.dir, [nonce('44'), nonce('55')])) as [string];
    const run = createAdapter({ ANNON_CONFIG: ws.config }, { purchase });
    for (const target of [first.slice(0, 10), first.slice(2, 10), first])
      expect(await run({ command: 'status', target })).toMatchObject({
        purchaseId: first,
        state: 'accepted',
      });
    expect(purchase).toHaveBeenLastCalledWith('https://near.test', contract, first);
  } finally {
    await ws.remove();
  }
});

it('a prefix that is too short, unknown or shared by two purchases is refused before any lookup', async () => {
  const ws = await workspace('ref-refused');
  const purchase = vi.fn();
  try {
    const [first] = (await saved(ws.dir, [nonce('44')])) as [string];
    // A second record of the same contract whose ID shares the first eight hex digits.
    const second = twin(first, '0');
    await writeFile(
      join(ws.dir, 'records', `${'f'.repeat(64)}.json`),
      JSON.stringify({ id: second, revision: 0, backup: '' }),
    );
    await rememberPurchase(config(ws.dir), second, false);
    const run = createAdapter({ ANNON_CONFIG: ws.config }, { purchase });
    const refused = async (target: string) =>
      publicError(await run({ command: 'status', target }).catch((e) => e));
    expect(await refused(first.slice(0, 10))).toEqual({
      code: 'purchase_required',
      message: 'This ID prefix matches more than one saved purchase. Use more digits.',
      exitCode: 2,
    });
    expect(await refused('0xdeadbeef')).toMatchObject({
      code: 'purchase_required',
      message: 'No saved purchase starts with this ID prefix.',
      exitCode: 2,
    });
    // Seven digits are not a prefix: the argument stays an invalid ID.
    expect(await refused(first.slice(0, 9))).toMatchObject({ code: 'invalid_arguments' });
    expect(purchase).not.toHaveBeenCalled();
    // More digits tell the two apart again.
    purchase.mockResolvedValue({ file_id: fileId, grants: [] });
    expect(await run({ command: 'status', target: first.slice(0, 12) })).toMatchObject({
      purchaseId: first,
    });
  } finally {
    await ws.remove();
  }
});

it("without an ID the latest purchase of this contract is used, and never another contract's", async () => {
  const ws = await workspace('ref-latest');
  const purchase = vi.fn(async () => ({ file_id: fileId, grants: [] }) as never);
  try {
    const run = createAdapter({ ANNON_CONFIG: ws.config }, { purchase });
    const none = publicError(await run({ command: 'status' }).catch((e) => e));
    expect(none).toMatchObject({ code: 'purchase_required', exitCode: 2 });
    const [first, second] = (await saved(ws.dir, [nonce('44'), nonce('55')])) as [string, string];
    await rememberPurchase(config(ws.dir, 'other.near'), second);
    expect(publicError(await run({ command: 'status' }).catch((e) => e)).code).toBe(
      'purchase_required',
    );
    await rememberPurchase(config(ws.dir), first);
    expect(await run({ command: 'status' })).toMatchObject({ purchaseId: first });
    await rememberPurchase(config(ws.dir), second);
    expect(await run({ command: 'status' })).toMatchObject({ purchaseId: second });
  } finally {
    await ws.remove();
  }
});

it('open resolves --purchase or the target, and leaves file names and backups alone', async () => {
  const ws = await workspace('ref-open');
  try {
    const [first] = (await saved(ws.dir, [nonce('44')])) as [string];
    const c = config(ws.dir);
    await rememberPurchase(c, first);
    const prefix = first.slice(0, 12);
    expect(await withPurchaseRef({ command: 'open', output: 'o' }, c)).toMatchObject({
      target: first,
    });
    expect(await withPurchaseRef({ command: 'open', target: prefix }, c)).toMatchObject({
      target: first,
    });
    expect(
      await withPurchaseRef({ command: 'open', target: 'file.pay2', purchase: prefix }, c),
    ).toEqual({ command: 'open', target: 'file.pay2', purchase: first });
    for (const target of ['./deadbeef12', '/private/backup.json', 'report.pay2'])
      expect(await withPurchaseRef({ command: 'open', target }, c)).toEqual({
        command: 'open',
        target,
      });
  } finally {
    await ws.remove();
  }
});

it('agent mode keeps requiring the full purchase ID', async () => {
  const ws = await workspace('ref-agent', { workDir: '/tmp', maxPrice: '1', dailyBudget: '1' });
  const purchase = vi.fn();
  try {
    const [first] = (await saved(ws.dir, [nonce('44')])) as [string];
    await rememberPurchase(config(ws.dir), first);
    const run = createAdapter({ ANNON_CONFIG: ws.config }, { agent: true, purchase });
    for (const target of [undefined, first.slice(0, 12)]) {
      const error = await run({ command: 'status', ...(target ? { target } : {}) }).catch((e) => e);
      expect(publicError(error)).toMatchObject({ code: 'invalid_arguments', exitCode: 2 });
    }
    expect(purchase).not.toHaveBeenCalled();
  } finally {
    await ws.remove();
  }
});

const UNLISTED =
  'A saved purchase starts with this ID prefix, but it is not listed for this contract and network. It was saved by an older version or for another contract or network. Use the full purchase ID.';
const refusal = async (o: Parameters<typeof withPurchaseRef>[0], c: Config) =>
  publicError(await withPurchaseRef(o, c).catch((e) => e));

it.each([
  { contractId: 'other.near', network: 'near:mainnet' },
  { contractId: contract, network: 'near:testnet' },
])('a prefix never names a purchase saved for another deployment: %j', async (elsewhere) => {
  const ws = await workspace('ref-scope');
  try {
    const [first] = (await saved(ws.dir, [nonce('44')])) as [string];
    const target = first.slice(0, 12);
    const there = config(ws.dir, elsewhere.contractId, elsewhere.network);
    for (const o of [
      { command: 'status', target } as const,
      { command: 'open', target, output: 'o' } as const,
      { command: 'open', target: 'file.pay2', purchase: target } as const,
    ])
      expect(await refusal(o, there)).toEqual({
        code: 'purchase_required',
        message: UNLISTED,
        exitCode: 2,
      });
    // The full ID is passed on as typed; the commands check the record itself.
    expect(await withPurchaseRef({ command: 'status', target: first }, there)).toEqual({
      command: 'status',
      target: first,
    });
    expect(await withPurchaseRef({ command: 'status', target }, config(ws.dir))).toEqual({
      command: 'status',
      target: first,
    });
  } finally {
    await ws.remove();
  }
});

it('a record saved before IDs were listed per contract needs its full ID', async () => {
  const ws = await workspace('ref-unlisted');
  try {
    const [old] = (await saved(ws.dir, [nonce('44')], null)) as [string];
    const c = config(ws.dir);
    expect(await refusal({ command: 'status', target: old.slice(0, 12) }, c)).toMatchObject({
      code: 'purchase_required',
      message: UNLISTED,
    });
    expect(await withPurchaseRef({ command: 'status', target: old }, c)).toMatchObject({
      target: old,
    });
    // An ID listed for the contract with no saved record is not a saved purchase either.
    await rememberPurchase(c, `0xfeedbeef${'0'.repeat(56)}`);
    expect(await refusal({ command: 'status', target: 'feedbeef' }, c)).toMatchObject({
      message: 'No saved purchase starts with this ID prefix.',
    });
  } finally {
    await ws.remove();
  }
});

it('the same prefix names a different purchase under each contract and network', async () => {
  const ws = await workspace('ref-twins');
  try {
    const here = config(ws.dir);
    const otherContract = config(ws.dir, 'other.near');
    const otherNetwork = config(ws.dir, contract, 'near:testnet');
    // A Base purchase here, a recovery under another contract, a NEAR purchase on another network.
    const [base] = (await saved(ws.dir, [nonce('44')], here, true)) as [string];
    const prefix = base.slice(0, 10);
    const recovery = twin(base, '1');
    await recovered(ws.dir, recovery, otherContract);
    const near = twin(base, '2');
    await writeFile(
      join(ws.dir, 'records', `${'e'.repeat(64)}.json`),
      JSON.stringify({ id: near, revision: 0, backup: '' }),
    );
    await rememberPurchase(otherNetwork, near, false);
    const named = async (c: Config) =>
      (await withPurchaseRef({ command: 'status', target: prefix }, c)).target;
    expect(await named(here)).toBe(base);
    expect(await named(otherContract)).toBe(recovery);
    expect(await named(otherNetwork)).toBe(near);
    expect(
      await refusal(
        { command: 'status', target: prefix },
        config(ws.dir, 'other.near', 'near:testnet'),
      ),
    ).toMatchObject({ code: 'purchase_required', message: UNLISTED });
    // Listing never changes the latest purchase of a contract, and each keeps its own.
    expect((await refusal({ command: 'status' }, otherContract)).code).toBe('purchase_required');
    await rememberPurchase(here, base);
    await rememberPurchase(otherNetwork, near);
    expect((await withPurchaseRef({ command: 'status' }, here)).target).toBe(base);
    expect((await withPurchaseRef({ command: 'status' }, otherNetwork)).target).toBe(near);
    // Only purchases of the same contract and network make a prefix ambiguous.
    await recovered(ws.dir, twin(base, '3'), here);
    expect(await refusal({ command: 'status', target: prefix }, here)).toMatchObject({
      message: 'This ID prefix matches more than one saved purchase. Use more digits.',
    });
    expect(await named(otherContract)).toBe(recovery);
    expect((await withPurchaseRef({ command: 'status' }, here)).target).toBe(base);
  } finally {
    await ws.remove();
  }
});

it('recover lists what it recovered for this contract and leaves the latest purchase alone', async () => {
  const ws = await workspace('ref-recover');
  const purchase = vi.fn(async () => ({ file_id: fileId, grants: [] }) as never);
  const id = `0x${'77'.repeat(32)}`;
  try {
    await mkdir(join(ws.dir, 'records'));
    const run = createAdapter(
      { ANNON_CONFIG: ws.config, ANNON_BACKUP_SECRET: backupSecretHex },
      {
        purchase,
        wallet: async () => ({ identity: buyer, authorize: vi.fn() }),
        sdk: (options) => {
          const sdk = new Annon(options);
          vi.spyOn(sdk, 'recover').mockImplementation(async () => {
            const store = encryptedRecoveryStore(options.rawStore, backupSecret);
            await store.compareAndSet(`annon/recovery/${id}`, null, recoveryRecord(id));
            return [recoveryRecord(id)];
          });
          return sdk;
        },
      },
    );
    await run({ command: 'recover', recovery: 'near:buyer.near' });
    expect(await run({ command: 'status', target: id.slice(0, 10) })).toMatchObject({
      purchaseId: id,
    });
    expect(publicError(await run({ command: 'status' }).catch((e) => e)).code).toBe(
      'purchase_required',
    );
    expect(
      await refusal({ command: 'status', target: id.slice(0, 10) }, config(ws.dir, 'other.near')),
    ).toMatchObject({ message: UNLISTED });
  } finally {
    await ws.remove();
  }
});
