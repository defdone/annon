//! Annon: NEAR releases a file key once it has verified the buyer's payment on Base.
//!
//! - `register`: a seller lists a file and gets its key (`register.rs`)
//! - `unlock`: a buyer's payment on Base, verified by NEAR MPC, releases the key (`unlock.rs`)
//! - `reopen`: the seller or a buyer gets the key again on any device (`register.rs`)
//! - prepaid storage for callers that can't attach a deposit (`storage.rs`)
use near_sdk::json_types::U128;
use near_sdk::store::LookupMap;
use near_sdk::{env, near, require, AccountId, PanicOnDefault};

mod events;
mod evm;
mod moderation;
mod mpc;
mod register;
mod storage;
#[cfg(test)]
mod tests;
mod text;
mod unlock;

use evm::{bytes, hex0x};
pub use moderation::{StopSalesArgs, TakedownReason};
pub use register::{RegisterArgs, ReopenArgs};
use unlock::buyer_entry;
pub use unlock::UnlockArgs;

#[near(serializers = [json])]
pub struct FileView {
    pub seller: String,
    pub price: U128,
    /// Where the payment goes: USDC `Transfer` to this address, `0x` and lowercase. A wallet, or
    /// any contract the seller chose (e.g. an immutable revenue split).
    pub pay_to: String,
    pub cipher_hash: String,
    pub moderator: Option<AccountId>,
    /// Unix seconds when the seller stopped sales, if they did.
    pub sales_stopped_at: Option<u64>,
    /// Set while the moderator has the file taken down.
    pub taken_down: Option<TakedownReason>,
}

/// What the contract was initialized with: the token it accepts and the MPC it asks. A client
/// checks a payment request against these before the buyer signs.
#[near(serializers = [json])]
pub struct ConfigView {
    pub mpc: AccountId,
    pub ckd_domain: u64,
    pub foreign_tx_domain: u64,
    pub usdc: String,
}

#[near(serializers = [borsh])]
struct File {
    seller: [u8; 20],
    price: u128,
    pay_to: [u8; 20],
    cipher_hash: [u8; 32],
    moderator: Option<AccountId>,
    // Fixed width, paid for at `register`, so a stop or takedown never grows storage.
    /// Unix seconds of `stop_sales`; 0 while the file is on sale.
    sales_stopped_at: u64,
    /// 0 while available, else a `TakedownReason` code (`moderation::reason`).
    taken_down: u8,
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
    /// USDC on Base, the only valid emitter of the `AuthorizationUsed` and `Transfer` of a payment.
    usdc: [u8; 20],
    /// `file_id ‖ buyer address` for every wallet that paid.
    buyers: LookupMap<[u8; 52], ()>,
    /// `tx_hash ‖ log_index` of every payment that has released a key.
    used: LookupMap<[u8; 40], ()>,
    /// One per `reopen` that asked MPC for the key, whether or not MPC answered: a second call with
    /// the same file, wallet and one-time key is refused, so a replayed signature can't make anyone
    /// pay for the same release twice. After a failure the wallet signs again for a new key.
    reopened: LookupMap<[u8; 32], ()>,
    /// Prepaid storage (NEP-145 style) so a function-call key can `unlock` without a deposit.
    /// Only its owner can withdraw it; nobody else, the contract account included, can move it.
    balances: LookupMap<AccountId, u128>,
}

#[near]
impl Annon {
    #[init]
    pub fn new(mpc: AccountId, ckd_domain: u64, foreign_tx_domain: u64, usdc: String) -> Self {
        // Deploy and init in one transaction, signed by the contract account. Nobody else can pick
        // the MPC account, domains or payment sources that a locked contract trusts forever.
        require!(
            env::predecessor_account_id() == env::current_account_id(),
            "only the contract account can initialize it"
        );
        Self {
            files: LookupMap::new(b"f"),
            mpc,
            ckd_domain,
            foreign_tx_domain,
            usdc: bytes::<20>(&usdc, "usdc"),
            buyers: LookupMap::new(b"b"),
            used: LookupMap::new(b"u"),
            reopened: LookupMap::new(b"r"),
            balances: LookupMap::new(b"s"),
        }
    }

    pub fn is_buyer(&self, file_id: String, wallet: String) -> bool {
        self.buyers.contains_key(&buyer_entry(
            &bytes::<32>(&file_id, "file_id"),
            &bytes::<20>(&wallet, "wallet"),
        ))
    }

    /// Whether a Base payment has already unlocked a file: its transaction and the index of its
    /// first log (`AuthorizationUsed`), as in `payment_verified`.
    pub fn is_payment_used(&self, base_tx: String, log_index: u64) -> bool {
        let mut payment = [0u8; 40];
        payment[..32].copy_from_slice(&bytes::<32>(&base_tx, "base_tx"));
        payment[32..].copy_from_slice(&log_index.to_be_bytes());
        self.used.contains_key(&payment)
    }

    pub fn get_file(&self, file_id: String) -> Option<FileView> {
        self.files
            .get(&bytes::<32>(&file_id, "file_id"))
            .map(|f| FileView {
                seller: hex0x(&f.seller),
                price: U128(f.price),
                pay_to: hex0x(&f.pay_to),
                cipher_hash: hex0x(&f.cipher_hash),
                moderator: f.moderator.clone(),
                sales_stopped_at: (f.sales_stopped_at != 0).then_some(f.sales_stopped_at),
                taken_down: moderation::reason(f.taken_down),
            })
    }

    pub fn get_config(&self) -> ConfigView {
        ConfigView {
            mpc: self.mpc.clone(),
            ckd_domain: self.ckd_domain,
            foreign_tx_domain: self.foreign_tx_domain,
            usdc: hex0x(&self.usdc),
        }
    }
}

#[cfg(test)]
mod init_tests {
    use crate::tests::*;
    use near_sdk::NearToken;

    #[test]
    #[should_panic(expected = "only the contract account can initialize it")]
    fn nobody_else_can_initialize_the_contract() {
        as_caller("attacker.near", NearToken::from_yoctonear(0));
        init();
    }

    #[test]
    fn get_config_shows_what_init_was_given() {
        as_caller(CONTRACT, NearToken::from_yoctonear(0));
        let c = init().get_config();
        assert_eq!(c.mpc.as_str(), "v1.signer");
        assert_eq!((c.ckd_domain, c.foreign_tx_domain), (2, 3));
        assert_eq!(c.usdc, USDC.to_lowercase());
    }
}
