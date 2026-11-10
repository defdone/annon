//! The shared vectors the SDK writes (specs/vectors/near-settlement.json, texts.json): the
//! contract must produce the same bytes, texts and hashes, and reject what they say it rejects.
use near_sdk::serde_json::{from_value, Value};
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::{borsh, testing_env, AccountId};

use crate::evm::{bytes, hex0x};
use crate::identity::{Auth, Identity, IdentityJson};
use crate::merkle::{verify, Accumulator, Leaf};
use crate::purchase::{base_nonce, parse, refund_prefix, to_json, Parsed};
use crate::register::{reopen_seller_text_for, RegisterArgs, TermsJson};

fn load(name: &str) -> Value {
    let path = format!("{}/../../specs/vectors/{name}", env!("CARGO_MANIFEST_DIR"));
    near_sdk::serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

fn at(contract: &str, predecessor: &str) {
    testing_env!(VMContextBuilder::new()
        .current_account_id(contract.parse().unwrap())
        .predecessor_account_id(predecessor.parse().unwrap())
        .build());
}

fn s(v: &Value) -> &str {
    v.as_str().unwrap()
}

fn identity(v: &Value) -> Identity {
    Identity::from_json(&from_value::<IdentityJson>(v.clone()).unwrap()).unwrap()
}

fn route(name: &str) -> u8 {
    if name == "near-usdc" {
        0
    } else {
        1
    }
}

#[test]
fn identities_encode_like_the_sdk() {
    for v in load("near-settlement.json")["identities"]
        .as_array()
        .unwrap()
    {
        let i = identity(&v["identity"]);
        assert_eq!(hex0x(&borsh::to_vec(&i).unwrap()), s(&v["borsh"]), "{v}");
        assert_eq!(i.text(), s(&v["text"]));
        assert_eq!(i.intents_id(), s(&v["intents_account"]));
        assert_eq!(
            near_sdk::serde_json::to_string(&IdentityJson::from(&i)).unwrap(),
            s(&v["json"])
        );
    }
}

#[test]
fn terms_hash_and_register_texts_match() {
    for v in load("near-settlement.json")["terms"].as_array().unwrap() {
        at(s(&v["terms"]["contract"]), "x.near");
        let t = from_value::<TermsJson>(v["terms"].clone())
            .unwrap()
            .decode();
        assert_eq!(
            hex0x(&borsh::to_vec(&t).unwrap()),
            s(&v["borsh"]),
            "{}",
            v["id"]
        );
        assert_eq!(hex0x(&t.hash()), s(&v["terms_hash"]));
        let key = bytes::<48>(s(&v["seller_key"]), "seller_key");
        assert_eq!(
            t.register_text(&key, v["deadline"].as_u64().unwrap()),
            s(&v["register_text"])
        );
        assert_eq!(t.problem(&t.network, &t.near.token), None, "{}", v["id"]);
    }
}

#[test]
fn purchases_parse_to_the_same_commitment() {
    for v in load("near-settlement.json")["purchases"]
        .as_array()
        .unwrap()
    {
        let p = &v["purchase"];
        at(s(&p["contract"]), "x.near");
        let msg = s(&v["message"]);
        assert_eq!(msg.len() as u64, v["message_bytes"].as_u64().unwrap());
        let Parsed::Ok { purchase, id } =
            parse(msg, s(&p["network"]), s(&p["asset"]), route(s(&p["route"])))
        else {
            panic!("{} did not parse", v["id"]);
        };
        assert_eq!(
            hex0x(&borsh::to_vec(&purchase).unwrap()),
            s(&v["borsh"]),
            "{}",
            v["id"]
        );
        assert_eq!(hex0x(&id), s(&v["purchase_id"]));
        assert_eq!(to_json(&purchase, &id), msg);
        assert_eq!(hex0x(&base_nonce(&id)), s(&v["base_nonce_v2"]));
        let r = &v["reopen"];
        let text = crate::keys::reopen_text_for(
            &s(&r["contract"]).parse().unwrap(),
            &id,
            &purchase.file_id,
            &identity(&r["recovery"]),
            &bytes::<48>(s(&r["fresh_key"]), "fresh_key"),
            &bytes::<32>(s(&r["nonce"]), "nonce"),
            r["deadline"].as_u64().unwrap(),
        );
        assert_eq!(text, s(&v["reopen_text"]));
    }
}

#[test]
fn refund_leaves_and_trees_match() {
    let v = load("near-settlement.json");
    for r in v["refunds"].as_array().unwrap() {
        let f = &r["fields"];
        let leaf = Leaf {
            network: s(&f["network"]).into(),
            contract: s(&f["contract"]).parse().unwrap(),
            delivery_id: s(&f["delivery_id"]).parse().unwrap(),
            refund: identity(&f["refund"]),
            amount: s(&f["amount"]).parse().unwrap(),
        };
        assert_eq!(hex0x(&borsh::to_vec(&leaf).unwrap()), s(&r["borsh"]));
        assert_eq!(hex0x(&leaf.hash()), s(&r["leaf"]));
    }
    at("annon.near", "x.near");
    for t in v["merkle"].as_array().unwrap() {
        let mut acc = Accumulator::new();
        for l in t["leaves"].as_array().unwrap() {
            acc.push(bytes::<32>(s(l), "leaf"));
        }
        assert_eq!(hex0x(&acc.root), s(&t["root"]), "{} leaves", t["count"]);
        for p in t["proofs"].as_array().unwrap() {
            let i = p["index"].as_u64().unwrap();
            let proof: Vec<[u8; 32]> = p["proof"]
                .as_array()
                .unwrap()
                .iter()
                .map(|h| bytes::<32>(s(h), "p"))
                .collect();
            let leaf = bytes::<32>(s(&t["leaves"][i as usize]), "leaf");
            assert!(verify(&acc.root, leaf, i, &proof), "proof {i}");
        }
    }
}

#[test]
fn authorizations_verify() {
    for v in load("near-settlement.json")["authorizations"]
        .as_array()
        .unwrap()
    {
        at(
            "annon.near",
            v["predecessor"].as_str().unwrap_or("someone.near"),
        );
        let auth: Option<Auth> = from_value(v["auth"].clone()).unwrap();
        assert!(
            identity(&v["identity"]).authorized(s(&v["text"]), auth.as_ref()),
            "{v}"
        );
    }
}

#[test]
fn every_negative_case_is_refused_as_the_vectors_say() {
    for v in load("near-settlement.json")["negative"].as_array().unwrap() {
        let (id, input, want) = (s(&v["id"]), &v["input"], s(&v["expected"]["contract"]));
        let ctx = &v["context"];
        at(
            ctx["contract"].as_str().unwrap_or("annon.near"),
            "someone.near",
        );
        let got = match s(&v["kind"]) {
            "purchase" => match parse(
                s(input),
                s(&ctx["network"]),
                s(&ctx["asset"]),
                ctx["route"].as_u64().unwrap() as u8,
            ) {
                Parsed::Foreign => "foreign",
                Parsed::Unusable { .. } => "unusable",
                Parsed::Ok { .. } => "ok",
            },
            "refund_prefix" => {
                if refund_prefix(s(input)).is_none() {
                    "foreign"
                } else {
                    "ok"
                }
            }
            "terms" => {
                let t = from_value::<TermsJson>(input.clone()).unwrap().decode();
                let token: AccountId = s(&ctx["asset"]).parse().unwrap();
                if t.problem(s(&ctx["network"]), &token).is_some() {
                    "problem"
                } else {
                    "ok"
                }
            }
            "authorization" => {
                let auth: Option<Auth> = from_value(input["auth"].clone()).unwrap();
                if identity(&input["identity"]).authorized(s(&input["text"]), auth.as_ref()) {
                    "true"
                } else {
                    "false"
                }
            }
            "merkle" => {
                let proof: Vec<[u8; 32]> = input["proof"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|h| bytes::<32>(s(h), "p"))
                    .collect();
                let ok = verify(
                    &bytes::<32>(s(&input["root"]), "root"),
                    bytes::<32>(s(&input["leaf"]), "leaf"),
                    input["index"].as_u64().unwrap(),
                    &proof,
                );
                if ok {
                    "true"
                } else {
                    "false"
                }
            }
            k => panic!("unknown negative kind {k}"),
        };
        assert_eq!(got, want, "{id}");
    }
}

#[test]
fn seller_and_buyer_texts_match() {
    for c in load("texts.json")["cases"].as_array().unwrap() {
        let contract: AccountId = s(&c["contractId"]).parse().unwrap();
        at(contract.as_str(), "x.near");
        let a = &c["args"];
        let text = match s(&c["kind"]) {
            "register" => {
                let r: RegisterArgs = from_value(a.clone()).unwrap();
                r.terms
                    .decode()
                    .register_text(&bytes::<48>(&r.seller_key, "seller_key"), r.deadline)
            }
            "reopen" => crate::keys::reopen_text_for(
                &contract,
                &bytes::<32>(s(&a["purchase_id"]), "purchase_id"),
                &bytes::<32>(s(&a["file_id"]), "file_id"),
                &identity(&a["recovery"]),
                &bytes::<48>(s(&a["fresh_key"]), "fresh_key"),
                &bytes::<32>(s(&a["nonce"]), "nonce"),
                a["deadline"].as_u64().unwrap(),
            ),
            "stop_sales" => crate::moderation::stop_sales_text_for(
                &contract,
                &bytes::<32>(s(&a["file_id"]), "file_id"),
                &identity(&c["seller"]),
                a["deadline"].as_u64().unwrap(),
            ),
            "reopen_seller" => reopen_seller_text_for(
                &contract,
                &bytes::<32>(s(&a["file_id"]), "file_id"),
                &identity(&c["seller"]),
                &bytes::<48>(s(&a["key"]), "key"),
                a["deadline"].as_u64().unwrap(),
            ),
            k => panic!("unknown text kind {k}"),
        };
        assert_eq!(text, s(&c["text"]), "{}", c["id"]);
    }
}
