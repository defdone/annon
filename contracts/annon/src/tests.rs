use super::*;
use k256::ecdsa::SigningKey;
use near_mpc_contract_interface::types::{EvmLog, Hash160, Hash256};
use near_sdk::test_utils::{get_created_receipts, VMContextBuilder};
use near_sdk::{testing_env, NearToken, PromiseResult};
use sha3::{Digest, Keccak256};

const CONTRACT: &str = "v1.annon.defdone.near";
const NOW_S: u64 = 1_793_000_000;
const SPLITTER: &str = "0x5151515151515151515151515151515151515151";
/// Address of Seller::new(7), the test buyer.
const PAYER: &str = "0x4a62316623ad457f02cdc5d997ded67a383ec569";

struct Seller(SigningKey);

impl Seller {
    fn new(seed: u8) -> Self {
        Self(SigningKey::from_bytes(&[seed; 32].into()).unwrap())
    }

    fn address(&self) -> String {
        let point = self.0.verifying_key().to_encoded_point(false);
        let hash = Keccak256::digest(&point.as_bytes()[1..]);
        format!("0x{}", hex::encode(&hash[12..]))
    }

    /// EIP-191 personal_sign, as a wallet does it.
    fn sign(&self, message: &str) -> String {
        let prefixed = format!("\x19Ethereum Signed Message:\n{}{}", message.len(), message);
        let digest = Keccak256::digest(prefixed.as_bytes());
        let (sig, recid) = self.0.sign_prehash_recoverable(&digest).unwrap();
        let mut out = sig.to_bytes().to_vec();
        out.push(27 + recid.to_byte());
        format!("0x{}", hex::encode(out))
    }
}

fn context(deposit: NearToken) {
    testing_env!(VMContextBuilder::new()
        .current_account_id(CONTRACT.parse().unwrap())
        .predecessor_account_id("relayer.annon.defdone.near".parse().unwrap())
        .attached_deposit(deposit)
        .block_timestamp(NOW_S * 1_000_000_000)
        .build());
}

fn contract() -> Annon {
    context(NearToken::from_millinear(100));
    Annon::new("v1.signer".parse().unwrap(), 2, 3, SPLITTER.into())
}

fn args(seller: &Seller) -> RegisterArgs {
    RegisterArgs {
        file_id: format!("0x{}", "11".repeat(32)),
        seller: seller.address(),
        price: U128(10_000),
        source: Source::Partner,
        cipher_hash: format!("0x{}", "22".repeat(32)),
        moderator: Some("moderator.sputnik-dao.near".parse().unwrap()),
        seller_key: format!("0x{}", "33".repeat(48)),
        deadline: NOW_S + 600,
    }
}

fn signed(c: &Annon, seller: &Seller, a: &RegisterArgs) -> String {
    seller.sign(&c.register_message(a.clone()))
}

#[test]
fn registers_a_file_signed_by_its_seller() {
    let mut c = contract();
    let seller = Seller::new(1);
    let a = args(&seller);
    let sig = signed(&c, &seller, &a);
    c.register(a.clone(), sig);

    let f = c.get_file(a.file_id).unwrap();
    assert_eq!(f.seller, seller.address());
    assert_eq!(f.price, U128(10_000));
    assert_eq!(f.source, Source::Partner);
    assert_eq!(f.cipher_hash, a.cipher_hash);
    assert_eq!(f.moderator, a.moderator);
    assert!(!f.sales_stopped);
}

#[test]
fn registers_a_direct_x402_file() {
    let mut c = contract();
    let seller = Seller::new(1);
    let mut a = args(&seller);
    a.source = Source::X402 {
        pay_to: Seller::new(9).address(),
    };
    a.moderator = None;
    let sig = signed(&c, &seller, &a);
    c.register(a.clone(), sig);
    assert_eq!(c.get_file(a.file_id).unwrap().source, a.source);
}

#[test]
fn message_names_the_contract_and_every_field() {
    let c = contract();
    let seller = Seller::new(1);
    let m = c.register_message(args(&seller));
    for part in [
        CONTRACT,
        &seller.address(),
        "10000",
        "partner",
        "moderator.sputnik-dao.near",
    ] {
        assert!(m.contains(part), "message is missing {part}:\n{m}");
    }
}

