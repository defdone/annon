//! The Base route (specs/near-settlement.md §5.3): a purchase paid in USDC on Base with EIP-3009,
//! verified by NEAR MPC, is recorded like a NEAR purchase and releases the file key to the buyer.
use near_mpc_contract_interface::types::{EvmLog, VerifyForeignTransactionResponse};
use near_sdk::json_types::U128;
use near_sdk::serde_json::json;
use near_sdk::{env, near, require, AccountId, Gas, GasWeight, NearToken};

use crate::events::emit;
use crate::evm::{bytes, header_number_and_time, hex0x};
use crate::identity::{Identity, IdentityJson};
use crate::moderation::payment_allowed;
use crate::purchase::{base_nonce, parse, Parsed};
use crate::register::now;
use crate::state::PurchaseRec;
use crate::terms::BaseTerms;
use crate::{Annon, AnnonExt};

/// The callback checks the answer, then asks for CKD (30) and its confirmation (10); it also gets
/// a share of the unused gas.
const CALLBACK_GAS: Gas = Gas::from_tgas(60);
/// Below this the callback could run out of gas after the deposit was reserved.
const MIN_UNLOCK_GAS: Gas = Gas::from_tgas(150);
/// Attached to `unlock` for the purchase and payment records (under 0.007 NEAR); the rest comes back.
pub(crate) const UNLOCK_DEPOSIT: NearToken = NearToken::from_millinear(10);
/// The CAIP-2 network a Base purchase names.
pub(crate) const BASE: &str = "eip155:8453";

/// USDC (EIP-3009) emits these two back to back in `transferWithAuthorization`.
const AUTHORIZATION_USED: &[u8] = b"AuthorizationUsed(address,bytes32)";
const TRANSFER: &[u8] = b"Transfer(address,address,uint256)";

#[near(serializers = [json])]
pub struct UnlockArgs {
    /// The purchase message (§5.1) with route `base-usdc`, exactly as the buyer's client built it.
    /// The payment's EIP-3009 nonce is `base_nonce(purchase_id)`.
    pub purchase: String,
    /// The payment logs exactly as `eth_getTransactionReceipt` returned them; MPC checks them on
    /// Base: USDC `AuthorizationUsed` and the `Transfer` right after it.
    pub logs: Vec<EvmLog>,
    /// The RLP header of the payment's Base block, `0x` hex. Needed only once the seller has
    /// stopped sales: the payment's time comes from it (`moderation::payment_allowed`).
    #[serde(default)]
    pub header: Option<String>,
}

