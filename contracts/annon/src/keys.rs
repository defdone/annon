//! The buyer's key (specs/near-settlement.md §9): `claim_key` releases a purchase's key to any of
//! its grants, `reopen` adds a grant (a fresh one-time key) authorized by the purchase's recovery
//! identity, and `purchases_of` finds purchases on a new device.
use near_sdk::serde_json::json;
use near_sdk::{env, near, require};

use crate::events::emit;
use crate::evm::{bytes, hex0x};
use crate::identity::{Auth, Identity, IdentityJson};
use crate::purchase::valid_bls_key;
use crate::receive::recovery_key;
use crate::register::now;
use crate::state::PurchaseRec;
use crate::text::utc;
use crate::{Annon, AnnonExt};

#[near(serializers = [json])]
#[derive(Clone)]
#[serde(deny_unknown_fields)]
pub struct ReopenArgs {
    pub purchase_id: String,
    /// A fresh one-time BLS12-381 G1 key (48 bytes compressed, hex).
    pub fresh_key: String,
    /// 32 random bytes, so every reopen text is new to the wallet.
    pub nonce: String,
    pub deadline: u64,
}

#[near(serializers = [json])]
pub struct PurchaseView {
    pub file_id: String,
    pub terms_hash: String,
    pub buyer_key: String,
    pub recovery: IdentityJson,
    pub route: String,
    /// The NEAR delivery that paid; none for Base.
    pub delivery: Option<u64>,
    pub accepted_at: u64,
    pub grants: u32,
}

impl Annon {
    fn purchase(&self, id: &[u8; 32]) -> &PurchaseRec {
        self.purchases
            .get(id)
            .unwrap_or_else(|| env::panic_str("unknown purchase"))
    }

    fn grant_key(&self, id: &[u8; 32], rec: &PurchaseRec, grant: u32) -> [u8; 48] {
        if grant == 0 {
            return rec.buyer_key;
        }
        *self
            .grants
            .get(&grant_entry(id, grant))
            .unwrap_or_else(|| env::panic_str("unknown grant"))
    }
}

fn grant_entry(id: &[u8; 32], grant: u32) -> [u8; 36] {
    let mut k = [0u8; 36];
    k[..32].copy_from_slice(id);
    k[32..].copy_from_slice(&grant.to_le_bytes());
    k
}

fn key_marker(id: &[u8; 32], key: &[u8; 48]) -> [u8; 32] {
    let mut m = id.to_vec();
    m.extend_from_slice(key);
    env::sha256_array(&m)
}

#[near]
impl Annon {
    /// Releases the file key of a purchase, encrypted to the key of `grant` (0: the key from the
    /// purchase). Anyone may call it, any number of times: only the grant's secret opens the answer.
    /// Refused while the file is taken down. Returns MPC's CKD answer.
    pub fn claim_key(&mut self, purchase_id: String, grant: Option<u32>) {
        let id = bytes::<32>(&purchase_id, "purchase_id");
        let grant = grant.unwrap_or(0);
        let rec = self.purchase(&id);
        let key = self.grant_key(&id, rec, grant);
        let (file_id, who) = (rec.file_id, rec.recovery.text());
        require!(self.file(&file_id).taken_down == 0, "file taken down");
        emit(
            "key_requested",
            json!({ "purchase_id": hex0x(&id), "grant": grant, "key": hex0x(&key) }),
        );
        self.ckd(&file_id, &key, "claim", who, Some((&id, grant)))
    }

