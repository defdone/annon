/** Synthetic workspaces, NEAR views, sealed files and purchase records for CLI command tests. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { privateKeyToAccount } from 'viem/accounts';
import { vi } from 'vitest';
import { parseHeader, SIG, sealWithKey, sha256 } from '../src/envelope/pay2.js';
import { keyFromSecret } from '../src/keys/near-ckd.js';
import type { FileInfo } from '../src/near/rpc.js';
import type { RecoveryRecord } from '../src/pay/backup.js';
import type { PurchaseRecord } from '../src/pay/purchase.js';
import { bytes, hex, usdc } from '../src/settle-near/codec.js';
import { buildPurchaseMessage, type Purchase, purchaseId } from '../src/settle-near/purchase.js';
import { NEAR_USDC, publishTextV2, type Terms, termsHash } from '../src/settle-near/terms.js';
import { terms as initial, purchase as initialPurchase } from './fixtures.js';

export const contract = initial.contract;
export const fileId = initial.file_id;
export const nearRpc = 'https://near.test';
export const backupSecret = new Uint8Array(32).fill(0xab);
export const backupSecretHex = hex(backupSecret).slice(2);
export const buyer = { kind: 'near', id: 'buyer.near' } as const;

/** A temporary state directory with a trusted human config; `remove` deletes it. */
export async function workspace(prefix: string, config: Record<string, unknown> = {}) {
  const dir = await mkdtemp(join(tmpdir(), `annon-${prefix}-`));
  const path = join(dir, 'config.json');
  await writeFile(
    path,
    JSON.stringify({
      contractId: contract,
      network: 'near:mainnet',
      nearRpc,
      stateDir: dir,
      trustContract: true,
      ...config,
    }),
  );
  return { dir, config: path, remove: () => rm(dir, { recursive: true, force: true }) };
}

type Views = Record<string, (args: Record<string, unknown>) => unknown>;

/** A fetch that answers the named NEAR view calls at `nearRpc`; other URLs go to `other`. */
export function nearViews(
  views: Views,
  other?: (url: string, init?: RequestInit) => Promise<Response | undefined> | Response | undefined,
) {
  return vi.fn<typeof fetch>(async (url, init) => {
    if (String(url) === nearRpc) {
      const q = JSON.parse(String(init?.body));
      const view = q.method === 'query' ? views[q.params.method_name] : undefined;
      if (!view) throw new Error(`Unexpected RPC call: ${q.method} ${q.params?.method_name}`);
      const args = JSON.parse(Buffer.from(q.params.args_base64, 'base64').toString('utf8'));
      return Response.json({
        jsonrpc: '2.0',
        id: q.id,
        result: { result: [...Buffer.from(JSON.stringify(view(args)))] },
      });
    }
    const reply = await other?.(String(url), init);
    if (reply) return reply;
    throw new Error(`Unexpected network access: ${String(url)}`);
  });
}

/** The contract configuration view for the fixture deployment. */
export const contractConfig = (network = initial.network) => ({
  network,
  near_usdc: NEAR_USDC,
  usdc: initial.base?.usdc,
  intents: contract,
  mpc: contract,
  ckd_domain: 2,
  foreign_tx_domain: 3,
});

/**
 * A PAY2 file sealed and signed by a synthetic EVM seller, with its registered terms. The key
 * stanza is for `contractId`; the seller signs the publish text for `signedFor` (default: the same).
 */
export async function sealedFile(
  o: { contractId?: string; signedFor?: string; content?: string } = {},
) {
  const account = privateKeyToAccount(`0x${'41'.repeat(32)}`);
  const seller = { kind: 'evm' as const, id: account.address.toLowerCase() };
  const sealed = await sealWithKey(
    new Uint8Array(32).fill(5),
    new TextEncoder().encode(o.content ?? 'sealed content'),
    { fileId: bytes(fileId, 32), name: 'file', mime: '', authKind: 0 },
  );
  const file = await sealed.finish({
    contractId: o.contractId ?? contract,
    seller,
    ckdSecret: bytes(initialPurchase.buyer_key, 48),
    sign: (text) => account.signMessage({ message: text }),
  });
  const header = file.subarray(0, parseHeader(file).headerLen);
  if (o.signedFor) {
    const signed = header.subarray(0, header.length - SIG);
    const text = publishTextV2(o.signedFor, fileId, hex(await sha256(signed)));
    header.set(bytes(await account.signMessage({ message: text }), SIG), header.length - SIG);
  }
  const terms: Terms = { ...initial, seller, cipher_hash: hex(sealed.cipherHash) };
  const info: FileInfo = {
    terms,
    termsHash: termsHash(terms),
    seller,
    cipherHash: terms.cipher_hash,
    price: BigInt(terms.near.price),
    payTo: terms.base?.pay_to ?? '',
    purchaseStorageBalance: 0n,
    moderator: null,
    headerHash: null,
    salesStoppedAt: null,
    takenDown: null,
  };
  return { file, header, headerHash: hex(await sha256(header)), terms, info, seller };
}

/** A valid saved NEAR-route purchase record for the fixture file. */
export function purchaseRecord(
  o: { headerHash?: string; nonce?: string; expiresAt?: string } = {},
): PurchaseRecord {
  const secret = new Uint8Array(32).fill(7);
  const p: Purchase = {
    version: 2,
    refund: buyer,
    network: 'near:mainnet',
    contract,
    route: 'near-usdc',
    asset: NEAR_USDC,
    file_id: fileId,
    terms_hash: initial.cipher_hash,
    price: initial.near.price,
    nonce: o.nonce ?? `0x${'44'.repeat(32)}`,
    buyer_key: hex(keyFromSecret(secret).publicKeyBytes),
    recovery: buyer,
    expires_at: o.expiresAt ?? '4000000000',
  };
  const id = purchaseId(p);
  const headerHash = o.headerHash ?? `0x${'66'.repeat(32)}`;
  return {
    schemaVersion: 2,
    recoveryProved: false,
    payment: {
      route: 'near',
      amountUsdc: usdc(BigInt(p.price)),
      amountBaseUnits: p.price,
      asset: { symbol: 'USDC', id: p.asset },
      network: p.network,
    },
    id,
    revision: 0,
    purchase: p,
    message: buildPurchaseMessage(p),
    buyerSecret: hex(secret),
    recovery: buyer,
    quote: null,
    checkedHeaderHash: headerHash,
    attempts: [],
    terms: {
      network: p.network,
      contractId: contract,
      fileId,
      buyer: buyer.id,
      seller: initial.seller,
      to: '',
      usdc: p.asset,
      price: p.price,
      buyerKey: p.buyer_key,
      nonce: p.nonce,
      headerHash,
      cipherHash: initial.cipher_hash,
      moderator: null,
    },
  };
}

/** The public payment summary the CLI reports for `purchaseRecord()`. */
export const nearPayment = {
  amountUsdc: '0.2',
  amountBaseUnits: initial.near.price,
  asset: { symbol: 'USDC', id: NEAR_USDC },
  network: 'near:mainnet',
  route: 'near',
};

/** A final recovery grant for a purchase of the fixture file. */
export function recoveryRecord(purchase: string): RecoveryRecord {
  const secret = new Uint8Array(32).fill(9);
  return {
    kind: 'recovery',
    id: `recovery:${purchase}`,
    revision: 0,
    purchase_id: purchase,
    file_id: fileId,
    recovery: buyer,
    buyerSecret: hex(secret),
    fresh_key: hex(keyFromSecret(secret).publicKeyBytes),
    nonce: hex(new Uint8Array(32)),
    grant: 0,
    deadline: 1800000000,
  };
}
