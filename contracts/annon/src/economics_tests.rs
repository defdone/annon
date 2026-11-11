//! Economic regressions, introduced before changing acceptance accounting.
use crate::receive::tests::{deliver, near_purchase, selling};
use crate::tests::*;
use crate::*;

#[test]
fn acceptance_never_spends_refund_reserve() {
    let mut c = selling();
    let reserve = c.reserve;
    deliver(&mut c, 10_000, &message(&near_purchase()));
    assert!(c.get_purchase(evm::hex0x(&near_purchase().id())).is_some());
    assert_eq!(c.reserve, reserve, "valid purchases must charge their file");
}

#[test]
fn funded_purchase_survives_empty_refund_reserve() {
    let mut c = selling();
    c.reserve = 0;
    deliver(&mut c, 10_000, &message(&near_purchase()));
    assert!(c.get_purchase(evm::hex0x(&near_purchase().id())).is_some());
}

#[test]
fn measure_permanent_purchase_storage() {
    for route in [0, 1] {
        for (label, identity) in [
            ("evm", Seller::new(7).id()),
            (
                "solana",
                identity::IdentityJson {
                    kind: "solana".into(),
                    id: "12".repeat(32),
                },
            ),
            ("near10", tests::near_id("buyer.near")),
            ("near64", tests::near_id(&"a".repeat(64))),
        ] {
            // Flush complete permanent writes through the actual collection implementation.
            near_sdk::mock::with_mocked_blockchain(|b| {
                b.take_storage();
            });
            near_sdk::testing_env!(near_sdk::test_utils::VMContextBuilder::new()
                .current_account_id(CONTRACT.parse().unwrap())
                .predecessor_account_id(CONTRACT.parse().unwrap())
                .build());
            let mut c = init();
            let identity = identity::Identity::from_json(&identity).unwrap();
            for n in 0..2u8 {
                let before = near_sdk::env::storage_usage();
                let mut p = near_purchase();
                p.nonce = [n; 32];
                let id = p.id();
                c.index_purchase(&identity, id);
                c.purchases.insert(
                    id,
                    state::PurchaseRec {
                        file_id: p.file_id,
                        buyer_key: p.buyer_key,
                        recovery: identity.clone(),
                        route,
                        delivery: u64::MAX,
                        accepted_at: NOW_S,
                        grants: 1,
                    },
                );
                if route == 1 {
                    let mut used = [0; 40];
                    used[0] = n;
                    c.used.insert(used, ());
                }
                c.purchases.flush();
                c.recovery.flush();
                c.recovery_count.flush();
                c.used.flush();
                let bytes = near_sdk::env::storage_usage() - before;
                let expected = match label {
                    "evm" => 304,
                    "solana" => 316,
                    "near10" => 298,
                    _ => 352,
                } + if route == 1 { 81 } else { 0 };
                assert_eq!(bytes, expected);
                println!("STORAGE route={route} identity={label} purchase={n} bytes={bytes}");
            }
        }
    }
}

fn budget(c: &Annon, file: &str) -> u128 {
    c.file_storage_balance(file.into()).available.0
}
fn settle(c: &mut Annon, delivery: u64) {
    use near_sdk::{NearToken, PromiseResult};
    let d = c.get_delivery(delivery).unwrap();
    as_caller("keeper.test", NearToken::from_yoctonear(0));
    c.fund_delivery(delivery);
    answered(vec![PromiseResult::Successful(
        format!("\"{}\"", d.amount.0).into_bytes(),
    )]);
    c.on_funded(delivery, 1);
    for slot in 0..d.slots.len() {
        as_caller("keeper.test", NearToken::from_yoctonear(0));
        c.pay_slot(delivery, slot as u32);
        answered(vec![PromiseResult::Successful(vec![])]);
        c.on_paid(delivery, slot as u32, 1);
    }
}

