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
    as_caller(CONTRACT, NearToken::from_yoctonear(0)); // init is a self-call in the deploy tx
    let c = init();
    context(NearToken::from_millinear(100));
    c
}

pub(crate) fn init() -> Annon {
    Annon::new(
        "v1.signer".parse().unwrap(),
        2,
        3,
        SPLITTER.into(),
        USDC.into(),
    )
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
    unlock_logs(vec![log])
}

pub(crate) fn unlock_logs(logs: Vec<EvmLog>) -> UnlockArgs {
    UnlockArgs {
        file_id: format!("0x{}", "11".repeat(32)),
        buyer_key: format!("0x{}", "33".repeat(48)),
        logs,
    }
}

pub(crate) const USDC: &str = "0x5252525252525252525252525252525252525252";
/// Address of Seller::new(9), the x402 seller's `pay_to`.
pub(crate) const PAY_TO: &str = "0x58da990a8f4a3a6ca7cb6315d68a140105917352";
// USDC `AuthorizationUsed` (log 7) and `Transfer` (log 8) of one direct x402 payment for the test
// file and buyer key. Payload hash of both logs from the reference code, as for PaymentSplit.
pub(crate) const AUTH_USED_TOPIC: &str =
    "98de503528ee59b575ef0c0a2576a82497bfc029a5685b209e9ec333479b10a5";
pub(crate) const TRANSFER_TOPIC: &str =
    "ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
pub(crate) const X402_NONCE: &str =
    "52112c22da1c1cb9865e7e136a5162eca47f68141120192b9b448b228fc7c059";
pub(crate) const X402_PAYLOAD_HASH: &str =
    "0210acf134dff365035ba3e3ee5b8d685e8944ca97c04b23992ce9f079c62a1b";

pub(crate) fn x402_logs() -> Vec<EvmLog> {
    let log = |log_index, topics, data: &str| EvmLog {
        removed: false,
        log_index,
        transaction_index: 5,
        transaction_hash: h256(&"cc".repeat(32)),
        block_hash: h256(&"bb".repeat(32)),
        block_number: 0x3000000,
        address: Hash160([0x52; 20]),
        data: data.into(),
        topics,
    };
    vec![
        log(
            7,
            vec![
                h256(AUTH_USED_TOPIC),
                topic_address(PAYER),
                h256(X402_NONCE),
            ],
            "0x",
        ),
        log(
            8,
            vec![
                h256(TRANSFER_TOPIC),
                topic_address(PAYER),
                topic_address(PAY_TO),
            ],
            &format!("0x{:064x}", 10_000),
        ),
    ]
}

/// A contract with the test file listed for a direct x402 payment to `PAY_TO`.
pub(crate) fn listed_x402() -> Annon {
    let mut c = contract();
    let seller = Seller::new(1);
    let mut a = args(&seller);
    a.source = Source::X402 {
        pay_to: PAY_TO.into(),
    };
    let sig = signed(&c, &seller, &a);
    c.register(a, sig);
    context(UNLOCK_DEPOSIT);
    c
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
        U128(10_000),
        0x3000000,
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
        U128(10_000),
        0x3000000,
    );
}

/// NEP-297 events with this name logged so far, as their `data[0]`.
pub(crate) fn events(name: &str) -> Vec<near_sdk::serde_json::Value> {
    near_sdk::test_utils::get_logs()
        .iter()
        .filter_map(|l| l.strip_prefix("EVENT_JSON:"))
        .map(|j| near_sdk::serde_json::from_str::<near_sdk::serde_json::Value>(j).unwrap())
        .inspect(|e| {
            assert_eq!(e["standard"], "annon");
            assert_eq!(e["version"], "1.0.0");
        })
        .filter(|e| e["event"] == name)
        .map(|e| e["data"][0].clone())
        .collect()
}

/// Method names of calls this contract scheduled on itself since `before` receipts.
pub(crate) fn self_calls(before: usize) -> Vec<String> {
    get_created_receipts()[before..]
        .iter()
        .filter(|r| r.receiver_id.as_str() == CONTRACT)
        .flat_map(|r| r.actions.clone())
        .filter_map(|a| match a {
            near_sdk::mock::MockAction::FunctionCallWeight { method_name, .. } => {
                Some(String::from_utf8(method_name).unwrap())
            }
            _ => None,
        })
        .collect()
}

pub(crate) fn ckd_answered(result: PromiseResult) {
    mpc_answered(result)
}

pub(crate) const CKD_ANSWER: &str = r#"{"big_y":"bls12381g1:Y","big_c":"bls12381g1:C"}"#;
