# Annon relayer

An HTTP front for `relay` from `@defdone/annon`: it sends `register`, `unlock`, `claim_key`, `reopen`, `reopen_seller` and
`stop_sales` to an Annon contract and pays the NEAR gas, for people and agents without a NEAR
account. It also runs the keeper: after each NEAR purchase or refund it calls `fund_delivery` and
`pay_slot`, which anyone may call and which can't change an amount or a destination. It keeps no
database. Run one instance: its limits live in memory.

```
docker build -f apps/relayer/Dockerfile -t annon-relayer .     # from the repository root
docker run -p 8080:8080 --env-file relayer.env annon-relayer
```

| Variable | Required | Meaning |
|---|---|---|
| `CONTRACT_ID` | yes | The Annon contract, e.g. `v1.annon.defdone.near` |
| `RELAYER_ACCOUNT` | yes | The NEAR account that sends and pays |
| `RELAYER_KEY` | yes, secret | A function-call key of that account for these six methods plus `fund_delivery` and `pay_slot`, on that contract only |
| `SELLERS` | no, secret | Comma-separated `kind:id` seller identities (e.g. `evm:0x…`, `near:seller.near`, `solana:<base58>`); empty serves any seller |
| `NEAR_RPC`, `BASE_RPC` | no | RPC endpoints (defaults: FastNEAR, `mainnet.base.org`) |
| `USDC` | no | USDC on Base (default: the canonical address) |
| `MIN_PRICE` | no | Smallest listing price served, USDC base units (default `10000` = 0.01 USDC) |
| `MAX_DEADLINE_SECONDS` | no | How far ahead a wallet signature may be valid (default `600`) |
| `PER_IP_HOUR`, `PER_DAY` | no | Requests per IP per hour, transactions per day (defaults `60`, `500`) |
| `IP_HEADER` | no | The header your proxy sets to the client's IP (e.g. `fly-client-ip`), only behind a proxy that overwrites it; without it, the connection's address is used |
| `DISABLED` | no | `1` answers 503 and sends nothing |
| `KEEPER_SECONDS` | no | Seconds between keeper passes (default `30`); `0` turns the keeper off |
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

Each keeper pass reads `delivery_count` once and up to 20 `list_deliveries` pages of 50 IDs.
This costs `1 + min(20, ceil(delivery_count / 50))` contract view calls per pass (excluding
transport retries). At the default 30-second interval, a full scan takes about
`30 * ceil(ceil(delivery_count / 50) / 20)` seconds, plus RPC and sending time. IDs include
settled gaps and reserved refund leaves: scan cost grows with historical IDs. Old IDs must be
revisited because refund leaves can materialize there later. A larger SDK `maxPages` reduces
scan latency at the cost of more views per pass. No daily 10,000-step retry cap exists.
Each attempted step has a one-minute hold; successful passes and RPC/signing outages cannot
accumulate exponential per-step delays. Expired holds are swept each pass. Steps observed in
flight are never sent again until a contract callback makes them due.

The isolated production-install test is opt-in: `ANNON_TEST_CONTAINER=1 pnpm --filter
@defdone/annon-relayer test`. CI runs it explicitly. Ordinary `pnpm test` does not install
packages or contact the registry for this check.
