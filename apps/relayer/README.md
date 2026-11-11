# Annon relayer

An HTTP front for `relay` from `@defdone/annon`: it sends `register`, `unlock`, `claim_key`, `reopen`, `reopen_seller` and
`stop_sales` to an Annon contract and pays the NEAR gas, for people and agents without a NEAR
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
| `RELAYER_KEY` | yes, secret | A function-call key of that account for the six relay methods, on that contract only |
| `SELLERS` | no, secret | Comma-separated `kind:id` seller identities (e.g. `evm:0x…`, `near:seller.near`, `solana:<base58>`); empty serves any seller |
| `NEAR_RPC`, `BASE_RPC` | no | RPC endpoints (defaults: FastNEAR, `mainnet.base.org`) |
| `USDC` | no | USDC on Base (default: the canonical address) |
| `MIN_PRICE` | no | Smallest listing price served, USDC base units (default `10000` = 0.01 USDC) |
| `MAX_DEADLINE_SECONDS` | no | How far ahead a wallet signature may be valid (default `600`) |
| `PER_IP_HOUR`, `PER_DAY` | no | Requests per IP per hour, transactions per day (defaults `60`, `500`) |
| `IP_HEADER` | no | The header your proxy sets to the client's IP (e.g. `fly-client-ip`), only behind a proxy that overwrites it; without it, the connection's address is used |
| `DISABLED` | no | `1` answers 503 and sends nothing |
| `KEEPER_SECONDS` | no | Seconds between keeper passes (default `0`, disabled); enabling requires the keeper settings below |
| `PORT` | no | Default `8080` |

The account needs prepaid storage on the contract (`storage_deposit`) for `register`, `unlock`
`reopen` and `reopen_seller`. Numeric settings must be whole numbers; anything else stops the start.

Identity-authorized requests use `{method,args,auth:{kind,sig}}`; NEAR identities call directly.
`claim_key` and `unlock` requests have only `method` and `args`. The relay sends identity
operations as `{args,auth}`, `unlock` as `{args}` (the purchase message, logs and header) and
`claim_key` flat (`{purchase_id,grant}`). Purchase recovery uses purchase IDs and grants; the call
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

Set `KEEPER_SECONDS=30` to enable. The account needs gas, a sufficient key allowance, and prepaid contract storage for refund materialization. The keeper has its own nonce queue, so relay requests do not serialize behind it. Shutdown cancels future passes. Mount a writable persistent volume owned by the container's `node` user at `KEEPER_STATE_DIR`.

A sweep pins `open_delivery_count` and all open-index pages to one finalized block and persists its cursor. `settle` attaches 600 Tgas (450 when already funded). Final state and successful trusted-executor failure events drive per-phase/slot backoff: 1, 2, 4, 8, 16, then 30 minutes with jitter. Inclusion never resets retries. Signed hashes/bytes persist before submission; InFlight steps are never reset or newly submitted. A shared breaker slows Intents pause/locked-sender failures. Monitor structured `keeper: incident` and `keeper: alert` records for transport, finalized failures, uncertainty, InFlight and low reserves.

Hourly/daily UTC gas reservations persist and are retained after uncertainty. Charges use twice attached gas times the configured maximum gas price; refund storage has an additional conservative reservation. This intentionally overcounts actual burn. Deleting state defeats limits and can lose transaction recovery; keep it backed up and private.

Reserve exhaustion produces refund leaves **outside the open-delivery index**. The server has no bundled indexer or leaf-history source. SDK embedders can supply `RefundSource` to `keep` to materialize provided current proofs using prepaid storage and zero attached deposit. Operators must supply complete leaf history and refresh proofs within the last-32-root window. The environment-only server services open deliveries; supply `config.keeper.refunds` when embedding `serve`, or wire a source through the SDK, for unmaterialized leaves. No keeper can resolve a permanently unavailable dependency or safely reset an uncertain InFlight payment. See the [SDK README](../../packages/annon/README.md#durable-keeper).

The isolated production-install test is opt-in: `ANNON_TEST_CONTAINER=1 pnpm --filter
@defdone/annon-relayer test`. CI runs it explicitly. Ordinary `pnpm test` does not install
packages or contact the registry for this check.

Keeper jobs use the contract's finalized network identity, rather than the RPC URL, for durable job and spending scopes. Changing RPC providers retains outstanding work and gas reservations. Gas-price checks use an explicit current finalized block hash. Both `fromEnv` and `serve` require separate relay/keeper accounts and keys before starting the keeper.

Unknown transactions are checked against the keeper access-key nonce and reference-block age at finality, using the protocol's transaction validity period in blocks. Proven consumed/expired transactions release unresolved capacity after a finalized delivery read and durable backoff. Missing validity evidence remains uncertain. The keeper classifies dependency pause/lock failures only from structured trusted-executor failures and trusted failure-event reasons; transaction metadata such as `block_hash` never trips the breaker.