#[test]
#[should_panic(expected = "signature is not from the seller")]
fn rejects_a_signature_from_someone_else() {
    let mut c = contract();
    let a = args(&Seller::new(1));
    let sig = signed(&c, &Seller::new(2), &a);
    c.register(a, sig);
}

#[test]
#[should_panic(expected = "signature is not from the seller")]
fn rejects_a_field_changed_after_signing() {
    let mut c = contract();
    let seller = Seller::new(1);
    let mut a = args(&seller);
    let sig = signed(&c, &seller, &a);
    a.price = U128(1);
    c.register(a, sig);
}

#[test]
#[should_panic(expected = "signature is not from the seller")]
fn rejects_a_signature_made_for_another_contract() {
    let mut c = contract();
    let seller = Seller::new(1);
    let a = args(&seller);
    let other = c
        .register_message(a.clone())
        .replace(CONTRACT, "v2.annon.defdone.near");
    c.register(a, seller.sign(&other));
}

#[test]
#[should_panic(expected = "file already registered")]
fn rejects_the_same_file_twice() {
    let mut c = contract();
    let seller = Seller::new(1);
    let a = args(&seller);
    let sig = signed(&c, &seller, &a);
    c.register(a.clone(), sig.clone());
    context(NearToken::from_millinear(100));
    c.register(a, sig);
}

#[test]
#[should_panic(expected = "signature expired")]
fn rejects_an_expired_signature() {
    let mut c = contract();
    let seller = Seller::new(1);
    let mut a = args(&seller);
    a.deadline = NOW_S - 1;
    let sig = signed(&c, &seller, &a);
    c.register(a, sig);
}

#[test]
#[should_panic(expected = "price must be above zero")]
fn rejects_a_free_file() {
    let mut c = contract();
    let seller = Seller::new(1);
    let mut a = args(&seller);
    a.price = U128(0);
    let sig = signed(&c, &seller, &a);
    c.register(a, sig);
}

#[test]
#[should_panic(expected = "file_id must be 32 bytes")]
fn rejects_a_short_file_id() {
    let mut c = contract();
    let seller = Seller::new(1);
    let mut a = args(&seller);
    a.file_id = "0x1234".into();
    c.register(a, "0x00".into());
}

#[test]
#[should_panic(expected = "seller_key must be 48 bytes")]
fn rejects_a_wrong_size_one_time_key() {
    let mut c = contract();
    let seller = Seller::new(1);
    let mut a = args(&seller);
    a.seller_key = format!("0x{}", "33".repeat(32));
    c.register(a, "0x00".into());
}

#[test]
#[should_panic(expected = "attach at least")]
fn rejects_a_call_that_does_not_pay_for_storage() {
    let mut c = contract();
    let seller = Seller::new(1);
    let a = args(&seller);
    let sig = signed(&c, &seller, &a);
    context(NearToken::from_yoctonear(0));
    c.register(a, sig);
}

#[test]
fn recovers_a_signature_made_by_viem() {
    context(NearToken::from_yoctonear(0));
    // viem `signMessage` with private key 0x01..01, as a browser wallet returns it.
    let sig = "0xa0b1241b6a8e97f459e365636c15fe34dceece91c6f78ec04fb79c69bef010592472ee3522a86fdef71d7117ccd342deb84ad74a90768cbb550af1afd10a11691b";
    let address =
        recover_eip191("Annon: list a file for sale\ncontract: x", sig).map(|a| hex0x(&a));
    assert_eq!(
        address.as_deref(),
        Some("0x1a642f0e3c3af545e7acbd38b07251b3990914f1")
    );
}

#[test]
#[should_panic(expected = "signature is not from the seller")]
fn no_moderator_and_an_account_named_none_sign_differently() {
    let mut c = contract();
    let seller = Seller::new(1);
    let mut a = args(&seller);
    a.moderator = None;
    let sig = signed(&c, &seller, &a);
    a.moderator = Some("none".parse().unwrap());
    c.register(a, sig);
}

