# NEAR settlement (draft 3)

How a file is sold for native USDC on NEAR, paid directly from a NEAR account or from any chain
NEAR Intents 1Click supports, with a per-file split to recipients on EVM, Solana or NEAR, wallet
based recovery, and no human power over money. Every file has the NEAR route and,
optionally, the Base route (`specs/x402-annon.md`); both use the purchase commitment of §5.

One model (decision 10 Nov 2026): this document replaces the earlier registration, unlock, reopen
and PAY2 version 1. The contract has one set of entry points (no `_v2` names) and accepts nothing
in the old formats; there is no backward compatibility, as nothing was in production.

Status: draft for implementation (11 Nov 2026). Byte layouts, texts and hashes here are normative:
the contract (Rust) and the SDK (TypeScript) must produce identical vectors
(`vectors/near-settlement.json`).

## 1. Encodings

- **Borsh** as in borsh-js / borsh-rs: integers little-endian, `String` = u32 length + UTF-8,
  `Vec<T>` = u32 count + items, `Option<T>` = 0 or 1 then `T`, enums = u8 discriminant then the
  variant, fixed arrays without a length.
- **Hex** in JSON and texts: lowercase, `0x` prefix, except Solana ids in JSON (§2).
- Domain-separated hashes: `SHA256(tag ‖ 0x00 ‖ Borsh(…))` where `tag` is the ASCII string given.
- NEAR USDC: `17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1` (`asset` below).
  Amounts are USDC base units (6 decimals) as canonical decimal strings in JSON.

## 2. Identity

One type for sellers, split recipients, refund and recovery identities.

| kind | Borsh discriminant | Borsh payload | JSON `id` | Text form |
|---|---|---|---|---|
| `evm` | 0 | `[u8;20]` | `0x` + 40 hex | `EVM 0x…` (lowercase) |
| `solana` | 1 | `[u8;32]` (ed25519 public key) | 64 hex, no `0x` | `Solana <base58>` |
| `near` | 2 | `String` (canonical NEAR AccountId) | the account id | `NEAR <account>` |

JSON: `{"kind":"evm","id":"0x…"}`, keys in that order. The SDK accepts Solana base58 at its API and
converts it. The Intents account of an identity is: EVM → the `0x` address; Solana → the 64-hex
key; NEAR → the account id (near/intents `contracts/defuse/core/src/public_key.rs`).

Authorization of an identity over an authoritative text `T` (UTF-8, `\n` line ends, no trailing
newline):

- `evm`: EIP-191 `personal_sign` of `T`; 65 bytes `r ‖ s ‖ v`, `v` ∈ {27, 28}, low `s`; recovers to
  the address. The SDK requires this strict signature encoding.
- `solana`: Ed25519 over exactly `UTF8(T)` (no prefix, no prehash), 64 bytes; checked with
  `env::ed25519_verify`. The SDK refuses a wallet whose returned signed bytes differ from `UTF8(T)`.
- `near`: no signature; the call's predecessor must be the account (wallet transaction, 1 yocto
  attached where noted).

Signatures travel as `{"kind":"evm"|"solana","sig":"0x…"}`; `near` sends no auth object.
The contract additionally accepts EVM recovery bytes `v = 0/1`, uppercase hex and EVM signatures
without `0x`; Solana signature hex may also be uppercase. The SDK deliberately requires lowercase
`0x` signature hex and EVM `v = 27/28`. Identity JSON on the wire remains canonical on both sides.
The SDK uses strict Ed25519 verification (`zip215: false`); the NEAR host uses dalek non-strict
verification. Adversarial small-order or noncanonical owner-created signatures may therefore be
accepted by the host and refused by the SDK.

Distinct Identity kinds can share an Intents account: an implicit NEAR account equal to an EVM
address or Solana hex key credits the same balance. They remain separate Borsh identities, split
slots and recovery indexes (`purchases_of` indexes by Borsh Identity). This does not merge grants
or authorizations.

Smart-contract wallets (Safe, ERC-1271, PDAs) cannot authorize; they can still pay (§5).

