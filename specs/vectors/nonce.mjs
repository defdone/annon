// Writes nonce.json: the EIP-3009 nonce of specs/nonce.md. The contract (Rust, NEAR's keccak) and
// the SDK (TypeScript) check the same values, so the implementations must agree.
//   node specs/vectors/nonce.mjs
import { writeFileSync } from 'node:fs';
import { keccak_256 } from '@noble/hashes/sha3.js';

const hex = (b) => Buffer.from(b).toString('hex');
const bytes = (h) => Buffer.from(h.replace(/^0x/, ''), 'hex');

export const annonNonce = (contractId, fileId, buyerKey) =>
  keccak_256(
    Buffer.concat([
      Buffer.from('annon/v1'),
      Buffer.from(contractId),
      bytes(fileId),
      bytes(buyerKey),
    ]),
  );

const cases = [
  // The fixture of the contract's unit tests: file 0x11.., buyer key 0x33...
  {
    id: 'unit-test-fixture',
    contractId: 'v1.annon.defdone.near',
    fileId: `0x${'11'.repeat(32)}`,
    buyerKey: `0x${'33'.repeat(48)}`,
  },
  {
    id: 'mixed-bytes',
    contractId: 'annon-dev.synthetic.near',
    fileId: `0x${hex(keccak_256(Buffer.from('file')))}`,
    buyerKey: `0x${hex(Buffer.concat([keccak_256(Buffer.from('a')), keccak_256(Buffer.from('b')).subarray(0, 16)]))}`,
  },
];

const out = cases.map((c) => ({
  ...c,
  annonNonce: `0x${hex(annonNonce(c.contractId, c.fileId, c.buyerKey))}`,
}));
writeFileSync(
  new URL('./nonce.json', import.meta.url),
  `${JSON.stringify({ spec: 'specs/nonce.md', cases: out }, null, 1)}\n`,
);
console.log(JSON.stringify(out, null, 1));
