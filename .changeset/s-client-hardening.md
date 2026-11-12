---
'@defdone/annon': patch
'@defdone/annon-mcp': patch
---

Check Base sponsorship and split eligibility before signing. Preserve pending Base purchases after expiry and allow an explicit NEAR unlock wallet when resuming with a fresh SDK instance.

Enforce configured source spending caps, prevent accidental repeat purchases, and retain download and settlement waits across restarts. Automatic download retries and pending-payment polling now stop after at most 60 seconds of total waiting and return the remaining retry hint. Use the same saved purchase when retrying.

Require a configured origin for agent 1Click purchases. Recover the purchase guard queue after a failed renewal and preserve completed buy results when reservation cleanup fails.
