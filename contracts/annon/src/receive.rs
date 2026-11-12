//! Receiving NEAR USDC (specs/near-settlement.md §6): every delivery with a readable refund
//! identity is kept and gets exactly one disposition; anything else is refused.
use near_sdk::json_types::U128;
use near_sdk::serde_json::json;
use near_sdk::{env, near, require, AccountId};

use crate::events::emit;
use crate::evm::{bytes, hex0x};
use crate::identity::{Identity, IdentityJson};
use crate::merkle::{root_of, Leaf};
use crate::purchase::{parse, Parsed, Purchase};
use crate::register::now;
use crate::state::{Delivery, PurchaseRec, Slot, Step, PENDING};
use crate::{Annon, AnnonExt};

/// Admission allowance before a write (purchase, delivery with up to 9 slots,
/// recovery index and open-delivery index). Debited by what was actually used.
pub const DELIVERY_BYTES: u64 = 4096;

/// Why a delivery was refunded (stored in `Delivery::reason`).
pub mod reason {
    pub const ACCEPTED: u8 = 0;
    pub const UNUSABLE: u8 = 1;
    pub const UNKNOWN_FILE: u8 = 2;
    pub const WRONG_TERMS: u8 = 3;
    pub const NOT_PUBLISHED: u8 = 4;
    pub const EXPIRED: u8 = 5;
    pub const STOPPED: u8 = 6;
    pub const TAKEN_DOWN: u8 = 7;
    pub const DUPLICATE: u8 = 8;
    pub const UNDERPAID: u8 = 9;
    pub const NO_STORAGE: u8 = 10;
    pub const FILE_STORAGE_LOW: u8 = 11;
}

#[near(serializers = [json])]
#[derive(Clone)]
pub struct LeafArgs {
    pub delivery_id: u64,
    pub refund: IdentityJson,
    pub amount: U128,
}

impl Annon {
    /// Why this purchase can't be accepted now for `amount`, or Ok.
    fn check(&self, p: &Purchase, id: &[u8; 32], amount: u128) -> Result<(), u8> {
        let file = self.files.get(&p.file_id).ok_or(reason::UNKNOWN_FILE)?;
        let t = &file.terms;
        if p.terms_hash != t.hash() || p.price != t.near.price {
            return Err(reason::WRONG_TERMS);
        }
        if matches!(t.seller, Identity::Near(_)) && file.header_hash == [0; 32] {
            return Err(reason::NOT_PUBLISHED);
        }
        if now() > p.expires_at {
            return Err(reason::EXPIRED);
        }
        if file.taken_down != 0 {
            return Err(reason::TAKEN_DOWN);
        }
        if file.sales_stopped_at != 0 {
            return Err(reason::STOPPED);
        }
        if self.purchases.contains_key(id) {
            return Err(reason::DUPLICATE);
        }
        if amount < p.price {
            return Err(reason::UNDERPAID);
        }
        Ok(())
    }

    fn new_delivery(&mut self, id: u64, d: Delivery) {
        self.deliveries.insert(id, d);
        self.open_deliveries.insert(id);
    }

    pub(crate) fn index_purchase(&mut self, recovery: &Identity, purchase_id: [u8; 32]) {
        let k = recovery_key(recovery);
        if let Some((n, _)) = self.recovery_count.get_mut(&k) {
            let mut entry = [0u8; 36];
            entry[..32].copy_from_slice(&k);
            entry[32..].copy_from_slice(&n.to_le_bytes());
            self.recovery.insert(entry, purchase_id);
            *n = n.checked_add(1).expect("recovery index full");
        } else {
            self.recovery_count.insert(k, (1, purchase_id));
        }
    }
}

pub(crate) fn recovery_key(identity: &Identity) -> [u8; 32] {
    env::sha256_array(near_sdk::borsh::to_vec(identity).unwrap())
}

fn refund_slot(to: Identity, amount: u128) -> Slot {
    Slot {
        to,
        amount,
        step: Step {
            state: PENDING,
            attempt: 0,
        },
    }
}

