//! Listing a file and giving its seller the key again (specs/near-settlement.md §3, §9). The seller
//! authorizes a text the contract builds itself, so the wallet shows exactly what the contract
//! checks: EVM wallets sign it (EIP-191), Solana wallets sign it (Ed25519 over UTF-8), and a NEAR
//! seller calls the contract from its own account.
use near_sdk::json_types::U128;
use near_sdk::serde_json::json;
use near_sdk::{env, near, require, AccountId};

use crate::events::emit;
use crate::evm::{bytes, hex0x};
use crate::identity::{Auth, Identity, IdentityJson};
use crate::purchase::valid_bls_key;
use crate::state::File;
use crate::terms::{self, BaseTerms, NearTerms, Terms};
use crate::text::utc;
use crate::{Annon, AnnonExt};

#[near(serializers = [json])]
#[derive(Clone)]
#[serde(deny_unknown_fields)]
pub struct RecipientJson {
    pub identity: IdentityJson,
    pub bps: u16,
}

#[near(serializers = [json])]
#[derive(Clone)]
#[serde(deny_unknown_fields)]
pub struct NearTermsJson {
    pub token: AccountId,
    pub price: U128,
    pub recipients: Vec<RecipientJson>,
    pub remainder: u8,
}

#[near(serializers = [json])]
#[derive(Clone)]
#[serde(deny_unknown_fields)]
pub struct BaseTermsJson {
    pub usdc: String,
    pub price: U128,
    pub pay_to: String,
}

#[near(serializers = [json])]
#[derive(Clone)]
#[serde(deny_unknown_fields)]
pub struct TermsJson {
    pub network: String,
    pub contract: AccountId,
    pub file_id: String,
    pub seller: IdentityJson,
    pub pay2_version: u8,
    pub cipher_hash: String,
    pub moderator: Option<AccountId>,
    pub near: NearTermsJson,
    pub base: Option<BaseTermsJson>,
}

fn identity(j: &IdentityJson) -> Identity {
    Identity::from_json(j).unwrap_or_else(|| env::panic_str("invalid identity"))
}

impl TermsJson {
    pub fn encode(t: &Terms) -> Self {
        let id = |i: &Identity| IdentityJson::from(i);
        TermsJson {
            network: t.network.clone(),
            contract: t.contract.clone(),
            file_id: hex0x(&t.file_id),
            seller: id(&t.seller),
            pay2_version: t.pay2_version,
            cipher_hash: hex0x(&t.cipher_hash),
            moderator: t.moderator.clone(),
            near: NearTermsJson {
                token: t.near.token.clone(),
                price: U128(t.near.price),
                recipients: t
                    .near
                    .recipients
                    .iter()
                    .map(|(i, bps)| RecipientJson {
                        identity: id(i),
                        bps: *bps,
                    })
                    .collect(),
                remainder: t.near.remainder,
            },
            base: t.base.as_ref().map(|b| BaseTermsJson {
                usdc: hex0x(&b.usdc),
                price: U128(b.price),
                pay_to: hex0x(&b.pay_to),
            }),
        }
    }

    pub fn decode(&self) -> Terms {
        Terms {
            network: self.network.clone(),
            contract: self.contract.clone(),
            file_id: bytes::<32>(&self.file_id, "file_id"),
            seller: identity(&self.seller),
            pay2_version: self.pay2_version,
            cipher_hash: bytes::<32>(&self.cipher_hash, "cipher_hash"),
            moderator: self.moderator.clone(),
            near: NearTerms {
                token: self.near.token.clone(),
                price: self.near.price.0,
                recipients: self
                    .near
                    .recipients
                    .iter()
                    .map(|r| (identity(&r.identity), r.bps))
                    .collect(),
                remainder: self.near.remainder,
            },
            base: self.base.as_ref().map(|b| BaseTerms {
                usdc: bytes::<20>(&b.usdc, "usdc"),
                price: b.price.0,
                pay_to: bytes::<20>(&b.pay_to, "pay_to"),
            }),
        }
    }
}

#[near(serializers = [json])]
#[derive(Clone)]
#[serde(deny_unknown_fields)]
pub struct RegisterArgs {
    pub terms: TermsJson,
    /// The seller's one-time BLS12-381 G1 key (48 bytes compressed, hex) for the file key.
    pub seller_key: String,
    pub deadline: u64,
}

