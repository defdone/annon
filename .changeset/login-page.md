---
"@defdone/annon": patch
---

The CLI wallet approval page shows a readable summary of exactly what the wallet signs: a title per action, the pairing code to compare, amounts in USDC or NEAR, receiver, account, expiry and what signing does, with the CLI's terms shown apart and the raw request under Technical details (the NEP-413 nonce as hex). Each click opens at most one wallet window, so Meteor's web popup is no longer blocked: NEP-413 messages are signed without a sign-in, and transactions connect first and then send. After a closed, blocked or declined wallet window the page explains it and allows another try until the request expires. The terminal prints a waiting line with the expiry, the reported wallet failure and a specific final error (`cancelled`, `rejected` or `wallet_error`) instead of `operation_failed`.
