//! Unlocking: a payment on Base, verified by NEAR MPC, releases the file key to the buyer.
use near_mpc_contract_interface::types::{EvmLog, VerifyForeignTransactionResponse};
use near_sdk::json_types::U128;
use near_sdk::serde_json::json;
use near_sdk::{env, near, require, AccountId, Gas, GasWeight, NearToken};

use crate::events::emit;
use crate::evm::{bytes, hex0x};
use crate::moderation::payment_allowed;
use crate::{Annon, AnnonExt, File, Source};

/// The callback checks the answer, then asks for CKD (30) and its confirmation (10); it also gets
/// a share of the unused gas.
const CALLBACK_GAS: Gas = Gas::from_tgas(60);
/// Below this the callback could run out of gas after the deposit was reserved.
const MIN_UNLOCK_GAS: Gas = Gas::from_tgas(150);
/// Attached to `unlock` for the buyer and payment records (about 0.002 NEAR); the rest comes back.
pub(crate) const UNLOCK_DEPOSIT: NearToken = NearToken::from_millinear(5);

/// Partner's splitter event: `PaymentSplit(payer, creator, total, dev, creatorAmount, nonce)`,
/// with `payer` and `creator` indexed.
const PAYMENT_SPLIT: &[u8] = b"PaymentSplit(address,address,uint256,uint256,uint256,bytes32)";
/// USDC (EIP-3009) emits these two back to back in `transferWithAuthorization`.
const AUTHORIZATION_USED: &[u8] = b"AuthorizationUsed(address,bytes32)";
const TRANSFER: &[u8] = b"Transfer(address,address,uint256)";

#[near(serializers = [json])]
pub struct UnlockArgs {
    pub file_id: String,
    /// The buyer's one-time BLS12-381 G1 key; the payment nonce must commit to it.
    pub buyer_key: String,
    /// The payment logs exactly as `eth_getTransactionReceipt` returned them; MPC checks them on
    /// Base. Partner: the `PaymentSplit` log. x402: USDC `AuthorizationUsed` and the `Transfer`
    /// right after it.
    pub logs: Vec<EvmLog>,
}

#[near]
impl Annon {
    /// Releases the file key to the buyer's one-time key once NEAR MPC has verified the payment on
    /// Base. Anyone may call it (relayer, agent, buyer): the key is useless without the buyer's
    /// secret, and the nonce binds the payment to this file and this key. The caller attaches
    /// `UNLOCK_DEPOSIT` for storage, or attaches nothing and has it reserved from their prepaid
    /// balance. What storage doesn't use comes back, and all of it if MPC fails.
    #[payable]
    pub fn unlock(&mut self, args: UnlockArgs) {
        require!(
            env::prepaid_gas() >= MIN_UNLOCK_GAS,
            "attach at least 150 Tgas"
        );
        let caller = env::predecessor_account_id();
        let attached = env::attached_deposit();
        let prepaid = attached.is_zero()
            && self.balances.get(&caller).copied().unwrap_or(0) >= UNLOCK_DEPOSIT.as_yoctonear();
        require!(
            prepaid || attached >= UNLOCK_DEPOSIT,
            format!(
                "attach at least {} yoctoNEAR for storage, or call storage_deposit first",
                UNLOCK_DEPOSIT.as_yoctonear()
            )
        );
        let file_id = bytes::<32>(&args.file_id, "file_id");
        let buyer_key = bytes::<48>(&args.buyer_key, "buyer_key");
        let file = self
            .files
            .get(&file_id)
            .unwrap_or_else(|| env::panic_str("unknown file"));
        let (payer, payment, amount) = self.check_payment(file, &file_id, &buyer_key, &args.logs);
        if let Err(reason) = payment_allowed(file, args.logs[0].block_number) {
            env::panic_str(reason);
        }
        require!(!self.used.contains_key(&payment), "payment already used");

        if prepaid {
            *self.balances.get_mut(&caller).unwrap() -= UNLOCK_DEPOSIT.as_yoctonear();
        }
        let deposit = if prepaid { UNLOCK_DEPOSIT } else { attached };

        let (p, expected) = self.verify_logs(&args.logs);
        let then = env::promise_batch_then(p, &env::current_account_id());
        env::promise_batch_action_function_call_weight(
            then,
            "on_payment_verified",
            json!({
                "file_id": hex0x(&file_id),
                "buyer_key": hex0x(&buyer_key),
                "payer": hex0x(&payer),
                "payment": hex0x(&payment),
                "payload_hash": hex::encode(expected),
                "caller": caller,
                "deposit": U128(deposit.as_yoctonear()),
                "prepaid": prepaid,
                "amount": U128(amount),
                "block_number": args.logs[0].block_number,
            })
            .to_string()
            .as_bytes(),
            NearToken::from_yoctonear(0),
            CALLBACK_GAS,
            GasWeight(1),
        );
        env::promise_return(then);
    }