#[near(serializers = [json])]
#[derive(Clone)]
#[serde(deny_unknown_fields)]
pub struct SellerArgs {
    pub file_id: String,
    /// For reopen: a fresh one-time key. Absent for stop.
    pub key: Option<String>,
    pub deadline: u64,
}

pub(crate) fn now() -> u64 {
    env::block_timestamp() / 1_000_000_000
}

impl Annon {
    pub(crate) fn file(&self, file_id: &[u8; 32]) -> &File {
        self.files
            .get(file_id)
            .unwrap_or_else(|| env::panic_str("unknown file"))
    }

    fn seller_authorized(&self, file: &File, text: &str, auth: Option<&Auth>) {
        require!(
            file.terms.seller.authorized(text, auth),
            "not authorized by the seller"
        );
    }
}

#[near]
impl Annon {
    /// Lists a file and returns MPC's CKD answer (`big_y`, `big_c`): the file key encrypted to
    /// `seller_key`. The seller authorizes `register_text`: EVM and Solana sellers by signature
    /// (anyone may submit it), a NEAR seller by calling. The caller pays for storage with an
    /// attached deposit (the rest is refunded) or, attaching nothing, from its prepaid balance.
    /// If MPC fails the listing stays; the seller gets the key through `reopen_seller`.
    #[payable]
    pub fn register(&mut self, args: RegisterArgs, auth: Option<Auth>) {
        let terms = args.terms.decode();
        let seller_key = bytes::<48>(&args.seller_key, "seller_key");
        // A key MPC can't use fails the release; the point at infinity would publish the file key.
        require!(valid_bls_key(&seller_key), "invalid one-time key");
        if let Some(why) = terms.problem(&self.network, &self.near_usdc) {
            env::panic_str(why);
        }
        require!(
            terms.base.as_ref().is_none_or(|b| b.usdc == self.usdc),
            "the Base price must be in the configured USDC"
        );
        require!(now() <= args.deadline, "signature expired");
        require!(
            terms.seller.authorized(
                &terms.register_text(&seller_key, args.deadline),
                auth.as_ref()
            ),
            "not authorized by the seller"
        );
        let file_id = terms.file_id;
        require!(
            !self.files.contains_key(&file_id),
            "file already registered"
        );
        let event = json!({
            "file_id": hex0x(&file_id),
            "terms_hash": hex0x(&terms.hash()),
            "seller": terms.seller.text(),
        });
        let seller = terms.seller.text();
        let before = env::storage_usage();
        self.files.insert(
            file_id,
            File {
                terms,
                header_hash: [0; 32],
                sales_stopped_at: 0,
                taken_down: 0,
            },
        );
        self.files.flush();
        self.pay_for_storage(env::storage_usage() - before);
        emit("file_registered", event);
        self.ckd(&file_id, &seller_key, "register", seller, None)
    }

    /// The exact text the seller authorizes (§3.2). The SDK shows it to the wallet.
    pub fn register_text(&self, args: RegisterArgs) -> String {
        args.terms
            .decode()
            .register_text(&bytes::<48>(&args.seller_key, "seller_key"), args.deadline)
    }

    /// The text an EVM or Solana seller signs into a PAY2 header (§3.3).
    pub fn publish_text(&self, file_id: String, header_hash: String) -> String {
        terms::publish_text(
            &env::current_account_id(),
            &bytes::<32>(&file_id, "file_id"),
            &bytes::<32>(&header_hash, "header_hash"),
        )
    }

    /// A NEAR seller publishes the hash of the finished PAY2 header, once. Nothing is sold on
    /// the NEAR route before it.
    pub fn publish_header(&mut self, file_id: String, header_hash: String) {
        let file_id = bytes::<32>(&file_id, "file_id");
        let hash = bytes::<32>(&header_hash, "header_hash");
        require!(hash != [0; 32], "header hash can't be zero");
        let file = self
            .files
            .get_mut(&file_id)
            .unwrap_or_else(|| env::panic_str("unknown file"));
        require!(
            matches!(&file.terms.seller, Identity::Near(a) if a == &env::predecessor_account_id()),
            "only a NEAR seller publishes its header, from its own account"
        );
        if file.header_hash == hash {
            return;
        }
        require!(file.header_hash == [0; 32], "header already published");
        file.header_hash = hash;
        emit(
            "header_published",
            json!({ "file_id": hex0x(&file_id), "header_hash": hex0x(&hash) }),
        );
    }

