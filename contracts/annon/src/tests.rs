//! Shared test helpers: wallets of every kind, contexts, a registered file, purchases on both
//! routes and a matching Base payment.
#![allow(dead_code)]
use crate::identity::{Auth, Identity, IdentityJson};
use crate::purchase::{to_json, Purchase};
use crate::register::{BaseTermsJson, NearTermsJson, RecipientJson};
use crate::*;
use k256::ecdsa::SigningKey;
use near_mpc_bounded_collections::UpperBoundedVec;
use near_mpc_contract_interface::types::{
    EvmExtractedValue, EvmExtractor, EvmFinality, EvmLog, EvmRpcRequest, EvmTxId, ExtractedValue,
    ForeignChainRpcRequest, ForeignTxPayloadVersion, ForeignTxSignPayload, Hash160, Hash256,
};
use near_sdk::json_types::U128;
use near_sdk::test_utils::{get_created_receipts, VMContextBuilder};
use near_sdk::{testing_env, NearToken, PromiseResult};
use sha3::{Digest, Keccak256};
use unlock::UNLOCK_DEPOSIT;

pub(crate) const CONTRACT: &str = "v1.annon.defdone.near";
pub(crate) const NOW_S: u64 = 1_793_000_000;
/// Address of Seller::new(7), the test buyer.
pub(crate) const PAYER: &str = "0x4a62316623ad457f02cdc5d997ded67a383ec569";
pub(crate) const FILE: &str = "0x1111111111111111111111111111111111111111111111111111111111111111";
pub(crate) const MODERATOR: &str = "moderator.sputnik-dao.near";
pub(crate) const PLATFORM: &str = "defdone.near";
/// Real BLS12-381 G1 points, compressed: the generator and twice the generator.
pub(crate) const G1: &str = "0x97f1d3a73197d7942695638c4fa9ac0fc3688c4f9774b905a14e3a3f171bac586c55e83ff97a1aeffb3af00adb22c6bb";
pub(crate) const G1X2: &str = "0xa572cbea904d67468808c8eb50a9450c9721db309128012543902d0ac358a62ae28f75bb8f1c7c42c39a8c5529bf0f4e";
pub(crate) const RELAYER: &str = "relayer.annon.defdone.near";

/// An EVM wallet (EIP-191).
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

    pub(crate) fn id(&self) -> IdentityJson {
        IdentityJson {
            kind: "evm".into(),
            id: self.address(),
        }
    }

    pub(crate) fn auth(&self, text: &str) -> Option<Auth> {
        Some(Auth {
            kind: "evm".into(),
            sig: self.sign(text),
        })
    }
}

/// A Solana wallet: Ed25519 over the text's UTF-8 bytes, as `signMessage` does it.
pub(crate) struct Sol(pub(crate) ed25519_dalek::SigningKey);

impl Sol {
    pub(crate) fn new(seed: u8) -> Self {
        Self(ed25519_dalek::SigningKey::from_bytes(&[seed; 32]))
    }

    pub(crate) fn id(&self) -> IdentityJson {
        IdentityJson {
            kind: "solana".into(),
            id: hex::encode(self.0.verifying_key().to_bytes()),
        }
    }

    pub(crate) fn auth(&self, text: &str) -> Option<Auth> {
        use ed25519_dalek::Signer;
        let sig = self.0.sign(text.as_bytes()).to_bytes();
        Some(Auth {
            kind: "solana".into(),
            sig: format!("0x{}", hex::encode(sig)),
        })
    }
}

pub(crate) fn near_id(account: &str) -> IdentityJson {
    IdentityJson {
        kind: "near".into(),
        id: account.into(),
    }
}

pub(crate) fn identity(j: &IdentityJson) -> Identity {
    Identity::from_json(j).unwrap()
}

pub(crate) fn context(deposit: NearToken) {
    as_caller(RELAYER, deposit);
}

pub(crate) fn as_caller(who: &str, deposit: NearToken) {
    at_time(who, deposit, NOW_S);
}

