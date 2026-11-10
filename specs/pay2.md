# PAY2: the Annon file format

Version 2, one model (10 November 2026). Version 1 is neither produced nor accepted; byte 4 = 1 fails with `unsupported_version`.

PAY2 is the encrypted file a seller uploads and a buyer downloads. Hosting sees only these bytes.
The file key `K` is released by the Annon contract on NEAR (`near-ckd/v1` stanza). The body hash is
registered on the contract and the seller signs the final header, so a buyer can check every byte
against the registration before paying or opening.

PAY2 extends PAY1, the Private Link format Partner has used since September 2026 (chunked
AES-256-GCM, a last-chunk flag against truncation). New in PAY2: key stanzas, a header MAC, a
registered body hash over a chunk hash list, one key per chunk, and an optional verified preview.

All integers are unsigned big-endian. `‖` is concatenation. Strings are ASCII unless stated.
`x[a .. b]` is bytes `a` to `b - 1` of `x`. Base64 is RFC 4648 section 4 (alphabet `A-Z a-z 0-9 + /`)
with padding and nothing else: no whitespace, no URL-safe alphabet, no non-zero unused bits.

## 1. Primitives

| Name | Definition |
|---|---|
| `SHA256(x)` | SHA-256 |
| `HKDF(ikm, salt, info)` | HKDF-SHA256 (RFC 5869), 32-byte output |
| `GCM(k, nonce, p)` | AES-256-GCM, no associated data, output `ciphertext ‖ tag(16)` |
| `KW(kek, k)` | AES-256 key wrap (RFC 3394, default IV `A6A6A6A6A6A6A6A6`), 40 bytes for a 32-byte key |
| `HMAC(k, x)` | HMAC-SHA256 |

## 2. Keys

- `K`: 32 random bytes, fresh for every file. Never reused, never stored by the SDK.
- `fileId`: 32 random bytes chosen by the seller, the same value registered on the contract.
- Chunk key: `k_i = HKDF(K, fileId, "annon/pay2/chunk" ‖ u32(i))` for chunk index `i`.
- Header MAC key: `HKDF(K, fileId, "annon/pay2/header")`.
- Key commitment: `c_i = SHA256("annon/pay2/key" ‖ k_i)` for the chunks a seller may reveal: `c_0`,
  and `c_1` when there is a preview. `kc` is their count (1 or 2).

`k_i` reveals nothing about `K` or any other chunk, so a seller can publish `k_0` and `k_1` as a
preview (section 7). AES-GCM doesn't commit to its key: a seller who knows two keys can build one
ciphertext that decrypts under both to different plaintexts. The commitments, bound into
`cipherHash`, make the published key and the key the buyer later derives the same key.

## 3. Body

The plaintext is split into `n` pieces, in this order:

| Index | Piece | Plaintext length |
|---|---|---|
| 0 | Metadata | `metaLen` (section 3.1) |
| 1, only if `previewLen > 0` | Preview: the first `previewLen` bytes of the file | `previewLen` |
| then `m` data pieces | The rest of the file, in order | `C = 2^chunkLog2` each, the last one 1 to `C` bytes |

- `m = max(1, ceil((size - previewLen) / C))`. The last data piece is empty only for an empty file.
- `previewLen ≤ min(65536, floor(size / 10))`. Encoders default to `0` (no preview).
- Wire chunk `i`: `w_i = GCM(k_i, nonce_i, piece_i)`, where `nonce_i` is 12 zero bytes, except that
  byte 11 is `0x01` for the last chunk (`i = n - 1`). The last chunk is always a data chunk.
- Body: `w_0 ‖ w_1 ‖ … ‖ w_{n-1}`.
- Chunk hash: `h_i = SHA256(w_i)`.
- **`cipherHash = SHA256("annon/pay2/body" ‖ u8 version ‖ u8 chunkLog2 ‖ fileId ‖ u16 metaLen ‖
  u32 previewLen ‖ u32 n ‖ c_0 ‖ [c_1] ‖ h_0 ‖ … ‖ h_{n-1})`**, the fields as in the header (section
  4). This is the value registered on the contract (`cipher_hash`). It binds every header field
  known before `register`; the rest is covered by the seller's signature (section 4.1).

