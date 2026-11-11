//! Paying the split and the refunds (specs/near-settlement.md §7). Each delivery is first moved
//! into this contract's own NEAR Intents balance (`fund_delivery`), then each slot is credited to
//! its beneficiary's Intents account with `mt_transfer` (`pay_slot`). Anyone may call both; nobody
//! can change an amount or a destination.
//!
//! A step is written as in flight before its promise is created, and only its own callback moves
//! it on. A failed `mt_transfer` moved nothing, so the slot goes back to pending. A deposit whose
//! final result is unreadable may have moved the tokens anyway (NEP-141 runs the receiver and the
//! resolver as separate receipts), so it stays in flight: never paid twice, never redirected; the
//! limit is described in SECURITY.md.
use near_sdk::json_types::U128;
use near_sdk::serde_json::json;
use near_sdk::{env, near, require, Gas, GasWeight, NearToken, PromiseError, PromiseIndex};

use crate::events::emit;
use crate::identity::{Identity, IdentityJson};
use crate::state::{Delivery, Step, DONE, IN_FLIGHT, PENDING};
use crate::{Annon, AnnonExt};

/// `ft_transfer_call` into Intents: the transfer, Intents' `ft_on_transfer` and the resolver.
const DEPOSIT_GAS: Gas = Gas::from_tgas(100);
const MT_TRANSFER_GAS: Gas = Gas::from_tgas(30);
/// Includes final delivery/index removal. Real-bytecode measurements: mainnet_contracts.gas.txt.
const CALLBACK_GAS: Gas = Gas::from_tgas(15);
/// Nine independent 30 + 15 Tgas payment chains (405), plus dispatch execution and margin.
const DISPATCH_GAS: Gas = Gas::from_tgas(450);
/// Deposit (100), bookkeeping (15), dispatch (450), entry execution and margin.
const SETTLE_GAS: Gas = Gas::from_tgas(600);

fn call(to: &near_sdk::AccountId, method: &str, args: String, gas: Gas) -> PromiseIndex {
    let p = env::promise_batch_create(to);
    env::promise_batch_action_function_call_weight(
        p,
        method,
        args.as_bytes(),
        NearToken::from_yoctonear(1),
        gas,
        GasWeight(0),
    );
    p
}

fn then(p: PromiseIndex, method: &str, args: String, gas: Gas) -> PromiseIndex {
    let t = env::promise_batch_then(p, &env::current_account_id());
    env::promise_batch_action_function_call_weight(
        t,
        method,
        args.as_bytes(),
        NearToken::from_yoctonear(0),
        gas,
        GasWeight(0),
    );
    t
}

impl Annon {
    /// Once a delivery is funded and every slot paid, its record goes and the storage it held
    /// returns to the purchase file, or to refund working capital for refund-only deliveries.
    /// The permanent purchase keeps its entitlement and the events keep the history.
    fn retire_delivery(&mut self, delivery_id: u64) {
        let done = self
            .deliveries
            .get(&delivery_id)
            .is_some_and(|d| d.fund.state == DONE && d.slots.iter().all(|s| s.step.state == DONE));
        if !done {
            return;
        }
        self.deliveries.flush();
        self.open_deliveries.flush();
        let before = env::storage_usage();
        let file_id = self
            .deliveries
            .get(&delivery_id)
            .unwrap()
            .purchase
            .map(|p| self.purchases.get(&p).expect("purchase missing").file_id);
        self.deliveries.remove(&delivery_id);
        self.open_deliveries.remove(&delivery_id);
        self.deliveries.flush();
        self.open_deliveries.flush();
        let freed = before.saturating_sub(env::storage_usage());
        let credit = env::storage_byte_cost().as_yoctonear() * u128::from(freed);
        if let Some(id) = file_id {
            let file = self.files.get_mut(&id).expect("file missing");
            file.purchase_storage_balance = file
                .purchase_storage_balance
                .checked_add(credit)
                .expect("file storage overflow");
        } else {
            self.reserve = self
                .reserve
                .checked_add(credit)
                .expect("refund reserve overflow");
        }
        emit(
            "delivery_settled",
            json!({ "delivery_id": delivery_id, "freed_bytes": freed, "storage_credit": U128(credit),
                "storage_destination": file_id.map(|id| crate::evm::hex0x(&id)).unwrap_or_else(|| "receiver_reserve".into()) }),
        );
    }

