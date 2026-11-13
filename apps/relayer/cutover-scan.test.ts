import { expect, it } from 'vitest';
import { scanRegistrations } from './cutover-scan.ts';

const archiveFixture = () => ({
  EXPERIMENTAL_genesis_config: { genesis_height: 0 },
  block: { header: { hash: 'b0', height: 0, prev_hash: '' }, chunks: [{ chunk_hash: 'c' }] },
  chunk: { transactions: [{ hash: 'tx', signer_id: 'sponsor.test', receiver_id: 'market.test' }] },
  EXPERIMENTAL_tx_status: {
    final_execution_status: 'FINAL',
    receipts_outcome: [
      {
        id: 'receipt',
        block_hash: 'b0',
        outcome: { executor_id: 'market.test', status: { SuccessValue: '' }, logs: [] as string[] },
      },
    ],
  },
});

const event = `EVENT_JSON:${JSON.stringify({ standard: 'annon', version: '2.0.0', event: 'file_registered', data: [{ file_id: `0x${'22'.repeat(32)}` }] })}`;
it('walks every archival block and transaction, filtering failed and foreign receipt events', async () => {
  const calls: string[] = [];
  const rpc = async (_url: string, method: string, params: unknown) => {
    const p = params as { block_id?: string };
    calls.push(`${method}:${p.block_id ?? ''}`);
    if (method === 'EXPERIMENTAL_genesis_config') return { result: { genesis_height: 0 } };
    if (method === 'block')
      return {
        result: {
          header: {
            hash: p.block_id,
            prev_hash: p.block_id === 'b1' ? 'b0' : '',
            height: p.block_id === 'b1' ? 1 : 0,
          },
          chunks: [{ chunk_hash: `c${p.block_id}` }],
        },
      };
    if (method === 'chunk')
      return {
        result: {
          transactions: [{ hash: 'tx', signer_id: 'sender.test', receiver_id: 'market.test' }],
        },
      };
    return {
      result: {
        final_execution_status: 'FINAL',
        receipts_outcome: [
          {
            block_hash: 'b1',
            outcome: { executor_id: 'market.test', status: { SuccessValue: '' }, logs: [event] },
          },
          {
            block_hash: 'b1',
            outcome: {
              executor_id: 'foreign.test',
              status: { SuccessValue: '' },
              logs: [event.replaceAll('22', '33')],
            },
          },
          {
            block_hash: 'b1',
            outcome: {
              executor_id: 'market.test',
              status: { Failure: {} },
              logs: [event.replaceAll('22', '44')],
            },
          },
        ],
      },
    };
  };
  expect(
    await scanRegistrations(
      'https://archive.test',
      'market.test',
      { hash: 'b1', height: 1, fromHeight: 0 },
      rpc,
    ),
  ).toEqual([`0x${'22'.repeat(32)}`]);
  expect(calls).toContain('block:b0');
  expect(calls.filter((c) => c.startsWith('chunk:'))).toHaveLength(2);
  expect(calls.filter((c) => c.startsWith('EXPERIMENTAL_tx_status:'))).toHaveLength(1);
});
it('refuses to seal incomplete history or an unfinalized transaction lookup', async () => {
  await expect(
    scanRegistrations(
      'https://archive.test',
      'market.test',
      { hash: 'b1', height: 1, fromHeight: 0 },
      async () => ({ error: {} }),
    ),
  ).rejects.toThrow();
  await expect(
    scanRegistrations(
      'https://archive.test',
      'market.test',
      { hash: 'b1', height: 1, fromHeight: 0 },
      async (_url, method) =>
        method === 'EXPERIMENTAL_genesis_config'
          ? { result: { genesis_height: 0 } }
          : method === 'block'
            ? {
                result: {
                  header: { hash: 'b1', height: 1, prev_hash: 'b0' },
                  chunks: [{ chunk_hash: 'c' }],
                },
              }
            : method === 'chunk'
              ? {
                  result: {
                    transactions: [
                      { hash: 'tx', signer_id: 'sender.test', receiver_id: 'market.test' },
                    ],
                  },
                }
              : { result: { final_execution_status: 'INCLUDED', receipts_outcome: [] } },
    ),
  ).rejects.toThrow('Archival outcome is incomplete.');
});

