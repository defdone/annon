//! Stopping sales (by the seller) and takedowns (by the file's moderator), plan 4.9.
//! A seller alone can never take a paid key away: payments made before a stop always unlock.
use near_sdk::serde_json::json;
use near_sdk::{env, near, require, NearToken};

use crate::events::emit;
use crate::evm::{bytes, hex0x, recover_eip191};
use crate::{Annon, AnnonExt, File};

/// Base produces one block every 2 seconds from its genesis, so a verified block number gives the
/// exact time of a payment (checked against blocks 1, 33554432 and 53247902 on 2 Nov 2026).
const BASE_GENESIS: u64 = 1_686_789_347;
const BASE_BLOCK_SECONDS: u64 = 2;
/// After a stop every payment still unlocks for a week. That covers buyers if Base ever changes
/// its block time and the formula above starts dating payments too late.
const STOP_GRACE_SECONDS: u64 = 7 * 24 * 60 * 60;

/// Public reason codes for a takedown.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum TakedownReason {
    IllegalContent,
    CourtOrder,
    RightsHolderNotice,
}

#[near(serializers = [json])]
#[derive(Clone)]
pub struct StopSalesArgs {
    pub file_id: String,
    /// Unix seconds after which the signature is void.
    pub deadline: u64,
}

#[near]
impl Annon {
    /// Stops new sales of a file, signed by its seller (EIP-191 over `stop_sales_message`).
    /// Payments made before the stop still unlock, and every past buyer can still `reopen`.
    pub fn stop_sales(&mut self, args: StopSalesArgs, sig: String) {
        let file_id = bytes::<32>(&args.file_id, "file_id");
        require!(now() <= args.deadline, "signature expired");
        let signer = recover_eip191(&self.stop_sales_message(args), &sig);
        let file = self
            .files
            .get_mut(&file_id)
            .unwrap_or_else(|| env::panic_str("unknown file"));
        require!(
            signer == Some(file.seller),
            "signature is not from the seller"
        );
        require!(file.sales_stopped_at == 0, "sales already stopped");
        file.sales_stopped_at = now();
        emit(
            "sales_stopped",
            json!({ "file_id": hex0x(&file_id), "at": now() }),
        );
    }

    /// The exact text a seller signs to stop selling a file.
    pub fn stop_sales_message(&self, args: StopSalesArgs) -> String {
        format!(
            "Annon: stop selling a file\n\
             contract: {}\n\
             file: {}\n\
             valid until: {}",
            env::current_account_id(),
            hex0x(&bytes::<32>(&args.file_id, "file_id")),
            args.deadline,
        )
    }

    /// Blocks `unlock` and `reopen` for a file, with a public reason. Only the moderator named at
    /// `register`, with 1 yoctoNEAR (a full-access key or a DAO proposal, never a function-call key).
    #[payable]
    pub fn takedown(&mut self, file_id: String, reason: TakedownReason) {
        let file_id = bytes::<32>(&file_id, "file_id");
        self.moderated(&file_id).taken_down = code(&reason);
        emit(
            "taken_down",
            json!({ "file_id": hex0x(&file_id), "reason": reason, "moderator": env::predecessor_account_id() }),
        );
    }

    /// Undoes a mistaken takedown. Same rules as `takedown`.
    #[payable]
    pub fn restore(&mut self, file_id: String) {
        let file_id = bytes::<32>(&file_id, "file_id");
        self.moderated(&file_id).taken_down = 0;
        emit(
            "restored",
            json!({ "file_id": hex0x(&file_id), "moderator": env::predecessor_account_id() }),
        );
    }
}

impl Annon {
    fn moderated(&mut self, file_id: &[u8; 32]) -> &mut File {
        require!(
            env::attached_deposit() == NearToken::from_yoctonear(1),
            "attach exactly 1 yoctoNEAR"
        );
        let file = self
            .files
            .get_mut(file_id)
            .unwrap_or_else(|| env::panic_str("unknown file"));
        require!(
            file.moderator.as_ref() == Some(&env::predecessor_account_id()),
            "only this file's moderator can do that"
        );
        file
    }
}

/// Whether a payment in Base block `block_number` may release this file's key now. Checked before
/// asking MPC and again in its callback, since a stop or takedown can land in between.
pub(crate) fn payment_allowed(file: &File, block_number: u64) -> Result<(), &'static str> {
    if file.taken_down != 0 {
        return Err("file taken down");
    }
    let stopped = file.sales_stopped_at;
    if stopped != 0 {
        let paid = BASE_GENESIS.saturating_add(BASE_BLOCK_SECONDS.saturating_mul(block_number));
        if paid > stopped && now() > stopped.saturating_add(STOP_GRACE_SECONDS) {
            return Err("sales stopped before this payment");
        }
    }
    Ok(())
}

fn code(reason: &TakedownReason) -> u8 {
    match reason {
        TakedownReason::IllegalContent => 1,
        TakedownReason::CourtOrder => 2,
        TakedownReason::RightsHolderNotice => 3,
    }
}

