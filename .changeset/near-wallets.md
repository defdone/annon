---
"@defdone/annon": patch
---

Browser login offers Meteor Wallet and HOT Wallet for NEAR instead of the retired MyNearWallet, which no longer connects to apps. HOT is offered for near:mainnet only, and unknown NEAR chains are refused. The login page CSP connects only to the page, the selector's NEAR RPC and HOT's relay, and frames only the HOT widget. Browser NEP-413 requests no longer include a callback URL, since both wallets return signatures to the page. The bundled Meteor SDK no longer logs its generated key pair, and Meteor sign-out removes that key.
