<!-- verify against merged code in the phase 2 docs pass -->

# Using Annon with a NEAR account

A NEAR account can buy directly on NEAR, sell files and recover its purchases. Selling and recovery
require NEAR for gas and contract storage. Direct Base payments require a separate EVM wallet.

Under the release rule, a file sold from a NEAR account will list without Base terms. Buyers will
pay on NEAR or through 1Click, including 1Click with Base as the source chain. This listing rule is
pending release. A separate EVM payout address for Base proceeds is on the
[roadmap](../ROADMAP.md#base-payouts-for-near-and-solana-sellers).

This page explains why NEAR accounts pay storage, what it costs, and what we plan to change.

## Why

The contract recognises identities in two ways.

- A **NEAR account** authorizes contract actions by submitting them from that account. In the
  current flow, its wallet submits the actions and pays gas; registration and recovery use its
  prepaid storage balance.
- An **EVM or Solana** identity authorizes actions with a signed message. A relayer can submit that
  message and fund the action when it accepts the sponsorship request.

## What it costs

| | NEAR account | EVM or Solana wallet |
|---|---|---|
| Who submits the transaction | You, from your account | A relayer, with your signature, when it accepts the request |
| Selling: NEAR you pay | Contract storage for the listing, and a purchase storage budget for the file | No NEAR for sponsored registration |
| Protocol fee on each sale | None | Default sponsorship fee: 0.03 USDC plus 1% of the price |
| Recovering a purchase on a new device | Gas and contract storage for the new key grant | Nothing |

Self-funded listings have no compulsory protocol fee. The registered split determines each
recipient's share. We charge only for infrastructure that defdone runs, such as sponsorship and the
relayer, at cost plus a small margin. Using the protocol, the SDK or the CLI on your own
infrastructure has no fee, and there is no shop commission.

Direct NEAR buying requires a NEAR wallet, USDC on NEAR and NEAR for gas. Sponsored Base buying
requires an EVM wallet and USDC on Base, and works only for files whose terms include Base. A 1Click
purchase requires a supported source asset and enough funds for the quoted deposit and source-chain
transaction costs.

## Selling from a NEAR account

Configure the reviewed deployment, NEAR wallet and backup secret first (see the
[README](../README.md#from-the-command-line)). Replace the account, file ID and amounts with your own
values.

1. Prepay contract storage with `storage_deposit` (the README example uses 0.01 NEAR). If it runs
   short, a register or recover call stops with `storage_required`; deposit more and resume.
2. Give the file a purchase storage budget when you sell:

   ```sh
   annon sell report.pdf --wallet near --price 1.00 --split near:YOUR_ACCOUNT.near:10000 --storage-budget 0.05 --output report.pay2
   ```

3. Check it with `annon budget 0xFILE_ID` before you share the URL, and add more when it runs low:

   ```sh
   annon fund 0xFILE_ID 0.05 --wallet near
   ```

How the budget works:

- Each NEAR or 1Click purchase requires the file's available budget to cover the contract's
  admission allowance, currently 0.04096 NEAR. A failed preflight returns `file_storage_low` before
  payment. This check does not reserve storage: if the budget is too low when payment arrives, the
  contract does not accept the purchase and refunds the USDC to the designated NEAR Intents account.
- A purchase keeps a small permanent record, about 0.003 to 0.005 NEAR of storage. The temporary part
  of each purchase returns to the budget after the payout.
- Purchases paid on Base do not use the file's budget.
- NEAR put into a file's budget cannot be withdrawn.

## Recovering on a new device

Configure the reviewed deployment, NEAR wallet and backup secret first. Replace account, purchase ID
and file URL placeholders with your own values. Prepay a little storage as in step 1 above, then:

```sh
annon recover --wallet near --recovery near:YOUR_ACCOUNT.near
annon open 0xPURCHASE_ID --url https://demo.annon.dev/f/FILE --output file.pdf
```

You never pay for the file again.

## What we plan to change

We plan to sponsor contract storage for NEAR accounts. See the
[roadmap](../ROADMAP.md#near-storage-sponsorship-for-near-accounts).
