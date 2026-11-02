//! Annon: NEAR releases a file key once it has verified the buyer's payment on Base.
//!
//! - `register`: a seller lists a file and gets its key (`register.rs`)
//! - `unlock`: a buyer's payment on Base, verified by NEAR MPC, releases the key (`unlock.rs`)
//! - `reopen`: the seller or a buyer gets the key again on any device (`register.rs`)
//! - prepaid storage for callers that can't attach a deposit (`storage.rs`)
use near_sdk::json_types::U128;
use near_sdk::store::LookupMap;
use near_sdk::{near, AccountId, PanicOnDefault};

mod evm;
mod mpc;
mod register;
mod storage;
#[cfg(test)]
mod tests;
mod unlock;

use evm::{bytes, hex0x};
pub use register::{RegisterArgs, ReopenArgs};
use unlock::buyer_entry;
pub use unlock::UnlockArgs;

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
    /// USDC on Base, the only valid emitter of `AuthorizationUsed` and `Transfer` for x402.
    usdc: [u8; 20],
    /// `file_id ‖ buyer address` for every wallet that paid.
    buyers: LookupMap<[u8; 52], ()>,
    /// `tx_hash ‖ log_index` of every payment that has released a key.
    used: LookupMap<[u8; 40], ()>,
    /// Prepaid storage (NEP-145 style) so a function-call key can `unlock` without a deposit.
    /// Only its owner can withdraw it; nobody else, the contract account included, can move it.
    balances: LookupMap<AccountId, u128>,
}

#[near]
impl Annon {
    #[init]
    pub fn new(
        mpc: AccountId,
        ckd_domain: u64,
        foreign_tx_domain: u64,
        payaion_splitter: String,
        usdc: String,
    ) -> Self {
        Self {
            files: LookupMap::new(b"f"),
            mpc,
            ckd_domain,
            foreign_tx_domain,
            payaion_splitter: bytes::<20>(&payaion_splitter, "payaion_splitter"),
            usdc: bytes::<20>(&usdc, "usdc"),
            buyers: LookupMap::new(b"b"),
            used: LookupMap::new(b"u"),
            balances: LookupMap::new(b"s"),
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
