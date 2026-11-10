/**
 * `Annon-Buyer-Proof` (specs/download.md section 3): a BLS signature by the purchase's one-time key
 * over the file URL. Only the buyer holds that key's secret (the facilitator sees the payload with
 * its public key, never this header), and the URL ties the proof to one host and file.
 */
import { bls12_381 as bls } from '@noble/curves/bls12-381.js';

export const BUYER_PROOF_DST = 'ANNON-BUYER-PROOF-V1_BLS_SIG_BLS12381G2_XMD:SHA-256_SSWU_RO_';
export const BUYER_PROOF_HEADER = 'Annon-Buyer-Proof';

const sigs = bls.longSignatures;
const utf8 = new TextEncoder();

/** `UTF8("annon/v1.1 buyer proof") || 0x0a || UTF8(resource.url)`. */
export const buyerProofMessage = (resourceUrl: string) =>
  Uint8Array.from([...utf8.encode('annon/v1.1 buyer proof'), 0x0a, ...utf8.encode(resourceUrl)]);

const b64url = (b: Uint8Array) =>
  btoa(String.fromCharCode(...b))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');

/** The header value: the one-time key's 32-byte secret signs `resourceUrl`. */
export function buyerProof(secret: Uint8Array, resourceUrl: string): string {
  return b64url(
    sigs.sign(sigs.hash(buyerProofMessage(resourceUrl), BUYER_PROOF_DST), secret).toBytes(true),
  );
}

/**
 * Whether `proof` is the buyer key's signature over `resourceUrl`. Both points must decode, be in
 * their subgroups and not be the identity; anything malformed is false, never an exception.
 */
export function verifyBuyerProof(buyerKey: string, resourceUrl: string, proof: string): boolean {
  try {
    if (!/^0x[0-9a-f]{96}$/.test(buyerKey) || !/^[A-Za-z0-9_-]{128}$/.test(proof)) return false;
    const pk = bls.G1.Point.fromBytes(
      Uint8Array.from(buyerKey.slice(2).match(/../g) ?? [], (h) => Number.parseInt(h, 16)),
    );
    const raw = Uint8Array.from(atob(proof.replaceAll('-', '+').replaceAll('_', '/')), (c) =>
      c.charCodeAt(0),
    );
    const sig = bls.G2.Point.fromBytes(raw);
    if (pk.is0() || sig.is0() || !pk.isTorsionFree() || !sig.isTorsionFree()) return false;
    return sigs.verify(sig, sigs.hash(buyerProofMessage(resourceUrl), BUYER_PROOF_DST), pk);
  } catch {
    return false;
  }
}

/** The URL as WHATWG parses and serializes it, without the fragment; null if it doesn't parse. */
function canonical(url: string): string | null {
  if (!URL.canParse(url)) return null;
  const u = new URL(url);
  u.hash = '';
  return u.href;
}

/** A client signs a proof only when the advertised `resource.url` is where the request goes. */
export function sameResource(advertised: string, requested: string): boolean {
  const a = canonical(advertised);
  return a !== null && a === canonical(requested);
}

export interface PurchaseProof {
  purchase_id: string;
  grant: number;
  signature: string;
}
/** The existing URL signature, accompanied by its final contract lookup coordinates. */
export function purchaseProof(
  secret: Uint8Array,
  url: string,
  purchase_id: string,
  grant = 0,
): string {
  if (
    !/^0x[0-9a-f]{64}$/.test(purchase_id) ||
    !Number.isInteger(grant) ||
    grant < 0 ||
    grant > 0xffffffff
  )
    throw new TypeError('invalid purchase/grant');
  return b64url(
    utf8.encode(JSON.stringify({ purchase_id, grant, signature: buyerProof(secret, url) })),
  );
}
export function readPurchaseProof(header: string | null): PurchaseProof | null {
  try {
    if (!header || header.length > 512 || !/^[A-Za-z0-9_-]+$/.test(header)) return null;
    const p = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(
        Uint8Array.from(atob(header.replaceAll('-', '+').replaceAll('_', '/')), (c) =>
          c.charCodeAt(0),
        ),
      ),
    ) as PurchaseProof;
    if (
      Object.keys(p).sort().join() !== 'grant,purchase_id,signature' ||
      !/^0x[0-9a-f]{64}$/.test(p.purchase_id) ||
      !Number.isInteger(p.grant) ||
      p.grant < 0 ||
      p.grant > 0xffffffff ||
      !/^[A-Za-z0-9_-]{128}$/.test(p.signature)
    )
      return null;
    return p;
  } catch {
    return null;
  }
}
