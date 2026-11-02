//! Listing a file and opening it again. Both take an EIP-191 signature from an EVM wallet over
//! a text the contract builds itself, so the wallet shows exactly what the contract checks.
use near_sdk::json_types::U128;
use near_sdk::{env, near, require, AccountId};

use crate::events::emit;
use crate::evm::{bytes, hex0x, recover_eip191};
use crate::storage::pay_for_storage;
use crate::unlock::buyer_entry;
use crate::{Annon, AnnonExt, File, Source};
use near_sdk::serde_json::json;

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

#[near]
impl Annon {
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

        let event = json!({
            "file_id": hex0x(&file_id),
            "seller": hex0x(&seller),
            "price": args.price,
            "source": args.source,
            "cipher_hash": hex0x(&cipher_hash),
            "moderator": args.moderator,
        });
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
        emit("register", event);
        // If MPC fails here the listing stays; the seller gets the key again through `reopen`.
        self.ckd(&file_id, &seller_key, "register", &seller)
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
        self.ckd(&file_id, &key, "reopen", &wallet)
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
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tests::*;
    use near_sdk::test_utils::get_created_receipts;
    use near_sdk::NearToken;

    #[test]
    fn registers_a_file_signed_by_its_seller() {
        let mut c = contract();
        let seller = Seller::new(1);
        let a = args(&seller);
        let sig = signed(&c, &seller, &a);
        c.register(a.clone(), sig);

        let f = c.get_file(a.file_id).unwrap();
        assert_eq!(f.seller, seller.address());
        assert_eq!(f.price, U128(10_000));
        assert_eq!(f.source, Source::Partner);
        assert_eq!(f.cipher_hash, a.cipher_hash);
        assert_eq!(f.moderator, a.moderator);
        assert!(!f.sales_stopped);
    }

    #[test]
    fn registers_a_direct_x402_file() {
        let mut c = contract();
        let seller = Seller::new(1);
        let mut a = args(&seller);
        a.source = Source::X402 {
            pay_to: Seller::new(9).address(),
        };
        a.moderator = None;
        let sig = signed(&c, &seller, &a);
        c.register(a.clone(), sig);
        assert_eq!(c.get_file(a.file_id).unwrap().source, a.source);
    }

    #[test]
    fn message_names_the_contract_and_every_field() {
        let c = contract();
        let seller = Seller::new(1);
        let m = c.register_message(args(&seller));
        for part in [
            CONTRACT,
            &seller.address(),
            "10000",
            "partner",
            "moderator.sputnik-dao.near",
        ] {
            assert!(m.contains(part), "message is missing {part}:\n{m}");
        }
    }

    #[test]
    #[should_panic(expected = "signature is not from the seller")]
    fn rejects_a_signature_from_someone_else() {
        let mut c = contract();
        let a = args(&Seller::new(1));
        let sig = signed(&c, &Seller::new(2), &a);
        c.register(a, sig);
    }

    #[test]
    #[should_panic(expected = "signature is not from the seller")]
    fn rejects_a_field_changed_after_signing() {
        let mut c = contract();
        let seller = Seller::new(1);
        let mut a = args(&seller);
        let sig = signed(&c, &seller, &a);
        a.price = U128(1);
        c.register(a, sig);
    }

    #[test]
    #[should_panic(expected = "signature is not from the seller")]
    fn rejects_a_signature_made_for_another_contract() {
        let mut c = contract();
        let seller = Seller::new(1);
        let a = args(&seller);
        let other = c
            .register_message(a.clone())
            .replace(CONTRACT, "v2.annon.defdone.near");
        c.register(a, seller.sign(&other));
    }

    #[test]
    #[should_panic(expected = "file already registered")]
    fn rejects_the_same_file_twice() {
        let mut c = contract();
        let seller = Seller::new(1);
        let a = args(&seller);
        let sig = signed(&c, &seller, &a);
        c.register(a.clone(), sig.clone());
        context(NearToken::from_millinear(100));
        c.register(a, sig);
    }

    #[test]
    #[should_panic(expected = "signature expired")]
    fn rejects_an_expired_signature() {
        let mut c = contract();
        let seller = Seller::new(1);
        let mut a = args(&seller);
        a.deadline = NOW_S - 1;
        let sig = signed(&c, &seller, &a);
        c.register(a, sig);
    }