## 3. Registration (`register`)

### 3.1 Terms

```
NearTerms   = { token: AccountId, price: u128, recipients: Vec<(Identity, u16 bps)>, remainder: u8 }
BaseTerms   = { usdc: [u8;20], price: u128, pay_to: [u8;20] }
Terms       = { network: String, contract: AccountId, file_id: [u8;32], seller: Identity,
                pay2_version: u8, cipher_hash: [u8;32], moderator: Option<AccountId>,
                near: NearTerms, base: Option<BaseTerms> }
terms_hash  = SHA256("annon/terms/v2" ‖ 0x00 ‖ Borsh(Terms))
```

Rules: `network` = `near:mainnet` (or `near:testnet`/sandbox in tests); 1 to 8 recipients, distinct,
sorted by `Borsh(Identity)` bytes ascending; every `bps` > 0, sum 10 000; `remainder` < count;
`price` > 0; `token` = the configured NEAR USDC (`get_config.near_usdc`). Mainnet defaults to native USDC;
testnet and sandbox use the deployment token. SDK commitment encoders accept explicit
`nearUsdc` / `baseUsdc` expectations; payment flows compare with the final deployment config. `base`, when present, is the Base route of
`x402-annon.md` for this file: `pay_to` is usually a 0xSplits split built by the SDK from the same
recipients (only possible when all are EVM); the contract does not check that split.

### 3.2 Seller authorization text

```
Annon: list a file for sale
Signing this lets whoever holds the seller key below open the file.
contract: <contract>
file: 0x<file_id>
seller: <seller text form>
price: <price as USDC, minimal decimals: 0.2, 1, 0.000001> USDC on NEAR
split: <recipient text form> <bps/100 with 2 decimals>%   (one line per recipient, sorted)
remainder: <recipient text form>
base: <price> USDC on Base to 0x<pay_to> | base: none
cipher: 0x<cipher_hash>
moderator: <account> | (none)
terms: 0x<terms_hash>
seller key: 0x<48-byte BLS key>
valid until: <UTC, YYYY-MM-DD HH:MM:SS UTC>
```

`register(args, auth)`; `near` sellers call it themselves; EVM and Solana sellers sign and may
use the relayer. It stores the terms and requests CKD for the seller key.

### 3.3 Header publication

The PAY2 v2 header is authenticated after CKD (the finished header needs the CKD answer):

- EVM / Solana: the header's 65-byte trailer carries the signature over
  ```
  Annon: publish a file
  contract: <contract>
  file: 0x<file_id>
  header: 0x<SHA256(header[0 .. headerLen-65])>
  ```
- NEAR: `publish_header(file_id, header_hash)` called by the seller; stored once (same hash is a
  no-op, another fails). The NEAR route sells nothing for a NEAR seller's file before this.

## 4. PAY2 (version 2)

The layout in `specs/pay2.md` is PAY2 version 2. Version 1 is no longer produced or
accepted (byte 4 = 1 fails as an unsupported version):

| Field | Rule |
|---|---|
| Byte 4 | 2 |
| Byte 7 | auth kind: 0 EVM, 1 Solana, 2 NEAR |
| Trailer (65 bytes) | kind 0: EIP-191 sig; kind 1: 64-byte Ed25519 sig + 1 zero byte; kind 2: 65 zero bytes, authenticated by the published hash (§3.3) |

The kind must match the registered seller identity; unknown kinds and non-zero padding fail. The
body hash covers the version byte. Previews keep package `v: 1`; checking a preview needs the
registered seller to check the kind.

## 5. Purchase

### 5.1 Message

Sent as the `msg` of a direct `ft_transfer_call` of NEAR USDC to the contract, or as 1Click's
`customRecipientMsg`. Compact JSON, keys in exactly this order, at most 1 024 UTF-8 bytes:

```json
{"annon":2,"refund":{"kind":"evm","id":"0x…"},"purchase":{"network":"near:mainnet",
"contract":"<contract>","route":"near-usdc","asset":"<NEAR USDC>","file_id":"0x…",
"terms_hash":"0x…","price":"200000","nonce":"0x<32 random bytes>","buyer_key":"0x<48 bytes>",
"recovery":{"kind":"solana","id":"…"},"expires_at":"1794350000","purchase_id":"0x…"}}
```

The prefix `{"annon":2,"refund":{"kind":"…","id":"…"},` is parsed first by a bounded parser (at
most 160 bytes). A valid refund identity there fixes where any refund goes before anything else is
read (§6).

### 5.2 Commitment

```
Purchase    = { version: u8 (2), refund: Identity, network: String, contract: AccountId,
                route: u8 (0 near-usdc, 1 base-usdc), asset: String, file_id: [u8;32],
                terms_hash: [u8;32], price: u128, nonce: [u8;32], buyer_key: [u8;48],
                recovery: Identity, expires_at: u64 }
purchase_id = SHA256("annon/purchase/v2" ‖ 0x00 ‖ Borsh(Purchase))
```

Computed from decoded values, not JSON bytes; `purchase_id` in the message must equal it. The SDK
generates `nonce` and the buyer key locally, checks that the buyer controls `recovery` (a signature)
before showing payment instructions, and saves the encrypted purchase record first (§9). Default
expiry: 1 hour after local quote preparation. Anyone may pay for anyone's purchase.