#[test]
fn repeated_settled_self_purchases_and_retirement_are_isolated() {
    let mut c = selling();
    let other = format!("0x{}", "a3".repeat(32));
    let seller = Seller::new(1);
    let mut a = args(&seller);
    a.terms.file_id = other.clone();
    as_caller(RELAYER, near_sdk::NearToken::from_near(1));
    let auth = signed(&c, &seller, &a);
    c.register(a, auth);
    as_caller("sponsor.test", near_sdk::NearToken::from_near(1));
    c.fund_file_storage(other.clone(), None);
    let reserve = c.reserve;
    let untouched = budget(&c, &other);
    let start = budget(&c, FILE);
    for nonce in 0..8u8 {
        let mut p = near_purchase();
        p.nonce = [nonce; 32];
        let before = budget(&c, FILE);
        deliver(&mut c, 10_000, &message(&p));
        let charged = budget(&c, FILE);
        assert!(charged < before);
        settle(&mut c, nonce.into());
        let retired = budget(&c, FILE);
        assert!(retired > charged && retired < before);
        let settled = event("delivery_settled");
        assert_eq!(settled["storage_destination"], FILE);
        assert_eq!(settled["storage_credit"], (retired - charged).to_string());
        assert_eq!(
            settled["freed_bytes"].as_u64().unwrap() as u128
                * near_sdk::env::storage_byte_cost().as_yoctonear(),
            retired - charged
        );
        c.on_paid(nonce.into(), 0, 1);
        c.on_funded(nonce.into(), 1);
        assert_eq!(budget(&c, FILE), retired);
        assert_eq!((c.reserve, budget(&c, &other)), (reserve, untouched));
    }
    assert!(budget(&c, FILE) < start);
}

#[test]
fn refund_flood_cannot_block_funded_files_or_charge_their_budget() {
    let mut c = selling();
    c.reserve = near_sdk::env::storage_byte_cost().as_yoctonear() * 4096;
    let before = budget(&c, FILE);
    for _ in 0..10 {
        deliver(
            &mut c,
            1,
            "{\"annon\":2,\"refund\":{\"kind\":\"near\",\"id\":\"buyer.test\"},",
        );
    }
    assert!(c.reserve < near_sdk::env::storage_byte_cost().as_yoctonear() * 4096);
    assert!(c.refunds.count > 0);
    assert_eq!(budget(&c, FILE), before);
    deliver(&mut c, 10_000, &message(&near_purchase()));
    assert!(c.get_purchase(evm::hex0x(&near_purchase().id())).is_some());
}

#[test]
fn low_budget_refunds_without_consuming_id_and_can_be_funded_later() {
    let mut c = selling();
    c.files
        .get_mut(&evm::bytes::<32>(FILE, "file"))
        .unwrap()
        .purchase_storage_balance = 0;
    let p = near_purchase();
    deliver(&mut c, 10_000, &message(&p));
    assert_eq!(
        c.get_delivery(0).unwrap().reason,
        receive::reason::FILE_STORAGE_LOW
    );
    assert!(c.get_purchase(evm::hex0x(&p.id())).is_none());
    assert_eq!(budget(&c, FILE), 0);
    as_caller("sponsor.test", near_sdk::NearToken::from_near(1));
    c.fund_file_storage(FILE.into(), None);
    deliver(&mut c, 10_000, &message(&p));
    assert!(c.get_purchase(evm::hex0x(&p.id())).is_some());
}

#[test]
fn all_rejections_leave_file_budget_untouched() {
    let mut c = selling();
    let p = near_purchase();
    deliver(&mut c, 10_000, &message(&p));
    let before = budget(&c, FILE);
    deliver(&mut c, 10_000, &message(&p)); // duplicate
    let mut p = p;
    p.nonce = [99; 32];
    deliver(&mut c, 9_999, &message(&p)); // underpaid
    p.expires_at = NOW_S - 1;
    deliver(&mut c, 10_000, &message(&p));
    p.terms_hash = [99; 32];
    deliver(&mut c, 10_000, &message(&p));
    deliver(
        &mut c,
        1,
        "{\"annon\":2,\"refund\":{\"kind\":\"near\",\"id\":\"buyer.test\"},",
    );
    assert_eq!(budget(&c, FILE), before);
}