#[test]
fn hex_spelling_does_not_change_the_message() {
    let c = contract();
    let seller = Seller::new(1);
    let a = args(&seller);
    let mut b = a.clone();
    b.file_id = b.file_id.trim_start_matches("0x").to_uppercase();
    b.seller = b.seller.to_uppercase().replace("0X", "0x");
    assert_eq!(c.register_message(a), c.register_message(b));
}

#[test]
fn asks_mpc_for_the_file_key_encrypted_to_the_seller() {
    let mut c = contract();
    let seller = Seller::new(1);
    let a = args(&seller);
    let sig = signed(&c, &seller, &a);
    c.register(a, sig);

    let call = get_created_receipts()
        .into_iter()
        .filter(|r| r.receiver_id.as_str() == "v1.signer")
        .flat_map(|r| r.actions)
        .find_map(|action| match action {
            near_sdk::mock::MockAction::FunctionCallWeight {
                method_name,
                args,
                attached_deposit,
                ..
            } => Some((method_name, args, attached_deposit)),
            _ => None,
        })
        .expect("no call to v1.signer");
    assert_eq!(call.0, b"request_app_private_key");
    assert_eq!(call.2, NearToken::from_yoctonear(1));
    let json: near_sdk::serde_json::Value = near_sdk::serde_json::from_slice(&call.1).unwrap();
    let key = format!("bls12381g1:{}", bs58::encode([0x33u8; 48]).into_string());
    assert_eq!(
        json,
        near_sdk::serde_json::json!({ "request": {
            "derivation_path": format!("file/{}", "11".repeat(32)),
            "app_public_key": { "AppPublicKey": key },
            "domain_id": 2,
        }})
    );
}

fn registered(c: &mut Annon, seller: &Seller) -> RegisterArgs {
    let a = args(seller);
    let sig = signed(c, seller, &a);
    c.register(a.clone(), sig);
    a
}

fn reopen_args(file_id: &str, wallet: &Seller) -> ReopenArgs {
    ReopenArgs {
        file_id: file_id.into(),
        wallet: wallet.address(),
        key: format!("0x{}", "44".repeat(48)),
        deadline: NOW_S + 600,
    }
}

fn ckd_calls() -> usize {
    get_created_receipts()
        .iter()
        .filter(|r| r.receiver_id.as_str() == "v1.signer")
        .count()
}

#[test]
fn seller_can_get_the_key_again_after_mpc_failed() {
    let mut c = contract();
    let seller = Seller::new(1);
    let a = registered(&mut c, &seller);
    let before = ckd_calls();
    let r = reopen_args(&a.file_id, &seller);
    let sig = seller.sign(&c.reopen_message(r.clone()));
    c.reopen(r, sig);
    assert_eq!(ckd_calls(), before + 1);
}

#[test]
#[should_panic(expected = "only the seller or a buyer can reopen")]
fn a_stranger_cannot_reopen() {
    let mut c = contract();
    let a = registered(&mut c, &Seller::new(1));
    let stranger = Seller::new(2);
    let r = reopen_args(&a.file_id, &stranger);
    let sig = stranger.sign(&c.reopen_message(r.clone()));
    c.reopen(r, sig);
}

#[test]
#[should_panic(expected = "signature is not from the wallet")]
fn reopen_needs_the_wallet_signature() {
    let mut c = contract();
    let seller = Seller::new(1);
    let a = registered(&mut c, &seller);
    let r = reopen_args(&a.file_id, &seller);
    let sig = Seller::new(2).sign(&c.reopen_message(r.clone()));
    c.reopen(r, sig);
}

#[test]
#[should_panic(expected = "signature is not from the wallet")]
fn a_reopen_signature_cannot_be_moved_to_another_key() {
    let mut c = contract();
    let seller = Seller::new(1);
    let a = registered(&mut c, &seller);
    let mut r = reopen_args(&a.file_id, &seller);
    let sig = seller.sign(&c.reopen_message(r.clone()));
    r.key = format!("0x{}", "55".repeat(48));
    c.reopen(r, sig);
}

