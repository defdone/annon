import { expect, it, vi } from 'vitest';
import { Annon } from './api/annon.js';
import { MAX_PLAINTEXT_BYTES } from './limits.js';
import { memoryStore } from './pay/store.js';

it('refuses oversized replayable plaintext before reads, signing or chain access', async () => {
  const read = vi.fn();
  const sign = vi.fn();
  const sdk = new Annon({
    nearRpc: 'https://near.test',
    baseRpc: 'https://base.test',
    network: 'near:mainnet',
    contractId: 'annon.near',
    rawStore: memoryStore(),
    backupSecret: new Uint8Array(32),
    writeBackup: vi.fn(),
  });
  const seller = {
    identity: { kind: 'evm' as const, id: `0x${'11'.repeat(20)}` },
    authorize: sign,
  };
  await expect(
    sdk.sell({
      data: { size: MAX_PLAINTEXT_BYTES + 1, read },
      seller,
      name: 'f',
      mime: '',
      near: {
        price: '200000',
        recipients: [{ identity: seller.identity, bps: 10000 }],
        remainder: seller.identity,
      },
      publish: vi.fn(),
    }),
  ).rejects.toMatchObject({ code: 'too_large' });
  expect(read).not.toHaveBeenCalled();
  expect(sign).not.toHaveBeenCalled();
});

it('applies the same plaintext cap to a resumed sale and the encrypted cap to streamed opening', async () => {
  const sdk = new Annon({
    nearRpc: 'https://near.test',
    baseRpc: 'https://base.test',
    network: 'near:mainnet',
    contractId: 'annon.near',
    rawStore: memoryStore(),
    backupSecret: new Uint8Array(32),
    writeBackup: vi.fn(),
  });
  const read = vi.fn();
  await expect(
    sdk.resumeSell({
      fileId: `0x${'11'.repeat(32)}`,
      data: { size: MAX_PLAINTEXT_BYTES + 1, read },
      seller: { identity: { kind: 'near', id: 'seller.near' }, authorize: vi.fn() },
      publish: vi.fn(),
    }),
  ).rejects.toMatchObject({ code: 'too_large' });
  const { MAX_PAY2_BYTES } = await import('./limits.js');
  await expect(
    sdk.openTo({ file: { size: MAX_PAY2_BYTES + 1, read }, sink: new WritableStream() }),
  ).rejects.toMatchObject({ code: 'too_large' });
  expect(read).not.toHaveBeenCalled();
});
