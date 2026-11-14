# Annon demo host

The file host behind the demo shop. It serves Annon files behind `serveFile` from the SDK: until a
purchase is final on NEAR, a request gets `402` with the x402 offer; after it, the buyer who proves
the purchase gets the file. It also accepts hosted uploads from sellers, can be its own x402
facilitator on Base, and can create a seller's split contract on Base.

The host never sees a file key or plaintext. It stores encrypted PAY2 files and checks them against
the terms registered on NEAR before it publishes them.

## Routes

| Route | Answer |
|---|---|
| `GET /` | The files and the commands to buy them (HTML) |
| `GET /files.json` | The catalog for clients and agents: name, file ID, title, description, URL, header URL, sizes, creation and expiry time, registered terms, and whether sales stopped or the file was taken down |
| `GET /f/<name>` | The PAY2 file: `402` with the offer until paid, `410 file_expired` after expiry |
| `GET /f/<name>/header` | Its public header, checked by the buyer before paying |
| `POST /v1/uploads` | Start a hosted upload with a seller-signed request |
| `PUT /v1/uploads/<id>/body`, `PUT /v1/uploads/<id>/header` | Send the encrypted body, then the signed header |
| `GET /v1/uploads/<id>` | Upload status |
| `POST /v1/uploads/<id>/base-split` | Ask the host to create the file's split contract on Base (EVM sellers) |
| `GET /v1/upload-reservations/<id>` | The signed hosting reservation the relayer checks |
| `GET /healthz` | `{"ok":true}` |

`POST /v1/uploads` carries the signed upload request, including `auth`, in its JSON body. Body,
header, upload-status and base-split requests use `Annon-Upload-Authorization`. The reservation
lookup is public; the relayer verifies the host's signature on the returned reservation. The offer for a
file includes Base only when its final on-chain terms have a Base payee. A Base payment for any other
file is refused with `400 route_unavailable` before any settlement work.

## Hosted uploads

The SDK's `UploadClient` drives this sequence; `annon share` uses it.

1. The seller signs an upload request (`uploadText`): EVM with `personal_sign`, Solana with
   `signMessage`, NEAR with a NEP-413 message. The host checks the signature, the size and the
   quotas, and reserves disk and ingress before it accepts a byte.
2. The seller streams the encrypted body. The host hashes it as it arrives and refuses it if it does
   not match the declared commitment.
3. For a verified body the host issues a hosting reservation, signed with its reservation key and
   valid for 600 seconds. The relayer accepts an unlisted seller's sponsored registration only with
   such a reservation, so no NEAR is spent on a file the host has not checked.
4. For an EVM seller with Base terms, the host creates the split contract (see below).
5. After the terms are registered on NEAR, the seller sends the signed header. The host checks it
   against the final chain state and publishes the file atomically.

A verified unfinished upload expires after `UPLOAD_STAGING_SECONDS` (default 24 hours), measured
from body verification. It can be restaged. Published files expire `UPLOAD_TTL_SECONDS` (default 7
days) after first publication, except the canonical demo file; that published-file expiry is
permanent on this host.

## Quotas

A hosted upload is counted when the host accepts its admission, not on every request. An upload
that fails before its body is verified gives its count back; the bytes it sent still count toward
the daily byte limit. The limits apply per UTC day.

