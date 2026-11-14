# Annon relayer

An HTTP front for `relay` from `@defdone/annon`. It sends `register`, `unlock`, `claim_key`,
`reopen`, `reopen_seller`, `stop_sales` and `fund_file_storage` to an Annon contract and pays the NEAR
gas and storage, for people and agents without a NEAR account. An optional keeper, with its own
account and key, calls the permissionless `settle` so recipients get paid.

Sponsorship decisions, admissions, quotas, storage allocations and pending operations live in a
durable ledger under `RELAYER_STATE_DIR` and survive restarts. Additional HTTP request throttles are
kept in memory. Run one relayer instance per signing key and per state directory.

```sh
docker build -f apps/relayer/Dockerfile -t annon-relayer .     # from the repository root
docker run -p 8080:8080 -v relayer-state:/data --env-file relayer.env annon-relayer
```

With that volume, set `RELAYER_STATE_DIR` (and `KEEPER_STATE_DIR`) to directories under `/data`.
Without Docker: `pnpm --filter @defdone/annon-relayer start` (Node.js 22.22.2 or newer).

| Route | Answer |
|---|---|
| `POST /v1/relay` | A relay request as JSON. `200 {txHash, signer}`; `202 {txHash, signer, uncertain: true}` when NEAR's answer was lost (read the outcome by hash); `202 {pending: true, retryAfterSeconds}` while the same request is being signed; or `{error, message}` |
| `GET /v1/capabilities` | What this relayer sponsors: network, contract, methods, fee and treasuries, sponsorship allocations, minimum price, `acceptingNewBasePayments` |
| `POST /v1/base-eligibility` | `{fileId, termsHash}` in; whether this relayer will unlock a Base purchase of that file |
| `GET /healthz` | `{"ok":true}` |

The caller reads every transaction's outcome through its own NEAR RPC: a relayer cannot fake one.

## Required settings

Startup stops on a missing or invalid setting.

| Variable | Meaning |
|---|---|
| `CONTRACT_ID` | The Annon contract, for example `v1.annon.defdone.near` |
| `RELAYER_ACCOUNT` | The NEAR account that sends and pays |
| `RELAYER_KEY` | Secret. A function-call key of that account, restricted to the contract and the methods `register,unlock,claim_key,reopen,reopen_seller,stop_sales,fund_file_storage` |
| `RELAYER_STATE_DIR` | A private directory on durable storage, writable by the container's `node` user. Holds the ledger and the alert state |
| `DEMO_HOST_ORIGIN` | The HTTPS origin of the file host whose hosting reservations this relayer accepts, for example `https://demo.annon.dev`. Fixed in configuration, never taken from a request |
| `SELLERS` | Required while `OPEN_POOL_ENABLED=1` (the default). Comma-separated `kind:id` identities of listed sellers, who get their own allowance and need no hosting reservation. Keep the list private |
| `TREASURY_EVM` | Required while `BASE_SPONSORSHIP=1` (the default). The EVM identity that receives the fee share on Base listings, as `evm:0x…` or a bare address |

Fees above zero need a treasury: `TREASURY_EVM`, `TREASURY_NEAR`, or both. The relay account needs
prepaid storage on the contract (`storage_deposit`).

## Network and service settings