#[near]
impl Annon {
    /// NEP-141 receiver for NEAR USDC. Returns the amount it does not keep: all of it for another
    /// token or a message with no readable refund identity, 0 otherwise. Schedules nothing: money
    /// moves later through `fund_delivery` and `pay_slot`, the key through `claim_key`.
    pub fn ft_on_transfer(&mut self, sender_id: AccountId, amount: U128, msg: String) -> U128 {
        if env::predecessor_account_id() != self.near_usdc {
            return amount;
        }
        let (refund, outcome) = match parse(&msg, &self.network, self.near_usdc.as_str(), 0) {
            Parsed::Foreign => {
                env::log_str("delivery refused: not an Annon purchase");
                return amount;
            }
            Parsed::Unusable { refund, why } => {
                env::log_str(&format!("purchase unusable: {why}"));
                (refund, Err(reason::UNUSABLE))
            }
            Parsed::Ok { purchase, id } => {
                let r = self
                    .check(&purchase, &id, amount.0)
                    .map(|()| (purchase.clone(), id));
                (purchase.refund, r)
            }
        };
        let delivery_id = self.next_delivery;
        self.next_delivery += 1;

        let byte = env::storage_byte_cost().as_yoctonear();
        let admission = byte * u128::from(DELIVERY_BYTES);
        let outcome = outcome.and_then(|(p, id)| {
            let available = self.file(&p.file_id).purchase_storage_balance;
            if available < admission {
                emit(
                    "file_storage_low",
                    json!({ "file_id": hex0x(&p.file_id),
                    "available": U128(available), "admission_requirement": U128(admission) }),
                );
                Err(reason::FILE_STORAGE_LOW)
            } else {
                Ok((p, id))
            }
        });
        // Rejected payments use only refund working capital, never a file budget.
        if outcome.is_err() && self.reserve < admission {
            if self.refunds.is_full() {
                // Note: 2^32 leaves; unreachable in practice. Refused, so NEP-141 returns it.
                env::log_str("delivery refused: no storage reserve and the refund tree is full");
                self.next_delivery -= 1;
                return amount;
            }
            // No storage of its own: a fixed-size leaf in the refund accumulator instead.
            let leaf = Leaf {
                network: self.network.clone(),
                contract: env::current_account_id(),
                delivery_id,
                refund: refund.clone(),
                amount: amount.0,
            };
            let index = self.refunds.push(leaf.hash());
            emit(
                "refund_leaf",
                json!({ "index": index, "delivery_id": delivery_id, "refund": refund.intents_id(),
                        "refund_kind": refund.kind(), "amount": amount, "root": hex0x(&self.refunds.root) }),
            );
            return U128(0);
        }

        let before = env::storage_usage();
        let accepted = outcome
            .as_ref()
            .ok()
            .map(|(p, id)| (p.file_id, *id, p.buyer_key, p.recovery.text()));
        match outcome {
            Ok((p, id)) => {
                let file = self.files.get(&p.file_id).unwrap();
                let shares = file.terms.shares();
                let mut slots: Vec<Slot> = file
                    .terms
                    .near
                    .recipients
                    .iter()
                    .zip(shares)
                    .map(|((to, _), amount)| refund_slot(to.clone(), amount))
                    .collect();
                if amount.0 > p.price {
                    slots.push(refund_slot(refund.clone(), amount.0 - p.price));
                }
                self.purchases.insert(
                    id,
                    PurchaseRec {
                        file_id: p.file_id,
                        buyer_key: p.buyer_key,
                        recovery: p.recovery.clone(),
                        route: 0,
                        delivery: delivery_id,
                        accepted_at: now(),
                        grants: 1,
                    },
                );
                self.index_purchase(&p.recovery, id);
                self.new_delivery(
                    delivery_id,
                    Delivery {
                        amount: amount.0,
                        sender: sender_id,
                        purchase: Some(id),
                        reason: reason::ACCEPTED,
                        fund: Step {
                            state: PENDING,
                            attempt: 0,
                        },
                        funded: 0,
                        slots,
                    },
                );
            }
            Err(why) => {
                self.new_delivery(
                    delivery_id,
                    Delivery {
                        amount: amount.0,
                        sender: sender_id,
                        purchase: None,
                        reason: why,
                        fund: Step {
                            state: PENDING,
                            attempt: 0,
                        },
                        funded: 0,
                        slots: vec![refund_slot(refund.clone(), amount.0)],
                    },
                );
                emit(
                    "refund_due",
                    json!({ "delivery_id": delivery_id, "reason": why, "refund": refund.text(), "amount": amount }),
                );
            }
        }
        self.deliveries.flush();
        self.open_deliveries.flush();
        self.purchases.flush();
        self.recovery.flush();
        self.recovery_count.flush();
        let used = env::storage_usage().saturating_sub(before);
        require!(
            used <= DELIVERY_BYTES,
            "acceptance exceeds storage allowance"
        );
        let cost = byte * u128::from(used);
        if let Some((file_id, id, buyer_key, recovery)) = accepted {
            let file = self.files.get_mut(&file_id).unwrap();
            file.purchase_storage_balance = file
                .purchase_storage_balance
                .checked_sub(cost)
                .expect("file storage underflow");
            let remaining = file.purchase_storage_balance;
            emit(
                "purchase_accepted",
                json!({ "purchase_id": hex0x(&id), "file_id": hex0x(&file_id),
                "delivery_id": delivery_id, "buyer_key": hex0x(&buyer_key), "recovery": recovery,
                "charged_bytes": used, "charged_cost": U128(cost), "remaining_budget": U128(remaining) }),
            );
            if remaining < admission {
                emit(
                    "file_storage_low",
                    json!({ "file_id": hex0x(&file_id), "available": U128(remaining),
                    "admission_requirement": U128(admission) }),
                );
            }
        } else {
            self.reserve = self
                .reserve
                .checked_sub(cost)
                .expect("refund reserve underflow");
        }
        emit(
            "delivery_received",
            json!({ "delivery_id": delivery_id, "amount": amount }),
        );
        U128(0)
    }

