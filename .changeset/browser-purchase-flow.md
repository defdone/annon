---
"@defdone/annon": minor
---

Add explicit purchase routes, durable browser purchase orchestration and encrypted IndexedDB receipts. Add 1Click token selection, dry previews, origin refund validation, memo deposits and resumable polling.

Preserve legacy 1Click origins, validate selected origins before purchase preparation, and store browser purchases separately with atomic metadata updates and bounded contention retries.

Legacy CLI/MCP Solana and EVM refund addresses are now validated; invalid refund addresses are refused. Aurora retains its legacy explicit-refund behaviour. Preserve recovery revision archives, track Base authorization exposure before dry-run requests, and fence active browser preparations with renewable leases.
