//! What the contract keeps per file, purchase and delivery (specs/near-settlement.md §3-§9).
use near_sdk::{near, AccountId};

use crate::identity::Identity;
use crate::terms::Terms;

#[near(serializers = [borsh])]
pub struct File {
    pub terms: Terms,
    /// For a NEAR seller: SHA256 of the PAY2 header without its trailer, published once
    /// (all zero until then; fixed width, so publishing grows nothing).
    pub header_hash: [u8; 32],
    // Fixed width, paid for at registration.
    pub sales_stopped_at: u64,
    pub taken_down: u8,
}

#[near(serializers = [borsh])]
pub struct PurchaseRec {
    pub file_id: [u8; 32],
    pub terms_hash: [u8; 32],
    /// Grant 0: the buyer key from the purchase.
    pub buyer_key: [u8; 48],
    pub recovery: Identity,
    /// 0 near-usdc, 1 base-usdc.
    pub route: u8,
    /// The delivery that paid (NEAR route), or u64::MAX.
    pub delivery: u64,
    pub accepted_at: u64,
    /// Number of grants, including grant 0.
    pub grants: u32,
}

/// One step of moving money: 0 pending, 1 in flight (attempt), 2 done. Never reset by time.
#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Step {
    pub state: u8,
    pub attempt: u32,
}

pub const PENDING: u8 = 0;
pub const IN_FLIGHT: u8 = 1;
pub const DONE: u8 = 2;

#[near(serializers = [borsh])]
pub struct Slot {
    pub to: Identity,
    pub amount: u128,
    pub step: Step,
}

#[near(serializers = [borsh])]
pub struct Delivery {
    pub amount: u128,
    pub sender: AccountId,
    /// Set when this delivery bought something.
    pub purchase: Option<[u8; 32]>,
    /// Why it was refunded (0 when accepted with no refund).
    pub reason: u8,
    /// Moving `amount` into this contract's own Intents balance.
    pub fund: Step,
    pub funded: u128,
    /// Split shares, then a refund slot if any. Fixed at creation: callbacks only change `step`.
    pub slots: Vec<Slot>,
}
