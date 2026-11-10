# Downloading a bought file (v1.1 draft)

How a buyer's client gets an Annon file from a host. It implements section 7 of
[x402-annon.md](x402-annon.md): the body goes only to a wallet that bought the file, every request
is authorized again against NEAR, and the client checks every chunk against the header it checked
before paying. The resource is the PAY2 file at the offer's `resource.url`: the paid request
returns it (profile section 7), and every later download signs in at the same URL with the
standard x402 [sign-in-with-x](https://github.com/x402-foundation/x402/blob/main/specs/extensions/sign-in-with-x.md)
extension (SIWX). v1 used its own challenge and an `Authorization: Annon-SIWE` header; v1.1
replaces both.

## 0. Transport

The file URL is `https` (plain `http` only for `localhost` in development): on plain HTTP anyone on
the path could read the body or race the buyer with an intercepted proof. Clients do not follow
redirects for these requests. Body responses carry `Cache-Control: private, no-store`. Browser
rules are in profile section 9.

In a browser the wallet checks that the message's domain is the origin of the page that asks it to
sign (EIP-4361, "verifying the request origin"); CORS does not change that. So a browser buys and
signs in from a page on the origin of `resource.url`: a file stored elsewhere is served through a
route on that origin.

## 1. One URL, one order

Every request to `resource.url` is handled in this order:

1. A taken-down file answers `410`, whatever the request carries.
2. `PAYMENT-SIGNATURE`, if present, goes through profile sections 4 and 10. A refusal there (a bad
   payload `400`, a payment id reused with another payload `409`, an expired purchase, a stop that
   refuses a new payment) is the answer. Otherwise its state is the `PAYMENT-RESPONSE` of the
   answer.
3. The request is entitled to the file if it has
   - a valid `Annon-Buyer-Proof` (section 3) for the `buyerKey` of a payload in this request whose
     purchase is settled, or
   - a wallet, by its session or its `SIGN-IN-WITH-X` (sections 2 and 4), that bought the file:
     `is_buyer`, or a purchase of this file by it that this host has settled.
4. An entitled request gets the file (section 5), with the `PAYMENT-RESPONSE` of step 2 if there
   was one.
5. A request with a payload whose purchase is not settled yet answers as profile section 7 says
   (`402` with `settlement_pending`, or `503` with `Retry-After`).
6. Otherwise `402` with `PAYMENT-REQUIRED` (profile section 2): the offer while sales are open, and
   always a fresh sign-in challenge, plus the `PAYMENT-RESPONSE` of step 2 if there was one. Once
   sales are stopped, a signed-in wallet that did not buy and has no purchase of this file under
   way on this host answers `403`: there is nothing it can do; one with a purchase under way gets
   that purchase's answer (step 5). An invalid proof, sign-in or session counts as none.

## 2. Sign-in

The challenge is the SIWX `info` as the extension defines it, with:

| Field | Value |
|---|---|
| `domain` | the host of `resource.url`, from the host's configuration (never from request headers) |
| `uri` | `resource.url` |
| `version` | `"1"` |
| `statement` | `Download an Annon file you bought.` |
| `nonce` | 16 random bytes as 32 hex digits, as SIWX defines it |
| `issuedAt` | ISO 8601 UTC |
| `expirationTime` | at most 5 minutes after `issuedAt` |
| `resources` | `["urn:annon:v1:<contract>:<fileId>:<headerHash>"]`, `fileId` and `headerHash` as `0x` and lowercase hex; `headerHash` as in profile section 7 |

and `supportedChains: [{ "chainId": "eip155:8453", "type": "eip191" }]`. The client refuses to sign
a challenge whose `domain` and `uri` origin are not the origin of `resource.url`, whose resource is
not the URN of the file and header it holds, that is already expired by its own clock, issued more
than 60 seconds ahead of it, or valid for more than 5 minutes. The wallet signs the EIP-4361
message SIWX builds from it (`personal_sign`), and the client sends the request again with the
`SIGN-IN-WITH-X` header (base64 JSON: the challenge's fields, `address`, `chainId`, `type` and
`signature`), and `Range` if it resumes.

The host checks, in this order:

1. the proof's challenge fields are exactly a challenge this host issued, not yet used, and it
   deletes it now, whatever the outcome (single use, atomic across the host's instances; SIWX only
   recommends tracking nonces, Annon requires it);
2. `domain` and the origin of `uri` are the host's configured ones, `issuedAt` is at most 5
   minutes old and not in the future, `expirationTime` has not passed;
3. the signature over the EIP-4361 message the host rebuilds from its own challenge and the claimed
   `address` recovers to `address` (65 bytes, low `s`, `v` 27 or 28);
4. then section 1, step 3, for that wallet.

A failure of 1 to 3 is no sign-in (section 1, step 5).

## 3. Buyer proof

With the payment, and on its retries, the client sends

```
Annon-Buyer-Proof: <base64url, no padding, of a 96-byte compressed G2 point>
```

a BLS signature (the `longSignatures` form: public key in G1, signature in G2) by the purchase's
one-time key over the octets

```
UTF8("annon/v1.1 buyer proof") || 0x0a || UTF8(resource.url)
```

hashed to G2 with the domain separation tag `ANNON-BUYER-PROOF-V1_BLS_SIG_BLS12381G2_XMD:SHA-256_SSWU_RO_`
(RFC 9380). `specs/vectors/buyer-proof.json` holds test vectors.

**The client binds it to where it goes.** It signs and sends a proof only in a request to
`resource.url` itself, and only if `resource.url` is the URL of the request that received the
`402`: both parsed and serialized by the WHATWG URL standard, without fragment, must be equal
strings. Otherwise it signs nothing: an endpoint that advertises another host's URL gets no proof
it could pass on.

**The host checks it** against the `buyerKey` of the payload in the same request (a valid G1 point,
not the identity; the nonce commits to it, profile section 3) and its own configured
`resource.url`, never one from the request, and checks that the signature is a valid G2 point in
its subgroup. The facilitator sees the payload, never this header; another host has another URL.
The proof needs no wallet prompt: the client holds the one-time secret anyway, to open the file.

## 4. Session

A request that passed section 2 is answered as section 1 says, and carries `Annon-Session: <token>`:
at least 128 random bits, opaque, bound by the host to the signed-in wallet and its own origin. It
expires two hours after the sign-in at the latest, and is never extended: a later sign-in makes a
new one. The host can revoke it. The client keeps it in memory only and sends it on later requests
to this host, for any file:

```
Authorization: Bearer <token>
Range: bytes=<offset>-
```

A missing, expired or revoked session is no session (section 1). The token is never in a URL, a
cookie or a log line.

## 5. Serving the file

For every entitled request, Range requests included: a wallet is the one the sign-in or the session
names, never one from the request; "bought" is `is_buyer(fileId, wallet)` on the trusted Annon
contract at final state, or a purchase of this file by it that this host has settled (profile
section 10), until NEAR records it; and the file exists and is not taken down (`get_file` at final
state; `is_buyer` does not see a takedown). The host maps the URL to its contract, `fileId` and
header from its own configuration. A stop does not end past buyers' access. The host serves the
PAY2 file: `206` with `Content-Range` for a Range request, or `200` with the whole file.

## 6. Client checks

The client already holds the header it checked before paying (or its hash, recorded with the
purchase, and then fetches `info.header` and checks it hashes to that) and does not take the header
from the download. It reads the body from the end of the header, chunk by chunk, with the lengths
the header implies, and passes a chunk on only after its `SHA256` equals the header's hash for it.
The last chunk is the rest of the file and must be 16 to `C + 16` bytes, checked on its own (a
seller can sign the hash of a malformed chunk); any byte after it is a mismatch. A response that
ends before the end its `Content-Range` (or `Content-Length`) announced, or an error on the
connection, is a broken connection: the client resumes with `Range` from the first byte of the
first unchecked chunk, with its payload and proof, or its session, or after signing in; a `206`
must start exactly there, a `200` is skipped up to there. A mismatch is final,
without retries: the client discards what it received.
