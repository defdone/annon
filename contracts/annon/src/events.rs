//! NEP-297 events: the public receipts. A buyer's receipt is the NEAR transaction holding
//! `payment_verified` and `key_released` for their file and one-time key; the verify page reads it
//! from NEAR and links the Base payment.
use near_sdk::env;
use near_sdk::serde_json::{json, Value};

pub(crate) fn emit(event: &str, data: Value) {
    env::log_str(&format!(
        "EVENT_JSON:{}",
        json!({ "standard": "annon", "version": "1.0.0", "event": event, "data": [data] })
    ));
}
