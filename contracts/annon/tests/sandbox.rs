//! Annon's real wasm in a local NEAR sandbox, with stand-ins for NEAR MPC (`contracts/mock-mpc`)
//! and for NEAR USDC and intents.near (`contracts/mock-token`). Checks what unit tests can't:
//! entrypoint guards, real gas, the real NEP-141 call chain, the host's BLS12-381 and Ed25519
//! checks, return values, refunds, events and a function-call key. Run `contracts/annon/build.sh`
//! first; `--nocapture` prints the gas used.
use k256::ecdsa::SigningKey;
use near_workspaces::network::Sandbox;
use near_workspaces::result::ExecutionFinalResult;
use near_workspaces::types::{AccessKey, Gas, NearToken, SecretKey};
use near_workspaces::{Account, Contract, Worker};
use serde_json::{json, Value};
use sha2::Sha256;
use sha3::{Digest, Keccak256};

const WASM_DIR: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../target/wasm32-unknown-unknown/release"
);
const USDC: &str = "0x5252525252525252525252525252525252525252";
const AUTH_USED: &str = "AuthorizationUsed(address,bytes32)";
const TRANSFER: &str = "Transfer(address,address,uint256)";
const PRICE: u128 = 10_000;
/// Real BLS12-381 G1 points, compressed: the generator and twice the generator.
const G1: &str = "0x97f1d3a73197d7942695638c4fa9ac0fc3688c4f9774b905a14e3a3f171bac586c55e83ff97a1aeffb3af00adb22c6bb";
const G1X2: &str = "0xa572cbea904d67468808c8eb50a9450c9721db309128012543902d0ac358a62ae28f75bb8f1c7c42c39a8c5529bf0f4e";
const DEADLINE: u64 = 4_000_000_000;

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

fn unhex(s: &str) -> Vec<u8> {
    hex::decode(s.trim_start_matches("0x")).unwrap()
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
    fn id(&self) -> Value {
        json!({ "kind": "evm", "id": self.address() })
    }
    fn auth(&self, text: &str) -> Value {
        json!({ "kind": "evm", "sig": self.sign(text) })
    }
}

/// An identity as the contract's Borsh encodes it (specs/near-settlement.md §2).
fn borsh_identity(i: &Value) -> Vec<u8> {
    let id = i["id"].as_str().unwrap();
    match i["kind"].as_str().unwrap() {
        "evm" => [vec![0], unhex(id)].concat(),
        "solana" => [vec![1], unhex(id)].concat(),
        _ => [vec![2], borsh_str(id)].concat(),
    }
}

fn borsh_str(s: &str) -> Vec<u8> {
    [
        (s.len() as u32).to_le_bytes().to_vec(),
        s.as_bytes().to_vec(),
    ]
    .concat()
}

/// A purchase message (§5.1) and its id (§5.2), built here from the spec, not by the contract.
struct Purchase {
    refund: Value,
    network: String,
    contract: String,
    route: u8,
    asset: String,
    file_id: String,
    terms_hash: String,
    price: u128,
    nonce: [u8; 32],
    buyer_key: String,
    recovery: Value,
    expires_at: u64,
}

impl Purchase {
    fn id(&self) -> [u8; 32] {
        let mut b = vec![2u8];
        b.extend(borsh_identity(&self.refund));
        b.extend(borsh_str(&self.network));
        b.extend(borsh_str(&self.contract));
        b.push(self.route);
        b.extend(borsh_str(&self.asset));
        b.extend(unhex(&self.file_id));
        b.extend(unhex(&self.terms_hash));
        b.extend(self.price.to_le_bytes());
        b.extend(self.nonce);
        b.extend(unhex(&self.buyer_key));
        b.extend(borsh_identity(&self.recovery));
        b.extend(self.expires_at.to_le_bytes());
        let mut h = Sha256::new();
        h.update(b"annon/purchase/v2\0");
        h.update(&b);
        h.finalize().into()
    }

    fn id_hex(&self) -> String {
        hex0x(&self.id())
    }

