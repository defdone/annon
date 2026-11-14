---
"@defdone/annon": patch
---

Browser login offers Meteor Wallet and HOT Wallet for NEAR instead of the retired MyNearWallet, which no longer connects to apps. The login page CSP frames only the HOT widget origin, and browser NEP-413 requests no longer include a callback URL, since both wallets return signatures to the page.
