---
"@defdone/annon": patch
---

Check Base authorization validity, balances and nonce state before recording new payments. Add exact-origin CORS validation and hooks for durable completed-download accounting.

The SDK HTTP helper now applies an exact-origin CORS allow-list policy with no origins allowed by default. Integrators configure `allowedOrigins` and, optionally, verified exact `previewOrigins` on `handle()` for their browser clients.