`chunkLog2` is any value from 16 to 24, and decoders accept all of them. Encoders default to 22
(4 MiB) and raise it only when `n` would exceed 1024.

### 3.1 Metadata

`piece_0 = u16 nameLen ‖ name ‖ u8 mimeLen ‖ mime ‖ u64 size ‖ zero padding`:
- `name`: UTF-8, no byte order mark added or removed. Decoders reject invalid UTF-8. It is the
  seller's suggestion only: never use it as a path without sanitizing it.
- `mime`: printable ASCII (`0x20` to `0x7e`), may be empty.
- `size`: the plaintext length in bytes, at most `2^53 - 1`.
- Padding: zero bytes up to `metaLen`, which must be the smallest multiple of 256 that fits, at most
  4096. The padding hides the length of the name.

Binary on purpose: every file has exactly one valid metadata encoding.

## 4. Header

| Offset | Size | Field | Rule |
|---|---|---|---|
| 0 | 4 | magic | `"PAY2"` |
| 4 | 1 | version | `2` |
| 5 | 1 | `chunkLog2` | 16 to 24 |
| 6 | 1 | stanza count | 1 to 8 |
| 7 | 1 | auth kind | 0 EVM, 1 Solana, 2 NEAR; must match registered seller |
| 8 | 4 | `headerLen` | whole header, MAC and signature included; at most 65536 |
| 12 | 32 | `fileId` | |
| 44 | 2 | `metaLen` | 256 to 4096, multiple of 256 |
| 46 | 4 | `previewLen` | 0 to 65536 |
| 50 | 4 | `n` (chunk count) | 2 to 1024; at least 3 if `previewLen > 0` |
| 54 | `32·kc` | `c_0 [c_1]` | key commitments, section 2 |
| `54 + 32·kc` | `32·n` | `h_0 … h_{n-1}` | |
| | | stanzas | section 5 |
| `headerLen - 97` | 32 | MAC | `HMAC(macKey, header[0 .. headerLen - 97])` |
| `headerLen - 65` | 65 | seller signature | section 4.1 |

`prefixLen = 54 + 32·(kc + n)`. `headerLen` must equal `prefixLen + (stanza bytes) + 97` exactly.
The MAC covers every header byte before it: version, `fileId`, sizes, commitments, the hash list and
every stanza.

### 4.1 Seller signature

The stanzas and the MAC need the CKD answer, which exists only after `register`, so the registered
`cipherHash` can't cover them. The seller's wallet signs them instead, once the header is final:

```
Annon: publish a file
contract: <contractId>
file: 0x<fileId, 64 lowercase hex>
header: 0x<SHA256(header[0 .. headerLen - 65]), 64 lowercase hex>
```

Lines end with `\n`, no trailing newline. The registered seller is an Identity from
[near-settlement.md §2](near-settlement.md). The fixed 65-byte trailer is:

- kind 0: EIP-191 `personal_sign` of this text, `r ‖ s ‖ v`, low s, v 27/28;
- kind 1: Ed25519 over exactly UTF-8(text), 64 bytes followed by one zero byte;
- kind 2: 65 zero bytes; the seller calls `publish_header(file_id, header_hash)` and the client
  compares that final registered hash with SHA256(header without trailer).

Unknown kinds, mismatched seller kinds and nonzero padding fail. The contract and file ID in the
text are the values the client independently trusts. A NEAR seller's header must be published
before sales. The body hash includes version 2.

## 5. Stanzas

Each stanza says how to get `K`. Encoding: `u8 typeLen ‖ type ‖ u16 bodyLen ‖ body`, with `type` 1 to
32 characters from `[a-z0-9/.-]` and `bodyLen` at most 1024. Two stanzas of the same type are
invalid. Decoders skip unknown types; the MAC still covers them.

### 5.1 `near-ckd/v1`

`body = u8 len(contractId) ‖ contractId ‖ KW(wrapKey, K)`, length exactly `1 + len + 40`.