| Variable | Default | Meaning |
|---|---|---|
| `NEAR_RPC` | `https://rpc.mainnet.fastnear.com` | NEAR RPC. Use an endpoint with an API key for a keeper that polls often |
| `BASE_RPC` | `https://mainnet.base.org` | Base RPC. Use an endpoint with an API key: the public one rate-limits the reads made during unlocking |
| `NEAR_ARCHIVAL_RPC` | unset | Archival NEAR RPC for historical file reads. Without it, startup raises `historical_unavailable` |
| `NETWORK` | `near:mainnet` | Must match the contract's configuration |
| `NEAR_USDC`, `USDC` | The canonical USDC on NEAR and on Base | Must match the contract's configuration; startup checks both |
| `DEMO_RESERVATION_PUBLIC_KEY` | unset | The host's Ed25519 public key (64 hex characters) that signs hosting reservations. Without it, only listed sellers are sponsored |
| `CORS_ALLOW_ORIGINS` | `https://annon.dev,https://www.annon.dev` | Exact browser origins allowed to call the relayer |
| `CORS_PREVIEW_ORIGINS` | empty | Extra exact origins, for preview deployments |
| `CORS_MAX_AGE_SECONDS` | `600` | Preflight cache, at most 600 |
| `IP_HEADER` | unset | The single-value header your proxy overwrites with the client IP (for example `x-client-ip`). Never an appending header like `x-forwarded-for`. Without it, the connection's address is used |
| `DISABLED` | `0` | `1` answers 503 and sends nothing |
| `PORT` | `8080` | |

## Sponsorship and fees

On defdone's relayer the fee pays for the infrastructure it provides: sponsored registration and
storage, relayed transactions and the settlement keeper. We set it at cost plus a small margin. A
seller who registers directly with their own NEAR account pays no protocol fee.

| Variable | Default | Meaning |
|---|---|---|
| `OPEN_POOL_ENABLED` | `1` | `1`: unlisted EVM and Solana sellers can get sponsored registrations, with a hosting reservation from the host at `DEMO_HOST_ORIGIN`. `0`: only listed sellers |
| `MIN_PRICE` | `100000` | Smallest listing price and smallest Base purchase served, in USDC base units (0.10 USDC). Cannot be lower |
| `FEE_FIXED` | `30000` | Fixed fee in USDC base units (0.03 USDC). Cannot be lower |
| `FEE_BPS` | `100` | Proportional fee in basis points (1%). At least 100, below 10000 |
| `TREASURY_NEAR` | unset | Fee recipient on NEAR-only listings, as `kind:id` or a bare NEAR account. Falls back to `TREASURY_EVM` |
| `TREASURY_EVM` | unset | Fee recipient on Base listings, and on NEAR-only listings without `TREASURY_NEAR` |
| `BASE_SPONSORSHIP` | `1` | `0` disables sponsored Base registrations and Base unlocks |
| `MAX_FILE_BYTES` | `50000000` | Largest plaintext a hosting reservation may declare. Cannot be higher |
| `MAX_DEADLINE_SECONDS`, `TOPUP_MAX_DEADLINE_SECONDS` | `600` | How far ahead a wallet signature may be valid. Cannot be higher |

A sponsored registration must give the route treasury at least
`ceil((FEE_FIXED * 10000 + price * FEE_BPS) / price)` basis points. With the defaults that is 0.03 USDC
plus 1% of the price. A file with Base terms carries one EVM treasury share, the larger of the NEAR
and Base requirements, and all its recipients must be EVM identities. The eight-recipient limit
includes the treasury. A fee that takes the whole price is refused.

The SDK reads the fee from `/v1/capabilities`, adds the treasury share, scales the other shares down
and gives the rounding to an original recipient. The CLI shows the resulting split before it
registers. JSON, agent and MCP sales refuse a fee above `maxProtocolFee`; an interactive human sale
can approve it explicitly.

### Who gets sponsored

- A **listed seller** (in `SELLERS`) gets sponsored registrations up to its own daily allowance and
  needs no hosting reservation.
- An **unlisted EVM or Solana seller** gets a sponsored registration only with a hosting reservation
  signed by the host at `DEMO_HOST_ORIGIN`, and only while `OPEN_POOL_ENABLED=1`. Without one the
  request is refused with `not_sponsored` before anything is sent.
- A **NEAR seller** registers with their own wallet and does not use the relayer for it.

Sponsored Base registration includes `baseSplit: {kind, salt}` outside the contract arguments. The
relayer recomputes the immutable, ownerless split address from the recipients, shares, kind and salt,
and refuses a different `pay_to`.

### Registration quotas

