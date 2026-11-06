/**
 * EIP-3009 on Base USDC: the authorization a buyer signs, its EIP-712 digest, the checks on the
 * signature a wallet sends back. Nonces as in `specs/nonce.md`.
 */
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3.js';

export const BASE_CHAIN_ID = 8453;

/** What the buyer signs: USDC `TransferWithAuthorization` straight to the file's `pay_to`. */
const PRIMARY_TYPE = 'TransferWithAuthorization';

export interface Authorization {
  from: string;
  to: string;
  value: bigint;
  validAfter: bigint;
  validBefore: bigint;
  nonce: string;
}

const FIELDS = [
  { name: 'from', type: 'address' },
  { name: 'to', type: 'address' },
  { name: 'value', type: 'uint256' },
  { name: 'validAfter', type: 'uint256' },
  { name: 'validBefore', type: 'uint256' },
  { name: 'nonce', type: 'bytes32' },
] as const;

/** The typed data in the shape `signTypedData` takes (viem, ethers' `_signTypedData` minus domain types). */
export const typedData = (usdc: string, a: Authorization) => ({
  domain: { name: 'USD Coin', version: '2', chainId: BASE_CHAIN_ID, verifyingContract: usdc },
  types: { [PRIMARY_TYPE]: FIELDS },
  primaryType: PRIMARY_TYPE,
  message: a,
});

export type TypedData = ReturnType<typeof typedData>;

const utf8 = new TextEncoder();
const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};
export const toHex = (b: Uint8Array) =>
  `0x${Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')}`;
export function fromHex(s: string, bytes: number, name: string): Uint8Array {
  if (!new RegExp(`^0x[0-9a-fA-F]{${2 * bytes}}$`).test(s)) {
    throw new TypeError(`${name} must be 0x and ${bytes} bytes of hex`);
  }
  return Uint8Array.from(s.slice(2).match(/../g) ?? [], (x) => Number.parseInt(x, 16));
}
/** A uint256 word. */
export function word(n: bigint): Uint8Array {
  if (n < 0n || n >= 2n ** 256n) throw new RangeError('not a uint256');
  return fromHex(`0x${n.toString(16).padStart(64, '0')}`, 32, 'word');
}
/** An address as a 32-byte word. */
export const addressWord = (a: string) => concat(new Uint8Array(12), fromHex(a, 20, 'address'));

/** The EIP-712 digest a wallet signs for `typedData(usdc, a)`. */
export function digest(usdc: string, a: Authorization): Uint8Array {
  const domainType = keccak_256(
    utf8.encode(
      'EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)',
    ),
  );
  const domain = keccak_256(
    concat(
      domainType,
      keccak_256(utf8.encode('USD Coin')),
      keccak_256(utf8.encode('2')),
      word(BigInt(BASE_CHAIN_ID)),
      addressWord(usdc),
    ),
  );
  const type = keccak_256(
    utf8.encode(`${PRIMARY_TYPE}(${FIELDS.map((f) => `${f.type} ${f.name}`)})`),
  );
  const struct = keccak_256(
    concat(
      type,
      addressWord(a.from),
      addressWord(a.to),
      word(a.value),
      word(a.validAfter),
      word(a.validBefore),
      fromHex(a.nonce, 32, 'nonce'),
    ),
  );
  return keccak_256(concat(new Uint8Array([0x19, 0x01]), domain, struct));
}

/**
 * The address that signed `digest`, or null. Only what USDC itself accepts: 65 bytes r ‖ s ‖ v,
 * v 27 or 28, low s (FiatToken's ECRecover refuses the rest).
 */
export function signer(digestBytes: Uint8Array, signature: string): string | null {
  if (!/^0x[0-9a-fA-F]{130}$/.test(signature)) return null;
  const sig = fromHex(signature, 65, 'signature');
  const v = sig[64] ?? 0;
  const s = BigInt(toHex(sig.subarray(32, 64)));
  if ((v !== 27 && v !== 28) || s > secp256k1.Point.Fn.ORDER / 2n) return null;
  try {
    const pub = secp256k1.Point.fromBytes(
      secp256k1.recoverPublicKey(
        concat(new Uint8Array([v - 27]), sig.subarray(0, 64)),
        digestBytes,
        {
          prehash: false,
        },
      ),
    );
    return toHex(keccak_256(pub.toBytes(false).subarray(1)).subarray(12));
  } catch {
    return null;
  }
}

/** `keccak256("annon/v1" ‖ contractId ‖ fileId ‖ buyerKey)`. */
export const annonNonce = (contractId: string, fileId: string, buyerKey: Uint8Array) =>
  toHex(
    keccak_256(
      concat(
        utf8.encode('annon/v1'),
        utf8.encode(contractId),
        fromHex(fileId, 32, 'fileId'),
        buyerKey,
      ),
    ),
  );
