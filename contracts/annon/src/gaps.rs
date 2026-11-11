//! Tests that pin checks no other test noticed when they were removed (mutation testing, 11 Nov),
//! plus the fixes from the contract audit: settled deliveries, recent refund roots, a full refund
//! tree, the deposit of an idempotent reopen, seller one-time keys.
use crate::identity::IdentityJson;
use crate::keys::ReopenArgs;
use crate::purchase::Purchase;
use crate::receive::tests::{deliver, near_purchase, selling};
use crate::register::SellerArgs;
use crate::tests::*;
use crate::unlock::UNLOCK_DEPOSIT;
use crate::*;
use near_sdk::json_types::U128;
use near_sdk::test_utils::get_created_receipts;
use near_sdk::{env, NearToken};

fn key(k: &str) -> [u8; 48] {
    hex::decode(&k[2..]).unwrap().try_into().unwrap()
}

fn buy(c: &mut Annon, recovery: IdentityJson, buyer_key: &str) -> String {
    let p = Purchase {
        buyer_key: key(buyer_key),
        ..purchase(0, recovery)
    };
    assert_eq!(deliver(c, 10_000, &message(&p)), 0);
    format!("0x{}", hex::encode(p.id()))
}

fn reopen_args(id: &str, k: &str) -> ReopenArgs {
    ReopenArgs {
        purchase_id: id.into(),
        fresh_key: k.into(),
        nonce: format!("0x{}", "77".repeat(32)),
        deadline: NOW_S + 600,
    }
}

fn reopen(c: &mut Annon, who: &Seller, id: &str, k: &str, deposit: NearToken) {
    as_caller(RELAYER, deposit);
    let r = reopen_args(id, k);
    let auth = who.auth(&c.reopen_text(r.clone()));
    c.reopen(r, auth);
}

/// NEAR sent to `who` since `before` receipts.
fn sent_to(who: &str, before: usize) -> u128 {
    get_created_receipts()[before..]
        .iter()
        .filter(|r| r.receiver_id.as_str() == who)
        .flat_map(|r| r.actions.clone())
        .map(|a| match a {
            near_sdk::mock::MockAction::Transfer { deposit, .. } => deposit.as_yoctonear(),
            _ => 0,
        })
        .sum()
}

// keys.rs:116
#[test]
#[should_panic(expected = "file taken down")]
fn reopen_is_refused_while_the_file_is_taken_down() {
    let mut c = selling();
    let id = buy(&mut c, Seller::new(7).id(), G1);
    as_caller(MODERATOR, NearToken::from_yoctonear(1));
    c.takedown(FILE.into(), TakedownReason::IllegalContent);
    reopen(
        &mut c,
        &Seller::new(7),
        &id,
        G1X2,
        NearToken::from_millinear(10),
    );
}

// keys.rs:69 grant_entry, keys.rs:76 key_marker
#[test]
fn grants_of_two_purchases_stay_apart() {
    let mut c = selling();
    let a = buy(&mut c, Seller::new(7).id(), G1);
    let b = buy(&mut c, Seller::new(8).id(), G1X2);
    reopen(
        &mut c,
        &Seller::new(7),
        &a,
        G1X2,
        NearToken::from_millinear(10),
    );
    reopen(
        &mut c,
        &Seller::new(8),
        &b,
        G1,
        NearToken::from_millinear(10),
    );
    assert_eq!(c.get_purchase(b.clone()).unwrap().grants, 2);
    assert_eq!(c.get_grant(a, 1).unwrap().buyer_key, G1X2);
    assert_eq!(c.get_grant(b, 1).unwrap().buyer_key, G1);
}

// keys.rs:132 (delete, and - -> /)
#[test]
fn reopen_charges_the_grant_storage() {
    let mut c = selling();
    let id = buy(&mut c, Seller::new(7).id(), G1);
    let before = get_created_receipts().len();
    reopen(
        &mut c,
        &Seller::new(7),
        &id,
        G1X2,
        NearToken::from_millinear(10),
    );
    let back = sent_to(RELAYER, before);
    let kept = NearToken::from_millinear(10).as_yoctonear() - back;
    assert!(back > 0, "excess not refunded");
    assert!(
        kept >= 100 * env::storage_byte_cost().as_yoctonear(),
        "kept {kept}"
    );
}

