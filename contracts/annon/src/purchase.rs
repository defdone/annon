//! The purchase message and its commitment (specs/near-settlement.md §5): parsed strictly, the
//! refund identity first, so that any later problem has a place to send the money back to.
use near_sdk::serde::Deserialize;
use near_sdk::{env, near, AccountId};

use crate::evm::hex0x;
use crate::identity::{Identity, IdentityJson};
use crate::terms::tagged_hash;

pub const MAX_MSG: usize = 1024;
const MAX_PREFIX: usize = 160;
const PREFIX: &str = "{\"annon\":2,\"refund\":{\"kind\":\"";

#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct Purchase {
    pub version: u8,
    pub refund: Identity,
    pub network: String,
    pub contract: AccountId,
    /// 0 near-usdc, 1 base-usdc.
    pub route: u8,
    pub asset: String,
    pub file_id: [u8; 32],
    pub terms_hash: [u8; 32],
    pub price: u128,
    pub nonce: [u8; 32],
    pub buyer_key: [u8; 48],
    pub recovery: Identity,
    pub expires_at: u64,
}

impl Purchase {
    pub fn id(&self) -> [u8; 32] {
        tagged_hash("annon/purchase/v2", self)
    }
}

/// `keccak256("annon/base-payment/v2" ‖ 0x00 ‖ purchase_id)`: the EIP-3009 nonce of a Base purchase.
pub fn base_nonce(purchase_id: &[u8; 32]) -> [u8; 32] {
    let mut b = b"annon/base-payment/v2\0".to_vec();
    b.extend_from_slice(purchase_id);
    env::keccak256_array(&b)
}

#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde", deny_unknown_fields)]
struct Msg {
    annon: u8,
    refund: IdentityJson,
    purchase: Body,
}

#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde", deny_unknown_fields)]
struct Body {
    network: String,
    contract: String,
    route: String,
    asset: String,
    file_id: String,
    terms_hash: String,
    price: String,
    nonce: String,
    buyer_key: String,
    recovery: IdentityJson,
    expires_at: String,
    purchase_id: String,
}

/// What a delivery's message says.
// Note: short-lived return value, never stored; boxing would only add an allocation.
#[allow(clippy::large_enum_variant)]
#[derive(Debug, PartialEq)]
pub enum Parsed {
    /// Not an Annon purchase: no refund identity can be read. The contract refuses the tokens.
    Foreign,
    /// A refund identity but an unusable purchase: everything goes back to `refund`.
    Unusable {
        refund: Identity,
        why: &'static str,
    },
    Ok {
        purchase: Purchase,
        id: [u8; 32],
    },
}

/// The refund identity from the fixed prefix, read without parsing the rest.
pub(crate) fn refund_prefix(msg: &str) -> Option<Identity> {
    let head = &msg.as_bytes()[..msg.len().min(MAX_PREFIX)];
    let head = std::str::from_utf8(head).ok().or_else(|| {
        // A multi-byte character cut at the bound: the prefix is ASCII, so the valid part is enough.
        let n = (0..head.len())
            .rev()
            .find(|&i| std::str::from_utf8(&head[..i]).is_ok())?;
        std::str::from_utf8(&head[..n]).ok()
    })?;
    let rest = head.strip_prefix(PREFIX)?;
    let (kind, rest) = rest.split_once('"')?;
    let rest = rest.strip_prefix(",\"id\":\"")?;
    let (id, rest) = rest.split_once('"')?;
    rest.strip_prefix("},")?;
    Identity::parse(kind, id)
}

fn fixed<const N: usize>(s: &str) -> Option<[u8; N]> {
    let h = s.strip_prefix("0x")?;
    if h.len() != 2 * N
        || !h
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return None;
    }
    hex::decode(h).ok()?.try_into().ok()
}

/// A canonical unsigned decimal: digits only, no leading zero unless "0".
fn canonical<T: std::str::FromStr + ToString>(s: &str) -> Option<T> {
    let v: T = s.parse().ok()?;
    (v.to_string() == s && s.bytes().all(|b| b.is_ascii_digit())).then_some(v)
}

fn identity_json(i: &Identity) -> String {
    let kind = match i {
        Identity::Evm(_) => "evm",
        Identity::Solana(_) => "solana",
        Identity::Near(_) => "near",
    };
    format!("{{\"kind\":\"{kind}\",\"id\":\"{}\"}}", i.intents_id())
}

/// The one canonical serialization of a message (§5.1): compact, keys in order.
pub fn to_json(p: &Purchase, id: &[u8; 32]) -> String {
    format!(
        "{{\"annon\":2,\"refund\":{},\"purchase\":{{\"network\":\"{}\",\"contract\":\"{}\",\"route\":\"{}\",\"asset\":\"{}\",\"file_id\":\"{}\",\"terms_hash\":\"{}\",\"price\":\"{}\",\"nonce\":\"{}\",\"buyer_key\":\"{}\",\"recovery\":{},\"expires_at\":\"{}\",\"purchase_id\":\"{}\"}}}}",
        identity_json(&p.refund),
        p.network,
        p.contract,
        if p.route == 0 { "near-usdc" } else { "base-usdc" },
        p.asset,
        hex0x(&p.file_id),
        hex0x(&p.terms_hash),
        p.price,
        hex0x(&p.nonce),
        hex0x(&p.buyer_key),
        identity_json(&p.recovery),
        p.expires_at,
        hex0x(id),
    )
}

