import { bls12_381 as bls } from '@noble/curves/bls12-381.js';
import { ed25519 } from '@noble/curves/ed25519.js';
import { base58, base64 } from '@scure/base';
import { privateKeyToAccount } from 'viem/accounts';
import { afterEach, expect, it, vi } from 'vitest';
import { terms as fixture, must } from '../../test/fixtures.js';
import { open } from '../envelope/pay2.js';
import { fileAppId, hashPoint } from '../keys/near-ckd.js';
import { nep413Hash } from '../near/nep413.js';
import * as rpc from '../near/rpc.js';
import { type EncryptedRecord, newBackupSecret } from '../pay/backup.js';
import { memoryStore } from '../pay/store.js';
import { bytes, hex } from '../settle-near/codec.js';
import type { Identity } from '../settle-near/identity.js';
import { type Terms, termsHash } from '../settle-near/terms.js';
import { type BrowserSaleIndex, createBrowserSeller } from './selling.js';
import {
  browserEvmWallet,
  browserNearWallet,
  browserSolanaWallet,
  signNearUpload,
} from './wallets.js';

const now = 1800000000;
const master = 12345n;
const mpc = bls.G2.Point.BASE.multiply(master);
const mpcKey = `bls12381g2:${base58.encode(mpc.toBytes(true))}`;
afterEach(() => vi.restoreAllMocks());
it.each(['evm', 'solana', 'near'] as const)(
  'browser %s controller signs exact texts, stages a Blob and publishes a usable file',
  async (kind) => {
    vi.spyOn(rpc, 'getConfig').mockResolvedValue({
      network: fixture.network,
      nearUsdc: fixture.near.token,
      usdc: must(fixture.base).usdc,
      mpc: 'mpc.synthetic.near',
      ckdDomain: 2,
    } as never);
    vi.spyOn(rpc, 'view').mockImplementation(async (_url, _contract, method) =>
      method === 'storage_balance_of' ? '0' : mpcKey,
    );
    vi.spyOn(rpc, 'isFullAccessKey').mockResolvedValue(true);
    let registered: Terms | null = null,
      publishedHash: string | null = null;
    vi.spyOn(rpc, 'getFile').mockImplementation(async () =>
      registered
        ? ({
            terms: registered,
            termsHash: termsHash(registered),
            headerHash: publishedHash,
            purchaseStorageBalance: 0n,
            seller: registered.seller,
            cipherHash: registered.cipher_hash,
            takenDown: null,
            salesStoppedAt: null,
          } as never)
        : null,
    );
    const exactTexts: string[] = [],
      direct: { method: string; deposit: bigint }[] = [];
    const key = new Uint8Array(32).fill(8),
      publicKey = ed25519.getPublicKey(key);
    const evm = privateKeyToAccount(`0x${'42'.repeat(32)}`);
    const identity: Identity =
      kind === 'evm'
        ? { kind, id: evm.address.toLowerCase() }
        : kind === 'near'
          ? { kind, id: 'seller.synthetic.near' }
          : { kind, id: hex(publicKey).slice(2) };
    const ckd = (id: string) =>
      hashPoint(mpc, fileAppId(fixture.contract, bytes(id, 32))).multiply(master);
    const answer = (id: string, sellerKey: string) => ({
      big_y: `bls12381g1:${base58.encode(bls.G1.Point.BASE.multiply(77n).toBytes(true))}`,
      big_c: `bls12381g1:${base58.encode(
        ckd(id)
          .add(bls.G1.Point.fromBytes(bytes(sellerKey, 48)).multiply(77n))
          .toBytes(true),
      )}`,
    });
    const nearProvider = {
      getAccounts: async () => [{ accountId: identity.id }],
      signMessage: async (payload: Parameters<typeof nep413Hash>[0]) => {
        expect(Object.keys(payload).sort()).toEqual(['message', 'nonce', 'recipient']);
        exactTexts.push(payload.message);
        return {
          accountId: identity.id,
          publicKey: `ed25519:${base58.encode(publicKey)}`,
          signature: base64.encode(ed25519.sign(nep413Hash(payload), key)),
        };
      },
      signAndSendTransaction: async (tx: import('./wallets.js').BrowserNearTransaction) => {
        const call = must(tx.actions[0]).functionCall;
        const args = JSON.parse(new TextDecoder().decode(call.args));
        direct.push({ method: call.methodName, deposit: call.deposit });
        let value: unknown = null;
        if (call.methodName === 'register') {
          registered = args.args.terms;
          value = answer(args.args.terms.file_id, args.args.seller_key);
        }
        if (call.methodName === 'publish_header') publishedHash = args.header_hash;
        return {
          transaction: {
            hash: `synthetic-${direct.length}`,
            signer_id: identity.id,
            receiver_id: fixture.contract,
            actions: [
              {
                FunctionCall: {
                  method_name: call.methodName,
                  args: base64.encode(new TextEncoder().encode(JSON.stringify(args))),
                },
              },
            ],
          },
          status: { SuccessValue: base64.encode(new TextEncoder().encode(JSON.stringify(value))) },
          receipts_outcome: [],
        };
      },
    };
    const wallet =
      kind === 'evm'
        ? browserEvmWallet(
            {
              request: async ({ method, params }) => {
                if (method === 'eth_accounts') return [evm.address];
                if (method === 'personal_sign') {
                  const message = must((params as string[])[0]);
                  exactTexts.push(
                    new TextDecoder().decode(bytes(message, (message.length - 2) / 2)),
                  );
                  return evm.signMessage({ message: { raw: message as `0x${string}` } });
                }
                throw new Error('Unexpected wallet operation');
              },
            },
            evm.address,
          )
        : kind === 'solana'
          ? browserSolanaWallet(
              {
                publicKey,
                signMessage: async (message) => {
                  exactTexts.push(new TextDecoder().decode(message));
                  return ed25519.sign(message, key);
                },
              },
              identity.id,
            )
          : browserNearWallet(nearProvider, identity.id);
    const uploadId = 'aa'.repeat(32);
    let request = undefined as import('../download/upload.js').UploadRequest | undefined;
    let body = undefined as Uint8Array | undefined,
      header = undefined as Uint8Array | undefined;
    let reservation: Record<string, unknown>;
    let result = null as import('../download/upload.js').UploadPublished | null;
    let split: import('../download/upload.js').UploadBaseSplit | null = null;
    const fetcher = vi.fn<typeof fetch>(async (url, options) => {
      expect(options?.credentials).toBe('omit');
      if (String(url).endsWith('/v1/uploads')) {
        request = JSON.parse(String(options?.body));
        reservation = {
          v: 1,
          uploadId,
          ...must(request).intent,
          issuedAt: now,
          expiresAt: now + 600,
          signature: 'a'.repeat(86),
        };
        delete reservation.nonce;
        return Response.json({
          uploadId,
          state: 'receiving',
          expiresAt: now + 600,
          bodyUrl: `https://host.example/v1/uploads/${uploadId}/body`,
          headerUrl: `https://host.example/v1/uploads/${uploadId}/header`,
        });
      }
      if (String(url).endsWith('/body')) {
        expect(options?.body).toBeInstanceOf(Blob);
        body = new Uint8Array(await new Response(options?.body).arrayBuffer());
        return Response.json({ uploadId, state: 'reserved', reservation });
      }
      if (String(url).endsWith('/base-split')) {
        expect(kind).toBe('evm');
        expect(JSON.parse(String(options?.body))).toEqual({
          kind: 'push',
          salt: `0x${'00'.repeat(32)}`,
        });
        split = {
          state: 'ready',
          address: must(must(request).terms.base).pay_to,
          kind: 'push',
          salt: `0x${'00'.repeat(32)}`,
          txHash: `0x${'ab'.repeat(32)}`,
        };
        return Response.json({ baseSplit: split });
      }
      if (String(url).endsWith('/header')) {
        header = new Uint8Array(options?.body as Uint8Array);
        result = {
          fileId: must(request).intent.fileId,
          url: `https://host.example/f/${must(request).intent.fileId.slice(2)}`,
          header: `https://host.example/f/${must(request).intent.fileId.slice(2)}/header`,
          expiresAt: now + 604800,
        };
        return Response.json(result, { status: 201 });
      }
      return Response.json(
        result
          ? { uploadId, state: 'published', result, baseSplit: split }
          : { uploadId, state: 'reserved', reservation, baseSplit: split },
      );
    });
    const send = vi.fn(async (method: string, envelope: object) => {
      expect(method).toBe('register');
      expect(kind).not.toBe('near');
      const a = envelope as {
        args: { terms: Terms; seller_key: string };
        hostingReservation: unknown;
      };
      expect(a.hostingReservation).toEqual(reservation);
      registered = a.args.terms;
      const value = answer(registered.file_id, a.args.seller_key);
      if (kind !== 'solana') return value;
      // Solana's transport returns the full NEAR outcome, as a relayer transport may.
      const json = (v: unknown) => base64.encode(new TextEncoder().encode(JSON.stringify(v)));
      return {
        transaction: {
          hash: 'synthetic-sponsored-register',
          signer_id: 'relay.synthetic.near',
          receiver_id: fixture.contract,
          actions: [
            {
              FunctionCall: {
                method_name: method,
                args: json({
                  args: { ...a.args, file_budget: '41000000000000000000000' },
                  auth: (envelope as { auth: unknown }).auth,
                }),
              },
            },
          ],
        },
        status: { SuccessValue: json(value) },
        receipts_outcome: [],
      };
    });
    const controllerOptions = {
      network: fixture.network,
      contractId: fixture.contract,
      nearRpc: 'https://near.example',
      baseRpc: 'https://base.example',
      host: 'https://host.example',
      rawStore: memoryStore<EncryptedRecord>(),
      indexStore: memoryStore<BrowserSaleIndex>(),
      backupSecret: newBackupSecret(),
      writeBackup: async () => {},
      fetch: fetcher,
      send,
      now: () => now,
      wallet: () => ({
        wallet,
        ...(kind === 'near'
          ? {
              signUpload: (intent: import('../download/upload.js').UploadIntent) =>
                signNearUpload(nearProvider, intent, 'https://near.example'),
            }
          : {}),
      }),
    };
    const controller = createBrowserSeller(controllerOptions);
    const plaintext = new TextEncoder().encode('file-of-value');
    const file = Object.assign(new Blob([plaintext]), { name: 'file.txt' });
    const q = await controller.quote(
      { id: 'synthetic', kind, label: 'Seller' },
      { file, title: 'File', description: '', priceUsdc: '0.10' },
    );
    expect(exactTexts).toEqual([]);
    expect(fetcher).not.toHaveBeenCalled();
    const sale = await controller.begin(q.quoteId);
    await sale.exportBackup();
    await sale.confirmBackup();
    let view = await sale.view();
    while (view.next) view = await sale.next();
    expect(view.needs).toEqual([]);
    const resumed = await createBrowserSeller(controllerOptions).active();
    expect((await must(resumed).view()).needs).toEqual([]);
    expect(view.result).toEqual({
      fileId: must(request).intent.fileId,
      url: must(result).url,
      expiresAt: now + 604800,
    });
    expect(exactTexts.map((t) => t.split('\n')[0])).toEqual(
      kind === 'near'
        ? ['Annon: reserve encrypted file hosting']
        : [
            'Annon: reserve encrypted file hosting',
            'Annon: list a file for sale',
            'Annon: publish a file',
          ],
    );
    if (kind === 'near')
      expect(direct).toEqual([
        { method: 'storage_deposit', deposit: 10n ** 22n },
        { method: 'register', deposit: 0n },
        { method: 'fund_file_storage', deposit: 5n * 10n ** 22n },
        { method: 'publish_header', deposit: 0n },
      ]);
    else expect(direct).toEqual([]);
    const full = new Uint8Array(must(header).length + must(body).length);
    full.set(must(header));
    full.set(must(body), must(header).length);
    const opened = await open(full, {
      contractId: fixture.contract,
      listing: {
        fileId: must(request).intent.fileId,
        cipherHash: must(request).intent.cipherHash,
        seller: identity,
        ...(publishedHash ? { publishedHeaderHash: publishedHash } : {}),
      },
      ckdSecret: async () => ckd(must(request).intent.fileId).toBytes(true),
    });
    expect(opened.data).toEqual(plaintext);
    for (const [, options] of fetcher.mock.calls)
      if (typeof options?.body === 'string')
        expect(options.body).not.toMatch(/fileKey|sellerSecret|ckdSecret/);
  },
);