// storage.rs:92, register.rs:212 (- -> /)
#[test]
fn register_refunds_the_excess_and_keeps_the_cost() {
    let mut c = contract();
    let seller = Seller::new(1);
    let a = args(&seller);
    let auth = signed(&c, &seller, &a);
    context(NearToken::from_near(1));
    let before = get_created_receipts().len();
    c.register(a, auth);
    let back = sent_to(RELAYER, before);
    let kept = NearToken::from_near(1).as_yoctonear() - back;
    assert!(back > 0, "excess not refunded");
    assert!(
        kept >= 100 * env::storage_byte_cost().as_yoctonear(),
        "kept {kept}"
    );
}

// unlock.rs:291
#[test]
fn a_second_verified_payment_for_a_recorded_purchase_is_not_recorded() {
    let mut c = listed();
    mpc_answered(verified(&payload_hash(&x402_logs())));
    callback(&mut c);
    mpc_answered(verified(&payload_hash(&x402_logs())));
    let p = base_purchase();
    c.on_payment_verified(
        format!("0x{}", hex::encode(p.id())),
        FILE.into(),
        format!("0x{}", hex::encode(p.terms_hash)),
        G1X2.into(),
        Seller::new(7).id(),
        PAYER.into(),
        format!("0x{}{}", "dd".repeat(32), "0000000000000007"),
        payload_hash(&x402_logs()),
        RELAYER.parse().unwrap(),
        U128(UNLOCK_DEPOSIT.as_yoctonear()),
        false,
        U128(10_000),
        0x3000000,
        None,
    );
    assert!(!c.is_payment_used(format!("0x{}", "dd".repeat(32)), 7));
    assert_eq!(
        c.get_purchase(format!("0x{}", hex::encode(p.id())))
            .unwrap()
            .buyer_key,
        G1
    );
}

// unlock.rs:302 (- -> /)
#[test]
fn a_verified_payment_keeps_its_storage_cost() {
    let mut c = listed();
    mpc_answered(verified(&payload_hash(&x402_logs())));
    let before = get_created_receipts().len();
    callback(&mut c);
    let kept = UNLOCK_DEPOSIT.as_yoctonear() - refunded(before);
    assert!(
        kept >= 100 * env::storage_byte_cost().as_yoctonear(),
        "kept {kept}"
    );
}

// register.rs:268
#[test]
#[should_panic(expected = "signature expired")]
fn an_expired_seller_reopen_is_refused() {
    let mut c = contract();
    let seller = Seller::new(1);
    registered(&mut c, &seller);
    let r = SellerArgs {
        file_id: FILE.into(),
        key: Some(G1X2.into()),
        deadline: NOW_S - 1,
    };
    let auth = seller.auth(&c.reopen_seller_text(r.clone()));
    c.reopen_seller(r, auth);
}

// receive.rs:291 (delete, and - -> /)
#[test]
#[should_panic(expected = "for storage, or call storage_deposit first")]
fn materialize_refund_needs_a_deposit() {
    let mut c = contract();
    registered(&mut c, &Seller::new(1));
    assert_eq!(deliver(&mut c, 10_000, &message(&near_purchase())), 0);
    let leaf = crate::merkle::Leaf {
        network: "near:mainnet".into(),
        contract: CONTRACT.parse().unwrap(),
        delivery_id: 0,
        refund: identity(&Seller::new(7).id()),
        amount: 10_000,
    };
    let proof: Vec<String> = crate::merkle::tests::proof(&[leaf.hash()], 0)
        .iter()
        .map(|h| format!("0x{}", hex::encode(h)))
        .collect();
    as_caller("keeper.near", NearToken::from_yoctonear(0));
    c.materialize_refund(
        crate::receive::LeafArgs {
            delivery_id: 0,
            refund: Seller::new(7).id(),
            amount: U128(10_000),
        },
        0,
        proof,
    );
}