    #[test]
    #[should_panic(expected = "price must be above zero")]
    fn rejects_a_free_file() {
        let mut c = contract();
        let seller = Seller::new(1);
        let mut a = args(&seller);
        a.price = U128(0);
        let sig = signed(&c, &seller, &a);
        c.register(a, sig);
    }

    #[test]
    #[should_panic(expected = "file_id must be 32 bytes")]
    fn rejects_a_short_file_id() {
        let mut c = contract();
        let seller = Seller::new(1);
        let mut a = args(&seller);
        a.file_id = "0x1234".into();
        c.register(a, "0x00".into());
    }

    #[test]
    #[should_panic(expected = "seller_key must be 48 bytes")]
    fn rejects_a_wrong_size_one_time_key() {
        let mut c = contract();
        let seller = Seller::new(1);
        let mut a = args(&seller);
        a.seller_key = format!("0x{}", "33".repeat(32));
        c.register(a, "0x00".into());
    }

    #[test]
    #[should_panic(expected = "attach at least")]
    fn rejects_a_call_that_does_not_pay_for_storage() {
        let mut c = contract();
        let seller = Seller::new(1);
        let a = args(&seller);
        let sig = signed(&c, &seller, &a);
        context(NearToken::from_yoctonear(0));
        c.register(a, sig);
    }

    #[test]
    #[should_panic(expected = "signature is not from the seller")]
    fn no_moderator_and_an_account_named_none_sign_differently() {
        let mut c = contract();
        let seller = Seller::new(1);
        let mut a = args(&seller);
        a.moderator = None;
        let sig = signed(&c, &seller, &a);
        a.moderator = Some("none".parse().unwrap());
        c.register(a, sig);
    }

    #[test]
    fn hex_spelling_does_not_change_the_message() {
        let c = contract();
        let seller = Seller::new(1);
        let a = args(&seller);
        let mut b = a.clone();
        b.file_id = b.file_id.trim_start_matches("0x").to_uppercase();
        b.seller = b.seller.to_uppercase().replace("0X", "0x");
        assert_eq!(c.register_message(a), c.register_message(b));
    }

    #[test]
    fn asks_mpc_for_the_file_key_encrypted_to_the_seller() {
        let mut c = contract();
        let seller = Seller::new(1);
        let a = args(&seller);
        let sig = signed(&c, &seller, &a);
        c.register(a, sig);

        let call = get_created_receipts()
            .into_iter()
            .filter(|r| r.receiver_id.as_str() == "v1.signer")
            .flat_map(|r| r.actions)
            .find_map(|action| match action {
                near_sdk::mock::MockAction::FunctionCallWeight {
                    method_name,
                    args,
                    attached_deposit,
                    ..
                } => Some((method_name, args, attached_deposit)),
                _ => None,
            })
            .expect("no call to v1.signer");
        assert_eq!(call.0, b"request_app_private_key");
        assert_eq!(call.2, NearToken::from_yoctonear(1));
        let json: near_sdk::serde_json::Value = near_sdk::serde_json::from_slice(&call.1).unwrap();
        let key = format!("bls12381g1:{}", bs58::encode([0x33u8; 48]).into_string());
        assert_eq!(
            json,
            near_sdk::serde_json::json!({ "request": {
                "derivation_path": format!("file/{}", "11".repeat(32)),
                "app_public_key": { "AppPublicKey": key },
                "domain_id": 2,
            }})
        );
    }

    #[test]
    fn seller_can_get_the_key_again_after_mpc_failed() {
        let mut c = contract();
        let seller = Seller::new(1);
        let a = registered(&mut c, &seller);
        let before = ckd_calls();
        let r = reopen_args(&a.file_id, &seller);
        let sig = seller.sign(&c.reopen_message(r.clone()));
        c.reopen(r, sig);
        assert_eq!(ckd_calls(), before + 1);
    }

    #[test]
    #[should_panic(expected = "only the seller or a buyer can reopen")]
    fn a_stranger_cannot_reopen() {
        let mut c = contract();
        let a = registered(&mut c, &Seller::new(1));
        let stranger = Seller::new(2);
        let r = reopen_args(&a.file_id, &stranger);
        let sig = stranger.sign(&c.reopen_message(r.clone()));
        c.reopen(r, sig);
    }

