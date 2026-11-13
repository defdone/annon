import { toFunctionSelector } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { must, terms as originalTerms, purchase as sample } from '../../test/fixtures.js';
import { getFile, getPurchase } from '../near/rpc.js';
import { registerText } from '../near/texts.js';
import {
  block,
  blockHeader,
  getCode,
  getReceipt,
  head,
  PayError,
  paymentLogs,
  viewWord,
} from '../pay/base.js';
import { cloneCode, createSplit, SPLIT_FACTORIES, splitHash } from '../pay/split.js';
import { buildPurchaseMessage, purchaseId } from '../settle-near/purchase.js';
import { termsHash } from '../settle-near/terms.js';
import { applySponsoredFee } from './fees.js';
import { canonicalRequest, checkRelay, contractArgs, resetRelayState } from './relay.js';

vi.mock('../near/rpc.js', async (original) => ({
  ...(await original<typeof import('../near/rpc.js')>()),
  getFile: vi.fn(),
  getPurchase: vi.fn(),
}));
vi.mock('../pay/base.js', async (original) => ({
  ...(await original<typeof import('../pay/base.js')>()),
  head: vi.fn(),
  getCode: vi.fn(),
  viewWord: vi.fn(),
  block: vi.fn(),
  blockHeader: vi.fn(),
  getReceipt: vi.fn(),
  paymentLogs: vi.fn(),
}));
const seller = privateKeyToAccount(`0x${'44'.repeat(32)}`);
const baseSplit = { kind: 'push' as const, salt: `0x${'01'.repeat(32)}` };
const treasury = { kind: 'evm' as const, id: `0x${'55'.repeat(20)}` };
const fee = { fixed: '30000', bps: 100, treasuryNear: null, treasuryEvm: treasury };
const near = applySponsoredFee(originalTerms.near, fee, must(originalTerms.base).price);
const splitTerms = {
  recipients: near.recipients.map((r) => r.identity.id),
  allocations: near.recipients.map((r) => BigInt(r.bps)),
  totalAllocation: 10000n,
  distributionIncentive: 0,
};
const split = createSplit(baseSplit.kind, splitTerms, baseSplit.salt);
const terms = {
  ...originalTerms,
  near,
  seller: { kind: 'evm' as const, id: seller.address.toLowerCase() },
  base: { ...must(originalTerms.base), pay_to: split.address },
};
const purchase = { ...sample, terms_hash: termsHash(terms), expires_at: '1' };
const log = {
  address: sample.asset.slice(2),
  block_hash: 'aa'.repeat(32),
  block_number: 42,
  data: '0x',
  log_index: 0,
  removed: false,
  topics: ['bb'.repeat(32), 'cc'.repeat(32), 'dd'.repeat(32)],
  transaction_hash: 'ee'.repeat(32),
  transaction_index: 0,
};
const logs = [log, { ...log, log_index: 1 }];
const options = {
  nearRpc: 'https://near.rpc',
  baseRpc: 'https://base.rpc',
  contractId: terms.contract,
  usdc: sample.asset,
  policy: { minPrice: 1n, maxDeadlineSeconds: 600, fee },
};
const file = {
  terms,
  purchaseStorageBalance: 0n,
  termsHash: termsHash(terms),
  seller: terms.seller,
  price: 200000n,
  payTo: terms.base?.pay_to ?? '',
  cipherHash: terms.cipher_hash,
  moderator: null,
  headerHash: null,
  salesStoppedAt: null as number | null,
  takenDown: null as string | null,
};
const request = (header: string | null = null) =>
  canonicalRequest({
    method: 'unlock',
    args: { purchase: buildPurchaseMessage(purchase), logs, header },
  });
