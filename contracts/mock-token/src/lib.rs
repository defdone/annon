//! Test stand-in for Annon's sandbox tests only. Deployed twice: as NEAR USDC (a NEP-141 token
//! with the real `ft_transfer_call` → `ft_on_transfer` → `ft_resolve_transfer` chain) and as
//! `intents.near` (a deposit credits the account named in `msg`; `mt_transfer` moves balances).
//! `set_mode` makes the Intents side refuse deposits or fail transfers.
use near_sdk::json_types::U128;
use near_sdk::serde_json::json;
use near_sdk::{env, near, require, AccountId, Gas, GasWeight, NearToken};
use std::collections::HashMap;

#[near(contract_state)]
#[derive(Default)]
pub struct MockToken {
    balances: HashMap<AccountId, u128>,
    /// Intents balances: `owner/token_id`.
    mt: HashMap<String, u128>,
    /// "ok" (default), "refuse_deposit" or "fail_mt".
    mode: String,
}

impl MockToken {
    fn debit(&mut self, who: &AccountId, amount: u128) {
        let b = self.balances.entry(who.clone()).or_default();
        require!(*b >= amount, "not enough balance");
        *b -= amount;
    }
}

#[near]
impl MockToken {
    pub fn set_mode(&mut self, mode: String) {
        self.mode = mode;
    }

    pub fn mint(&mut self, account_id: AccountId, amount: U128) {
        *self.balances.entry(account_id).or_default() += amount.0;
    }

    pub fn ft_balance_of(&self, account_id: AccountId) -> U128 {
        U128(self.balances.get(&account_id).copied().unwrap_or(0))
    }

    #[payable]
    pub fn ft_transfer_call(&mut self, receiver_id: AccountId, amount: U128, msg: String) {
        require!(
            env::attached_deposit() == NearToken::from_yoctonear(1),
            "requires 1 yocto"
        );
        let sender = env::predecessor_account_id();
        self.debit(&sender, amount.0);
        *self.balances.entry(receiver_id.clone()).or_default() += amount.0;
        let p = env::promise_batch_create(&receiver_id);
        env::promise_batch_action_function_call_weight(
            p,
            "ft_on_transfer",
            json!({ "sender_id": sender, "amount": amount, "msg": msg })
                .to_string()
                .as_bytes(),
            NearToken::from_yoctonear(0),
            Gas::from_tgas(30),
            GasWeight(1),
        );
        let t = env::promise_batch_then(p, &env::current_account_id());
        env::promise_batch_action_function_call_weight(
            t,
            "ft_resolve_transfer",
            json!({ "sender_id": sender, "receiver_id": receiver_id, "amount": amount })
                .to_string()
                .as_bytes(),
            NearToken::from_yoctonear(0),
            Gas::from_tgas(10),
            GasWeight(0),
        );
        env::promise_return(t);
    }

    /// As in near-contract-standards: refunds the unused amount and returns the used one.
    #[private]
    pub fn ft_resolve_transfer(
        &mut self,
        sender_id: AccountId,
        receiver_id: AccountId,
        amount: U128,
    ) -> U128 {
        let unused = match env::promise_result_checked(0, 64) {
            Ok(v) => near_sdk::serde_json::from_slice::<U128>(&v)
                .map(|u| u.0.min(amount.0))
                .unwrap_or(amount.0),
            Err(_) => amount.0,
        };
        let have = self.balances.get(&receiver_id).copied().unwrap_or(0);
        let back = unused.min(have);
        if back > 0 {
            self.debit(&receiver_id, back);
            *self.balances.entry(sender_id).or_default() += back;
        }
        U128(amount.0 - back)
    }

    /// As intents.near: a deposit credits the account named in `msg`.
    pub fn ft_on_transfer(&mut self, sender_id: AccountId, amount: U128, msg: String) -> U128 {
        let _ = sender_id;
        if self.mode == "refuse_deposit" {
            return amount;
        }
        let token = format!("nep141:{}", env::predecessor_account_id());
        *self.mt.entry(format!("{msg}/{token}")).or_default() += amount.0;
        U128(0)
    }

    #[payable]
    pub fn mt_transfer(
        &mut self,
        receiver_id: String,
        token_id: String,
        amount: U128,
        approval: Option<near_sdk::serde_json::Value>,
        memo: Option<String>,
    ) {
        let _ = (approval, memo);
        require!(
            env::attached_deposit() == NearToken::from_yoctonear(1),
            "requires 1 yocto"
        );
        require!(self.mode != "fail_mt", "transfers are paused");
        let from = format!("{}/{token_id}", env::predecessor_account_id());
        let have = self.mt.get(&from).copied().unwrap_or(0);
        require!(have >= amount.0, "not enough Intents balance");
        self.mt.insert(from, have - amount.0);
        *self
            .mt
            .entry(format!("{receiver_id}/{token_id}"))
            .or_default() += amount.0;
    }

    pub fn mt_balance_of(&self, account_id: String, token_id: String) -> U128 {
        U128(
            self.mt
                .get(&format!("{account_id}/{token_id}"))
                .copied()
                .unwrap_or(0),
        )
    }
}