pub(crate) fn at_time(who: &str, deposit: NearToken, t: u64) {
    testing_env!(VMContextBuilder::new()
        .current_account_id(CONTRACT.parse().unwrap())
        .predecessor_account_id(who.parse().unwrap())
        .attached_deposit(deposit)
        .prepaid_gas(near_sdk::Gas::from_tgas(300))
        .block_timestamp(t * 1_000_000_000)
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
        USDC.into(),
        None,
        None,
        None,
    )
}

/// The test file: 0.01 USDC on NEAR split 95/5 between PAY_TO (EVM) and PLATFORM (NEAR), and the
/// same price on Base, paid to PAY_TO.
pub(crate) fn terms(seller: IdentityJson) -> TermsJson {
    TermsJson {
        network: "near:mainnet".into(),
        contract: CONTRACT.parse().unwrap(),
        file_id: FILE.into(),
        seller,
        pay2_version: 2,
        cipher_hash: format!("0x{}", "22".repeat(32)),
        moderator: Some(MODERATOR.parse().unwrap()),
        near: NearTermsJson {
            token: NEAR_USDC.parse().unwrap(),
            price: U128(10_000),
            recipients: vec![
                RecipientJson {
                    identity: IdentityJson {
                        kind: "evm".into(),
                        id: PAY_TO.into(),
                    },
                    bps: 9_500,
                },
                RecipientJson {
                    identity: near_id(PLATFORM),
                    bps: 500,
                },
            ],
            remainder: 0,
        },
        base: Some(BaseTermsJson {
            usdc: USDC.into(),
            price: U128(10_000),
            pay_to: PAY_TO.into(),
        }),
    }
}

pub(crate) fn args_for(seller: IdentityJson) -> RegisterArgs {
    RegisterArgs {
        file_budget: None,
        terms: terms(seller),
        seller_key: G1.into(),
        deadline: NOW_S + 600,
    }
}

pub(crate) fn args(seller: &Seller) -> RegisterArgs {
    args_for(seller.id())
}

pub(crate) fn signed(c: &Annon, seller: &Seller, a: &RegisterArgs) -> Option<Auth> {
    seller.auth(&c.register_text(a.clone()))
}

pub(crate) fn registered(c: &mut Annon, seller: &Seller) -> RegisterArgs {
    let a = args(seller);
    let auth = signed(c, seller, &a);
    c.register(a.clone(), auth);
    a
}

pub(crate) fn terms_hash() -> [u8; 32] {
    args(&Seller::new(1)).terms.decode().hash()
}

/// A purchase of the test file. Route 0 pays NEAR USDC, route 1 USDC on Base.
pub(crate) fn purchase(route: u8, recovery: IdentityJson) -> Purchase {
    let (network, asset) = if route == 0 {
        ("near:mainnet".to_string(), NEAR_USDC.to_string())
    } else {
        ("eip155:8453".to_string(), USDC.to_string())
    };
    Purchase {
        version: 2,
        refund: identity(&Seller::new(7).id()),
        network,
        contract: CONTRACT.parse().unwrap(),
        route,
        asset,
        file_id: [0x11; 32],
        terms_hash: terms_hash(),
        price: 10_000,
        nonce: [0x55; 32],
        buyer_key: hex::decode(&G1[2..]).unwrap().try_into().unwrap(),
        recovery: identity(&recovery),
        expires_at: NOW_S + 3_600,
    }
}

pub(crate) fn message(p: &Purchase) -> String {
    to_json(p, &p.id())
}

pub(crate) fn ckd_calls() -> usize {
    get_created_receipts()
        .iter()
        .filter(|r| r.receiver_id.as_str() == "v1.signer")
        .count()
}

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

/// The EIP-3009 nonce of a Base purchase, with sha3's Keccak, not the contract's.
pub(crate) fn nonce_of(p: &Purchase) -> String {
    let mut m = b"annon/base-payment/v2\0".to_vec();
    m.extend_from_slice(&p.id());
    hex::encode(Keccak256::digest(&m))
}

/// The Base purchase paid by PAYER with recovery identity PAYER.
pub(crate) fn base_purchase() -> Purchase {
    purchase(1, Seller::new(7).id())
}

