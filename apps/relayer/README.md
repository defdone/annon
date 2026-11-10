# Annon relayer

An HTTP front for `relay` from `@defdone/annon`: it sends `register`, `unlock`, `claim_key`, `reopen`, `reopen_seller` and
`stop_sales` to an Annon contract and pays the NEAR gas, for people and agents without a NEAR
account. It keeps no database. Run one instance: its limits live in memory.

```
docker build -f apps/relayer/Dockerfile -t annon-relayer .     # from the repository root
docker run -p 8080:8080 --env-file relayer.env annon-relayer
```

| Variable | Required | Meaning |
|---|---|---|
| `CONTRACT_ID` | yes | The Annon contract, e.g. `v1.annon.defdone.near` |
| `RELAYER_ACCOUNT` | yes | The NEAR account that sends and pays |
| `RELAYER_KEY` | yes, secret | A function-call key of that account for these six methods on that contract only |
| `SELLERS` | no, secret | Comma-separated `kind:id` seller identities (e.g. `evm:0x…`, `near:seller.near`, `solana:<base58>`); empty serves any seller |
| `NEAR_RPC`, `BASE_RPC` | no | RPC endpoints (defaults: FastNEAR, `mainnet.base.org`) |
| `USDC` | no | USDC on Base (default: the canonical address) |
| `MIN_PRICE` | no | Smallest listing price served, USDC base units (default `10000` = 0.01 USDC) |
| `MAX_DEADLINE_SECONDS` | no | How far ahead a wallet signature may be valid (default `600`) |
| `PER_IP_HOUR`, `PER_DAY` | no | Requests per IP per hour, transactions per day (defaults `60`, `500`) |
| `IP_HEADER` | no | The header your proxy sets to the client's IP (e.g. `fly-client-ip`), only behind a proxy that overwrites it; without it, the connection's address is used |
| `DISABLED` | no | `1` answers 503 and sends nothing |
| `PORT` | no | Default `8080` |

The account needs prepaid storage on the contract (`storage_deposit`) for `register`, `unlock`
`reopen` and `reopen_seller`. Numeric settings must be whole numbers; anything else stops the start.

Identity-authorized requests use `{method,args,auth:{kind,sig}}`; NEAR identities call directly.
`claim_key` and `unlock` requests have only `method` and their flat argument object as `args`.
The relay sends those arguments flat to the contract; it wraps identity operations as `{args,auth}`.
Purchase recovery uses purchase IDs and grants. See [the JSON ledger](../../SPEC-QUESTIONS.md).