const zeroWord = `0x${'00'.repeat(32)}`;
beforeEach(() => {
  vi.resetAllMocks();
  resetRelayState();
  vi.mocked(head).mockResolvedValue({ number: 43, timestamp: 1302 });
  vi.mocked(getCode).mockResolvedValue(cloneCode(SPLIT_FACTORIES[0].implementation));
  vi.mocked(viewWord).mockImplementation(async (_url, _to, data) => {
    if (data === toFunctionSelector('splitHash()')) return splitHash(splitTerms);
    if (data === toFunctionSelector('owner()') || data === toFunctionSelector('paused()'))
      return zeroWord;
    throw new Error('unexpected split view');
  });
  vi.mocked(getFile).mockResolvedValue(file);
  vi.mocked(getPurchase).mockResolvedValue(null);
  vi.mocked(paymentLogs).mockReturnValue(logs);
  vi.mocked(blockHeader).mockResolvedValue('0xab');
  vi.mocked(block).mockResolvedValue({ number: 42, timestamp: 1300, hash: `0x${log.block_hash}` });
});
describe('Base unlock contract timing', () => {
  it('accepts the canonical message with null header while open, without an expires_at check', async () => {
    const r = request();
    expect(contractArgs(r)).toEqual({ args: r.args });
    await checkRelay(r, options);
    expect(getReceipt).toHaveBeenCalled();
    expect(blockHeader).not.toHaveBeenCalled();
  });
  it('requires and verifies a header after a stop and accepts the inclusive +300 boundary', async () => {
    vi.mocked(getFile).mockResolvedValue({ ...file, salesStoppedAt: 1000 });
    await expect(checkRelay(request(), options)).rejects.toMatchObject({ code: 'bad_header' });
    await checkRelay(request('0xab'), options);
    await expect(checkRelay(request('0xcd'), options)).rejects.toMatchObject({
      code: 'bad_header',
    });
    vi.mocked(block).mockResolvedValue({
      number: 42,
      timestamp: 1301,
      hash: `0x${log.block_hash}`,
    });
    await expect(checkRelay(request('0xab'), options)).rejects.toMatchObject({
      code: 'sales_stopped',
    });
    vi.mocked(block).mockResolvedValue({ number: 42, timestamp: 999, hash: `0x${log.block_hash}` });
    await checkRelay(request('0xab'), options);
  });
  it('still checks provided headers, safe block hashes, receipts and takedowns', async () => {
    await expect(checkRelay(request('0xcd'), options)).rejects.toMatchObject({
      code: 'bad_header',
    });
    vi.mocked(block).mockResolvedValueOnce({ number: 41, timestamp: 1300 });
    await expect(checkRelay(request(), options)).rejects.toMatchObject({
      code: 'settlement_pending',
    });
    vi.mocked(block)
      .mockResolvedValueOnce({ number: 42, timestamp: 1300 })
      .mockResolvedValueOnce({ number: 42, timestamp: 1300, hash: `0x${'ff'.repeat(32)}` });
    await expect(checkRelay(request(), options)).rejects.toMatchObject({
      code: 'settlement_pending',
    });
    vi.mocked(paymentLogs).mockReturnValueOnce(null);
    await expect(checkRelay(request(), options)).rejects.toMatchObject({
      code: 'payment_not_found',
    });
    vi.mocked(getFile).mockResolvedValueOnce({ ...file, takenDown: 'court_order' });
    await expect(checkRelay(request(), options)).rejects.toMatchObject({ code: 'taken_down' });
  });
});

it('refuses unlock below the sponsorship floor before reading the payment', async () => {
  await expect(
    checkRelay(request(), {
      ...options,
      policy: { ...options.policy, minPrice: BigInt(purchase.price) + 1n },
    }),
  ).rejects.toMatchObject({ code: 'not_sponsored' });
  expect(getReceipt).not.toHaveBeenCalled();
});

it.each(SPLIT_FACTORIES)(
  'sponsors a valid $kind split with fresh state and no salt',
  async (factory) => {
    vi.mocked(getCode).mockResolvedValue(cloneCode(factory.implementation));
    await checkRelay(request(), options);
    expect(getCode).toHaveBeenCalledWith(options.baseRpc, file.payTo, 43);
    expect(viewWord).toHaveBeenCalledTimes(3);
    for (const sig of ['splitHash()', 'owner()', 'paused()'])
      expect(viewWord).toHaveBeenCalledWith(
        options.baseRpc,
        file.payTo,
        toFunctionSelector(sig),
        43,
      );
    resetRelayState();
    await checkRelay(request(), options);
    expect(getCode).toHaveBeenCalledTimes(2);
    expect(getReceipt).toHaveBeenCalledTimes(2);
  },
);

it('caches only positive Base verification and still checks current treasury requirements', async () => {
  await checkRelay(request(), options);
  await checkRelay(request(), options);
  expect(getCode).toHaveBeenCalledTimes(1);
  await expect(
    checkRelay(request(), {
      ...options,
      policy: { ...options.policy, fee: { ...fee, fixed: '40000' } },
    }),
  ).rejects.toMatchObject({ code: 'not_sponsored' });
  expect(getReceipt).toHaveBeenCalledTimes(2);
});