    /// Adds a grant for a fresh one-time key, authorized by the purchase's recovery identity over
    /// `reopen_text` (EVM or Solana signature, or the NEAR account calling), and releases the key
    /// to it. The same key again gives the same grant. The caller pays the grant's storage.
    #[payable]
    pub fn reopen(&mut self, args: ReopenArgs, auth: Option<Auth>) {
        let id = bytes::<32>(&args.purchase_id, "purchase_id");
        let key = bytes::<48>(&args.fresh_key, "fresh_key");
        bytes::<32>(&args.nonce, "nonce");
        require!(now() <= args.deadline, "signature expired");
        let text = self.reopen_text(args);
        let rec = self.purchase(&id);
        require!(
            rec.recovery.authorized(&text, auth.as_ref()),
            "not authorized by the purchase's recovery identity"
        );
        let (file_id, who) = (rec.file_id, rec.recovery.text());
        require!(self.file(&file_id).taken_down == 0, "file taken down");
        require!(valid_bls_key(&key), "invalid one-time key");
        let marker = key_marker(&id, &key);
        let grant = match self.grant_of_key.get(&marker) {
            Some(g) => *g,
            None if key == rec.buyer_key => 0,
            None => {
                let before = env::storage_usage();
                let rec = self.purchases.get_mut(&id).unwrap();
                let g = rec.grants;
                rec.grants += 1;
                self.grants.insert(grant_entry(&id, g), key);
                self.grant_of_key.insert(marker, g);
                self.purchases.flush();
                self.grants.flush();
                self.grant_of_key.flush();
                self.pay_for_storage(env::storage_usage() - before);
                emit(
                    "grant_created",
                    json!({ "purchase_id": hex0x(&id), "grant": g, "key": hex0x(&key) }),
                );
                g
            }
        };
        self.ckd(&file_id, &key, "reopen", who, Some((&id, grant)))
    }

    /// The exact text the recovery identity authorizes to open a purchased file again.
    pub fn reopen_text(&self, args: ReopenArgs) -> String {
        let id = bytes::<32>(&args.purchase_id, "purchase_id");
        let rec = self.purchase(&id);
        format!(
            "Annon: open a purchased file again\n\
             contract: {}\n\
             purchase: {}\n\
             file: {}\n\
             recovery: {}\n\
             new key: {}\n\
             nonce: {}\n\
             valid until: {}",
            env::current_account_id(),
            hex0x(&id),
            hex0x(&rec.file_id),
            rec.recovery.text(),
            hex0x(&bytes::<48>(&args.fresh_key, "fresh_key")),
            hex0x(&bytes::<32>(&args.nonce, "nonce")),
            utc(args.deadline),
        )
    }

    /// Purchases whose recovery identity is `recovery`, oldest first.
    pub fn purchases_of(&self, recovery: IdentityJson, from: u32, limit: u32) -> Vec<String> {
        let identity =
            Identity::from_json(&recovery).unwrap_or_else(|| env::panic_str("invalid identity"));
        let k = recovery_key(&identity);
        let n = self.recovery_count.get(&k).copied().unwrap_or(0);
        (from..n.min(from.saturating_add(limit.min(100))))
            .map(|i| {
                let mut e = [0u8; 36];
                e[..32].copy_from_slice(&k);
                e[32..].copy_from_slice(&i.to_le_bytes());
                hex0x(self.recovery.get(&e).unwrap())
            })
            .collect()
    }

    pub fn get_purchase(&self, purchase_id: String) -> Option<PurchaseView> {
        self.purchases
            .get(&bytes::<32>(&purchase_id, "purchase_id"))
            .map(|r| PurchaseView {
                file_id: hex0x(&r.file_id),
                terms_hash: hex0x(&r.terms_hash),
                buyer_key: hex0x(&r.buyer_key),
                recovery: IdentityJson::from(&r.recovery),
                route: if r.route == 0 {
                    "near-usdc"
                } else {
                    "base-usdc"
                }
                .into(),
                delivery: (r.delivery != u64::MAX).then_some(r.delivery),
                accepted_at: r.accepted_at,
                grants: r.grants,
            })
    }