#[near]
impl Annon {
    /// Records a Base purchase and releases the file key to the buyer's one-time key once NEAR MPC
    /// has verified the payment on Base. Anyone may call it (relayer, agent, buyer): the key is
    /// useless without the buyer's secret, and the nonce binds the payment to this purchase. The caller attaches
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
        let (buy, id) = match parse(&args.purchase, BASE, &hex0x(&self.usdc), 1) {
            Parsed::Ok { purchase, id } => (purchase, id),
            Parsed::Unusable { why, .. } => env::panic_str(why),
            Parsed::Foreign => env::panic_str("not a purchase message"),
        };
        let file = self
            .files
            .get(&buy.file_id)
            .unwrap_or_else(|| env::panic_str("unknown file"));
        let base = file
            .terms
            .base
            .as_ref()
            .unwrap_or_else(|| env::panic_str("this file is not sold on Base"));
        require!(
            buy.terms_hash == file.terms.hash() && buy.price == base.price,
            "purchase does not match the file's terms"
        );
        require!(
            !self.purchases.contains_key(&id),
            "purchase already recorded; use claim_key"
        );
        let (payer, payment, amount) = self.check_payment(base, &id, &args.logs);
        let paid_at = args.header.as_deref().map(|h| paid_at(h, &args.logs[0]));
        if let Err(reason) = payment_allowed(file, paid_at) {
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
                "purchase_id": hex0x(&id),
                "file_id": hex0x(&buy.file_id),
                "terms_hash": hex0x(&buy.terms_hash),
                "buyer_key": hex0x(&buy.buyer_key),
                "recovery": IdentityJson::from(&buy.recovery),
                "payer": hex0x(&payer),
                "payment": hex0x(&payment),
                "payload_hash": hex::encode(expected),
                "caller": caller,
                "deposit": U128(deposit.as_yoctonear()),
                "prepaid": prepaid,
                "amount": U128(amount),
                "block_number": args.logs[0].block_number,
                "paid_at": paid_at,
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
        purchase_id: String,
        file_id: String,
        terms_hash: String,
        buyer_key: String,
        recovery: IdentityJson,
        payer: String,
        payment: String,
        payload_hash: String,
        caller: AccountId,
        deposit: U128,
        prepaid: bool,
        amount: U128,
        block_number: u64,
        paid_at: Option<u64>,
    ) {
        let id = bytes::<32>(&purchase_id, "purchase_id");
        let file_id = bytes::<32>(&file_id, "file_id");
        let buyer_key = bytes::<48>(&buyer_key, "buyer_key");
        let recovery = Identity::from_json(&recovery).unwrap();
        let payer = bytes::<20>(&payer, "payer");
        let payment = bytes::<40>(&payment, "payment");
        let deposit = NearToken::from_yoctonear(deposit.0);
        let rec = PurchaseRec {
            file_id,
            terms_hash: bytes::<32>(&terms_hash, "terms_hash"),
            buyer_key,
            recovery: recovery.clone(),
            route: 1,
            delivery: u64::MAX,
            accepted_at: now(),
            grants: 1,
        };
        let recorded = self.record_payment(
            id,
            rec,
            payment,
            &bytes::<32>(&payload_hash, "payload_hash"),
            paid_at,
        );
        match recorded {
            Ok(cost) => {
                self.give_back(&caller, deposit.saturating_sub(cost), prepaid);
                emit(
                    "payment_verified",
                    json!({
                        "purchase_id": hex0x(&id),
                        "file_id": hex0x(&file_id),
                        "payer": hex0x(&payer),
                        "buyer_key": hex0x(&buyer_key),
                        "recovery": recovery.text(),
                        "base_tx": hex0x(&payment[..32]),
                        "log_index": u64::from_be_bytes(payment[32..].try_into().unwrap()),
                        "amount": amount,
                        "block_number": block_number,
                    }),
                );
                self.ckd(
                    &file_id,
                    &buyer_key,
                    "unlock",
                    recovery.text(),
                    Some((&id, 0)),
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
    /// Checks, before asking MPC, that the logs are a payment of at least the Base price to the
    /// file's `pay_to`, bound by its nonce to this purchase. MPC then only has to confirm the logs
    /// are real. Returns the payer and the key that marks the payment used.
    fn check_payment(
        &self,
        base: &BaseTerms,
        purchase_id: &[u8; 32],
        logs: &[EvmLog],
    ) -> ([u8; 20], [u8; 40], u128) {
        require!(logs.iter().all(|l| !l.removed), "log was removed");
        require!(logs.len() == 2, "a payment is two logs");
        let (auth, transfer) = (&logs[0], &logs[1]);
        require!(
            auth.address.0 == self.usdc && transfer.address.0 == self.usdc,
            "log is not from USDC"
        );
        require!(
            is_event(auth, AUTHORIZATION_USED),
            "not an AuthorizationUsed event"
        );
        require!(is_event(transfer, TRANSFER), "not a Transfer event");
        // Adjacent logs of one transaction are one `transferWithAuthorization` call, so one
        // Transfer can't be counted for two authorizations.
        require!(
            transfer.transaction_hash == auth.transaction_hash
                && auth.log_index.checked_add(1) == Some(transfer.log_index),
            "the Transfer must follow its authorization"
        );
        require!(
            indexed_address(transfer, 1) == indexed_address(auth, 1),
            "the Transfer is not from the authorizer"
        );
        require!(
            indexed_address(transfer, 2) == base.pay_to,
            "payment went to another address"
        );
        let amount = amount(&words(transfer, 1, "bad Transfer data"));
        require!(amount >= base.price, "payment is below the price");
        // The authorization signs its recipient (`to`) itself; the nonce ties it to this purchase,
        // whose commitment names this contract, the file, its terms and the buyer key.
        require!(
            auth.topics[2].0 == base_nonce(purchase_id),
            "payment was not made for this purchase"
        );
        let mut payment = [0u8; 40];
        payment[..32].copy_from_slice(&logs[0].transaction_hash.0);
        payment[32..].copy_from_slice(&logs[0].log_index.to_be_bytes());
        (indexed_address(auth, 1), payment, amount)
    }

    /// Checks MPC's answer and that the file may still be sold, then records the purchase and the
    /// payment. Returns the storage it used.
    fn record_payment(
        &mut self,
        id: [u8; 32],
        rec: PurchaseRec,
        payment: [u8; 40],
        expected: &[u8; 32],
        paid_at: Option<u64>,
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
        let file = self.files.get(&rec.file_id).ok_or("unknown file")?;
        payment_allowed(file, paid_at)?;
        // Checked again here: two unlocks for one payment or one purchase can both be in flight.
        if self.used.contains_key(&payment) {
            return Err("payment already used");
        }
        if self.purchases.contains_key(&id) {
            return Err("purchase already recorded; use claim_key");
        }
        let before = env::storage_usage();
        self.used.insert(payment, ());
        self.index_purchase(&rec.recovery, id);
        self.purchases.insert(id, rec);
        self.used.flush();
        self.purchases.flush();
        self.recovery.flush();
        self.recovery_count.flush();
        Ok(env::storage_byte_cost().saturating_mul((env::storage_usage() - before).into()))
    }
}

/// The Base time of the payment, from its block header: only bytes that hash to the block hash in
/// the payment log count, and MPC verifies that log, hash included, before anything is recorded.
fn paid_at(header: &str, log: &EvmLog) -> u64 {
    let rlp = hex::decode(header.strip_prefix("0x").unwrap_or(header))
        .unwrap_or_else(|_| env::panic_str("header must be hex"));
    match header_number_and_time(&rlp) {
        Some((number, time))
            if env::keccak256_array(&rlp) == log.block_hash.0 && number == log.block_number =>
        {
            time
        }
        _ => env::panic_str("the header is not the payment's block"),
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tests::*;
    use crate::NEAR_USDC;
    use near_mpc_contract_interface::types::Hash160;
    use near_sdk::test_utils::get_created_receipts;
    use near_sdk::{NearToken, PromiseResult};

    #[test]
    fn unlock_asks_mpc_to_verify_the_exact_log_on_base() {
        let mut c = listed();
        c.unlock(unlock_args());
        let req = &mpc_call()["request"];
        assert_eq!(req["expected_payload_hash"], payload_hash(&x402_logs()));
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
        let tx = format!("0x{}", "cc".repeat(32)); // the payment `callback` records
        assert!(!c.is_payment_used(tx.clone(), 7));
        c.unlock(unlock_args());
        mpc_answered(verified(&payload_hash(&x402_logs())));
        callback(&mut c);
        assert!(c.is_payment_used(tx.clone(), 7));
        assert!(
            !c.is_payment_used(tx, 8),
            "another log of the same tx is another payment"
        );
    }

    #[test]
    fn the_payment_nonce_commits_to_the_purchase() {
        // sha3's Keccak in `nonce_of`, the contract's own in `base_nonce`.
        let p = base_purchase();
        assert_eq!(hex::encode(base_nonce(&p.id())), nonce_of(&p));
    }

    #[test]
    #[should_panic(expected = "payment was not made for this purchase")]
    fn unlock_rejects_a_payment_made_for_another_purchase() {
        let mut c = listed();
        let mut p = base_purchase();
        p.buyer_key = hex::decode(&G1X2[2..]).unwrap().try_into().unwrap();
        c.unlock(UnlockArgs {
            purchase: message(&p),
            ..unlock_args()
        });
    }

    fn refused(change: impl FnOnce(&mut crate::purchase::Purchase)) {
        let mut c = listed();
        let mut p = base_purchase();
        change(&mut p);
        c.unlock(UnlockArgs {
            purchase: message(&p),
            ..unlock_args()
        });
    }

    #[test]
    #[should_panic(expected = "purchase is for another route")]
    fn unlock_refuses_a_purchase_for_the_near_route() {
        refused(|p| p.route = 0);
    }

    #[test]
    #[should_panic(expected = "another network")]
    fn unlock_refuses_a_purchase_for_another_network() {
        refused(|p| p.network = "eip155:1".into());
    }

    #[test]
    #[should_panic(expected = "another network")]
    fn unlock_refuses_a_purchase_in_another_asset() {
        refused(|p| p.asset = NEAR_USDC.into());
    }

    #[test]
    #[should_panic(expected = "purchase does not match the file's terms")]
    fn unlock_refuses_a_purchase_at_another_price() {
        refused(|p| p.price = 9_999);
    }

    #[test]
    #[should_panic(expected = "purchase does not match the file's terms")]
    fn unlock_refuses_a_purchase_under_other_terms() {
        refused(|p| p.terms_hash = [9; 32]);
    }

    #[test]
    #[should_panic(expected = "unknown file")]
    fn unlock_refuses_a_purchase_of_an_unknown_file() {
        refused(|p| p.file_id = [0x99; 32]);
    }

    #[test]
    #[should_panic(expected = "this file is not sold on Base")]
    fn a_file_without_base_terms_has_no_base_route() {
        let mut c = contract();
        let seller = Seller::new(1);
        let mut a = args(&seller);
        a.terms.base = None;
        let auth = signed(&c, &seller, &a);
        c.register(a.clone(), auth);
        context(UNLOCK_DEPOSIT);
        let mut p = base_purchase();
        p.terms_hash = a.terms.decode().hash();
        c.unlock(UnlockArgs {
            purchase: message(&p),
            ..unlock_args()
        });
    }

    #[test]
    #[should_panic(expected = "log was removed")]
    fn unlock_rejects_a_removed_log() {
        let mut c = listed();
        let mut logs = x402_logs();
        logs[0].removed = true;
        c.unlock(unlock_logs(logs));
    }

    #[test]
    fn a_verified_payment_releases_the_key_and_records_the_purchase() {
        let mut c = listed();
        mpc_answered(verified(&payload_hash(&x402_logs())));
        let before = get_created_receipts().len();
        callback(&mut c);
        let ckd = get_created_receipts()[before..]
            .iter()
            .filter(|r| r.receiver_id.as_str() == "v1.signer")
            .count();
        assert_eq!(ckd, 1, "no CKD request after a verified payment");
        let p = c
            .get_purchase(format!("0x{}", hex::encode(base_purchase().id())))
            .unwrap();
        assert_eq!(
            (p.route.as_str(), p.delivery, p.grants),
            ("base-usdc", None, 1)
        );
        assert_eq!((p.buyer_key.as_str(), p.recovery.id.as_str()), (G1, PAYER));
        let to = calls_to("v1.signer", "request_app_private_key")
            .pop()
            .unwrap();
        let key = format!(
            "bls12381g1:{}",
            bs58::encode(hex::decode(&G1[2..]).unwrap()).into_string()
        );
        assert_eq!(to["request"]["app_public_key"]["AppPublicKey"], key);
    }

    #[test]
    fn a_different_payload_releases_nothing_and_refunds() {
        let mut c = listed();
        mpc_answered(verified(&"00".repeat(32)));
        let before = get_created_receipts().len();
        callback(&mut c);
        assert_refused("MPC verified a different payload", before);
        assert!(c
            .get_purchase(format!("0x{}", hex::encode(base_purchase().id())))
            .is_none());
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
        c.unlock(unlock_args()); // retry is accepted
    }

    #[test]
    fn a_verified_payment_refunds_what_storage_did_not_use() {
        let mut c = listed();
        mpc_answered(verified(&payload_hash(&x402_logs())));
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
        c.unlock(unlock_args());
    }

    #[test]
    #[should_panic(expected = "purchase already recorded; use claim_key")]
    fn one_purchase_unlocks_once() {
        let mut c = listed();
        mpc_answered(verified(&payload_hash(&x402_logs())));
        callback(&mut c);
        context(UNLOCK_DEPOSIT);
        c.unlock(unlock_args());
    }

    #[test]
    fn a_second_callback_for_a_used_payment_releases_nothing() {
        let mut c = listed();
        mpc_answered(verified(&payload_hash(&x402_logs())));
        callback(&mut c);
        mpc_answered(verified(&payload_hash(&x402_logs())));
        let before = get_created_receipts().len();
        callback(&mut c);
        assert_refused("payment already used", before);
        assert_eq!(c.purchases_of(Seller::new(7).id(), 0, 10).len(), 1);
    }

    #[test]
    fn x402_unlock_asks_mpc_to_verify_both_usdc_logs() {
        let mut c = listed();
        c.unlock(unlock_logs(x402_logs()));
        let req = &mpc_call()["request"];
        assert_eq!(req["expected_payload_hash"], payload_hash(&x402_logs()));
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
        let mut c = listed();
        let mut logs = x402_logs();
        change(&mut logs);
        c.unlock(unlock_logs(logs));
    }

    #[test]
    #[should_panic(expected = "log is not from USDC")]
    fn x402_rejects_logs_not_from_usdc() {
        x402_refused(|l| l[1].address = Hash160([0x53; 20]));
    }

    #[test]
    #[should_panic(expected = "log is not from USDC")]
    fn x402_rejects_an_authorization_not_from_usdc() {
        x402_refused(|l| l[0].address = Hash160([0x53; 20]));
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
    #[should_panic(expected = "payment went to another address")]
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
    #[should_panic(expected = "payment was not made for this purchase")]
    fn x402_rejects_an_authorization_for_another_purchase() {
        x402_refused(|l| l[0].topics[2] = h256(&"ee".repeat(32)));
    }

    #[test]
    #[should_panic(expected = "the Transfer must follow its authorization")]
    fn x402_refuses_the_last_log_index_without_overflowing() {
        x402_refused(|l| {
            l[0].log_index = u64::MAX;
            l[1].log_index = 0;
        });
    }

    #[test]
    #[should_panic(expected = "a payment is two logs")]
    fn x402_takes_no_extra_log() {
        x402_refused(|l| l.push(l[1].clone()));
    }

    #[test]
    #[should_panic(expected = "a payment is two logs")]
    fn x402_needs_both_logs() {
        x402_refused(|l| {
            l.pop();
        });
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
        c.unlock(unlock_args());
    }

    #[test]
    fn mpc_and_the_callback_get_the_unused_gas_too() {
        let mut c = listed();
        c.unlock(unlock_args());
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
        mpc_answered(verified(&payload_hash(&x402_logs())));
        let before = get_created_receipts().len();
        callback(&mut c);
        let e = &events("payment_verified")[0];
        assert_eq!(
            e["purchase_id"],
            format!("0x{}", hex::encode(base_purchase().id()))
        );
        assert_eq!(e["file_id"], FILE);
        assert_eq!(e["payer"], PAYER);
        assert_eq!(e["buyer_key"], G1);
        assert_eq!(e["recovery"], format!("EVM {PAYER}"));
        assert_eq!(e["base_tx"], format!("0x{}", "cc".repeat(32)));
        assert_eq!(e["log_index"], 7);
        assert_eq!(e["amount"], "10000");
        assert_eq!(e["block_number"], 0x3000000);
        assert_eq!(self_calls(before), vec!["on_key_released"]);
        let k = calls_to(CONTRACT, "on_key_released").pop().unwrap();
        assert_eq!(
            (k["purchase"].as_str(), k["grant"].as_u64()),
            (Some(e["purchase_id"].as_str().unwrap()), Some(0))
        );
    }

    #[test]
    fn a_refused_payment_is_no_receipt() {
        let mut c = listed();
        mpc_answered(PromiseResult::Failed);
        callback(&mut c);
        assert!(events("payment_verified").is_empty());
    }
}