it.each(['inventory', 'ineligible-fee', 'invalid-split', 'unavailable-split', 'mixed'] as const)(
  'seals a complete cutover with %s evidence',
  async (mode) => {
    const { sealLegacy } = await import('./cutover-scan.ts');
    const { RelayLedger } = await import('@defdone/annon/relay');
    const { memoryStore } = await import('../../packages/annon/src/pay/store.ts');
    const { terms } = await import('../../packages/annon/test/fixtures.ts');
    const { termsHash } = await import('../../packages/annon/src/settle-near/terms.ts');
    const ledger = new RelayLedger(memoryStore(), `${terms.network}|${terms.contract}`);
    const events = [
      {
        standard: 'annon',
        version: '2.0.0',
        event: 'file_registered',
        data: [
          { file_id: terms.file_id },
          ...(mode === 'mixed' ? [{ file_id: `0x${'99'.repeat(32)}` }] : []),
        ],
      },
      {
        standard: 'annon',
        version: '2.0.0',
        event: 'file_storage_funded',
        data: [
          { file_id: terms.file_id, funder: 'sponsor.test', amount: '41000000000000000000000' },
        ],
      },
    ].map((e) => `EVENT_JSON:${JSON.stringify(e)}`);
    const rpc = async (_url: string, method: string, _params: unknown) => {
      if (method === 'EXPERIMENTAL_genesis_config') return { result: { genesis_height: 100 } };
      if (method === 'block')
        return {
          result: { header: { height: 100, hash: 'cutover' }, chunks: [{ chunk_hash: 'c' }] },
        };
      if (method === 'chunk')
        return {
          result: {
            transactions: [{ hash: 't', signer_id: 'sponsor.test', receiver_id: terms.contract }],
          },
        };
      if (
        method === 'query' &&
        (_params as { request_type?: string }).request_type === 'view_account'
      )
        return (_params as { block_id?: number }).block_id === 99
          ? { error: { cause: { name: 'UNKNOWN_ACCOUNT' } } }
          : { result: { amount: '1' } };
      if (method === 'query')
        return {
          result: {
            result: [
              ...Buffer.from(
                JSON.stringify({
                  terms,
                  terms_hash: termsHash(terms),
                  header_hash: null,
                  sales_stopped_at: null,
                  taken_down: null,
                }),
              ),
            ],
          },
        };
      return {
        result: {
          final_execution_status: 'FINAL',
          receipts_outcome: [
            {
              id: 'r',
              block_hash: 'cutover',
              outcome: { executor_id: terms.contract, status: { SuccessValue: '' }, logs: events },
            },
          ],
        },
      };
    };
    const sealing = sealLegacy(
      {
        ledger,
        network: terms.network,
        contractId: terms.contract,
        nearRpc: 'https://rpc.test',
        archivalRpc: 'https://archive.test',
        baseRpc: 'https://base.test',
        usdc: terms.base?.usdc ?? '',
        policy: { minPrice: 100000n, maxDeadlineSeconds: 600 },
      },
      {
        hash: 'cutover',
        height: 100,
        fromHeight: 100,
        fee: {
          fixed: '30000',
          bps: 100,
          treasuryNear: null,
          treasuryEvm: mode.endsWith('split') ? terms.seller : null,
        },
        inventory: ['inventory', 'mixed'].includes(mode) ? [terms.file_id] : [],
        sponsor: 'sponsor.test',
      },
      rpc,
      async () => {
        if (mode.endsWith('split'))
          throw Object.assign(new Error('split unavailable'), {
            code: mode === 'invalid-split' ? 'bad_requirements' : 'transport',
          });
        return { kind: 'push', shares: [], distributorPercent: 0 };
      },
      async (_url, _contract, _id, block) => {
        expect(block).toBe('cutover');
        const checked = { ...terms, file_id: _id };
        return {
          terms: checked,
          termsHash: termsHash(checked),
          seller: terms.seller,
          price: BigInt(terms.base?.price ?? '0'),
          payTo: terms.base?.pay_to ?? '',
          cipherHash: terms.cipher_hash,
          moderator: null,
          headerHash: null,
          purchaseStorageBalance: 0n,
          salesStoppedAt: null,
          takenDown: null,
        };
      },
    );
    if (mode === 'unavailable-split') {
      await expect(sealing).rejects.toThrow();
      expect(await ledger.cutover()).toBeUndefined();
      return;
    }
    expect(await sealing).toEqual({
      scanned: mode === 'mixed' ? 2 : 1,
      eligible: ['inventory', 'mixed'].includes(mode) ? 1 : 0,
    });
    if (mode === 'mixed') {
      expect(await ledger.cutover()).toMatchObject({ scannedThrough: 100 });
      expect(
        await ledger.decision(
          `0x${'99'.repeat(32)}`,
          termsHash({ ...terms, file_id: `0x${'99'.repeat(32)}` }),
        ),
      ).toBeNull();
      return;
    }
    if (mode !== 'inventory') {
      expect(await ledger.decision(terms.file_id, termsHash(terms))).toBeNull();
      expect(await ledger.cutover()).toMatchObject({ scannedThrough: 100 });
      return;
    }
    expect((await ledger.decision(terms.file_id, termsHash(terms)))?.fee).toMatchObject({
      fixed: '0',
      bps: 0,
    });
    expect((await ledger.decision(terms.file_id, termsHash(terms)))?.allocated).toBe(
      '41000000000000000000000',
    );
    expect((await ledger.decision(terms.file_id, termsHash(terms)))?.fee).toMatchObject({
      fixed: '0',
      bps: 0,
    });
    expect(await ledger.cutover()).toMatchObject({
      policyVersion: 'legacy-v0',
      scannedThrough: 100,
      blockHash: 'cutover',
    });
  },
);