    fn message(&self) -> String {
        let ident = |i: &Value| {
            format!(
                "{{\"kind\":\"{}\",\"id\":\"{}\"}}",
                i["kind"].as_str().unwrap(),
                i["id"].as_str().unwrap()
            )
        };
        format!(
            "{{\"annon\":2,\"refund\":{},\"purchase\":{{\"network\":\"{}\",\"contract\":\"{}\",\"route\":\"{}\",\"asset\":\"{}\",\"file_id\":\"{}\",\"terms_hash\":\"{}\",\"price\":\"{}\",\"nonce\":\"{}\",\"buyer_key\":\"{}\",\"recovery\":{},\"expires_at\":\"{}\",\"purchase_id\":\"{}\"}}}}",
            ident(&self.refund), self.network, self.contract,
            if self.route == 0 { "near-usdc" } else { "base-usdc" },
            self.asset, self.file_id, self.terms_hash, self.price, hex0x(&self.nonce), self.buyer_key,
            ident(&self.recovery), self.expires_at, self.id_hex(),
        )
    }

    /// The EIP-3009 nonce of a Base purchase (§5.3).
    fn base_nonce(&self) -> [u8; 32] {
        keccak(&[b"annon/base-payment/v2\0".as_slice(), &self.id()].concat())
    }
}

struct World {
    worker: Worker<Sandbox>,
    annon: Contract,
    mpc: Contract,
    usdc: Contract,
    intents: Contract,
    relayer: Account,
    /// Pays NEAR USDC for purchases.
    payer: Account,
    platform: Account,
    seller: Wallet,
    buyer: Wallet,
}

async fn world() -> anyhow::Result<World> {
    let worker = near_workspaces::sandbox().await?;
    let mpc = worker.dev_deploy(&wasm("mock_mpc")).await?;
    let usdc = worker.dev_deploy(&wasm("mock_token")).await?;
    let intents = worker.dev_deploy(&wasm("mock_token")).await?;
    let annon = worker.dev_deploy(&wasm("annon")).await?;
    annon
        .call("new")
        .args_json(
            json!({ "mpc": mpc.id(), "ckd_domain": 2, "foreign_tx_domain": 3, "usdc": USDC,
            "near_usdc": usdc.id(), "intents": intents.id() }),
        )
        .transact()
        .await?
        .into_result()?;
    let relayer = worker.dev_create_account().await?;
    let payer = worker.dev_create_account().await?;
    let platform = worker.dev_create_account().await?;
    usdc.call("mint")
        .args_json(json!({ "account_id": payer.id(), "amount": "1000000" }))
        .transact()
        .await?
        .into_result()?;
    Ok(World {
        worker,
        annon,
        mpc,
        usdc,
        intents,
        relayer,
        payer,
        platform,
        seller: Wallet::new(1),
        buyer: Wallet::new(7),
    })
}