/// A compressed BLS12-381 G1 point in the prime-order subgroup, not the identity.
pub fn valid_bls_key(key: &[u8; 48]) -> bool {
    if key[0] & 0x40 != 0 {
        return false; // the point at infinity
    }
    let Some(p) = env::bls12381_p1_decompress(key) else {
        return false;
    };
    // The pairing check rejects (None) a point outside G1; its result does not matter.
    let mut input = p;
    input.extend_from_slice(&G2_GENERATOR);
    env::bls12381_pairing_check(&input).is_some()
}

/// The BLS12-381 G2 generator, uncompressed (192 bytes, as NEP-488 encodes it).
const G2_GENERATOR: [u8; 192] = {
    const H: &[u8] = b"13e02b6052719f607dacd3a088274f65596bd0d09920b61ab5da61bbdc7f5049334cf11213945d57e5ac7d055d042b7e024aa2b2f08f0a91260805272dc51051c6e47ad4fa403b02b4510b647ae3d1770bac0326a805bbefd48056c8c121bdb80606c4a02ea734cc32acd2b02bc28b99cb3e287e85a763af267492ab572e99ab3f370d275cec1da1aaa9075ff05f79be0ce5d527727d6e118cc9cdc6da2e351aadfd9baa8cbdd3a76d429a695160d12c923ac9cc3baca289e193548608b82801";
    const fn v(c: u8) -> u8 {
        if c >= b'a' {
            c - b'a' + 10
        } else {
            c - b'0'
        }
    }
    let mut out = [0u8; 192];
    let mut i = 0;
    while i < 192 {
        out[i] = v(H[2 * i]) * 16 + v(H[2 * i + 1]);
        i += 1;
    }
    out
};

