//! Annon: NEAR releases a file key once it has verified the buyer's payment on Base.
use near_mpc_bounded_collections::UpperBoundedVec;
use near_mpc_contract_interface::types::{
    DomainId, EvmExtractedValue, EvmExtractor, EvmFinality, EvmLog, EvmRpcRequest, EvmTxId,
    ExtractedValue, ForeignChainRpcRequest, ForeignTxPayloadVersion, ForeignTxSignPayload,
    VerifyForeignTransactionRequestArgs, VerifyForeignTransactionResponse,
};
use near_sdk::json_types::U128;
use near_sdk::serde_json::json;
use near_sdk::store::LookupMap;
use near_sdk::{env, near, require, AccountId, Gas, NearToken, PanicOnDefault};

/// Gas for `request_app_private_key` and `verify_foreign_transaction` (MPC asks for 15).
const CKD_GAS: Gas = Gas::from_tgas(30);
const VERIFY_GAS: Gas = Gas::from_tgas(30);
/// The callback checks the answer and then asks for CKD.
const CALLBACK_GAS: Gas = Gas::from_tgas(50);
/// Attached to `unlock` for the buyer and payment records (about 0.002 NEAR); the rest comes back.
const UNLOCK_DEPOSIT: NearToken = NearToken::from_millinear(5);

/// Payaion's splitter event: `PaymentSplit(payer, creator, total, dev, creatorAmount, nonce)`,
/// with `payer` and `creator` indexed.
const PAYMENT_SPLIT: &[u8] = b"PaymentSplit(address,address,uint256,uint256,uint256,bytes32)";

/// Where the payment for a file comes from (plan 4.7).
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Source {
    /// Payaion's splitter `PaymentSplit`; the event's `creator` must be the seller.
    Payaion,
    /// A direct x402 payment: USDC `Transfer` to `pay_to`.
    X402 { pay_to: String },
}

#[near(serializers = [json])]
#[derive(Clone)]
pub struct RegisterArgs {
    /// 32 random bytes picked by the seller's client, hex.
    pub file_id: String,
    /// The seller's EVM address; must match the signature.
    pub seller: String,
    /// USDC base units (6 decimals).
    pub price: U128,
    pub source: Source,
    /// sha256 of the PAY2 bytes, hex.
    pub cipher_hash: String,
    /// The only account that can take the file down. The contract can't tell whether the seller
    /// controls it, so the buyer's client shows it and refuses unknown moderators by default.
    pub moderator: Option<AccountId>,
    /// The seller's one-time BLS12-381 G1 key (48 bytes compressed, hex) for the file key.
    pub seller_key: String,
    /// Unix seconds after which the signature is void.
    pub deadline: u64,
}

#[near(serializers = [json])]
#[derive(Clone)]
pub struct ReopenArgs {
    pub file_id: String,
    /// The EVM address asking: the seller, or (with `unlock`) a recorded buyer.
    pub wallet: String,
    /// A fresh one-time BLS12-381 G1 key (48 bytes compressed, hex).
    pub key: String,
    /// Unix seconds after which the signature is void.
    pub deadline: u64,
}

#[near(serializers = [json])]
pub struct UnlockArgs {
    pub file_id: String,
    /// The buyer's one-time BLS12-381 G1 key; the payment nonce must commit to it.
    pub buyer_key: String,
    /// The payment log exactly as `eth_getTransactionReceipt` returned it. MPC checks it on Base.
    pub log: EvmLog,
}

#[near(serializers = [json])]
pub struct FileView {
    pub seller: String,
    pub price: U128,
    pub source: Source,
    pub cipher_hash: String,
    pub moderator: Option<AccountId>,
    pub sales_stopped: bool,
}

#[near(serializers = [borsh])]
struct File {
    seller: [u8; 20],
    price: u128,
    source: Source,
    cipher_hash: [u8; 32],
    moderator: Option<AccountId>,
    sales_stopped: bool,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Annon {
    files: LookupMap<[u8; 32], File>,
    /// The NEAR MPC contract (`v1.signer` on mainnet).
    mpc: AccountId,
    /// MPC domain for CKD (BLS12-381; 2 on mainnet).
    ckd_domain: u64,
    /// MPC domain for `verify_foreign_transaction` (secp256k1; 3 on mainnet).
    foreign_tx_domain: u64,
    /// Payaion's splitter on Base, the only valid emitter of `PaymentSplit`.
    payaion_splitter: [u8; 20],
    /// `file_id ‖ buyer address` for every wallet that paid.
    buyers: LookupMap<[u8; 52], ()>,
    /// `tx_hash ‖ log_index` of every payment that has released a key.
    used: LookupMap<[u8; 40], ()>,
}

#[near]
impl Annon {
    #[init]
    pub fn new(
        mpc: AccountId,
        ckd_domain: u64,
        foreign_tx_domain: u64,
        payaion_splitter: String,
    ) -> Self {
        Self {
            files: LookupMap::new(b"f"),
            mpc,
            ckd_domain,
            foreign_tx_domain,
            payaion_splitter: bytes::<20>(&payaion_splitter, "payaion_splitter"),
            buyers: LookupMap::new(b"b"),
            used: LookupMap::new(b"u"),
        }
    }

