import { expect, it, vi } from 'vitest';
import { signInAccountOnly } from './account-only.js';

it('MyNearWallet signIn omits contractId and methodNames, preventing function-call key creation', async () => {
  const signIn = vi.fn(async (_params: { contractId?: string }) => [{ accountId: 'a.near' }]);
  await signInAccountOnly({ signIn });
  expect(signIn).toHaveBeenCalledWith({});
  expect(Object.keys(signIn.mock.calls[0]?.[0] ?? {})).not.toContain('contractId');
});

it('clears any stale connector authority before requesting account-only sign-in', async () => {
  const signOut = vi.fn(async () => {});
  const signIn = vi.fn(async (_params: { contractId?: string }) => [{ accountId: 'a.near' }]);
  await signInAccountOnly({ signIn, signOut });
  expect(signOut).toHaveBeenCalledTimes(1);
  expect(signOut.mock.invocationCallOrder[0]).toBeLessThan(signIn.mock.invocationCallOrder[0] ?? 0);
});
