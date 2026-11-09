---
'@defdone/annon': minor
---

`preflight` and `authorize` check the PAY2 header (or the whole public file) before anything is signed; `offerFor` requires `header` and an https `download`. Add `nextStep` and `purchaseKey` to resume a purchase without paying twice.