it('refuses a cutover above finality or a hash outside the canonical finalized chain', async () => {
  const { sealLegacy } = await import('./cutover-scan.ts');
  const o = {
    ledger: { cutover: async () => undefined },
    archivalRpc: 'https://archive.test',
  } as unknown as Parameters<typeof sealLegacy>[0];
  const snapshot = {
    hash: 'cutover',
    height: 100,
    fromHeight: 100,
    fee: { fixed: '30000', bps: 100, treasuryNear: null, treasuryEvm: null },
    inventory: [],
    sponsor: 'sponsor.test',
  };
  await expect(
    sealLegacy(o, snapshot, async () => ({ result: { header: { hash: 'earlier', height: 99 } } })),
  ).rejects.toThrow('Cutover is not finalized.');
  await expect(
    sealLegacy(o, snapshot, async (_url, method, _params) =>
      method === 'block'
        ? { result: { header: { hash: 'different', height: 101 } } }
        : { result: { genesis_height: 0 } },
    ),
  ).rejects.toThrow('Cutover is not canonical.');
});

it.each([
  ['block hash', 'block', ['header', 'hash'], 'foreign'],
  ['fractional height', 'block', ['header', 'height'], 0.5],
  ['missing chunks', 'block', ['chunks'], null],
  ['chunk identity', 'block', ['chunks', '0', 'chunk_hash'], null],
  ['missing transactions', 'chunk', ['transactions'], null],
  ['transaction hash', 'chunk', ['transactions', '0', 'hash'], null],
  ['transaction signer', 'chunk', ['transactions', '0', 'signer_id'], null],
  ['transaction finality', 'EXPERIMENTAL_tx_status', ['final_execution_status'], 'INCLUDED'],
  ['missing receipts', 'EXPERIMENTAL_tx_status', ['receipts_outcome'], null],
  ['receipt status', 'EXPERIMENTAL_tx_status', ['receipts_outcome', '0', 'outcome', 'status'], {}],
  ['receipt logs', 'EXPERIMENTAL_tx_status', ['receipts_outcome', '0', 'outcome', 'logs'], null],
] as const)('refuses incomplete archival evidence: %s', async (_label, method, path, value) => {
  const fixture = archiveFixture() as Record<string, unknown>;
  let target = fixture[method] as Record<string, unknown>;
  for (const key of path.slice(0, -1)) target = target[key] as Record<string, unknown>;
  target[path[path.length - 1] ?? ''] = value;
  await expect(
    scanRegistrations(
      'https://archive.test',
      'market.test',
      { hash: 'b0', height: 0, fromHeight: 0 },
      async (_url, method) => ({ result: fixture[method] }),
    ),
  ).rejects.toThrow();
});

