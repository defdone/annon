# Annon relayer

An HTTP front for `relay` from `@defdone/annon`: it sends `register`, `unlock`, `claim_key`, `reopen`, `reopen_seller` and
`stop_sales` and `fund_file_storage` to an Annon contract and pays the NEAR gas, for people and agents without a NEAR
account. An optional keeper uses a separate account/key, durable retry/submission state, and
persisted NEAR budgets to call permissionless `settle`. Relay admission limits remain in memory.
Run one relayer instance per relay signing key.

```
docker build -f apps/relayer/Dockerfile -t annon-relayer .     # from the repository root
docker run -p 8080:8080 --env-file relayer.env annon-relayer
```

| Variable | Required | Meaning |
|---|---|---|
| `CONTRACT_ID` | yes | The Annon contract, e.g. `v1.annon.defdone.near` |
| `RELAYER_ACCOUNT` | yes | The NEAR account that sends and pays |
| `RELAYER_KEY` | yes, secret | A function-call key of that account for the relay methods including `fund_file_storage`, on that contract only |
| `SELLERS` | no | Comma-separated `kind:id` identities eligible for `LISTED_FILE_BUDGET`; unlisted sellers remain sponsored |
| `NEAR_RPC`, `BASE_RPC` | no | Defaults are public RPC endpoints; use endpoints with API keys for production |
| `USDC` | no | USDC on Base (default: the canonical address) |
| `MIN_PRICE` | no | Smallest NEAR and Base listing price, and Base unlock purchase price served, USDC base units (default `100000` = 0.10 USDC) |
| `MAX_DEADLINE_SECONDS` | no | How far ahead a wallet signature may be valid (default `600`) |
| `PER_IP_HOUR`, `PER_DAY` | no | Admissions per client per hour (`60`); total transactions across all methods per daily window (`500`) |
| `PER_DAY_REGISTER`, `PER_DAY_UNLOCK`, `PER_DAY_CLAIM_KEY`, `PER_DAY_REOPEN`, `PER_DAY_REOPEN_SELLER`, `PER_DAY_STOP_SALES` | no | Override the daily capacity of one method; each defaults to `PER_DAY` |
| `UNLOCK_RESERVED` | no | Capacity reserved from `PER_DAY` for unlock; default half rounded up (`250` at the default cap), must not exceed `PER_DAY` |
| `CLAIMS_PER_PURCHASE_DAY` | no | Sponsored claims per (purchase, grant) per 24-hour window, default `3`; the existing setting name is retained |
| `REGISTRATIONS_PER_SELLER_DAY`, `REOPENS_PER_PURCHASE_DAY` | no | Daily operation quotas, defaults `20`, `10` |
| `HOLD_SECONDS`, `MAX_WAITING` | no | Recent-operation hold (`900` seconds, claims retain hashes through their quota window) and signing queue capacity (`32`) |
| `MAX_CHECKING` | no | Concurrent chain preflight checks, default `32`; excess requests fail before RPC reads |
| `HITS_CAP`, `REQUEST_MULTIPLIER` | no | Client counter capacity (`100000`, minimum `1`) and coarse request cap as a multiple of `PER_IP_HOUR` (`10`) |
| `RETRY_SECONDS` | no | Short retry hint for busy/unsafe/paused responses, default `5`; hourly IP exhaustion advertises `3600`, daily pools `86400` |
| `RELAYER_BALANCE_LOW_WATER`, `RELAYER_STORAGE_LOW_WATER` | no | Liquid and prepaid storage alert thresholds, each default `100000000000000000000000` yoctoNEAR (0.1 NEAR) |
| `RELAYER_ALERT_WEBHOOK` | no | Private HTTPS incoming webhook, same delivery format and safeguards as keeper alerts |
| `IP_HEADER` | no | The header your proxy sets to the client's IP (e.g. `fly-client-ip`), only behind a proxy that overwrites it; without it, the connection's address is used |
| `DISABLED` | no | `1` answers 503 and sends nothing |
| `KEEPER_SECONDS` | no | Seconds between keeper passes (default `0`, disabled); enabling requires the keeper settings below |
| `PORT` | no | Default `8080` |