    /// Lists a file. Anyone may submit it; only the seller's EIP-191 signature over
    /// `register_message(args)` makes it valid. The caller pays for storage; the rest is refunded.
    /// Returns MPC's CKD answer (`big_y`, `big_c`): the file key encrypted to `seller_key`.
    #[payable]
    pub fn register(&mut self, args: RegisterArgs, sig: String) {
        let file_id = bytes::<32>(&args.file_id, "file_id");
        let seller = bytes::<20>(&args.seller, "seller");
        let cipher_hash = bytes::<32>(&args.cipher_hash, "cipher_hash");
        let seller_key = bytes::<48>(&args.seller_key, "seller_key");
        if let Source::X402 { pay_to } = &args.source {
            bytes::<20>(pay_to, "pay_to");
        }
        require!(args.price.0 > 0, "price must be above zero");
        require!(
            env::block_timestamp() / 1_000_000_000 <= args.deadline,
            "signature expired"
        );
        require!(
            recover_eip191(&self.register_message(args.clone()), &sig) == Some(seller),
            "signature is not from the seller"
        );
        require!(
            !self.files.contains_key(&file_id),
            "file already registered"
        );

        let before = env::storage_usage();
        self.files.insert(
            file_id,
            File {
                seller,
                price: args.price.0,
                source: args.source,
                cipher_hash,
                moderator: args.moderator,
                sales_stopped: false,
            },
        );
        self.files.flush();
        pay_for_storage(env::storage_usage() - before);
        // If MPC fails here the listing stays; the seller gets the key again through `reopen`.
        self.ckd(&file_id, &seller_key)
    }

    /// The exact text the seller signs. The SDK shows this to the wallet, so both sides agree.
    pub fn register_message(&self, args: RegisterArgs) -> String {
        let source = match &args.source {
            Source::Payaion => "payaion".to_string(),
            Source::X402 { pay_to } => {
                format!("x402, pay to {}", hex0x(&bytes::<20>(pay_to, "pay_to")))
            }
        };
        let moderator = args.moderator.as_ref().map_or("(none)", |m| m.as_str()); // "(" never appears in an account id
        format!(
            "Annon: list a file for sale\n\
             contract: {}\n\
             file: {}\n\
             seller: {}\n\
             price: {} USDC base units (6 decimals)\n\
             source: {source}\n\
             cipher: {}\n\
             moderator: {moderator}\n\
             seller key: {}\n\
             valid until: {}",
            env::current_account_id(),
            hex0x(&bytes::<32>(&args.file_id, "file_id")),
            hex0x(&bytes::<20>(&args.seller, "seller")),
            args.price.0,
            hex0x(&bytes::<32>(&args.cipher_hash, "cipher_hash")),
            hex0x(&bytes::<48>(&args.seller_key, "seller_key")),
            args.deadline,
        )
    }

    /// Releases the file key again, to a new one-time key, with no new payment. Needs an EIP-191
    /// signature from `wallet` over `reopen_message(args)`. Replaying it gives nothing: the answer
    /// is encrypted to `args.key`, and only the signer holds its secret.
    pub fn reopen(&mut self, args: ReopenArgs, sig: String) {
        let file_id = bytes::<32>(&args.file_id, "file_id");
        let wallet = bytes::<20>(&args.wallet, "wallet");
        let key = bytes::<48>(&args.key, "key");
        require!(
            env::block_timestamp() / 1_000_000_000 <= args.deadline,
            "signature expired"
        );
        let file = self
            .files
            .get(&file_id)
            .unwrap_or_else(|| env::panic_str("unknown file"));
        require!(
            recover_eip191(&self.reopen_message(args.clone()), &sig) == Some(wallet),
            "signature is not from the wallet"
        );
        require!(
            file.seller == wallet || self.buyers.contains_key(&buyer_entry(&file_id, &wallet)),
            "only the seller or a buyer can reopen"
        );
        self.ckd(&file_id, &key)
    }

