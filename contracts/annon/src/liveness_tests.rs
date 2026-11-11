//! Regression tests written before the liveness implementation.
use crate::receive::tests::{deliver, near_purchase, selling};
use crate::state::{IN_FLIGHT, PENDING};
use crate::tests::*;
use crate::*;
use near_sdk::json_types::U128;
use near_sdk::{env, NearToken, PromiseResult};

const BARE: &str = "{\"annon\":2,\"refund\":{\"kind\":\"near\",\"id\":\"buyer.near\"},";

fn keeper() {
    near_sdk::testing_env!(near_sdk::test_utils::VMContextBuilder::new()
        .current_account_id(CONTRACT.parse().unwrap())
        .predecessor_account_id("keeper.near".parse().unwrap())
        .prepaid_gas(near_sdk::Gas::from_tgas(600))
        .build());
}

fn paid(c: &mut Annon, id: u64) {
    keeper();
    c.fund_delivery(id);
    answered(vec![PromiseResult::Successful(b"\"1\"".to_vec())]);
    c.on_funded(id, 1);
    keeper();
    c.pay_slot(id, 0);
    answered(vec![PromiseResult::Successful(vec![])]);
    c.on_paid(id, 0, 1);
}

#[test]
fn open_index_includes_inflight_and_retires_exactly_once() {
    let mut c = selling();
    let start = c.reserve;
    for _ in 0..5 {
        deliver(&mut c, 1, BARE);
    }
    assert_eq!(c.open_delivery_count(), 5);
    keeper();
    c.fund_delivery(4);
    assert_eq!(c.list_open_deliveries(4, 1)[0].fund.state, IN_FLIGHT);
    // First, middle and last swap removals, leaving the in-flight record indexed.
    for id in [0, 2, 1, 3] {
        paid(&mut c, id);
    }
    assert_eq!(c.open_delivery_count(), 1);
    assert_eq!(c.list_open_deliveries(0, 50)[0].id, 4);
    answered(vec![PromiseResult::Successful(b"\"1\"".to_vec())]);
    c.on_funded(4, 1);
    keeper();
    c.pay_slot(4, 0);
    answered(vec![PromiseResult::Successful(vec![])]);
    c.on_paid(4, 0, 1);
    assert_eq!(c.reserve, start, "delivery AND index storage credited once");
    assert_eq!(c.open_delivery_count(), 0);
    c.on_paid(4, 0, 1); // A duplicate callback after retirement must be harmless.
    c.on_funded(4, 1);
    assert_eq!(c.reserve, start);
}

#[test]
fn open_pages_are_capped_and_extreme_offsets_are_empty() {
    let mut c = selling();
    for _ in 0..55 {
        deliver(&mut c, 1, BARE);
    }
    assert_eq!(c.list_open_deliveries(0, u64::MAX).len(), 50);
    assert_eq!(c.list_open_deliveries(50, 50).len(), 5);
    assert!(c.list_open_deliveries(u64::MAX, 50).is_empty());
    assert!(c.list_open_deliveries(0, 0).is_empty());
}

#[test]
fn repeated_sweeps_cover_survivors_after_concurrent_swap_removals() {
    let mut c = selling();
    for _ in 0..12 {
        deliver(&mut c, 1, BARE);
    }
    let mut visited = std::collections::BTreeSet::new();
    // A moving forward scan can skip swapped entries. Restart at zero after a sweep;
    // once removals cease a full sweep visits all survivors. Snapshot scans are stronger.
    for sweep in 0..2 {
        let mut from = 0;
        loop {
            let page = c.list_open_deliveries(from, 2);
            if page.is_empty() {
                break;
            }
            visited.extend(page.iter().map(|d| d.id));
            from += page.len() as u64;
            if sweep == 0 && from == 2 {
                paid(&mut c, 0);
                paid(&mut c, 1);
            }
        }
    }
    assert!((2..12).all(|id| visited.contains(&id)));
}

