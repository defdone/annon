//! Annon's real wasm in a local NEAR sandbox, with a stand-in for NEAR MPC (`contracts/mock-mpc`).
//! Checks what unit tests can't: entrypoint guards, real gas, return values, refunds, events and a
//! function-call key. Run `contracts/annon/build.sh` first; `--nocapture` prints the gas used.
use k256::ecdsa::SigningKey;
use near_workspaces::network::Sandbox;
use near_workspaces::result::ExecutionFinalResult;
use near_workspaces::types::{AccessKey, Gas, NearToken, SecretKey};
use near_workspaces::{Account, Contract, Worker};
use serde_json::{json, Value};
use sha3::{Digest, Keccak256};

const WASM_DIR: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../target/wasm32-unknown-unknown/release"
);
const SPLITTER: &str = "0x5151515151515151515151515151515151515151";
const USDC: &str = "0x5252525252525252525252525252525252525252";
const SPLIT: &str = "PaymentSplit(address,address,uint256,uint256,uint256,bytes32)";
const AUTH_USED: &str = "AuthorizationUsed(address,bytes32)";
const TRANSFER: &str = "Transfer(address,address,uint256)";
const PRICE: u128 = 10_000;

fn wasm(name: &str) -> Vec<u8> {
    std::fs::read(format!("{WASM_DIR}/{name}.wasm"))
        .unwrap_or_else(|_| panic!("{name}.wasm missing: run contracts/annon/build.sh first"))
}

fn keccak(b: &[u8]) -> [u8; 32] {
    Keccak256::digest(b).into()
}

fn hex0x(b: &[u8]) -> String {
    format!("0x{}", hex::encode(b))
}

struct Wallet(SigningKey);

impl Wallet {
    fn new(seed: u8) -> Self {
        Self(SigningKey::from_bytes(&[seed; 32].into()).unwrap())
    }
    fn address(&self) -> String {
        let p = self.0.verifying_key().to_encoded_point(false);
        hex0x(&keccak(&p.as_bytes()[1..])[12..])
    }
    fn sign(&self, message: &str) -> String {
        let prefixed = format!("\x19Ethereum Signed Message:\n{}{message}", message.len());
        let (sig, recid) = self
            .0
            .sign_prehash_recoverable(&keccak(prefixed.as_bytes()))
            .unwrap();
        let mut out = sig.to_bytes().to_vec();
        out.push(27 + recid.to_byte());
        hex0x(&out)
    }
}

struct World {
    worker: Worker<Sandbox>,
    annon: Contract,
    mpc: Contract,
    relayer: Account,
    seller: Wallet,
    buyer: Wallet,
}

async fn world() -> anyhow::Result<World> {
    let worker = near_workspaces::sandbox().await?;
    let mpc = worker.dev_deploy(&wasm("mock_mpc")).await?;
    let annon = worker.dev_deploy(&wasm("annon")).await?;
    annon
        .call("new")
        .args_json(
            json!({ "mpc": mpc.id(), "ckd_domain": 2, "foreign_tx_domain": 3,
            "partner_splitter": SPLITTER, "usdc": USDC }),
        )
        .transact()
        .await?
        .into_result()?;
    let relayer = worker.dev_create_account().await?;
    Ok(World {
        worker,
        annon,
        mpc,
        relayer,
        seller: Wallet::new(1),
        buyer: Wallet::new(7),
    })
}

fn topic_address(a: &str) -> String {
    format!("{}{}", "00".repeat(12), a.trim_start_matches("0x"))
}

fn h(b: &[u8; 32]) -> String {
    hex::encode(b)
}

fn log(address: &str, index: u64, topics: Vec<String>, data: String) -> Value {
    json!({ "removed": false, "log_index": index, "transaction_index": 5,
        "transaction_hash": "cc".repeat(32), "block_hash": "bb".repeat(32), "block_number": 53_000_000u64,
        "address": address.trim_start_matches("0x"), "data": data, "topics": topics })
}

impl World {
    fn file(&self, n: u8) -> String {
        hex0x(&[n; 32])
    }