| Variable | Default | Meaning |
|---|---|---|
| `SPONSORED_FILES_PER_DAY` | `60` | Sponsored registrations per UTC day for all unlisted sellers together |
| `SPONSORED_FILES_PER_IP_DAY` | `2` | Sponsored registrations per IP bucket for unlisted sellers per UTC day |
| `REGISTRATIONS_PER_SELLER_DAY` | `2` | Sponsored registrations per unlisted seller per UTC day |
| `LISTED_REGISTRATIONS_PER_SELLER_DAY` | `20` | Sponsored registrations per listed seller per UTC day |
| `SPONSORED_FILES_LISTED_RESERVED` | `0` | Fixed at 0 |

These defaults are also the highest values accepted; an operator can lower them. A registration is
charged when it is admitted. One that was sent and then failed on chain is not refunded, because
NEAR was spent.

### File storage allocations

Values in decimal NEAR, with at most 24 fractional digits. The allocation defaults are also the
highest values accepted.

| Variable | Default | Meaning |
|---|---|---|
| `FILE_BUDGET` | `0.041` | Purchase storage allocated to a new unlisted file at registration |
| `LISTED_FILE_BUDGET` | `0.05` | The same for a listed seller's file |
| `TOPUP_PER_FILE`, `LISTED_TOPUP_PER_FILE` | `0.082`, `0.15` | Lifetime allocation cap per sponsored file, registration included |
| `TOPUP_PER_FILE_DAY`, `LISTED_TOPUP_PER_FILE_DAY` | `0.041`, `0.05` | Additional allocation per file per UTC day |
| `TOPUP_PER_DAY` | `0.5` | Additional allocation across all files per UTC day |
| `TOPUP_LISTED_RESERVED` | `0.25` | Part of `TOPUP_PER_DAY` kept for listed sellers |
| `PREPAID_UNLOCK_FLOOR` | `1` | Prepaid contract storage kept for unlocks: other sponsored writes are refused when they would go below it. At least 1 |
| `STORAGE_PER_WRITE` | `0.01` | Prepaid storage set aside per sponsored write |

Registration sends one zero-deposit `register` with `args.file_budget`. The contract debits
registration storage and that allocation from the relayer's prepaid balance in one step; too little
prepaid storage rolls back the whole registration. A zero `FILE_BUDGET` leaves the listing unfunded.

A registered EVM or Solana seller can ask for more:

```json
{"method":"fund_file_storage","args":{"file_id":"<file-id>","amount":"<yoctoNEAR>","nonce":"<0x-32-byte-nonce>","deadline":1794528600},"auth":{"kind":"evm","sig":"<seller-signature>"}}
```

The seller signs `fileFundingText` from the SDK over the network, contract, seller, file ID, amount,
nonce and deadline (Unix seconds, at most 600 seconds ahead). Only sponsored files qualify, and every
cap above applies. Retries reuse the same envelope; the same nonce returns the saved result without a
second allocation. There are no automatic top-ups. NEAR sellers fund their files directly.

Keep signing credentials private and rotate a compromised key.

## Admission floor

| Variable | Default | Meaning |
|---|---|---|
| `ADMISSION_FLOOR_NEAR` | `3` | Decimal NEAR, positive. Liquid balance below which new listing work stops |

Before each seller-side write the relayer reads its liquid balance: the account balance minus the
stake for its own account storage. Below the floor it refuses sponsored `register`, `reopen_seller`,
`stop_sales` and `fund_file_storage` with `budget` (HTTP 429) and a 30-second `Retry-After`.

Buyers keep working below the floor: paid `unlock`, `claim_key` and buyer `reopen` (recovery of a
paid purchase) are still served. Crossing the floor raises one `admissions_paused` alert, and
recovering above it raises `admissions_resumed`. Set the floor above the balance you need to finish
the unlocks of purchases already paid.

## Send pools and per-client limits

