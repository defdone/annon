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
use the relayer. Optional `args.file_budget` is a positive yoctoNEAR string allocated
from the caller's prepaid balance atomically with registration. It is outside signed Terms
and seller authorization. The call uses one FunctionCall action. It stores the terms and requests CKD for the seller key. The seller key, like every
one-time key (`reopen_seller`, `reopen`, the buyer key), must be a compressed G1 point in the
prime-order subgroup and not the point at infinity: MPC would publish the file key in the clear for
the point at infinity.

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
callback can require a retry with the header. A takedown refuses every new key request (`unlock`,
`claim_key`, `reopen`, `reopen_seller`); a request already sent to MPC before the takedown may still
complete, because its answer is published on chain by MPC and cannot be withdrawn.

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

4. **Storage.** An otherwise valid acceptance requires 4 096 bytes' worth of the file's
   `purchase_storage_balance`, outside signed Terms. Acceptance debits actual flushed storage
   for the whole write, including permanent purchase/recovery and temporary delivery/index
   records. The receiver reserve is not an admission gate for funded files. If the file budget
   is short, emit `file_storage_low` and refund with reason `11` (`FILE_STORAGE_LOW`) without
   consuming the purchase ID. Rejected payments never spend file budgets. They create a
   refund-only delivery using receiver reserve working capital, or append a refund leaf (§8)
   with no variable-size write when that reserve is short. Claims, recovery and caller-funded
   Base unlock have no file-budget requirement.

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
`fund_delivery(delivery_id)`, `pay_slot(delivery_id, slot)`, `settle(delivery_id)`. Callbacks are
private and check both state and attempt. Funding returns to Pending only for a readable used
amount below the remaining obligation. An unreadable result (including a failed deposit promise)
leaves funding InFlight: the tokens may already have moved. Payment returns to Pending only for
an explicitly failed synchronous transfer; an unreadable successful result leaves it InFlight.
Missing records and stale callbacks are harmless.

`settle` starts funding if Pending, then chains **three separate stages**:
`USDC ft_transfer_call → on_funded bookkeeping → dispatch_delivery`. The original entry reserves
the gas for both later receipts; bookkeeping never schedules payments. The private dispatcher
re-reads the delivery and schedules only Pending slots, only if funding is Done. Its failure cannot
roll back the earlier funding record: `pay_slot` or another `settle` can continue. An already funded
delivery dispatches directly; missing/settled and funding-InFlight deliveries are no-ops. Before
scheduling each transfer, the dispatcher records that slot's InFlight attempt. Parallel callbacks,
legacy calls, duplicate keepers and delayed dispatchers cannot pay a slot twice.

Allowances, all with unused-gas weight zero: deposit 100 Tgas, each external transfer 30 Tgas,
each bookkeeping/payment callback 15 Tgas, dispatcher 450 Tgas. Nine chains reserve 405 Tgas,
leaving 45 Tgas for dispatcher execution and margin. Attach at least 600 Tgas to `settle` when
funding is Pending (565 reserved downstream, 35 for entry execution and margin); 450 Tgas suffices
when already funded. Calls below these thresholds are refused before changing state. Measurements
with the real mainnet USDC and Intents bytecode, including final-callback first/middle/last index
removal, are in `contracts/annon/tests/mainnet_contracts.gas.txt`. These are allowances, not burn
estimates. Keepers still pay gas and the contract must have native NEAR for outbound 1-yocto calls.

Payout state never affects the buyer's entitlement. Once a delivery is funded and
every slot is paid, its record is removed and freed delivery/index storage returns to the accepted purchase
file budget, or to the receiver reserve for refund-only deliveries
(`delivery_settled` event); `get_delivery` then returns null, the purchase keeps its `delivery` id.
`delivery_count()` is the number of delivery ids ever assigned; ids without a record are refund
leaves not yet materialized or settled deliveries. `receiver_reserve()` shows the reserve.

