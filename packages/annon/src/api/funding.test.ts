import { privateKeyToAccount } from 'viem/accounts';
import { afterEach, expect, it, vi } from 'vitest';
import { terms as initial } from '../../test/fixtures.js';
import * as rpc from '../near/rpc.js';
import { fileFundingText } from '../near/texts.js';
import { memoryStore } from '../pay/store.js';
import { termsHash } from '../settle-near/terms.js';
import { Annon } from './annon.js';

const account = privateKeyToAccount(`0x${'44'.repeat(32)}`);
const seller = { kind: 'evm' as const, id: account.address.toLowerCase() };
const terms = { ...initial, seller };
afterEach(() => vi.restoreAllMocks());
function setup(change: object = {}) {
  vi.spyOn(rpc, 'getFile').mockResolvedValue({
    terms,
    seller,
    termsHash: termsHash(terms),
    takenDown: null,
    salesStoppedAt: null,
    ...change,
  } as rpc.FileInfo);
  const send = vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({}));
  const wallet = {
    identity: seller,
    authorize: vi.fn(async (message: string) => ({
      kind: 'evm' as const,
      sig: await account.signMessage({ message }),
    })),
  };
  const sdk = new Annon({
    nearRpc: 'https://near.test',
    baseRpc: 'https://base.test',
    network: terms.network,
    contractId: terms.contract,
    rawStore: memoryStore(),
    backupSecret: new Uint8Array(32).fill(1),
    writeBackup: async () => {},
    send,
    now: () => 1000,
  });
  return { sdk, wallet, send };
}
it('signs the exact seller funding text and sends only the required envelope', async () => {
  const { sdk, wallet, send } = setup();
  const nonce = `0x${'66'.repeat(32)}`;
  await sdk.fund(terms.file_id, 1n, wallet, { nonce, deadline: 1600 });
  const args = { file_id: terms.file_id, amount: '1', nonce, deadline: 1600 };
  expect(wallet.authorize).toHaveBeenCalledWith(
    fileFundingText({ ...args, network: terms.network, contract: terms.contract, seller }),
  );
  expect(send).toHaveBeenCalledWith(
    'fund_file_storage',
    {
      args,
      auth: await wallet.authorize(
        fileFundingText({ ...args, network: terms.network, contract: terms.contract, seller }),
      ),
    },
    undefined,
  );
});
it.each([
  'seller',
  'network',
  'contract',
  'amount',
  'overflow',
  'expired',
  'fractional',
  'deadline',
  'nonce',
  'stopped',
  'taken down',
  'signature',
])('refuses invalid funding before sending: %s', async (mode) => {
  const { sdk, wallet, send } = setup(
    mode === 'contract'
      ? { terms: { ...terms, contract: 'other.test' } }
      : mode === 'network'
        ? { terms: { ...terms, network: 'near:testnet' } }
        : mode === 'stopped'
          ? { salesStoppedAt: 1 }
          : mode === 'taken down'
            ? { takenDown: {} }
            : {},
  );
  if (mode === 'seller') wallet.identity = { kind: 'evm', id: `0x${'11'.repeat(20)}` };
  if (mode === 'signature') wallet.authorize.mockResolvedValue({ kind: 'evm', sig: '0x00' });
  await expect(
    sdk.fund(
      terms.file_id,
      mode === 'amount' ? 0n : mode === 'overflow' ? 2n ** 128n : 1n,
      wallet,
      {
        nonce: mode === 'nonce' ? 'bad' : `0x${'66'.repeat(32)}`,
        deadline:
          mode === 'expired'
            ? 1000
            : mode === 'fractional'
              ? 1000.5
              : mode === 'deadline'
                ? 1601
                : 1600,
      },
    ),
  ).rejects.toThrow();
  expect(send).not.toHaveBeenCalled();
  if (mode === 'amount' || mode === 'overflow') expect(rpc.getFile).not.toHaveBeenCalled();
  if (mode !== 'signature') expect(wallet.authorize).not.toHaveBeenCalled();
});

it('checks funding transaction evidence against the stripped contract arguments', async () => {
  const { sdk, wallet, send } = setup();
  send.mockResolvedValue({ transaction: { hash: 'T', signer_id: 'relay.test' } });
  const outcome = vi
    .spyOn(rpc, 'readOutcome')
    .mockReturnValue({ state: 'done', value: null } as never);
  await sdk.fund(terms.file_id, 1n, wallet);
  expect(outcome).toHaveBeenCalledWith(
    expect.anything(),
    terms.contract,
    expect.objectContaining({
      method: 'fund_file_storage',
      args: { file_id: terms.file_id, amount: '1' },
    }),
  );
});

it('refuses funding an unknown listing with its public code before signing', async () => {
  const { sdk, wallet, send } = setup();
  vi.mocked(rpc.getFile).mockResolvedValue(null);
  await expect(sdk.fund(terms.file_id, 1n, wallet)).rejects.toMatchObject({ code: 'unknown_file' });
  expect(wallet.authorize).not.toHaveBeenCalled();
  expect(send).not.toHaveBeenCalled();
});

it('refuses a wallet other than the file seller with wrong_identity before signing', async () => {
  const { sdk, wallet, send } = setup();
  wallet.identity = { kind: 'evm', id: `0x${'11'.repeat(20)}` };
  await expect(sdk.fund(terms.file_id, 1n, wallet)).rejects.toMatchObject({
    code: 'wrong_identity',
  });
  expect(wallet.authorize).not.toHaveBeenCalled();
  expect(send).not.toHaveBeenCalled();
});

it('keeps NEAR funding on the direct wallet path', async () => {
  const nearSeller = { kind: 'near' as const, id: 'seller.test' };
  const { sdk, send } = setup({ terms: { ...terms, seller: nearSeller }, seller: nearSeller });
  const call = vi.fn(async () => null);
  const authorize = vi.fn();
  const wallet = { identity: nearSeller, authorize, call, transferPurchase: vi.fn() };
  await sdk.fund(terms.file_id, 1n, wallet);
  expect(call).toHaveBeenCalledWith(
    expect.objectContaining({
      method: 'fund_file_storage',
      args: { file_id: terms.file_id, amount: '1' },
      deposit: 1n,
    }),
  );
  expect(send).not.toHaveBeenCalled();
  expect(authorize).not.toHaveBeenCalled();
});