    /// MPC's answer to `unlock`. Nothing is recorded unless MPC verified exactly our payload, so a
    /// timeout or failure leaves the payment unused and `unlock` can be retried. It never panics:
    /// a failure refunds the whole deposit and returns `{"error": ...}`; success returns the CKD
    /// answer and refunds what storage didn't use.
    #[private]
    #[allow(clippy::too_many_arguments)]
    pub fn on_payment_verified(
        &mut self,
        file_id: String,
        buyer_key: String,
        payer: String,
        payment: String,
        payload_hash: String,
        caller: AccountId,
        deposit: U128,
        prepaid: bool,
        amount: U128,
        block_number: u64,
    ) {
        let file_id = bytes::<32>(&file_id, "file_id");
        let payer = bytes::<20>(&payer, "payer");
        let payment = bytes::<40>(&payment, "payment");
        let deposit = NearToken::from_yoctonear(deposit.0);
        let recorded = self.record_payment(
            &file_id,
            &payer,
            payment,
            &bytes::<32>(&payload_hash, "payload_hash"),
            block_number,
        );
        match recorded {
            Ok(cost) => {
                self.give_back(&caller, deposit.saturating_sub(cost), prepaid);
                emit(
                    "payment_verified",
                    json!({
                        "file_id": hex0x(&file_id),
                        "payer": hex0x(&payer),
                        "buyer_key": buyer_key,
                        "base_tx": hex0x(&payment[..32]),
                        "log_index": u64::from_be_bytes(payment[32..].try_into().unwrap()),
                        "amount": amount,
                        "block_number": block_number,
                    }),
                );
                self.ckd(
                    &file_id,
                    &bytes::<48>(&buyer_key, "buyer_key"),
                    "unlock",
                    &payer,
                );
            }
            Err(reason) => {
                env::log_str(&format!("unlock failed: {reason}"));
                self.give_back(&caller, deposit, prepaid);
                env::value_return(json!({ "error": reason }).to_string().as_bytes());
            }
        }
    }
}

impl Annon {
    /// Checks, before asking MPC, that the logs are a payment of at least the price to this file's
    /// seller, bound by its nonce to this file and buyer key. MPC then only has to confirm the
    /// logs are real. Returns the payer and the key that marks the payment used.
    fn check_payment(
        &self,
        file: &File,
        file_id: &[u8; 32],
        buyer_key: &[u8; 48],
        logs: &[EvmLog],
    ) -> ([u8; 20], [u8; 40], u128) {
        require!(logs.iter().all(|l| !l.removed), "log was removed");
        let (payer, amount, nonce) = match &file.source {
            Source::Partner => {
                require!(logs.len() == 1, "a Partner payment is one log");
                let split = &logs[0];
                require!(
                    split.address.0 == self.partner_splitter,
                    "log is not from the payment source"
                );
                require!(is_event(split, PAYMENT_SPLIT), "not a PaymentSplit event");
                let data = words(split, 4, "bad PaymentSplit data");
                require!(
                    indexed_address(split, 2) == file.seller,
                    "payment went to another seller"
                );
                let nonce: [u8; 32] = data[96..128].try_into().unwrap();
                (indexed_address(split, 1), amount(&data[..32]), nonce)
            }
            Source::X402 { pay_to } => {
                require!(logs.len() == 2, "an x402 payment is two logs");
                let (auth, transfer) = (&logs[0], &logs[1]);
                require!(
                    auth.address.0 == self.usdc && transfer.address.0 == self.usdc,
                    "log is not from the payment source"
                );
                require!(
                    is_event(auth, AUTHORIZATION_USED),
                    "not an AuthorizationUsed event"
                );
                require!(is_event(transfer, TRANSFER), "not a Transfer event");
                // Adjacent logs of one transaction are one `transferWithAuthorization` call, so
                // one Transfer can't be counted for two authorizations.
                require!(
                    transfer.transaction_hash == auth.transaction_hash
                        && transfer.log_index == auth.log_index + 1,
                    "the Transfer must follow its authorization"
                );
                require!(
                    indexed_address(transfer, 1) == indexed_address(auth, 1),
                    "the Transfer is not from the authorizer"
                );
                require!(
                    indexed_address(transfer, 2) == bytes::<20>(pay_to, "pay_to"),
                    "payment went to another seller"
                );
                let data = words(transfer, 1, "bad Transfer data");
                (indexed_address(auth, 1), amount(&data), auth.topics[2].0)
            }
        };
        require!(amount >= file.price, "payment is below the price");
        require!(
            nonce == self.nonce(file_id, buyer_key),
            "payment was not made for this file and key"
        );
        let mut payment = [0u8; 40];
        payment[..32].copy_from_slice(&logs[0].transaction_hash.0);
        payment[32..].copy_from_slice(&logs[0].log_index.to_be_bytes());
        (payer, payment, amount)
    }

