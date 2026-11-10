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
use near_sdk::{env, near, require, Gas, GasWeight, NearToken, PromiseIndex};

use crate::events::emit;
use crate::identity::{Identity, IdentityJson};
use crate::state::{Delivery, Step, DONE, IN_FLIGHT, PENDING};
use crate::{Annon, AnnonExt};

/// `ft_transfer_call` into Intents: the transfer, Intents' `ft_on_transfer` and the resolver.
const DEPOSIT_GAS: Gas = Gas::from_tgas(100);
const MT_TRANSFER_GAS: Gas = Gas::from_tgas(30);
/// Callbacks only rewrite fixed-width fields, so a fixed allowance is enough.
const CALLBACK_GAS: Gas = Gas::from_tgas(15);

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

fn then(p: PromiseIndex, method: &str, args: String) {
    let t = env::promise_batch_then(p, &env::current_account_id());
    env::promise_batch_action_function_call_weight(
        t,
        method,
        args.as_bytes(),
        NearToken::from_yoctonear(0),
        CALLBACK_GAS,
        GasWeight(0),
    );
}

#[near]
impl Annon {
    /// Moves what is left of a delivery's USDC into this contract's Intents balance.
    pub fn fund_delivery(&mut self, delivery_id: u64) {
        let (to, token) = (self.intents.clone(), self.near_usdc.clone());
        let d = self
            .deliveries
            .get_mut(&delivery_id)
            .unwrap_or_else(|| env::panic_str("unknown delivery"));
        require!(
            d.fund.state == PENDING,
            "delivery is not waiting to be funded"
        );
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
        );
    }

    /// The result of `fund_delivery`: NEP-141's final used amount, counted exactly.
    #[private]
    pub fn on_funded(&mut self, delivery_id: u64, attempt: u32) {
        let used = env::promise_result_checked(0, 64)
            .ok()
            .and_then(|r| near_sdk::serde_json::from_slice::<U128>(&r).ok());
        let d = self.deliveries.get_mut(&delivery_id).unwrap();
        if d.fund.state != IN_FLIGHT || d.fund.attempt != attempt {
            return;
        }
        let Some(U128(used)) = used else {
            env::log_str("deposit outcome unknown; the delivery stays in flight");
            return;
        };
        d.funded += used.min(d.amount - d.funded);
        d.fund.state = if d.funded == d.amount { DONE } else { PENDING };
        emit(
            "funded",
            json!({ "delivery_id": delivery_id, "attempt": attempt, "used": U128(used), "funded": U128(d.funded) }),
        );
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
        );
    }

    /// The result of `pay_slot`. `mt_transfer` is one synchronous step: a failure moved nothing.
    #[private]
    pub fn on_paid(&mut self, delivery_id: u64, slot: u32, attempt: u32) {
        let ok = env::promise_result_checked(0, 64).is_ok();
        let d = self.deliveries.get_mut(&delivery_id).unwrap();
        let s = &mut d.slots[slot as usize];
        if s.step.state != IN_FLIGHT || s.step.attempt != attempt {
            return;
        }
        s.step.state = if ok { DONE } else { PENDING };
        if ok {
            emit(
                "slot_paid",
                json!({ "delivery_id": delivery_id, "slot": slot, "attempt": attempt, "to": s.to.text(), "amount": U128(s.amount) }),
            );
        } else {
            env::log_str("mt_transfer failed; the slot is pending again");
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
