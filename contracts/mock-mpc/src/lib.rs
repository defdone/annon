//! Test stand-in for NEAR MPC (`v1.signer`), for Annon's sandbox tests only. It asks for what the
//! real contract asks for (1 yoctoNEAR, at least 15 Tgas) and answers at once instead of through
//! yield/resume. `set_mode` makes it fail or sign the wrong payload.
use near_sdk::serde_json::{json, Value};
use near_sdk::{env, near, require, Gas, NearToken};

#[near(contract_state)]
#[derive(Default)]
pub struct MockMpc {
    /// "ok" (default), "fail" or "wrong_hash".
    verify: String,
    /// "ok" (default) or "fail".
    ckd: String,
}

fn like_mpc() {
    require!(
        env::attached_deposit() >= NearToken::from_yoctonear(1),
        "attach 1 yoctoNEAR"
    );
    require!(
        env::prepaid_gas() >= Gas::from_tgas(15),
        "Attached gas is less than the required gas"
    );
}

#[near]
impl MockMpc {
    pub fn set_mode(&mut self, verify: String, ckd: String) {
        self.verify = verify;
        self.ckd = ckd;
    }

    #[payable]
    pub fn verify_foreign_transaction(&mut self, request: Value) -> Value {
        like_mpc();
        let hash = match self.verify.as_str() {
            "fail" => env::panic_str("Request has timed out"),
            "wrong_hash" => Value::from("00".repeat(32)),
            _ => request["expected_payload_hash"].clone(),
        };
        json!({ "payload_hash": hash, "signature": { "scheme": "Secp256k1",
            "big_r": { "affine_point": format!("02{}", "11".repeat(32)) },
            "s": { "scalar": "22".repeat(32) }, "recovery_id": 0 } })
    }

    #[payable]
    pub fn request_app_private_key(&mut self, request: Value) -> Value {
        like_mpc();
        if self.ckd == "fail" {
            env::panic_str("Request has timed out");
        }
        json!({ "big_y": "bls12381g1:mockY", "big_c": format!("bls12381g1:mockC-{}", request["derivation_path"].as_str().unwrap_or("")) })
    }
}