    /// Anyone adds NEAR to pay the storage of future deliveries.
    #[payable]
    pub fn fund_receiver_reserve(&mut self) {
        self.reserve += env::attached_deposit().as_yoctonear();
    }

    /// NEAR (yocto) refund working capital. Below 4096 bytes' worth, rejected payments
    /// become refund leaves; funded purchases remain independent.
    pub fn receiver_reserve(&self) -> U128 {
        U128(self.reserve)
    }

    /// Turns a refund leaf into an ordinary refund; the caller pays its storage.
    #[payable]
    pub fn materialize_refund(&mut self, leaf: LeafArgs, index: u64, proof: Vec<String>) {
        let refund =
            Identity::from_json(&leaf.refund).unwrap_or_else(|| env::panic_str("invalid identity"));
        let l = Leaf {
            network: self.network.clone(),
            contract: env::current_account_id(),
            delivery_id: leaf.delivery_id,
            refund: refund.clone(),
            amount: leaf.amount.0,
        };
        let proof: Vec<[u8; 32]> = proof.iter().map(|p| bytes::<32>(p, "proof")).collect();
        // The current root or a recent one: deliveries appended meanwhile don't void the proof.
        require!(
            root_of(l.hash(), index, &proof).is_some_and(|r| self.refunds.knows(&r)),
            "not a leaf of the refund accumulator"
        );
        require!(
            !self.materialized.contains_key(&index),
            "already materialized"
        );
        require!(
            !self.deliveries.contains_key(&leaf.delivery_id),
            "delivery already recorded"
        );
        let before = env::storage_usage();
        self.materialized.insert(index, ());
        self.new_delivery(
            leaf.delivery_id,
            Delivery {
                amount: leaf.amount.0,
                sender: env::current_account_id(),
                purchase: None,
                reason: reason::NO_STORAGE,
                fund: Step {
                    state: PENDING,
                    attempt: 0,
                },
                funded: 0,
                slots: vec![refund_slot(refund.clone(), leaf.amount.0)],
            },
        );
        self.materialized.flush();
        self.deliveries.flush();
        self.open_deliveries.flush();
        self.pay_for_storage(env::storage_usage() - before);
        emit(
            "refund_due",
            json!({ "delivery_id": leaf.delivery_id, "reason": reason::NO_STORAGE, "refund": refund.text(), "amount": leaf.amount }),
        );
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::reason::*;
    use crate::identity::IdentityJson;
    use crate::merkle::{tests::proof, Leaf};
    use crate::purchase::Purchase;
    use crate::tests::*;
    use crate::*;
    use near_sdk::json_types::U128;
    use near_sdk::NearToken;

    /// A contract with the test file listed and a storage reserve for deliveries.
    pub(crate) fn selling() -> Annon {
        let mut c = contract();
        registered(&mut c, &Seller::new(1));
        as_caller("anyone.near", NearToken::from_near(1));
        c.fund_receiver_reserve();
        as_caller("anyone.near", NearToken::from_near(1));
        c.fund_file_storage(FILE.into(), None);
        c
    }

    /// `amount` of NEAR USDC arrives from `buyer.near` with `msg`; returns what the contract
    /// gives back.
    pub(crate) fn deliver(c: &mut Annon, amount: u128, msg: &str) -> u128 {
        as_caller(NEAR_USDC, NearToken::from_yoctonear(0));
        c.ft_on_transfer("buyer.near".parse().unwrap(), U128(amount), msg.into())
            .0
    }

    pub(crate) fn near_purchase() -> Purchase {
        purchase(0, Seller::new(7).id())
    }

    fn reason_of(c: &Annon, id: u64) -> u8 {
        c.get_delivery(id).unwrap().reason
    }

    fn refund_only(c: &Annon, id: u64, amount: u128) {
        let d = c.get_delivery(id).unwrap();
        assert_eq!(d.purchase, None);
        assert_eq!(d.slots.len(), 1);
        assert_eq!(d.slots[0].to.id, PAYER);
        assert_eq!(d.slots[0].amount, U128(amount));
    }

    #[test]
    fn another_token_is_returned_whole() {
        let mut c = selling();
        as_caller("usdt.tether-token.near", NearToken::from_yoctonear(0));
        let back = c.ft_on_transfer(
            "buyer.near".parse().unwrap(),
            U128(10_000),
            message(&near_purchase()),
        );
        assert_eq!(back, U128(10_000));
        assert!(c.get_delivery(0).is_none());
    }

    #[test]
    fn a_message_without_a_refund_identity_is_refused() {
        let mut c = selling();
        assert_eq!(deliver(&mut c, 10_000, "hello"), 10_000);
        assert_eq!(
            deliver(
                &mut c,
                10_000,
                r#"{"annon":2,"refund":{"kind":"evm","id":"0xAB"},"#
            ),
            10_000
        );
        assert!(c.get_delivery(0).is_none());
    }

    #[test]
    fn the_price_buys_the_file_and_is_split() {
        let mut c = selling();
        let p = near_purchase();
        assert_eq!(deliver(&mut c, 10_000, &message(&p)), 0);
        let id = format!("0x{}", hex::encode(p.id()));
        let rec = c.get_purchase(id.clone()).unwrap();
        assert_eq!(
            (rec.route.as_str(), rec.delivery, rec.buyer_key.as_str()),
            ("near-usdc", Some(0), G1)
        );
        let d = c.get_delivery(0).unwrap();
        assert_eq!(
            (d.purchase, d.reason, d.amount),
            (Some(id.clone()), ACCEPTED, U128(10_000))
        );
        let slots: Vec<(String, U128)> = d
            .slots
            .iter()
            .map(|s| (s.to.id.clone(), s.amount))
            .collect();
        assert_eq!(
            slots,
            vec![(PAY_TO.into(), U128(9_500)), (PLATFORM.into(), U128(500))]
        );
        assert_eq!(events("purchase_accepted")[0]["purchase_id"], id);
        assert_eq!(c.purchases_of(Seller::new(7).id(), 0, 10), vec![id]);
    }

    #[test]
    fn an_overpayment_refunds_the_excess() {
        let mut c = selling();
        deliver(&mut c, 12_345, &message(&near_purchase()));
        let d = c.get_delivery(0).unwrap();
        assert_eq!(d.slots.len(), 3);
        assert_eq!(
            (d.slots[2].to.id.as_str(), d.slots[2].amount),
            (PAYER, U128(2_345))
        );
    }

    #[test]
    fn an_underpayment_is_refunded_and_the_purchase_stays_open() {
        let mut c = selling();
        let p = near_purchase();
        assert_eq!(deliver(&mut c, 9_999, &message(&p)), 0);
        assert_eq!(reason_of(&c, 0), UNDERPAID);
        refund_only(&c, 0, 9_999);
        assert!(c
            .get_purchase(format!("0x{}", hex::encode(p.id())))
            .is_none());
        deliver(&mut c, 10_000, &message(&p));
        assert_eq!(reason_of(&c, 1), ACCEPTED);
    }

    #[test]
    fn a_second_payment_for_one_purchase_is_refunded() {
        let mut c = selling();
        let m = message(&near_purchase());
        deliver(&mut c, 10_000, &m);
        deliver(&mut c, 10_000, &m);
        assert_eq!(reason_of(&c, 1), DUPLICATE);
        refund_only(&c, 1, 10_000);
        assert_eq!(events("refund_due")[0]["refund"], format!("EVM {PAYER}"));
    }

    #[test]
    fn an_expired_purchase_is_refunded() {
        let mut c = selling();
        let m = message(&near_purchase());
        at_time(NEAR_USDC, NearToken::from_yoctonear(0), NOW_S + 3_601);
        c.ft_on_transfer("buyer.near".parse().unwrap(), U128(10_000), m);
        assert_eq!(reason_of(&c, 0), EXPIRED);
    }

    #[test]
    fn a_stopped_file_is_refunded() {
        let mut c = selling();
        let stop = crate::register::SellerArgs {
            file_id: FILE.into(),
            key: None,
            deadline: NOW_S + 60,
        };
        let auth = Seller::new(1).auth(&c.stop_sales_text(stop.clone()));
        c.stop_sales(stop, auth);
        deliver(&mut c, 10_000, &message(&near_purchase()));
        assert_eq!(reason_of(&c, 0), STOPPED);
    }

    #[test]
    fn a_taken_down_file_is_refunded() {
        let mut c = selling();
        as_caller(MODERATOR, NearToken::from_yoctonear(1));
        c.takedown(FILE.into(), TakedownReason::CourtOrder);
        deliver(&mut c, 10_000, &message(&near_purchase()));
        assert_eq!(reason_of(&c, 0), TAKEN_DOWN);
    }

    fn refunded_for(change: impl FnOnce(&mut Purchase), why: u8) {
        let mut c = selling();
        let mut p = near_purchase();
        change(&mut p);
        assert_eq!(deliver(&mut c, 10_000, &message(&p)), 0);
        assert_eq!(reason_of(&c, 0), why);
        refund_only(&c, 0, 10_000);
    }

    #[test]
    fn a_purchase_at_another_price_is_refunded() {
        refunded_for(|p| p.price = 9_000, WRONG_TERMS);
    }

    #[test]
    fn a_purchase_under_other_terms_is_refunded() {
        refunded_for(|p| p.terms_hash = [7; 32], WRONG_TERMS);
    }

    #[test]
    fn a_purchase_of_an_unknown_file_is_refunded() {
        refunded_for(|p| p.file_id = [0x99; 32], UNKNOWN_FILE);
    }

    fn unusable(m: String) {
        let mut c = selling();
        assert_eq!(deliver(&mut c, 10_000, &m), 0, "{m}");
        assert_eq!(reason_of(&c, 0), UNUSABLE, "{m}");
        refund_only(&c, 0, 10_000);
    }

    #[test]
    fn a_non_canonical_number_is_refunded() {
        unusable(message(&near_purchase()).replace("\"price\":\"10000\"", "\"price\":\"010000\""));
    }

    #[test]
    fn a_buyer_key_off_the_curve_is_refunded() {
        unusable(message(&Purchase {
            buyer_key: [0x33; 48],
            ..near_purchase()
        }));
    }

    #[test]
    fn a_base_purchase_sent_to_the_near_route_is_refunded() {
        unusable(message(&purchase(1, Seller::new(7).id())));
    }

    #[test]
    fn trailing_bytes_are_refunded() {
        unusable(message(&near_purchase()) + " ");
    }

    #[test]
    fn a_bare_refund_prefix_is_refunded() {
        unusable(format!(
            "{{\"annon\":2,\"refund\":{{\"kind\":\"evm\",\"id\":\"{PAYER}\"}},"
        ));
    }

    #[test]
    fn a_near_seller_sells_nothing_before_publishing_the_header() {
        let mut c = contract();
        as_caller("seller.near", NearToken::from_millinear(100));
        let a = args_for(near_id("seller.near"));
        let hash = a.terms.decode().hash();
        c.register(a, None);
        as_caller("anyone.near", NearToken::from_near(1));
        c.fund_receiver_reserve();
        as_caller("anyone.near", NearToken::from_near(1));
        c.fund_file_storage(FILE.into(), None);
        let p = Purchase {
            terms_hash: hash,
            ..near_purchase()
        };
        deliver(&mut c, 10_000, &message(&p));
        assert_eq!(reason_of(&c, 0), NOT_PUBLISHED);
        as_caller("seller.near", NearToken::from_yoctonear(0));
        c.publish_header(FILE.into(), format!("0x{}", "ab".repeat(32)));
        deliver(&mut c, 10_000, &message(&p));
        assert_eq!(reason_of(&c, 1), ACCEPTED);
    }

    #[test]
    fn a_purchase_pays_its_storage_from_the_file() {
        let mut c = selling();
        let before = c.file_storage_balance(FILE.into()).available.0;
        deliver(&mut c, 10_000, &message(&near_purchase()));
        let used = before - c.file_storage_balance(FILE.into()).available.0;
        assert_eq!(c.receiver_reserve(), U128(c.reserve));
        assert!(
            used > 0 && used < NearToken::from_millinear(41).as_yoctonear(),
            "{used}"
        );
    }

    fn leaf(delivery_id: u64, amount: u128) -> Leaf {
        Leaf {
            network: "near:mainnet".into(),
            contract: CONTRACT.parse().unwrap(),
            delivery_id,
            refund: identity(&Seller::new(7).id()),
            amount,
        }
    }

    fn leaf_args(delivery_id: u64, amount: u128) -> super::LeafArgs {
        super::LeafArgs {
            delivery_id,
            refund: Seller::new(7).id(),
            amount: U128(amount),
        }
    }

    fn hexes(p: Vec<[u8; 32]>) -> Vec<String> {
        p.iter().map(|h| format!("0x{}", hex::encode(h))).collect()
    }

    /// Two deliveries with no reserve: the test purchase, then 7 units with a bare refund prefix.
    fn two_leaves() -> (Annon, [[u8; 32]; 2]) {
        let mut c = contract();
        registered(&mut c, &Seller::new(1));
        assert_eq!(deliver(&mut c, 10_000, &message(&near_purchase())), 0);
        assert_eq!(events("refund_leaf")[0]["index"], 0);
        let bare = format!("{{\"annon\":2,\"refund\":{{\"kind\":\"evm\",\"id\":\"{PAYER}\"}},");
        assert_eq!(deliver(&mut c, 7, &bare), 0);
        assert_eq!(events("refund_leaf")[0]["index"], 1);
        assert!(c.get_delivery(0).is_none() && c.get_delivery(1).is_none());
        assert!(c
            .get_purchase(format!("0x{}", hex::encode(near_purchase().id())))
            .is_none());
        assert_eq!(c.refund_root()["count"], 2);
        (c, [leaf(0, 10_000).hash(), leaf(1, 7).hash()])
    }

    #[test]
    fn without_a_reserve_a_delivery_becomes_a_refund_leaf_that_anyone_can_materialize() {
        let (mut c, leaves) = two_leaves();
        as_caller("keeper.near", NearToken::from_millinear(50));
        c.materialize_refund(leaf_args(1, 7), 1, hexes(proof(&leaves, 1)));
        let d = c.get_delivery(1).unwrap();
        assert_eq!(
            (d.reason, d.slots[0].amount, d.slots[0].to.id.as_str()),
            (NO_STORAGE, U128(7), PAYER)
        );
    }

    #[test]
    #[should_panic(expected = "already materialized")]
    fn a_leaf_is_materialized_once() {
        let (mut c, leaves) = two_leaves();
        as_caller("keeper.near", NearToken::from_millinear(50));
        c.materialize_refund(leaf_args(1, 7), 1, hexes(proof(&leaves, 1)));
        as_caller("keeper.near", NearToken::from_millinear(50));
        c.materialize_refund(leaf_args(1, 7), 1, hexes(proof(&leaves, 1)));
    }

    #[test]
    #[should_panic(expected = "not a leaf of the refund accumulator")]
    fn a_leaf_with_another_amount_is_refused() {
        let (mut c, leaves) = two_leaves();
        as_caller("keeper.near", NearToken::from_millinear(50));
        c.materialize_refund(leaf_args(0, 10_001), 0, hexes(proof(&leaves, 0)));
    }

    #[test]
    #[should_panic(expected = "not a leaf of the refund accumulator")]
    fn a_leaf_at_another_index_is_refused() {
        let (mut c, leaves) = two_leaves();
        as_caller("keeper.near", NearToken::from_millinear(50));
        c.materialize_refund(leaf_args(0, 10_000), 1, hexes(proof(&leaves, 1)));
    }

    #[test]
    fn identity_json_round_trips() {
        let j = IdentityJson {
            kind: "solana".into(),
            id: "ab".repeat(32),
        };
        assert_eq!(IdentityJson::from(&identity(&j)).id, j.id);
    }
}