The recovery challenge is exactly (no trailing newline):
```
Annon: verify purchase recovery
contract: <contract>
purchase: 0x<purchase_id>
recovery: <identity text form>
```
For NEAR recovery, use [NEP-413 signMessage](https://github.com/near/NEPs/blob/master/neps/nep-0413.md):
`message` is this challenge, `recipient` is the contract ID, and `nonce` is 32 fresh random bytes.
Sign Ed25519 over SHA256 of Borsh `u32(2^31+413)`, `message: String`, `nonce: [u8;32]`,
`recipient: String`, `callbackUrl: Option<String>` (absent in the SDK). Verify the signature and
returned account, then query RPC `view_access_key` with `finality: "final"`, that account and
public key. Require `permission: "FullAccess"`; a function-call key or absent key is refused
before payment instructions or a payment signature. This off-chain proof does not authorize a
contract method; NEAR contract authorization still uses the predecessor.

### 5.3 Base route with the same commitment

For `route = base-usdc` the buyer signs EIP-3009 (`x402-annon.md`) with

```
base_nonce = keccak256("annon/base-payment/v2" ‖ 0x00 ‖ purchase_id)
```

For this route the commitment's `network` is exactly `eip155:8453` and `asset` the lowercase `0x`
address of Base USDC configured in the contract; anything else is refused.
`unlock({"args":{"purchase":"<canonical §5.1 MESSAGE string>","logs":[...],"header":null}})` verifies the Base logs through MPC (Safe finality) against
`terms.base` and this nonce, and records the purchase with its recovery identity. `refund` is
carried but unused on Base (EIP-3009 moves exactly the price). The `purchase` field is the same
canonical message string used by the NEAR route, not a decoded Purchase object.

The SDK must set EIP-3009 `validBefore <= expires_at` and the seller checks that bound before
settlement. The Base contract path does **not** check `expires_at`; USDC's authorization deadline
bounds the payment. There is no unlock-time expiry check. While sales are open, `header` may be
null. After sales stop, `header` must be `"0x<RLP of the payment block header>"`, matching the proved
log's block hash and number. A payment is allowed if its Base block time is at most
`sales_stopped_at + STOP_SETTLEMENT_SECONDS`, where `STOP_SETTLEMENT_SECONDS = 300` (inclusive).
An allowed payment remains unlockable regardless of when unlock runs. A stop during the MPC
callback can require a retry with the header. Takedown blocks release throughout.

## 6. Receiving USDC (`ft_on_transfer`)

1. The predecessor must be the configured NEAR USDC. Any other token: return the full amount.
2. Parse the refund prefix. If missing or invalid: **refuse** (return the full amount). A direct
   NEAR payer gets the NEP-141 refund; a 1Click delivery goes back to the quote's own Intents
   account (not to the buyer). Only non-Annon or broken clients reach this.
3. With a valid refund identity, the contract keeps the tokens (returns `0`) and records a delivery
   with exactly one disposition:

| Condition | Disposition |
|---|---|
| Valid; amount = price | accept the purchase; split the price |
| Valid; amount > price | accept; split the price; refund the excess |
| Amount < price | refund all; the purchase id is **not** consumed |
| Purchase id already accepted | refund all |
| Unknown file, NEAR route absent, wrong terms hash/price/asset/route/contract/network | refund all |
| Expired, sales stopped (by callback time), taken down | refund all |
| Invalid body JSON, duplicate/unknown fields, bad commitment, invalid buyer key or recovery identity | refund all |

The buyer key must decode as a compressed BLS12-381 G1 point in the prime-order subgroup, not the
identity. The receiver schedules no promise and never returns a promise.

4. **Storage.** Each delivery reserves 4 096 bytes of the receiver reserve before writing. If the
   reserve is short, the delivery is not accepted: a refund leaf is appended to the refund
   accumulator (§8) and nothing variable-length is written.

## 7. Payouts and refunds

Every obligation (a split share or a refund) is paid by crediting the beneficiary's Intents
balance, in two steps per delivery:

1. **Fund**: `ft_transfer_call(intents.near, amount, msg = <this contract's account>)` moves the
   delivery's USDC into the contract's own Intents balance; the callback reads the final used
   amount (NEP-141) and records exactly that.
2. **Pay**: per obligation, `intents.near::mt_transfer(receiver_id = <beneficiary Intents id>,
   token_id = "nep141:<NEAR USDC>", amount, memo = "annon:<delivery>:<slot>:<attempt>")`, 1 yocto.
   Success → paid; failure → pending again (the transfer is one synchronous step, so a failure moved
   nothing).

Shares: `share[i] = floor(price × bps[i] / 10000)`, `share[remainder] += price − Σ share`. Zero
shares complete without a transfer. A beneficiary equal to this contract completes locally.

States: `Pending → InFlight(attempt) → Done | Pending` for both steps. `InFlight` is never reset by
time or by anyone. Entry points, permissionless and unable to change amounts or destinations:
`fund_delivery(delivery_id)`, `pay_slot(delivery_id, slot)`. Callbacks are private, check the
attempt, and write only fixed-width fields with a fixed gas allowance. The keeper calls these after
each acceptance. Payout state never affects the buyer's entitlement.

Known limit (SECURITY.md): if a callback itself fails (a bug or under-provisioned gas), that slot
stays `InFlight`: never paid twice, never redirected, fixable only by a contract upgrade.

## 8. Refund accumulator

For deliveries that cannot get storage: an append-only binary Merkle tree of depth 32, frontier and
root preallocated at init.

```
leaf  = SHA256("annon/refund-leaf/v1" ‖ 0x00 ‖ Borsh({ network: String, contract: AccountId,
        delivery_id: u64, refund: Identity, amount: u128 }))
node  = SHA256(0x01 ‖ left ‖ right);  empty subtree of height h: zero[0] = [0;32], zero[h+1] = SHA256(0x01 ‖ zero[h] ‖ zero[h])
```

Leaf indexes start at 0 and are appended left to right. A proof lists siblings from height 0 to
31; bit `h` of the index (least significant first) says whether the node at height `h` is a right
child. The empty root is `zero[32]`.

`materialize_refund(leaf_fields, index, proof: Vec<[u8;32]>)`, payable (the caller funds storage):
checks inclusion under the current root and a one-time marker, then creates an ordinary refund
obligation (§7). Events carry every leaf so anyone (the keeper) can build proofs.

## 9. Key release and recovery

- `claim_key(purchase_id, grant: u32 = 0)`: anyone; requests CKD to the grant's buyer key for the
  file's unchanged derivation path; refused while taken down; repeatable. Grant 0 is the key from
  the purchase.
- `reopen({purchase_id, fresh_key, nonce, deadline}, auth)`: authorized by the purchase's
  `recovery` identity over
  ```
  Annon: open a purchased file again
  contract: <contract>
  purchase: 0x<purchase_id>
  file: 0x<file_id>
  recovery: <identity text form>
  new key: 0x<fresh 48-byte key>
  nonce: 0x<32 bytes>
  valid until: <UTC>
  ```
  creates the next grant (identical request → same grant) and requests CKD. Earlier grants stay.
- Seller: `reopen_seller` and `stop_sales` with the same identity authorization (texts in the
  contract's `reopen_seller_text` / `stop_sales_text`, `seller:` before key/deadline, ending with `valid until: <UTC>`).
  Stop is final.
- `purchases_of(recovery: Identity, from, limit)` finds purchases on a fresh device.
- Downloads: the existing buyer proof (`specs/download.md`) plus `purchase_id` and `grant`; the
  host checks the proof against that grant's key at finality.
- The SDK also writes an encrypted purchase file (buyer key secret, message, checked header hash,
  quote, recovery identity), encrypted with a user-held backup secret, never a wallet signature.

## 10. Events and views

Events (`standard: "annon"`, `version: "2.0.0"`): `file_registered`, `header_published`,
`delivery_received`, `purchase_accepted`, `refund_due`, `refund_leaf`, `delivery_refused` (log only),
`funded`, `slot_paid`, `key_requested`, `key_released`, `grant_created`, `sales_stopped`. Never log
secrets.

Views: `get_file(file_id)`, `get_purchase(purchase_id)`, `get_grant`,
`get_delivery(delivery_id)`, `list_deliveries(from, limit)`, `purchases_of(...)`,
`refund_root()`, `get_config`, `storage_balance_of`.

- `get_file` → `{terms, terms_hash, header_hash|null, sales_stopped_at|null, taken_down|null}`.
- `get_purchase` → `{purchase_id, file_id, terms_hash, buyer_key, recovery: Identity,
  route: "near-usdc"|"base-usdc", delivery: number|null, accepted_at: number, grants: number}`.
- `get_grant({purchase_id, grant})` → `{purchase_id, grant, buyer_key}` or null.
- `claim_key({purchase_id, grant?})` defaults to grant 0.
- `purchases_of({recovery, from, limit})` → purchase ID strings, at most 100; offsets are u32.
- `get_config` → `{mpc, ckd_domain, foreign_tx_domain, usdc, network, near_usdc, intents}`.
- Keeper calls: `fund_delivery({delivery_id})` with 150 Tgas, `pay_slot({delivery_id, slot})`
  with 80 Tgas; delivery views use numeric IDs, decimal-string USDC, and steps
  `{state: 0|1|2, attempt: number}`. `list_deliveries({from, limit})` returns at most 50.
- `refund_root()` → `{root, count}`. Payable
  `materialize_refund({leaf:{delivery_id, refund: Identity, amount: string}, index, proof})`
  takes 32 sibling hashes and a storage deposit; network/contract come from the deployment.

Vectors label the SDK-only accumulator cache `sdk_frontier`; Rust keeps stale frontier slots.
Only roots and proofs are cross-language wire commitments. Negative entries state `expected.sdk`
and `expected.contract`; purchase parser outcomes are `foreign` (no valid refund prefix) or
`unusable` (valid refund prefix, invalid body) under each entry's deployment context.
UTC formatting follows Rust for all u64 seconds, including years beyond 9999.

## 11. Offer (x402 extension v3)

The 402 for a file lists `annon-near-usdc` (settlement on NEAR at this contract, `asset` NEAR USDC,
`amount` = NEAR price, extra: `contract`, `file_id`, `terms_hash`) and, when `base` is present,
`annon-exact` on Base with `extra.nonceVersion: 2`. 1Click is a way to pay `annon-near-usdc`, not a
separate offer. Details in `x402-annon.md` §11 (to be updated).
