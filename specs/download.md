# Download after payment (v1)

How a buyer's client gets an Annon file from a host after paying. It implements section 7 of
[x402-annon.md](x402-annon.md): the body is served only to a wallet that bought the file, every
request is authorized again, and the client checks every chunk against the header it checked
before paying. The SDK implements both sides (`download`, `verifyDownload` in
`packages/annon/src/download`).

## 0. Transport

`info.download` is an `https` URL (plain `http` only for `localhost` in development): on plain HTTP
anyone on the path could read the body or race the buyer with the intercepted authorization.
Clients do not follow redirects for these requests.

In a browser the wallet checks that the message's domain is the page's own host (EIP-4361,
"verifying the request origin"), so `info.download` must be on the host of the page that asks the
wallet to sign. A file stored elsewhere is served through a route on that host.

A host that serves cross-origin clients answers the preflight `OPTIONS` without authorization,
with `204`, `Access-Control-Allow-Origin`, `Access-Control-Allow-Methods: GET` and
`Access-Control-Allow-Headers: Authorization, Range`; and sends `Access-Control-Allow-Origin` and
`Access-Control-Expose-Headers: Content-Range, Content-Length` on the 401, 206 and 200 answers.

## 1. Challenge

`GET <info.download>` without `Authorization` answers `401` with a JSON body:

```json
{ "nonce": "<8 to 64 letters or digits>", "issuedAt": 1800000000, "expiresAt": 1800000120 }
```

Times are Unix seconds; `0 < expiresAt - issuedAt ≤ 120`, and the nonce is 8 to 64 letters or
digits. The body is at most 1 KiB; a client stops reading past that. A client refuses to sign a
challenge outside these bounds, already expired by its own clock, or issued more than 60 s ahead
of it. The host keeps the challenge
and deletes it the first time it is presented, whatever the outcome (single use, atomic across the
host's instances).

## 2. Signed request

The wallet signs this EIP-4361 message with `personal_sign` (EIP-191), lines joined by `\n`, none
after the last:

```
<domain> wants you to sign in with your Ethereum account:
<address, EIP-55>

Download an Annon file you bought.

URI: <info.download>
Version: 1
Chain ID: 8453
Nonce: <nonce>
Issued At: <issuedAt, ISO 8601 UTC with milliseconds>
Expiration Time: <expiresAt, same format>
Resources:
- urn:annon:v1:<contract>:<fileId>:<headerHash>
```

`domain` is the host of `info.download`. `fileId` and `headerHash` are `0x` and lowercase hex;
`headerHash` is `SHA256` of the complete header served at `info.header`. The client then sends
`GET <info.download>` with

```
Authorization: Annon-SIWE <base64url, no padding, of {"address":"0x…","nonce":"…","signature":"0x…"}>
Range: bytes=<offset>-
```

The signature is 65 bytes `r ‖ s ‖ v`, low `s`, `v` 27 or 28.

## 3. Host checks

For every request, Range requests included, in this order: the challenge exists, is deleted,
lives at most 120 s, and `issuedAt ≤ now < expiresAt`; the host rebuilds the message from its own
`domain` and download URL (never from request headers), the challenge and the claimed address,
and the signature
recovers to that address; `is_buyer(fileId, address)` on the trusted Annon contract at final
state is `true`; and the file exists and is not taken down (`get_file` at final state; `is_buyer`
does not see a takedown). A stop does not end past buyers' access. A failure of the first two
answers `401` with a new challenge; a wallet that did not buy answers `403`; a taken-down file
answers `410`. Then the host serves the PAY2 file: `206` with `Content-Range` for a Range
request, or `200` with the whole file.

## 4. Client checks

The client already holds the header it checked before paying and does not take it from the host.
It reads the body from the end of the header, chunk by chunk, with the lengths the header implies,
and passes a chunk on only after its `SHA256` equals the header's hash for it. The last chunk is
the rest of the file and must be 16 to `C + 16` bytes, checked on its own (a seller can sign the
hash of a malformed chunk); any byte after it is a mismatch. A response that ends before the end
its `Content-Range` (or `Content-Length`) announced, or an error on the connection, is a broken
connection: the client gets a new challenge and resumes with `Range` from the first byte of the
first unchecked chunk; a `206` must start exactly there, a `200` is skipped up to there. A
mismatch is final, without retries: the client discards what it received.