/// `unlock` with the test payment (`x402_logs`).
pub(crate) fn unlock_args() -> UnlockArgs {
    unlock_logs(x402_logs())
}

pub(crate) fn unlock_logs(logs: Vec<EvmLog>) -> UnlockArgs {
    UnlockArgs {
        purchase: message(&base_purchase()),
        logs,
        header: None,
    }
}

/// An RLP block header for the logs' block at Base time `time`, and the logs with their
/// `block_hash` set to the header's hash, as on Base. Fields other than number (8) and time (11)
/// are zeros.
pub(crate) fn with_header(mut logs: Vec<EvmLog>, time: u64) -> (Vec<EvmLog>, String) {
    let int = |n: u64| {
        let b: Vec<u8> = n
            .to_be_bytes()
            .into_iter()
            .skip_while(|x| *x == 0)
            .collect();
        match b.as_slice() {
            [x] if *x < 0x80 => b,
            _ => [vec![0x80 + b.len() as u8], b].concat(),
        }
    };
    let mut fields = Vec::new();
    for i in 0..15 {
        fields.extend(match i {
            8 => int(logs[0].block_number),
            11 => int(time),
            _ => vec![0xa0].into_iter().chain([0u8; 32]).collect(),
        });
    }
    let mut rlp = vec![0xf9, (fields.len() >> 8) as u8, fields.len() as u8];
    rlp.extend(fields);
    // sha3's Keccak, not the contract's env::keccak256: an independent hash.
    let hash = Hash256(Keccak256::digest(&rlp).into());
    for l in &mut logs {
        l.block_hash = hash.clone();
    }
    (logs, format!("0x{}", hex::encode(rlp)))
}

pub(crate) const USDC: &str = "0x5252525252525252525252525252525252525252";
/// Address of Seller::new(9), the test file's `pay_to`.
pub(crate) const PAY_TO: &str = "0x58da990a8f4a3a6ca7cb6315d68a140105917352";
pub(crate) const AUTH_USED_TOPIC: &str =
    "98de503528ee59b575ef0c0a2576a82497bfc029a5685b209e9ec333479b10a5";
pub(crate) const TRANSFER_TOPIC: &str =
    "ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
// A fixed nonce and the synthetic logs of `logs_with_nonce` have this MPC payload hash.
// `payload_hash` must agree with this independent expected value.
pub(crate) const TEST_NONCE: &str =
    "52112c22da1c1cb9865e7e136a5162eca47f68141120192b9b448b228fc7c059";
pub(crate) const TEST_PAYLOAD_HASH: &str =
    "0210acf134dff365035ba3e3ee5b8d685e8944ca97c04b23992ce9f079c62a1b";