fn topic_address(a: &str) -> String {
    format!("{}{}", "00".repeat(12), a.trim_start_matches("0x"))
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

    /// The address buyers pay on Base, and the 95% share on NEAR (Wallet 9).
    fn pay_to(&self) -> String {
        Wallet::new(9).address()
    }

    fn terms(&self, file: &str, seller: Value) -> Value {
        json!({
            "network": "near:mainnet", "contract": self.annon.id(), "file_id": file, "seller": seller,
            "pay2_version": 2, "cipher_hash": hex0x(&[0x22; 32]), "moderator": self.relayer.id(),
            "near": { "token": self.usdc.id(), "price": PRICE.to_string(), "remainder": 0, "recipients": [
                { "identity": { "kind": "evm", "id": self.pay_to() }, "bps": 9500 },
                { "identity": { "kind": "near", "id": self.platform.id() }, "bps": 500 },
            ]},
            "base": { "usdc": USDC, "price": PRICE.to_string(), "pay_to": self.pay_to() },
        })
    }

    fn register_args(&self, file: &str, seller: Value) -> Value {
        json!({ "terms": self.terms(file, seller), "seller_key": hex0x(&[0x33; 48]), "deadline": DEADLINE })
    }

    async fn text(&self, method: &str, args: &Value) -> anyhow::Result<String> {
        Ok(self
            .annon
            .view(method)
            .args_json(json!({ "args": args }))
            .await?
            .json()?)
    }

    async fn register(&self, file: &str) -> anyhow::Result<ExecutionFinalResult> {
        self.register_by(&self.relayer, file, NearToken::from_millinear(20))
            .await
    }

    async fn register_by(
        &self,
        by: &Account,
        file: &str,
        deposit: NearToken,
    ) -> anyhow::Result<ExecutionFinalResult> {
        let args = self.register_args(file, self.seller.id());
        let text = self.text("register_text", &args).await?;
        Ok(by
            .call(self.annon.id(), "register")
            .args_json(json!({ "args": args, "auth": self.seller.auth(&text) }))
            .deposit(deposit)
            .gas(Gas::from_tgas(100))
            .transact()
            .await?)
    }

    async fn terms_hash(&self, file: &str) -> anyhow::Result<String> {
        let f: Value = self
            .annon
            .view("get_file")
            .args_json(json!({ "file_id": file }))
            .await?
            .json()?;
        Ok(f["terms_hash"].as_str().unwrap().into())
    }

    async fn purchase(&self, file: &str, route: u8) -> anyhow::Result<Purchase> {
        let (network, asset) = if route == 0 {
            ("near:mainnet".to_string(), self.usdc.id().to_string())
        } else {
            ("eip155:8453".to_string(), USDC.to_string())
        };
        Ok(Purchase {
            refund: self.buyer.id(),
            network,
            contract: self.annon.id().to_string(),
            route,
            asset,
            file_id: file.into(),
            terms_hash: self.terms_hash(file).await?,
            price: PRICE,
            nonce: [0x55; 32],
            buyer_key: G1.into(),
            recovery: self.buyer.id(),
            expires_at: DEADLINE,
        })
    }

    /// The USDC `AuthorizationUsed` and `Transfer` of one Base payment for `p`.
    fn payment_logs(&self, p: &Purchase) -> Value {
        json!([
            log(
                USDC,
                7,
                vec![
                    hex::encode(keccak(AUTH_USED.as_bytes())),
                    topic_address(&self.buyer.address()),
                    hex::encode(p.base_nonce())
                ],
                "0x".into()
            ),
            log(
                USDC,
                8,
                vec![
                    hex::encode(keccak(TRANSFER.as_bytes())),
                    topic_address(&self.buyer.address()),
                    topic_address(&self.pay_to())
                ],
                format!("0x{PRICE:064x}")
            ),
        ])
    }

    async fn unlock(
        &self,
        by: &Account,
        p: &Purchase,
        logs: Value,
        deposit: NearToken,
        tgas: u64,
    ) -> anyhow::Result<ExecutionFinalResult> {
        Ok(by
            .call(self.annon.id(), "unlock")
            .args_json(json!({ "args": { "purchase": p.message(), "logs": logs } }))
            .deposit(deposit)
            .gas(Gas::from_tgas(tgas))
            .transact()
            .await?)
    }

    /// `amount` of NEAR USDC sent to Annon with `msg`, through the token's `ft_transfer_call`.
    async fn pay_near(&self, amount: u128, msg: &str) -> anyhow::Result<ExecutionFinalResult> {
        Ok(self
            .payer
            .call(self.usdc.id(), "ft_transfer_call")
            .args_json(
                json!({ "receiver_id": self.annon.id(), "amount": amount.to_string(), "msg": msg }),
            )
            .deposit(NearToken::from_yoctonear(1))
            .gas(Gas::from_tgas(300))
            .transact()
            .await?)
    }

    async fn fund_reserve(&self) -> anyhow::Result<()> {
        self.relayer
            .call(self.annon.id(), "fund_receiver_reserve")
            .deposit(NearToken::from_near(1))
            .transact()
            .await?
            .into_result()?;
        Ok(())
    }

    async fn keeper(
        &self,
        method: &str,
        args: Value,
        tgas: u64,
    ) -> anyhow::Result<ExecutionFinalResult> {
        Ok(self
            .relayer
            .call(self.annon.id(), method)
            .args_json(args)
            .gas(Gas::from_tgas(tgas))
            .transact()
            .await?)
    }

    async fn delivery(&self, id: u64) -> anyhow::Result<Value> {
        Ok(self
            .annon
            .view("get_delivery")
            .args_json(json!({ "delivery_id": id }))
            .await?
            .json()?)
    }

    async fn ft_balance(&self, of: &str) -> anyhow::Result<u128> {
        let b: String = self
            .usdc
            .view("ft_balance_of")
            .args_json(json!({ "account_id": of }))
            .await?
            .json()?;
        Ok(b.parse()?)
    }

    async fn intents_balance(&self, of: &str) -> anyhow::Result<u128> {
        let b: String = self
            .intents
            .view("mt_balance_of")
            .args_json(
                json!({ "account_id": of, "token_id": format!("nep141:{}", self.usdc.id()) }),
            )
            .await?
            .json()?;
        Ok(b.parse()?)
    }

    async fn set_mode(&self, c: &Contract, mode: &str) -> anyhow::Result<()> {
        c.call("set_mode")
            .args_json(json!({ "mode": mode }))
            .transact()
            .await?
            .into_result()?;
        Ok(())
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

    async fn bought(&self, p: &Purchase) -> anyhow::Result<bool> {
        let v: Value = self
            .annon
            .view("get_purchase")
            .args_json(json!({ "purchase_id": p.id_hex() }))
            .await?
            .json()?;
        Ok(!v.is_null())
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
            json!({ "mpc": attacker.id(), "ckd_domain": 2, "foreign_tx_domain": 3, "usdc": USDC }),
        )
        .transact()
        .await?;
    assert!(out.is_failure(), "an outsider initialized the contract");
    Ok(())
}

#[tokio::test]
async fn callbacks_are_private() -> anyhow::Result<()> {
    let w = world().await?;
    for (method, args) in [
        (
            "on_key_released",
            json!({ "file_id": w.file(1), "key": G1, "reason": "claim", "who": "x" }),
        ),
        ("on_funded", json!({ "delivery_id": 0, "attempt": 1 })),
        (
            "on_paid",
            json!({ "delivery_id": 0, "slot": 0, "attempt": 1 }),
        ),
    ] {
        let out = w
            .relayer
            .call(w.annon.id(), method)
            .args_json(args)
            .transact()
            .await?;
        assert!(out.is_failure(), "{method} is callable from outside");
    }
    Ok(())
}

#[tokio::test]
async fn sellers_of_every_kind_register_and_get_the_key() -> anyhow::Result<()> {
    let w = world().await?;
    let out = w.register(&w.file(1)).await?;
    assert!(out.is_success(), "{:?}", out.failures());
    let a = answer(&out);
    assert_eq!(a["big_y"], "bls12381g1:mockY");
    assert!(a["big_c"]
        .as_str()
        .unwrap()
        .ends_with(&format!("file/{}", "01".repeat(32))));
    assert_eq!(events(&out, "file_registered").len(), 1);
    assert_eq!(events(&out, "key_released")[0]["reason"], "register");
    println!("register (EVM seller): {} Tgas burnt", tgas(&out));

    // A Solana seller: the host's ed25519_verify over the UTF-8 text.
    use ed25519_dalek::Signer;
    let sol = ed25519_dalek::SigningKey::from_bytes(&[4; 32]);
    let id = json!({ "kind": "solana", "id": hex::encode(sol.verifying_key().to_bytes()) });
    let args = w.register_args(&w.file(2), id);
    let text = w.text("register_text", &args).await?;
    let sig = hex0x(&sol.sign(text.as_bytes()).to_bytes());
    let out = w
        .relayer
        .call(w.annon.id(), "register")
        .args_json(json!({ "args": args, "auth": { "kind": "solana", "sig": sig } }))
        .deposit(NearToken::from_millinear(20))
        .gas(Gas::from_tgas(100))
        .transact()
        .await?;
    assert!(out.is_success(), "{:?}", out.failures());
    println!("register (Solana seller): {} Tgas burnt", tgas(&out));

    // A NEAR seller calls itself; nobody else can register for it.
    let id = json!({ "kind": "near", "id": w.platform.id() });
    let args = w.register_args(&w.file(3), id);
    let out = w
        .relayer
        .call(w.annon.id(), "register")
        .args_json(json!({ "args": args }))
        .deposit(NearToken::from_millinear(20))
        .gas(Gas::from_tgas(100))
        .transact()
        .await?;
    assert!(out.is_failure());
    let out = w
        .platform
        .call(w.annon.id(), "register")
        .args_json(json!({ "args": args }))
        .deposit(NearToken::from_millinear(20))
        .gas(Gas::from_tgas(100))
        .transact()
        .await?;
    assert!(out.is_success(), "{:?}", out.failures());
    Ok(())
}

#[tokio::test]
async fn a_base_purchase_releases_the_key_with_the_minimum_gas() -> anyhow::Result<()> {
    let w = world().await?;
    let file = w.file(2);
    w.register(&file).await?.into_result()?;
    let p = w.purchase(&file, 1).await?;
    let out = w
        .unlock(
            &w.relayer,
            &p,
            w.payment_logs(&p),
            NearToken::from_millinear(10),
            150,
        )
        .await?;
    assert!(out.is_success(), "{:?}", out.failures());
    assert_eq!(
        answer(&out)["big_y"],
        "bls12381g1:mockY",
        "unlock must return the CKD answer"
    );
    let paid = &events(&out, "payment_verified")[0];
    assert_eq!(paid["payer"], w.buyer.address());
    assert_eq!(paid["purchase_id"], p.id_hex());
    assert_eq!(events(&out, "key_released")[0]["reason"], "unlock");
    assert!(w.bought(&p).await?);
    let used: bool = w
        .annon
        .view("is_payment_used")
        .args_json(json!({ "base_tx": paid["base_tx"], "log_index": paid["log_index"] }))
        .await?
        .json()?;
    assert!(used, "the payment must show as used after unlock");
    println!("unlock: {} Tgas burnt of 150 attached", tgas(&out));
    assert!(tgas(&out) < 120, "unlock burnt {} Tgas", tgas(&out));
    Ok(())
}

#[tokio::test]
async fn a_failed_check_refunds_the_reservation_and_the_payment_can_be_retried(
) -> anyhow::Result<()> {
    let w = world().await?;
    let file = w.file(4);
    w.register(&file).await?.into_result()?;
    w.relayer
        .call(w.annon.id(), "storage_deposit")
        .args_json(json!({}))
        .deposit(NearToken::from_millinear(100))
        .transact()
        .await?
        .into_result()?;
    let start = w.balance(&w.relayer).await?;
    let p = w.purchase(&file, 1).await?;

    for bad in ["fail", "wrong_hash"] {
        w.mode(bad, "ok").await?;
        let out = w
            .unlock(
                &w.relayer,
                &p,
                w.payment_logs(&p),
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
        assert!(!w.bought(&p).await?);
    }

    w.mode("ok", "ok").await?;
    let out = w
        .unlock(
            &w.relayer,
            &p,
            w.payment_logs(&p),
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
    println!("storage for one Base purchase: {spent} yoctoNEAR");
    assert!(spent > 0 && spent < NearToken::from_millinear(10).as_yoctonear());
    Ok(())
}

#[tokio::test]
async fn a_failed_key_release_keeps_the_purchase_and_the_buyer_gets_the_key_later(
) -> anyhow::Result<()> {
    let w = world().await?;
    let file = w.file(5);
    w.register(&file).await?.into_result()?;
    let p = w.purchase(&file, 1).await?;
    w.mode("ok", "fail").await?;
    let out = w
        .unlock(
            &w.relayer,
            &p,
            w.payment_logs(&p),
            NearToken::from_millinear(10),
            150,
        )
        .await?;
    assert_eq!(events(&out, "payment_verified").len(), 1);
    assert!(
        events(&out, "key_released").is_empty(),
        "no receipt without a key"
    );
    assert!(answer(&out)["error"]
        .as_str()
        .unwrap()
        .contains("ask again"));
    assert!(w.bought(&p).await?);

    w.mode("ok", "ok").await?;
    let out = w
        .keeper("claim_key", json!({ "purchase_id": p.id_hex() }), 100)
        .await?;
    assert!(out.is_success(), "{:?}", out.failures());
    assert_eq!(events(&out, "key_released")[0]["reason"], "claim");
    println!("claim_key: {} Tgas burnt", tgas(&out));

    // A new device: the recovery wallet adds a grant for a fresh key. The same request again
    // gives the same grant.
    let args = json!({ "purchase_id": p.id_hex(), "fresh_key": G1X2, "nonce": hex0x(&[7; 32]), "deadline": DEADLINE });
    let text = w.text("reopen_text", &args).await?;
    for _ in 0..2 {
        let out = w
            .relayer
            .call(w.annon.id(), "reopen")
            .args_json(json!({ "args": args, "auth": w.buyer.auth(&text) }))
            .deposit(NearToken::from_millinear(10))
            .gas(Gas::from_tgas(100))
            .transact()
            .await?;
        assert!(out.is_success(), "{:?}", out.failures());
        assert_eq!(events(&out, "key_released")[0]["grant"], 1);
    }
    let v: Value = w
        .annon
        .view("get_purchase")
        .args_json(json!({ "purchase_id": p.id_hex() }))
        .await?
        .json()?;
    assert_eq!(v["grants"], 2);

    // The seller's own reopen runs once per one-time key.
    let args = json!({ "file_id": file, "key": G1X2, "deadline": DEADLINE });
    let text = w.text("reopen_seller_text", &args).await?;
    let send = || {
        w.relayer
            .call(w.annon.id(), "reopen_seller")
            .args_json(json!({ "args": args, "auth": w.seller.auth(&text) }))
            .deposit(NearToken::from_millinear(10))
            .gas(Gas::from_tgas(100))
            .transact()
    };
    assert_eq!(
        events(&send().await?, "key_released")[0]["reason"],
        "reopen"
    );
    let again = send().await?;
    assert!(format!("{:?}", again.failures()).contains("already used"));
    Ok(())
}

#[tokio::test]
async fn a_function_call_key_registers_and_unlocks_from_a_prepaid_balance_but_cannot_withdraw(
) -> anyhow::Result<()> {
    let w = world().await?;
    let file = w.file(6);
    w.register(&file).await?.into_result()?;
    w.relayer
        .call(w.annon.id(), "storage_deposit")
        .args_json(json!({}))
        .deposit(NearToken::from_millinear(100))
        .transact()
        .await?
        .into_result()?;

    // The relayer's hot key: function-call only, limited to the methods it relays.
    let hot = SecretKey::from_random(near_workspaces::types::KeyType::ED25519);
    w.relayer
        .batch(w.relayer.id())
        .add_key(
            hot.public_key(),
            AccessKey::function_call_access(
                w.annon.id(),
                &[
                    "register",
                    "unlock",
                    "reopen",
                    "reopen_seller",
                    "stop_sales",
                    "claim_key",
                    "fund_delivery",
                    "pay_slot",
                ],
                None,
            ),
        )
        .transact()
        .await?
        .into_result()?;
    let agent = Account::from_secret_key(w.relayer.id().clone(), hot, &w.worker);

    let before = w.balance(&w.relayer).await?;
    let out = w
        .register_by(&agent, &w.file(7), NearToken::from_yoctonear(0))
        .await?;
    assert!(out.is_success(), "{:?}", out.failures());
    let used = before - w.balance(&w.relayer).await?;
    assert!(
        used > 0 && used < NearToken::from_millinear(10).as_yoctonear(),
        "register took {used} yocto"
    );
    println!("register from the prepaid balance: {used} yoctoNEAR of storage");

    let p = w.purchase(&file, 1).await?;
    let out = w
        .unlock(
            &agent,
            &p,
            w.payment_logs(&p),
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
    w.register(&file).await?.into_result()?; // moderator: the relayer account
    w.relayer
        .call(w.annon.id(), "takedown")
        .args_json(json!({ "file_id": file, "reason": "court_order" }))
        .deposit(NearToken::from_yoctonear(1))
        .transact()
        .await?
        .into_result()?;
    let p = w.purchase(&file, 1).await?;
    let out = w
        .unlock(
            &w.relayer,
            &p,
            w.payment_logs(&p),
            NearToken::from_millinear(10),
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
            &p,
            w.payment_logs(&p),
            NearToken::from_millinear(10),
            150,
        )
        .await?;
    assert_eq!(events(&out, "key_released").len(), 1);
    Ok(())
}

/// A real Base header (specs/vectors/base-headers.json) and the log fields that name its block.
fn real_header(i: usize) -> (String, String, u64) {
    let v: Value =
        serde_json::from_str(include_str!("../../../specs/vectors/base-headers.json")).unwrap();
    let c = &v["cases"][i];
    (
        c["rlp"].as_str().unwrap().into(),
        c["hash"].as_str().unwrap()[2..].into(),
        c["number"].as_u64().unwrap(),
    )
}

#[tokio::test]
async fn after_a_stop_unlock_reads_the_payment_time_from_the_real_block_header(
) -> anyhow::Result<()> {
    let w = world().await?;
    let file = w.file(9);
    w.register(&file).await?.into_result()?;
    let stop = json!({ "file_id": file, "deadline": DEADLINE });
    let text = w.text("stop_sales_text", &stop).await?;
    w.relayer
        .call(w.annon.id(), "stop_sales")
        .args_json(json!({ "args": stop, "auth": w.seller.auth(&text) }))
        .transact()
        .await?
        .into_result()?;

    // The payment sits in a real Base block from before the stop (3 Nov 2026).
    let p = w.purchase(&file, 1).await?;
    let (header, hash, number) = real_header(0);
    let mut logs = w.payment_logs(&p);
    for i in 0..2 {
        logs[i]["block_hash"] = json!(hash);
        logs[i]["block_number"] = json!(number);
    }
    let send = |header: Option<String>| {
        w.relayer
            .call(w.annon.id(), "unlock")
            .args_json(
                json!({ "args": { "purchase": p.message(), "logs": logs, "header": header } }),
            )
            .deposit(NearToken::from_millinear(10))
            .gas(Gas::from_tgas(150))
            .transact()
    };
    let without = send(None).await?;
    assert!(format!("{:?}", without.failures()).contains("send the payment's block header"));
    let (other, ..) = real_header(4);
    let wrong = send(Some(other)).await?;
    assert!(format!("{:?}", wrong.failures()).contains("the header is not the payment's block"));
    assert!(!w.bought(&p).await?, "a refused unlock records nothing");

    let out = send(Some(header)).await?;
    assert!(out.is_success(), "{:?}", out.failures());
    assert!(w.bought(&p).await?);
    println!(
        "unlock with a header after a stop: {} Tgas burnt",
        tgas(&out)
    );
    assert!(tgas(&out) < 120, "unlock burnt {} Tgas", tgas(&out));
    Ok(())
}

#[tokio::test]
async fn a_near_purchase_is_split_through_intents_and_releases_the_key() -> anyhow::Result<()> {
    let w = world().await?;
    let file = w.file(10);
    w.register(&file).await?.into_result()?;
    w.fund_reserve().await?;
    let p = w.purchase(&file, 0).await?;
    let start = w.ft_balance(w.payer.id().as_str()).await?;

    // The real NEP-141 chain; the host checks the buyer key (BLS12-381) on the way.
    let out = w.pay_near(PRICE + 2_000, &p.message()).await?;
    assert!(out.is_success(), "{:?}", out.failures());
    assert_eq!(
        answer(&out),
        json!((PRICE + 2_000).to_string()),
        "the contract keeps all of it"
    );
    assert_eq!(
        events(&out, "purchase_accepted")[0]["purchase_id"],
        p.id_hex()
    );
    println!(
        "NEAR purchase through ft_transfer_call: {} Tgas burnt",
        tgas(&out)
    );
    assert_eq!(
        w.ft_balance(w.payer.id().as_str()).await?,
        start - PRICE - 2_000
    );
    assert!(w.bought(&p).await?);

    let out = w
        .keeper("claim_key", json!({ "purchase_id": p.id_hex() }), 100)
        .await?;
    assert_eq!(answer(&out)["big_y"], "bls12381g1:mockY");

    let out = w
        .keeper("fund_delivery", json!({ "delivery_id": 0 }), 150)
        .await?;
    assert!(out.is_success(), "{:?}", out.failures());
    println!("fund_delivery: {} Tgas burnt", tgas(&out));
    assert_eq!(w.delivery(0).await?["fund"]["state"], 2);
    assert_eq!(
        w.intents_balance(w.annon.id().as_str()).await?,
        PRICE + 2_000
    );

    for slot in 0..3 {
        let out = w
            .keeper("pay_slot", json!({ "delivery_id": 0, "slot": slot }), 80)
            .await?;
        assert!(out.is_success(), "{:?}", out.failures());
        assert_eq!(events(&out, "slot_paid").len(), 1, "slot {slot}");
        println!("pay_slot {slot}: {} Tgas burnt", tgas(&out));
    }
    assert_eq!(w.intents_balance(&w.pay_to()).await?, 9_500);
    assert_eq!(w.intents_balance(w.platform.id().as_str()).await?, 500);
    assert_eq!(
        w.intents_balance(&w.buyer.address()).await?,
        2_000,
        "the excess back to the refund identity"
    );
    assert_eq!(w.intents_balance(w.annon.id().as_str()).await?, 0);
    let again = w
        .keeper("pay_slot", json!({ "delivery_id": 0, "slot": 0 }), 80)
        .await?;
    assert!(again.is_failure(), "a paid slot was paid again");
    Ok(())
}

#[tokio::test]
async fn refunds_are_automatic_and_foreign_messages_bounce() -> anyhow::Result<()> {
    let w = world().await?;
    let file = w.file(11);
    w.register(&file).await?.into_result()?;
    w.fund_reserve().await?;
    let p = w.purchase(&file, 0).await?;
    let start = w.ft_balance(w.payer.id().as_str()).await?;

    // Not an Annon purchase: NEP-141 sends it all back to the payer.
    let out = w.pay_near(PRICE, "hello").await?;
    assert_eq!(answer(&out), json!("0"));
    assert_eq!(w.ft_balance(w.payer.id().as_str()).await?, start);

    // Underpaid: kept, and owed back to the refund identity.
    let out = w.pay_near(PRICE - 1, &p.message()).await?;
    assert_eq!(answer(&out), json!((PRICE - 1).to_string()));
    assert_eq!(events(&out, "refund_due")[0]["reason"], 9);
    assert!(!w.bought(&p).await?);

    // A buyer key off the curve, checked by the host: refunded too.
    let bad = Purchase {
        buyer_key: hex0x(&[0x33; 48]),
        ..w.purchase(&file, 0).await?
    };
    let out = w.pay_near(PRICE, &bad.message()).await?;
    assert_eq!(events(&out, "refund_due")[0]["reason"], 1);

    // Funding refused by Intents: nothing counted, retried later in full.
    w.set_mode(&w.intents, "refuse_deposit").await?;
    w.keeper("fund_delivery", json!({ "delivery_id": 0 }), 150)
        .await?
        .into_result()?;
    let d = w.delivery(0).await?;
    assert_eq!(
        (d["fund"]["state"].clone(), d["funded"].clone()),
        (json!(0), json!("0"))
    );
    w.set_mode(&w.intents, "ok").await?;
    w.keeper("fund_delivery", json!({ "delivery_id": 0 }), 150)
        .await?
        .into_result()?;

    // A failed transfer: pending again, paid on retry, never twice.
    w.set_mode(&w.intents, "fail_mt").await?;
    w.keeper("pay_slot", json!({ "delivery_id": 0, "slot": 0 }), 80)
        .await?
        .into_result()?;
    assert_eq!(w.delivery(0).await?["slots"][0]["step"]["state"], 0);
    w.set_mode(&w.intents, "ok").await?;
    w.keeper("pay_slot", json!({ "delivery_id": 0, "slot": 0 }), 80)
        .await?
        .into_result()?;
    assert_eq!(w.intents_balance(&w.buyer.address()).await?, PRICE - 1);
    Ok(())
}

#[tokio::test]
async fn without_a_reserve_a_refund_waits_in_the_tree_until_someone_materializes_it(
) -> anyhow::Result<()> {
    let w = world().await?;
    let file = w.file(12);
    w.register(&file).await?.into_result()?;
    let p = w.purchase(&file, 0).await?;
    let out = w.pay_near(PRICE, &p.message()).await?;
    assert_eq!(answer(&out), json!(PRICE.to_string()));
    let leaf = &events(&out, "refund_leaf")[0];
    let count: u64 = w.annon.view("delivery_count").await?.json()?;
    assert_eq!(count, 1, "a leaf keeps its delivery id");
    assert!(w.delivery(0).await?.is_null());
    assert!(!w.bought(&p).await?, "no storage, no purchase");
    println!("delivery into the refund tree: {} Tgas burnt", tgas(&out));

    // A tree with one leaf: its proof is the empty subtrees.
    let mut zero = [0u8; 32];
    let mut proof = vec![];
    for _ in 0..32 {
        proof.push(hex0x(&zero));
        let mut h = Sha256::new();
        h.update([1u8]);
        h.update(zero);
        h.update(zero);
        zero = h.finalize().into();
    }
    let out = w.relayer.call(w.annon.id(), "materialize_refund")
        .args_json(json!({ "leaf": { "delivery_id": leaf["delivery_id"], "refund": w.buyer.id(), "amount": PRICE.to_string() },
            "index": 0, "proof": proof }))
        .deposit(NearToken::from_millinear(20)).gas(Gas::from_tgas(100)).transact().await?;
    assert!(out.is_success(), "{:?}", out.failures());
    assert_eq!(
        w.delivery(0).await?["slots"][0]["amount"],
        PRICE.to_string()
    );
    Ok(())
}