| Variable | Default | Meaning |
|---|---|---|
| `PER_DAY` | `1000` | Transactions per UTC day across all methods |
| `UNLOCK_RESERVED` | `500` (at most `PER_DAY`) | Part of `PER_DAY` that only `unlock` can use |
| `UNLOCK_LISTED_RESERVED` | `250` | Part of the unlock pool kept for listed sellers' files |
| `PER_DAY_REGISTER`, `PER_DAY_UNLOCK`, `PER_DAY_CLAIM_KEY`, `PER_DAY_REOPEN`, `PER_DAY_REOPEN_SELLER`, `PER_DAY_STOP_SALES`, `PER_DAY_FUND_FILE_STORAGE` | `100`, `500`, `250`, `50`, `50`, `100`, `50` | Daily pool of one method, inside `PER_DAY` |
| `UNLOCKS_PER_FILE_DAY`, `UNLOCKS_PER_SELLER_DAY` | `10`, `20` | Sponsored Base unlocks per unlisted file and seller per day |
| `LISTED_UNLOCKS_PER_FILE_DAY`, `LISTED_UNLOCKS_PER_SELLER_DAY` | `100`, `250` | The same for listed sellers |
| `CLAIMS_PER_GRANT_DAY` | `3` | New sponsored `claim_key` sends per (purchase, grant) per 24 hours |
| `REOPENS_PER_PURCHASE_DAY` | `10` | Sponsored recoveries per wallet and file per day |
| `PER_IP_HOUR` | `600` | Durable admissions per client IP per UTC hour (IPv6 grouped by /48), with additional HTTP throttling in memory |
| `REQUEST_MULTIPLIER` | `10` | Coarse request cap per IP, as a multiple of `PER_IP_HOUR`. In memory |
| `HITS_CAP` | `100000` | In-memory client counters before the oldest are evicted |
| `HOLD_SECONDS` | `900` | How long a recent operation is held against duplicates |
| `MAX_WAITING`, `MAX_CHECKING` | `32`, `32` | Signing queue capacity and concurrent chain preflight checks |
| `RETRY_SECONDS` | `5` | Short retry hint for busy or paused answers |

Count settings must be whole numbers. Non-unlock methods together may use at most
`PER_DAY - UNLOCK_RESERVED`; capacity reserved for unlock is never lent to other methods. A definite
refusal before execution can release the operation's reserved counters. A registration that executes
and fails on chain keeps its quota charge. An uncertain result keeps its saved evidence until
reconciled.

HTTP 429, 503 and 425 answers carry `Retry-After` in seconds. Refusals answer `{error, message}`
with a public error code; the SDK maps it to the same error the CLI and the MCP server report. A Base
payment that is not yet final answers 425 `settlement_pending`: retry the same request after
`Retry-After`.

## Alerts

| Variable | Default | Meaning |
|---|---|---|
| `RELAYER_ALERT_WEBHOOK` | unset | Private HTTPS webhook for relayer alerts. Each alert is a JSON POST with `text` (a one-line summary) and `alert` (the alert fields) |
| `RELAYER_BALANCE_LOW_WATER` | 3 NEAR | Liquid balance alert, in yoctoNEAR |
| `RELAYER_STORAGE_LOW_WATER` | 0.5 NEAR | Prepaid contract storage alert, in yoctoNEAR |
| `ALERT_SAMPLE_SECONDS` | `60` | How often balances are sampled |
| `ALERT_POOL_PERCENT`, `ALERT_DISK_PERCENT` | `70`, `70` | Daily pool and disk use alerts |
| `ALERT_KEEPER_STALLED_SECONDS`, `ALERT_OLDEST_DELIVERY_SECONDS` | `300`, `1800` | Keeper progress alerts |
| `ALERT_RELAYER_429_COUNT`, `ALERT_RELAYER_429_WINDOW_SECONDS` | `20`, `600` | Refusal burst alert |
| `ALERT_KEEPER_BUDGET_PERCENT` | `50` | Keeper budget use alert |

Alerts are POSTed as JSON `{text, alert}` with a three-second timeout and no redirects; webhook
failures never stop the relayer. `alert` holds only its type and public numbers such as balances.
Keys, webhook URLs and upstream error bodies are never included. Repeated low samples are
suppressed until the value recovers.