    fn nonce(&self, file: &str, key: &str) -> [u8; 32] {
        let mut m = b"annon/v1".to_vec();
        m.extend_from_slice(self.annon.id().as_bytes());
        m.extend_from_slice(&hex::decode(&file[2..]).unwrap());
        m.extend_from_slice(&hex::decode(&key[2..]).unwrap());
        keccak(&m)
    }

    async fn register(&self, file: &str, source: Value) -> anyhow::Result<ExecutionFinalResult> {
        self.register_by(&self.relayer, file, source, NearToken::from_millinear(10))
            .await
    }

    async fn register_by(
        &self,
        by: &Account,
        file: &str,
        source: Value,
        deposit: NearToken,
    ) -> anyhow::Result<ExecutionFinalResult> {
        let args = json!({ "file_id": file, "seller": self.seller.address(), "price": PRICE.to_string(),
            "source": source, "cipher_hash": hex0x(&[0x22; 32]), "moderator": self.relayer.id(),
            "seller_key": hex0x(&[0x33; 48]), "deadline": 4_000_000_000u64 });
        let message: String = self
            .annon
            .view("register_message")
            .args_json(json!({ "args": args }))
            .await?
            .json()?;
        Ok(by
            .call(self.annon.id(), "register")
            .args_json(json!({ "args": args, "sig": self.seller.sign(&message) }))
            .deposit(deposit)
            .gas(Gas::from_tgas(100))
            .transact()
            .await?)
    }

    fn split_logs(&self, file: &str, key: &str) -> Value {
        let data = format!(
            "0x{:064x}{:064x}{:064x}{}",
            PRICE,
            PRICE / 20,
            PRICE - PRICE / 20,
            h(&self.nonce(file, key))
        );
        json!([log(
            SPLITTER,
            7,
            vec![
                h(&keccak(SPLIT.as_bytes())),
                topic_address(&self.buyer.address()),
                topic_address(&self.seller.address())
            ],
            data
        )])
    }

    fn x402_logs(&self, file: &str, key: &str, pay_to: &str) -> Value {
        json!([
            log(
                USDC,
                7,
                vec![
                    h(&keccak(AUTH_USED.as_bytes())),
                    topic_address(&self.buyer.address()),
                    h(&self.nonce(file, key))
                ],
                "0x".into()
            ),
            log(
                USDC,
                8,
                vec![
                    h(&keccak(TRANSFER.as_bytes())),
                    topic_address(&self.buyer.address()),
                    topic_address(pay_to)
                ],
                format!("0x{PRICE:064x}")
            ),
        ])
    }

    async fn unlock(
        &self,
        by: &Account,
        file: &str,
        key: &str,
        logs: Value,
        deposit: NearToken,
        tgas: u64,
    ) -> anyhow::Result<ExecutionFinalResult> {
        Ok(by
            .call(self.annon.id(), "unlock")
            .args_json(json!({ "args": { "file_id": file, "buyer_key": key, "logs": logs } }))
            .deposit(deposit)
            .gas(Gas::from_tgas(tgas))
            .transact()
            .await?)
    }

    async fn mode(&self, verify: &str, ckd: &str) -> anyhow::Result<()> {
        self.mpc
            .call("set_mode")
            .args_json(json!({ "verify": verify, "ckd": ckd }))
            .transact()
            .await?
            .into_result()?;
        Ok(())
    }

    async fn is_buyer(&self, file: &str) -> anyhow::Result<bool> {
        Ok(self
            .annon
            .view("is_buyer")
            .args_json(json!({ "file_id": file, "wallet": self.buyer.address() }))
            .await?
            .json()?)
    }

    async fn balance(&self, of: &Account) -> anyhow::Result<u128> {
        let b: Option<String> = self
            .annon
            .view("storage_balance_of")
            .args_json(json!({ "account_id": of.id() }))
            .await?
            .json()?;
        Ok(b.map_or(0, |b| b.parse().unwrap()))
    }
}