#[test]
fn settle_separates_bookkeeping_from_dispatch_and_guards_duplicate_keepers() {
    let mut c = selling();
    deliver(&mut c, 12_000, &message(&near_purchase()));
    keeper();
    c.settle(0);
    assert_eq!(calls_to(NEAR_USDC, "ft_transfer_call").len(), 1);
    assert_eq!(calls_to(CONTRACT, "dispatch_delivery").len(), 1);
    let receipts = near_sdk::test_utils::get_created_receipts();
    assert_eq!(receipts.len(), 3);
    let action = |i: usize| {
        let near_sdk::mock::MockAction::FunctionCallWeight {
            receipt_index,
            prepaid_gas,
            gas_weight,
            ..
        } = &receipts[i].actions[0]
        else {
            panic!("expected function call")
        };
        assert_eq!(gas_weight.0, 0);
        (*receipt_index, prepaid_gas.as_tgas())
    };
    assert_eq!(receipts[1].receipt_indices, vec![action(0).0]);
    assert_eq!(receipts[2].receipt_indices, vec![action(1).0]);
    assert_eq!((action(0).1, action(1).1, action(2).1), (100, 15, 450));
    c.settle(0);
    assert_eq!(calls_to(NEAR_USDC, "ft_transfer_call").len(), 1);
    answered(vec![PromiseResult::Successful(b"\"12000\"".to_vec())]);
    c.on_funded(0, 1);
    assert!(calls_to("intents.near", "mt_transfer").is_empty());
    keeper(); // Simulate a dispatcher that never executed: funding is durable.
    c.pay_slot(0, 0);
    c.settle(0); // Already funded: dispatches directly, skipping the in-flight slot.
    assert_eq!(calls_to("intents.near", "mt_transfer").len(), 3);
    c.settle(0);
    assert_eq!(calls_to("intents.near", "mt_transfer").len(), 3);
    let d = c.get_delivery(0).unwrap();
    assert!(d
        .slots
        .iter()
        .all(|s| s.step.state == IN_FLIGHT && s.step.attempt == 1));
    // Arbitrary callback ordering, mixed failure, stale attempt and legacy retry.
    answered(vec![PromiseResult::Failed]);
    c.on_paid(0, 1, 1);
    keeper();
    c.pay_slot(0, 1);
    answered(vec![PromiseResult::Successful(vec![])]);
    c.on_paid(0, 1, 1);
    assert_eq!(c.get_delivery(0).unwrap().slots[1].step.state, IN_FLIGHT);
    c.on_paid(0, 2, 1);
    c.on_paid(0, 0, 1);
    c.on_paid(0, 1, 2);
    assert!(c.get_delivery(0).is_none());
}

#[test]
fn dispatcher_rechecks_funding_and_never_pays_partial_or_uncertain_deposits() {
    let mut c = selling();
    deliver(&mut c, 10_000, &message(&near_purchase()));
    keeper();
    c.settle(0);
    answered(vec![PromiseResult::Successful(b"\"2000\"".to_vec())]);
    c.on_funded(0, 1);
    assert_eq!(events("funding_failed")[0]["remaining"], "8000");
    keeper();
    c.dispatch_delivery(0);
    assert!(calls_to("intents.near", "mt_transfer").is_empty());
    c.settle(0);
    assert_eq!(calls_to(NEAR_USDC, "ft_transfer_call")[0]["amount"], "8000");
    answered(vec![PromiseResult::Failed]);
    c.on_funded(0, 2);
    assert_eq!(events("funding_failed")[0]["remaining"], "8000");
    keeper();
    c.dispatch_delivery(0);
    c.settle(0);
    assert!(calls_to("intents.near", "mt_transfer").is_empty());
    assert!(calls_to(NEAR_USDC, "ft_transfer_call").is_empty());
    assert_eq!(c.get_delivery(0).unwrap().fund.state, IN_FLIGHT);
}

#[test]
fn failure_events_describe_pending_and_unknown_outcomes_without_stale_signals() {
    let mut c = selling();
    deliver(&mut c, 1, BARE);
    keeper();
    c.fund_delivery(0);
    answered(vec![PromiseResult::Successful(b"\"0\"".to_vec())]);
    c.on_funded(0, 1);
    let e = events("funding_failed").pop().unwrap();
    assert_eq!(e["state"], "Pending");
    assert_eq!(e["attempt"], 1);
    assert_eq!(e["remaining"], "1");
    c.on_funded(0, 1);
    assert_eq!(events("funding_failed").len(), 1);
    keeper();
    c.fund_delivery(0);
    answered(vec![PromiseResult::Successful(vec![0; 65])]);
    c.on_funded(0, 2);
    let e = events("funding_failed").pop().unwrap();
    assert_eq!(e["state"], "InFlight");
    assert_eq!(e["reason"], "unreadable_result");
}

#[test]
fn unreadable_successful_payment_is_never_retried_and_emits_unknown_signal() {
    let mut c = selling();
    deliver(&mut c, 1, BARE);
    keeper();
    c.fund_delivery(0);
    answered(vec![PromiseResult::Successful(b"\"1\"".to_vec())]);
    c.on_funded(0, 1);
    keeper();
    c.pay_slot(0, 0);
    answered(vec![PromiseResult::Successful(vec![0; 65])]);
    c.on_paid(0, 0, 1);
    assert_eq!(c.get_delivery(0).unwrap().slots[0].step.state, IN_FLIGHT);
    let e = events("payment_failed").pop().unwrap();
    assert_eq!(e["state"], "InFlight");
    assert_eq!(e["reason"], "unreadable_result");
}