/// Reads a purchase message for `route` (0 NEAR, 1 Base); `network` and `asset` are what this
/// deployment accepts on that route, the contract is always this one.
pub fn parse(msg: &str, network: &str, asset: &str, route: u8) -> Parsed {
    let Some(refund) = refund_prefix(msg) else {
        return Parsed::Foreign;
    };
    let bad = |why| Parsed::Unusable {
        refund: refund.clone(),
        why,
    };
    if msg.len() > MAX_MSG {
        return bad("message too long");
    }
    let Ok(m) = near_sdk::serde_json::from_str::<Msg>(msg) else {
        return bad("not a purchase message");
    };
    let b = m.purchase;
    let named_route = match b.route.as_str() {
        "near-usdc" => 0,
        "base-usdc" => 1,
        _ => return bad("unknown route"),
    };
    let (Some(file_id), Some(terms_hash), Some(nonce), Some(buyer_key), Some(id)) = (
        fixed::<32>(&b.file_id),
        fixed::<32>(&b.terms_hash),
        fixed::<32>(&b.nonce),
        fixed::<48>(&b.buyer_key),
        fixed::<32>(&b.purchase_id),
    ) else {
        return bad("malformed hex field");
    };
    let (Some(price), Some(expires_at)) =
        (canonical::<u128>(&b.price), canonical::<u64>(&b.expires_at))
    else {
        return bad("malformed number");
    };
    let Some(recovery) = Identity::from_json(&b.recovery) else {
        return bad("invalid recovery identity");
    };
    let Ok(contract) = b.contract.parse::<AccountId>() else {
        return bad("invalid contract");
    };
    if m.annon != 2 || Identity::from_json(&m.refund).as_ref() != Some(&refund) {
        return bad("not a purchase message");
    }
    let purchase = Purchase {
        version: 2,
        refund: refund.clone(),
        network: b.network,
        contract,
        route: named_route,
        asset: b.asset,
        file_id,
        terms_hash,
        price,
        nonce,
        buyer_key,
        recovery,
        expires_at,
    };
    if purchase.id() != id {
        return bad("purchase id does not match");
    }
    // Byte for byte the canonical form: key order, no spaces, no duplicates, no escapes.
    if to_json(&purchase, &id) != msg {
        return bad("message is not in canonical form");
    }
    if purchase.network != network
        || purchase.contract != env::current_account_id()
        || purchase.asset != asset
    {
        return bad("message is for another network, contract or asset");
    }
    if purchase.route != route {
        return bad("purchase is for another route");
    }
    if !valid_bls_key(&purchase.buyer_key) {
        return bad("invalid buyer key");
    }
    Parsed::Ok { purchase, id }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::terms::tests::{ctx, USDC};

    /// A real G1 point: the generator, compressed.
    pub const G1: &str = "97f1d3a73197d7942695638c4fa9ac0fc3688c4f9774b905a14e3a3f171bac586c55e83ff97a1aeffb3af00adb22c6bb";

    pub fn purchase() -> Purchase {
        Purchase {
            version: 2,
            refund: Identity::Evm([0xe8; 20]),
            network: "near:mainnet".into(),
            contract: "annon.near".parse().unwrap(),
            route: 0,
            asset: USDC.into(),
            file_id: [1; 32],
            terms_hash: [2; 32],
            price: 200_000,
            nonce: [3; 32],
            buyer_key: hex::decode(G1).unwrap().try_into().unwrap(),
            recovery: Identity::Solana([0xb6; 32]),
            expires_at: 1_794_350_000,
        }
    }

    pub fn msg(p: &Purchase) -> String {
        to_json(p, &p.id())
    }

    fn parse_here(m: &str) -> Parsed {
        parse(m, "near:mainnet", USDC, 0)
    }

    #[test]
    fn a_canonical_message_parses() {
        ctx();
        let p = purchase();
        let m = msg(&p);
        assert!(m.len() <= MAX_MSG);
        assert_eq!(
            parse_here(&m),
            Parsed::Ok {
                id: p.id(),
                purchase: p
            }
        );
    }

    #[test]
    fn the_largest_message_fits() {
        ctx();
        let long = format!("{}.near", "a".repeat(58));
        let mut p = purchase();
        p.refund = Identity::Near(long.parse().unwrap());
        p.recovery = p.refund.clone();
        p.contract = "annon.near".parse().unwrap();
        p.price = u128::MAX;
        p.expires_at = u64::MAX;
        assert!(msg(&p).len() <= MAX_MSG, "{}", msg(&p).len());
    }

    #[test]
    fn without_a_refund_prefix_it_is_foreign() {
        ctx();
        let m = msg(&purchase());
        for foreign in [
            String::new(),
            "x".into(),
            r#"{"annon":1,"file":"0xab"}"#.into(),
            m.replacen("\"annon\":2", "\"annon\": 2", 1),
            m.replacen("\"kind\":\"evm\"", "\"kind\":\"btc\"", 1),
            m.replacen(
                &format!("0x{}", "e8".repeat(20)),
                &format!("0x{}", "E8".repeat(20)),
                1,
            ),
            format!(" {m}"),
        ] {
            assert_eq!(parse_here(&foreign), Parsed::Foreign, "{foreign}");
        }
    }

    #[test]
    fn with_a_refund_prefix_every_other_problem_refunds() {
        ctx();
        let p = purchase();
        let m = msg(&p);
        let refund = || p.refund.clone();
        let unusable = |s: &str| match parse_here(s) {
            Parsed::Unusable { refund: r, .. } => r == refund(),
            other => panic!("{s}: {other:?}"),
        };
        let mut cases = vec![
            m.replacen("\"price\":\"200000\"", "\"price\":\"0200000\"", 1),
            m.replacen("\"price\":\"200000\"", "\"price\":\"200001\"", 1), // id no longer matches
            m.replacen("\"route\":\"near-usdc\"", "\"route\":\"sol-usdc\"", 1),
            m.replacen(",\"nonce\"", ",\"extra\":1,\"nonce\"", 1),
            m.replacen("}}", ",\"purchase_id\":\"0x00\"}}", 1),
            format!("{m} "),
            format!("{}{}", &m[..m.len() - 1], ",\"x\":1}"),
            format!("{m}{}", " ".repeat(MAX_MSG)),
        ];
        // Same values, other key order.
        cases.push(m.replacen(
            "\"network\":\"near:mainnet\",\"contract\":\"annon.near\"",
            "\"contract\":\"annon.near\",\"network\":\"near:mainnet\"",
            1,
        ));
        for c in &cases {
            assert!(unusable(c));
        }
        let mut q = p.clone();
        q.contract = "other.near".parse().unwrap();
        assert!(unusable(&msg(&q)), "another contract");
        let mut q = p.clone();
        q.network = "near:testnet".into();
        assert!(unusable(&msg(&q)));
        let mut q = p.clone();
        q.route = 1;
        assert!(
            unusable(&msg(&q)),
            "a Base purchase sent to the NEAR receiver"
        );
        let mut q = p.clone();
        q.buyer_key[47] ^= 1;
        assert!(unusable(&msg(&q)), "not a curve point");
        let mut q = p.clone();
        q.buyer_key = [0; 48];
        q.buyer_key[0] = 0xc0;
        assert!(unusable(&msg(&q)), "the identity");
    }

    #[test]
    fn the_id_covers_every_field() {
        let p = purchase();
        let id = p.id();
        let mut v = vec![];
        let mut x = p.clone();
        x.refund = Identity::Evm([1; 20]);
        v.push(x);
        let mut x = p.clone();
        x.recovery = Identity::Evm([1; 20]);
        v.push(x);
        let mut x = p.clone();
        x.nonce[0] ^= 1;
        v.push(x);
        let mut x = p.clone();
        x.buyer_key[1] ^= 1;
        v.push(x);
        let mut x = p.clone();
        x.expires_at += 1;
        v.push(x);
        let mut x = p.clone();
        x.terms_hash[0] ^= 1;
        v.push(x);
        let mut x = p.clone();
        x.route = 1;
        v.push(x);
        for x in v {
            assert_ne!(x.id(), id);
        }
        assert_ne!(base_nonce(&id), id);
    }
}