it('scopes the positive verification cache to the Base RPC', async () => {
  await checkRelay(request(), options);
  vi.mocked(getCode).mockResolvedValue('0x');
  await expect(
    checkRelay(request(), { ...options, baseRpc: 'https://other.base.rpc' }),
  ).rejects.toMatchObject({ code: 'not_sponsored' });
  expect(getCode).toHaveBeenCalledTimes(2);
  expect(getReceipt).toHaveBeenCalledTimes(1);
});

it('revalidates changed registered terms even when the payment address has a positive cache', async () => {
  await checkRelay(request(), options);
  const changed = {
    ...terms,
    near: {
      ...near,
      recipients: near.recipients.map((r, i) => ({ ...r, bps: i === 0 ? 8300 : 1700 })),
    },
  };
  vi.mocked(getFile).mockResolvedValue({ ...file, terms: changed, termsHash: termsHash(changed) });
  const r = canonicalRequest({
    method: 'unlock',
    args: {
      purchase: buildPurchaseMessage({ ...purchase, terms_hash: termsHash(changed) }),
      logs,
      header: null,
    },
  });
  await expect(checkRelay(r, options)).rejects.toMatchObject({ code: 'not_sponsored' });
  expect(getCode).toHaveBeenCalledTimes(2);
  expect(getReceipt).toHaveBeenCalledTimes(1);
});

it.each([
  ['an EOA', '0x'],
  ['arbitrary code', '0x6000'],
  ['a clone of an unknown implementation', cloneCode(`0x${'99'.repeat(20)}`)],
  ['a modified clone', `${cloneCode(SPLIT_FACTORIES[0].implementation)}00`],
])('refuses %s and briefly caches the refusal', async (_label, code) => {
  vi.mocked(getCode).mockResolvedValueOnce(code);
  await expect(checkRelay(request(), options)).rejects.toMatchObject({ code: 'not_sponsored' });
  expect(getReceipt).not.toHaveBeenCalled();
  await expect(checkRelay(request(), options)).rejects.toMatchObject({ code: 'not_sponsored' });
  expect(getCode).toHaveBeenCalledTimes(1);
});

it.each([
  ['a different split', 'splitHash()', splitHash({ ...splitTerms, allocations: [9000n, 1000n] })],
  ['a distribution reward', 'splitHash()', splitHash({ ...splitTerms, distributionIncentive: 1 })],
  ['an owned split', 'owner()', `0x${'00'.repeat(12)}${'11'.repeat(20)}`],
  ['a paused split', 'paused()', `0x${'00'.repeat(31)}01`],
])('refuses %s before reading the payment', async (_label, sig, value) => {
  const read = vi.mocked(viewWord).getMockImplementation();
  vi.mocked(viewWord).mockImplementation(async (...args) =>
    args[2] === toFunctionSelector(sig) ? value : must(read)(...args),
  );
  await expect(checkRelay(request(), options)).rejects.toMatchObject({ code: 'not_sponsored' });
  expect(getReceipt).not.toHaveBeenCalled();
});

it.each(['missing', 'insufficient', 'non-EVM'] as const)(
  'refuses a split with %s treasury recipients from registered terms',
  async (kind) => {
    const recipients =
      kind === 'missing'
        ? originalTerms.near.recipients
        : kind === 'insufficient'
          ? [
              { identity: originalTerms.seller, bps: 9999 },
              { identity: treasury, bps: 1 },
            ]
          : [
              { identity: treasury, bps: 1600 },
              { identity: { kind: 'near' as const, id: 'seller.test' }, bps: 8400 },
            ];
    const changed = { ...terms, near: { ...near, recipients } };
    vi.mocked(getFile).mockResolvedValue({
      ...file,
      terms: changed,
      termsHash: termsHash(changed),
    });
    const r = canonicalRequest({
      method: 'unlock',
      args: {
        purchase: buildPurchaseMessage({ ...purchase, terms_hash: termsHash(changed) }),
        logs,
        header: null,
      },
    });
    await expect(checkRelay(r, options)).rejects.toMatchObject({ code: 'not_sponsored' });
    expect(getReceipt).not.toHaveBeenCalled();
  },
);

