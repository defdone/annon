---
"@defdone/annon": patch
"@defdone/annon-mcp": patch
---

Hosting lifetime is now the shop's policy. Hosted selling accepts any future publication expiry from the selected shop, or `null` for no planned expiry, instead of refusing expiries more than seven days away. An expiry at or before the current time is still refused with `file_expired`, and malformed values are refused. `Shared.expiresAt` and the browser seller's `view().result.expiresAt` are now `number | null`. Saved completed sales stay readable after their expiry. The browser seller's `quote.hostedDays` comes from the new optional `fileLifetimeDays` option instead of a fixed 7, and is absent when the page does not pass it.