    #[test]
    #[should_panic(expected = "signature is not from the wallet")]
    fn reopen_needs_the_wallet_signature() {
        let mut c = contract();
        let seller = Seller::new(1);
        let a = registered(&mut c, &seller);
        let r = reopen_args(&a.file_id, &seller);
        let sig = Seller::new(2).sign(&c.reopen_message(r.clone()));
        c.reopen(r, sig);
    }

    #[test]
    #[should_panic(expected = "signature is not from the wallet")]
    fn a_reopen_signature_cannot_be_moved_to_another_key() {
        let mut c = contract();
        let seller = Seller::new(1);
        let a = registered(&mut c, &seller);
        let mut r = reopen_args(&a.file_id, &seller);
        let sig = seller.sign(&c.reopen_message(r.clone()));
        r.key = format!("0x{}", "55".repeat(48));
        c.reopen(r, sig);
    }

    #[test]
    #[should_panic(expected = "signature expired")]
    fn rejects_an_expired_reopen() {
        let mut c = contract();
        let seller = Seller::new(1);
        let a = registered(&mut c, &seller);
        let mut r = reopen_args(&a.file_id, &seller);
        r.deadline = NOW_S - 1;
        let sig = seller.sign(&c.reopen_message(r.clone()));
        c.reopen(r, sig);
    }

    #[test]
    #[should_panic(expected = "unknown file")]
    fn rejects_reopen_of_an_unknown_file() {
        let mut c = contract();
        let seller = Seller::new(1);
        let r = reopen_args(&format!("0x{}", "99".repeat(32)), &seller);
        let sig = seller.sign(&c.reopen_message(r.clone()));
        c.reopen(r, sig);
    }

    #[test]
    fn reopen_and_register_messages_never_match() {
        let c = contract();
        let seller = Seller::new(1);
        let m = c.reopen_message(reopen_args(&args(&seller).file_id, &seller));
        assert!(m.starts_with("Annon: open a file again\n"), "{m}");
        assert!(m.contains(CONTRACT));
    }

    #[test]
    fn register_emits_an_event_and_confirms_the_key_release() {
        let mut c = contract();
        let seller = Seller::new(1);
        let a = args(&seller);
        let sig = signed(&c, &seller, &a);
        let before = get_created_receipts().len();
        c.register(a.clone(), sig);
        let e = &events("register")[0];
        assert_eq!(e["file_id"], a.file_id);
        assert_eq!(e["seller"], seller.address());
        assert_eq!(e["price"], "10000");
        assert_eq!(e["source"]["kind"], "partner");
        assert_eq!(e["cipher_hash"], a.cipher_hash);
        assert_eq!(e["moderator"], "moderator.sputnik-dao.near");
        assert_eq!(self_calls(before), vec!["on_key_released"]);
    }

    #[test]
    fn reopen_confirms_the_key_release_too() {
        let mut c = contract();
        let seller = Seller::new(1);
        let a = registered(&mut c, &seller);
        let r = reopen_args(&a.file_id, &seller);
        let sig = seller.sign(&c.reopen_message(r.clone()));
        let before = get_created_receipts().len();
        c.reopen(r, sig);
        assert_eq!(self_calls(before), vec!["on_key_released"]);
    }

    #[test]
    fn a_released_key_is_a_receipt_event() {
        let mut c = contract();
        ckd_answered(near_sdk::PromiseResult::Successful(
            CKD_ANSWER.as_bytes().to_vec(),
        ));
        c.on_key_released(
            format!("0x{}", "11".repeat(32)),
            format!("0x{}", "44".repeat(48)),
            "reopen".into(),
            PAYER.into(),
        );
        let e = &events("key_released")[0];
        assert_eq!(e["file_id"], format!("0x{}", "11".repeat(32)));
        assert_eq!(e["key"], format!("0x{}", "44".repeat(48)));
        assert_eq!(e["reason"], "reopen");
        assert_eq!(e["wallet"], PAYER);
    }

    #[test]
    fn a_failed_key_release_is_no_receipt() {
        let mut c = contract();
        ckd_answered(near_sdk::PromiseResult::Failed);
        c.on_key_released(
            format!("0x{}", "11".repeat(32)),
            format!("0x{}", "44".repeat(48)),
            "unlock".into(),
            PAYER.into(),
        );
        assert!(events("key_released").is_empty());
        assert!(near_sdk::test_utils::get_logs()
            .iter()
            .any(|l| l.contains("call reopen")));
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