it.each(['head', 'code', 'hash', 'owner', 'pause'] as const)(
  'fails closed with a retryable error on a Base RPC failure reading %s',
  async (stage) => {
    const error = new PayError('transport', 'fixture RPC unavailable');
    const read = vi.mocked(viewWord).getMockImplementation();
    if (stage === 'head') vi.mocked(head).mockRejectedValueOnce(error);
    else if (stage === 'code') vi.mocked(getCode).mockRejectedValueOnce(error);
    else {
      const sig = { hash: 'splitHash()', owner: 'owner()', pause: 'paused()' }[stage];
      vi.mocked(viewWord).mockImplementation(async (...args) => {
        if (args[2] === toFunctionSelector(sig)) throw error;
        return must(read)(...args);
      });
    }
    await expect(checkRelay(request(), options)).rejects.toMatchObject({ code: 'unavailable' });
    expect(getReceipt).not.toHaveBeenCalled();
    vi.mocked(viewWord).mockImplementation(must(read));
    await checkRelay(request(), options);
    expect(getReceipt).toHaveBeenCalledTimes(1);
  },
);

it('does not treat registration-time salt validation as an on-chain verification', async () => {
  const deadline = Math.floor(Date.now() / 1000) + 100;
  const args = { terms, seller_key: sample.buyer_key, deadline };
  vi.mocked(getFile).mockResolvedValueOnce(null);
  await checkRelay(
    {
      method: 'register',
      args,
      baseSplit,
      auth: {
        kind: 'evm',
        sig: await seller.signMessage({ message: registerText(terms.contract, args) }),
      },
    },
    options,
  );
  vi.mocked(getCode).mockResolvedValue('0x');
  await expect(checkRelay(request(), options)).rejects.toMatchObject({ code: 'not_sponsored' });
  expect(getReceipt).not.toHaveBeenCalled();
});

it('honors the Base sponsorship kill switch with a positive cache', async () => {
  await checkRelay(request(), options);
  await expect(
    checkRelay(request(), { ...options, policy: { ...options.policy, baseSponsorship: false } }),
  ).rejects.toMatchObject({ code: 'not_sponsored' });
  expect(getReceipt).toHaveBeenCalledTimes(1);
});

it('caches refused split checks for 60 seconds by exact terms and RPC, then retries', async () => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(100000);
  try {
    vi.mocked(getCode).mockResolvedValue('0x');
    await expect(checkRelay(request(), options)).rejects.toMatchObject({ code: 'not_sponsored' });
    clock.mockReturnValue(159999);
    await expect(checkRelay(request(), options)).rejects.toMatchObject({ code: 'not_sponsored' });
    expect(getCode).toHaveBeenCalledTimes(1);
    const changed = { ...terms, cipher_hash: `0x${'99'.repeat(32)}` };
    vi.mocked(getFile).mockResolvedValueOnce({
      ...file,
      terms: changed,
      termsHash: termsHash(changed),
    });
    const changedRequest = canonicalRequest({
      method: 'unlock',
      args: {
        purchase: buildPurchaseMessage({ ...purchase, terms_hash: termsHash(changed) }),
        logs,
        header: null,
      },
    });
    await expect(checkRelay(changedRequest, options)).rejects.toMatchObject({
      code: 'not_sponsored',
    });
    await expect(
      checkRelay(request(), { ...options, baseRpc: 'https://other.rpc' }),
    ).rejects.toMatchObject({ code: 'not_sponsored' });
    expect(getCode).toHaveBeenCalledTimes(3);
    clock.mockReturnValue(160000);
    vi.mocked(getCode).mockResolvedValue(cloneCode(SPLIT_FACTORIES[0].implementation));
    await checkRelay(request(), options);
    expect(getCode).toHaveBeenCalledTimes(4);
    expect(getReceipt).toHaveBeenCalledTimes(1);
  } finally {
    clock.mockRestore();
  }
});

it('applies MIN_PRICE to claim_key before reading its grant', async () => {
  vi.mocked(getPurchase).mockResolvedValue({
    purchase_id: purchaseId(purchase, { baseUsdc: sample.asset }),
    file_id: terms.file_id,
  } as never);
  await expect(
    checkRelay(
      {
        method: 'claim_key',
        args: { purchase_id: purchaseId(purchase, { baseUsdc: sample.asset }) },
      },
      { ...options, policy: { ...options.policy, minPrice: file.price + 1n } },
    ),
  ).rejects.toMatchObject({ code: 'not_sponsored' });
});
