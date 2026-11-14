import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { backupSecret, contract, fileId, purchaseRecord, workspace } from '../../test/commands.js';
import { type EncryptedRecord, encryptedPurchaseStore } from '../pay/backup.js';
import { purchaseKey } from '../pay/purchase.js';
import { fileStore } from '../pay/store-node.js';
import { createAdapter } from './adapter.js';
import type { Config } from './config.js';
import { publicError } from './errors.js';
import { rememberPurchase, withPurchaseRef } from './purchase-ref.js';

const config = (dir: string, contractId = contract) =>
  ({ stateDir: dir, network: 'near:mainnet', contractId }) as Config;

/** Saves purchase records with the given nonces and returns their IDs. */
async function saved(dir: string, nonces: string[]) {
  await mkdir(join(dir, 'records'), { recursive: true });
  const store = encryptedPurchaseStore(
    fileStore<EncryptedRecord>(join(dir, 'records')),
    backupSecret,
  );
  const ids: string[] = [];
  for (const nonce of nonces) {
    const record = purchaseRecord({ nonce });
    await store.compareAndSet(purchaseKey(record.id), null, record);
    ids.push(record.id);
  }
  return ids;
}
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
    // A second record whose ID shares the first eight hex digits.
    const twin = `${first.slice(0, 10)}${'0'.repeat(56)}`;
    await writeFile(
      join(ws.dir, 'records', `${'f'.repeat(64)}.json`),
      JSON.stringify({ id: twin, revision: 0, backup: '' }),
    );
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
