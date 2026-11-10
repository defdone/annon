//! Calls to the NEAR MPC contract: CKD (key release) and foreign-transaction checks.
//!
//! Low-level promise API on purpose: near-sdk's `Promise` links every action host function,
//! including ones mainnet doesn't have yet, and the deploy fails with a link error.
use near_mpc_bounded_collections::UpperBoundedVec;
use near_mpc_contract_interface::types::{
    DomainId, EvmExtractedValue, EvmExtractor, EvmFinality, EvmLog, EvmRpcRequest, EvmTxId,
    ExtractedValue, ForeignChainRpcRequest, ForeignTxPayloadVersion, ForeignTxSignPayload,
    VerifyForeignTransactionRequestArgs,
};
use near_sdk::serde_json::json;
use near_sdk::{env, near, Gas, GasWeight, NearToken, PromiseIndex};

use crate::events::emit;
use crate::evm::hex0x;
use crate::{Annon, AnnonExt};

/// Minimum gas for `request_app_private_key` and `verify_foreign_transaction` (MPC asks for 15
/// today). Each call also gets a share of the unused gas, so if MPC ever asks for more, callers
/// attach more gas instead of the locked contract breaking.
const CKD_GAS: Gas = Gas::from_tgas(30);
const VERIFY_GAS: Gas = Gas::from_tgas(30);
/// `on_key_released` only logs and passes the answer on.
const CONFIRM_GAS: Gas = Gas::from_tgas(10);

impl Annon {
    /// Asks MPC for the key of `file/<file_id>`, encrypted to the one-time key `to`, then
    /// confirms the release in `on_key_released`. The key depends only on this contract's account
    /// and the path, never on `to`. The MPC answer becomes the return value of the calling method.
    /// `who` names the recipient in the event (an identity's text form); a purchase adds its id
    /// and grant.
    pub(crate) fn ckd(
        &self,
        file_id: &[u8; 32],
        to: &[u8; 48],
        reason: &str,
        who: String,
        purchase: Option<(&[u8; 32], u32)>,
    ) {
        let args = json!({ "request": {
            "derivation_path": format!("file/{}", hex::encode(file_id)),
            "app_public_key": { "AppPublicKey": format!("bls12381g1:{}", bs58::encode(to).into_string()) },
            "domain_id": self.ckd_domain,
        }});
        let p = env::promise_batch_create(&self.mpc);
        env::promise_batch_action_function_call_weight(
            p,
            "request_app_private_key",
            args.to_string().as_bytes(),
            NearToken::from_yoctonear(1),
            CKD_GAS,
            GasWeight(1),
        );
        let then = env::promise_batch_then(p, &env::current_account_id());
        env::promise_batch_action_function_call_weight(
            then,
            "on_key_released",
            json!({
                "file_id": hex0x(file_id),
                "key": hex0x(to),
                "reason": reason,
                "who": who,
                "purchase": purchase.map(|(p, _)| hex0x(p)),
                "grant": purchase.map(|(_, g)| g),
            })
            .to_string()
            .as_bytes(),
            NearToken::from_yoctonear(0),
            CONFIRM_GAS,
            GasWeight(0),
        );
        env::promise_return(then);
    }

    /// Asks MPC to verify Base logs of one transaction at `Safe` finality and returns the promise
    /// and the payload hash we expect MPC to sign. MPC only answers if the logs on Base are
    /// exactly these.
    pub(crate) fn verify_logs(&self, logs: &[EvmLog]) -> (PromiseIndex, [u8; 32]) {
        let request = ForeignChainRpcRequest::Base(EvmRpcRequest {
            tx_id: EvmTxId(logs[0].transaction_hash.0),
            extractors: UpperBoundedVec::from_vec(
                logs.iter()
                    .map(|l| EvmExtractor::Log {
                        log_index: l.log_index,
                    })
                    .collect(),
            )
            .unwrap_or_else(|_| env::panic_str("too many logs")),
            finality: EvmFinality::Safe,
        });
        let expected = ForeignTxSignPayload::new(
            ForeignTxPayloadVersion::V1,
            request.clone(),
            logs.iter()
                .map(|l| ExtractedValue::EvmExtractedValue(EvmExtractedValue::Log(l.clone())))
                .collect(),
        )
        .compute_msg_hash()
        .unwrap_or_else(|_| env::panic_str("cannot hash the payload"));
        let verify = json!({ "request": VerifyForeignTransactionRequestArgs {
            request,
            domain_id: DomainId(self.foreign_tx_domain),
            payload_version: ForeignTxPayloadVersion::V1,
            expected_payload_hash: Some(expected.clone()),
        }});
        let p = env::promise_batch_create(&self.mpc);
        env::promise_batch_action_function_call_weight(
            p,
            "verify_foreign_transaction",
            verify.to_string().as_bytes(),
            NearToken::from_yoctonear(1),
            VERIFY_GAS,
            GasWeight(1),
        );
        (p, expected.0)
    }
}

#[near]
impl Annon {
    /// The end of every key release. Only if MPC answered does it log `key_released`, the
    /// delivery receipt; either way it returns what the caller needs (see `release_output`).
    #[private]
    pub fn on_key_released(
        &mut self,
        file_id: String,
        key: String,
        reason: String,
        who: String,
        purchase: Option<String>,
        grant: Option<u32>,
    ) {
        let answer = env::promise_result_checked(0, 1024).map_err(|_| ());
        if answer.is_ok() {
            let mut data = json!({ "file_id": file_id, "key": key, "reason": reason, "who": who });
            if let Some(p) = purchase {
                data["purchase"] = json!(p);
                data["grant"] = json!(grant);
            }
            emit("key_released", data);
        } else {
            env::log_str("key release failed: MPC did not answer; ask again");
        }
        env::value_return(release_output(answer));
    }
}

/// MPC's CKD answer (`big_y`, `big_c`) passed on unchanged, or `{"error": ...}`.
pub(crate) fn release_output(answer: Result<Vec<u8>, ()>) -> Vec<u8> {
    answer.unwrap_or_else(|_| {
        json!({ "error": "MPC did not release the key; ask again" })
            .to_string()
            .into_bytes()
    })
}