| Variable | Default | Meaning |
|---|---|---|
| `SPONSORED_FILES_PER_DAY` | `200` | Accepted uploads from unlisted sellers, all together |
| `SPONSORED_FILES_PER_IP_DAY` | `10` | Accepted uploads per IP bucket for unlisted sellers (IPv4 address, IPv6 /48) |
| `REGISTRATIONS_PER_SELLER_DAY` | `10` | Accepted uploads per unlisted seller wallet |
| `LISTED_REGISTRATIONS_PER_SELLER_DAY` | `20` | Accepted uploads per listed seller |
| `UPLOAD_BYTES_PER_DAY` | `2000000000` | Encrypted body bytes accepted per day across all uploads (2 GB). Bytes of failed uploads still count |
| `UPLOAD_CONCURRENCY` | `4` | Uploads receiving at the same time |
| `UPLOADS_PER_SELLER`, `UPLOADS_PER_IP` | `1`, `1` | Uploads receiving at the same time per seller and per IP |
| `MAX_FILE_BYTES` | `50000000` | Plaintext per file |
| `HOST_DATA_BUDGET_BYTES` | `80000000000` | Disk the host may use, at most `HOST_VOLUME_BYTES` |
| `POOL_STORAGE_BYTES` | `40000000000` | Disk for unlisted sellers' files |
| `OPEN_POOL_ENABLED` | `1` | `0` accepts uploads only from listed sellers |

Every limit can be lowered, never raised above its default. A quota refusal answers `429
rate_limited` with `Retry-After`; a full disk or a closed pool answers `503 host_capacity`. These
quotas are separate from the relayer's: the relayer counts sponsored registrations, where NEAR is
spent. A shop can publish its rules for sellers in its manifest; see
[docs/shops-and-limits.md](../../docs/shops-and-limits.md).

## Base split service

For an EVM seller whose terms include Base, the host creates the 0xSplits v2 split on Base at its
own gas cost. The seller's signed terms already commit to the predicted address, so there is no
separate signature.

- The request is `POST /v1/uploads/<id>/base-split` with `{"kind":"push","salt":"0x00…00"}` (64
  zeros) and the upload authorization, only after a verified body and a live reservation.
- The host builds the factory call itself from the stored terms: recipients and shares,
  `totalAllocation` 10000, no distribution incentive and no owner. It reuses an identical split that
  already exists.
- It saves the nonce, transaction hash and spend before it broadcasts, and reconciles a lost answer
  to the same address and transaction before any new send.
- `202` with `{baseSplit: {state: "pending", …}}` while the transaction is open; `200` with
  `state: "ready"` once the split is read back from Base.

Split deployment is off by default. Enabling it requires every budget below, with no guessed
defaults:

| Variable | Meaning |
|---|---|
| `SPLIT_DEPLOY_ENABLED` | `1` to enable, default `0` |
| `SPLIT_DEPLOYMENTS_PER_DAY` | New splits per UTC day |
| `SPLIT_SENDS_PER_MINUTE` | Split transactions per minute |
| `SPLIT_REVERTS_PER_DAY` | Reverted split transactions per day before deployment pauses |
| `SPLIT_GAS_LIMIT` | Gas limit per split transaction |
| `SPLIT_MAX_FEE_GWEI` | Fee cap per split transaction |
| `SPLIT_L1_FEE_ALLOWANCE_WEI` | Allowance for Base's L1 data fee per transaction |
| `SPLIT_DAILY_BUDGET_WEI` | ETH the host may spend on splits per day |
| `BASE_WALLET_DAILY_BUDGET_WEI` | ETH the host wallet may spend per day in total; at least `FACILITATOR_DAILY_GAS_BUDGET_WEI` plus `SPLIT_DAILY_BUDGET_WEI` |
| `TREASURY_EVM` | The relayer's EVM treasury, so the predicted split includes its fee share |
| `FEE_FIXED`, `FEE_BPS` | The relayer's fee, at least `30000` and `100` |
| `MIN_PRICE` | Smallest price, default `100000` |

Payments and splits share one nonce queue. Buyer payments keep their own budget: a split is sent only
if it fits both its own cap and the total after the remaining payment budget is protected. Budget or
rate exhaustion answers `429 budget` or `rate_limited` with the retry time; an open transaction
answers `202 settlement_pending`; disabled deployment answers `503 disabled`. Size the budgets from
the number of splits you expect and current Base gas prices.

## Settings

Required:

| Variable | Meaning |
|---|---|
| `CONTRACT_ID` | The Annon contract the files are registered on |
| `NEAR_RPC`, `BASE_RPC` | RPC endpoints. Use endpoints with an API key; public ones rate-limit the reads a payment needs |
| `PUBLIC_URL` | The host's own HTTPS origin; offers and downloads name it |
| `RELAYER_ORIGIN` | The relayer's HTTPS origin, used for Base eligibility checks |
| `FILES_DIR` | Holds `files.json` and the operator's `.pay2` files |
| `DATA_DIR` | Durable state: uploads, quotas, downloads, payments in flight, the facilitator's nonce queue. In Docker, a volume writable by uid 1000 |
| `SELLERS` | Comma-separated `kind:id` identities of listed sellers, the same list as on the relayer. Keep it private |
| `CANONICAL_DEMO_FILE_ID` | The file ID of the canonical demo file (`what-we-are-building`), which never expires |
| `DEMO_ALERT_WEBHOOK` | Private HTTPS incoming webhook for host alerts, also used for startup failures |

Optional:

| Variable | Default | Meaning |
|---|---|---|
| `DEMO_RESERVATION_SIGNING_KEY` | unset | Secret. 64 hex characters, the Ed25519 seed that signs hosting reservations. Without it the upload routes answer `503 unavailable` |
| `FACILITATOR_KEY` | unset | Secret. A Base hot wallet that submits buyers' USDC authorizations and pays their gas. Without it, Base payments get `501` and the index shows only the NEAR route |
| `MAX_FEE_GWEI` | `0.5` | Fee cap for payment transactions, at most 0.5 |
| `FACILITATOR_DAILY_GAS_BUDGET_WEI` | `1000000000000000` | ETH for payment transactions per day (0.001 ETH) |
| `FACILITATOR_REVERTS_PER_DAY`, `FACILITATOR_PAYER_REVERTS_PER_DAY` | `10`, `1` | Reverted payments per day, in total and per payer |
| `FACILITATOR_ETH_LOW_WATER` | `0.003` | ETH balance alert |
| `SENDS_PER_MINUTE` | `10` | Facilitator transactions per minute |
| `PAYMENTS_PER_CLIENT_MINUTE` | `60` | Requests carrying a payment per client per minute |
| `PER_IP_MINUTE` | `600` | Requests per client per minute (`/healthz` is not counted) |
| `DOWNLOAD_IMMEDIATE_COUNT` | `3` | Downloads per purchase before the waits start (15 minutes, 2 hours, then 24 hours) |
| `CORS_ALLOW_ORIGINS`, `CORS_PREVIEW_ORIGINS` | the annon.dev origins, empty | Exact browser origins |
| `IP_HEADER` | unset | A single-value client IP header that your proxy overwrites (for example `x-client-ip`); never an appending header like `x-forwarded-for`. Behind a proxy without it, every client shares one limit |
| `PORT` | `8080` | |

`settings.ts` has the full list, including upload timeouts, download waits and alert thresholds.
Most numeric settings have a ceiling in code, and a value above it stops startup.

`files.json` lists the operator's own files:

```json
[{ "name": "hello", "fileId": "0x…", "title": "Hello", "description": "…", "priceUsdc": "0.10" }]
```

`name` is the URL segment and the file name (`hello.pay2`). Buyers pay the price registered on the
contract; `priceUsdc` is only shown on the index. Published uploads are added to the catalog
automatically.

## Run

```sh
pnpm --filter @defdone/annon-demo-host start
```

With Docker, from the repository root:

```sh
docker build -f apps/demo-host/Dockerfile -t annon-demo-host .
```

The facilitator pins Base USDC and submits an authorization only when its recipient and amount match
the offer, USDC has not marked it used, and a dry run succeeds, so a payer without the USDC costs no
gas. It sends one transaction at a time, at most one per payer every 30 seconds and at most
`SENDS_PER_MINUTE`, never sends the same authorization twice, and answers right after broadcast so
the payment check can watch Base. Keep only a little ETH on its wallet.