#[test]
fn recovery_and_immutable_terms_survive_budget_depletion_and_moderation() {
    let mut c = selling();
    let p = near_purchase();
    deliver(&mut c, 10_000, &message(&p));
    settle(&mut c, 0);
    let terms = c.get_file(FILE.into()).unwrap().terms_hash;
    c.files
        .get_mut(&p.file_id)
        .unwrap()
        .purchase_storage_balance = 0;
    as_caller(RELAYER, near_sdk::NearToken::from_millinear(10));
    c.claim_key(evm::hex0x(&p.id()), None);
    let args = crate::keys::ReopenArgs {
        purchase_id: evm::hex0x(&p.id()),
        fresh_key: G1X2.into(),
        nonce: evm::hex0x(&[88; 32]),
        deadline: NOW_S + 60,
    };
    let auth = Seller::new(7).auth(&c.reopen_text(args.clone()));
    c.reopen(args, auth);
    let stop = SellerArgs {
        file_id: FILE.into(),
        key: None,
        deadline: NOW_S + 60,
    };
    let auth = Seller::new(1).auth(&c.stop_sales_text(stop.clone()));
    c.stop_sales(stop, auth);
    as_caller(MODERATOR, near_sdk::NearToken::from_yoctonear(1));
    c.takedown(FILE.into(), TakedownReason::CourtOrder);
    c.restore(FILE.into());
    assert_eq!(c.get_file(FILE.into()).unwrap().terms_hash, terms);
    assert_eq!(
        c.get_purchase(evm::hex0x(&p.id())).unwrap().terms_hash,
        terms
    );
    assert_eq!(c.get_purchase(evm::hex0x(&p.id())).unwrap().grants, 2);
    // register is the only creation entry; it refuses overwrites even with fresh authorization.
    as_caller(RELAYER, near_sdk::NearToken::from_near(1));
    let mut a = tests::args(&Seller::new(1));
    a.terms.near.price.0 += 1;
    let auth = signed(&c, &Seller::new(1), &a);
    assert!(
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.register(a, auth))).is_err()
    );
    assert_eq!(c.get_file(FILE.into()).unwrap().terms_hash, terms);
}

#[test]
fn prepaid_funding_only_debits_caller_and_requires_an_explicit_amount() {
    let mut c = selling();
    as_caller("sponsor.test", near_sdk::NearToken::from_near(1));
    c.storage_deposit(None);
    let before = c
        .storage_balance_of("sponsor.test".parse().unwrap())
        .unwrap()
        .0;
    as_caller("sponsor.test", near_sdk::NearToken::from_yoctonear(0));
    let start = budget(&c, FILE);
    c.fund_file_storage(FILE.into(), Some(near_sdk::json_types::U128(123)));
    assert_eq!(budget(&c, FILE), start + 123);
    assert_eq!(
        c.storage_balance_of("sponsor.test".parse().unwrap())
            .unwrap()
            .0,
        before - 123
    );
    assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(
        || c.fund_file_storage(FILE.into(), None)
    ))
    .is_err());
    as_caller("stranger.test", near_sdk::NearToken::from_yoctonear(0));
    assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(
        || c.fund_file_storage(FILE.into(), Some(near_sdk::json_types::U128(1)))
    ))
    .is_err());
}

#[test]
fn recovery_head_pagination_preserves_order_across_files() {
    let mut c = selling();
    let recovery = Seller::new(7).id();
    let mut ids = vec![];
    for n in 0..5u8 {
        let mut p = near_purchase();
        p.nonce = [n; 32];
        ids.push(evm::hex0x(&p.id()));
        deliver(&mut c, 10_000, &message(&p));
    }
    assert_eq!(c.purchases_of(recovery.clone(), 0, 100), ids);
    assert_eq!(c.purchases_of(recovery.clone(), 0, 1), ids[..1]);
    assert_eq!(c.purchases_of(recovery.clone(), 1, 2), ids[1..3]);
    assert!(c.purchases_of(recovery.clone(), u32::MAX, 100).is_empty());
    assert!(c.purchases_of(recovery, 0, 0).is_empty());
}

#[test]
fn base_unlock_succeeds_with_no_file_budget_or_receiver_reserve() {
    let mut c = listed();
    assert_eq!((budget(&c, FILE), c.reserve), (0, 0));
    c.unlock(unlock_args());
    mpc_answered(verified(&payload_hash(&x402_logs())));
    callback(&mut c);
    assert!(c.get_purchase(evm::hex0x(&base_purchase().id())).is_some());
    assert_eq!((budget(&c, FILE), c.reserve), (0, 0));
}

#[test]
fn no_file_lifecycle_method_changes_registered_terms() {
    use near_sdk::NearToken;
    let mut c = contract();
    let seller = "seller.test";
    as_caller(seller, NearToken::from_near(1));
    c.register(args_for(near_id(seller)), None);
    let id = evm::bytes::<32>(FILE, "file_id");
    let original = near_sdk::borsh::to_vec(&c.file(&id).terms).unwrap();
    let unchanged = |c: &Annon| {
        assert_eq!(
            near_sdk::borsh::to_vec(&c.file(&id).terms).unwrap(),
            original
        )
    };
    c.publish_header(FILE.into(), evm::hex0x(&[22; 32]));
    unchanged(&c);
    as_caller("sponsor.test", NearToken::from_near(1));
    c.fund_file_storage(FILE.into(), None);
    unchanged(&c);
    as_caller(seller, NearToken::from_near(1));
    c.reopen_seller(
        SellerArgs {
            file_id: FILE.into(),
            key: Some(G1X2.into()),
            deadline: NOW_S + 60,
        },
        None,
    );
    unchanged(&c);
    as_caller(seller, NearToken::from_yoctonear(1));
    c.stop_sales(
        SellerArgs {
            file_id: FILE.into(),
            key: None,
            deadline: NOW_S + 60,
        },
        None,
    );
    unchanged(&c);
    as_caller(MODERATOR, NearToken::from_yoctonear(1));
    c.takedown(FILE.into(), TakedownReason::CourtOrder);
    unchanged(&c);
    c.restore(FILE.into());
    unchanged(&c);
}

