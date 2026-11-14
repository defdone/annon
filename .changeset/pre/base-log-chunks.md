---
"@defdone/annon": patch
---

Search Base for a payment in eth_getLogs chunks of at most 10,000 blocks, so a purchase whose search window outgrows the common RPC range limit still reaches unlock instead of failing with a transport error on every retry.