    /// The seller gets the file key again, for a fresh one-time key; once per key.
    #[payable]
    pub fn reopen_seller(&mut self, args: SellerArgs, auth: Option<Auth>) {
        let file_id = bytes::<32>(&args.file_id, "file_id");
        let key = bytes::<48>(
            args.key
                .as_deref()
                .unwrap_or_else(|| env::panic_str("key is required")),
            "key",
        );
        require!(now() <= args.deadline, "signature expired");
        require!(valid_bls_key(&key), "invalid one-time key");
        let text = self.reopen_seller_text(args);
        let file = self.file(&file_id);
        self.seller_authorized(file, &text, auth.as_ref());
        require!(file.taken_down == 0, "file taken down");
        let seller = file.terms.seller.text();
        let mut m = b"annon/reopen-seller/v2\0".to_vec();
        m.extend_from_slice(&file_id);
        m.extend_from_slice(&key);
        let marker = env::sha256_array(&m);
        require!(
            !self.reopened.contains_key(&marker),
            "this one-time key was already used; reopen with a new one"
        );
        let before = env::storage_usage();
        self.reopened.insert(marker, ());
        self.reopened.flush();
        self.pay_for_storage(env::storage_usage() - before);
        self.ckd(&file_id, &key, "reopen", seller, None)
    }

    pub fn reopen_seller_text(&self, args: SellerArgs) -> String {
        let file_id = bytes::<32>(&args.file_id, "file_id");
        reopen_seller_text_for(
            &env::current_account_id(),
            &file_id,
            &self.file(&file_id).terms.seller,
            &bytes::<48>(args.key.as_deref().unwrap_or(""), "key"),
            args.deadline,
        )
    }
}

