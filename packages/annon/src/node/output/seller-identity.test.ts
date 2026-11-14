import { expect, it } from 'vitest';
import { SellError } from '../../api/annon.js';
import { AnnonError, withIdentities } from '../../errors.js';
import { publicError } from '../errors.js';
import { sellerIdentityError } from './seller-identity.js';

const seller = { kind: 'evm' as const, id: `0xe8cc${'00'.repeat(16)}d86d` };
const signedIn = { kind: 'near' as const, id: 'alice.near' };
const fileId = `0x${'22'.repeat(32)}`;

it('tells a signed-in person who the seller is and how to sign in as them', () => {
  const error = withIdentities(new AnnonError('wrong_identity'), seller, signedIn);
  expect(publicError(sellerIdentityError(error, true))).toEqual({
    code: 'wrong_identity',
    message:
      "You are signed in as near:alice.near. This file's seller is evm:0xe8cc0000...d86d. Sign in as the seller with `annon login --wallet evm` (choose that account in your wallet), then run the command again.",
    exitCode: publicError(error).exitCode,
  });
});

it('finds the identities on a wrapped share resume error and keeps its file ID', () => {
  const error = new SellError(fileId, {
    cause: withIdentities(new AnnonError('wrong_identity'), seller, signedIn),
  });
  expect(publicError(sellerIdentityError(error, true))).toMatchObject({
    code: 'wrong_identity',
    message: expect.stringMatching(/^You are signed in as near:alice\.near\./),
    fileId,
  });
});

it('leaves other errors and a wrong_identity without identities unchanged', () => {
  const plain = new AnnonError('wrong_identity');
  expect(sellerIdentityError(plain, true)).toBe(plain);
  const other = withIdentities(new AnnonError('unknown_file'), seller, signedIn);
  expect(sellerIdentityError(other, true)).toBe(other);
  // The identities never reach the public error.
  expect(JSON.stringify(publicError(other))).not.toContain('alice');
});
