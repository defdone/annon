//! Stopping sales (by the seller) and takedowns (by the file's moderator), plan 4.9.
//! A seller alone can never take a paid key away: payments made before a stop always unlock.
//! The payment's time comes from its Base block header, never from the block number: Base's block
//! time changed (2 s to 200 ms on 5 Nov 2026, Denim) and may change again.
use near_sdk::serde_json::json;
use near_sdk::{env, near, require, NearToken};

use crate::events::emit;
use crate::evm::{bytes, hex0x, recover_eip191};
use crate::text::utc;
use crate::{Annon, AnnonExt, File};

/// A payment that lands on Base this long after a stop still counts, so an authorization signed
/// before the stop (the SDK signs for at most 180 s, plus 60 s of clock skew) can't be settled into a payment without a key,
/// by a slow facilitator or a seller who stops on purpose.
pub(crate) const STOP_SETTLEMENT_SECONDS: u64 = 300;

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
             Signing this is final: the file can't be sold again. Past buyers keep access.\n\
             contract: {}\n\
             file: {}\n\
             valid until: {}",
            env::current_account_id(),
            hex0x(&bytes::<32>(&args.file_id, "file_id")),
            utc(args.deadline),
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

/// Whether a payment made at Base time `paid_at` (from its block header) may release this file's
/// key. Checked before asking MPC and again in its callback, since a stop or takedown can land in
/// between. The answer never depends on when `unlock` runs: a payment from before the stop unlocks
/// years later, one from after it never does. While sales are open the time isn't needed.
pub(crate) fn payment_allowed(file: &File, paid_at: Option<u64>) -> Result<(), &'static str> {
    if file.taken_down != 0 {
        return Err("file taken down");
    }
    let stopped = file.sales_stopped_at;
    if stopped == 0 {
        return Ok(());
    }
    match paid_at {
        None => Err("sales were stopped: send the payment's block header"),
        Some(t) if t > stopped.saturating_add(STOP_SETTLEMENT_SECONDS) => {
            Err("sales stopped before this payment")
        }
        Some(_) => Ok(()),
    }
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
    use crate::moderation::STOP_SETTLEMENT_SECONDS;
    use crate::tests::*;
    use crate::unlock::UNLOCK_DEPOSIT;
    use crate::*;
    use near_sdk::test_utils::get_created_receipts;
    use near_sdk::NearToken;

    const MODERATOR: &str = "moderator.sputnik-dao.near";
    const FILE: &str = "0x1111111111111111111111111111111111111111111111111111111111111111";
    const YEAR: u64 = 365 * 24 * 60 * 60;

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

    /// The test payment, landed on Base at `at`, with its block header.
    fn paid_at(at: u64) -> UnlockArgs {
        let (logs, header) = with_header(x402_logs(), at);
        UnlockArgs {
            header: Some(header),
            ..unlock_logs(logs)
        }
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
    fn the_stop_message_says_it_is_final_and_reads_in_utc() {
        let c = listed();
        let m = c.stop_sales_message(stop_args());
        assert!(m.contains("this is final"), "{m}");
        assert!(m.ends_with("\nvalid until: 2026-10-26 07:43:20 UTC"), "{m}");
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
        now(NOW_S);
        stop(&mut c, &Seller::new(1));
        now(NOW_S + YEAR);
        c.unlock(paid_at(NOW_S - 60)); // reaches MPC
    }

    #[test]
    fn the_settlement_window_is_five_minutes() {
        assert_eq!(STOP_SETTLEMENT_SECONDS, 300);
    }

    #[test]
    fn a_payment_settled_within_the_window_after_the_stop_counts_forever() {
        let mut c = listed();
        now(NOW_S);
        stop(&mut c, &Seller::new(1));
        now(NOW_S + YEAR);
        c.unlock(paid_at(NOW_S + 300));
    }

    #[test]
    #[should_panic(expected = "sales stopped before this payment")]
    fn a_payment_after_the_window_never_unlocks_right_away() {
        let mut c = listed();
        now(NOW_S);
        stop(&mut c, &Seller::new(1));
        now(NOW_S + 302);
        c.unlock(paid_at(NOW_S + 301));
    }

    #[test]
    #[should_panic(expected = "sales stopped before this payment")]
    fn a_payment_after_the_window_never_unlocks_years_later() {
        let mut c = listed();
        now(NOW_S);
        stop(&mut c, &Seller::new(1));
        now(NOW_S + YEAR);
        c.unlock(paid_at(NOW_S + 301));
    }

    #[test]
    #[should_panic(expected = "sales were stopped: send the payment's block header")]
    fn after_a_stop_the_header_is_required() {
        let mut c = listed();
        now(NOW_S);
        stop(&mut c, &Seller::new(1));
        c.unlock(unlock_args());
    }

    #[test]
    fn while_sales_are_open_no_header_is_needed() {
        let mut c = listed();
        now(NOW_S);
        c.unlock(unlock_args()); // reaches MPC
    }

    #[test]
    #[should_panic(expected = "the header is not the payment's block")]
    fn a_header_of_another_block_is_refused() {
        let mut c = listed();
        now(NOW_S);
        stop(&mut c, &Seller::new(1));
        // A real, earlier header, but the log is in another block.
        let (_, early) = with_header(x402_logs(), NOW_S - 60);
        let (logs, _) = with_header(x402_logs(), NOW_S + YEAR);
        c.unlock(UnlockArgs {
            header: Some(early),
            ..unlock_logs(logs)
        });
    }

    #[test]
    #[should_panic(expected = "the header is not the payment's block")]
    fn a_header_whose_number_is_not_the_log_block_is_refused() {
        let mut c = listed();
        now(NOW_S);
        stop(&mut c, &Seller::new(1));
        // The header hashes to the log's block hash, but is for the next block number.
        let mut next = x402_logs();
        for l in &mut next {
            l.block_number += 1;
        }
        let (hashed, header) = with_header(next, NOW_S - 60);
        let mut logs = x402_logs();
        for l in &mut logs {
            l.block_hash = hashed[0].block_hash.clone();
        }
        c.unlock(UnlockArgs {
            header: Some(header),
            ..unlock_logs(logs)
        });
    }

    #[test]
    fn past_buyers_can_still_reopen_after_a_stop() {
        let mut c = listed();
        mpc_answered(verified(X402_PAYLOAD_HASH));
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
        c.unlock(unlock_args());
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
        c.unlock(unlock_args());
        moderator(1);
        c.takedown(FILE.into(), TakedownReason::IllegalContent);
        mpc_answered(verified(X402_PAYLOAD_HASH));
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
        c.unlock(unlock_args()); // the same payment works after restore
    }

    /// Runs the callback that the last `unlock` scheduled, with exactly the arguments it
    /// scheduled, as MPC's answer (confirming that payload) arrives at `at`.
    fn run_scheduled_callback(c: &mut Annon, at: u64) {
        let a: near_sdk::serde_json::Value = get_created_receipts()
            .into_iter()
            .flat_map(|r| r.actions)
            .filter_map(|action| match action {
                near_sdk::mock::MockAction::FunctionCallWeight {
                    method_name, args, ..
                } if method_name == b"on_payment_verified" => {
                    Some(near_sdk::serde_json::from_slice(&args).unwrap())
                }
                _ => None,
            })
            .next_back()
            .expect("unlock scheduled no callback");
        let s = |k: &str| a[k].as_str().unwrap().to_string();
        let n = |k: &str| near_sdk::json_types::U128(s(k).parse().unwrap());
        near_sdk::testing_env!(
            near_sdk::test_utils::VMContextBuilder::new()
                .current_account_id(CONTRACT.parse().unwrap())
                .predecessor_account_id(CONTRACT.parse().unwrap())
                .block_timestamp(at * 1_000_000_000)
                .build(),
            near_sdk::test_vm_config(),
            near_sdk::RuntimeFeesConfig::test(),
            Default::default(),
            vec![verified(&s("payload_hash"))],
        );
        c.on_payment_verified(
            s("file_id"),
            s("buyer_key"),
            s("payer"),
            s("payment"),
            s("payload_hash"),
            s("caller").parse().unwrap(),
            n("deposit"),
            a["prepaid"].as_bool().unwrap(),
            n("amount"),
            a["block_number"].as_u64().unwrap(),
            a["paid_at"].as_u64(),
        );
    }

    /// `unlock` while sales are open; the stop lands while MPC verifies.
    fn unlock_then_stop(c: &mut Annon, args: UnlockArgs) {
        now(NOW_S);
        c.unlock(args);
        stop(c, &Seller::new(1));
    }

    #[test]
    fn a_stop_during_verification_refuses_a_later_payment_and_refunds_the_deposit() {
        let mut c = listed();
        unlock_then_stop(&mut c, paid_at(NOW_S + 301));
        // The callback runs in a fresh context: its receipts start at 0.
        run_scheduled_callback(&mut c, NOW_S + 10);
        assert!(!c.is_buyer(FILE.into(), PAYER.into()));
        assert_eq!(refunded(0), UNLOCK_DEPOSIT.as_yoctonear());
        assert!(!get_created_receipts()
            .iter()
            .any(|r| r.receiver_id.as_str() == "v1.signer"));
    }

    #[test]
    fn a_stop_during_verification_keeps_a_payment_inside_the_window() {
        let mut c = listed();
        unlock_then_stop(&mut c, paid_at(NOW_S + 300));
        run_scheduled_callback(&mut c, NOW_S + YEAR);
        assert!(c.is_buyer(FILE.into(), PAYER.into()));
    }

    #[test]
    fn a_stop_during_verification_without_a_header_keeps_the_payment_for_a_retry() {
        let mut c = listed();
        unlock_then_stop(&mut c, unlock_args());
        run_scheduled_callback(&mut c, NOW_S + 10);
        assert!(!c.is_buyer(FILE.into(), PAYER.into()));
        assert!(near_sdk::test_utils::get_logs()
            .iter()
            .any(|l| l.contains("send the payment's block header")));
        // The same payment sent again through unlock, now with its header, is recorded.
        let retry = paid_at(NOW_S - 30);
        assert!(!c.is_payment_used(
            format!("0x{}", hex::encode(retry.logs[0].transaction_hash.0)),
            retry.logs[0].log_index
        ));
        now(NOW_S + 20);
        c.unlock(retry);
        run_scheduled_callback(&mut c, NOW_S + 30);
        assert!(c.is_buyer(FILE.into(), PAYER.into()));
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