/// NEP-297 events named `name` in the whole transaction.
fn events(out: &ExecutionFinalResult, name: &str) -> Vec<Value> {
    out.logs()
        .iter()
        .filter_map(|l| l.strip_prefix("EVENT_JSON:"))
        .map(|j| serde_json::from_str::<Value>(j).unwrap())
        .filter(|e| e["standard"] == "annon" && e["event"] == name)
        .map(|e| e["data"][0].clone())
        .collect()
}

/// The transaction's final return value.
fn answer(out: &ExecutionFinalResult) -> Value {
    out.clone().json().expect("no JSON return value")
}

fn tgas(out: &ExecutionFinalResult) -> u64 {
    out.total_gas_burnt.as_tgas()
}

#[tokio::test]
async fn nobody_but_the_contract_account_can_initialize_it() -> anyhow::Result<()> {
    let worker = near_workspaces::sandbox().await?;
    let annon = worker.dev_deploy(&wasm("annon")).await?;
    let attacker = worker.dev_create_account().await?;
    let out = attacker
        .call(annon.id(), "new")
        .args_json(
            json!({ "mpc": attacker.id(), "ckd_domain": 2, "foreign_tx_domain": 3,
            "partner_splitter": SPLITTER, "usdc": USDC }),
        )
        .transact()
        .await?;
    assert!(out.is_failure(), "an outsider initialized the contract");
    Ok(())
}

#[tokio::test]
async fn callbacks_are_private() -> anyhow::Result<()> {
    let w = world().await?;
    let out = w.relayer.call(w.annon.id(), "on_key_released")
        .args_json(json!({ "file_id": w.file(1), "key": hex0x(&[0x44; 48]), "reason": "reopen", "wallet": w.buyer.address() }))
        .transact().await?;
    assert!(out.is_failure(), "on_key_released is callable from outside");
    Ok(())
}

#[tokio::test]
async fn register_returns_the_key_answer_and_logs_receipts() -> anyhow::Result<()> {
    let w = world().await?;
    let out = w.register(&w.file(1), json!({ "kind": "partner" })).await?;
    assert!(out.is_success(), "{:?}", out.failures());
    let answer = answer(&out);
    assert_eq!(answer["big_y"], "bls12381g1:mockY");
    assert!(answer["big_c"]
        .as_str()
        .unwrap()
        .ends_with(&format!("file/{}", "01".repeat(32))));
    assert_eq!(events(&out, "register").len(), 1);
    assert_eq!(events(&out, "key_released")[0]["reason"], "register");
    println!("register: {} Tgas burnt", tgas(&out));
    Ok(())
}

#[tokio::test]
async fn a_partner_purchase_releases_the_key_with_the_minimum_gas() -> anyhow::Result<()> {
    let w = world().await?;
    let file = w.file(2);
    let key = hex0x(&[0x33; 48]);
    w.register(&file, json!({ "kind": "partner" }))
        .await?
        .into_result()?;
    let out = w
        .unlock(
            &w.relayer,
            &file,
            &key,
            w.split_logs(&file, &key),
            NearToken::from_millinear(5),
            150,
        )
        .await?;
    assert!(out.is_success(), "{:?}", out.failures());
    let answer = answer(&out);
    assert_eq!(
        answer["big_y"], "bls12381g1:mockY",
        "unlock must return the CKD answer"
    );
    let paid = &events(&out, "payment_verified")[0];
    assert_eq!(paid["payer"], w.buyer.address());
    assert_eq!(paid["amount"], PRICE.to_string());
    assert_eq!(events(&out, "key_released")[0]["reason"], "unlock");
    assert!(w.is_buyer(&file).await?);
    let used: bool = w
        .annon
        .view("is_payment_used")
        .args_json(json!({ "base_tx": paid["base_tx"], "log_index": paid["log_index"] }))
        .await?
        .json()?;
    assert!(used, "the payment must show as used after unlock");
    println!(
        "unlock (Partner): {} Tgas burnt of 150 attached",
        tgas(&out)
    );
    assert!(tgas(&out) < 120, "unlock burnt {} Tgas", tgas(&out));
    Ok(())
}