#[test]
#[should_panic(expected = "signature expired")]
fn rejects_an_expired_reopen() {
    let mut c = contract();
    let seller = Seller::new(1);
    let a = registered(&mut c, &seller);
    let mut r = reopen_args(&a.file_id, &seller);
    r.deadline = NOW_S - 1;
    let sig = seller.sign(&c.reopen_message(r.clone()));
    c.reopen(r, sig);
}

#[test]
#[should_panic(expected = "unknown file")]
fn rejects_reopen_of_an_unknown_file() {
    let mut c = contract();
    let seller = Seller::new(1);
    let r = reopen_args(&format!("0x{}", "99".repeat(32)), &seller);
    let sig = seller.sign(&c.reopen_message(r.clone()));
    c.reopen(r, sig);
}

#[test]
fn reopen_and_register_messages_never_match() {
    let c = contract();
    let seller = Seller::new(1);
    let m = c.reopen_message(reopen_args(&args(&seller).file_id, &seller));
    assert!(m.starts_with("Annon: open a file again\n"), "{m}");
    assert!(m.contains(CONTRACT));
}

// A PaymentSplit log for args(Seller::new(1)) paid with buyer key 0x33..33. Its payload hash
// (fff5f9d0...) was computed by the reference code, which matched NEAR MPC byte for byte on mainnet.
const SPLIT_TOPIC: &str = "1d53deaef03137ccd2fa5503b6c280dacfce2e7ae1483128fb0ebfc6fa050e8c";
const SPLIT_DATA: &str = "0x000000000000000000000000000000000000000000000000000000000000271000000000000000000000000000000000000000000000000000000000000001f4000000000000000000000000000000000000000000000000000000000000251c52112c22da1c1cb9865e7e136a5162eca47f68141120192b9b448b228fc7c059";
const SPLIT_PAYLOAD_HASH: &str = "fff5f9d04947a46e1cd2ce279446e48cd6827d1e9faa3784638ae88b5ce7f9d0";

fn h256(s: &str) -> Hash256 {
    Hash256(
        hex::decode(s.trim_start_matches("0x"))
            .unwrap()
            .try_into()
            .unwrap(),
    )
}

fn topic_address(a: &str) -> Hash256 {
    h256(&format!(
        "{}{}",
        "00".repeat(12),
        a.trim_start_matches("0x")
    ))
}

fn split_log() -> EvmLog {
    EvmLog {
        removed: false,
        log_index: 7,
        transaction_index: 5,
        transaction_hash: h256(&"aa".repeat(32)),
        block_hash: h256(&"bb".repeat(32)),
        block_number: 0x3000000,
        address: Hash160([0x51; 20]),
        data: SPLIT_DATA.into(),
        topics: vec![
            h256(SPLIT_TOPIC),
            topic_address(PAYER),
            topic_address(&Seller::new(1).address()),
        ],
    }
}

fn unlock_args(log: EvmLog) -> UnlockArgs {
    UnlockArgs {
        file_id: format!("0x{}", "11".repeat(32)),
        buyer_key: format!("0x{}", "33".repeat(48)),
        log,
    }
}

/// A contract with the test file registered, ready for unlock.
fn listed() -> Annon {
    let mut c = contract();
    registered(&mut c, &Seller::new(1));
    context(UNLOCK_DEPOSIT);
    c
}

fn mpc_call() -> near_sdk::serde_json::Value {
    get_created_receipts()
        .into_iter()
        .filter(|r| r.receiver_id.as_str() == "v1.signer")
        .flat_map(|r| r.actions)
        .find_map(|action| match action {
            near_sdk::mock::MockAction::FunctionCallWeight {
                method_name, args, ..
            } if method_name == b"verify_foreign_transaction" => {
                Some(near_sdk::serde_json::from_slice(&args).unwrap())
            }
            _ => None,
        })
        .expect("no verify_foreign_transaction call")
}

#[test]
fn unlock_asks_mpc_to_verify_the_exact_log_on_base() {
    let mut c = listed();
    c.unlock(unlock_args(split_log()));
    let req = &mpc_call()["request"];
    assert_eq!(req["expected_payload_hash"], SPLIT_PAYLOAD_HASH);
    assert_eq!(req["domain_id"], 3);
    assert_eq!(req["request"]["Base"]["finality"], "Safe");
    assert_eq!(
        req["request"]["Base"]["extractors"][0]["Log"]["log_index"],
        7
    );
}