    /// The one-time key of a grant (0: the key from the purchase).
    pub fn get_grant(&self, purchase_id: String, grant: u32) -> Option<String> {
        let id = bytes::<32>(&purchase_id, "purchase_id");
        let rec = self.purchases.get(&id)?;
        if grant == 0 {
            return Some(hex0x(&rec.buyer_key));
        }
        self.grants.get(&grant_entry(&id, grant)).map(|k| hex0x(k))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::receive::tests::{deliver, selling};
    use crate::tests::*;
    use crate::TakedownReason;
    use near_sdk::NearToken;

    /// A NEAR purchase of the test file whose recovery identity is `recovery`.
    fn bought(recovery: IdentityJson) -> (Annon, String) {
        let mut c = selling();
        let p = purchase(0, recovery);
        deliver(&mut c, 10_000, &message(&p));
        as_caller(RELAYER, NearToken::from_millinear(10));
        (c, format!("0x{}", hex::encode(p.id())))
    }

    fn reopen_args(id: &str, key: &str) -> ReopenArgs {
        ReopenArgs {
            purchase_id: id.into(),
            fresh_key: key.into(),
            nonce: format!("0x{}", "77".repeat(32)),
            deadline: NOW_S + 600,
        }
    }

    fn released_to() -> (String, near_sdk::serde_json::Value) {
        let mpc = calls_to("v1.signer", "request_app_private_key")
            .pop()
            .unwrap();
        let confirm = calls_to(CONTRACT, "on_key_released").pop().unwrap();
        (
            mpc["request"]["app_public_key"]["AppPublicKey"]
                .as_str()
                .unwrap()
                .into(),
            confirm,
        )
    }

    fn bls(key: &str) -> String {
        format!(
            "bls12381g1:{}",
            bs58::encode(hex::decode(&key[2..]).unwrap()).into_string()
        )
    }

    #[test]
    fn anyone_claims_the_key_for_the_purchase_key() {
        let (mut c, id) = bought(Seller::new(7).id());
        as_caller("stranger.near", NearToken::from_yoctonear(0));
        c.claim_key(id.clone(), None);
        let (to, confirm) = released_to();
        assert_eq!(to, bls(G1));
        assert_eq!(
            (confirm["purchase"].as_str(), confirm["grant"].as_u64()),
            (Some(id.as_str()), Some(0))
        );
        assert_eq!(confirm["file_id"], FILE);
    }

    #[test]
    #[should_panic(expected = "unknown purchase")]
    fn an_unknown_purchase_has_no_key() {
        let (mut c, _) = bought(Seller::new(7).id());
        c.claim_key(format!("0x{}", "99".repeat(32)), None);
    }

    #[test]
    #[should_panic(expected = "file taken down")]
    fn no_key_while_the_file_is_taken_down() {
        let (mut c, id) = bought(Seller::new(7).id());
        as_caller(MODERATOR, NearToken::from_yoctonear(1));
        c.takedown(FILE.into(), TakedownReason::IllegalContent);
        c.claim_key(id, None);
    }

    #[test]
    fn an_evm_recovery_wallet_adds_a_grant_for_a_fresh_key() {
        let buyer = Seller::new(7);
        let (mut c, id) = bought(buyer.id());
        let r = reopen_args(&id, G1X2);
        let auth = buyer.auth(&c.reopen_text(r.clone()));
        c.reopen(r.clone(), auth.clone());
        assert_eq!(released_to().0, bls(G1X2));
        assert_eq!(c.get_purchase(id.clone()).unwrap().grants, 2);
        assert_eq!(c.get_grant(id.clone(), 1), Some(G1X2.into()));
        assert_eq!(events("grant_created")[0]["grant"], 1);
        // The same request again: the same grant, no new one.
        as_caller(RELAYER, NearToken::from_millinear(10));
        c.reopen(r, auth);
        assert_eq!(c.get_purchase(id.clone()).unwrap().grants, 2);
        assert_eq!(released_to().1["grant"], 1);
        c.claim_key(id, Some(1));
        assert_eq!(released_to().0, bls(G1X2));
    }

    #[test]
    fn a_solana_recovery_wallet_reopens() {
        let sol = Sol::new(5);
        let (mut c, id) = bought(sol.id());
        let r = reopen_args(&id, G1X2);
        let auth = sol.auth(&c.reopen_text(r.clone()));
        c.reopen(r, auth);
        assert_eq!(c.get_grant(id, 1), Some(G1X2.into()));
    }

    #[test]
    fn a_near_recovery_account_reopens_by_calling() {
        let (mut c, id) = bought(near_id("buyer.near"));
        as_caller("buyer.near", NearToken::from_millinear(10));
        c.reopen(reopen_args(&id, G1X2), None);
        assert_eq!(c.get_grant(id, 1), Some(G1X2.into()));
    }

    #[test]
    #[should_panic(expected = "not authorized by the purchase's recovery identity")]
    fn another_wallet_can_not_reopen() {
        let (mut c, id) = bought(Seller::new(7).id());
        let r = reopen_args(&id, G1X2);
        let auth = Seller::new(8).auth(&c.reopen_text(r.clone()));
        c.reopen(r, auth);
    }

    #[test]
    #[should_panic(expected = "not authorized by the purchase's recovery identity")]
    fn a_reopen_signature_can_not_be_moved_to_another_key() {
        let buyer = Seller::new(7);
        let (mut c, id) = bought(buyer.id());
        let auth = buyer.auth(&c.reopen_text(reopen_args(&id, G1X2)));
        c.reopen(reopen_args(&id, G1), auth);
    }

    #[test]
    #[should_panic(expected = "invalid one-time key")]
    fn a_fresh_key_off_the_curve_is_refused() {
        let buyer = Seller::new(7);
        let (mut c, id) = bought(buyer.id());
        let r = reopen_args(&id, &format!("0x{}", "33".repeat(48)));
        let auth = buyer.auth(&c.reopen_text(r.clone()));
        c.reopen(r, auth);
    }

    #[test]
    #[should_panic(expected = "signature expired")]
    fn an_expired_reopen_is_refused() {
        let buyer = Seller::new(7);
        let (mut c, id) = bought(buyer.id());
        let mut r = reopen_args(&id, G1X2);
        r.deadline = NOW_S - 1;
        let auth = buyer.auth(&c.reopen_text(r.clone()));
        c.reopen(r, auth);
    }

    #[test]
    fn reopening_with_the_purchase_key_is_grant_zero_and_costs_nothing() {
        let buyer = Seller::new(7);
        let (mut c, id) = bought(buyer.id());
        as_caller(RELAYER, NearToken::from_yoctonear(0));
        let r = reopen_args(&id, G1);
        let auth = buyer.auth(&c.reopen_text(r.clone()));
        c.reopen(r, auth);
        assert_eq!(released_to().1["grant"], 0);
        assert_eq!(c.get_purchase(id).unwrap().grants, 1);
    }

    #[test]
    fn the_reopen_text_names_everything_it_authorizes() {
        let (c, id) = bought(Sol::new(5).id());
        let t = c.reopen_text(reopen_args(&id, G1X2));
        let sol = bs58::encode(hex::decode(Sol::new(5).id().id).unwrap()).into_string();
        assert_eq!(
            t,
            format!(
                "Annon: open a purchased file again\ncontract: {CONTRACT}\npurchase: {id}\nfile: {FILE}\n\
                 recovery: Solana {sol}\nnew key: {G1X2}\nnonce: 0x{}\nvalid until: 2026-10-26 07:43:20 UTC",
                "77".repeat(32)
            )
        );
    }

    #[test]
    fn purchases_are_found_by_their_recovery_identity() {
        let mut c = selling();
        let who = near_id("buyer.near");
        let mut ids = vec![];
        for n in 0..3u8 {
            let mut p = purchase(0, who.clone());
            p.nonce = [n; 32];
            deliver(&mut c, 10_000, &message(&p));
            ids.push(format!("0x{}", hex::encode(p.id())));
        }
        assert_eq!(c.purchases_of(who.clone(), 0, 10), ids);
        assert_eq!(c.purchases_of(who, 1, 1), ids[1..2]);
        assert!(c.purchases_of(Seller::new(7).id(), 0, 10).is_empty());
    }
}