    /// Returns the bookkeeping receipt, so settle can chain an isolated dispatcher after it.
    fn start_funding(&mut self, delivery_id: u64) -> PromiseIndex {
        let (to, token) = (self.intents.clone(), self.near_usdc.clone());
        let d = self.deliveries.get_mut(&delivery_id).unwrap();
        let amount = d.amount - d.funded;
        d.fund.state = IN_FLIGHT;
        d.fund.attempt += 1;
        let attempt = d.fund.attempt;
        let args = json!({
            "receiver_id": to,
            "amount": U128(amount),
            "msg": env::current_account_id(),
        });
        let p = call(&token, "ft_transfer_call", args.to_string(), DEPOSIT_GAS);
        then(
            p,
            "on_funded",
            json!({ "delivery_id": delivery_id, "attempt": attempt }).to_string(),
            CALLBACK_GAS,
        )
    }
}

#[near]
impl Annon {
    /// Permissionless progress: deposit -> bookkeeping -> isolated dispatcher. Already funded
    /// deliveries dispatch directly. Missing/settled/in-flight deliveries are harmless no-ops.
    /// Attach 600 Tgas (450 suffices when already funded); no deposit. Never resets InFlight.
    pub fn settle(&mut self, delivery_id: u64) {
        let Some(d) = self.deliveries.get(&delivery_id) else {
            return;
        };
        match d.fund.state {
            PENDING => {
                require!(env::prepaid_gas() >= SETTLE_GAS, "settle needs 600 Tgas");
                let bookkeeping = self.start_funding(delivery_id);
                then(
                    bookkeeping,
                    "dispatch_delivery",
                    json!({ "delivery_id": delivery_id }).to_string(),
                    DISPATCH_GAS,
                );
            }
            DONE => {
                require!(
                    env::prepaid_gas() >= DISPATCH_GAS,
                    "settle needs 450 Tgas when funded"
                );
                self.dispatch_delivery(delivery_id);
            }
            _ => {}
        }
    }

    /// Re-read durable funding, ignoring the preceding receipt's result. If this receipt fails,
    /// the funding bookkeeping stays committed and pay_slot/settle remain available.
    #[private]
    pub fn dispatch_delivery(&mut self, delivery_id: u64) {
        let Some(d) = self.deliveries.get(&delivery_id) else {
            return;
        };
        if d.fund.state != DONE {
            return;
        }
        let pending: Vec<u32> = d
            .slots
            .iter()
            .enumerate()
            .filter_map(|(i, s)| (s.step.state == PENDING).then_some(i as u32))
            .collect();
        for slot in pending {
            self.pay_slot(delivery_id, slot);
        }
    }

    /// Moves what is left of a delivery's USDC into this contract's Intents balance.
    pub fn fund_delivery(&mut self, delivery_id: u64) {
        let d = self
            .deliveries
            .get(&delivery_id)
            .unwrap_or_else(|| env::panic_str("unknown delivery"));
        require!(
            d.fund.state == PENDING,
            "delivery is not waiting to be funded"
        );
        self.start_funding(delivery_id);
    }

