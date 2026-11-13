import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { privateKeyToAccount } = createRequire(
  new URL('../../packages/annon/package.json', import.meta.url),
)('viem/accounts');

import { afterEach, expect, it, vi } from 'vitest';
import * as rpc from '../../packages/annon/src/near/rpc.ts';
import { fileFundingText } from '../../packages/annon/src/near/texts.ts';
import { createAdapter } from '../../packages/annon/src/node/adapter.ts';
import { memoryStore } from '../../packages/annon/src/pay/store.ts';
import { RelayLedger } from '../../packages/annon/src/relay/ledger.ts';
import { resetRelayState } from '../../packages/annon/src/relay/relay.ts';
import { termsHash } from '../../packages/annon/src/settle-near/terms.ts';
import { terms as initial, must } from '../../packages/annon/test/fixtures.ts';
import { type Config, handle } from './server.ts';

const created = vi.hoisted(() => vi.fn());
vi.mock('../../packages/annon/node_modules/near-api-js/lib/index.js', async (original) => ({
  ...(await original<
    typeof import('../../packages/annon/node_modules/near-api-js/lib/index.js')
  >()),
  Account: class {
    createSignedTransaction = created;
  },
  encodeTransaction: () => new Uint8Array([1, 2, 3]),
}));
afterEach(() => {
  vi.restoreAllMocks();
  resetRelayState();
});
it('CLI funding reaches the real relayer with the exact seller-signed envelope and stripped contract args', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'annon-funding-client-'));
  try {
    const account = privateKeyToAccount(`0x${'44'.repeat(32)}`);
    const seller = { kind: 'evm' as const, id: account.address.toLowerCase() };
    const terms = { ...initial, seller };
    const hash = termsHash(terms);
    const file = {
      terms,
      seller,
      termsHash: hash,
      takenDown: null,
      salesStoppedAt: null,
    } as rpc.FileInfo;
    vi.spyOn(rpc, 'getFile').mockResolvedValue(file);
    vi.spyOn(rpc, 'view').mockResolvedValue('10000000000000000000000000');
    vi.spyOn(rpc, 'rpcReply').mockResolvedValue({ result: { final_execution_status: 'INCLUDED' } });
    const ledger = new RelayLedger(memoryStore(), 'funding-client');
    await ledger.seal(
      {
        policyVersion: 'legacy-v0',
        blockHash: 'cutover',
        blockHeight: 1,
        scannedThrough: 1,
        minPrice: '100000',
        fee: { fixed: '0', bps: 0, treasuryNear: null, treasuryEvm: null },
        inventory: [],
      },
      [],
    );
    await ledger.remember({
      network: terms.network,
      contract: terms.contract,
      fileId: terms.file_id,
      termsHash: hash,
      terms,
      eligible: true,
      tier: 'listed',
      listed: true,
      policyVersion: 'v1',
      minPrice: '100000',
      fee: { fixed: '0', bps: 0, treasuryNear: null, treasuryEvm: null },
      decidedAt: 1,
      allocated: '0',
      outcome: 'registered',
    });
    const c: Config = {
      nearRpc: 'https://near.test',
      baseRpc: 'https://base.test',
      contractId: terms.contract,
      network: terms.network,
      usdc: must(terms.base).usdc,
      ledger,
      sender: { accountId: 'relay.test', key: 'test-double' },
      disabled: false,
      perDay: 1000,
      perIpHour: 600,
      policy: { minPrice: 100000n, maxDeadlineSeconds: 600 },
    };
    const signed = vi.fn(async (message: string) => ({
      kind: 'evm' as const,
      sig: await account.signMessage({ message }),
    }));
    const requests: Record<string, unknown>[] = [];
    const amount = '1000000000000000000000';
    created.mockResolvedValue({ transaction: { encode: () => new Uint8Array([1, 2, 3]) } });
    vi.spyOn(rpc, 'txOutcome').mockImplementation(
      async (_rpc, _hash, _signer, _contract, _wait, expected) => {
        expect(expected?.args).toEqual({ file_id: terms.file_id, amount });
        return { state: 'done', value: null } as never;
      },
    );
    const fetcher = (async (url, init) => {
      requests.push(JSON.parse(String(init?.body)));
      const out = await handle(
        c,
        init?.method ?? 'GET',
        new URL(String(url)).pathname,
        '192.0.2.1',
        String(init?.body ?? ''),
      );
      expect(out.status).toBe(200);
      return Response.json(out.body, { status: out.status, headers: out.headers ?? {} });
    }) as typeof fetch;
    const config = join(dir, 'config.json');
    await writeFile(
      config,
      JSON.stringify({
        network: terms.network,
        contractId: terms.contract,
        nearRpc: c.nearRpc,
        baseRpc: c.baseRpc,
        relayer: 'https://relay.test',
        trustContract: true,
        stateDir: dir,
      }),
    );
    const adapter = createAdapter(
      { ANNON_BACKUP_SECRET: '01'.repeat(32) },
      { fetch: fetcher, wallet: async () => ({ identity: seller, authorize: signed }) },
    );
    await expect(
      adapter({ command: 'fund', target: terms.file_id, fundAmount: '0.001', config, json: true }),
    ).resolves.toMatchObject({ fileId: terms.file_id, fundedNear: '0.001' });
    const request = requests[0] as {
      method: string;
      args: { file_id: string; amount: string; nonce: string; deadline: number };
      auth: object;
    };
    expect(Object.keys(request).sort()).toEqual(['args', 'auth', 'method']);
    expect(Object.keys(request.args).sort()).toEqual(['amount', 'deadline', 'file_id', 'nonce']);
    expect(request.args).toMatchObject({
      file_id: terms.file_id,
      amount,
      nonce: expect.stringMatching(/^0x[0-9a-f]{64}$/),
    });
    expect(signed).toHaveBeenCalledWith(
      fileFundingText({
        ...request.args,
        network: terms.network,
        contract: terms.contract,
        seller,
      }),
    );
    expect(created).toHaveBeenCalledTimes(1);
    const call = created.mock.calls[0]?.[0];
    expect(JSON.parse(new TextDecoder().decode(call.actions[0].functionCall.args))).toEqual({
      file_id: terms.file_id,
      amount,
    });
    const replay = await handle(c, 'POST', '/v1/relay', '192.0.2.1', JSON.stringify(request));
    expect(replay.status).toBe(200);
    expect(created).toHaveBeenCalledTimes(1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
