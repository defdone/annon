//! Live mainnet bytecode imported read-only into a fresh local sandbox; no mainnet signer.
//! Run after build.sh: cargo test -p annon --test mainnet_contracts -- --nocapture
//! Initializers: circlefin/stablecoin-near src/fiat_token.rs and fiat_token_action.rs;
//! near/intents contracts/defuse/src/contract/{mod.rs,config.rs}, core/src/fees.rs.
use near_workspaces::result::ExecutionFinalResult;
use near_workspaces::types::{Gas, NearToken};
use near_workspaces::{Account, Contract};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
const TOKEN: &str = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
const G1: &str = "0x97f1d3a73197d7942695638c4fa9ac0fc3688c4f9774b905a14e3a3f171bac586c55e83ff97a1aeffb3af00adb22c6bb";
fn hex0x(b: &[u8]) -> String {
    format!("0x{}", hex::encode(b))
}
fn unhex(s: &str) -> Vec<u8> {
    hex::decode(s.trim_start_matches("0x")).unwrap()
}
fn wasm(name: &str) -> Vec<u8> {
    std::fs::read(format!(
        "{}/../../target/wasm32-unknown-unknown/release/{name}.wasm",
        env!("CARGO_MANIFEST_DIR")
    ))
    .unwrap()
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
#[derive(Clone)]
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
}