pub(crate) fn reason(code: u8) -> Option<TakedownReason> {
    match code {
        1 => Some(TakedownReason::IllegalContent),
        2 => Some(TakedownReason::CourtOrder),
        3 => Some(TakedownReason::RightsHolderNotice),
        _ => None,
    }
}

fn now() -> u64 {
    env::block_timestamp() / 1_000_000_000
}

#[cfg(test)]
mod tests {
    use crate::tests::*;
    use crate::unlock::UNLOCK_DEPOSIT;
    use crate::*;
    use near_sdk::test_utils::get_created_receipts;
    use near_sdk::NearToken;

    const MODERATOR: &str = "moderator.sputnik-dao.near";
    const FILE: &str = "0x1111111111111111111111111111111111111111111111111111111111111111";
    const WEEK: u64 = 7 * 24 * 60 * 60;

    fn stop_args() -> StopSalesArgs {
        StopSalesArgs {
            file_id: FILE.into(),
            deadline: NOW_S + 600,
        }
    }

    fn stop(c: &mut Annon, who: &Seller) {
        let a = stop_args();
        let sig = who.sign(&c.stop_sales_message(a.clone()));
        c.stop_sales(a, sig);
    }

    /// The Base block whose time is `at` (Base: genesis 1686789347, one block every 2 s).
    fn base_block(at: u64) -> u64 {
        (at - 1_686_789_347) / 2
    }

    fn paid_at(at: u64) -> UnlockArgs {
        let mut log = split_log();
        log.block_number = base_block(at);
        unlock_args(log)
    }

    fn now(t: u64) {
        near_sdk::testing_env!(near_sdk::test_utils::VMContextBuilder::new()
            .current_account_id(CONTRACT.parse().unwrap())
            .predecessor_account_id(RELAYER.parse().unwrap())
            .attached_deposit(UNLOCK_DEPOSIT)
            .block_timestamp(t * 1_000_000_000)
            .build());
    }

    fn moderator(deposit: u128) {
        as_caller(MODERATOR, NearToken::from_yoctonear(deposit));
    }

    #[test]
    fn the_seller_can_stop_sales() {
        let mut c = listed();
        stop(&mut c, &Seller::new(1));
        assert_eq!(
            c.get_file(FILE.into()).unwrap().sales_stopped_at,
            Some(NOW_S)
        );
        assert_eq!(events("sales_stopped")[0]["file_id"], FILE);
    }

    #[test]
    #[should_panic(expected = "signature is not from the seller")]
    fn nobody_else_can_stop_sales() {
        let mut c = listed();
        stop(&mut c, &Seller::new(2));
    }

    #[test]
    #[should_panic(expected = "signature expired")]
    fn an_expired_stop_is_refused() {
        let mut c = listed();
        let mut a = stop_args();
        a.deadline = NOW_S - 1;
        let sig = Seller::new(1).sign(&c.stop_sales_message(a.clone()));
        c.stop_sales(a, sig);
    }

    #[test]
    #[should_panic(expected = "sales already stopped")]
    fn a_stop_can_not_be_replayed() {
        let mut c = listed();
        stop(&mut c, &Seller::new(1));
        stop(&mut c, &Seller::new(1));
    }

    #[test]
    fn a_payment_made_before_the_stop_always_unlocks() {
        let mut c = listed();
        stop(&mut c, &Seller::new(1));
        now(NOW_S + 365 * 24 * 60 * 60);
        c.unlock(paid_at(NOW_S - 60)); // reaches MPC
    }

    #[test]
    fn any_payment_unlocks_in_the_week_after_a_stop() {
        let mut c = listed();
        stop(&mut c, &Seller::new(1));
        now(NOW_S + WEEK - 1);
        c.unlock(paid_at(NOW_S + 60));
    }

    #[test]
    #[should_panic(expected = "sales stopped before this payment")]
    fn a_payment_after_the_stop_is_refused_once_the_week_is_over() {
        let mut c = listed();
        stop(&mut c, &Seller::new(1));
        now(NOW_S + WEEK + 1);
        c.unlock(paid_at(NOW_S + 60));
    }

    #[test]
    fn past_buyers_can_still_reopen_after_a_stop() {
        let mut c = listed();
        mpc_answered(verified(SPLIT_PAYLOAD_HASH));
        callback(&mut c);
        now(NOW_S);
        stop(&mut c, &Seller::new(1));
        let buyer = Seller::new(7);
        let r = reopen_args(FILE, &buyer);
        c.reopen(r.clone(), buyer.sign(&c.reopen_message(r)));
    }

    #[test]
    fn the_moderator_can_take_a_file_down_and_restore_it() {
        let mut c = listed();
        moderator(1);
        c.takedown(FILE.into(), TakedownReason::CourtOrder);
        let f = c.get_file(FILE.into()).unwrap();
        assert_eq!(f.taken_down, Some(TakedownReason::CourtOrder));
        assert_eq!(events("taken_down")[0]["reason"], "court_order");
        moderator(1);
        c.restore(FILE.into());
        assert_eq!(c.get_file(FILE.into()).unwrap().taken_down, None);
        assert_eq!(events("restored")[0]["file_id"], FILE);
    }