/// The text a seller authorizes to get the key of `file_id` again, for `key`.
pub(crate) fn reopen_seller_text_for(
    contract: &AccountId,
    file_id: &[u8; 32],
    seller: &Identity,
    key: &[u8; 48],
    deadline: u64,
) -> String {
    format!(
        "Annon: open a file again\n\
         Signing this lets whoever holds the one-time key below open the file.\n\
         contract: {contract}\n\
         file: {}\n\
         seller: {}\n\
         one-time key: {}\n\
         valid until: {}",
        hex0x(file_id),
        seller.text(),
        hex0x(key),
        utc(deadline),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tests::*;
    use near_sdk::test_utils::get_created_receipts;
    use near_sdk::NearToken;

    /// Seller reopen arguments for a real one-time key: "44" is 2·G, "55" is G.
    fn seller_args(key: &str) -> SellerArgs {
        SellerArgs {
            file_id: FILE.into(),
            key: Some(if key == "44" { G1X2 } else { G1 }.into()),
            deadline: NOW_S + 600,
        }
    }

    fn reopen_as(c: &mut Annon, seller: &Seller, key: &str) {
        let r = seller_args(key);
        let auth = seller.auth(&c.reopen_seller_text(r.clone()));
        c.reopen_seller(r, auth);
    }

    #[test]
    fn registers_a_file_signed_by_its_evm_seller() {
        let mut c = contract();
        let seller = Seller::new(1);
        let a = registered(&mut c, &seller);
        let f = c.get_file(FILE.into()).unwrap();
        assert_eq!(f.terms.seller.id, seller.address());
        assert_eq!(f.terms.near.price, U128(10_000));
        assert_eq!(f.terms.base.as_ref().unwrap().pay_to, PAY_TO);
        assert_eq!(f.terms.cipher_hash, a.terms.cipher_hash);
        assert_eq!(f.terms.moderator, a.terms.moderator);
        assert_eq!(f.terms_hash, hex0x(&terms_hash()));
        assert_eq!(
            (f.header_hash, f.sales_stopped_at, f.taken_down),
            (None, None, None)
        );
    }

    #[test]
    fn registers_a_file_signed_by_a_solana_seller() {
        let mut c = contract();
        let sol = Sol::new(4);
        let a = args_for(sol.id());
        let auth = sol.auth(&c.register_text(a.clone()));
        c.register(a, auth);
        assert_eq!(c.get_file(FILE.into()).unwrap().terms.seller.kind, "solana");
    }

    #[test]
    #[should_panic(expected = "not authorized by the seller")]
    fn a_solana_signature_over_other_bytes_is_refused() {
        let mut c = contract();
        let sol = Sol::new(4);
        let a = args_for(sol.id());
        let auth = sol.auth(&(c.register_text(a.clone()) + " "));
        c.register(a, auth);
    }

    #[test]
    fn a_near_seller_registers_by_calling() {
        let mut c = contract();
        let a = args_for(near_id("seller.near"));
        as_caller("seller.near", NearToken::from_millinear(100));
        c.register(a, None);
        assert_eq!(
            c.get_file(FILE.into()).unwrap().terms.seller.id,
            "seller.near"
        );
    }

    #[test]
    #[should_panic(expected = "not authorized by the seller")]
    fn nobody_else_registers_for_a_near_seller() {
        let mut c = contract();
        c.register(args_for(near_id("seller.near")), None);
    }

    #[test]
    #[should_panic(expected = "not authorized by the seller")]
    fn a_signature_of_the_wrong_kind_is_refused() {
        let mut c = contract();
        let seller = Seller::new(1);
        let a = args(&seller);
        let mut auth = signed(&c, &seller, &a).unwrap();
        auth.kind = "solana".into();
        c.register(a, Some(auth));
    }

    #[test]
    fn the_text_names_the_contract_and_the_key_fields() {
        let c = contract();
        let seller = Seller::new(1);
        let m = c.register_text(args(&seller));
        for part in [
            CONTRACT,
            &seller.address(),
            "0.01",
            PAY_TO,
            PLATFORM,
            MODERATOR,
            "\nvalid until: 2026-10-26 07:43:20 UTC",
        ] {
            assert!(m.contains(part), "text is missing {part}:\n{m}");
        }
    }

    #[test]
    fn register_takes_storage_from_a_prepaid_balance_when_nothing_is_attached() {
        let mut c = contract();
        as_caller(RELAYER, NearToken::from_millinear(100));
        c.storage_deposit(None);
        let before = balance(&c, RELAYER);
        as_caller(RELAYER, NearToken::from_yoctonear(0)); // a function-call key attaches nothing
        let receipts = get_created_receipts().len();
        registered(&mut c, &Seller::new(1));
        let used = before - balance(&c, RELAYER);
        assert!(
            used > 0 && used < NearToken::from_millinear(10).as_yoctonear(),
            "used {used}"
        );
        assert_eq!(refunded(receipts), 0, "nothing to refund from a balance");
    }

    #[test]
    fn an_attached_deposit_pays_before_the_balance() {
        let mut c = contract();
        as_caller(RELAYER, NearToken::from_millinear(100));
        c.storage_deposit(None);
        let before = balance(&c, RELAYER);
        as_caller(RELAYER, NearToken::from_millinear(20));
        registered(&mut c, &Seller::new(1));
        assert_eq!(balance(&c, RELAYER), before);
    }

    #[test]
    #[should_panic(expected = "not authorized by the seller")]
    fn rejects_a_signature_from_someone_else() {
        let mut c = contract();
        let a = args(&Seller::new(1));
        let auth = signed(&c, &Seller::new(2), &a);
        c.register(a, auth);
    }

    #[test]
    #[should_panic(expected = "not authorized by the seller")]
    fn rejects_a_field_changed_after_signing() {
        let mut c = contract();
        let seller = Seller::new(1);
        let mut a = args(&seller);
        let auth = signed(&c, &seller, &a);
        a.terms.near.price = U128(1);
        c.register(a, auth);
    }

    #[test]
    #[should_panic(expected = "not authorized by the seller")]
    fn rejects_a_changed_split_after_signing() {
        let mut c = contract();
        let seller = Seller::new(1);
        let mut a = args(&seller);
        let auth = signed(&c, &seller, &a);
        a.terms.near.recipients[1].identity = near_id("thief.near");
        c.register(a, auth);
    }

    #[test]
    #[should_panic(expected = "not authorized by the seller")]
    fn rejects_a_signature_made_for_another_contract() {
        let mut c = contract();
        let seller = Seller::new(1);
        let a = args(&seller);
        let other = c
            .register_text(a.clone())
            .replace(CONTRACT, "v2.annon.defdone.near");
        c.register(a, seller.auth(&other));
    }

    #[test]
    #[should_panic(expected = "file already registered")]
    fn rejects_the_same_file_twice() {
        let mut c = contract();
        let seller = Seller::new(1);
        let a = args(&seller);
        let auth = signed(&c, &seller, &a);
        c.register(a.clone(), auth.clone());
        context(NearToken::from_millinear(100));
        c.register(a, auth);
    }

    #[test]
    #[should_panic(expected = "signature expired")]
    fn rejects_an_expired_signature() {
        let mut c = contract();
        let seller = Seller::new(1);
        let mut a = args(&seller);
        a.deadline = NOW_S - 1;
        let auth = signed(&c, &seller, &a);
        c.register(a, auth);
    }

    /// Each `Terms::problem` (unit-tested in terms.rs) stops `register`, signature or not.
    fn refused(change: impl FnOnce(&mut RegisterArgs)) {
        let mut c = contract();
        let seller = Seller::new(1);
        let mut a = args(&seller);
        change(&mut a);
        let auth = signed(&c, &seller, &a);
        c.register(a, auth);
    }

    #[test]
    #[should_panic(expected = "price must be above 0")]
    fn rejects_a_free_file() {
        refused(|a| a.terms.near.price = U128(0));
    }

    #[test]
    #[should_panic(expected = "terms are for another network or contract")]
    fn rejects_terms_for_another_network() {
        refused(|a| a.terms.network = "near:testnet".into());
    }

    #[test]
    #[should_panic(expected = "terms are for another network or contract")]
    fn rejects_terms_for_another_contract() {
        refused(|a| a.terms.contract = "other.near".parse().unwrap());
    }

    #[test]
    #[should_panic(expected = "the NEAR price must be in the configured USDC")]
    fn rejects_another_token() {
        refused(|a| a.terms.near.token = "usdt.tether-token.near".parse().unwrap());
    }

    #[test]
    #[should_panic(expected = "files use PAY2 version 2")]
    fn rejects_an_old_pay2_version() {
        refused(|a| a.terms.pay2_version = 1);
    }

    #[test]
    #[should_panic(expected = "split recipients must be distinct and sorted")]
    fn rejects_an_unsorted_split() {
        refused(|a| a.terms.near.recipients.reverse());
    }

    #[test]
    #[should_panic(expected = "split shares must be above 0 and sum to 10000 bps")]
    fn rejects_shares_that_do_not_add_up() {
        refused(|a| a.terms.near.recipients[1].bps = 400);
    }

    #[test]
    #[should_panic(expected = "the Base price must be in the configured USDC")]
    fn rejects_a_base_price_in_another_token() {
        refused(|a| a.terms.base.as_mut().unwrap().usdc = PAY_TO.into());
    }

    #[test]
    #[should_panic(expected = "file_id must be 32 bytes")]
    fn rejects_a_short_file_id() {
        let mut c = contract();
        let mut a = args(&Seller::new(1));
        a.terms.file_id = "0x1234".into();
        c.register(a, None);
    }

    #[test]
    #[should_panic(expected = "seller_key must be 48 bytes")]
    fn rejects_a_wrong_size_one_time_key() {
        let mut c = contract();
        let mut a = args(&Seller::new(1));
        a.seller_key = format!("0x{}", "33".repeat(32));
        c.register(a, None);
    }

    #[test]
    #[should_panic(expected = "for storage, or call storage_deposit first")]
    fn rejects_a_call_that_does_not_pay_for_storage() {
        let mut c = contract();
        let seller = Seller::new(1);
        let a = args(&seller);
        let auth = signed(&c, &seller, &a);
        context(NearToken::from_yoctonear(0));
        c.register(a, auth);
    }

    #[test]
    #[should_panic(expected = "not authorized by the seller")]
    fn no_moderator_and_an_account_named_none_sign_differently() {
        let mut c = contract();
        let seller = Seller::new(1);
        let mut a = args(&seller);
        a.terms.moderator = None;
        let auth = signed(&c, &seller, &a);
        a.terms.moderator = Some("none".parse().unwrap());
        c.register(a, auth);
    }

    #[test]
    fn asks_mpc_for_the_file_key_encrypted_to_the_seller() {
        let mut c = contract();
        let before = get_created_receipts().len();
        registered(&mut c, &Seller::new(1));
        let call = calls_to("v1.signer", "request_app_private_key")
            .pop()
            .unwrap();
        let key = format!(
            "bls12381g1:{}",
            bs58::encode(hex::decode(&G1[2..]).unwrap()).into_string()
        );
        assert_eq!(
            call,
            near_sdk::serde_json::json!({ "request": {
                "derivation_path": format!("file/{}", "11".repeat(32)),
                "app_public_key": { "AppPublicKey": key },
                "domain_id": 2,
            }})
        );
        assert_eq!(self_calls(before), vec!["on_key_released"]);
        let e = &events("file_registered")[0];
        assert_eq!(e["file_id"], FILE);
        assert_eq!(e["terms_hash"], hex0x(&terms_hash()));
    }

    #[test]
    fn the_seller_can_ask_for_the_key_again() {
        let mut c = contract();
        let seller = Seller::new(1);
        registered(&mut c, &seller);
        let before = ckd_calls();
        reopen_as(&mut c, &seller, "44");
        reopen_as(&mut c, &seller, "55");
        assert_eq!(ckd_calls(), before + 2);
    }

    #[test]
    #[should_panic(expected = "this one-time key was already used")]
    fn the_same_seller_reopen_runs_once() {
        let mut c = contract();
        let seller = Seller::new(1);
        registered(&mut c, &seller);
        reopen_as(&mut c, &seller, "44");
        reopen_as(&mut c, &seller, "44");
    }

    #[test]
    #[should_panic(expected = "not authorized by the seller")]
    fn a_stranger_cannot_reopen_as_seller() {
        let mut c = contract();
        registered(&mut c, &Seller::new(1));
        reopen_as(&mut c, &Seller::new(2), "44");
    }

    #[test]
    #[should_panic(expected = "not authorized by the seller")]
    fn a_seller_reopen_cannot_be_moved_to_another_key() {
        let mut c = contract();
        let seller = Seller::new(1);
        registered(&mut c, &seller);
        let r = seller_args("44");
        let auth = seller.auth(&c.reopen_seller_text(r.clone()));
        c.reopen_seller(seller_args("55"), auth);
    }

    #[test]
    #[should_panic(expected = "unknown file")]
    fn rejects_reopen_of_an_unknown_file() {
        let mut c = contract();
        let r = SellerArgs {
            file_id: format!("0x{}", "99".repeat(32)),
            ..seller_args("44")
        };
        c.reopen_seller(r, None);
    }

    #[test]
    fn a_near_seller_publishes_its_header_once() {
        let mut c = contract();
        as_caller("seller.near", NearToken::from_millinear(100));
        c.register(args_for(near_id("seller.near")), None);
        let h = format!("0x{}", "ab".repeat(32));
        c.publish_header(FILE.into(), h.clone());
        c.publish_header(FILE.into(), h.clone()); // the same hash again is a no-op
        assert_eq!(c.get_file(FILE.into()).unwrap().header_hash, Some(h));
        assert_eq!(events("header_published").len(), 1);
        let other = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            c.publish_header(FILE.into(), format!("0x{}", "cd".repeat(32)))
        }));
        assert!(other.is_err(), "a second, different header was accepted");
    }

    #[test]
    #[should_panic(expected = "only a NEAR seller publishes its header")]
    fn an_evm_seller_has_no_header_to_publish() {
        let mut c = contract();
        registered(&mut c, &Seller::new(1));
        c.publish_header(FILE.into(), format!("0x{}", "ab".repeat(32)));
    }

    #[test]
    fn a_released_key_is_a_receipt_event() {
        let mut c = contract();
        ckd_answered(near_sdk::PromiseResult::Successful(
            CKD_ANSWER.as_bytes().to_vec(),
        ));
        c.on_key_released(
            FILE.into(),
            G1.into(),
            "claim".into(),
            "EVM 0x00".into(),
            Some("0x01".into()),
            Some(3),
        );
        let e = &events("key_released")[0];
        assert_eq!(
            (e["file_id"].as_str(), e["key"].as_str()),
            (Some(FILE), Some(G1))
        );
        assert_eq!(
            (e["reason"].as_str(), e["who"].as_str()),
            (Some("claim"), Some("EVM 0x00"))
        );
        assert_eq!(
            (e["purchase"].as_str(), e["grant"].as_u64()),
            (Some("0x01"), Some(3))
        );
    }

    #[test]
    fn a_failed_key_release_is_no_receipt() {
        let mut c = contract();
        ckd_answered(near_sdk::PromiseResult::Failed);
        c.on_key_released(
            FILE.into(),
            G1.into(),
            "unlock".into(),
            "x".into(),
            None,
            None,
        );
        assert!(events("key_released").is_empty());
        assert!(near_sdk::test_utils::get_logs()
            .iter()
            .any(|l| l.contains("ask again")));
    }

    #[test]
    fn the_mpc_answer_is_passed_back_unchanged() {
        assert_eq!(
            crate::mpc::release_output(Ok(CKD_ANSWER.as_bytes().to_vec())),
            CKD_ANSWER.as_bytes()
        );
        let failed = String::from_utf8(crate::mpc::release_output(Err(()))).unwrap();
        assert!(failed.contains("\"error\""), "{failed}");
    }
}
