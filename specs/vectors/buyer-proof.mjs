// Writes buyer-proof.json: the Annon-Buyer-Proof of specs/download.md section 3, a BLS signature
// (public key in G1, signature in G2) by a purchase's one-time key over the file URL.
//   node specs/vectors/buyer-proof.mjs
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { bls12_381 as bls } from '@noble/curves/bls12-381.js';

export const DST = 'ANNON-BUYER-PROOF-V1_BLS_SIG_BLS12381G2_XMD:SHA-256_SSWU_RO_';
const hex = (b) => Buffer.from(b).toString('hex');
const b64url = (b) => Buffer.from(b).toString('base64url');
const sigs = bls.longSignatures;

export const message = (url) =>
  Buffer.concat([Buffer.from('annon/v1.1 buyer proof'), Buffer.from([0x0a]), Buffer.from(url)]);

const cases = [
  { id: 'small-scalar', secret: 7n, url: 'https://seller.example/f/1' },
  {
    id: 'path-query-port',
    secret: 0x1f2e3d4c5b6a79880123456789abcdeffedcba9876543210aabbccddeeff00n,
    url: 'https://files.example:8443/a/b%20c?file=0x11&x=1',
  },
  {
    id: 'unicode-path',
    secret: 0x2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2an,
    url: 'https://xn--bcher-kva.example/%C3%BC/file',
  },
];

const valid = cases.map((c) => {
  const sk = Buffer.from(c.secret.toString(16).padStart(64, '0'), 'hex');
  const pk = sigs.getPublicKey(sk).toBytes(true);
  const sig = sigs.sign(sigs.hash(message(c.url), DST), sk).toBytes(true);
  const purchase_id = `0x${createHash('sha256').update(c.id).digest('hex')}`;
  const grant = c.id === 'small-scalar' ? 0 : 7;
  return {
    purchase_id,
    grant,
    header: b64url(Buffer.from(JSON.stringify({ purchase_id, grant, signature: b64url(sig) }))),
    id: c.id,
    secret: `0x${hex(sk)}`,
    buyerKey: `0x${hex(pk)}`,
    resourceUrl: c.url,
    message: `0x${hex(message(c.url))}`,
    proof: b64url(sig),
  };
});

const [first, second] = valid;
// Each must fail: another URL, another key, another DST, a flipped byte.
const otherDst = sigs
  .sign(
    sigs.hash(message(first.resourceUrl), 'ANNON-OTHER_XMD:SHA-256_SSWU_RO_'),
    Buffer.from(first.secret.slice(2), 'hex'),
  )
  .toBytes(true);
const flipped = Buffer.from(first.proof, 'base64url');
flipped[40] ^= 1;
const invalid = [
  {
    id: 'other-url',
    buyerKey: first.buyerKey,
    resourceUrl: `${first.resourceUrl}/x`,
    proof: first.proof,
  },
  {
    id: 'other-key',
    buyerKey: second.buyerKey,
    resourceUrl: first.resourceUrl,
    proof: first.proof,
  },
  {
    id: 'other-dst',
    buyerKey: first.buyerKey,
    resourceUrl: first.resourceUrl,
    proof: b64url(otherDst),
  },
  {
    id: 'flipped-byte',
    buyerKey: first.buyerKey,
    resourceUrl: first.resourceUrl,
    proof: b64url(flipped),
  },
];

writeFileSync(
  new URL('buyer-proof.json', import.meta.url),
  `${JSON.stringify({ dst: DST, valid, invalid }, null, 2)}\n`,
);
console.log(`buyer-proof.json: ${valid.length} valid, ${invalid.length} invalid`);