#[test]
#[should_panic(expected = "attach exactly amount")]
fn funding_mismatched_attachment_is_refused() {
    let mut c = selling();
    as_caller("sponsor.test", near_sdk::NearToken::from_yoctonear(1));
    c.fund_file_storage(
        FILE.into(),
        Some(near_sdk::json_types::U128(10u128.pow(24))),
    );
}
#[test]
#[should_panic(expected = "positive amount required")]
fn funding_zero_is_refused() {
    let mut c = selling();
    as_caller("sponsor.test", near_sdk::NearToken::from_yoctonear(0));
    c.fund_file_storage(FILE.into(), Some(near_sdk::json_types::U128(0)));
}
#[test]
#[should_panic(expected = "unknown file")]
fn funding_unknown_file_is_refused() {
    let mut c = selling();
    as_caller("sponsor.test", near_sdk::NearToken::from_near(1));
    c.fund_file_storage(evm::hex0x(&[99; 32]), None);
}
#[test]
#[should_panic(expected = "sales stopped")]
fn funding_stopped_file_is_refused() {
    let mut c = selling();
    c.files
        .get_mut(&near_purchase().file_id)
        .unwrap()
        .sales_stopped_at = NOW_S;
    as_caller("sponsor.test", near_sdk::NearToken::from_near(1));
    c.fund_file_storage(FILE.into(), None);
}
#[test]
#[should_panic(expected = "taken down")]
fn funding_taken_down_file_is_refused() {
    let mut c = selling();
    c.files
        .get_mut(&near_purchase().file_id)
        .unwrap()
        .taken_down = 1;
    as_caller("sponsor.test", near_sdk::NearToken::from_near(1));
    c.fund_file_storage(FILE.into(), None);
}
fn event(name: &str) -> near_sdk::serde_json::Value {
    near_sdk::test_utils::get_logs()
        .iter()
        .filter_map(|s| s.strip_prefix("EVENT_JSON:"))
        .map(|s| near_sdk::serde_json::from_str::<near_sdk::serde_json::Value>(s).unwrap())
        .find(|v| v["event"] == name)
        .unwrap()["data"][0]
        .clone()
}
#[test]
fn file_admission_boundary_and_economic_events() {
    let mut c = selling();
    let p = near_purchase();
    let admission = near_sdk::env::storage_byte_cost().as_yoctonear() * 4096;
    c.files
        .get_mut(&p.file_id)
        .unwrap()
        .purchase_storage_balance = admission - 1;
    deliver(&mut c, 10_000, &message(&p));
    assert!(c.get_purchase(evm::hex0x(&p.id())).is_none());
    assert_eq!(c.get_delivery(0).unwrap().reason, 11);
    let low = event("file_storage_low");
    assert_eq!(low["file_id"], FILE);
    assert_eq!(low["available"], (admission - 1).to_string());
    assert_eq!(low["admission_requirement"], admission.to_string());
    as_caller("sponsor.test", near_sdk::NearToken::from_yoctonear(1));
    c.fund_file_storage(FILE.into(), None);
    let funded = event("file_storage_funded");
    assert_eq!(funded["file_id"], FILE);
    assert_eq!(funded["funder"], "sponsor.test");
    assert_eq!(funded["amount"], "1");
    assert_eq!(funded["balance"], admission.to_string());
    deliver(&mut c, 10_000, &message(&p));
    assert!(c.get_purchase(evm::hex0x(&p.id())).is_some());
    let accepted = event("purchase_accepted");
    let cost = accepted["charged_cost"]
        .as_str()
        .unwrap()
        .parse::<u128>()
        .unwrap();
    assert_eq!(
        cost,
        accepted["charged_bytes"].as_u64().unwrap() as u128
            * near_sdk::env::storage_byte_cost().as_yoctonear()
    );
    assert_eq!(accepted["file_id"], FILE);
    assert_eq!(accepted["purchase_id"], evm::hex0x(&p.id()));
    assert_eq!(accepted["remaining_budget"], budget(&c, FILE).to_string());
    assert_eq!(admission - cost, budget(&c, FILE));
}