- `contractId`: the NEAR account of the Annon contract, 2 to 64 characters from `[a-z0-9._-]`.
  A body that breaks these rules is `bad_stanza`. A decoder uses the
  stanza only if `contractId` is the contract the client trusts (pinned in the SDK, never taken from
  a link or the file); otherwise it skips it.
- `wrapKey = HKDF(ckdSecret, fileId, "annon/pay2/near-ckd/v1")`.
- `ckdSecret`: the BLS12-381 G1 point the client gets from the contract's CKD answer for app path
  `file/<fileId hex>`: `big_c - a·big_y`, where `a` is the one-time secret whose public key was sent
  with `register`, `unlock` or `reopen`. Encoded as 48 bytes in the compressed form of the ZCash
  BLS12-381 serialization (big-endian `x`, flags in the top three bits of byte 0), the encoding
  NEAR uses for G1. The key backend checks the point is on the curve and in the subgroup before it
  hands it to the envelope. The seller and every buyer get the same point for a file.

Reserved for later: `link/v1` (the key in a URL fragment).

## 6. Opening

A decoder runs these steps in order and stops at the first failure with the error code shown. The
buffered API returns nothing on failure. A streaming API may emit a chunk only after its hash and
its GCM tag are checked; on any later failure it signals the error, and the caller must discard
everything it received. Every vector has one fault; when a file has several, a decoder may report
any of their codes, and the outcome (refused) is what matters.

1. **Header.** Read the fixed 54 bytes, then the rest of `headerLen`. Checks, in order:
   magic, or fewer than 4 bytes, `bad_magic`; fewer than 54 bytes `bad_header`; version other than 2
   `unsupported_version`; `chunkLog2` `bad_chunk_size`;
   `headerLen > 65536` `header_too_large`; every other rule on the fixed 54 bytes, `headerLen` below
   `prefixLen + 97`, and a file shorter than `headerLen`, `bad_header`. Then parse `stanza count` stanzas from `prefixLen`:
   a stanza that breaks section 5 or runs past `headerLen - 97` is `bad_stanza`; ending anywhere but
   exactly at `headerLen - 97` is `bad_header`. Nothing larger than `headerLen` is allocated before
   these checks pass.
2. **Registration.** The header's `fileId` must be the file the client looked up on the contract:
   `file_id_mismatch`. Compute `cipherHash` from the commitments and the hash list and compare it
   with the contract's `cipher_hash`: `cipher_hash_mismatch`.
3. **Seller signature.** Section 4.1, against the registered seller: `seller_signature_invalid`.
4. **Body framing.** The body is everything after the header. Chunk lengths: `w_0` is
   `metaLen + 16`, `w_1` is `previewLen + 16` if there is a preview, every other non-last chunk is
   `C + 16`, and the last is the remainder, which must be 16 to `C + 16` bytes: `bad_body_length`.
   Only then, in index order, each `SHA256(w_i) = h_i`: `chunk_hash_mismatch`.
5. **Stanza.** Pick the `near-ckd/v1` stanza for the trusted contract: `no_usable_stanza`.
6. **Key.** Get `ckdSecret` (section 5.1) and unwrap `K`: `key_unwrap_failed`.
7. **MAC.** Check the header MAC: `header_mac_invalid`.
8. **Decrypt.** For each chunk, derive `k_i`; for `i < kc`, check `SHA256("annon/pay2/key" ‖ k_i)`
   against `c_i`; then decrypt. Either failure is `chunk_invalid`. Chunk 0 first, then parse the
   metadata (section 3.1) and check it against the header: `previewLen ≤ min(65536, floor(size/10))`
   and `n = 1 + (previewLen > 0) + m`. Then the plaintext lengths of chunks 1 to `n - 1` (wire length
   minus 16) must add up to `size`. Any of these is `meta_invalid`. Then decrypt the other chunks.

Steps 1 to 4 need no key, so a client runs them before it pays wherever the bytes are public.

## 7. Preview

A seller may publish chunk 0 (metadata), chunk 1 (preview) or both, before any sale. Package:

