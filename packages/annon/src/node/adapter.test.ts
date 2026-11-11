import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { privateKeyToAccount } from 'viem/accounts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { purchase as initial, terms as initialTerms, must } from '../../test/fixtures.js';
import { Annon } from '../api/annon.js';
import { serveFile } from '../download/host.js';
import { parseHeader, sealWithKey, sha256 } from '../envelope/pay2.js';
import { keyFromSecret } from '../keys/near-ckd.js';
import * as nearRpc from '../near/rpc.js';
import { type EncryptedRecord, encryptedPurchaseStore } from '../pay/backup.js';
import type { PurchaseRecord } from '../pay/purchase.js';
import { purchaseKey } from '../pay/purchase.js';
import { nextStep } from '../pay/recover.js';
import type { SellerRecord } from '../pay/settle.js';
import { memoryStore } from '../pay/store.js';
import { fileStore } from '../pay/store-node.js';
import { bytes, hex } from '../settle-near/codec.js';
import { baseNonceV2, buildPurchaseMessage, purchaseId } from '../settle-near/purchase.js';
import { termsHash } from '../settle-near/terms.js';
import { createAdapter, retryAfterMs } from './adapter.js';
import { runCli } from './cli.js';
import { publicError } from './errors.js';

// Base finality/log discovery has its own real-RPC-fixture tests. Here it supplies a paid
// result so the real SDK accept(), adapter and grant-enforcing host meet at their boundary.
vi.mock('../pay/recover.js', () => ({ nextStep: vi.fn() }));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
it.each([
  {
    command: 'open',
    transport: 'wallet',
    refusals: 0,
    code: 'payment_not_safe',
    json: false,
    agent: false,
  },
  {
    command: 'status',
    transport: 'wallet',
    refusals: 0,
    code: 'payment_not_safe',
    json: false,
    agent: false,
  },
  {
    command: 'open',
    transport: 'relayer',
    refusals: 2,
    code: 'payment_not_safe',
    json: false,
    agent: false,
  },
  {
    command: 'open',
    transport: 'relayer',
    refusals: 2,
    code: 'payment_not_safe',
    json: true,
    agent: false,
  },
  {
    command: 'open',
    transport: 'relayer',
    refusals: 2,
    code: 'payment_not_safe',
    json: false,
    agent: true,
  },
  {
    command: 'status',
    transport: 'relayer',
    refusals: 2,
    code: 'payment_not_safe',
    json: false,
    agent: false,
  },
  {
    command: 'status',
    transport: 'relayer',
    refusals: 2,
    code: 'payment_not_safe',
    json: true,
    agent: false,
  },
  {
    command: 'open',
    transport: 'relayer',
    refusals: 100,
    code: 'payment_not_safe',
    json: false,
    agent: false,
  },
  {
    command: 'open',
    transport: 'relayer',
    refusals: 2,
    code: 'in_flight',
    json: true,
    agent: false,
  },
] as const)(
  'resumes paid Base $command via $transport with $refusals $code replies (JSON $json, agent $agent)',
  async ({ command, transport, refusals, code, json, agent }) => {
    const dir = await mkdtemp(join(tmpdir(), 'annon-base-host-'));
    const signer = privateKeyToAccount(`0x${'42'.repeat(32)}`);
    const identity = { kind: 'evm' as const, id: signer.address.toLowerCase() };
    const secret = new Uint8Array(32).fill(7);
    const data = new TextEncoder().encode('bought content');
    const s = await sealWithKey(new Uint8Array(32).fill(5), data, {
      fileId: bytes(initialTerms.file_id, 32),
      name: 'f',
      mime: '',
      authKind: 0,
    });
    const file = await s.finish({
      contractId: initialTerms.contract,
      ckdSecret: keyFromSecret(secret).publicKeyBytes,
      seller: identity,
      sign: (text) => signer.signMessage({ message: text }),
    });
    const header = file.subarray(0, parseHeader(file).headerLen);
    const terms = { ...initialTerms, seller: identity, cipher_hash: hex(s.cipherHash) };
    const p = {
      ...initial,
      terms_hash: termsHash(terms),
      buyer_key: hex(keyFromSecret(secret).publicKeyBytes),
    };
    const id = purchaseId(p);
    const hash = hex(await sha256(header));
    const record: PurchaseRecord = {
      schemaVersion: 2,
      id,
      revision: 0,
      purchase: p,
      message: buildPurchaseMessage(p),
      buyerSecret: hex(secret),
      recovery: p.recovery,
      quote: null,
      checkedHeaderHash: hash,
      attempts: [],
      terms: {
        network: p.network,
        contractId: p.contract,
        fileId: p.file_id,
        buyer: identity.id,
        seller: identity,
        to: must(terms.base).pay_to,
        usdc: p.asset,
        price: p.price,
        buyerKey: p.buyer_key,
        nonce: baseNonceV2(id),
        headerHash: hash,
        cipherHash: terms.cipher_hash,
        moderator: null,
      },
    };
    const backupSecret = new Uint8Array(32).fill(0xab);
    await mkdir(join(dir, 'records'));
    const store = encryptedPurchaseStore(
      fileStore<EncryptedRecord>(join(dir, 'records')),
      backupSecret,
    );
    await store.compareAndSet(purchaseKey(id), null, record);
    let accepted = false;
    const order: string[] = [];
    const host = {
      nearRpc: 'https://near.rpc',
      baseRpc: 'https://base.rpc',
      contractId: terms.contract,
      fileId: terms.file_id,
      url: 'https://files.example/f',
      header: 'https://files.example/header',
      headerHash: hash,
      store: memoryStore<SellerRecord>(),
      facilitator: vi.fn(),
      file: {
        size: file.length,
        read: (start: number) =>
          new ReadableStream<Uint8Array>({
            start(c) {
              c.enqueue(file.subarray(start));
              c.close();
            },
          }),
      },
    };
    let relayCalls = 0;
    const fetcher = vi.fn<typeof fetch>(async (url, init) => {
      if (String(url).startsWith('https://relay.example')) {
        relayCalls++;
        if (relayCalls <= refusals)
          return code === 'in_flight'
            ? Response.json({ pending: true }, { status: 202 })
            : Response.json({ error: code, message: 'PRIVATE_UPSTREAM' }, { status: 425 });
        accepted = true;
        order.push('unlock');
        return Response.json({ txHash: 'stub-transaction', signer: 'stub.near' });
      }
      if (String(url).endsWith('/header')) return new Response(header);
      if (String(url).startsWith('https://files.example')) {
        order.push('download');
        const r = await serveFile({ headers: new Headers(init?.headers) }, host);
        return new Response(r.body, { status: r.status, headers: r.headers });
      }
      const q = JSON.parse(String(init?.body));
      const method = q.params.method_name;
      const value =
        method === 'get_file'
          ? {
              terms,
              terms_hash: termsHash(terms),
              header_hash: null,
              sales_stopped_at: null,
              taken_down: null,
            }
          : method === 'get_purchase'
            ? accepted
              ? {
                  purchase_id: id,
                  file_id: p.file_id,
                  terms_hash: p.terms_hash,
                  recovery: p.recovery,
                  buyer_key: p.buyer_key,
                  route: 'base-usdc',
                  delivery: null,
                  accepted_at: 1,
                  grants: 1,
                }
              : null
            : method === 'get_grant'
              ? accepted
                ? { purchase_id: id, grant: 0, buyer_key: p.buyer_key }
                : null
              : null;
      return Response.json({
        id: q.id,
        result: { result: [...Buffer.from(JSON.stringify(value))] },
      });
    });
    vi.stubGlobal('fetch', fetcher);
    vi.mocked(nextStep).mockResolvedValue({
      step: 'unlock',
      args: { purchase: record.message, logs: [], header: null },
    });
    const call = vi.fn(async ({ method }: { method: string }) => {
      expect(method).toBe('unlock');
      order.push('unlock');
      accepted = true;
      return null;
    });
    vi.spyOn(nearRpc, 'txOutcome').mockResolvedValue({
      state: 'done',
      method: 'unlock',
      value: null,
      events: [],
    });
    const wait = vi.fn(async (_ms: number) => {});
    const notify = vi.fn();
    const adapter = createAdapter(
      {
        ANNON_BACKUP_SECRET: hex(backupSecret).slice(2),
        ANNON_CONFIG: join(dir, 'none'),
        ANNON_STATE_DIR: dir,
        ...(transport === 'wallet' ? { ANNON_WALLET: 'near' } : {}),
      },
      {
        fetch: fetcher,
        agent,
        wait,
        notify,
        wallet: async () => ({
          identity: { kind: 'near', id: 'gas.near' },
          call,
          authorize: vi.fn(),
          transferPurchase: vi.fn(),
        }),
        sdk(options) {
          const sdk = new Annon(options);
          vi.spyOn(sdk, 'open').mockImplementation(async (o) => {
            expect(o.file).toEqual(file);
            return { meta: { name: 'f', mime: '', size: data.length }, data };
          });
          return sdk;
        },
      },
    );
    try {
      expect((await serveFile({ headers: new Headers() }, host)).status).toBe(402);
      const input = {
        command,
        json,
        relayer: 'https://relay.example',
        target: id,
        contractId: terms.contract,
        nearRpc: host.nearRpc,
        baseRpc: host.baseRpc,
        ...(agent ? {} : { stateDir: dir }),
        config: join(dir, 'none'),
        trustContract: true,
        url: host.url,
        output: join(dir, 'out'),
      };
      const immediate =
        code === 'payment_not_safe' && refusals > 0 && (command !== 'open' || json || agent);
      if (immediate || refusals === 100) {
        const printed: string[] = [];
        const exit = await runCli(
          [command, id, ...(json ? ['--json'] : [])],
          () => adapter(input),
          (text) => printed.push(text),
        );
        expect(exit).toBe(command === 'status' ? 4 : 1);
        expect(JSON.parse(must(printed[0]))).toMatchObject({
          ok: false,
          error: {
            code: 'payment_not_safe',
            message: publicError({ code: 'payment_not_safe' }).message,
          },
        });
        expect(printed.join('')).not.toContain('PRIVATE_UPSTREAM');
        expect(relayCalls).toBe(immediate ? 1 : 6);
        expect(wait.mock.calls).toEqual(
          immediate ? [] : [[10000], [20000], [30000], [40000], [60000]],
        );
        expect(notify).toHaveBeenCalledTimes(immediate ? 0 : 5);
        expect(order).not.toContain('download');
        return;
      }
      const result = await adapter(input);
      expect(wait.mock.calls).toEqual(
        refusals === 0 ? [] : code === 'in_flight' ? [[5000], [5000]] : [[10000], [20000]],
      );
      expect(notify).toHaveBeenCalledTimes(json ? 0 : refusals);
      expect(accepted).toBe(true);
      expect(order[0]).toBe('unlock');
      expect(call).toHaveBeenCalledTimes(transport === 'wallet' ? 1 : 0);
      if (transport === 'relayer') expect(relayCalls).toBe(refusals + 1);
      if (command === 'open') {
        expect(result.bytes).toBe(data.length);
        expect(order).toContain('download');
      } else expect(result.state).toBe('accepted');
      expect(host.facilitator).not.toHaveBeenCalled();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);

describe('retryAfterMs', () => {
  it('reads seconds and dates, defaults to 5 s and refuses waits over a minute', () => {
    const now = Date.parse('2026-11-11T12:00:00Z');
    expect(retryAfterMs(null, now)).toBe(5000);
    expect(retryAfterMs('soon', now)).toBe(5000);
    expect(retryAfterMs('7', now)).toBe(7000);
    expect(retryAfterMs('60', now)).toBe(60_000);
    expect(retryAfterMs('61', now)).toBeNull();
    expect(retryAfterMs('Wed, 11 Nov 2026 12:00:30 GMT', now)).toBe(30_000);
    expect(retryAfterMs('Wed, 11 Nov 2026 11:59:00 GMT', now)).toBe(0);
    expect(retryAfterMs('Wed, 11 Nov 2026 13:00:00 GMT', now)).toBeNull();
  });
});
