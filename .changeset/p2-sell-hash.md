---
"@defdone/annon": patch
---

Check NEAR wallet return hashes against the pending call's exact deposit and the time the attempt started. Old, mismatched or unreadable hashes are refused with transaction_uncertain and leave the pending operation in place, so no second deposit is sent. Saved transaction hashes are also checked for the exact deposit. Passing txHash when no NEAR wallet call is pending now fails with invalid_arguments.