#[test]
fn explicit_payment_failure_emits_retryable_signal() {
    let mut c = selling();
    deliver(&mut c, 1, BARE);
    keeper();
    c.fund_delivery(0);
    answered(vec![PromiseResult::Successful(b"\"1\"".to_vec())]);
    c.on_funded(0, 1);
    keeper();
    c.pay_slot(0, 0);
    answered(vec![PromiseResult::Failed]);
    c.on_paid(0, 0, 1);
    let e = events("payment_failed").pop().unwrap();
    assert_eq!(e["state"], "Pending");
    assert_eq!(e["reason"], "transfer_failed");
    assert_eq!(e["delivery_id"], 0);
    assert_eq!(e["slot"], 0);
    assert_eq!(e["attempt"], 1);
    assert_eq!(c.get_delivery(0).unwrap().slots[0].step.state, PENDING);
}

#[test]
fn maximum_delivery_admission_and_index_charge_are_exact() {
    let mut c = contract();
    let mut a = args_for(near_id(&"s".repeat(64)));
    a.terms.near.recipients = (0..8)
        .map(|i| crate::register::RecipientJson {
            identity: near_id(&format!("{}{i}", "r".repeat(63))),
            bps: 1250,
        })
        .collect();
    // The seller's NEAR identity authorizes registration and publishes the header.
    let hash = a.terms.decode().hash();
    as_caller(&"s".repeat(64), NearToken::from_near(1));
    c.register(a, None);
    c.publish_header(FILE.into(), format!("0x{}", "ab".repeat(32)));
    c.reserve =
        env::storage_byte_cost().as_yoctonear() * u128::from(crate::receive::DELIVERY_BYTES);
    let p = crate::purchase::Purchase {
        terms_hash: hash,
        refund: identity(&near_id(&"x".repeat(64))),
        recovery: identity(&near_id(&"x".repeat(64))),
        ..near_purchase()
    };
    let start = c.reserve;
    as_caller(NEAR_USDC, NearToken::from_yoctonear(0));
    let before = env::storage_usage();
    c.ft_on_transfer("b".repeat(64).parse().unwrap(), U128(12_000), message(&p));
    let used = env::storage_usage() - before;
    assert!(used <= crate::receive::DELIVERY_BYTES, "{used}");
    assert_eq!(
        start - c.reserve,
        u128::from(used) * env::storage_byte_cost().as_yoctonear()
    );
    assert_eq!(c.list_open_deliveries(0, 50)[0].slots.len(), 9);
    println!("STORAGE maximum delivery acceptance={used} bytes");
}

#[test]
fn materialized_refund_charges_index_and_marker_once() {
    let mut c = contract();
    deliver(&mut c, 1, BARE);
    assert_eq!(c.open_delivery_count(), 0);
    let leaf = crate::merkle::Leaf {
        network: "near:mainnet".into(),
        contract: CONTRACT.parse().unwrap(),
        delivery_id: 0,
        refund: identity(&near_id("buyer.near")),
        amount: 1,
    };
    let proof = crate::merkle::tests::proof(&[leaf.hash()], 0)
        .iter()
        .map(|h| format!("0x{}", hex::encode(h)))
        .collect();
    as_caller("keeper.near", NearToken::from_near(1));
    c.storage_deposit(None);
    let balance = c
        .storage_balance_of("keeper.near".parse().unwrap())
        .unwrap()
        .0;
    keeper();
    let before = env::storage_usage();
    c.materialize_refund(
        crate::receive::LeafArgs {
            delivery_id: 0,
            refund: near_id("buyer.near"),
            amount: U128(1),
        },
        0,
        proof,
    );
    let used = env::storage_usage() - before;
    assert_eq!(c.open_delivery_count(), 1);
    assert_eq!(
        c.storage_balance_of("keeper.near".parse().unwrap())
            .unwrap()
            .0,
        balance - u128::from(used) * env::storage_byte_cost().as_yoctonear()
    );
    println!("STORAGE materialized refund with index and marker={used} bytes");
    paid(&mut c, 0);
    assert_eq!(c.open_delivery_count(), 0);
    assert!(c.materialized.contains_key(&0));
}