    /// The result of `fund_delivery`: NEP-141's final used amount, counted exactly.
    #[private]
    pub fn on_funded(&mut self, delivery_id: u64, attempt: u32) {
        let used = env::promise_result_checked(0, 64)
            .ok()
            .and_then(|r| near_sdk::serde_json::from_slice::<U128>(&r).ok());
        let Some(d) = self.deliveries.get_mut(&delivery_id) else {
            return;
        };
        if d.fund.state != IN_FLIGHT || d.fund.attempt != attempt {
            return;
        }
        let Some(U128(used)) = used else {
            emit(
                "funding_failed",
                json!({ "delivery_id": delivery_id, "attempt": attempt,
                "state": "InFlight", "reason": "unreadable_result", "remaining": U128(d.amount - d.funded) }),
            );
            return;
        };
        d.funded += used.min(d.amount - d.funded);
        d.fund.state = if d.funded == d.amount { DONE } else { PENDING };
        emit(
            "funded",
            json!({ "delivery_id": delivery_id, "attempt": attempt, "used": U128(used), "funded": U128(d.funded) }),
        );
        if d.fund.state == PENDING {
            emit(
                "funding_failed",
                json!({ "delivery_id": delivery_id, "attempt": attempt,
                "state": "Pending", "reason": "incomplete_deposit", "used": U128(used),
                "remaining": U128(d.amount - d.funded) }),
            );
        }
    }

    /// Credits one slot of a funded delivery to its beneficiary's Intents account.
    pub fn pay_slot(&mut self, delivery_id: u64, slot: u32) {
        let (intents, token) = (self.intents.clone(), self.near_usdc.clone());
        let me = env::current_account_id();
        let d = self
            .deliveries
            .get_mut(&delivery_id)
            .unwrap_or_else(|| env::panic_str("unknown delivery"));
        require!(d.fund.state == DONE, "delivery is not funded yet");
        let s = d
            .slots
            .get_mut(slot as usize)
            .unwrap_or_else(|| env::panic_str("unknown slot"));
        require!(s.step.state == PENDING, "slot is not waiting to be paid");
        // Nothing to move: a zero share, or a share for this contract itself.
        if s.amount == 0 || s.to == Identity::Near(me) {
            s.step.state = DONE;
            emit(
                "slot_paid",
                json!({ "delivery_id": delivery_id, "slot": slot, "local": true }),
            );
            self.retire_delivery(delivery_id);
            return;
        }
        s.step.state = IN_FLIGHT;
        s.step.attempt += 1;
        let attempt = s.step.attempt;
        let args = json!({
            "receiver_id": s.to.intents_id(),
            "token_id": format!("nep141:{token}"),
            "amount": U128(s.amount),
            "approval": null,
            "memo": format!("annon:{delivery_id}:{slot}:{attempt}"),
        });
        let p = call(&intents, "mt_transfer", args.to_string(), MT_TRANSFER_GAS);
        then(
            p,
            "on_paid",
            json!({ "delivery_id": delivery_id, "slot": slot, "attempt": attempt }).to_string(),
            CALLBACK_GAS,
        );
    }

    /// The result of `pay_slot`. `mt_transfer` is one synchronous step: a failure moved nothing.
    #[private]
    pub fn on_paid(&mut self, delivery_id: u64, slot: u32, attempt: u32) {
        let result = env::promise_result_checked(0, 64);
        let Some(d) = self.deliveries.get_mut(&delivery_id) else {
            return;
        };
        let Some(s) = d.slots.get_mut(slot as usize) else {
            return;
        };
        if s.step.state != IN_FLIGHT || s.step.attempt != attempt {
            return;
        }
        let ok = match result {
            Ok(_) => true,
            Err(PromiseError::Failed) => false,
            Err(_) => {
                emit(
                    "payment_failed",
                    json!({ "delivery_id": delivery_id, "slot": slot,
                    "attempt": attempt, "state": "InFlight", "reason": "unreadable_result" }),
                );
                return;
            }
        };
        s.step.state = if ok { DONE } else { PENDING };
        if ok {
            emit(
                "slot_paid",
                json!({ "delivery_id": delivery_id, "slot": slot, "attempt": attempt, "to": s.to.text(), "amount": U128(s.amount) }),
            );
            self.retire_delivery(delivery_id);
        } else {
            emit(
                "payment_failed",
                json!({ "delivery_id": delivery_id, "slot": slot,
                "attempt": attempt, "state": "Pending", "reason": "transfer_failed" }),
            );
        }
    }
}

