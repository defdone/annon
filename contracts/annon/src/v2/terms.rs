//! A v2 registration's terms (specs/near-settlement.md §3): the NEAR price and split, the optional
//! Base route, and the text the seller authorizes.
use near_sdk::{env, near, AccountId};

use super::identity::Identity;
use crate::evm::hex0x;
use crate::text::{usdc, utc};

pub const MAX_RECIPIENTS: usize = 8;

#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct NearTerms {
    pub token: AccountId,
    pub price: u128,
    pub recipients: Vec<(Identity, u16)>,
    pub remainder: u8,
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct BaseTerms {
    pub usdc: [u8; 20],
    pub price: u128,
    pub pay_to: [u8; 20],
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct Terms {
    pub network: String,
    pub contract: AccountId,
    pub file_id: [u8; 32],
    pub seller: Identity,
    pub pay2_version: u8,
    pub cipher_hash: [u8; 32],
    pub moderator: Option<AccountId>,
    pub near: NearTerms,
    pub base: Option<BaseTerms>,
}

/// `SHA256(tag ‖ 0x00 ‖ Borsh(value))`.
pub fn tagged_hash<T: near_sdk::borsh::BorshSerialize>(tag: &str, value: &T) -> [u8; 32] {
    let mut b = tag.as_bytes().to_vec();
    b.push(0);
    b.extend(near_sdk::borsh::to_vec(value).unwrap());
    env::sha256_array(&b)
}

impl Terms {
    /// Why these terms can't be registered on this contract, or None.
    pub fn problem(&self, network: &str, usdc_token: &AccountId) -> Option<&'static str> {
        let r = &self.near.recipients;
        if self.network != network || self.contract != env::current_account_id() {
            return Some("terms are for another network or contract");
        }
        if &self.near.token != usdc_token {
            return Some("the NEAR price must be in the configured USDC");
        }
        if self.near.price == 0 || self.base.as_ref().is_some_and(|b| b.price == 0) {
            return Some("price must be above 0");
        }
        if self.pay2_version != 2 {
            return Some("v2 registrations are for PAY2 v2 files");
        }
        if r.is_empty() || r.len() > MAX_RECIPIENTS {
            return Some("the split has 1 to 8 recipients");
        }
        // Sorted by their Borsh bytes, strictly: also rules out duplicates.
        let keys: Vec<Vec<u8>> = r
            .iter()
            .map(|(i, _)| near_sdk::borsh::to_vec(i).unwrap())
            .collect();
        if keys.windows(2).any(|w| w[0] >= w[1]) {
            return Some("split recipients must be distinct and sorted");
        }
        if r.iter().any(|(_, bps)| *bps == 0)
            || r.iter().map(|(_, b)| u32::from(*b)).sum::<u32>() != 10_000
        {
            return Some("split shares must be above 0 and sum to 10000 bps");
        }
        if usize::from(self.near.remainder) >= r.len() {
            return Some("the remainder recipient must be one of the split");
        }
        None
    }

    pub fn hash(&self) -> [u8; 32] {
        tagged_hash("annon/terms/v2", self)
    }

    /// Each recipient's share of `price`: floor by bps, the rounding remainder to `remainder`.
    pub fn shares(&self) -> Vec<u128> {
        let p = self.near.price;
        let mut s: Vec<u128> = self
            .near
            .recipients
            .iter()
            .map(|(_, bps)| {
                (p / 10_000) * u128::from(*bps) + (p % 10_000) * u128::from(*bps) / 10_000
            })
            .collect();
        let rest = p - s.iter().sum::<u128>();
        s[usize::from(self.near.remainder)] += rest;
        s
    }

    /// The text the seller authorizes (§3.2).
    pub fn register_text(&self, seller_key: &[u8; 48], deadline: u64) -> String {
        let split: String = self
            .near
            .recipients
            .iter()
            .map(|(i, bps)| format!("split: {} {}.{:02}%\n", i.text(), bps / 100, bps % 100))
            .collect();
        let base = match &self.base {
            Some(b) => format!(
                "base: {} USDC on Base to {}",
                usdc(b.price),
                hex0x(&b.pay_to)
            ),
            None => "base: none".to_string(),
        };
        let moderator = self.moderator.as_ref().map_or("(none)", |m| m.as_str());
        format!(
            "Annon: list a file for sale\n\
             Signing this lets whoever holds the seller key below open the file.\n\
             contract: {}\n\
             file: {}\n\
             seller: {}\n\
             price: {} USDC on NEAR\n\
             {split}\
             remainder: {}\n\
             {base}\n\
             cipher: {}\n\
             moderator: {moderator}\n\
             terms: {}\n\
             seller key: {}\n\
             valid until: {}",
            self.contract,
            hex0x(&self.file_id),
            self.seller.text(),
            usdc(self.near.price),
            self.near.recipients[usize::from(self.near.remainder)]
                .0
                .text(),
            hex0x(&self.cipher_hash),
            hex0x(&self.hash()),
            hex0x(seller_key),
            utc(deadline),
        )
    }
}