## Base purchases

For a Base unlock the relayer reads `BASE_RPC` and requires `terms.base.pay_to` to be a clone of a
known 0xSplits v2.2 implementation. At one Base block it checks that `splitHash()` matches the
registered recipients and shares with zero distribution incentive, that `owner()` is zero and
`paused()` is false, and that the treasury share follows policy. Owned, paused or different splits,
plain accounts and missing treasury shares are refused. RPC failures fail closed with 503 and
`Retry-After`, so the buyer can retry without spending gas.

Clients call `POST /v1/base-eligibility` before signing a new Base payment and check the returned
network, contract, assets and file. `acceptingNewBasePayments` in `/v1/capabilities` must be true
for a new Base payment. It is false when the relayer is disabled, `BASE_SPONSORSHIP=0`, or the state
directory has not been sealed by the one-time cutover bootstrap in `cutover.ts` (the relayer raises
`cutover_unsealed` until then). An eligible answer freezes its `minPrice`, `fee`, `tier`,
`policyVersion` and `decidedAt`, and a paid purchase keeps that decision after later configuration
changes.

## Claims and duplicates

A purchase and grant pair gets at most `CLAIMS_PER_GRANT_DAY` new sponsored `claim_key` sends per
24 hours. A request for a pair that is already being sent returns its pending state or its hash
without another send. After `HOLD_SECONDS` the relayer checks the cached transaction: only a final
`{big_y, big_c}` release keeps the hash. A final outcome without a release, or an explicit unknown
transaction, allows one new send charged to the same pair. Non-final transactions, transport errors
and malformed outcomes keep the cache and never justify another send.

Identity-authorized requests use `{method, args, auth: {kind, sig}}`; `claim_key` and `unlock` have
only `method` and `args`. An omitted `grant` becomes `0` before signing. The call shapes are in
[specs/near-settlement.md](../../specs/near-settlement.md) section 10.

## Keeper

| Variable | Default | Meaning |
|---|---|---|
| `KEEPER_SECONDS` | `0` (off) | Seconds between keeper passes, for example `15` |
| `KEEPER_ACCOUNT`, `KEEPER_KEY` | required when on | A dedicated account and key, different from the relay account and key, allowed to call `settle` and `materialize_refund` |
| `KEEPER_STATE_DIR` | required when on | A private durable directory; `jobs` and `budgets` survive restarts |
| `KEEPER_HOURLY_BUDGET`, `KEEPER_DAILY_BUDGET` | 0.5 NEAR, 1 NEAR | Spend caps in yoctoNEAR |
| `KEEPER_GAS_PRICE` | `100000000` | Highest yoctoNEAR per gas; higher network prices stop new signing |
| `KEEPER_MIN_PAYOUT` | `100000` | Smallest purchase payout the keeper settles, in USDC base units (0.10 USDC) |
| `KEEPER_RESERVE_LOW_WATER` | 0.04096 NEAR | Refund reserve alert, in yoctoNEAR |
| `KEEPER_BALANCE_LOW_WATER` | 2 NEAR | Minimum liquid keeper balance, in yoctoNEAR. Signing needs at least this and the next transaction's full cost |
| `KEEPER_ALERT_WEBHOOK` | unset | Private HTTPS incoming webhook for keeper alerts |

Run the keeper with its dedicated account and durable state directory. Keep that state private and
backed up, and fund the account before enabling it. Check saved transactions after an uncertain
result. The keeper settles purchases at or above `KEEPER_MIN_PAYOUT` and processes refunds within its
configured budgets. Supply `config.keeper.refunds` when embedding `serve` to provide a
`RefundSource`; see the [SDK README](../../packages/annon/README.md#durable-keeper).

## Tests

The production-install container test is opt-in: `ANNON_TEST_CONTAINER=1 pnpm --filter
@defdone/annon-relayer test`. CI runs it explicitly. Ordinary `pnpm test` does not install packages
or contact the registry for this check.