#[test]
fn quantify_rpc_refund_preimage_storage_without_changing_admission() {
    let _c = contract();
    let mut preimages =
        near_sdk::store::LookupMap::<u64, (u64, crate::identity::Identity, u128)>::new(b"q");
    for (index, refund) in [
        Seller::new(7).id(),
        Sol::new(7).id(),
        near_id("buyer.near"),
        near_id(&"r".repeat(64)),
    ]
    .iter()
    .enumerate()
    {
        let before = env::storage_usage();
        preimages.insert(index as u64, (0, identity(refund), 1));
        preimages.flush();
        let bytes = env::storage_usage() - before;
        println!(
            "STORAGE readable leaf {} id-length={} bytes={bytes} yoctoNEAR={}",
            refund.kind,
            refund.id.len(),
            u128::from(bytes) * env::storage_byte_cost().as_yoctonear()
        );
        assert_eq!(bytes, [94, 106, 88, 142][index]);
    }
}

#[test]
fn dispatcher_handles_zero_and_self_slots_and_a_delayed_duplicate_dispatch() {
    let mut c = selling();
    deliver(&mut c, 12_000, &message(&near_purchase()));
    // Exercise fixed local slots together with an external payment.
    let d = c.deliveries.get_mut(&0).unwrap();
    d.slots[0].amount = 0;
    d.slots[1].to = crate::identity::Identity::Near(CONTRACT.parse().unwrap());
    keeper();
    c.settle(0);
    answered(vec![PromiseResult::Successful(b"\"12000\"".to_vec())]);
    c.on_funded(0, 1);
    keeper();
    c.dispatch_delivery(0);
    assert_eq!(calls_to("intents.near", "mt_transfer").len(), 1);
    let d = c.get_delivery(0).unwrap();
    assert!(d.slots[..2]
        .iter()
        .all(|s| s.step.state == crate::state::DONE));
    c.dispatch_delivery(0);
    assert_eq!(calls_to("intents.near", "mt_transfer").len(), 1);
    answered(vec![PromiseResult::Successful(vec![])]);
    c.on_paid(0, 2, 1);
    keeper();
    c.dispatch_delivery(0);
    c.settle(0);
    assert!(c.get_delivery(0).is_none());
}

#[test]
fn insufficient_settle_gas_is_refused_before_marking_any_step_inflight() {
    let mut c = selling();
    deliver(&mut c, 1, BARE);
    as_caller("keeper.near", NearToken::from_yoctonear(0)); // 300 Tgas
    let refused = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.settle(0)));
    assert!(refused.is_err());
    assert_eq!(c.get_delivery(0).unwrap().fund.state, PENDING);
    assert!(calls_to(NEAR_USDC, "ft_transfer_call").is_empty());
    c.fund_delivery(0);
    answered(vec![PromiseResult::Successful(b"\"1\"".to_vec())]);
    c.on_funded(0, 1);
    as_caller("keeper.near", NearToken::from_yoctonear(0));
    let refused = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.settle(0)));
    assert!(refused.is_err());
    assert_eq!(c.get_delivery(0).unwrap().slots[0].step.state, PENDING);
    assert!(calls_to("intents.near", "mt_transfer").is_empty());
}

#[test]
fn index_storage_is_130_bytes_per_entry_including_swap_removal() {
    let _c = contract();
    let mut index = near_sdk::store::IterableSet::<u64>::new(b"q");
    let start = env::storage_usage();
    for id in 0..5 {
        let before = env::storage_usage();
        index.insert(id);
        index.flush();
        assert_eq!(env::storage_usage() - before, 130);
    }
    for id in [0, 2, 1, 3, 4] {
        let before = env::storage_usage();
        index.remove(&id);
        index.flush();
        assert_eq!(before - env::storage_usage(), 130);
    }
    assert_eq!(env::storage_usage(), start);
}

#[test]
fn funding_after_partial_use_never_accounts_more_than_the_remaining_obligation() {
    let mut c = selling();
    deliver(&mut c, 10_000, &message(&near_purchase()));
    keeper();
    c.settle(0);
    answered(vec![PromiseResult::Successful(b"\"2000\"".to_vec())]);
    c.on_funded(0, 1);
    keeper();
    c.settle(0);
    assert_eq!(calls_to(NEAR_USDC, "ft_transfer_call")[0]["amount"], "8000");
    answered(vec![PromiseResult::Successful(
        format!("\"{}\"", u128::MAX).into_bytes(),
    )]);
    c.on_funded(0, 2);
    let d = c.get_delivery(0).unwrap();
    assert_eq!(d.funded, U128(10_000));
    assert_eq!(d.fund.state, crate::state::DONE);
    keeper();
    c.dispatch_delivery(0);
    let transfers = calls_to("intents.near", "mt_transfer");
    assert_eq!(transfers.len(), 2);
    assert_eq!(transfers[0]["amount"], "9500");
    assert_eq!(transfers[1]["amount"], "500");
}