it('counts only successful sponsor funding receipts once and only through the cutover', async () => {
  const fixture = archiveFixture();
  const receipt = fixture.EXPERIMENTAL_tx_status.receipts_outcome[0];
  if (!receipt) throw new Error('missing fixture');
  const funding = (funder: string, amount: string) =>
    `EVENT_JSON:${JSON.stringify({
      standard: 'annon',
      version: '2.0.0',
      event: 'file_storage_funded',
      data: [{ file_id: `0x${'22'.repeat(32)}`, funder, amount }],
    })}`;
  receipt.outcome.logs.push(event, funding('sponsor.test', '41'), funding('other.test', '99'));
  fixture.EXPERIMENTAL_tx_status.receipts_outcome.push(structuredClone(receipt), {
    ...structuredClone(receipt),
    id: 'later',
    block_hash: 'b1',
  });
  const totals = new Map<string, bigint>();
  const rpc = async (_url: string, method: string, params: unknown) => ({
    result:
      method === 'block' && (params as { block_id?: string }).block_id === 'b1'
        ? { header: { hash: 'b1', height: 1, fromHeight: 0 }, chunks: [] }
        : (fixture as Record<string, unknown>)[method],
  });
  expect(
    await scanRegistrations(
      'https://archive.test',
      'market.test',
      { hash: 'b0', height: 0, fromHeight: 0 },
      rpc,
      {
        funder: 'sponsor.test',
        totals,
      },
    ),
  ).toEqual([`0x${'22'.repeat(32)}`]);
  expect(totals.get(`0x${'22'.repeat(32)}`)).toBe(41n);
});

it('starts at a verified non-genesis creation height and ignores foreign transactions and later receipts', async () => {
  const calls: { method: string; params: object }[] = [];
  const rpc = async (_url: string, method: string, params: unknown) => {
    calls.push({ method, params: params as object });
    const p = params as { block_id?: number | string; tx_hash?: string };
    if (method === 'query')
      return p.block_id === 99
        ? { error: { cause: { name: 'UNKNOWN_ACCOUNT' } } }
        : { result: { amount: '1' } };
    if (method === 'block')
      return {
        result: {
          header: {
            hash: p.block_id,
            height: p.block_id === 'later' ? 101 : 100,
            prev_hash: 'never',
          },
          chunks: [{ chunk_hash: 'c' }],
        },
      };
    if (method === 'chunk')
      return {
        result: {
          transactions: [
            { hash: 'ours', signer_id: 's.test', receiver_id: 'market.test' },
            { hash: 'foreign', signer_id: 's.test', receiver_id: 'other.test' },
          ],
        },
      };
    return {
      result: {
        final_execution_status: 'FINAL',
        receipts_outcome: [
          {
            id: 'r',
            block_hash: 'later',
            outcome: { executor_id: 'market.test', status: { SuccessValue: '' }, logs: [event] },
          },
        ],
      },
    };
  };
  expect(
    await scanRegistrations(
      'https://archive.test',
      'market.test',
      { hash: 'cutover', height: 100, fromHeight: 100 },
      rpc,
    ),
  ).toEqual([]);
  expect(calls.filter((c) => c.method === 'EXPERIMENTAL_tx_status')).toHaveLength(1);
  expect(calls.some((c) => (c.params as { block_id?: string }).block_id === 'never')).toBe(false);
  expect(
    calls.some((c) => c.method === 'query' && (c.params as { block_id?: number }).block_id === 99),
  ).toBe(true);
});
it('bounds the scan even when an archival request never answers', async () => {
  const { vi } = await import('vitest');
  vi.useFakeTimers();
  try {
    const scan = scanRegistrations(
      'https://archive.test',
      'market.test',
      { hash: 'b', height: 100, fromHeight: 100, maxSeconds: 1 },
      async () => new Promise(() => {}),
    );
    const assertion = expect(scan).rejects.toThrow('Cutover scan time limit reached.');
    await vi.advanceTimersByTimeAsync(1000);
    await assertion;
  } finally {
    vi.useRealTimers();
  }
});