// receive.rs:131 (* -> +, * -> /)
#[test]
fn a_reserve_just_below_4096_bytes_makes_a_leaf() {
    let mut c = contract();
    registered(&mut c, &Seller::new(1));
    as_caller(
        "anyone.near",
        NearToken::from_yoctonear(env::storage_byte_cost().as_yoctonear() * 4096 - 1),
    );
    c.fund_receiver_reserve();
    deliver(&mut c, 10_000, &message(&near_purchase()));
    assert!(
        c.get_delivery(0).is_none(),
        "recorded without a full reserve"
    );
}

// receive.rs:227 (* -> +, * -> /)
#[test]
fn a_delivery_debits_whole_bytes_from_the_reserve() {
    let mut c = selling();
    let before = c.reserve;
    deliver(&mut c, 10_000, &message(&near_purchase()));
    let used = before - c.reserve;
    let byte = env::storage_byte_cost().as_yoctonear();
    assert!(used.is_multiple_of(byte) && used / byte >= 100, "{used}");
}

// terms.rs:100 (* -> /)
#[test]
fn shares_are_exact_for_a_price_that_is_not_a_multiple_of_10000() {
    let _c = contract();
    let mut t = args(&Seller::new(1)).terms.decode();
    t.near.price = 19_999;
    let s = t.shares();
    let bps: Vec<u128> = t
        .near
        .recipients
        .iter()
        .map(|(_, b)| u128::from(*b))
        .collect();
    for (i, b) in bps.iter().enumerate() {
        if i != usize::from(t.near.remainder) {
            assert_eq!(s[i], 19_999 * b / 10_000, "share {i}");
        }
    }
}

// terms.rs:60
#[test]
fn a_zero_base_price_is_refused() {
    let _c = contract();
    let mut t = args(&Seller::new(1)).terms.decode();
    t.base.as_mut().unwrap().price = 0;
    assert_eq!(
        t.problem("near:mainnet", &NEAR_USDC.parse().unwrap()),
        Some("price must be above 0")
    );
}

// moderation.rs:143/145
#[test]
fn get_file_shows_every_takedown_reason() {
    let mut c = listed();
    for r in [
        TakedownReason::IllegalContent,
        TakedownReason::CourtOrder,
        TakedownReason::RightsHolderNotice,
    ] {
        as_caller(MODERATOR, NearToken::from_yoctonear(1));
        c.takedown(FILE.into(), r.clone());
        assert_eq!(c.get_file(FILE.into()).unwrap().taken_down, Some(r));
    }
}

// payout.rs:150
#[test]
fn a_stale_on_paid_changes_nothing() {
    let mut c = selling();
    deliver(&mut c, 10_000, &message(&near_purchase()));
    c.deliveries.get_mut(&0).unwrap().fund.state = crate::state::DONE;
    c.pay_slot(0, 0);
    answered(vec![near_sdk::PromiseResult::Successful(vec![])]);
    c.on_paid(0, 0, 7);
    assert_eq!(
        c.get_delivery(0).unwrap().slots[0].step.state,
        crate::state::IN_FLIGHT
    );
}

// unlock.rs:97
#[test]
#[should_panic(expected = "payment already used")]
fn unlock_refuses_a_used_payment_before_asking_mpc() {
    let mut c = listed();
    mpc_answered(verified(&payload_hash(&x402_logs())));
    callback(&mut c); // records payment (0xcc.., 7) for base_purchase()
    context(UNLOCK_DEPOSIT);
    let other = purchase(1, Seller::new(8).id());
    c.unlock(crate::unlock::UnlockArgs {
        purchase: message(&other),
        logs: logs_with_nonce(&nonce_of(&other)), // same tx and log index
        header: None,
    });
}

