// Prints the NEAR code hash of a wasm file: base58 of its SHA-256, as view_account reports it.
// Usage: node contracts/annon/code-hash.mjs <file.wasm>
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export function base58(bytes) {
  let n = BigInt(`0x${Buffer.from(bytes).toString('hex') || '0'}`);
  let out = '';
  while (n > 0n) {
    out = ALPHABET[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = `1${out}`;
  }
  return out;
}

if (process.argv[2] === '--self-check') {
  // Bitcoin base58 test vectors.
  const cases = [
    ['', ''],
    ['00', '1'],
    ['0000287fb4cd', '11233QC4'],
    ['61', '2g'],
    ['626262', 'a3gV'],
  ];
  for (const [hex, want] of cases) {
    const got = base58(Buffer.from(hex, 'hex'));
    if (got !== want) throw new Error(`base58(${hex}) = ${got}, want ${want}`);
  }
  console.log('code-hash self-check ok');
} else {
  const digest = createHash('sha256').update(readFileSync(process.argv[2])).digest();
  console.log(`code hash: ${base58(digest)} (sha256 ${digest.toString('hex')})`);
}
