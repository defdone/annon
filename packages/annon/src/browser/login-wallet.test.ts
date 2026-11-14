import { expect, it, vi } from 'vitest';
import { signingRequest } from '../node/signing.js';
import { pageWallets } from './login-wallet.js';

const q = (chain: string) =>
  signingRequest('near.signTransaction', chain, 'bot.near', {
    receiverId: 'usdc.near',
    method: 'ft_transfer_call',
    args: {},
    gas: '1',
    deposit: '1',
  });

it.each([
  ['near:mainnet', 'my-near-wallet', 'Unknown NEAR wallet'],
  [
    'near:testnet',
    'hot-wallet',
    'HOT Wallet is offered for near:mainnet only. Pick Meteor Wallet.',
  ],
  ['near:sandbox', 'hot-wallet', 'not near:sandbox'],
  ['near:sandbox', 'meteor-wallet', 'not near:sandbox'],
])('on %s the page refuses %s before any wallet code runs', async (chain, id, message) => {
  const sending = vi.fn();
  const wallets = pageWallets({ expect: vi.fn(), forget: vi.fn(), sending });
  await expect(wallets.run(q(chain), id)).rejects.toThrow(message);
  expect(sending).not.toHaveBeenCalled();
});