#[near(serializers = [json])]
pub struct SlotView {
    pub to: IdentityJson,
    pub amount: U128,
    pub step: Step,
}

#[near(serializers = [json])]
pub struct DeliveryView {
    pub id: u64,
    pub amount: U128,
    pub sender: near_sdk::AccountId,
    pub purchase: Option<String>,
    /// 0 accepted, else the refund reason (`receive::reason`).
    pub reason: u8,
    pub fund: Step,
    pub funded: U128,
    pub slots: Vec<SlotView>,
}

fn view(id: u64, d: &Delivery) -> DeliveryView {
    DeliveryView {
        id,
        amount: U128(d.amount),
        sender: d.sender.clone(),
        purchase: d.purchase.map(|p| crate::evm::hex0x(&p)),
        reason: d.reason,
        fund: d.fund,
        funded: U128(d.funded),
        slots: d
            .slots
            .iter()
            .map(|s| SlotView {
                to: IdentityJson::from(&s.to),
                amount: U128(s.amount),
                step: s.step,
            })
            .collect(),
    }
}

#[near]
impl Annon {
    pub fn get_delivery(&self, delivery_id: u64) -> Option<DeliveryView> {
        self.deliveries
            .get(&delivery_id)
            .map(|d| view(delivery_id, d))
    }

    /// How many delivery ids exist (`0 .. count`). Some may have no record: a refund leaf keeps
    /// its id until someone materializes it, so a keeper scans the whole range.
    pub fn delivery_count(&self) -> u64 {
        self.next_delivery
    }

    /// Recorded deliveries with ids in `from .. from + limit` (at most 50); the keeper's work list.
    pub fn list_deliveries(&self, from: u64, limit: u64) -> Vec<DeliveryView> {
        (from..self.next_delivery.min(from.saturating_add(limit.min(50))))
            .filter_map(|i| self.deliveries.get(&i).map(|d| view(i, d)))
            .collect()
    }

    /// All stored deliveries, including InFlight, in unordered index positions; at most 50.
    /// Removal swaps the last entry into the removed position. Pin EVERY page and the count of
    /// a full sweep to ONE finalized block via RPC block_id: concurrent removals then cannot
    /// skip a delivery that stays open. Advance by the number of returned entries. Across moving
    /// blocks, a single forward sweep can skip entries; repeat from zero, with coverage only
    /// guaranteed once mutations cease. New records after a snapshot belong to the next sweep.
    pub fn list_open_deliveries(&self, from: u64, limit: u64) -> Vec<DeliveryView> {
        if from >= u64::from(self.open_deliveries.len()) {
            return vec![];
        }
        self.open_deliveries
            .iter()
            .skip(from as usize)
            .take(limit.min(50) as usize)
            .map(|id| view(*id, self.deliveries.get(id).unwrap()))
            .collect()
    }

    pub fn open_delivery_count(&self) -> u64 {
        u64::from(self.open_deliveries.len())
    }

    /// The refund accumulator: its root and number of leaves.
    pub fn refund_root(&self) -> near_sdk::serde_json::Value {
        json!({ "root": crate::evm::hex0x(&self.refunds.root), "count": self.refunds.count })
    }
}

#[cfg(test)]
mod tests {
    use crate::receive::tests::{deliver, near_purchase, selling};
    use crate::state::{DONE, IN_FLIGHT, PENDING};
    use crate::tests::*;
    use crate::*;
    use near_sdk::json_types::U128;
    use near_sdk::{NearToken, PromiseResult};

    fn sold() -> Annon {
        let mut c = selling();
        deliver(&mut c, 12_000, &message(&near_purchase())); // 10 000 split + 2 000 back
        as_caller("keeper.near", NearToken::from_yoctonear(0));
        c
    }