    /// The exact text a wallet signs to open a file again.
    pub fn reopen_message(&self, args: ReopenArgs) -> String {
        format!(
            "Annon: open a file again\n\
             contract: {}\n\
             file: {}\n\
             wallet: {}\n\
             one-time key: {}\n\
             valid until: {}",
            env::current_account_id(),
            hex0x(&bytes::<32>(&args.file_id, "file_id")),
            hex0x(&bytes::<20>(&args.wallet, "wallet")),
            hex0x(&bytes::<48>(&args.key, "key")),
            args.deadline,
        )
    }

    /// Releases the file key to the buyer's one-time key once NEAR MPC has verified the payment on
    /// Base. Anyone may call it (relayer, agent, buyer): the key is useless without the buyer's
    /// secret, and the nonce binds the payment to this file and this key. The caller attaches
    /// `UNLOCK_DEPOSIT` for storage and gets back what isn't used, or all of it if MPC fails.
    #[payable]
    pub fn unlock(&mut self, args: UnlockArgs) {
        require!(
            env::attached_deposit() >= UNLOCK_DEPOSIT,
            format!(
                "attach at least {} yoctoNEAR for storage",
                UNLOCK_DEPOSIT.as_yoctonear()
            )
        );
        let file_id = bytes::<32>(&args.file_id, "file_id");
        let buyer_key = bytes::<48>(&args.buyer_key, "buyer_key");
        let file = self
            .files
            .get(&file_id)
            .unwrap_or_else(|| env::panic_str("unknown file"));
        let log = &args.log;
        require!(!log.removed, "log was removed");
        // ponytail: x402 (two logs, USDC Transfer to pay_to) is the next step
        require!(
            file.source == Source::Payaion,
            "x402 unlock is not built yet"
        );
        require!(
            log.address.0 == self.payaion_splitter,
            "log is not from the payment source"
        );
        require!(
            log.topics.len() == 3 && log.topics[0].0 == env::keccak256_array(PAYMENT_SPLIT),
            "not a PaymentSplit event"
        );
        let payer: [u8; 20] = log.topics[1].0[12..].try_into().unwrap();
        let creator = &log.topics[2].0[12..];
        let data = hex::decode(log.data.trim_start_matches("0x"))
            .ok()
            .filter(|d| d.len() == 128)
            .unwrap_or_else(|| env::panic_str("bad PaymentSplit data"));
        require!(creator == file.seller, "payment went to another seller");
        require!(
            data[..16].iter().all(|b| *b == 0)
                && u128::from_be_bytes(data[16..32].try_into().unwrap()) >= file.price,
            "payment is below the price"
        );
        require!(
            data[96..128] == self.nonce(&file_id, &buyer_key),
            "payment was not made for this file and key"
        );
        let mut payment = [0u8; 40];
        payment[..32].copy_from_slice(&log.transaction_hash.0);
        payment[32..].copy_from_slice(&log.log_index.to_be_bytes());
        require!(!self.used.contains_key(&payment), "payment already used");

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
                args.log.clone(),
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
        let then = env::promise_then(
            p,
            env::current_account_id(),
            "on_payment_verified",
            json!({
                "file_id": hex0x(&file_id),
                "buyer_key": hex0x(&buyer_key),
                "payer": hex0x(&payer),
                "payment": hex0x(&payment),
                "payload_hash": hex::encode(expected.0),
                "caller": env::predecessor_account_id(),
                "deposit": U128(env::attached_deposit().as_yoctonear()),
            })
            .to_string()
            .as_bytes(),
            NearToken::from_yoctonear(0),
            CALLBACK_GAS,
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
    ) {
        let file_id = bytes::<32>(&file_id, "file_id");
        let deposit = NearToken::from_yoctonear(deposit.0);
        let recorded = self.record_payment(
            &file_id,
            &bytes::<20>(&payer, "payer"),
            bytes::<40>(&payment, "payment"),
            &bytes::<32>(&payload_hash, "payload_hash"),
        );
        match recorded {
            Ok(cost) => {
                transfer(&caller, deposit.saturating_sub(cost));
                // ponytail: receipt commitment (plan 4.5) comes next
                self.ckd(&file_id, &bytes::<48>(&buyer_key, "buyer_key"));
            }
            Err(reason) => {
                env::log_str(&format!("unlock failed: {reason}"));
                transfer(&caller, deposit);
                env::value_return(json!({ "error": reason }).to_string().as_bytes());
            }
        }
    }

    pub fn is_buyer(&self, file_id: String, wallet: String) -> bool {
        self.buyers.contains_key(&buyer_entry(
            &bytes::<32>(&file_id, "file_id"),
            &bytes::<20>(&wallet, "wallet"),
        ))
    }

    pub fn get_file(&self, file_id: String) -> Option<FileView> {
        self.files
            .get(&bytes::<32>(&file_id, "file_id"))
            .map(|f| FileView {
                seller: hex0x(&f.seller),
                price: U128(f.price),
                source: f.source.clone(),
                cipher_hash: hex0x(&f.cipher_hash),
                moderator: f.moderator.clone(),
                sales_stopped: f.sales_stopped,
            })
    }
}

impl Annon {
    /// Checks MPC's answer and records the buyer and the payment. Returns the storage it used.
    fn record_payment(
        &mut self,
        file_id: &[u8; 32],
        payer: &[u8; 20],
        payment: [u8; 40],
        expected: &[u8; 32],
    ) -> Result<NearToken, &'static str> {
        // An answer is a hash and a signature; anything larger is refused unread.
        let answer = env::promise_result_checked(0, 1024)
            .map_err(|_| "MPC could not verify the payment; retry unlock")?;
        let response: VerifyForeignTransactionResponse = near_sdk::serde_json::from_slice(&answer)
            .map_err(|_| "MPC could not verify the payment; bad answer")?;
        if &response.payload_hash.0 != expected {
            return Err("MPC verified a different payload");
        }
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