The relayer needs a Base RPC endpoint with an API key in `BASE_RPC`. The file host (`baseRpc`) and CLI for Base purchases (`baseRpc` / `ANNON_BASE_RPC`) need one too. The public `https://mainnet.base.org` rate-limits the burst of reads made during settlement and unlocking. A keeper polling every few seconds also needs a NEAR RPC endpoint with an API key in `NEAR_RPC`. Keep API keys out of public files.

The account needs prepaid storage on the contract (`storage_deposit`) for `register`, `unlock`
`reopen` and `reopen_seller`. Count and USDC settings must be whole numbers. File-budget and top-up settings use decimal NEAR with at most 24 fractional digits. Invalid settings stop startup.

Identity-authorized requests use `{method,args,auth:{kind,sig}}`; NEAR identities call directly.
`claim_key` and `unlock` requests have only `method` and `args`. The relay sends identity
operations as `{args,auth}`, `unlock` as `{args}` (the purchase message, logs and header) and
`claim_key` flat (`{purchase_id,grant}`). Omitted `grant` is canonicalized to `0` before signing,
so the sent arguments and cached purchase/grant identity agree. Purchase recovery uses purchase IDs and grants; the call
shapes are in [specs/near-settlement.md](../../specs/near-settlement.md) §10.

An in-flight duplicate returns its transaction hash as soon as signing finishes. Before the hash
is available it returns HTTP 202 `{pending:true,retryAfterMs:5000}`. Clients retry the same release
request; a cached hash is always checked against the expected method/arguments via NEAR RPC.
The cache is process-local; contract checks remain authoritative after a restart.

## Separate keeper configuration

| Variable | Required when enabled | Meaning |
| --- | --- | --- |
| `KEEPER_ACCOUNT`, `KEEPER_KEY` | yes | Dedicated account/key, distinct from both relay credentials; allow `settle` and `materialize_refund` on this contract |
| `KEEPER_STATE_DIR` | yes | Private durable mounted directory; `jobs` and `budgets` survive restarts |
| `KEEPER_HOURLY_BUDGET`, `KEEPER_DAILY_BUDGET` | yes | Conservative NEAR spend caps, integer yoctoNEAR |
| `KEEPER_GAS_PRICE` | no | Maximum yoctoNEAR/gas, default `100000000`; higher network prices refuse new signing |
| `KEEPER_RESERVE_LOW_WATER` | no | Alert threshold in yoctoNEAR, default `40960000000000000000000` (0.04096 NEAR) |
| `KEEPER_BALANCE_LOW_WATER` | no | Minimum liquid keeper balance in yoctoNEAR, default `0`; signing requires at least the greater of this threshold and the next transaction's full submission cost |
| `KEEPER_ALERT_WEBHOOK` | no | HTTPS incoming webhook for every keeper alert; supports Slack and Discord (Discord URLs use its Slack-compatible `/slack` endpoint) |

Set `KEEPER_SECONDS=30` to enable. The account needs gas, a sufficient key allowance, and prepaid contract storage for refund materialization. The keeper has its own nonce queue, so relay requests do not serialize behind it. Shutdown cancels future passes. Mount a writable persistent volume owned by the container's `node` user at `KEEPER_STATE_DIR`.

Before reserving budget or signing, the keeper reads its account, gas price and protocol fees at one finalized block. It subtracts account storage stake from the non-staked balance and prices the full prepaid receipt gas at the protocol's minimum purchase price (or the current price, if higher), plus submission fees. For example, a 600 Tgas settle can need about 0.6009 NEAR upfront even when actual gas burn costs less. Insufficient liquid funds emit `keeper: alert` with `{type:"low_balance",balance,needed}` in integer yoctoNEAR, then skip signing without reserving budget or persisting a transaction. The low-balance state persists: repeated low passes and restarts do not repeat the alert; an affordable transaction resets it so a later low balance alerts again. Funds committed earlier in the same pass are conservatively deducted too. Failed balance/protocol reads refuse signing.