#[tokio::test]
async fn a_direct_x402_purchase_releases_the_key() -> anyhow::Result<()> {
    let w = world().await?;
    let file = w.file(3);
    let key = hex0x(&[0x33; 48]);
    let pay_to = Wallet::new(9).address();
    w.register(&file, json!({ "kind": "x402", "pay_to": pay_to }))
        .await?
        .into_result()?;
    let out = w
        .unlock(
            &w.relayer,
            &file,
            &key,
            w.x402_logs(&file, &key, &pay_to),
            NearToken::from_millinear(5),
            150,
        )
        .await?;
    assert!(out.is_success(), "{:?}", out.failures());
    assert_eq!(events(&out, "key_released").len(), 1);
    println!("unlock (x402, two logs): {} Tgas burnt", tgas(&out));
    Ok(())
}

#[tokio::test]
async fn a_failed_check_refunds_the_reservation_and_the_payment_can_be_retried(
) -> anyhow::Result<()> {
    let w = world().await?;
    let file = w.file(4);
    let key = hex0x(&[0x33; 48]);
    w.register(&file, json!({ "kind": "partner" }))
        .await?
        .into_result()?;
    w.relayer
        .call(w.annon.id(), "storage_deposit")
        .args_json(json!({}))
        .deposit(NearToken::from_millinear(100))
        .transact()
        .await?
        .into_result()?;
    let start = w.balance(&w.relayer).await?;

    for bad in ["fail", "wrong_hash"] {
        w.mode(bad, "ok").await?;
        let out = w
            .unlock(
                &w.relayer,
                &file,
                &key,
                w.split_logs(&file, &key),
                NearToken::from_yoctonear(0),
                150,
            )
            .await?;
        assert!(out.is_success(), "{:?}", out.failures());
        assert!(
            answer(&out)["error"].is_string(),
            "{bad}: expected an error answer"
        );
        assert!(events(&out, "payment_verified").is_empty());
        assert_eq!(
            w.balance(&w.relayer).await?,
            start,
            "{bad}: reservation not restored"
        );
        assert!(!w.is_buyer(&file).await?);
    }

    w.mode("ok", "ok").await?;
    let out = w
        .unlock(
            &w.relayer,
            &file,
            &key,
            w.split_logs(&file, &key),
            NearToken::from_yoctonear(0),
            150,
        )
        .await?;
    assert_eq!(
        events(&out, "key_released").len(),
        1,
        "retry after failures must work"
    );
    let spent = start - w.balance(&w.relayer).await?;
    println!("storage for one purchase: {spent} yoctoNEAR");
    assert!(spent > 0 && spent < NearToken::from_millinear(5).as_yoctonear());
    Ok(())
}

#[tokio::test]
async fn a_failed_key_release_keeps_the_purchase_and_reopen_gets_the_key() -> anyhow::Result<()> {
    let w = world().await?;
    let file = w.file(5);
    let key = hex0x(&[0x33; 48]);
    w.register(&file, json!({ "kind": "partner" }))
        .await?
        .into_result()?;
    w.mode("ok", "fail").await?;
    let out = w
        .unlock(
            &w.relayer,
            &file,
            &key,
            w.split_logs(&file, &key),
            NearToken::from_millinear(5),
            150,
        )
        .await?;
    assert_eq!(events(&out, "payment_verified").len(), 1);
    assert!(
        events(&out, "key_released").is_empty(),
        "no receipt without a key"
    );
    assert!(answer(&out)["error"].as_str().unwrap().contains("reopen"));
    assert!(w.is_buyer(&file).await?);

    w.mode("ok", "ok").await?;
    let args = json!({ "file_id": file, "wallet": w.buyer.address(), "key": hex0x(&[0x44; 48]), "deadline": 4_000_000_000u64 });
    let message: String = w
        .annon
        .view("reopen_message")
        .args_json(json!({ "args": args }))
        .await?
        .json()?;
    let out = w
        .relayer
        .call(w.annon.id(), "reopen")
        .args_json(json!({ "args": args, "sig": w.buyer.sign(&message) }))
        .gas(Gas::from_tgas(100))
        .transact()
        .await?;
    assert_eq!(events(&out, "key_released")[0]["reason"], "reopen");
    println!("reopen: {} Tgas burnt", tgas(&out));
    Ok(())
}