#[test]
#[should_panic(expected = "log is not from the payment source")]
fn unlock_rejects_a_log_from_another_contract() {
    let mut c = listed();
    let mut log = split_log();
    log.address = Hash160([0x52; 20]);
    c.unlock(unlock_args(log));
}

#[test]
#[should_panic(expected = "not a PaymentSplit event")]
fn unlock_rejects_another_event() {
    let mut c = listed();
    let mut log = split_log();
    log.topics[0] = h256(&"cd".repeat(32));
    c.unlock(unlock_args(log));
}

#[test]
#[should_panic(expected = "payment went to another seller")]
fn unlock_rejects_a_payment_to_someone_else() {
    let mut c = listed();
    let mut log = split_log();
    log.topics[2] = topic_address(&Seller::new(2).address());
    c.unlock(unlock_args(log));
}

#[test]
#[should_panic(expected = "payment is below the price")]
fn unlock_rejects_a_payment_below_the_price() {
    let mut c = listed();
    let mut log = split_log();
    log.data = SPLIT_DATA.replacen("2710", "270f", 1); // 9999 instead of 10000
    c.unlock(unlock_args(log));
}

#[test]
#[should_panic(expected = "payment was not made for this file and key")]
fn unlock_rejects_a_payment_bound_to_another_key() {
    let mut c = listed();
    let mut a = unlock_args(split_log());
    a.buyer_key = format!("0x{}", "44".repeat(48));
    c.unlock(a);
}

#[test]
#[should_panic(expected = "log was removed")]
fn unlock_rejects_a_removed_log() {
    let mut c = listed();
    let mut log = split_log();
    log.removed = true;
    c.unlock(unlock_args(log));
}

#[test]
#[should_panic(expected = "unknown file")]
fn unlock_rejects_an_unknown_file() {
    let mut c = listed();
    let mut a = unlock_args(split_log());
    a.file_id = format!("0x{}", "99".repeat(32));
    c.unlock(a);
}

fn mpc_answered(result: PromiseResult) {
    testing_env!(
        VMContextBuilder::new()
            .current_account_id(CONTRACT.parse().unwrap())
            .predecessor_account_id(CONTRACT.parse().unwrap())
            .block_timestamp(NOW_S * 1_000_000_000)
            .build(),
        near_sdk::test_vm_config(),
        near_sdk::RuntimeFeesConfig::test(),
        Default::default(),
        vec![result],
    );
}

fn verified(hash: &str) -> PromiseResult {
    let body = near_sdk::serde_json::json!({
        "payload_hash": hash,
        "signature": { "scheme": "Secp256k1", "big_r": { "affine_point": "02".to_string() + &"11".repeat(32) },
            "s": { "scalar": "22".repeat(32) }, "recovery_id": 0 },
    });
    PromiseResult::Successful(body.to_string().into_bytes())
}

fn callback(c: &mut Annon) {
    c.on_payment_verified(
        format!("0x{}", "11".repeat(32)),
        format!("0x{}", "33".repeat(48)),
        PAYER.into(),
        format!("0x{}{}", "aa".repeat(32), "0000000000000007"),
        SPLIT_PAYLOAD_HASH.into(),
        "relayer.annon.defdone.near".parse().unwrap(),
        U128(UNLOCK_DEPOSIT.as_yoctonear()),
    );
}

/// NEAR sent back to the relayer since `before` receipts.
fn refunded(before: usize) -> u128 {
    get_created_receipts()[before..]
        .iter()
        .filter(|r| r.receiver_id.as_str() == "relayer.annon.defdone.near")
        .flat_map(|r| r.actions.clone())
        .map(|a| match a {
            near_sdk::mock::MockAction::Transfer { deposit, .. } => deposit.as_yoctonear(),
            _ => 0,
        })
        .sum()
}

