//! Storage money. Callers pay for what they store; a prepaid balance (NEP-145 style) lets a
//! function-call key `unlock` without attaching a deposit.
use near_sdk::json_types::U128;
use near_sdk::{env, near, require, AccountId, NearToken};

use crate::{Annon, AnnonExt};

#[near]
impl Annon {
    /// Prepays storage for `account_id` (the caller by default). Anyone may fund anyone, e.g. an
    /// owner funding their agent; the first deposit pays for its own balance entry.
    #[payable]
    pub fn storage_deposit(&mut self, account_id: Option<AccountId>) -> U128 {
        let who = account_id.unwrap_or_else(env::predecessor_account_id);
        let mut amount = env::attached_deposit().as_yoctonear();
        if !self.balances.contains_key(&who) {
            let before = env::storage_usage();
            self.balances.insert(who.clone(), 0);
            self.balances.flush();
            let entry = env::storage_byte_cost()
                .saturating_mul((env::storage_usage() - before).into())
                .as_yoctonear();
            require!(
                amount > entry,
                format!("attach a deposit above {entry} yoctoNEAR")
            );
            amount -= entry;
        }
        require!(amount > 0, "attach a deposit");
        let balance = self.balances.get_mut(&who).unwrap();
        *balance += amount;
        U128(*balance)
    }

    /// Sends the caller's prepaid balance (all of it by default) back to the caller. Needs exactly
    /// 1 yoctoNEAR, which only a full-access key can attach, so a leaked function-call key can't.
    #[payable]
    pub fn storage_withdraw(&mut self, amount: Option<U128>) -> U128 {
        require!(
            env::attached_deposit() == NearToken::from_yoctonear(1),
            "attach exactly 1 yoctoNEAR"
        );
        let who = env::predecessor_account_id();
        let have = self.balances.get(&who).copied().unwrap_or(0);
        let take = amount.map_or(have, |a| a.0);
        require!(take <= have, "not enough balance");
        if have > 0 {
            self.balances.insert(who.clone(), have - take);
        }
        transfer(&who, NearToken::from_yoctonear(take + 1));
        U128(have - take)
    }

    pub fn storage_balance_of(&self, account_id: AccountId) -> Option<U128> {
        self.balances.get(&account_id).map(|b| U128(*b))
    }
}

impl Annon {
    /// Returns unused storage money: to the prepaid balance it came from, or as a transfer.
    pub(crate) fn give_back(&mut self, to: &AccountId, amount: NearToken, prepaid: bool) {
        if prepaid {
            *self.balances.entry(to.clone()).or_insert(0) += amount.as_yoctonear();
        } else {
            transfer(to, amount);
        }
    }
}

pub(crate) fn pay_for_storage(bytes_used: u64) {
    let cost = env::storage_byte_cost().saturating_mul(bytes_used.into());
    let attached = env::attached_deposit();
    require!(
        attached >= cost,
        format!(
            "attach at least {} yoctoNEAR for storage",
            cost.as_yoctonear()
        )
    );
    transfer(
        &env::predecessor_account_id(),
        attached.saturating_sub(cost),
    );
}

pub(crate) fn transfer(to: &AccountId, amount: NearToken) {
    if amount > NearToken::from_yoctonear(0) {
        let p = env::promise_batch_create(to);
        env::promise_batch_action_transfer(p, amount);
    }
}

#[cfg(test)]
mod tests {
    use crate::tests::*;
    use crate::unlock::UNLOCK_DEPOSIT;
    use near_sdk::json_types::U128;
    use near_sdk::test_utils::get_created_receipts;
    use near_sdk::{NearToken, PromiseResult};

    #[test]
    fn storage_deposit_credits_the_caller_or_the_named_account() {
        let mut c = listed();
        as_caller(RELAYER, NearToken::from_millinear(100));
        c.storage_deposit(None);
        let own = balance(&c, RELAYER);
        assert!(
            own > NearToken::from_millinear(99).as_yoctonear()
                && own <= NearToken::from_millinear(100).as_yoctonear()
        );

        as_caller("owner.near", NearToken::from_millinear(50));
        c.storage_deposit(Some("agent.near".parse().unwrap()));
        assert!(balance(&c, "agent.near") > 0);
        assert_eq!(balance(&c, "owner.near"), 0);
    }