    fn funded(c: &mut Annon) {
        c.fund_delivery(0);
        answered(vec![PromiseResult::Successful(b"\"12000\"".to_vec())]);
        c.on_funded(0, 1);
        as_caller("keeper.near", NearToken::from_yoctonear(0));
    }

    #[test]
    fn funding_moves_the_whole_delivery_into_our_intents_balance() {
        let mut c = sold();
        c.fund_delivery(0);
        let call = calls_to(NEAR_USDC, "ft_transfer_call").pop().unwrap();
        assert_eq!(
            call,
            near_sdk::serde_json::json!({ "receiver_id": "intents.near", "amount": "12000", "msg": CONTRACT })
        );
        assert_eq!(c.get_delivery(0).unwrap().fund.state, IN_FLIGHT);
        assert_eq!(
            calls_to(CONTRACT, "on_funded").pop().unwrap(),
            near_sdk::serde_json::json!({ "delivery_id": 0, "attempt": 1 })
        );
    }

    #[test]
    #[should_panic(expected = "delivery is not waiting to be funded")]
    fn a_delivery_in_flight_is_not_funded_twice() {
        let mut c = sold();
        c.fund_delivery(0);
        c.fund_delivery(0);
    }

    #[test]
    fn a_confirmed_deposit_is_counted_exactly() {
        let mut c = sold();
        funded(&mut c);
        let d = c.get_delivery(0).unwrap();
        assert_eq!((d.fund.state, d.funded), (DONE, U128(12_000)));
    }

    #[test]
    fn a_refused_deposit_can_be_retried_for_what_is_left() {
        let mut c = sold();
        c.fund_delivery(0);
        answered(vec![PromiseResult::Successful(b"\"2000\"".to_vec())]);
        c.on_funded(0, 1);
        let d = c.get_delivery(0).unwrap();
        assert_eq!((d.fund.state, d.funded), (PENDING, U128(2_000)));
        as_caller("keeper.near", NearToken::from_yoctonear(0));
        c.fund_delivery(0);
        assert_eq!(
            calls_to(NEAR_USDC, "ft_transfer_call").pop().unwrap()["amount"],
            "10000"
        );
        assert_eq!(c.get_delivery(0).unwrap().fund.attempt, 2);
    }

