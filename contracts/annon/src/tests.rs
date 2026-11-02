//! Shared test helpers: wallets, contexts, a registered file and a matching payment log.
#![allow(dead_code)]
use crate::*;
use k256::ecdsa::SigningKey;
use near_mpc_contract_interface::types::{EvmLog, Hash160, Hash256};
use near_sdk::test_utils::{get_created_receipts, VMContextBuilder};
use near_sdk::{testing_env, NearToken, PromiseResult};
use sha3::{Digest, Keccak256};
use unlock::UNLOCK_DEPOSIT;

pub(crate) const CONTRACT: &str = "v1.annon.defdone.near";
pub(crate) const NOW_S: u64 = 1_793_000_000;
pub(crate) const SPLITTER: &str = "0x5151515151515151515151515151515151515151";
/// Address of Seller::new(7), the test buyer.
pub(crate) const PAYER: &str = "0x4a62316623ad457f02cdc5d997ded67a383ec569";

pub(crate) struct Seller(pub(crate) SigningKey);

impl Seller {
    pub(crate) fn new(seed: u8) -> Self {
        Self(SigningKey::from_bytes(&[seed; 32].into()).unwrap())
    }

    pub(crate) fn address(&self) -> String {
        let point = self.0.verifying_key().to_encoded_point(false);
        let hash = Keccak256::digest(&point.as_bytes()[1..]);
        format!("0x{}", hex::encode(&hash[12..]))
    }

    /// EIP-191 personal_sign, as a wallet does it.
    pub(crate) fn sign(&self, message: &str) -> String {
        let prefixed = format!("\x19Ethereum Signed Message:\n{}{}", message.len(), message);
        let digest = Keccak256::digest(prefixed.as_bytes());
        let (sig, recid) = self.0.sign_prehash_recoverable(&digest).unwrap();
        let mut out = sig.to_bytes().to_vec();
        out.push(27 + recid.to_byte());
        format!("0x{}", hex::encode(out))
    }
}

pub(crate) fn context(deposit: NearToken) {
    testing_env!(VMContextBuilder::new()
        .current_account_id(CONTRACT.parse().unwrap())
        .predecessor_account_id("relayer.annon.defdone.near".parse().unwrap())
        .attached_deposit(deposit)
        .block_timestamp(NOW_S * 1_000_000_000)
        .build());
}

pub(crate) fn contract() -> Annon {
    context(NearToken::from_millinear(100));
    Annon::new("v1.signer".parse().unwrap(), 2, 3, SPLITTER.into())
}

pub(crate) fn args(seller: &Seller) -> RegisterArgs {
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

pub(crate) fn signed(c: &Annon, seller: &Seller, a: &RegisterArgs) -> String {
    seller.sign(&c.register_message(a.clone()))
}

pub(crate) fn registered(c: &mut Annon, seller: &Seller) -> RegisterArgs {
    let a = args(seller);
    let sig = signed(c, seller, &a);
    c.register(a.clone(), sig);
    a
}

pub(crate) fn reopen_args(file_id: &str, wallet: &Seller) -> ReopenArgs {
    ReopenArgs {
        file_id: file_id.into(),
        wallet: wallet.address(),
        key: format!("0x{}", "44".repeat(48)),
        deadline: NOW_S + 600,
    }
}

pub(crate) fn ckd_calls() -> usize {
    get_created_receipts()
        .iter()
        .filter(|r| r.receiver_id.as_str() == "v1.signer")
        .count()
}

// A PaymentSplit log for args(Seller::new(1)) paid with buyer key 0x33..33. Its payload hash
// (fff5f9d0...) was computed by the reference code, which matched NEAR MPC byte for byte on mainnet.
pub(crate) const SPLIT_TOPIC: &str =
    "1d53deaef03137ccd2fa5503b6c280dacfce2e7ae1483128fb0ebfc6fa050e8c";
pub(crate) const SPLIT_DATA: &str = "0x000000000000000000000000000000000000000000000000000000000000271000000000000000000000000000000000000000000000000000000000000001f4000000000000000000000000000000000000000000000000000000000000251c52112c22da1c1cb9865e7e136a5162eca47f68141120192b9b448b228fc7c059";
pub(crate) const SPLIT_PAYLOAD_HASH: &str =
    "fff5f9d04947a46e1cd2ce279446e48cd6827d1e9faa3784638ae88b5ce7f9d0";

pub(crate) fn h256(s: &str) -> Hash256 {
    Hash256(
        hex::decode(s.trim_start_matches("0x"))
            .unwrap()
            .try_into()
            .unwrap(),
    )
}

pub(crate) fn topic_address(a: &str) -> Hash256 {
    h256(&format!(
        "{}{}",
        "00".repeat(12),
        a.trim_start_matches("0x")
    ))
}

pub(crate) fn split_log() -> EvmLog {
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

pub(crate) fn unlock_args(log: EvmLog) -> UnlockArgs {
    UnlockArgs {
        file_id: format!("0x{}", "11".repeat(32)),
        buyer_key: format!("0x{}", "33".repeat(48)),
        log,
    }
}

/// A contract with the test file registered, ready for unlock.
pub(crate) fn listed() -> Annon {
    let mut c = contract();
    registered(&mut c, &Seller::new(1));
    context(UNLOCK_DEPOSIT);
    c
}

pub(crate) fn mpc_call() -> near_sdk::serde_json::Value {
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

pub(crate) fn mpc_answered(result: PromiseResult) {
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

pub(crate) fn verified(hash: &str) -> PromiseResult {
    let body = near_sdk::serde_json::json!({
        "payload_hash": hash,
        "signature": { "scheme": "Secp256k1", "big_r": { "affine_point": "02".to_string() + &"11".repeat(32) },
            "s": { "scalar": "22".repeat(32) }, "recovery_id": 0 },
    });
    PromiseResult::Successful(body.to_string().into_bytes())
}

pub(crate) fn callback(c: &mut Annon) {
    c.on_payment_verified(
        format!("0x{}", "11".repeat(32)),
        format!("0x{}", "33".repeat(48)),
        PAYER.into(),
        format!("0x{}{}", "aa".repeat(32), "0000000000000007"),
        SPLIT_PAYLOAD_HASH.into(),
        "relayer.annon.defdone.near".parse().unwrap(),
        U128(UNLOCK_DEPOSIT.as_yoctonear()),
        false,
    );
}

/// NEAR sent back to the relayer since `before` receipts.
pub(crate) fn refunded(before: usize) -> u128 {
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

pub(crate) fn assert_refused(reason: &str, before: usize) {
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

pub(crate) const RELAYER: &str = "relayer.annon.defdone.near";

pub(crate) fn as_caller(who: &str, deposit: NearToken) {
    testing_env!(VMContextBuilder::new()
        .current_account_id(CONTRACT.parse().unwrap())
        .predecessor_account_id(who.parse().unwrap())
        .attached_deposit(deposit)
        .block_timestamp(NOW_S * 1_000_000_000)
        .build());
}

pub(crate) fn balance(c: &Annon, who: &str) -> u128 {
    c.storage_balance_of(who.parse().unwrap())
        .map_or(0, |b| b.0)
}

pub(crate) fn prepaid_callback(c: &mut Annon) {
    c.on_payment_verified(
        format!("0x{}", "11".repeat(32)),
        format!("0x{}", "33".repeat(48)),
        PAYER.into(),
        format!("0x{}{}", "aa".repeat(32), "0000000000000007"),
        SPLIT_PAYLOAD_HASH.into(),
        RELAYER.parse().unwrap(),
        U128(UNLOCK_DEPOSIT.as_yoctonear()),
        true,
    );
}
