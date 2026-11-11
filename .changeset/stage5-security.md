---
"@defdone/annon": minor
"@defdone/annon-mcp": minor
---

Harden agent purchase policy and relayer admission, retry transient refusals, reconcile keeper gas reservations after finality, and reuse verified unlock answers for the first open.

Breaking for operators: agent mode requires config maxPrice and a human-set workDir, refuses local offer files and policy flags, confines file paths, and ignores state-directory environment overrides. Price and resource environment values can only tighten config policy. Production relayers require SELLERS; PER_DAY remains a global cap with reserved unlock capacity.

Canonicalize claim grants and refresh stale failed or unknown claim hashes without refunding quota. Confine local verify targets and open backup/PAY2 inputs to workDir. Embedded relayStatus callers must now await the result.

Classify FINAL claim outcomes with the SDK readOutcome classifier: any not-released result permits a quota-charged retry after the hold. Apply claim quotas independently per purchase/grant while retaining the existing setting names and global/method limits.
