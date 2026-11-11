# Annon demo host

A small public host for Annon files. Each file is served behind `serveFile` from the SDK: until a
purchase is final on NEAR, a request gets `402` with the x402 offer; after it, the buyer who proves
the purchase gets the file. Optionally the host is its own x402 facilitator on Base.

| Route | Answer |
|---|---|
| `GET /` | the demo files and the commands to buy them |
| `GET /files.json` | the same list for scripts and agents |
| `GET /f/<name>` | the PAY2 file (`402` with the offer until paid) |
| `GET /f/<name>/header` | its public header, checked by the buyer before paying |
| `GET /healthz` | `{"ok":true}` |

## Settings

| Variable | Meaning |
|---|---|
| `CONTRACT_ID` | the Annon contract the files are registered on |
| `NEAR_RPC`, `BASE_RPC` | RPC endpoints; use endpoints with an API key, public ones rate-limit the reads a payment needs |
| `PUBLIC_URL` | the host's own https URL; offers and downloads name it |
| `FILES_DIR` | holds `files.json` and the `.pay2` files it names |
| `DATA_DIR` | durable seller records (a payment in flight survives a restart); in Docker a volume writable by uid 1000 |
| `FACILITATOR_KEY` | optional; a Base hot wallet that submits buyers' USDC authorizations and pays their gas. Without it, requests carrying a payment get `501` and the index shows only the NEAR route |
| `MAX_FEE_GWEI` | fee cap for the facilitator's transactions, default 0.5 |
| `PAYMENTS_PER_CLIENT_MINUTE` | requests carrying a payment per client per minute, default 30 (a waiting buyer resends about every 3 s) |
| `SENDS_PER_MINUTE` | facilitator transactions per minute, default 10 |
| `PER_IP_MINUTE` | requests per client per minute, default 120 (IPv6 counted per /64; `/healthz` is not counted) |
| `IP_HEADER` | a single-value client IP header that your proxy overwrites (e.g. `fly-client-ip`); never an appending header like `x-forwarded-for`. Behind a proxy without it, every client shares the proxy's address and therefore one limit |
| `PORT` | default 8080 |

`files.json`:

```json
[{ "name": "hello", "fileId": "0x…", "title": "Hello", "description": "…", "priceUsdc": "0.10" }]
```

`name` is the URL segment and the file name (`hello.pay2`). The price buyers pay is the one
registered on the contract; `priceUsdc` is only shown on the index.

## Run

```sh
pnpm --filter @defdone/annon-demo-host start
```

With Docker, from the repository root:

```sh
docker build -f apps/demo-host/Dockerfile -t annon-demo-host .
```

Only `GET` is served. The facilitator pins Base USDC, submits an authorization only when its
recipient and amount match the offer, USDC has not marked it used and a dry run against USDC
succeeds (so a payer without the USDC costs no gas), sends one transaction at a time, one per payer every 30 s and at most
`SENDS_PER_MINUTE`, never sends the same authorization twice, and answers right after broadcast so the payment
check records the hash and watches Base. Keep only a little ETH on its wallet.
