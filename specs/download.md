# Downloading a purchased file

One model: [near-settlement.md §9](near-settlement.md). Possession of the secret for a final
purchase grant authorizes downloading. Recovery wallets create new grants through `reopen`.

## 1. Host checks

For every request, including Range requests, read final `get_file`; unknown is 404, taken down is
410. Process any PAYMENT-SIGNATURE using the x402 profile. Parse Annon-Buyer-Proof and read final
`get_purchase(purchase_id)` and `get_grant(purchase_id, grant)`. The purchase must name this file,
the grant must exist in its grant count, and the signature must verify against that grant's key
and this host's configured resource.url. A stopped sale preserves earlier access. Neither a
wallet signature nor a facilitator settlement substitutes for the final purchase and grant.
Without a usable proof answer 402 and PAYMENT-REQUIRED; stopped files advertise no offers.

## 2. Transport

HTTPS, plain HTTP only for localhost development; no redirects, cookies or caches. Authorized
responses carry Cache-Control: private, no-store. The client signs only the advertised resource.url
whose WHATWG serialization, ignoring fragment, equals the actual requested URL. The host uses its
configured URL, contract and file, never values chosen by request headers.

## 3. Buyer proof

Annon-Buyer-Proof is unpadded base64url of compact UTF-8 JSON:

```
{"purchase_id":"0x<32 bytes>","grant":0,"signature":"<unpadded base64url G2 signature>"}
```

Unknown fields, malformed coordinates and oversized headers fail closed. The signature is the
existing BLS long-signatures URL proof, public key in G1, signature in G2, over
`UTF8("annon/v1.1 buyer proof") ‖ 0x0a ‖ UTF8(resource.url)`, hashed to G2 with DST
`ANNON-BUYER-PROOF-V1_BLS_SIG_BLS12381G2_XMD:SHA-256_SSWU_RO_` (RFC 9380). Points must be in their
prime-order subgroups and nonidentity. The unchanged cryptographic domain is independent of the
retired settlement format. The wrapper carries the purchase/grant lookup coordinates; changing
either requires a signature under that grant's key. Vectors: vectors/buyer-proof.json.

## 4. Recovery

A fresh device enumerates `purchases_of(recovery, from, limit)`. The recovery identity authorizes
`reopen({purchase_id,fresh_key,nonce,deadline},auth)`. NEAR recovery calls directly. Persist the
fresh secret before this call; keep it even if the CKD callback fails, and retry claim_key for
that grant. Earlier grants remain usable. There is no download entitlement indexed by wallet.

## 5. Serving bytes

Serve the PAY2 file with 200, or 206 plus Content-Range for `Range: bytes=<offset>-`; out-of-bounds
is 416. Each request is checked as in §1. The client already holds the checked complete header or
fetches it and checks the recorded SHA256. It never adopts an unchecked replacement header.

## 6. Client checks

Read the body from the end of the checked header. Emit each chunk only after its SHA256 matches
the header hash list. Check last chunk length 16..C+16 independently, and refuse trailing bytes.
A broken response resumes from the first unchecked chunk using the same grant proof. A 206 must
start exactly at that offset and have valid bounds. A 200 is skipped up to the requested offset.
A chunk mismatch is final; the caller discards received bytes. Opening also verifies GCM, the
header MAC and metadata as specified by pay2.md.