    /// Asks MPC for the key of `file/<file_id>`, encrypted to the one-time key `to`.
    /// The key depends only on this contract's account and the path, never on `to`.
    /// Its answer becomes the return value of the calling method.
    fn ckd(&self, file_id: &[u8; 32], to: &[u8; 48]) {
        let args = json!({ "request": {
            "derivation_path": format!("file/{}", hex::encode(file_id)),
            "app_public_key": { "AppPublicKey": format!("bls12381g1:{}", bs58::encode(to).into_string()) },
            "domain_id": self.ckd_domain,
        }});
        // Low-level promise API on purpose: near-sdk's `Promise` links every action host function,
        // including ones mainnet doesn't have yet, and the deploy fails with a link error.
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
}

fn bytes<const N: usize>(s: &str, name: &str) -> [u8; N] {
    hex::decode(s.strip_prefix("0x").unwrap_or(s))
        .ok()
        .and_then(|v| v.try_into().ok())
        .unwrap_or_else(|| env::panic_str(&format!("{name} must be {N} bytes of hex")))
}

fn buyer_entry(file_id: &[u8; 32], wallet: &[u8; 20]) -> [u8; 52] {
    let mut k = [0u8; 52];
    k[..32].copy_from_slice(file_id);
    k[32..].copy_from_slice(wallet);
    k
}

fn hex0x(b: &[u8]) -> String {
    format!("0x{}", hex::encode(b))
}

/// The EVM address behind an EIP-191 `personal_sign` signature (65 bytes, `v` 0/1 or 27/28).
/// High-`s` signatures are rejected.
fn recover_eip191(message: &str, sig: &str) -> Option<[u8; 20]> {
    let sig = hex::decode(sig.strip_prefix("0x").unwrap_or(sig)).ok()?;
    if sig.len() != 65 {
        return None;
    }
    let v = match sig[64] {
        v @ 0..=1 => v,
        v @ 27..=28 => v - 27,
        _ => return None,
    };
    let prefixed = format!("\x19Ethereum Signed Message:\n{}{message}", message.len());
    let pubkey = env::ecrecover(
        &env::keccak256_array(prefixed.as_bytes()),
        &sig[..64],
        v,
        true,
    )?;
    env::keccak256_array(pubkey)[12..].try_into().ok()
}

fn pay_for_storage(bytes_used: u64) {
    let cost = env::storage_byte_cost().saturating_mul(bytes_used.into());
    let attached = env::attached_deposit();
    require!(
        attached >= cost,
        format!(
            "attach at least {} yoctoNEAR for storage",
            cost.as_yoctonear()
        )
    );
    transfer(
        &env::predecessor_account_id(),
        attached.saturating_sub(cost),
    );
}

fn transfer(to: &AccountId, amount: NearToken) {
    if amount > NearToken::from_yoctonear(0) {
        let p = env::promise_batch_create(to);
        env::promise_batch_action_transfer(p, amount);
    }
}

#[cfg(test)]
mod tests;
