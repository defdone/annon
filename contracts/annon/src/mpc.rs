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
use near_sdk::{env, Gas, NearToken, PromiseIndex};

use crate::Annon;

/// Gas for `request_app_private_key` and `verify_foreign_transaction` (MPC asks for 15).
const CKD_GAS: Gas = Gas::from_tgas(30);
const VERIFY_GAS: Gas = Gas::from_tgas(30);

impl Annon {
    /// Asks MPC for the key of `file/<file_id>`, encrypted to the one-time key `to`.
    /// The key depends only on this contract's account and the path, never on `to`.
    /// Its answer becomes the return value of the calling method.
    pub(crate) fn ckd(&self, file_id: &[u8; 32], to: &[u8; 48]) {
        let args = json!({ "request": {
            "derivation_path": format!("file/{}", hex::encode(file_id)),
            "app_public_key": { "AppPublicKey": format!("bls12381g1:{}", bs58::encode(to).into_string()) },
            "domain_id": self.ckd_domain,
        }});
        let p = env::promise_batch_create(&self.mpc);
        env::promise_batch_action_function_call(
            p,
            "request_app_private_key",
            args.to_string().as_bytes(),
            NearToken::from_yoctonear(1),
            CKD_GAS,
        );
        env::promise_return(p);
    }

    /// Asks MPC to verify one Base log at `Safe` finality and returns the promise and the payload
    /// hash we expect MPC to sign. MPC only answers if the log on Base is exactly this one.
    pub(crate) fn verify_log(&self, log: &EvmLog) -> (PromiseIndex, [u8; 32]) {
        let request = ForeignChainRpcRequest::Base(EvmRpcRequest {
            tx_id: EvmTxId(log.transaction_hash.0),
            extractors: UpperBoundedVec::from_vec(vec![EvmExtractor::Log {
                log_index: log.log_index,
            }])
            .unwrap(),
            finality: EvmFinality::Safe,
        });
        let expected = ForeignTxSignPayload::new(
            ForeignTxPayloadVersion::V1,
            request.clone(),
            vec![ExtractedValue::EvmExtractedValue(EvmExtractedValue::Log(
                log.clone(),
            ))],
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
        env::promise_batch_action_function_call(
            p,
            "verify_foreign_transaction",
            verify.to_string().as_bytes(),
            NearToken::from_yoctonear(1),
            VERIFY_GAS,
        );
        (p, expected.0)
    }
}
