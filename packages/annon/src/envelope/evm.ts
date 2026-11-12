import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3.js';

const utf8 = new TextEncoder();
const concat = (...parts: Uint8Array[]) => Uint8Array.from(parts.flatMap((p) => Array.from(p)));
const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

/**
 * Whether `sig` (r ‖ s ‖ v, low s, v 27 or 28) is `address` signing `text` with EIP-191.
 */
export function signedBy(text: string, sig: Uint8Array, address: string): boolean {
  return signerOf(text, sig) === address.toLowerCase();
}

/**
 * The address that signed `text` with EIP-191 (r ‖ s ‖ v, low s, v 27 or 28), lowercase 0x, or
 * null for a signature that recovers to nobody.
 */
export function signerOf(text: string, sig: Uint8Array): string | null {
  if (sig.length !== 65 || (sig[64] !== 27 && sig[64] !== 28)) return null;
  const s = BigInt(`0x${toHex(sig.subarray(32, 64))}`);
  if (s > secp256k1.Point.Fn.ORDER / 2n) return null;
  const t = utf8.encode(text);
  const digest = keccak_256(concat(utf8.encode(`\x19Ethereum Signed Message:\n${t.length}`), t));
  try {
    const recovered = concat(new Uint8Array([(sig[64] ?? 27) - 27]), sig.subarray(0, 64));
    const pub = secp256k1.Point.fromBytes(
      secp256k1.recoverPublicKey(recovered, digest, { prehash: false }),
    );
    return `0x${toHex(keccak_256(pub.toBytes(false).subarray(1)).subarray(12))}`;
  } catch {
    return null;
  }
}
