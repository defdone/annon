/**
 * A seller check that failed with `wrong_identity`, explained to a person: who they are signed in
 * as, who the file's seller is, and what to do. `--json` and agent mode keep the plain error.
 */
import type { Identity } from '../../settle-near/identity.js';
import { AdapterError, publicError } from '../errors.js';
import { identityLabel } from './seller-terms.js';

type Named = { code?: unknown; required?: Identity; offered?: Identity; cause?: unknown };

/** The identities the SDK attached to a wrong_identity error, directly or on its cause. */
function identities(error: unknown): { required: Identity; offered: Identity } | undefined {
  for (let e = error as Named | undefined, depth = 0; e && depth < 3; depth++) {
    if (e.required && e.offered) return { required: e.required, offered: e.offered };
    e = e.cause as Named | undefined;
  }
  return undefined;
}

export function sellerIdentityText(required: Identity, offered: Identity, signedIn: boolean) {
  const seller = `This file's seller is ${identityLabel(required)}.`;
  const login = required.kind === 'evm' || required.kind === 'near';
  return signedIn
    ? `You are signed in as ${identityLabel(offered)}. ${seller} ${
        login
          ? `Sign in as the seller with \`annon login --wallet ${required.kind}\` (choose that account in your wallet), then run the command again.`
          : "Use the seller's wallet, then run the command again."
      }`
    : `Your wallet is ${identityLabel(offered)}. ${seller} Use the seller's wallet, then run the command again.`;
}

/** The human error for a failed seller check, or the original error when there is nothing to add. */
export function sellerIdentityError(error: unknown, signedIn: boolean): unknown {
  const named = identities(error);
  if ((error as Named | undefined)?.code !== 'wrong_identity' || !named) return error;
  const { exitCode, fileId } = publicError(error);
  return Object.assign(
    new AdapterError(
      'wrong_identity',
      sellerIdentityText(named.required, named.offered, signedIn),
      exitCode,
    ),
    fileId ? { fileId } : {},
  );
}
