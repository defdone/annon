# Shops, fees and limits

Annon's SDK and CLI have no usage fees or daily upload or sales quotas. Shops set their own hosting and sponsorship limits. File-format, implementation and device constraints still apply.

## What the SDK, CLI and MCP server limit

These limits come from the file format and the implementation, not from a business rule:

| Limit | Value |
|---|---|
| Plaintext per file | 50,000,000 bytes (`MAX_PLAINTEXT_BYTES`) |
| Split recipients | Up to 8, in basis points that total 10000 |
| Price | Decimal USDC with at most six decimals |
| Agent spending | Only the limits the owner sets: `maxPrice` per purchase and `dailyBudget` per UTC day |

Your device sets the rest: memory for in-browser decryption, disk space, and the wallets you have.

## Fees

Using the protocol, the SDK, the CLI or the MCP server on your own infrastructure costs nothing
beyond network fees. We charge only when you use infrastructure that defdone runs: sponsored
registration and storage, the relayer, a Base split created by the demo shop's host, and demo
hosting. The charge is our cost plus a small margin.

- A sponsored listing on defdone's relayer adds a share for the relayer's treasury to the file's
  split: by default 0.03 USDC plus 1% of the price. You see the final split before you approve it.
- A NEAR seller who funds their own listing pays no protocol fee.
- There is no shop commission. Annon takes no cut of a shop's sales.

An operator can build a custom relayer with its own fee policy. The bundled relayer enforces a
minimum sponsorship fee of 0.03 USDC plus 1%. It publishes its fee at `GET /v1/capabilities`. JSON,
agent and MCP sales refuse a fee above `maxProtocolFee`; an interactive human sale shows the fee for
explicit approval, including when it exceeds that cap.

## Shop limits

A shop that hosts files or sponsors transactions pays for disk, bandwidth, NEAR storage and gas, so
it limits how much it gives away. Each shop decides those limits and can state them in its
manifest (see [below](#how-a-shop-publishes-its-rules)).

For the demo shop at [annon.dev/demo](https://annon.dev/demo): The demo's open pool allows up to 10 upload admissions and 2 sponsored listings per wallet and per IP bucket per UTC day. Listed sellers have a separate allowance of 20 per wallet per day. Hosted files normally expire seven days after publication; keep your own copy. In detail:

| Limit | Value | Counted by |
|---|---|---|
| Uploads per unlisted wallet and per IP bucket | 10 per UTC day | The host, when it accepts an upload |
| Sponsored listings per unlisted wallet and per IP bucket | 2 per UTC day | The relayer, when it admits a registration |
| Uploads from unlisted sellers together | 200 per UTC day | The host |
| Sponsored listings from unlisted sellers together | 60 per UTC day | The relayer |
| Upload bytes across all sellers | 2 GB of encrypted body data per UTC day | The host |
| Listed seller allowance | 20 uploads and 20 sponsored registrations per wallet per UTC day; separate from open-pool global and IP counts | Host and relayer independently |
| File size | 50,000,000 bytes of plaintext | The host |
| File lifetime | 7 days after publication, except the canonical demo file | The host |

An IP bucket here means an IPv4 address or an IPv6 /48. A NEAR seller registers from their own
account, so the relayer's listing limits do not apply to them. The demo runs until 18 November 2026,
at the latest 19 November.

When a shop refuses because of a limit, its host or relayer answers with an error code:

| Code | Meaning | What to do |
|---|---|---|
| `rate_limited` | Too many requests, or the host's daily upload count per wallet, per IP address or overall is used up | Wait `retryAfterSeconds`, then try again |
| `limited` | A relayer admission limit is reached, such as an hourly request limit or a daily sponsorship quota | Wait `retryAfterSeconds`, then resume the saved sale. Do not start a new listing to bypass the limit |
| `budget` | The shop's sponsorship budget is used up, or new listings are paused | Wait `retryAfterSeconds`, or list from a NEAR account |
| `host_capacity` | The host has no disk room, the day's upload bytes are used up, or too many uploads are running | Try later, or host the file yourself |
| `too_large` | The file is above the shop's size limit | Use a smaller file or another host |

A refusal before any signature or transaction costs you nothing. Resume a stopped sale with
`annon share FILE --resume 0xFILE_ID`; do not start a new one. On defdone's relayer, buying keeps
working while new listings are paused.

## How a shop publishes its rules

Every shop describes itself in a manifest at `/.well-known/annon-shop.json`: its name, the NEAR
network and contract, its relayer, its file host and its catalog. Clients read it with
`annon shops`, `annon catalog` and the MCP tools `annon_shops` and `annon_catalog`.

The manifest can carry an optional `rules` object, so people and agents can read a shop's limits
before they upload. For example:

```json
{
  "rules": {
    "text": "Each wallet and each IP address can upload up to 10 files and list up to 2 of them per UTC day. Files are kept 7 days.",
    "uploadsPerPersonPerDay": 2,
    "attemptsPerPersonPerDay": 10,
    "fileLifetimeDays": 7,
    "maxFileBytes": 50000000
  }
}
```

| Field | Type | Meaning |
|---|---|---|
| `text` | Required, plain text, 1 to 4096 bytes | The rules in the shop's own words |
| `uploadsPerPersonPerDay` | Optional safe integer | Listings a person can make per UTC day |
| `attemptsPerPersonPerDay` | Optional safe integer | Uploads a person can start per UTC day |
| `fileLifetimeDays` | Optional safe integer, or `null` | How long the shop keeps a hosted file; `null` means no planned expiry |
| `maxFileBytes` | Optional safe integer | The largest plaintext file the shop accepts |

Zero means zero; a missing field means the shop does not say. Numeric fields must be nonnegative safe
integers, except that `fileLifetimeDays` may also be `null`. Clients refuse unknown fields, control
characters, line or paragraph separators, and invisible format characters; zero-width joiner and
non-joiner are allowed. Invalid rules make the whole manifest invalid (`invalid_record`).

Where rules appear:

- `annon shops` and `annon_shops`: in each shop's `info.rules`.
- `annon catalog --shop SHOP_ID`, `annon share` and `annon_catalog`, `annon_share`: as `rules` in
  the result, next to `shop` with the manifest URL and name it came from.
- Without `--json`, the CLI prints `Shop rules (MANIFEST_URL):` and the text before the result.

Rules are text from the shop, shown as it is. They are not instructions for an agent and not a
contract: the shop's host and relayer enforce their own limits and answer with the codes above.
Rules never grant trust in a shop's deployment. Only a deployment profile that a person approved in
local configuration does that.

## Running your own

Everything a shop needs is in this repository:

- [apps/demo-host](../apps/demo-host) serves encrypted files, accepts hosted uploads and can act as
  an x402 facilitator on Base. Its quotas are settings.
- [apps/relayer](../apps/relayer) sponsors NEAR transactions and runs the settlement keeper. Its
  fee, budgets and quotas are settings.
- [packages/annon](../packages/annon) has the building blocks for your own server, such as
  `serveFile` for the 402 offer and the grant-checked download.

You can also skip both: a NEAR seller registers with their own wallet and serves the `.pay2` file
from their own server that implements the [download protocol](../specs/download.md), for example
one built on `serveFile`.