#[tokio::test]
async fn a_function_call_key_registers_and_unlocks_from_a_prepaid_balance_but_cannot_withdraw(
) -> anyhow::Result<()> {
    let w = world().await?;
    let file = w.file(6);
    let key = hex0x(&[0x33; 48]);
    w.register(&file, json!({ "kind": "partner" }))
        .await?
        .into_result()?;
    w.relayer
        .call(w.annon.id(), "storage_deposit")
        .args_json(json!({}))
        .deposit(NearToken::from_millinear(100))
        .transact()
        .await?
        .into_result()?;

    // The relayer's hot key: function-call only, limited to Annon's relayed methods.
    let hot = SecretKey::from_random(near_workspaces::types::KeyType::ED25519);
    w.relayer
        .batch(w.relayer.id())
        .add_key(
            hot.public_key(),
            AccessKey::function_call_access(
                w.annon.id(),
                &["register", "unlock", "reopen", "stop_sales"],
                None,
            ),
        )
        .transact()
        .await?
        .into_result()?;
    let agent = Account::from_secret_key(w.relayer.id().clone(), hot, &w.worker);

    // A listing paid from the balance: the hot key can't attach a deposit.
    let before = w.balance(&w.relayer).await?;
    let listed = w.file(7);
    let out = w
        .register_by(
            &agent,
            &listed,
            json!({ "kind": "partner" }),
            NearToken::from_yoctonear(0),
        )
        .await?;
    assert!(out.is_success(), "{:?}", out.failures());
    let used = before - w.balance(&w.relayer).await?;
    assert!(
        used > 0 && used < NearToken::from_millinear(5).as_yoctonear(),
        "register took {used} yocto from the balance"
    );
    println!("register from the prepaid balance: {used} yoctoNEAR of storage");

    let out = w
        .unlock(
            &agent,
            &file,
            &key,
            w.split_logs(&file, &key),
            NearToken::from_yoctonear(0),
            150,
        )
        .await?;
    assert!(out.is_success(), "{:?}", out.failures());
    assert_eq!(events(&out, "key_released").len(), 1);

    let withdraw = agent
        .call(w.annon.id(), "storage_withdraw")
        .args_json(json!({}))
        .deposit(NearToken::from_yoctonear(1))
        .transact()
        .await;
    assert!(
        withdraw.is_err() || withdraw.unwrap().is_failure(),
        "a function-call key withdrew the balance"
    );
    Ok(())
}

#[tokio::test]
async fn a_takedown_blocks_unlock_until_restore() -> anyhow::Result<()> {
    let w = world().await?;
    let file = w.file(7);
    let key = hex0x(&[0x33; 48]);
    w.register(&file, json!({ "kind": "partner" }))
        .await?
        .into_result()?; // moderator: the relayer account
    w.relayer
        .call(w.annon.id(), "takedown")
        .args_json(json!({ "file_id": file, "reason": "court_order" }))
        .deposit(NearToken::from_yoctonear(1))
        .transact()
        .await?
        .into_result()?;
    let out = w
        .unlock(
            &w.relayer,
            &file,
            &key,
            w.split_logs(&file, &key),
            NearToken::from_millinear(5),
            150,
        )
        .await?;
    assert!(out.is_failure(), "a taken-down file unlocked");
    w.relayer
        .call(w.annon.id(), "restore")
        .args_json(json!({ "file_id": file }))
        .deposit(NearToken::from_yoctonear(1))
        .transact()
        .await?
        .into_result()?;
    let out = w
        .unlock(
            &w.relayer,
            &file,
            &key,
            w.split_logs(&file, &key),
            NearToken::from_millinear(5),
            150,
        )
        .await?;
    assert_eq!(events(&out, "key_released").len(), 1);
    Ok(())
}