    /// Checks MPC's answer and that the file may still be sold, then records the buyer and the
    /// payment. Returns the storage it used.
    fn record_payment(
        &mut self,
        file_id: &[u8; 32],
        payer: &[u8; 20],
        payment: [u8; 40],
        expected: &[u8; 32],
        block_number: u64,
    ) -> Result<NearToken, &'static str> {
        // An answer is a hash and a signature; anything larger is refused unread.
        let answer = env::promise_result_checked(0, 1024)
            .map_err(|_| "MPC could not verify the payment; retry unlock")?;
        let response: VerifyForeignTransactionResponse = near_sdk::serde_json::from_slice(&answer)
            .map_err(|_| "MPC could not verify the payment; bad answer")?;
        if &response.payload_hash.0 != expected {
            return Err("MPC verified a different payload");
        }
        // A stop or takedown may have landed while MPC was checking; the payment stays unused.
        let file = self.files.get(file_id).ok_or("unknown file")?;
        payment_allowed(file, block_number)?;
        let before = env::storage_usage();
        // Checked again here: two unlocks for one payment can both be in flight.
        if self.used.insert(payment, ()).is_some() {
            return Err("payment already used");
        }
        self.buyers.insert(buyer_entry(file_id, payer), ());
        self.used.flush();
        self.buyers.flush();
        Ok(env::storage_byte_cost().saturating_mul((env::storage_usage() - before).into()))
    }

    /// The EIP-3009 nonce a buyer signs (plan 4.2): binds the payment to this contract, this file
    /// and this one-time key. The contract id is our own, so the concatenation is unambiguous.
    fn nonce(&self, file_id: &[u8; 32], buyer_key: &[u8; 48]) -> [u8; 32] {
        let mut m = b"annon/v1".to_vec();
        m.extend_from_slice(env::current_account_id().as_bytes());
        m.extend_from_slice(file_id);
        m.extend_from_slice(buyer_key);
        env::keccak256_array(&m)
    }
}

fn is_event(log: &EvmLog, signature: &[u8]) -> bool {
    log.topics.len() == 3 && log.topics[0].0 == env::keccak256_array(signature)
}

/// An address in an indexed topic (the last 20 of its 32 bytes).
fn indexed_address(log: &EvmLog, i: usize) -> [u8; 20] {
    log.topics[i].0[12..].try_into().unwrap()
}

/// The log's data as `n` 32-byte words.
fn words(log: &EvmLog, n: usize, error: &str) -> Vec<u8> {
    hex::decode(log.data.trim_start_matches("0x"))
        .ok()
        .filter(|d| d.len() == 32 * n)
        .unwrap_or_else(|| env::panic_str(error))
}

/// A uint256 amount; anything above u128 can't be real USDC, so it counts as zero.
fn amount(word: &[u8]) -> u128 {
    if word[..16].iter().any(|b| *b != 0) {
        return 0;
    }
    u128::from_be_bytes(word[16..32].try_into().unwrap())
}