    #[test]
    fn an_unreadable_deposit_result_stays_in_flight_for_good() {
        let mut c = sold();
        c.fund_delivery(0);
        answered(vec![PromiseResult::Failed]);
        c.on_funded(0, 1);
        assert_eq!(c.get_delivery(0).unwrap().fund.state, IN_FLIGHT);
        as_caller("keeper.near", NearToken::from_yoctonear(0));
        let again = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.fund_delivery(0)));
        assert!(again.is_err(), "an uncertain deposit was sent again");
    }

    #[test]
    fn a_stale_callback_changes_nothing() {
        let mut c = sold();
        c.fund_delivery(0);
        answered(vec![PromiseResult::Successful(b"\"12000\"".to_vec())]);
        c.on_funded(0, 7);
        assert_eq!(c.get_delivery(0).unwrap().fund.state, IN_FLIGHT);
    }

    #[test]
    #[should_panic(expected = "delivery is not funded yet")]
    fn nothing_is_paid_before_funding() {
        let mut c = sold();
        c.pay_slot(0, 0);
    }

    #[test]
    fn each_slot_is_credited_to_its_intents_account() {
        let mut c = sold();
        funded(&mut c);
        for slot in 0..3 {
            c.pay_slot(0, slot);
        }
        let calls = calls_to("intents.near", "mt_transfer");
        let token = format!("nep141:{NEAR_USDC}");
        let want = [(PAY_TO, "9500"), (PLATFORM, "500"), (PAYER, "2000")];
        assert_eq!(calls.len(), 3);
        for (i, (call, (to, amount))) in calls.iter().zip(want).enumerate() {
            assert_eq!(call["receiver_id"], to);
            assert_eq!(call["amount"], amount);
            assert_eq!(call["token_id"], token.as_str());
            assert_eq!(call["memo"], format!("annon:0:{i}:1"));
        }
    }

    #[test]
    fn a_paid_slot_is_done_and_never_paid_again() {
        let mut c = sold();
        funded(&mut c);
        c.pay_slot(0, 0);
        answered(vec![PromiseResult::Successful(vec![])]);
        c.on_paid(0, 0, 1);
        assert_eq!(c.get_delivery(0).unwrap().slots[0].step.state, DONE);
        assert_eq!(events("slot_paid")[0]["to"], format!("EVM {PAY_TO}"));
        as_caller("keeper.near", NearToken::from_yoctonear(0));
        let again = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.pay_slot(0, 0)));
        assert!(again.is_err());
    }

    #[test]
    fn a_failed_transfer_is_pending_again() {
        let mut c = sold();
        funded(&mut c);
        c.pay_slot(0, 1);
        answered(vec![PromiseResult::Failed]);
        c.on_paid(0, 1, 1);
        assert_eq!(c.get_delivery(0).unwrap().slots[1].step.state, PENDING);
        as_caller("keeper.near", NearToken::from_yoctonear(0));
        c.pay_slot(0, 1);
        assert_eq!(
            calls_to("intents.near", "mt_transfer").pop().unwrap()["memo"],
            "annon:0:1:2"
        );
    }

    #[test]
    fn a_transfer_whose_callback_never_ran_stays_in_flight() {
        let mut c = sold();
        funded(&mut c);
        c.pay_slot(0, 0);
        as_caller("keeper.near", NearToken::from_yoctonear(0));
        let again = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.pay_slot(0, 0)));
        assert!(again.is_err(), "an in-flight slot was paid again");
        assert_eq!(c.get_delivery(0).unwrap().slots[0].step.state, IN_FLIGHT);
    }

    #[test]
    fn a_share_for_the_contract_itself_completes_without_a_transfer() {
        let mut c = contract();
        let seller = Seller::new(1);
        let mut a = args(&seller);
        a.terms.near.recipients[1].identity = near_id(CONTRACT);
        let auth = signed(&c, &seller, &a);
        let hash = a.terms.decode().hash();
        c.register(a, auth);
        as_caller("anyone.near", NearToken::from_near(1));
        c.fund_receiver_reserve();
        as_caller("anyone.near", NearToken::from_near(1));
        c.fund_file_storage(FILE.into(), None);
        let p = crate::purchase::Purchase {
            terms_hash: hash,
            ..near_purchase()
        };
        deliver(&mut c, 10_000, &message(&p));
        as_caller("keeper.near", NearToken::from_yoctonear(0));
        c.fund_delivery(0);
        answered(vec![PromiseResult::Successful(b"\"10000\"".to_vec())]);
        c.on_funded(0, 1);
        as_caller("keeper.near", NearToken::from_yoctonear(0));
        c.pay_slot(0, 1);
        assert_eq!(c.get_delivery(0).unwrap().slots[1].step.state, DONE);
        assert!(calls_to("intents.near", "mt_transfer").is_empty());
    }

    #[test]
    fn the_keeper_lists_deliveries() {
        let mut c = selling();
        for _ in 0..3 {
            deliver(
                &mut c,
                1,
                "{\"annon\":2,\"refund\":{\"kind\":\"near\",\"id\":\"buyer.near\"},",
            );
        }
        let ids: Vec<u64> = c.list_deliveries(1, 10).iter().map(|d| d.id).collect();
        assert_eq!(ids, vec![1, 2]);
        assert_eq!(c.delivery_count(), 3);
        assert_eq!(c.get_delivery(2).unwrap().slots[0].to.id, "buyer.near");
    }
}
