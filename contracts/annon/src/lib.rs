//! Annon: NEAR releases a file key once it has verified the buyer's payment on Base.
use near_sdk::json_types::U128;
use near_sdk::serde_json::json;
use near_sdk::store::LookupMap;
use near_sdk::{env, near, require, AccountId, Gas, NearToken, PanicOnDefault, Promise};

/// Gas for `request_app_private_key`, as in NEAR MPC's own test contract.
const CKD_GAS: Gas = Gas::from_tgas(30);

/// Where the payment for a file comes from (plan 4.7).
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Source {
    /// Partner's splitter `PaymentSplit`; the event's `creator` must be the seller.
    Partner,
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
}

#[near]
impl Annon {
    #[init]
    pub fn new(mpc: AccountId, ckd_domain: u64) -> Self {
        Self {
            files: LookupMap::new(b"f"),
            mpc,
            ckd_domain,
        }
    }

    /// Lists a file. Anyone may submit it; only the seller's EIP-191 signature over
    /// `register_message(args)` makes it valid. The caller pays for storage; the rest is refunded.
    /// Returns MPC's CKD answer (`big_y`, `big_c`): the file key encrypted to `seller_key`.
    #[payable]
    pub fn register(&mut self, args: RegisterArgs, sig: String) -> Promise {
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
            Source::Partner => "partner".to_string(),
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
    pub fn reopen(&mut self, args: ReopenArgs, sig: String) -> Promise {
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
        // ponytail: seller only until `unlock` records buyers
        require!(
            file.seller == wallet,
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
    /// Asks MPC for the key of `file/<file_id>`, encrypted to the one-time key `to`.
    /// The key depends only on this contract's account and the path, never on `to`.
    fn ckd(&self, file_id: &[u8; 32], to: &[u8; 48]) -> Promise {
        let args = json!({ "request": {
            "derivation_path": format!("file/{}", hex::encode(file_id)),
            "app_public_key": { "AppPublicKey": format!("bls12381g1:{}", bs58::encode(to).into_string()) },
            "domain_id": self.ckd_domain,
        }});
        Promise::new(self.mpc.clone()).function_call(
            "request_app_private_key",
            args.to_string().into_bytes(),
            NearToken::from_yoctonear(1),
            CKD_GAS,
        )
    }
}

fn bytes<const N: usize>(s: &str, name: &str) -> [u8; N] {
    hex::decode(s.strip_prefix("0x").unwrap_or(s))
        .ok()
        .and_then(|v| v.try_into().ok())
        .unwrap_or_else(|| env::panic_str(&format!("{name} must be {N} bytes of hex")))
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
    let refund = attached.saturating_sub(cost);
    if refund > NearToken::from_yoctonear(0) {
        Promise::new(env::predecessor_account_id())
            .transfer(refund)
            .detach();
    }
}

#[cfg(test)]
mod tests;
