//! Annon: NEAR releases a file key once it has verified the buyer's payment, made in NEAR USDC
//! (directly or through 1Click from any chain) or in USDC on Base (verified by NEAR MPC).
//! specs/near-settlement.md is the normative description.
//!
//! - `register`, `publish_header`, `reopen_seller`: a seller lists a file (`register.rs`)
//! - `ft_on_transfer`: a purchase paid in NEAR USDC, with automatic refunds (`receive.rs`)
//! - `fund_delivery`, `pay_slot`: the split paid out through NEAR Intents (`payout.rs`)
//! - `unlock`: a purchase paid on Base, verified by NEAR MPC (`unlock.rs`)
//! - `claim_key`, `reopen`: the buyer gets the key, again on any device (`keys.rs`)
//! - `stop_sales`, `takedown`, `restore` (`moderation.rs`)
//! - prepaid storage for callers that can't attach a deposit (`storage.rs`)
use near_sdk::store::LookupMap;
use near_sdk::{env, near, require, AccountId, PanicOnDefault};

mod events;
mod evm;
mod identity;
mod keys;
mod merkle;
mod moderation;
mod mpc;
mod payout;
mod purchase;
mod receive;
mod register;
mod state;
mod storage;
mod terms;
#[cfg(test)]
mod tests;
mod text;
mod unlock;
#[cfg(test)]
mod vectors;

use evm::{bytes, hex0x};
use merkle::Accumulator;
pub use moderation::TakedownReason;
pub use register::{RegisterArgs, SellerArgs, TermsJson};
use state::{Delivery, File, PurchaseRec};
pub use unlock::UnlockArgs;

/// Native USDC on NEAR mainnet.
pub const NEAR_USDC: &str = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";

#[near(serializers = [json])]
pub struct FileView {
    pub terms: TermsJson,
    pub terms_hash: String,
    /// For a NEAR seller: the published header hash, once published.
    pub header_hash: Option<String>,
    /// Unix seconds when the seller stopped sales, if they did.
    pub sales_stopped_at: Option<u64>,
    /// Set while the moderator has the file taken down.
    pub taken_down: Option<TakedownReason>,
}

/// What the contract was initialized with. A client checks a payment request against these
/// before the buyer pays.
#[near(serializers = [json])]
pub struct ConfigView {
    pub mpc: AccountId,
    pub ckd_domain: u64,
    pub foreign_tx_domain: u64,
    /// USDC on Base.
    pub usdc: String,
    pub network: String,
    pub near_usdc: AccountId,
    pub intents: AccountId,
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
    /// `near:mainnet`; purchase messages name it.
    network: String,
    /// The NEP-141 USDC this contract accepts.
    near_usdc: AccountId,
    /// NEAR Intents (`intents.near`), where payouts and refunds are credited.
    intents: AccountId,
    purchases: LookupMap<[u8; 32], PurchaseRec>,
    /// `purchase_id ‖ grant` → buyer key, for grants after 0.
    grants: LookupMap<[u8; 36], [u8; 48]>,
    /// `SHA256(purchase_id ‖ key)` → grant, so an identical reopen gives the same grant.
    grant_of_key: LookupMap<[u8; 32], u32>,
    /// `SHA256(Borsh(recovery))` → number of purchases; `that ‖ index` → purchase id.
    recovery_count: LookupMap<[u8; 32], u32>,
    recovery: LookupMap<[u8; 36], [u8; 32]>,
    deliveries: LookupMap<u64, Delivery>,
    next_delivery: u64,
    /// Refunds for deliveries that arrived while the storage reserve was empty.
    refunds: Accumulator,
    /// Leaves of `refunds` already turned into refunds.
    materialized: LookupMap<u64, ()>,
    /// NEAR (yocto) set aside to pay the storage of deliveries; funded by anyone.
    reserve: u128,
    /// `tx_hash ‖ log_index` of every Base payment that has released a key.
    used: LookupMap<[u8; 40], ()>,
    /// One per seller reopen that asked MPC for the key, whether or not MPC answered: a second
    /// call with the same file and one-time key is refused, so a replayed authorization can't
    /// make anyone pay for the same release twice.
    reopened: LookupMap<[u8; 32], ()>,
    /// Prepaid storage (NEP-145 style) so a function-call key can call without a deposit.
    /// Only its owner can withdraw it; nobody else, the contract account included, can move it.
    balances: LookupMap<AccountId, u128>,
}

#[near]
impl Annon {
    /// `network` (default `near:mainnet`), `near_usdc` (default native USDC on NEAR mainnet) and
    /// `intents` (default `intents.near`) configure the NEAR route.
    #[init]
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        mpc: AccountId,
        ckd_domain: u64,
        foreign_tx_domain: u64,
        usdc: String,
        network: Option<String>,
        near_usdc: Option<AccountId>,
        intents: Option<AccountId>,
    ) -> Self {
        // Deploy and init in one transaction, signed by the contract account. Nobody else can pick
        // the MPC account, domains or payment sources the contract trusts.
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
            network: network.unwrap_or_else(|| "near:mainnet".into()),
            near_usdc: near_usdc.unwrap_or_else(|| NEAR_USDC.parse().unwrap()),
            intents: intents.unwrap_or_else(|| "intents.near".parse().unwrap()),
            purchases: LookupMap::new(b"p"),
            grants: LookupMap::new(b"g"),
            grant_of_key: LookupMap::new(b"k"),
            recovery_count: LookupMap::new(b"c"),
            recovery: LookupMap::new(b"i"),
            deliveries: LookupMap::new(b"d"),
            next_delivery: 0,
            refunds: Accumulator::new(),
            materialized: LookupMap::new(b"m"),
            reserve: 0,
            used: LookupMap::new(b"u"),
            reopened: LookupMap::new(b"r"),
            balances: LookupMap::new(b"s"),
        }
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
                terms: TermsJson::encode(&f.terms),
                terms_hash: hex0x(&f.terms.hash()),
                header_hash: (f.header_hash != [0; 32]).then(|| hex0x(&f.header_hash)),
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
            network: self.network.clone(),
            near_usdc: self.near_usdc.clone(),
            intents: self.intents.clone(),
        }
    }
}

#[cfg(test)]
mod init_tests {
    use crate::tests::*;
    use crate::NEAR_USDC;
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
        assert_eq!(c.network, "near:mainnet");
        assert_eq!(c.near_usdc.as_str(), NEAR_USDC);
        assert_eq!(c.intents.as_str(), "intents.near");
    }
}