`open_delivery_count()` counts all stored deliveries, including InFlight. Ordinary creation and
`materialize_refund` insert into the open index; only successful settlement removes from it.
`list_open_deliveries(from, limit)` returns Delivery views at unordered **index positions**, capped
at 50. Removal swaps the last entry into the hole. For a complete sweep, pin the count and **every
page to one finalized block hash/height** using RPC `block_id`; advance by the number of entries
returned. Concurrent removals cannot skip records in that snapshot, including every record that
stays open throughout the sweep. New records after that block belong to the next sweep. Archive
RPC may be needed if a sweep outlives the provider's retention. Across moving blocks a single
forward offset scan can skip records; restarting at zero gives full coverage once mutations cease,
but is not a guarantee under continuous churn. The count is not a cursor or a snapshot token.

Delivery and index insertion are flushed and charged together exactly once: ordinary acceptance
debits its file budget, ordinary rejection debits the receiver reserve, and materialization
charges its caller (attached or prepaid storage). Retirement credits actual freed delivery/index
bytes to that file exactly once, or to the receiver reserve for refund-only deliveries,
including caller-sponsored refunds. Purchases, recovery entries and materialization markers
persist. Each index entry uses 130 bytes, reclaimed on retirement including swap-removal.
Unit measurements: maximum-size acceptance including nine slots and 64-byte identities
uses 1,484 bytes, below the unchanged 4,096-byte admission allowance; a materialized refund with a
10-byte NEAR beneficiary, index and permanent marker uses 332 bytes (0.00332 NEAR at 10^19
yoctoNEAR/byte).

Conditional liveness: open, actionable deliveries make automatic progress while dependencies
permit transfers, receipts/callbacks execute successfully, native gas/storage sponsorship remains
available and at least one funded keeper runs fair snapshot sweeps and retries Pending work.
Refund leaves additionally need the history/proof prerequisite in §8. Keepers should back off
retryable dependency failures and alert on InFlight uncertainty; backoff never changes contract
state. Permissionless methods alone do not supply an executor, NEAR or dependency availability.

Known limit (SECURITY.md): a callback that fails leaves its step InFlight. A timeout, balance query,
or keeper assertion cannot distinguish a completed transfer from a delayed receipt; resetting it
could pay twice under another receipt ordering. No reset or administrative override is provided.
On an upgradeable deployment a reviewed upgrade may repair a provable accounting issue; it cannot
make an uncertain external effect known by itself. On a locked deployment an in-place upgrade is
unavailable: a replacement account/version does not recover old obligations automatically.

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
checks inclusion under one of the last 32 roots, the current one included (a proof stays valid
while up to 31 more leaves are appended, so build it right before sending) and a one-time marker,
then creates an ordinary refund
obligation (§7). Events carry every leaf so anyone (the keeper) can build proofs.

Plain-RPC discovery remains a known gap: the frontier/root cannot recover leaf preimages or all
sibling hashes. A keeper must retain/replay successful `refund_leaf` events from this executor to
build proofs, even when it also scans the open index. Later reserve funding does not materialize
old leaves automatically. Proofs can expire after 32 appends; rebuild against a recent root. No
commitment format changes are made here.

Storage options were measured with the actual SDK collection and storage accounting. A readable
map indexed by leaf index, storing `(delivery_id, refund, amount)` with network/contract implicit,
adds 94 bytes for EVM, 106 for Solana, and 78 + account-length bytes for NEAR (88 for `buyer.near`,
142 at the 64-byte maximum). At the current storage-byte constant that is 0.00088 to 0.00142 NEAR
per leaf for these NEAR examples, or 880 to 1,420 NEAR per million. Keeping all preimages enables
proof reconstruction by RPC, but someone must pay **when appended**, exactly when the delivery
reserve is empty. Silently charging the contract creates an unbounded storage-exhaustion vector.
Deleting materialized preimages alone also loses proof data for other leaves; hashes/nodes must
remain available. A separately sponsored preimage reserve is bounded and still needs an exhaustion
policy; mandatory sender sponsorship changes the NEP-141 ingress/payment flow. Refusing unsponsored
receipts returns tokens to the NEP-141 sender, which may be a bridge rather than the designated refund
identity. Therefore no per-leaf storage is added in this change. An indexer-free guarantee requires
an explicit ingress/storage funding decision; the existing constant-storage accumulator and
permissionless, caller-funded `materialize_refund` remain available.

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
`file_storage_funded`, `file_storage_low`, `delivery_received`, `purchase_accepted`, `refund_due`, `refund_leaf`, `delivery_refused` (log only),
`funded`, `slot_paid`, `delivery_settled`, `funding_failed`, `payment_failed`,
`key_requested`, `key_released`, `grant_created`, `sales_stopped`. Never log
secrets.

