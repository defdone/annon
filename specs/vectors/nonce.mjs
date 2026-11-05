// Writes nonce.json: the EIP-3009 nonces of specs/nonce.md. The contract (Rust, NEAR's keccak) and
// the splitter tests (Solidity) check the same values, so all three implementations must agree.
//   node specs/vectors/nonce.mjs
import { writeFileSync } from 'node:fs';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3.js';

const hex = (b) => Buffer.from(b).toString('hex');
const bytes = (h) => Buffer.from(h.replace(/^0x/, ''), 'hex');
const addressOf = (priv) =>
  `0x${hex(keccak_256(secp256k1.getPublicKey(priv, false).subarray(1)).subarray(12))}`;

export const annonNonce = (contractId, fileId, buyerKey) =>
  keccak_256(
    Buffer.concat([
      Buffer.from('annon/v1'),
      Buffer.from(contractId),
      bytes(fileId),
      bytes(buyerKey),
    ]),
  );
// Solidity: keccak256(abi.encodePacked(address creator, bytes32 commitment)).
export const partnerNonce = (creator, commitment) =>
  keccak_256(Buffer.concat([bytes(creator), commitment]));

const cases = [
  // The fixture of the contract's unit tests: file 0x11.., buyer key 0x33.., seller key [1; 32].
  {
    id: 'unit-test-fixture',
    contractId: 'v1.annon.defdone.near',
    fileId: `0x${'11'.repeat(32)}`,
    buyerKey: `0x${'33'.repeat(48)}`,
    seller: addressOf(new Uint8Array(32).fill(1)),
  },
  {
    id: 'mixed-bytes',
    contractId: 'annon-dev.synthetic.near',
    fileId: `0x${hex(keccak_256(Buffer.from('file')))}`,
    buyerKey: `0x${hex(Buffer.concat([keccak_256(Buffer.from('a')), keccak_256(Buffer.from('b')).subarray(0, 16)]))}`,
    seller: '0x00000000000000000000000000000000000000ff',
  },
];

const out = cases.map((c) => {
  const annon = annonNonce(c.contractId, c.fileId, c.buyerKey);
  return {
    ...c,
    annonNonce: `0x${hex(annon)}`,
    partnerNonce: `0x${hex(partnerNonce(c.seller, annon))}`,
  };
});
writeFileSync(
  new URL('./nonce.json', import.meta.url),
  `${JSON.stringify({ spec: 'specs/nonce.md', cases: out }, null, 1)}\n`,
);
console.log(JSON.stringify(out, null, 1));
