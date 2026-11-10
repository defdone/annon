// Independent Base nonce encoder; only purchase commitments are inputs.
import { readFileSync, writeFileSync } from 'node:fs';
import { keccak_256 } from '@noble/hashes/sha3.js';

const purchases = JSON.parse(
  readFileSync(new URL('./near-settlement.json', import.meta.url)),
).purchases;
const cases = purchases.map((p) => ({
  id: p.id,
  purchase_id: p.purchase_id,
  base_nonce: `0x${Buffer.from(keccak_256(Buffer.concat([Buffer.from('annon/base-payment/v2'), Buffer.from([0]), Buffer.from(p.purchase_id.slice(2), 'hex')]))).toString('hex')}`,
}));
writeFileSync(
  new URL('./nonce.json', import.meta.url),
  `${JSON.stringify({ spec: 'specs/nonce.md', cases }, null, 2)}\n`,
);
console.log(`nonce.json: ${cases.length} commitments`);