async fn call(
    by: &Account,
    to: &Contract,
    method: &str,
    args: Value,
    gas: u64,
    yocto: u128,
) -> anyhow::Result<ExecutionFinalResult> {
    Ok(by
        .call(to.id(), method)
        .args_json(args)
        .gas(Gas::from_tgas(gas))
        .deposit(NearToken::from_yoctonear(yocto))
        .transact()
        .await?)
}
async fn multisig(token: &Contract, a: &Account, b: &Account, action: Value) -> anyhow::Result<()> {
    let id: u32 = call(
        a,
        token,
        "create_multisig_request",
        json!({"action": action}),
        50,
        0,
    )
    .await?
    .into_result()?
    .json()?;
    for by in [a, b] {
        call(
            by,
            token,
            "approve_multisig_request",
            json!({"request_id": id}),
            50,
            0,
        )
        .await?
        .into_result()?;
    }
    call(
        a,
        token,
        "execute_multisig_request",
        json!({"request_id": id}),
        50,
        0,
    )
    .await?
    .into_result()?;
    Ok(())
}
fn measure(label: &str, out: &ExecutionFinalResult, annon: &Contract) {
    println!(
        "GAS {label}: total={:.6} Tgas",
        out.total_gas_burnt.as_gas() as f64 / 1e12
    );
    let own: Vec<_> = out
        .receipt_outcomes()
        .iter()
        .filter(|r| r.executor_id == *annon.id())
        .collect();
    for (i, r) in out.receipt_outcomes().iter().enumerate() {
        println!(
            "RECEIPT {label} {i}: executor={} gas={:.6} Tgas success={}",
            r.executor_id,
            r.gas_burnt.as_gas() as f64 / 1e12,
            r.is_success()
        );
    }
    // Refund receipts on the same account burn zero gas; the callback is the last nonzero one.
    if label.starts_with("fund") || label.starts_with("pay") {
        let callback = own.iter().rev().find(|r| r.gas_burnt.as_gas() > 0).unwrap();
        let burnt = callback.gas_burnt.as_gas() as f64 / 1e12;
        println!(
            "CALLBACK {label}: burnt={burnt:.6} allowance=15 margin={:.6} Tgas",
            15.0 - burnt
        );
        assert!(callback.is_success());
        assert!(burnt < 15.0);
    }
}
async fn delivery(annon: &Contract) -> anyhow::Result<Value> {
    Ok(annon
        .view("get_delivery")
        .args_json(json!({"delivery_id":0}))
        .await?
        .json()?)
}
async fn mt(intents: &Contract, account: &str) -> anyhow::Result<u128> {
    let v: String = intents
        .view("mt_balance_of")
        .args_json(json!({"account_id":account,"token_id":format!("nep141:{TOKEN}")}))
        .await?
        .json()?;
    Ok(v.parse()?)
}
#[tokio::test]
async fn real_mainnet_token_and_intents_maximum_delivery() -> anyhow::Result<()> {
    // Only reads go to this worker; every call() below uses a sandbox Account/Contract.
    let mainnet = near_workspaces::mainnet()
        .rpc_addr("https://rpc.mainnet.fastnear.com")
        .await?;
    let block = mainnet.view_block().await?;
    println!(
        "MAINNET snapshot height={} hash={}",
        block.height(),
        block.hash()
    );
    let sandbox = near_workspaces::sandbox().await?;
    println!(
        "PROTOCOL mainnet={} sandbox={}",
        block.header().latest_protocol_version(),
        sandbox
            .view_block()
            .await?
            .header()
            .latest_protocol_version()
    );
    println!(
        "ANNON wasm sha256={}",
        hex0x(&Sha256::digest(wasm("annon")))
    );
    let token_id = TOKEN.parse()?;
    let intents_id = "intents.near".parse()?;
    for id in [&token_id, &intents_id] {
        let code = mainnet.view_code(id).block_height(block.height()).await?;
        println!(
            "MAINNET code account={id} sha256={}",
            hex0x(&Sha256::digest(&code))
        );
    }
    let token = sandbox
        .import_contract(&token_id, &mainnet)
        .block_height(block.height())
        .initial_balance(NearToken::from_near(1_000_000_000))
        .transact()
        .await?;
    let intents = sandbox
        .import_contract(&intents_id, &mainnet)
        .block_height(block.height())
        .initial_balance(NearToken::from_near(1_000_000_000))
        .transact()
        .await?;
    let a = sandbox.dev_create_account().await?;
    let b = sandbox.dev_create_account().await?;
    let payer = sandbox.dev_create_account().await?;
    let mpc = sandbox.dev_deploy(&wasm("mock_mpc")).await?;
    let annon = sandbox.dev_deploy(&wasm("annon")).await?;
    let admins = json!([a.id(), b.id()]);
    token.call("init").args_json(json!({"admin_ids":admins,"master_minter_ids":admins,"owner_ids":admins,"pauser_ids":admins,
      "blocklister_id":a.id(),"metadata":{"spec":"ft-1.0.0","name":"USD Coin","symbol":"USDC","decimals":6}})).transact().await?.into_result()?;
    intents.call("new").args_json(json!({"config":{"wnear_id":"wrap.near","fees":{"fee":0,"fee_collector":a.id()},
      "roles":{"super_admins":[a.id()],"grantees":{"UnrestrictedAccountLocker":[a.id()],"UnrestrictedAccountUnlocker":[a.id()]}}}})).transact().await?.into_result()?;
    // The real USDC requires two approvals, including two controllers for a minter.
    for by in [&a, &b] {
        multisig(
            &token,
            &a,
            &b,
            json!({"ConfigureController":{"controller_id":by.id(),"minter_id":a.id()}}),
        )
        .await?;
    }
    multisig(
        &token,
        &a,
        &b,
        json!({"ConfigureMinterAllowance":{"controller_id":a.id(),"minter_allowance":"1000000"}}),
    )
    .await?;
    for id in [payer.id(), annon.id(), intents.id()] {
        call(
            &a,
            &token,
            "storage_deposit",
            json!({"account_id":id}),
            50,
            NearToken::from_millinear(10).as_yoctonear(),
        )
        .await?
        .into_result()?;
    }
    call(
        &a,
        &token,
        "mint",
        json!({"to":payer.id(),"amount":"1000000"}),
        50,
        0,
    )
    .await?
    .into_result()?;
    annon.call("new").args_json(json!({"mpc":mpc.id(),"ckd_domain":2,"foreign_tx_domain":3,"usdc":format!("0x{}","52".repeat(20)),
      "near_usdc":token.id(),"intents":intents.id()})).transact().await?.into_result()?;
    call(
        &a,
        &annon,
        "fund_receiver_reserve",
        json!({}),
        50,
        NearToken::from_near(1).as_yoctonear(),
    )
    .await?
    .into_result()?;
    let file_id = hex0x(&[11; 32]);
    let evm = format!("0x{}", "11".repeat(20));
    let sol = "22".repeat(32);
    let mut recipients = vec![
        json!({"identity":{"kind":"evm","id":evm},"bps":1250}),
        json!({"identity":{"kind":"solana","id":sol},"bps":1250}),
    ];
    for i in 0..6 {
        recipients
            .push(json!({"identity":{"kind":"near","id":format!("recipient{i}.near")},"bps":1250}));
    }
    let seller = json!({"kind":"near","id":a.id()});
    let terms = json!({"network":"near:mainnet","contract":annon.id(),"file_id":file_id,"seller":seller,"pay2_version":2,
      "cipher_hash":hex0x(&[0x33;32]),"moderator":null,"near":{"token":token.id(),"price":"10000","recipients":recipients,"remainder":0},"base":null});
    call(
        &a,
        &annon,
        "register",
        json!({"args":{"terms":terms,"seller_key":G1,"deadline":4_000_000_000u64}}),
        100,
        NearToken::from_millinear(20).as_yoctonear(),
    )
    .await?
    .into_result()?;
    call(
        &a,
        &annon,
        "publish_header",
        json!({"file_id":file_id,"header_hash":hex0x(&[0x44;32])}),
        50,
        0,
    )
    .await?
    .into_result()?;
    let f: Value = annon
        .view("get_file")
        .args_json(json!({"file_id":file_id}))
        .await?
        .json()?;
    let refund = json!({"kind":"near","id":payer.id()});
    let p = Purchase {
        refund: refund.clone(),
        network: "near:mainnet".into(),
        contract: annon.id().to_string(),
        route: 0,
        asset: TOKEN.into(),
        file_id,
        terms_hash: f["terms_hash"].as_str().unwrap().into(),
        price: 10000,
        nonce: [0x55; 32],
        buyer_key: G1.into(),
        recovery: refund,
        expires_at: 4_000_000_000,
    };
    let pay = |msg: String| {
        call(
            &payer,
            &token,
            "ft_transfer_call",
            json!({"receiver_id":annon.id(),"amount":"12000","msg":msg}),
            150,
            1,
        )
    };
    let out = pay(p.message()).await?;
    measure("receiver-max-9-slots", &out, &annon);
    assert!(out.is_success(), "{:?}", out.failures());
    let accepted: Value = annon
        .view("get_purchase")
        .args_json(json!({"purchase_id":p.id_hex()}))
        .await?
        .json()?;
    assert!(!accepted.is_null());
    assert_eq!(
        delivery(&annon).await?["slots"].as_array().unwrap().len(),
        9
    );
    let out = call(
        &a,
        &annon,
        "fund_delivery",
        json!({"delivery_id":0}),
        150,
        0,
    )
    .await?;
    measure("fund-real-usdc-intents-max", &out, &annon);
    assert!(out.is_success(), "{:?}", out.failures());
    assert_eq!(delivery(&annon).await?["fund"]["state"], 2);
    assert_eq!(mt(&intents, annon.id().as_str()).await?, 12000);
    // Real contract failure, no mocked mode: lock the sender's Intents account.
    call(
        &a,
        &intents,
        "force_lock_account",
        json!({"account_id":annon.id()}),
        50,
        1,
    )
    .await?
    .into_result()?;
    let out = call(
        &a,
        &annon,
        "pay_slot",
        json!({"delivery_id":0,"slot":0}),
        80,
        0,
    )
    .await?;
    measure("pay-real-locked-failure", &out, &annon);
    assert!(!out.receipt_failures().is_empty());
    assert!(out
        .receipt_outcomes()
        .iter()
        .any(|r| r.executor_id == *annon.id()
            && r.is_success()
            && r.logs
                .iter()
                .any(|l| l.contains("\"event\":\"payment_failed\"")
                    && l.contains("\"state\":\"Pending\""))));
    assert_eq!(delivery(&annon).await?["slots"][0]["step"]["state"], 0);
    assert_eq!(mt(&intents, &evm).await?, 0);
    call(
        &a,
        &intents,
        "force_unlock_account",
        json!({"account_id":annon.id()}),
        50,
        1,
    )
    .await?
    .into_result()?;
    for slot in 0..9 {
        let out = call(
            &a,
            &annon,
            "pay_slot",
            json!({"delivery_id":0,"slot":slot}),
            80,
            0,
        )
        .await?;
        measure(&format!("pay-real-slot-{slot}"), &out, &annon);
        assert!(out.is_success(), "{:?}", out.failures());
        if slot < 8 {
            assert_eq!(delivery(&annon).await?["slots"][slot]["step"]["state"], 2);
        } else {
            // The last slot settles the delivery: its record goes, its storage returns to the reserve.
            assert!(
                delivery(&annon).await?.is_null(),
                "a settled delivery is removed"
            );
        }
    }
    assert_eq!(mt(&intents, &evm).await?, 1250);
    // Solana identity maps to lower-case hex in the contract's Intents account id.
    assert_eq!(mt(&intents, &sol).await?, 1250);
    for i in 0..6 {
        assert_eq!(mt(&intents, &format!("recipient{i}.near")).await?, 1250);
    }
    assert_eq!(mt(&intents, payer.id().as_str()).await?, 2000);
    assert_eq!(mt(&intents, annon.id().as_str()).await?, 0);

    // Largest stored delivery: every one of the eight recipients and the refund uses
    // the maximum 64-byte NEAR account id (larger than EVM/Solana identities).
    let max_id = |i: u8| format!("{}{}", "r".repeat(63), i);
    let max_file = hex0x(&[12; 32]);
    let mut max_terms = terms.clone();
    max_terms["file_id"] = json!(max_file);
    max_terms["near"]["recipients"] = json!((0..8)
        .map(|i| json!({"identity":{"kind":"near","id":max_id(i)},"bps":1250}))
        .collect::<Vec<_>>());
    call(
        &a,
        &annon,
        "register",
        json!({"args":{"terms":max_terms,"seller_key":G1,"deadline":4_000_000_000u64}}),
        100,
        NearToken::from_millinear(20).as_yoctonear(),
    )
    .await?
    .into_result()?;
    call(
        &a,
        &annon,
        "publish_header",
        json!({"file_id":max_file,"header_hash":hex0x(&[0x44;32])}),
        50,
        0,
    )
    .await?
    .into_result()?;
    let max_view: Value = annon
        .view("get_file")
        .args_json(json!({"file_id":max_file}))
        .await?
        .json()?;
    let max_p = Purchase {
        file_id: max_file,
        terms_hash: max_view["terms_hash"].as_str().unwrap().into(),
        refund: json!({"kind":"near","id":max_id(8)}),
        recovery: json!({"kind":"near","id":max_id(8)}),
        ..p
    };
    assert!(max_p.message().len() <= 1024);
    let out = pay(max_p.message()).await?;
    measure("receiver-largest-9-max-identities", &out, &annon);
    assert!(out.is_success(), "{:?}", out.failures());
    let max_d: Value = annon
        .view("get_delivery")
        .args_json(json!({"delivery_id":1}))
        .await?
        .json()?;
    assert_eq!(max_d["reason"], 0);
    assert_eq!(max_d["slots"].as_array().unwrap().len(), 9);
    let out = call(
        &a,
        &annon,
        "fund_delivery",
        json!({"delivery_id":1}),
        150,
        0,
    )
    .await?;
    measure("fund-largest-9-max-identities", &out, &annon);
    assert!(out.is_success(), "{:?}", out.failures());
    for slot in 0..9 {
        let out = call(
            &a,
            &annon,
            "pay_slot",
            json!({"delivery_id":1,"slot":slot}),
            80,
            0,
        )
        .await?;
        measure(&format!("pay-largest-slot-{slot}"), &out, &annon);
        assert!(out.is_success(), "{:?}", out.failures());
        assert_eq!(
            mt(&intents, &max_id(slot)).await?,
            if slot == 8 { 2000 } else { 1250 }
        );
    }
    assert_eq!(mt(&intents, annon.id().as_str()).await?, 0);
    // A whole snapshot sweep remains complete while first/middle/last removals swap the live
    // index. Every page uses the same block, including pages fetched after the removals.
    for i in 0..6 {
        let p = Purchase {
            nonce: [0x60 + i; 32],
            ..max_p.clone()
        };
        let out = pay(p.message()).await?;
        assert!(out.is_success(), "{:?}", out.failures());
    }
    sandbox.fast_forward(3).await?;
    let snapshot = *sandbox.view_block().await?.header().last_final_block();
    let count: u64 = annon
        .view("open_delivery_count")
        .block_hash(snapshot)
        .await?
        .json()?;
    assert_eq!(count, 6);
    let mut visited = vec![];
    for (from, (id, position)) in [(2, "first"), (4, "middle"), (5, "last")]
        .into_iter()
        .enumerate()
    {
        let page: Vec<Value> = annon
            .view("list_open_deliveries")
            .args_json(json!({"from":from * 2,"limit":2}))
            .block_hash(snapshot)
            .await?
            .json()?;
        visited.extend(page.iter().map(|d| d["id"].as_u64().unwrap()));
        let out = call(&a, &annon, "settle", json!({"delivery_id":id}), 600, 0).await?;
        measure(&format!("settle-largest-index-{position}"), &out, &annon);
        assert!(out.is_success(), "{:?}", out.failures());
        let settled = out
            .receipt_outcomes()
            .iter()
            .find(|r| {
                r.executor_id == *annon.id()
                    && r.logs
                        .iter()
                        .any(|l| l.contains("\"event\":\"delivery_settled\""))
            })
            .unwrap();
        let burnt = settled.gas_burnt.as_gas() as f64 / 1e12;
        println!(
            "FINAL_CALLBACK index-{position}: burnt={burnt:.6} allowance=15 margin={:.6} Tgas",
            15.0 - burnt
        );
        assert!(settled.is_success() && burnt < 15.0);
    }
    visited.sort_unstable();
    assert_eq!(visited, vec![2, 3, 4, 5, 6, 7]);
    let live: Vec<Value> = annon
        .view("list_open_deliveries")
        .args_json(json!({"from":0,"limit":50}))
        .await?
        .json()?;
    assert!(live
        .iter()
        .all(|d| visited.contains(&d["id"].as_u64().unwrap())));
    // The already-funded route dispatches directly; a second keeper cannot pay twice.
    let out = call(
        &a,
        &annon,
        "fund_delivery",
        json!({"delivery_id":3}),
        150,
        0,
    )
    .await?;
    assert!(out.is_success(), "{:?}", out.failures());
    // Fault injection with the sandbox-only contract signer: run the private dispatcher with
    // insufficient gas. The earlier funding callback must survive the failing receipt.
    let out = call(
        annon.as_account(),
        &annon,
        "dispatch_delivery",
        json!({"delivery_id":3}),
        1,
        0,
    )
    .await?;
    assert!(!out.is_success());
    let d: Value = annon
        .view("get_delivery")
        .args_json(json!({"delivery_id":3}))
        .await?
        .json()?;
    assert_eq!(d["fund"]["state"], 2);
    assert_eq!(d["funded"], "12000");
    assert!(d["slots"]
        .as_array()
        .unwrap()
        .iter()
        .all(|s| s["step"]["state"] == 0));
    let out = call(
        &a,
        &annon,
        "pay_slot",
        json!({"delivery_id":3,"slot":0}),
        80,
        0,
    )
    .await?;
    assert!(out.is_success(), "{:?}", out.failures());
    let out = call(&a, &annon, "settle", json!({"delivery_id":3}), 450, 0).await?;
    measure("settle-largest-already-funded", &out, &annon);
    assert!(out.is_success(), "{:?}", out.failures());
    let out = call(&b, &annon, "settle", json!({"delivery_id":3}), 600, 0).await?;
    assert!(out.is_success());
    // The four newly settled maximum deliveries add exactly four shares/refunds, not five.
    for slot in 0..9 {
        assert_eq!(
            mt(&intents, &max_id(slot)).await?,
            5 * if slot == 8 { 2000 } else { 1250 }
        );
    }
    for id in [6, 7] {
        let out = call(&a, &annon, "settle", json!({"delivery_id":id}), 600, 0).await?;
        assert!(out.is_success(), "{:?}", out.failures());
    }
    let before: String = token
        .view("ft_balance_of")
        .args_json(json!({"account_id":payer.id()}))
        .await?
        .json()?;
    let out = pay("foreign message".into()).await?;
    measure("foreign-bounce", &out, &annon);
    assert!(out.is_success());
    assert_eq!(out.json::<String>()?, "0");
    let after: String = token
        .view("ft_balance_of")
        .args_json(json!({"account_id":payer.id()}))
        .await?
        .json()?;
    assert_eq!(before, after);
    Ok(())
}
