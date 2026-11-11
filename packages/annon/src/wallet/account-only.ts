/** Never supply contractId/methodNames: MyNearWallet otherwise generates a local secret. */
export async function signInAccountOnly(wallet: {
  signOut?: () => Promise<void>;
  signIn(params: { contractId?: string }): Promise<{ accountId: string }[]>;
}): Promise<{ accountId: string }[]> {
  // A reused loopback origin may contain older connector authority. Never let it sign silently.
  await wallet.signOut?.();
  return wallet.signIn({});
}
