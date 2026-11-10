/** NEP-413: https://github.com/near/NEPs/blob/master/neps/nep-0413.md */
import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { base58, base64 } from '@scure/base';
import { account, concat, le, str } from '../settle-near/codec.js';
import { isFullAccessKey } from './rpc.js';

export interface NearMessage {
  message: string;
  recipient: string;
  nonce: Uint8Array;
}
export interface NearSignedMessage {
  accountId: string;
  publicKey: string;
  signature: string;
}
export interface RecoveryProofContext {
  contractId: string;
  nearRpc: string;
}
/** u32 tag (2^31+413), Borsh message, fixed nonce, recipient, absent callbackUrl. */
export function nep413Hash(p: NearMessage): Uint8Array {
  if (p.nonce.length !== 32) throw new TypeError('NEP-413 nonce must be 32 bytes');
  return sha256(concat(le(2147484061, 4), str(p.message), p.nonce, str(p.recipient), le(0, 1)));
}
export async function proveNearControl(
  accountId: string,
  text: string,
  context: RecoveryProofContext,
  signMessage: (p: NearMessage) => Promise<NearSignedMessage | undefined>,
): Promise<void> {
  account(accountId);
  account(context.contractId);
  const payload = {
    message: text,
    recipient: context.contractId,
    nonce: crypto.getRandomValues(new Uint8Array(32)),
  };
  const hash = nep413Hash(payload);
  const result = await signMessage({ ...payload, nonce: payload.nonce.slice() });
  if (!result || result.accountId !== accountId || !result.publicKey.startsWith('ed25519:'))
    throw new Error('NEP-413 proof belongs to another account or key type');
  const key = base58.decode(result.publicKey.slice(8));
  const signature = base64.decode(result.signature);
  if (
    key.length !== 32 ||
    signature.length !== 64 ||
    !ed25519.verify(signature, hash, key, { zip215: false })
  )
    throw new Error('invalid NEP-413 recovery signature');
  if (!(await isFullAccessKey(context.nearRpc, accountId, result.publicKey)))
    throw new Error('NEP-413 recovery requires a full-access key');
}