    #[test]
    #[should_panic(expected = "only this file's moderator can do that")]
    fn nobody_else_can_take_a_file_down() {
        let mut c = listed();
        as_caller("other-mod.sputnik-dao.near", NearToken::from_yoctonear(1));
        c.takedown(FILE.into(), TakedownReason::IllegalContent);
    }

    #[test]
    #[should_panic(expected = "only this file's moderator can do that")]
    fn a_file_without_a_moderator_can_not_be_taken_down() {
        let mut c = contract();
        let seller = Seller::new(1);
        let mut a = args(&seller);
        a.moderator = None;
        let sig = signed(&c, &seller, &a);
        c.register(a, sig);
        moderator(1);
        c.takedown(FILE.into(), TakedownReason::IllegalContent);
    }

    #[test]
    #[should_panic(expected = "attach exactly 1 yoctoNEAR")]
    fn a_takedown_needs_a_full_access_key_or_a_dao_proposal() {
        let mut c = listed();
        moderator(0);
        c.takedown(FILE.into(), TakedownReason::IllegalContent);
    }

    #[test]
    #[should_panic(expected = "file taken down")]
    fn a_taken_down_file_does_not_unlock() {
        let mut c = listed();
        moderator(1);
        c.takedown(FILE.into(), TakedownReason::RightsHolderNotice);
        now(NOW_S);
        c.unlock(unlock_args(split_log()));
    }

    #[test]
    #[should_panic(expected = "file taken down")]
    fn a_taken_down_file_does_not_reopen() {
        let mut c = listed();
        moderator(1);
        c.takedown(FILE.into(), TakedownReason::IllegalContent);
        now(NOW_S);
        let seller = Seller::new(1);
        let r = reopen_args(FILE, &seller);
        c.reopen(r.clone(), seller.sign(&c.reopen_message(r)));
    }

    #[test]
    fn a_takedown_during_verification_releases_nothing_and_keeps_the_payment_usable() {
        let mut c = listed();
        c.unlock(unlock_args(split_log()));
        moderator(1);
        c.takedown(FILE.into(), TakedownReason::IllegalContent);
        mpc_answered(verified(SPLIT_PAYLOAD_HASH));
        let before = get_created_receipts().len();
        callback(&mut c);
        assert!(!c.is_buyer(FILE.into(), PAYER.into()));
        assert!(near_sdk::test_utils::get_logs()
            .iter()
            .any(|l| l.contains("file taken down")));
        assert!(!get_created_receipts()[before..]
            .iter()
            .any(|r| r.receiver_id.as_str() == "v1.signer"));
        moderator(1);
        c.restore(FILE.into());
        now(NOW_S);
        c.unlock(unlock_args(split_log())); // the same payment works after restore
    }

    #[test]
    fn a_stop_during_verification_is_checked_in_the_callback_too() {
        let mut c = listed();
        now(NOW_S);
        c.unlock(paid_at(NOW_S + 60));
        stop(&mut c, &Seller::new(1));
        // the callback runs more than a week later and the payment came after the stop
        near_sdk::testing_env!(
            near_sdk::test_utils::VMContextBuilder::new()
                .current_account_id(CONTRACT.parse().unwrap())
                .predecessor_account_id(CONTRACT.parse().unwrap())
                .block_timestamp((NOW_S + WEEK + 1) * 1_000_000_000)
                .build(),
            near_sdk::test_vm_config(),
            near_sdk::RuntimeFeesConfig::test(),
            Default::default(),
            vec![verified(SPLIT_PAYLOAD_HASH)],
        );
        c.on_payment_verified(
            FILE.into(),
            format!("0x{}", "33".repeat(48)),
            PAYER.into(),
            format!("0x{}{}", "aa".repeat(32), "0000000000000007"),
            SPLIT_PAYLOAD_HASH.into(),
            RELAYER.parse().unwrap(),
            near_sdk::json_types::U128(UNLOCK_DEPOSIT.as_yoctonear()),
            false,
            near_sdk::json_types::U128(10_000),
            base_block(NOW_S + 60),
        );
        assert!(!c.is_buyer(FILE.into(), PAYER.into()));
    }

    #[test]
    fn stopping_and_taking_down_never_grow_storage() {
        let mut c = listed();
        let flushed = |c: &mut Annon| {
            c.files.flush();
            near_sdk::env::storage_usage()
        };
        let start = flushed(&mut c);
        stop(&mut c, &Seller::new(1));
        assert_eq!(flushed(&mut c), start, "stop_sales grew storage");
        moderator(1);
        c.takedown(FILE.into(), TakedownReason::RightsHolderNotice);
        assert_eq!(flushed(&mut c), start, "takedown grew storage");
        moderator(1);
        c.restore(FILE.into());
        assert_eq!(flushed(&mut c), start, "restore changed storage");
    }
}