```json
{ "v": 1,
  "header": "<base64 of header[0 .. prefixLen], stanza count and headerLen set to 0>",
  "chunks": [ { "index": 0, "key": "<base64 k_0>", "data": "<base64 w_0>" } ] }
```

A verifier first checks the package's shape: `v` is 1, `chunks` holds one or two objects, and
`header`, `key` and `data` are strings. Other properties are ignored. It never decodes a string longer than the bytes it may hold
(the header prefix `54 + 32·(2 + 1024)`, a key 32, a chunk its length from step 4), nor one that
isn't canonical base64. Any of these is `preview_invalid`. Then:
1. It parses the header prefix with the checks of step 1 that the prefix covers, with their codes,
   except that stanza count and `headerLen` must be 0 (`bad_header`): a package has no stanzas, and
   fields nothing binds must not vary. The prefix must be exactly `prefixLen` bytes
   (`preview_invalid`). It runs step 2 (`file_id_mismatch`,
   `cipher_hash_mismatch`). The preview package remains `v: 1`, but its PAY2 prefix has version 2 and a kind matching the registered seller (required to verify a preview). The prefix has no stanzas, so there is no seller signature to check:
   the registration alone binds the preview.
2. For every chunk, before reading any metadata: `index` is 0, or 1 when `previewLen > 0`, and
   appears once; the key is 32 bytes and its commitment equals `c_index`; the data has the length
   from step 4 and `SHA256(data) = h_index`; it decrypts with the key and the non-last nonce.
   Otherwise `preview_invalid`.
3. If chunk 0 is present, it parses the metadata and checks `previewLen` against `size` and
   `n = 1 + (previewLen > 0) + m`, as in step 8 (`meta_invalid`); the sum of chunk lengths needs
   the whole body and waits for opening. A size the chunk count rules out is caught here, before
   anyone pays.

What a verified preview proves: these bytes are part of the body registered for this file, under
the same key the buyer will derive. What it doesn't prove: that the rest of the file is as good.

The SDK never builds a preview unless the seller asks for one, and never with `previewLen` above the
limit in section 3.

## 8. Security notes

- Every chunk has its own key and the last flag in its nonce, and the hash list fixes the number and
  order of chunks. So reordering, dropping, repeating or truncating chunks fails at step 4 or 8.
- The hash list and `cipherHash` reveal the file's size rounded to chunks. The whole ciphertext
  reveals the exact size: only the metadata is padded, so the body length minus the header, the
  metadata and the GCM tags is the plaintext length. Name, type and content stay secret.
- Hosting, a relayer or anyone in between can't change a byte without failing step 2, 3 or 4: the
  registration covers the body, the commitments and the hash list, and the seller's signature
  covers the whole header. Where the bytes are public this is known before paying; where they
  arrive with the payment (Partner), before opening, and it shows who changed them.
- Only the seller can build a file that passes steps 1 to 4 and fails later, and the seller signed
  it. The registration, the signed header and the receipt are the evidence.
- The signature binds the header to the seller's wallet, not to the content: a seller who lists a
  file that is junk inside signs it just the same (see the TEE checks in the README).
- The limits in section 4 bound work and memory for a hostile file: nothing larger than the input
  or `headerLen` is allocated before they pass.

## 9. Vectors

`vectors/pay2.json` is written by `vectors/pay2.mjs`, an encoder on `node:crypto` kept apart from the
SDK's WebCrypto code.

- `valid`: inputs (`K`, `fileId`, `ckdSecret`, the seller's test key, data; `pattern: L` means byte
  `j` is `j mod 251`), the chunk keys, hashes, `cipherHash`, the text the seller signs, the
  signature and the whole file. Signatures are RFC 6979 deterministic. Decoders must open each file
  to the input data; encoders must produce the same bytes.
- `preview`: a package for `preview-multi`, what verifying it yields, and packages that must fail
  with the given code.
- `invalid`: files and listings (`fileId`, `cipherHash`, `seller`) that must fail with exactly the
  given error code, as a decoder using the trusted contract `v1.annon.defdone.near` and the
  `ckdSecret` from `valid`. `host-*` cases change bytes after the seller signed; `seller-*` cases
  are built and signed by a dishonest seller who holds `K`.