Failure event data (one object in the NEP-297 `data` array):

| Event | Fields | Meaning |
|---|---|---|
| `funding_failed` | `delivery_id`, `attempt`, `state: "Pending"`, `reason: "incomplete_deposit"`, `used`, `remaining` | Readable partial/zero use; retry only the remainder. Also emits `funded` with the accounted progress. |
| `funding_failed` | `delivery_id`, `attempt`, `state: "InFlight"`, `reason: "unreadable_result"`, `remaining` | Unknown effect; alert, never resend this attempt. |
| `payment_failed` | `delivery_id`, `slot`, `attempt`, `state: "Pending"`, `reason: "transfer_failed"` | Explicit synchronous transfer failure; safe to retry. |
| `payment_failed` | `delivery_id`, `slot`, `attempt`, `state: "InFlight"`, `reason: "unreadable_result"` | Successful result could not be read within the bound; alert, never retry. |

Amounts are decimal strings; IDs, slot and attempt are numbers. Stale callbacks emit no failure
signal. A callback that never executes cannot emit one: reconcile InFlight state and transaction
outcomes too. Accept events only from successful finalized receipts executed by the trusted Annon
account; logs from failed receipts or other executors are not evidence of state transitions.

Views: `get_file(file_id)`, `get_purchase(purchase_id)`, `get_grant`,
`get_delivery(delivery_id)`, `list_deliveries(from, limit)`, `purchases_of(...)`,
`delivery_count()`, `list_open_deliveries(from, limit)`, `open_delivery_count()`,
`refund_root()`, `receiver_reserve()`, `file_storage_balance(file_id)`, `get_config`, `storage_balance_of`.

- `get_file` → `{terms, terms_hash, purchase_storage_balance, header_hash|null, sales_stopped_at|null, taken_down|null}`.
- `file_storage_balance({file_id})` → `{available, admission_requirement}`, decimal yoctoNEAR strings.
- Payable `fund_file_storage({file_id, amount?})` allocates attached NEAR, with optional exactly
  matching `amount`; zero attached requires an explicit positive `amount` from the caller's
  prepaid balance. Allocations are nonwithdrawable; anyone can sponsor an active file.
  Stopped or taken-down files refuse funding. Optional `register.args.file_budget` is a
  positive yoctoNEAR string debited from the caller's prepaid balance atomically with
  registration; it does not change signed Terms or seller authorization.
  A leaked function-call key authorized for registration or funding can move all of its
  account's prepaid balance into arbitrary files. A gas allowance does not bound this
  allocation; limit prepaid balances and revoke compromised keys.
- `get_purchase` → `{purchase_id, file_id, terms_hash, buyer_key, recovery: Identity,
  route: "near-usdc"|"base-usdc", delivery: number|null, accepted_at: number, grants: number}`.
