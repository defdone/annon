//! Who signs or receives, on any chain (specs/near-settlement.md §2): an EVM address, a Solana
//! ed25519 key or a NEAR account. One type for sellers, split recipients, refunds and recovery.
use near_sdk::{env, near, AccountId};

use crate::evm::{bytes, hex0x, recover_eip191};

#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Identity {
    Evm([u8; 20]),
    Solana([u8; 32]),
    Near(AccountId),
}

/// `{"kind":"evm"|"solana"|"near","id":…}` as it travels in JSON.
#[near(serializers = [json])]
#[derive(Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct IdentityJson {
    pub kind: String,
    pub id: String,
}

/// A signature over an authoritative text: `{"kind":"evm"|"solana","sig":"0x…"}`.
#[near(serializers = [json])]
#[derive(Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct Auth {
    pub kind: String,
    pub sig: String,
}

impl From<&Identity> for IdentityJson {
    fn from(i: &Identity) -> Self {
        let id = match i {
            Identity::Evm(a) => hex0x(a),
            Identity::Solana(k) => hex::encode(k),
            Identity::Near(a) => a.to_string(),
        };
        IdentityJson {
            kind: i.kind().into(),
            id,
        }
    }
}

fn lower_hex(s: &str, n: usize) -> bool {
    s.len() == n
        && s.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

impl Identity {
    /// The canonical JSON form only: lowercase hex, `0x` for EVM, none for Solana.
    pub fn parse(kind: &str, id: &str) -> Option<Self> {
        match kind {
            "evm" => id
                .strip_prefix("0x")
                .filter(|h| lower_hex(h, 40))
                .map(|h| Self::Evm(bytes::<20>(h, "id"))),
            "solana" => lower_hex(id, 64).then(|| Self::Solana(bytes::<32>(id, "id"))),
            // AccountId parsing is NEAR's own canonical check (lowercase, 2..64, separators).
            "near" => id.parse().ok().map(Self::Near),
            _ => None,
        }
    }

    pub fn from_json(j: &IdentityJson) -> Option<Self> {
        Self::parse(&j.kind, &j.id)
    }

    pub fn kind(&self) -> &'static str {
        match self {
            Self::Evm(_) => "evm",
            Self::Solana(_) => "solana",
            Self::Near(_) => "near",
        }
    }

    /// The Intents account that holds this identity's balance.
    pub fn intents_id(&self) -> String {
        match self {
            Self::Evm(a) => hex0x(a),
            Self::Solana(k) => hex::encode(k),
            Self::Near(a) => a.to_string(),
        }
    }

    /// How a person reads it in a text they sign.
    pub fn text(&self) -> String {
        match self {
            Self::Evm(a) => format!("EVM {}", hex0x(a)),
            Self::Solana(k) => format!("Solana {}", bs58::encode(k).into_string()),
            Self::Near(a) => format!("NEAR {a}"),
        }
    }

    /// Whether this identity authorized `text`: an EIP-191 signature, an Ed25519 signature over the
    /// text's UTF-8 bytes, or (NEAR) the call itself coming from the account, with no signature.
    pub fn authorized(&self, text: &str, auth: Option<&Auth>) -> bool {
        match (self, auth) {
            (Self::Evm(a), Some(x)) if x.kind == "evm" => recover_eip191(text, &x.sig) == Some(*a),
            (Self::Solana(k), Some(x)) if x.kind == "solana" => {
                match hex::decode(x.sig.strip_prefix("0x").unwrap_or("-")) {
                    Ok(sig) if sig.len() == 64 => {
                        env::ed25519_verify(&sig.try_into().unwrap(), text.as_bytes(), k)
                    }
                    _ => false,
                }
            }
            (Self::Near(a), None) => &env::predecessor_account_id() == a,
            _ => false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::testing_env;

    fn caller(a: &str) {
        testing_env!(VMContextBuilder::new()
            .predecessor_account_id(a.parse().unwrap())
            .build());
    }

    #[test]
    fn parses_only_canonical_json_forms() {
        let evm = "0xabababababababababababababababababababab";
        assert!(matches!(
            Identity::parse("evm", evm),
            Some(Identity::Evm(_))
        ));
        for bad in [
            "0xABABABABABABABABABABABABABABABABABABABAB", // uppercase
            "abababababababababababababababababababab",   // no 0x
            "0xababababababababababababababababababab",   // short
        ] {
            assert_eq!(Identity::parse("evm", bad), None, "{bad}");
        }
        let sol = "0707070707070707070707070707070707070707070707070707070707070707";
        assert!(matches!(
            Identity::parse("solana", sol),
            Some(Identity::Solana(_))
        ));
        assert_eq!(Identity::parse("solana", &format!("0x{sol}")), None);
        assert_eq!(
            Identity::parse("solana", "US517G5965aydkZ46HS38QLi7UQiSojurfbQfKCELFx"),
            None,
            "base58 is the SDK's job"
        );
        assert!(matches!(
            Identity::parse("near", "app.near"),
            Some(Identity::Near(_))
        ));
        assert_eq!(Identity::parse("near", "App.near"), None);
        assert_eq!(Identity::parse("btc", evm), None);
    }

    #[test]
    fn intents_ids_and_texts_use_canonical_forms() {
        // Synthetic identities have canonical Intents IDs and readable signing text.
        let evm = Identity::parse("evm", "0xabababababababababababababababababababab").unwrap();
        let sol = Identity::parse(
            "solana",
            "0707070707070707070707070707070707070707070707070707070707070707",
        )
        .unwrap();
        assert_eq!(
            evm.intents_id(),
            "0xabababababababababababababababababababab"
        );
        assert_eq!(
            sol.intents_id(),
            "0707070707070707070707070707070707070707070707070707070707070707"
        );
        assert_eq!(
            sol.text(),
            "Solana US517G5965aydkZ46HS38QLi7UQiSojurfbQfKCELFx"
        );
        assert_eq!(evm.text(), "EVM 0xabababababababababababababababababababab");
    }

    #[test]
    fn borsh_discriminants_are_stable() {
        let b = |i: &Identity| near_sdk::borsh::to_vec(i).unwrap();
        assert_eq!(b(&Identity::Evm([7; 20]))[0], 0);
        assert_eq!(b(&Identity::Solana([7; 32]))[0], 1);
        let n = b(&Identity::Near("a.near".parse().unwrap()));
        assert_eq!(n, [&[2u8, 6, 0, 0, 0][..], b"a.near"].concat());
    }

    #[test]
    fn solana_signs_the_exact_text() {
        caller("relayer.near");
        let sk = SigningKey::from_bytes(&[9; 32]);
        let id = Identity::Solana(sk.verifying_key().to_bytes());
        let text = "Annon: open a purchased file again\nnonce: 0x01";
        let auth = |m: &str| Auth {
            kind: "solana".into(),
            sig: hex0x(&sk.sign(m.as_bytes()).to_bytes()),
        };
        assert!(id.authorized(text, Some(&auth(text))));
        assert!(
            !id.authorized(text, Some(&auth(&format!("{text}\n")))),
            "another text"
        );
        let mut wrong_kind = auth(text);
        wrong_kind.kind = "evm".into();
        assert!(!id.authorized(text, Some(&wrong_kind)));
        assert!(!id.authorized(text, None));
        let mut short = auth(text);
        short.sig.truncate(short.sig.len() - 2);
        assert!(!id.authorized(text, Some(&short)));
    }

    #[test]
    fn evm_signs_eip191() {
        use k256::ecdsa::SigningKey as K;
        caller("relayer.near");
        let sk = K::from_slice(&[5; 32]).unwrap();
        let pk = sk.verifying_key().to_encoded_point(false);
        let addr: [u8; 20] = env::keccak256_array(&pk.as_bytes()[1..])[12..]
            .try_into()
            .unwrap();
        let text = "Annon: list a file for sale";
        let prefixed = format!("\x19Ethereum Signed Message:\n{}{text}", text.len());
        let (sig, rec) = sk
            .sign_prehash_recoverable(&env::keccak256_array(prefixed.as_bytes()))
            .unwrap();
        let mut b = sig.to_bytes().to_vec();
        b.push(27 + rec.to_byte());
        let id = Identity::Evm(addr);
        assert!(id.authorized(
            text,
            Some(&Auth {
                kind: "evm".into(),
                sig: hex0x(&b)
            })
        ));
        assert!(!id.authorized(
            "Annon: list a file for sale.",
            Some(&Auth {
                kind: "evm".into(),
                sig: hex0x(&b)
            })
        ));
        assert!(!id.authorized(
            text,
            Some(&Auth {
                kind: "solana".into(),
                sig: hex0x(&b)
            })
        ));
    }

    #[test]
    fn near_is_the_caller_and_never_a_signature() {
        let id = Identity::Near("seller.near".parse().unwrap());
        caller("seller.near");
        assert!(id.authorized("anything", None));
        assert!(!id.authorized(
            "anything",
            Some(&Auth {
                kind: "evm".into(),
                sig: "0x00".into()
            })
        ));
        caller("relayer.near");
        assert!(!id.authorized("anything", None));
    }
}