/// USDC `AuthorizationUsed` (log 7) and `Transfer` (log 8) of one payment by PAYER to PAY_TO.
pub(crate) fn logs_with_nonce(nonce: &str) -> Vec<EvmLog> {
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
            vec![h256(AUTH_USED_TOPIC), topic_address(PAYER), h256(nonce)],
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

/// The test payment for `base_purchase`.
pub(crate) fn x402_logs() -> Vec<EvmLog> {
    logs_with_nonce(&nonce_of(&base_purchase()))
}

/// The payload hash MPC signs for these logs, with MPC's own interface crate.
pub(crate) fn payload_hash(logs: &[EvmLog]) -> String {
    let request = ForeignChainRpcRequest::Base(EvmRpcRequest {
        tx_id: EvmTxId(logs[0].transaction_hash.0),
        extractors: UpperBoundedVec::from_vec(
            logs.iter()
                .map(|l| EvmExtractor::Log {
                    log_index: l.log_index,
                })
                .collect(),
        )
        .unwrap(),
        finality: EvmFinality::Safe,
    });
    let hash = ForeignTxSignPayload::new(
        ForeignTxPayloadVersion::V1,
        request,
        logs.iter()
            .map(|l| ExtractedValue::EvmExtractedValue(EvmExtractedValue::Log(l.clone())))
            .collect(),
    )
    .compute_msg_hash()
    .unwrap();
    hex::encode(hash.0)
}

/// A contract with the test file registered, ready for unlock.
pub(crate) fn listed() -> Annon {
    let mut c = contract();
    registered(&mut c, &Seller::new(1));
    context(UNLOCK_DEPOSIT);
    c
}

pub(crate) fn mpc_call() -> near_sdk::serde_json::Value {
    calls_to("v1.signer", "verify_foreign_transaction")
        .pop()
        .expect("no verify_foreign_transaction call")
}

/// Arguments of every call to `method` on `to` scheduled so far.
pub(crate) fn calls_to(to: &str, method: &str) -> Vec<near_sdk::serde_json::Value> {
    get_created_receipts()
        .into_iter()
        .filter(|r| r.receiver_id.as_str() == to)
        .flat_map(|r| r.actions)
        .filter_map(|action| match action {
            near_sdk::mock::MockAction::FunctionCallWeight {
                method_name, args, ..
            } if method_name == method.as_bytes() => {
                Some(near_sdk::serde_json::from_slice(&args).unwrap())
            }
            _ => None,
        })
        .collect()
}

/// A callback context: the contract calling itself, with these promise results.
pub(crate) fn answered(results: Vec<PromiseResult>) {
    testing_env!(
        VMContextBuilder::new()
            .current_account_id(CONTRACT.parse().unwrap())
            .predecessor_account_id(CONTRACT.parse().unwrap())
            .block_timestamp(NOW_S * 1_000_000_000)
            .build(),
        near_sdk::test_vm_config(),
        near_sdk::RuntimeFeesConfig::test(),
        Default::default(),
        results,
    );
}

pub(crate) fn mpc_answered(result: PromiseResult) {
    answered(vec![result])
}

pub(crate) fn verified(hash: &str) -> PromiseResult {
    let body = near_sdk::serde_json::json!({
        "payload_hash": hash,
        "signature": { "scheme": "Secp256k1", "big_r": { "affine_point": "02".to_string() + &"11".repeat(32) },
            "s": { "scalar": "22".repeat(32) }, "recovery_id": 0 },
    });
    PromiseResult::Successful(body.to_string().into_bytes())
}

fn payment_callback(c: &mut Annon, caller: &str, prepaid: bool) {
    let p = base_purchase();
    c.on_payment_verified(
        format!("0x{}", hex::encode(p.id())),
        FILE.into(),
        format!("0x{}", hex::encode(p.terms_hash)),
        G1.into(),
        Seller::new(7).id(),
        PAYER.into(),
        format!("0x{}{}", "cc".repeat(32), "0000000000000007"),
        payload_hash(&x402_logs()),
        caller.parse().unwrap(),
        U128(UNLOCK_DEPOSIT.as_yoctonear()),
        prepaid,
        U128(10_000),
        0x3000000,
        None,
    );
}

pub(crate) fn callback(c: &mut Annon) {
    payment_callback(c, RELAYER, false)
}

pub(crate) fn prepaid_callback(c: &mut Annon) {
    payment_callback(c, RELAYER, true)
}

/// NEAR sent back to the relayer since `before` receipts.
pub(crate) fn refunded(before: usize) -> u128 {
    get_created_receipts()[before..]
        .iter()
        .filter(|r| r.receiver_id.as_str() == RELAYER)
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

pub(crate) fn balance(c: &Annon, who: &str) -> u128 {
    c.storage_balance_of(who.parse().unwrap())
        .map_or(0, |b| b.0)
}

/// NEP-297 events with this name logged so far, as their `data[0]`.
pub(crate) fn events(name: &str) -> Vec<near_sdk::serde_json::Value> {
    near_sdk::test_utils::get_logs()
        .iter()
        .filter_map(|l| l.strip_prefix("EVENT_JSON:"))
        .map(|j| near_sdk::serde_json::from_str::<near_sdk::serde_json::Value>(j).unwrap())
        .inspect(|e| {
            assert_eq!(e["standard"], "annon");
            assert_eq!(e["version"], "2.0.0");
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

#[test]
fn payload_hash_matches_the_fixed_mpc_payload() {
    assert_eq!(
        payload_hash(&logs_with_nonce(TEST_NONCE)),
        TEST_PAYLOAD_HASH
    );
}