- `get_grant({purchase_id, grant})` → `{purchase_id, grant, buyer_key}` or null.
- `claim_key({purchase_id, grant?})` defaults to grant 0.
- `purchases_of({recovery, from, limit})` → purchase ID strings, at most 100; offsets are u32.
- `get_config` → `{mpc, ckd_domain, foreign_tx_domain, usdc, network, near_usdc, intents}`.
- Keeper calls: `fund_delivery({delivery_id})` with 150 Tgas, `pay_slot({delivery_id, slot})`
  with 80 Tgas, `settle({delivery_id})` with 600 Tgas; delivery views use numeric IDs, decimal-string USDC, and steps
  `{state: 0|1|2, attempt: number}`. `list_deliveries({from, limit})` returns at most 50.
  `list_open_deliveries({from, limit})` also returns at most 50, with snapshot semantics above.
  SDK `listOpenDeliveries` and `openDeliveryCount` accept an optional RPC block ID for this purpose.
  Existing `keep()` scheduling is unchanged; these bindings do not implement the next keeper design.
- `refund_root()` → `{root, count}`. Payable
  `materialize_refund({leaf:{delivery_id, refund: Identity, amount: string}, index, proof})`
  takes 32 sibling hashes and a storage deposit; network/contract come from the deployment.
  A zero attached deposit instead spends the caller's prepaid contract storage balance, including
  through the SDK binding, allowing a function-call key to materialize with sponsored storage.

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

## 11. File budgets and record economics

File state adds a fixed-width 16-byte `purchase_storage_balance` outside immutable Terms.
Registration initializes it to zero or atomically credits optional `args.file_budget`
from the caller's prepaid balance, in the same single-action call; funding, publishing, stopping and moderation never modify
registered Terms. `get_purchase.terms_hash` derives from those Terms; no duplicate hash is kept
in PurchaseRec. The recovery head stores `(count, first_purchase_id)` under the identity hash;
positions 1 onward remain individual entries. Pagination and every existing signed encoding,
cryptographic vector, event commitment and purchase view are unchanged. Base payment markers
remain permanent. No migration is supplied: deploy fresh state.

`file_storage_funded` includes `file_id`, `funder`, `amount`, `balance`.
`file_storage_low` includes `file_id`, `available`, `admission_requirement`, on admission refusal
or when acceptance crosses below admission. `purchase_accepted` adds `charged_bytes`,
`charged_cost`, `remaining_budget`. `delivery_settled` adds `storage_credit` and
`storage_destination` (file ID or `receiver_reserve`). Costs and balances are yoctoNEAR strings.

Measured permanent bytes per purchase through actual collection writes, including entry overhead:

| Recovery identity | NEAR/1Click before first / later | NEAR/1Click after any | Base before first / later | Base after any |
|---|---|---|---|---|
| EVM | 413 / 336 | 304 | 494 / 417 | 385 |
| Solana | 425 / 348 | 316 | 506 / 429 | 397 |
| NEAR, 10 characters | 407 / 330 | 298 | 488 / 411 | 379 |
| NEAR, 64 characters | 461 / 384 | 352 | 542 / 465 | 433 |

The first purchase per recovery identity saves 109 bytes; later purchases save 32 bytes.
At 10^19 yoctoNEAR per byte, multiply bytes by 0.00001 for NEAR storage stake.
Temporary acceptance storage is initially charged to the file and recycled at retirement.
Admission still requires 0.04096 NEAR; this allowance is not the measured purchase fee.

Relayer sponsorship policy is off-chain and published at `/v1/capabilities`. Its default fee
is 30,000 USDC base units plus 100 bps of price; required treasury bps round up as
`ceil((fixed * 10000 + price * bps) / price)`. SDK sponsored sell inserts treasury shares,
scales the others proportionally and assigns rounding to an original non-treasury
recipient. The exact fee share rounds up by less than one basis point. Base terms require
a single EVM treasury share at the larger of the two route requirements. Sponsored Base
registration supplies split kind/salt; the relayer recomputes the ownerless split address
locally and checks `pay_to`. Base unlock sponsorship requires the same verified terms
hash in memory, lost on restart. Direct self-funded registration has no compulsory fee. NEAR and 1Click clients
check `file_storage_balance` before paying and refuse with `file_storage_low` when short;
the contract rechecks on receipt because preflight reserves no budget.