#[test]
fn register_budget_debits_exact_budget_and_registration_storage_once() {
    let mut c = contract();
    let caller = "sponsor.test";
    let allocation = near_sdk::NearToken::from_millinear(50).as_yoctonear();
    as_caller(caller, near_sdk::NearToken::from_near(1));
    c.storage_deposit(None);
    let prepaid = balance(&c, caller);
    let seller = Seller::new(1);
    let mut a = args(&seller);
    a.file_budget = Some(near_sdk::json_types::U128(allocation));
    let auth = signed(&c, &seller, &a);
    as_caller(caller, near_sdk::NearToken::from_yoctonear(0));
    let before = near_sdk::env::storage_usage();
    c.register(a, auth);
    let storage_cost = u128::from(near_sdk::env::storage_usage() - before)
        * near_sdk::env::storage_byte_cost().as_yoctonear();
    assert!(storage_cost > 0);
    assert_eq!(balance(&c, caller), prepaid - allocation - storage_cost);
    assert_eq!(budget(&c, FILE), allocation);
    let events: Vec<near_sdk::serde_json::Value> = near_sdk::test_utils::get_logs()
        .iter()
        .filter_map(|s| s.strip_prefix("EVENT_JSON:"))
        .map(|s| near_sdk::serde_json::from_str(s).unwrap())
        .collect();
    let funded: Vec<_> = events
        .iter()
        .filter(|v| v["event"] == "file_storage_funded")
        .collect();
    assert_eq!(funded.len(), 1);
    assert_eq!(funded[0]["data"][0]["file_id"], FILE);
    assert_eq!(funded[0]["data"][0]["funder"], caller);
    assert_eq!(funded[0]["data"][0]["amount"], allocation.to_string());
    assert_eq!(funded[0]["data"][0]["balance"], allocation.to_string());
}

#[test]
fn register_emits_registration_before_budget_funding() {
    let mut c = contract();
    as_caller(RELAYER, near_sdk::NearToken::from_near(1));
    c.storage_deposit(None);
    let seller = Seller::new(1);
    let mut a = args(&seller);
    a.file_budget = Some(near_sdk::json_types::U128(123));
    let auth = signed(&c, &seller, &a);
    as_caller(RELAYER, near_sdk::NearToken::from_yoctonear(0));
    c.register(a, auth);
    let names: Vec<String> = near_sdk::test_utils::get_logs()
        .iter()
        .filter_map(|s| s.strip_prefix("EVENT_JSON:"))
        .map(|s| {
            near_sdk::serde_json::from_str::<near_sdk::serde_json::Value>(s).unwrap()["event"]
                .as_str()
                .unwrap()
                .to_string()
        })
        .collect();
    assert_eq!(names.iter().filter(|n| *n == "file_registered").count(), 1);
    let registered = names.iter().position(|n| n == "file_registered").unwrap();
    let funded = names
        .iter()
        .position(|n| n == "file_storage_funded")
        .unwrap();
    assert!(registered < funded);
}

#[test]
#[should_panic(expected = "no prepaid balance")]
fn register_budget_requires_prepaid_even_with_a_large_attachment() {
    let mut c = contract();
    let seller = Seller::new(1);
    let mut a = args(&seller);
    a.file_budget = Some(near_sdk::json_types::U128(123));
    let auth = signed(&c, &seller, &a);
    as_caller(RELAYER, near_sdk::NearToken::from_near(1));
    c.register(a, auth);
}

#[test]
#[should_panic(expected = "not enough prepaid balance")]
fn register_budget_refuses_a_prepaid_balance_one_yocto_short() {
    let mut c = contract();
    let seller = Seller::new(1);
    let mut a = args(&seller);
    a.file_budget = Some(near_sdk::json_types::U128(123));
    let auth = signed(&c, &seller, &a);
    c.balances.insert(RELAYER.parse().unwrap(), 122);
    // Attached money pays registration storage, never the requested budget.
    as_caller(RELAYER, near_sdk::NearToken::from_near(1));
    c.register(a, auth);
}

#[test]
#[should_panic(expected = "positive amount required")]
fn register_budget_refuses_some_zero() {
    let mut c = contract();
    let seller = Seller::new(1);
    let mut a = args(&seller);
    a.file_budget = Some(near_sdk::json_types::U128(0));
    let auth = signed(&c, &seller, &a);
    as_caller(RELAYER, near_sdk::NearToken::from_near(1));
    c.register(a, auth);
}