/// The text an EVM or Solana seller signs to publish a PAY2 v2 header (§3.3).
pub fn publish_text(contract: &AccountId, file_id: &[u8; 32], header_hash: &[u8; 32]) -> String {
    format!(
        "Annon: publish a file\ncontract: {contract}\nfile: {}\nheader: {}",
        hex0x(file_id),
        hex0x(header_hash)
    )
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::testing_env;

    pub const USDC: &str = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";

    pub fn ctx() {
        testing_env!(VMContextBuilder::new()
            .current_account_id("annon.near".parse().unwrap())
            .build());
    }

    pub fn terms(recipients: Vec<(Identity, u16)>, price: u128) -> Terms {
        Terms {
            network: "near:mainnet".into(),
            contract: "annon.near".parse().unwrap(),
            file_id: [1; 32],
            seller: Identity::Evm([2; 20]),
            pay2_version: 2,
            cipher_hash: [3; 32],
            moderator: None,
            near: NearTerms {
                token: USDC.parse().unwrap(),
                price,
                recipients,
                remainder: 0,
            },
            base: None,
        }
    }

    fn three() -> Vec<(Identity, u16)> {
        vec![
            (Identity::Evm([0xaa; 20]), 9_000),
            (Identity::Solana([0xbb; 32]), 700),
            (Identity::Near("platform.near".parse().unwrap()), 300),
        ]
    }

    #[test]
    fn accepts_a_valid_split_and_refuses_each_broken_rule() {
        ctx();
        let usdc: AccountId = USDC.parse().unwrap();
        let ok = terms(three(), 200_000);
        assert_eq!(ok.problem("near:mainnet", &usdc), None);
        let mut t = ok.clone();
        t.near.recipients.swap(0, 1);
        assert!(t.problem("near:mainnet", &usdc).is_some(), "unsorted");
        let mut t = ok.clone();
        t.near.recipients[1] = t.near.recipients[0].clone();
        assert!(t.problem("near:mainnet", &usdc).is_some(), "duplicate");
        let mut t = ok.clone();
        t.near.recipients[2].1 = 299;
        assert!(t.problem("near:mainnet", &usdc).is_some(), "sum 9999");
        let mut t = ok.clone();
        t.near.recipients[2].1 = 0;
        t.near.recipients[0].1 = 9_300;
        assert!(t.problem("near:mainnet", &usdc).is_some(), "a zero share");
        let mut t = ok.clone();
        t.near.remainder = 3;
        assert!(
            t.problem("near:mainnet", &usdc).is_some(),
            "remainder out of range"
        );
        let mut t = ok.clone();
        t.near.price = 0;
        assert!(t.problem("near:mainnet", &usdc).is_some());
        let mut t = ok.clone();
        t.near.token = "fake.near".parse().unwrap();
        assert!(t.problem("near:mainnet", &usdc).is_some());
        assert!(ok.problem("near:testnet", &usdc).is_some());
        let mut t = ok.clone();
        t.contract = "other.near".parse().unwrap();
        assert!(t.problem("near:mainnet", &usdc).is_some());
        let mut t = ok.clone();
        t.pay2_version = 1;
        assert!(t.problem("near:mainnet", &usdc).is_some());
        let nine: Vec<_> = (0..9u8)
            .map(|i| (Identity::Evm([i; 20]), if i == 0 { 2_000 } else { 1_000 }))
            .collect();
        assert!(
            terms(nine, 1).problem("near:mainnet", &usdc).is_some(),
            "9 recipients"
        );
    }

    #[test]
    fn shares_always_add_up_to_the_price() {
        ctx();
        for price in [1u128, 3, 9_999, 10_000, 200_000, 1_000_001, u128::MAX] {
            let t = terms(three(), price);
            let s = t.shares();
            assert_eq!(s.iter().sum::<u128>(), price, "{price}");
            // No share above its exact proportion except the remainder's.
            for (i, (_, bps)) in t.near.recipients.iter().enumerate().skip(1) {
                assert!(
                    s[i] <= price / 10_000 * u128::from(*bps)
                        + price % 10_000 * u128::from(*bps) / 10_000
                );
            }
        }
        assert_eq!(
            terms(three(), 200_000).shares(),
            vec![180_000, 14_000, 6_000]
        );
    }

    #[test]
    fn the_hash_covers_every_field() {
        ctx();
        let t = terms(three(), 200_000);
        let h = t.hash();
        let mut variants = vec![];
        let mut x = t.clone();
        x.near.price += 1;
        variants.push(x);
        let mut x = t.clone();
        x.near.recipients[0].1 -= 1;
        x.near.recipients[1].1 += 1;
        variants.push(x);
        let mut x = t.clone();
        x.near.remainder = 1;
        variants.push(x);
        let mut x = t.clone();
        x.seller = Identity::Evm([9; 20]);
        variants.push(x);
        let mut x = t.clone();
        x.moderator = Some("mod.near".parse().unwrap());
        variants.push(x);
        let mut x = t.clone();
        x.base = Some(BaseTerms {
            usdc: [4; 20],
            price: 1,
            pay_to: [5; 20],
        });
        variants.push(x);
        let mut x = t.clone();
        x.cipher_hash[0] ^= 1;
        variants.push(x);
        for v in variants {
            assert_ne!(v.hash(), h);
        }
    }

    #[test]
    fn the_register_text_names_every_term() {
        ctx();
        let mut t = terms(three(), 200_000);
        t.base = Some(BaseTerms {
            usdc: [4; 20],
            price: 210_000,
            pay_to: [5; 20],
        });
        let text = t.register_text(&[6; 48], 1_793_800_706);
        let expected = format!(
            "Annon: list a file for sale\n\
             Signing this lets whoever holds the seller key below open the file.\n\
             contract: annon.near\n\
             file: 0x{}\n\
             seller: EVM 0x{}\n\
             price: 0.2 USDC on NEAR\n\
             split: EVM 0x{} 90.00%\n\
             split: Solana {} 7.00%\n\
             split: NEAR platform.near 3.00%\n\
             remainder: EVM 0x{}\n\
             base: 0.21 USDC on Base to 0x{}\n\
             cipher: 0x{}\n\
             moderator: (none)\n\
             terms: {}\n\
             seller key: 0x{}\n\
             valid until: 2026-11-04 13:58:26 UTC",
            "01".repeat(32),
            "02".repeat(20),
            "aa".repeat(20),
            bs58::encode([0xbb; 32]).into_string(),
            "aa".repeat(20),
            "05".repeat(20),
            "03".repeat(32),
            hex0x(&t.hash()),
            "06".repeat(48)
        );
        assert_eq!(text, expected);
    }
}
