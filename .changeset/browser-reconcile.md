---
"@defdone/annon": patch
---

Add `BrowserPurchaseController.reconcile()` so a purchase that 1Click reported as failed can be checked again. Under the purchase lease it keeps the same purchase, deposit and recovery identity, checks NEAR acceptance and reads the existing deposit's 1Click status once. Accepted moves to `accepted`, `SUCCESS` to `accepting` and `REFUNDED` to `refunded`; anything else stays `failed` with the new status saved. If the saved deposit address or memo, the restored purchase's deposit and the saved polling checkpoint disagree, it refuses before any read or write. It never creates, starts or pays for a purchase.