it('resumes from a durable checkpoint instead of walking completed blocks again', async () => {
  let saved: import('./cutover-scan.ts').ScanCheckpoint | null = null;
  const progress = {
    load: async () => saved,
    save: async (state: import('./cutover-scan.ts').ScanCheckpoint) => {
      saved = structuredClone(state);
    },
  };
  const fixture = archiveFixture();
  fixture.EXPERIMENTAL_tx_status.receipts_outcome[0]?.outcome.logs.push(event);
  const rpc = async (_url: string, method: string) => ({
    result: (fixture as Record<string, unknown>)[method],
  });
  expect(
    await scanRegistrations(
      'https://archive.test',
      'market.test',
      { hash: 'b0', height: 0, fromHeight: 0 },
      rpc,
      undefined,
      progress,
    ),
  ).toEqual([`0x${'22'.repeat(32)}`]);
  expect(saved).toMatchObject({ nextHash: null, previousHeight: 0 });
  expect(
    await scanRegistrations(
      'https://archive.test',
      'market.test',
      { hash: 'b0', height: 0, fromHeight: 0 },
      async () => {
        throw new Error('completed blocks must not be fetched again');
      },
      undefined,
      progress,
    ),
  ).toEqual([`0x${'22'.repeat(32)}`]);
});
it('refuses an unverified creation bound', async () => {
  await expect(
    scanRegistrations(
      'https://archive.test',
      'market.test',
      { hash: 'b', height: 100, fromHeight: 100 },
      async () => ({ result: { amount: '1' } }),
    ),
  ).rejects.toThrow('CUTOVER_FROM_HEIGHT must prove account creation.');
});

it('stops at its deadline even if the archival reader returns immediately', async () => {
  const { vi } = await import('vitest');
  vi.useFakeTimers();
  vi.setSystemTime(0);
  const fixture = archiveFixture();
  try {
    await expect(
      scanRegistrations(
        'https://archive.test',
        'market.test',
        { hash: 'b0', height: 0, fromHeight: 0, maxSeconds: 1 },
        async (_url, method) => {
          vi.setSystemTime(1001);
          return { result: (fixture as Record<string, unknown>)[method] };
        },
      ),
    ).rejects.toThrow('Cutover scan time limit reached.');
  } finally {
    vi.useRealTimers();
  }
});

it.each([-1, 101, 0.5])('refuses an invalid creation height %s', async (fromHeight) => {
  await expect(
    scanRegistrations(
      'https://archive.test',
      'market.test',
      { hash: 'b', height: 100, fromHeight },
      async () => ({ error: {} }),
    ),
  ).rejects.toThrow('Verified CUTOVER_FROM_HEIGHT is required.');
});
it.each([0, -1, 3601, 0.5])('refuses an invalid scan time bound %s', async (maxSeconds) => {
  await expect(
    scanRegistrations(
      'https://archive.test',
      'market.test',
      { hash: 'b', height: 100, fromHeight: 100, maxSeconds },
      async () => ({ error: {} }),
    ),
  ).rejects.toThrow('Cutover time limit is invalid.');
});

it('retains every completed block when a slow or unavailable reader interrupts the scan', async () => {
  let saved: import('./cutover-scan.ts').ScanCheckpoint | null = null;
  const progress = {
    load: async () => saved,
    save: async (state: import('./cutover-scan.ts').ScanCheckpoint) => {
      saved = structuredClone(state);
    },
  };
  await expect(
    scanRegistrations(
      'https://archive.test',
      'market.test',
      { hash: 'b1', height: 1, fromHeight: 0 },
      async (_url, _method, params) => {
        if ((params as { block_id?: string }).block_id === 'b0')
          throw new Error('archive unavailable');
        return { result: { header: { hash: 'b1', height: 1, prev_hash: 'b0' }, chunks: [] } };
      },
      undefined,
      progress,
    ),
  ).rejects.toThrow('archive unavailable');
  expect(saved).toMatchObject({ nextHash: 'b0', previousHeight: 1 });
  const calls: string[] = [];
  expect(
    await scanRegistrations(
      'https://archive.test',
      'market.test',
      { hash: 'b1', height: 1, fromHeight: 0 },
      async (_url, _method, params) => {
        calls.push((params as { block_id: string }).block_id);
        return { result: { header: { hash: 'b0', height: 0 }, chunks: [] } };
      },
      undefined,
      progress,
    ),
  ).toEqual([]);
  expect(calls).toEqual(['b0']);
});