With `KEEPER_ALERT_WEBHOOK`, every emitted alert is also POSTed as JSON `{text,alert}`. `text` starts with `keeper: alert`; `alert` contains only its type and public balance, reserve, needed or delivery ID fields. Delivery has a three-second timeout, refuses redirects, and webhook failures never fail the keeper pass. Keep webhook URLs private; neither webhook credentials, signing keys nor upstream error bodies are included in alerts. Console alert records remain enabled.

A sweep pins `open_delivery_count` and all open-index pages to one finalized block and persists its cursor. `settle` attaches 600 Tgas (450 when already funded). Final state and successful trusted-executor failure events drive per-phase/slot backoff: 1, 2, 4, 8, 16, then 30 minutes with jitter. Inclusion never resets retries. Signed hashes/bytes persist before submission; InFlight steps are never reset or newly submitted. A shared breaker slows Intents pause/locked-sender failures. Monitor structured `keeper: incident` and `keeper: alert` records for transport, finalized failures, uncertainty, InFlight and low reserves.

Hourly/daily UTC gas reservations persist and are retained after uncertainty. Charges use twice attached gas times the configured maximum gas price; refund storage has an additional conservative reservation. Once a complete FINAL outcome is verified, gas reservations reconcile to transaction and receipt `tokens_burnt`. Refund materialization retains its conservative storage component. Reconciliation is idempotent across restarts; uncertainty or missing burn data keeps the full reservation. Deleting state defeats limits and can lose transaction recovery; keep it backed up and private.