// receive.rs:291 (- -> /)
#[test]
fn materialize_refund_keeps_its_storage_cost() {
    let mut c = contract();
    registered(&mut c, &Seller::new(1));
    assert_eq!(deliver(&mut c, 10_000, &message(&near_purchase())), 0);
    let leaf = crate::merkle::Leaf {
        network: "near:mainnet".into(),
        contract: CONTRACT.parse().unwrap(),
        delivery_id: 0,
        refund: identity(&Seller::new(7).id()),
        amount: 10_000,
    };
    let proof: Vec<String> = crate::merkle::tests::proof(&[leaf.hash()], 0)
        .iter()
        .map(|h| format!("0x{}", hex::encode(h)))
        .collect();
    as_caller("keeper.near", NearToken::from_millinear(50));
    let before = get_created_receipts().len();
    c.materialize_refund(
        crate::receive::LeafArgs {
            delivery_id: 0,
            refund: Seller::new(7).id(),
            amount: U128(10_000),
        },
        0,
        proof,
    );
    let kept = NearToken::from_millinear(50).as_yoctonear() - sent_to("keeper.near", before);
    assert!(
        kept >= 100 * env::storage_byte_cost().as_yoctonear(),
        "kept {kept}"
    );
}

fn leaf_of(delivery_id: u64, amount: u128) -> crate::merkle::Leaf {
    crate::merkle::Leaf {
        network: "near:mainnet".into(),
        contract: CONTRACT.parse().unwrap(),
        delivery_id,
        refund: identity(&Seller::new(7).id()),
        amount,
    }
}

fn hexes(p: Vec<[u8; 32]>) -> Vec<String> {
    p.iter().map(|h| format!("0x{}", hex::encode(h))).collect()
}

/// Funds delivery `id` and pays all its slots, callbacks included.
fn pay_out(c: &mut Annon, id: u64) {
    as_caller("keeper.near", NearToken::from_yoctonear(0));
    c.fund_delivery(id);
    let amount = c.get_delivery(id).unwrap().amount.0;
    answered(vec![near_sdk::PromiseResult::Successful(
        format!("\"{amount}\"").into_bytes(),
    )]);
    c.on_funded(id, 1);
    let slots = c.get_delivery(id).unwrap().slots.len() as u32;
    for slot in 0..slots {
        as_caller("keeper.near", NearToken::from_yoctonear(0));
        c.pay_slot(id, slot);
        answered(vec![near_sdk::PromiseResult::Successful(vec![])]);
        c.on_paid(id, slot, 1);
    }
}

#[test]
fn a_paid_out_refund_frees_its_storage_back_to_the_reserve() {
    let mut c = selling();
    let start = c.reserve;
    let bare = format!("{{\"annon\":2,\"refund\":{{\"kind\":\"evm\",\"id\":\"{PAYER}\"}},");
    deliver(&mut c, 1, &bare);
    assert!(c.reserve < start);
    pay_out(&mut c, 0);
    assert!(c.get_delivery(0).is_none(), "settled delivery kept");
    assert_eq!(c.reserve, start, "reserve not restored");
    assert_eq!(c.delivery_count(), 1);
}

#[test]
fn a_flood_of_dust_refunds_does_not_use_up_the_reserve_once_paid() {
    let mut c = selling();
    let start = c.reserve;
    let bare = "{\"annon\":2,\"refund\":{\"kind\":\"near\",\"id\":\"attacker.near\"},".to_string();
    for i in 0..30 {
        deliver(&mut c, 1, &bare);
        pay_out(&mut c, i);
    }
    assert_eq!(c.reserve, start);
    deliver(&mut c, 10_000, &message(&near_purchase()));
    assert!(
        c.get_delivery(30).is_some(),
        "a real purchase found no reserve"
    );
}

#[test]
fn a_purchase_keeps_its_record_after_its_delivery_settles() {
    let mut c = selling();
    deliver(&mut c, 10_000, &message(&near_purchase()));
    pay_out(&mut c, 0);
    assert!(c.get_delivery(0).is_none());
    let id = format!("0x{}", hex::encode(near_purchase().id()));
    assert_eq!(c.get_purchase(id).unwrap().delivery, Some(0));
}