    #[test]
    #[should_panic(expected = "attach a deposit")]
    fn storage_deposit_needs_a_deposit() {
        let mut c = listed();
        as_caller(RELAYER, NearToken::from_yoctonear(0));
        c.storage_deposit(None);
    }

    #[test]
    fn unlock_with_no_deposit_draws_from_the_prepaid_balance() {
        let mut c = listed();
        as_caller(RELAYER, NearToken::from_millinear(100));
        c.storage_deposit(None);
        let before = balance(&c, RELAYER);
        as_caller(RELAYER, NearToken::from_yoctonear(0)); // a function-call key attaches nothing
        c.unlock(unlock_args(split_log()));
        assert_eq!(balance(&c, RELAYER), before - UNLOCK_DEPOSIT.as_yoctonear());
    }

    #[test]
    fn a_prepaid_unlock_returns_unused_storage_to_the_balance() {
        let mut c = listed();
        as_caller(RELAYER, NearToken::from_millinear(100));
        c.storage_deposit(None);
        as_caller(RELAYER, NearToken::from_yoctonear(0));
        c.unlock(unlock_args(split_log()));
        let reserved = balance(&c, RELAYER);
        mpc_answered(verified(SPLIT_PAYLOAD_HASH));
        let receipts = get_created_receipts().len();
        prepaid_callback(&mut c);
        let back = balance(&c, RELAYER) - reserved;
        assert!(
            back > 0 && back < UNLOCK_DEPOSIT.as_yoctonear(),
            "returned {back}"
        );
        assert_eq!(
            refunded(receipts),
            0,
            "prepaid refunds go to the balance, not a transfer"
        );
    }

    #[test]
    fn a_failed_prepaid_unlock_restores_the_whole_reservation() {
        let mut c = listed();
        as_caller(RELAYER, NearToken::from_millinear(100));
        c.storage_deposit(None);
        let start = balance(&c, RELAYER);
        as_caller(RELAYER, NearToken::from_yoctonear(0));
        c.unlock(unlock_args(split_log()));
        mpc_answered(PromiseResult::Failed);
        prepaid_callback(&mut c);
        assert_eq!(balance(&c, RELAYER), start);
    }

    #[test]
    #[should_panic(expected = "or call storage_deposit first")]
    fn unlock_with_no_deposit_and_no_balance_is_refused() {
        let mut c = listed();
        as_caller("agent.near", NearToken::from_yoctonear(0));
        c.unlock(unlock_args(split_log()));
    }

    #[test]
    fn storage_withdraw_sends_the_balance_back_to_its_owner() {
        let mut c = listed();
        as_caller(RELAYER, NearToken::from_millinear(100));
        c.storage_deposit(None);
        let have = balance(&c, RELAYER);
        as_caller(RELAYER, NearToken::from_yoctonear(1));
        let before = get_created_receipts().len();
        c.storage_withdraw(None);
        assert_eq!(balance(&c, RELAYER), 0);
        assert_eq!(
            refunded(before),
            have + 1,
            "balance (and the 1 yocto) back to its owner"
        );
    }

    #[test]
    #[should_panic(expected = "attach exactly 1 yoctoNEAR")]
    fn storage_withdraw_needs_a_full_access_key() {
        let mut c = listed();
        as_caller(RELAYER, NearToken::from_millinear(100));
        c.storage_deposit(None);
        as_caller(RELAYER, NearToken::from_yoctonear(0)); // what a leaked function-call key can send
        c.storage_withdraw(None);
    }

    #[test]
    #[should_panic(expected = "not enough balance")]
    fn nobody_withdraws_more_than_they_have() {
        let mut c = listed();
        as_caller(RELAYER, NearToken::from_millinear(100));
        c.storage_deposit(None);
        as_caller("stranger.near", NearToken::from_yoctonear(1));
        c.storage_withdraw(Some(U128(1)));
    }
}
