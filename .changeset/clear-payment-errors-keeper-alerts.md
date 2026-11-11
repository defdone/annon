---
"@defdone/annon": patch
"@defdone/annon-mcp": patch
---

Expose safe 1Click quote refusals with decimal USDC minimums and refund only definite quote refusals from agent budgets, preserving refusals if refund storage fails. Show full file IDs and contract-configured token addresses in payment confirmations, enforcing canonical USDC on mainnet. Check finalized keeper liquid balance before signing or taking a breaker probe, deduplicate delivery alerts until InFlight clears, and judge low balance once per pass. Keep runnable delivery work after alert contention. Preserve outcome monitoring for InvalidNonce resends and structured RPC errors on non-2xx responses, reporting HTTP status for non-RPC failures.