pub(crate) fn buyer_entry(file_id: &[u8; 32], wallet: &[u8; 20]) -> [u8; 52] {
    let mut k = [0u8; 52];
    k[..32].copy_from_slice(file_id);
    k[32..].copy_from_slice(wallet);
    k
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tests::*;
    use near_mpc_contract_interface::types::Hash160;
    use near_sdk::test_utils::get_created_receipts;
    use near_sdk::{NearToken, PromiseResult};

    #[test]
    fn unlock_asks_mpc_to_verify_the_exact_log_on_base() {
        let mut c = listed();
        c.unlock(unlock_args(split_log()));
        let req = &mpc_call()["request"];
        assert_eq!(req["expected_payload_hash"], SPLIT_PAYLOAD_HASH);
        assert_eq!(req["domain_id"], 3);
        assert_eq!(req["request"]["Base"]["finality"], "Safe");
        assert_eq!(
            req["request"]["Base"]["extractors"][0]["Log"]["log_index"],
            7
        );
    }

    #[test]
    fn a_recorded_payment_shows_as_used() {
        let mut c = listed();
        let tx = format!("0x{}", "aa".repeat(32)); // the payment `callback` records
        assert!(!c.is_payment_used(tx.clone(), 7));
        c.unlock(unlock_args(split_log()));
        mpc_answered(verified(SPLIT_PAYLOAD_HASH));
        callback(&mut c);
        assert!(c.is_payment_used(tx.clone(), 7));
        assert!(
            !c.is_payment_used(tx, 8),
            "another log of the same tx is another payment"
        );
    }

    #[test]
    #[should_panic(expected = "log is not from the payment source")]
    fn unlock_rejects_a_log_from_another_contract() {
        let mut c = listed();
        let mut log = split_log();
        log.address = Hash160([0x52; 20]);
        c.unlock(unlock_args(log));
    }

    #[test]
    #[should_panic(expected = "not a PaymentSplit event")]
    fn unlock_rejects_another_event() {
        let mut c = listed();
        let mut log = split_log();
        log.topics[0] = h256(&"cd".repeat(32));
        c.unlock(unlock_args(log));
    }

    #[test]
    #[should_panic(expected = "payment went to another seller")]
    fn unlock_rejects_a_payment_to_someone_else() {
        let mut c = listed();
        let mut log = split_log();
        log.topics[2] = topic_address(&Seller::new(2).address());
        c.unlock(unlock_args(log));
    }

    #[test]
    #[should_panic(expected = "payment is below the price")]
    fn unlock_rejects_a_payment_below_the_price() {
        let mut c = listed();
        let mut log = split_log();
        log.data = SPLIT_DATA.replacen("2710", "270f", 1); // 9999 instead of 10000
        c.unlock(unlock_args(log));
    }

    #[test]
    #[should_panic(expected = "payment was not made for this file and key")]
    fn unlock_rejects_a_payment_bound_to_another_key() {
        let mut c = listed();
        let mut a = unlock_args(split_log());
        a.buyer_key = format!("0x{}", "44".repeat(48));
        c.unlock(a);
    }

    #[test]
    #[should_panic(expected = "log was removed")]
    fn unlock_rejects_a_removed_log() {
        let mut c = listed();
        let mut log = split_log();
        log.removed = true;
        c.unlock(unlock_args(log));
    }

    #[test]
    #[should_panic(expected = "unknown file")]
    fn unlock_rejects_an_unknown_file() {
        let mut c = listed();
        let mut a = unlock_args(split_log());
        a.file_id = format!("0x{}", "99".repeat(32));
        c.unlock(a);
    }

    #[test]
    fn a_verified_payment_releases_the_key_and_records_the_buyer() {
        let mut c = listed();
        mpc_answered(verified(SPLIT_PAYLOAD_HASH));
        let before = get_created_receipts().len();
        callback(&mut c);
        let ckd = get_created_receipts()[before..]
            .iter()
            .filter(|r| r.receiver_id.as_str() == "v1.signer")
            .count();
        assert_eq!(ckd, 1, "no CKD request after a verified payment");
        assert!(c.is_buyer(format!("0x{}", "11".repeat(32)), PAYER.into()));
    }

    #[test]
    fn a_different_payload_releases_nothing_and_refunds() {
        let mut c = listed();
        mpc_answered(verified(&"00".repeat(32)));
        let before = get_created_receipts().len();
        callback(&mut c);
        assert_refused("MPC verified a different payload", before);
        assert!(!c.is_buyer(format!("0x{}", "11".repeat(32)), PAYER.into()));
    }

    #[test]
    fn a_failed_mpc_call_releases_nothing_and_refunds() {
        let mut c = listed();
        mpc_answered(PromiseResult::Failed);
        let before = get_created_receipts().len();
        callback(&mut c);
        assert_refused("MPC could not verify the payment", before);
    }

    #[test]
    fn a_failed_mpc_call_leaves_the_payment_unused() {
        let mut c = listed();
        mpc_answered(PromiseResult::Failed);
        callback(&mut c);
        context(UNLOCK_DEPOSIT);
        c.unlock(unlock_args(split_log())); // retry is accepted
    }

    #[test]
    fn a_verified_payment_refunds_what_storage_did_not_use() {
        let mut c = listed();
        mpc_answered(verified(SPLIT_PAYLOAD_HASH));
        let before = get_created_receipts().len();
        callback(&mut c);
        let back = refunded(before);
        assert!(
            back > 0 && back < UNLOCK_DEPOSIT.as_yoctonear(),
            "refund {back}"
        );
    }

    #[test]
    #[should_panic(expected = "attach at least")]
    fn unlock_needs_a_storage_deposit() {
        let mut c = listed();
        context(NearToken::from_yoctonear(0));
        c.unlock(unlock_args(split_log()));
    }

    #[test]
    #[should_panic(expected = "payment already used")]
    fn one_payment_unlocks_once() {
        let mut c = listed();
        mpc_answered(verified(SPLIT_PAYLOAD_HASH));
        callback(&mut c);
        context(UNLOCK_DEPOSIT);
        c.unlock(unlock_args(split_log()));
    }

    #[test]
    fn a_second_callback_for_a_used_payment_releases_nothing() {
        let mut c = listed();
        mpc_answered(verified(SPLIT_PAYLOAD_HASH));
        callback(&mut c);
        mpc_answered(verified(SPLIT_PAYLOAD_HASH));
        let before = get_created_receipts().len();
        callback(&mut c);
        assert_refused("payment already used", before);
    }

    #[test]
    fn a_buyer_can_reopen_and_a_stranger_cannot() {
        let mut c = listed();
        mpc_answered(verified(SPLIT_PAYLOAD_HASH));
        callback(&mut c);
        context(NearToken::from_yoctonear(0));
        let file = format!("0x{}", "11".repeat(32));
        let buyer = Seller::new(7);
        assert_eq!(buyer.address(), PAYER);
        let r = reopen_args(&file, &buyer);
        let before = ckd_calls();
        c.reopen(r.clone(), buyer.sign(&c.reopen_message(r)));
        assert_eq!(ckd_calls(), before + 1);

        let stranger = Seller::new(8);
        let r = reopen_args(&file, &stranger);
        let sig = stranger.sign(&c.reopen_message(r.clone()));
        let refused = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.reopen(r, sig)));
        assert!(refused.is_err());
    }

    #[test]
    fn x402_unlock_asks_mpc_to_verify_both_usdc_logs() {
        let mut c = listed_x402();
        c.unlock(unlock_logs(x402_logs()));
        let req = &mpc_call()["request"];
        assert_eq!(req["expected_payload_hash"], X402_PAYLOAD_HASH);
        let ex = &req["request"]["Base"]["extractors"];
        assert_eq!(
            (
                ex[0]["Log"]["log_index"].clone(),
                ex[1]["Log"]["log_index"].clone()
            ),
            (7.into(), 8.into())
        );
    }

    fn x402_refused(change: impl FnOnce(&mut Vec<EvmLog>)) {
        let mut c = listed_x402();
        let mut logs = x402_logs();
        change(&mut logs);
        c.unlock(unlock_logs(logs));
    }

    #[test]
    #[should_panic(expected = "log is not from the payment source")]
    fn x402_rejects_logs_not_from_usdc() {
        x402_refused(|l| l[1].address = Hash160([0x53; 20]));
    }

    #[test]
    #[should_panic(expected = "not an AuthorizationUsed event")]
    fn x402_rejects_a_missing_authorization() {
        x402_refused(|l| l[0].topics[0] = h256(TRANSFER_TOPIC));
    }

    #[test]
    #[should_panic(expected = "not a Transfer event")]
    fn x402_rejects_a_missing_transfer() {
        x402_refused(|l| l[1].topics[0] = h256(AUTH_USED_TOPIC));
    }

    #[test]
    #[should_panic(expected = "the Transfer must follow its authorization")]
    fn x402_rejects_a_transfer_that_is_not_the_next_log() {
        x402_refused(|l| l[1].log_index = 9);
    }

    #[test]
    #[should_panic(expected = "the Transfer must follow its authorization")]
    fn x402_rejects_logs_from_two_transactions() {
        x402_refused(|l| l[1].transaction_hash = h256(&"dd".repeat(32)));
    }

    #[test]
    #[should_panic(expected = "payment went to another seller")]
    fn x402_rejects_a_transfer_to_someone_else() {
        x402_refused(|l| l[1].topics[2] = topic_address(&Seller::new(2).address()));
    }

    #[test]
    #[should_panic(expected = "the Transfer is not from the authorizer")]
    fn x402_rejects_a_transfer_from_another_wallet() {
        x402_refused(|l| l[1].topics[1] = topic_address(&Seller::new(2).address()));
    }

    #[test]
    #[should_panic(expected = "payment is below the price")]
    fn x402_rejects_a_payment_below_the_price() {
        x402_refused(|l| l[1].data = format!("0x{:064x}", 9_999));
    }

    #[test]
    #[should_panic(expected = "payment was not made for this file and key")]
    fn x402_rejects_an_authorization_for_another_key() {
        x402_refused(|l| l[0].topics[2] = h256(&"ee".repeat(32)));
    }

    #[test]
    #[should_panic(expected = "an x402 payment is two logs")]
    fn x402_needs_both_logs() {
        x402_refused(|l| {
            l.pop();
        });
    }

    #[test]
    #[should_panic(expected = "a Partner payment is one log")]
    fn partner_takes_one_log() {
        let mut c = listed();
        c.unlock(unlock_logs(vec![split_log(), split_log()]));
    }

    #[test]
    fn a_verified_x402_payment_records_the_authorizer_as_buyer() {
        let mut c = listed_x402();
        mpc_answered(verified(X402_PAYLOAD_HASH));
        c.on_payment_verified(
            format!("0x{}", "11".repeat(32)),
            format!("0x{}", "33".repeat(48)),
            PAYER.into(),
            format!("0x{}{}", "cc".repeat(32), "0000000000000007"),
            X402_PAYLOAD_HASH.into(),
            RELAYER.parse().unwrap(),
            U128(UNLOCK_DEPOSIT.as_yoctonear()),
            false,
            U128(10_000),
            0x3000000,
        );
        assert!(c.is_buyer(format!("0x{}", "11".repeat(32)), PAYER.into()));
    }

    #[test]
    #[should_panic(expected = "attach at least 150 Tgas")]
    fn unlock_refuses_too_little_gas_for_its_callback() {
        let mut c = listed();
        near_sdk::testing_env!(near_sdk::test_utils::VMContextBuilder::new()
            .current_account_id(CONTRACT.parse().unwrap())
            .predecessor_account_id(RELAYER.parse().unwrap())
            .attached_deposit(UNLOCK_DEPOSIT)
            .block_timestamp(NOW_S * 1_000_000_000)
            .prepaid_gas(near_sdk::Gas::from_tgas(149))
            .build());
        c.unlock(unlock_args(split_log()));
    }

    #[test]
    fn mpc_and_the_callback_get_the_unused_gas_too() {
        let mut c = listed();
        c.unlock(unlock_args(split_log()));
        let weights: Vec<(String, u64)> = get_created_receipts()
            .into_iter()
            .flat_map(|r| r.actions)
            .filter_map(|a| match a {
                near_sdk::mock::MockAction::FunctionCallWeight {
                    method_name,
                    gas_weight,
                    ..
                } => Some((String::from_utf8(method_name).unwrap(), gas_weight.0)),
                _ => None,
            })
            .filter(|(m, _)| m != "request_app_private_key")
            .collect();
        assert_eq!(
            weights,
            vec![
                ("verify_foreign_transaction".into(), 1),
                ("on_payment_verified".into(), 1)
            ]
        );
    }

    #[test]
    fn a_verified_payment_is_a_receipt_event() {
        let mut c = listed();
        mpc_answered(verified(SPLIT_PAYLOAD_HASH));
        let before = get_created_receipts().len();
        callback(&mut c);
        let e = &events("payment_verified")[0];
        assert_eq!(e["file_id"], format!("0x{}", "11".repeat(32)));
        assert_eq!(e["payer"], PAYER);
        assert_eq!(e["buyer_key"], format!("0x{}", "33".repeat(48)));
        assert_eq!(e["base_tx"], format!("0x{}", "aa".repeat(32)));
        assert_eq!(e["log_index"], 7);
        assert_eq!(e["amount"], "10000");
        assert_eq!(e["block_number"], 0x3000000);
        assert_eq!(self_calls(before), vec!["on_key_released"]);
    }

    #[test]
    fn a_refused_payment_is_no_receipt() {
        let mut c = listed();
        mpc_answered(PromiseResult::Failed);
        callback(&mut c);
        assert!(events("payment_verified").is_empty());
    }
}
