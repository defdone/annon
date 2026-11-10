import { beforeEach, describe, expect, it, vi } from 'vitest';
import { purchase as sample, terms } from '../../test/fixtures.js';
import { getFile, getPurchase } from '../near/rpc.js';
import { block, blockHeader, getReceipt, paymentLogs } from '../pay/base.js';
import { buildPurchaseMessage } from '../settle-near/purchase.js';
import { termsHash } from '../settle-near/terms.js';
import { canonicalRequest, checkRelay, contractArgs } from './relay.js';

vi.mock('../near/rpc.js', async (original) => ({
  ...(await original<typeof import('../near/rpc.js')>()),
  getFile: vi.fn(),
  getPurchase: vi.fn(),
}));
vi.mock('../pay/base.js', async (original) => ({
  ...(await original<typeof import('../pay/base.js')>()),
  block: vi.fn(),
  blockHeader: vi.fn(),
  getReceipt: vi.fn(),
  paymentLogs: vi.fn(),
}));
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
  policy: { minPrice: 1n, maxDeadlineSeconds: 600 },
};
const file = {
  terms,
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
beforeEach(() => {
  vi.clearAllMocks();
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
      code: 'payment_not_safe',
    });
    vi.mocked(block)
      .mockResolvedValueOnce({ number: 42, timestamp: 1300 })
      .mockResolvedValueOnce({ number: 42, timestamp: 1300, hash: `0x${'ff'.repeat(32)}` });
    await expect(checkRelay(request(), options)).rejects.toMatchObject({
      code: 'payment_not_safe',
    });
    vi.mocked(paymentLogs).mockReturnValueOnce(null);
    await expect(checkRelay(request(), options)).rejects.toMatchObject({
      code: 'payment_not_found',
    });
    vi.mocked(getFile).mockResolvedValueOnce({ ...file, takenDown: 'court_order' });
    await expect(checkRelay(request(), options)).rejects.toMatchObject({ code: 'taken_down' });
  });
});