Reserve exhaustion produces refund leaves **outside the open-delivery index**. The server has no bundled indexer or leaf-history source. SDK embedders can supply `RefundSource` to `keep` to materialize provided current proofs using prepaid storage and zero attached deposit. Operators must supply complete leaf history and refresh proofs within the last-32-root window. The environment-only server services open deliveries; supply `config.keeper.refunds` when embedding `serve`, or wire a source through the SDK, for unmaterialized leaves. No keeper can resolve a permanently unavailable dependency or safely reset an uncertain InFlight payment. See the [SDK README](../../packages/annon/README.md#durable-keeper).

The isolated production-install test is opt-in: `ANNON_TEST_CONTAINER=1 pnpm --filter
@defdone/annon-relayer test`. CI runs it explicitly. Ordinary `pnpm test` does not install
packages or contact the registry for this check.

Keeper jobs use the contract's finalized network identity, rather than the RPC URL, for durable job and spending scopes. Changing RPC providers retains outstanding work and gas reservations. Gas-price checks use an explicit current finalized block hash. Both `fromEnv` and `serve` require separate relay/keeper accounts and keys before starting the keeper.

Unknown transactions are checked against the keeper access-key nonce and reference-block age at finality, using the protocol's transaction validity period in blocks. Proven consumed/expired transactions release unresolved capacity after a finalized delivery read and durable backoff. Missing validity evidence remains uncertain. The keeper classifies dependency pause/lock failures only from structured trusted-executor failures and trusted failure-event reasons; transaction metadata such as `block_hash` never trips the breaker.

An RPC `InvalidTxError` at the first unambiguous send (including `NotEnoughBalance` and `NotEnoughAllowance`) is a definite validation rejection: the keeper clears the pending transaction, releases unresolved capacity and backs off, recording a `rejected` incident. It does not resend those bytes. Transport failures retain uncertainty and may retry identical bytes; other RPC errors are monitored without immediate send retries.

Client IP limits group IPv6 addresses by /64, canonicalize mapped IPv4 addresses, and evict the
oldest client counters at capacity. Daily method counters are preserved during eviction. A held
purchase/grant returns its pending state or existing hash without another sponsored claim. Submitted
claim hashes remain cached through the purchase/grant quota window; repeats consume neither operation
quota nor daily capacity. After `HOLD_SECONDS`, the relayer checks the cached transaction. A bound
FINAL outcome that the SDK's `readOutcome` classifies as anything other than `released`, or an
explicit unknown-transaction response, retires that hash and permits a new send charged to the
existing purchase/grant quota. This includes a successful transaction carrying an MPC error,
empty return or null return; only an actual `{big_y,big_c}` release keeps the successful hash.
Non-final transactions retain their hash and are checked again after another hold. A bound FINAL
`released` outcome retains its hash for the rest of the quota window. Transport errors and
malformed or mismatched outcomes retain the cache and do not justify another send.
Concurrent checks of one cached claim share a lookup. Only new sends consume claim quota. Quota
429 responses advertise the remaining quota-window time.
The default quota of three new sponsored sends applies independently to each (purchase, grant).
Exhausting one grant does not spend another grant's quota. Global `PER_DAY` and claim method
pool limits still apply across every grant. The SDK setting `claimsPerPurchase` and environment
setting `CLAIMS_PER_PURCHASE_DAY` retain their names with this per-pair meaning.
All admission counters remain process-local. A restart resets them.

HTTP 429, 503 and 425 responses include `Retry-After` in seconds. Refusals answer
`{error, message}` with a public error code; the SDK maps it to the same error the CLI and the MCP
server report. A Base payment that is not yet safe answers 425 `settlement_pending`: retry the same
request after `Retry-After`. Chain-state checks, payment
safety and authorization run before the nonce queue. The queue checks deadline freshness and
serializes prepaid storage estimates, signing and submission. The contract enforces current
file state, purchase uniqueness, signatures and payment evidence when executing.

Relayer liquid balance and prepaid storage are sampled once a minute, beginning one minute
after startup. Liquid balance accounts for account storage stake and the full cost of an unlock.
Low transitions emit `{relayer:"alert",type:"low_balance",balance,needed}` or
`{relayer:"alert",type:"storage_low",reserve}` and use `RELAYER_ALERT_WEBHOOK` when configured.
Repeated low samples are suppressed until recovery; process restart permits a new alert.
Definite transaction validation refusals release relay holds, daily capacity and operation quotas
only when no earlier attempt was ambiguous. A later refusal cannot prove an earlier lost send
did not land; those submissions retain their holds. `claim_key` does not consume the prepaid storage estimate.

Keeper network identity is cached after a successful `get_config`; receiver reserve reads happen
at most once per minute after a successful read, including across restarts with the same store.
Pinned page snapshots skip future job/phase backoff before an individual delivery RPC read, while
still reporting snapshot InFlight incidents on every pass and emitting their alert only once.

`PER_DAY` remains the global total, not a per-method allowance. Each `PER_DAY_<METHOD>` pool
also limits that method within the same global window. Non-unlock traffic may consume at most
`PER_DAY - UNLOCK_RESERVED` transactions; unlock may use unused capacity up to its method pool
and the global cap. Capacity reserved for unlock is never borrowed by other methods. Pool
refusals and pre-send failures refund every daily counter they reserved. Global and method pool counters share
the global window end. With defaults, the total is 500, with at least 250 reserved for unlock;
operators can lower any method pool independently. IPv6 scope identifiers do not split /64 buckets.


Embedded callers must await `relayStatus`, which can refresh stale claim outcomes before
admission. The HTTP server awaits this lookup before charging admission or daily counters.

## Open file sponsorship and fees

On defdone's relayer the fee pays for the infrastructure it provides: sponsored registration and
storage, relayed transactions and the settlement keeper. We set it at cost plus a small margin.
`FEE_FIXED` and `FEE_BPS` configure the relayer's sponsorship share, with minimum values of `30000`
USDC base units and `100` basis points. Direct self-funded registration has no compulsory protocol
fee.

`SELLERS` is optional. `DEV_ALLOW_ANY_SELLER` has no effect. All valid EVM/Solana
sellers can register within these limits, including sellers absent from `SELLERS`.
NEAR sellers register with their own wallet. Minimum prices apply to both routes.

| Setting | Default | Meaning |
|---|---|---|
| `SPONSORED_FILES_PER_DAY` | `100` | Global sponsored registrations per day |
| `SPONSORED_FILES_PER_IP_DAY` | `5` | Sponsored registrations per IP bucket per day |
| `FILE_BUDGET` | `0.05` | NEAR allocated per new unlisted file |
| `LISTED_FILE_BUDGET` | `FILE_BUDGET` | NEAR allocated per new listed file |
| `TOPUP_PER_FILE` | `0.15` | Lifetime NEAR allocation cap per sponsored file, including registration |
| `TOPUP_PER_FILE_DAY` | `0.05` | Additional NEAR allocation per file per UTC day |
| `TOPUP_PER_DAY` | `0.5` | Additional NEAR allocation globally per UTC day |
| `PER_DAY_FUND_FILE_STORAGE` | `PER_DAY` | Top-up method admission pool |
| `FEE_FIXED` | `30000` | Fixed protocol fee in USDC base units |
| `FEE_BPS` | `100` | Proportional fee basis points |
| `TREASURY_NEAR` | unset | NEAR-only route recipient as `kind:id`, or a bare NEAR account ID; falls back to `TREASURY_EVM` |
| `TREASURY_EVM` | unset | Required when Base sponsorship is enabled; also accepted for the NEAR route |
| `BASE_SPONSORSHIP` | `1` | Set `0` to disable sponsored Base registrations and unlocks |
| `KEEPER_MIN_PAYOUT` | `10000` | USDC base-unit minimum for purchase-payout sponsorship |

Registration sends one zero-deposit FunctionCall action: `register` with optional
`args.file_budget`, a yoctoNEAR string. The contract atomically debits registration storage
and that allocation from the caller's prepaid balance. Insufficient prepaid funding rolls
back the whole registration. The normal register return carries the CKD callback result.
The relay hot key method list is `register,unlock,claim_key,reopen,reopen_seller,stop_sales,fund_file_storage`.
Use a function-call key restricted to this contract. Top-ups each send one FunctionCall.
A leaked hot key can allocate its account's prepaid balance to any active file, even files
outside relayer policy; those allocations cannot be withdrawn. Cap prepaid balances and key
gas allowances, monitor allocations, and rotate a compromised key. Gas allowances do not cap
prepaid storage allocations.
A zero `FILE_BUDGET` explicitly disables the allocation, leaving the listing unfunded.

Request an additional allocation through `POST /v1/relay` with
`{method:"fund_file_storage",args:{file_id:"<file-id>",amount:"<yoctoNEAR>",nonce:"<0x-32-byte-nonce>",deadline:1794528600},auth:{kind:"evm",sig:"<seller-signature>"}}`.
The registered EVM or Solana seller signs `fileFundingText` from the SDK with the file
network, contract, seller, file ID, amount, nonce and deadline. The deadline is Unix seconds,
at most 600 seconds ahead. Reuse the same envelope for retries. Only `{file_id,amount}`
reaches the contract. NEAR sellers fund directly with their wallet.
Only persistently sponsored files qualify. The explicit positive amount is subject to
lifetime, daily, tier and global caps, IP/method pools and prepaid-balance checks.
No automatic top-ups run. Ambiguous sends retain allocations and quotas.
The same nonce and request return the saved result without a second allocation.

Registration decisions, allocations, quotas and pending operations persist in
`RELAYER_STATE_DIR`. Keep this directory on durable storage and run one service instance.
Restart retains frozen eligibility and unresolved storage holds.

A sponsored registration must include at least
`ceil((FEE_FIXED * 10000 + price * FEE_BPS) / price)` basis points for the route treasury.
The defaults mean 0.03 USDC plus 1% of the price. Each zero disables that fee component;
set both to zero to disable fees. Startup refuses fees without any treasury, or Base sponsorship without `TREASURY_EVM`.
`BASE_SPONSORSHIP=0` disables sponsored Base registration and unlock. A fee consuming the whole price is refused.
A file with Base terms uses one EVM treasury share, equal to the larger of the NEAR and
Base fee requirements. `TREASURY_EVM` also serves a NEAR-only route when `TREASURY_NEAR`
is unset. All Base recipients must be EVM identities; the eight-recipient limit includes
the treasury.

Sponsored Base registration includes `baseSplit:{kind,salt}` outside contract arguments.
The relayer locally recomputes the immutable, ownerless split address from canonical
recipients, bps, kind and salt, with zero distribution incentive. It refuses a different
`pay_to`. This registration-time salt check is independent of unlock verification.

For Base unlock, including files registered before a restart or through another instance,
the relayer reads `BASE_RPC` and requires `terms.base.pay_to` to have the exact clone runtime
of a known 0xSplits v2.2 implementation. At the same Base block it checks that `splitHash()`
matches the registered recipients and bps with zero distribution incentive, `owner()` is
zero, and `paused()` is false. It also requires the current treasury share policy in the
registered terms. No salt or registration history is needed. Successful code and state
checks are cached in memory by RPC and exact terms; a restart only causes another check.
Refused split checks are cached for 60 seconds (up to 1024 entries); RPC transport failures
remain retryable immediately. New eligibility uses current policy; paid unlocks use their persisted decision.
EOAs, unknown implementations, different splits, owned or paused splits, and missing or
insufficient treasury shares are refused. RPC failures fail closed with HTTP 503
`unavailable` and `Retry-After`, so the buyer can retry without spending relay gas.

`GET /v1/capabilities` publishes `baseSponsorship`, `fee` (`fixed`, `bps`, `treasuryNear`, `treasuryEvm`) and
`sponsorship` limits and allocations in yoctoNEAR. The SDK adds required treasury shares,
scales other shares proportionally, and assigns rounding to an original seller recipient.
If the original first recipient is the treasury, another recipient receives rounding.
Required fee bps round up, so the actual share can exceed the nominal fee by less than one bp. Interactive sell reviews this split before registration or Base split creation;
JSON and agent results include the resulting public terms. Direct self-funded registration
has no compulsory treasury share.

The relayer exposes `GET /v1/capabilities` and `POST /v1/base-eligibility` for Base purchase checks. Send `{fileId, termsHash}` to eligibility before signing or submitting a new payment, and check the returned network, contract, assets and file binding.

`acceptingNewBasePayments` is the service gate for new purchases. It is false when the service is disabled, `BASE_SPONSORSHIP=0`, or sponsorship initialization is incomplete. Clients must require it before starting a new Base payment. `baseSponsorship` describes the current registration policy and does not revoke a saved eligibility decision.

An eligible response freezes its `minPrice`, `fee`, `tier`, `policyVersion` and `decidedAt`. `checkedAt` is refreshed for each response and must be checked for freshness. A paid purchase continues using its frozen decision after configuration changes, including a paused new-payment gate. Resume that purchase and respect `settlement_pending` and `retryAfterSeconds` while waiting for its unlock.

The keeper skips purchase deliveries below `KEEPER_MIN_PAYOUT` and always considers refund
only deliveries within its existing gas and transaction budgets. Sellers and other callers
can settle skipped deliveries. File-funded purchases remain independent of the refund
reserve; malformed payments and rejected purchases never spend a file budget. A successful
purchase with an excess-refund slot bypasses the threshold so its refund can settle.