#[test]
fn a_refund_proof_stays_valid_while_new_leaves_arrive() {
    let mut c = contract();
    registered(&mut c, &Seller::new(1));
    deliver(&mut c, 10_000, &message(&near_purchase()));
    let first = [leaf_of(0, 10_000).hash()];
    let proof = hexes(crate::merkle::tests::proof(&first, 0));
    let bare = "{\"annon\":2,\"refund\":{\"kind\":\"near\",\"id\":\"attacker.near\"},".to_string();
    for _ in 0..5 {
        deliver(&mut c, 1, &bare);
    }
    as_caller("keeper.near", NearToken::from_millinear(50));
    c.materialize_refund(
        crate::receive::LeafArgs {
            delivery_id: 0,
            refund: Seller::new(7).id(),
            amount: U128(10_000),
        },
        0,
        proof,
    );
    assert_eq!(c.get_delivery(0).unwrap().slots[0].amount, U128(10_000));
}

#[test]
#[should_panic(expected = "not a leaf of the refund accumulator")]
fn a_proof_against_a_root_too_old_is_refused() {
    let mut c = contract();
    registered(&mut c, &Seller::new(1));
    deliver(&mut c, 10_000, &message(&near_purchase()));
    let proof = hexes(crate::merkle::tests::proof(&[leaf_of(0, 10_000).hash()], 0));
    let bare = "{\"annon\":2,\"refund\":{\"kind\":\"near\",\"id\":\"attacker.near\"},".to_string();
    for _ in 0..crate::merkle::RECENT_ROOTS {
        deliver(&mut c, 1, &bare);
    }
    as_caller("keeper.near", NearToken::from_millinear(50));
    c.materialize_refund(
        crate::receive::LeafArgs {
            delivery_id: 0,
            refund: Seller::new(7).id(),
            amount: U128(10_000),
        },
        0,
        proof,
    );
}

#[test]
fn a_full_refund_tree_refuses_the_delivery() {
    let mut c = contract();
    registered(&mut c, &Seller::new(1));
    c.refunds.count = crate::merkle::CAPACITY;
    assert_eq!(deliver(&mut c, 10_000, &message(&near_purchase())), 10_000);
    assert_eq!(c.delivery_count(), 0);
}

#[test]
fn an_identical_reopen_returns_the_whole_deposit() {
    let mut c = selling();
    let id = buy(&mut c, Seller::new(7).id(), G1);
    reopen(
        &mut c,
        &Seller::new(7),
        &id,
        G1X2,
        NearToken::from_millinear(10),
    );
    // The same fresh key again, then the purchase's own key: nothing new is stored.
    for k in [G1X2, G1] {
        as_caller(RELAYER, NearToken::from_millinear(10)); // a new context: receipts start at 0
        let r = reopen_args(&id, k);
        let auth = Seller::new(7).auth(&c.reopen_text(r.clone()));
        c.reopen(r, auth);
        assert_eq!(
            sent_to(RELAYER, 0),
            NearToken::from_millinear(10).as_yoctonear(),
            "{k}"
        );
    }
}

#[test]
#[should_panic(expected = "invalid one-time key")]
fn a_seller_key_off_the_curve_is_refused_at_register() {
    let mut c = contract();
    let seller = Seller::new(1);
    let mut a = args(&seller);
    a.seller_key = format!("0x{}", "33".repeat(48));
    let auth = signed(&c, &seller, &a);
    c.register(a, auth);
}

#[test]
#[should_panic(expected = "invalid one-time key")]
fn the_point_at_infinity_is_refused_for_a_seller_reopen() {
    let mut c = contract();
    let seller = Seller::new(1);
    registered(&mut c, &seller);
    let r = SellerArgs {
        file_id: FILE.into(),
        key: Some(format!("0xc0{}", "00".repeat(47))),
        deadline: NOW_S + 600,
    };
    let auth = seller.auth(&c.reopen_seller_text(r.clone()));
    c.reopen_seller(r, auth);
}