fn assert_refused(reason: &str, before: usize) {
    assert!(
        near_sdk::test_utils::get_logs()
            .iter()
            .any(|l| l.contains(reason)),
        "no log with {reason}: {:?}",
        near_sdk::test_utils::get_logs()
    );
    assert_eq!(
        refunded(before),
        UNLOCK_DEPOSIT.as_yoctonear(),
        "deposit not refunded in full"
    );
    assert!(!get_created_receipts()[before..]
        .iter()
        .any(|r| r.receiver_id.as_str() == "v1.signer"));
}

#[test]
fn a_verified_payment_releases_the_key_and_records_the_buyer() {
    let mut c = listed();
    mpc_answered(verified(SPLIT_PAYLOAD_HASH));
    let before = get_created_receipts().len();
    callback(&mut c);
    let ckd = get_created_receipts()[before..]
        .iter()
        .filter(|r| r.receiver_id.as_str() == "v1.signer")
        .count();
    assert_eq!(ckd, 1, "no CKD request after a verified payment");
    assert!(c.is_buyer(format!("0x{}", "11".repeat(32)), PAYER.into()));
}

#[test]
fn a_different_payload_releases_nothing_and_refunds() {
    let mut c = listed();
    mpc_answered(verified(&"00".repeat(32)));
    let before = get_created_receipts().len();
    callback(&mut c);
    assert_refused("MPC verified a different payload", before);
    assert!(!c.is_buyer(format!("0x{}", "11".repeat(32)), PAYER.into()));
}

#[test]
fn a_failed_mpc_call_releases_nothing_and_refunds() {
    let mut c = listed();
    mpc_answered(PromiseResult::Failed);
    let before = get_created_receipts().len();
    callback(&mut c);
    assert_refused("MPC could not verify the payment", before);
}

#[test]
fn a_failed_mpc_call_leaves_the_payment_unused() {
    let mut c = listed();
    mpc_answered(PromiseResult::Failed);
    callback(&mut c);
    context(UNLOCK_DEPOSIT);
    c.unlock(unlock_args(split_log())); // retry is accepted
}

#[test]
fn a_verified_payment_refunds_what_storage_did_not_use() {
    let mut c = listed();
    mpc_answered(verified(SPLIT_PAYLOAD_HASH));
    let before = get_created_receipts().len();
    callback(&mut c);
    let back = refunded(before);
    assert!(
        back > 0 && back < UNLOCK_DEPOSIT.as_yoctonear(),
        "refund {back}"
    );
}

#[test]
#[should_panic(expected = "attach at least")]
fn unlock_needs_a_storage_deposit() {
    let mut c = listed();
    context(NearToken::from_yoctonear(0));
    c.unlock(unlock_args(split_log()));
}

#[test]
#[should_panic(expected = "payment already used")]
fn one_payment_unlocks_once() {
    let mut c = listed();
    mpc_answered(verified(SPLIT_PAYLOAD_HASH));
    callback(&mut c);
    context(UNLOCK_DEPOSIT);
    c.unlock(unlock_args(split_log()));
}

#[test]
fn two_unlocks_in_flight_release_once() {
    let mut c = listed();
    mpc_answered(verified(SPLIT_PAYLOAD_HASH));
    callback(&mut c);
    mpc_answered(verified(SPLIT_PAYLOAD_HASH));
    let before = get_created_receipts().len();
    callback(&mut c);
    assert_refused("payment already used", before);
}

#[test]
fn a_buyer_can_reopen_and_a_stranger_cannot() {
    let mut c = listed();
    mpc_answered(verified(SPLIT_PAYLOAD_HASH));
    callback(&mut c);
    context(NearToken::from_yoctonear(0));
    let file = format!("0x{}", "11".repeat(32));
    let buyer = Seller::new(7);
    assert_eq!(buyer.address(), PAYER);
    let r = reopen_args(&file, &buyer);
    let before = ckd_calls();
    c.reopen(r.clone(), buyer.sign(&c.reopen_message(r)));
    assert_eq!(ckd_calls(), before + 1);

    let stranger = Seller::new(8);
    let r = reopen_args(&file, &stranger);
    let sig = stranger.sign(&c.reopen_message(r.clone()));
    let refused = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.reopen(r, sig)));
    assert!(refused.is_err());
}
