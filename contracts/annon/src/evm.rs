//! EVM helpers: hex fields and EIP-191 signature recovery.
use near_sdk::env;

pub(crate) fn bytes<const N: usize>(s: &str, name: &str) -> [u8; N] {
    hex::decode(s.strip_prefix("0x").unwrap_or(s))
        .ok()
        .and_then(|v| v.try_into().ok())
        .unwrap_or_else(|| env::panic_str(&format!("{name} must be {N} bytes of hex")))
}

pub(crate) fn hex0x(b: &[u8]) -> String {
    format!("0x{}", hex::encode(b))
}

/// The EVM address behind an EIP-191 `personal_sign` signature (65 bytes, `v` 0/1 or 27/28).
/// High-`s` signatures are rejected.
pub(crate) fn recover_eip191(message: &str, sig: &str) -> Option<[u8; 20]> {
    let sig = hex::decode(sig.strip_prefix("0x").unwrap_or(sig)).ok()?;
    if sig.len() != 65 {
        return None;
    }
    let v = match sig[64] {
        v @ 0..=1 => v,
        v @ 27..=28 => v - 27,
        _ => return None,
    };
    let prefixed = format!("\x19Ethereum Signed Message:\n{}{message}", message.len());
    let pubkey = env::ecrecover(
        &env::keccak256_array(prefixed.as_bytes()),
        &sig[..64],
        v,
        true,
    )?;
    env::keccak256_array(pubkey)[12..].try_into().ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tests::context;
    use near_sdk::NearToken;

    #[test]
    fn recovers_a_signature_made_by_viem() {
        context(NearToken::from_yoctonear(0));
        // viem `signMessage` with private key 0x01..01, as a browser wallet returns it.
        let sig = "0xa0b1241b6a8e97f459e365636c15fe34dceece91c6f78ec04fb79c69bef010592472ee3522a86fdef71d7117ccd342deb84ad74a90768cbb550af1afd10a11691b";
        let address =
            recover_eip191("Annon: list a file for sale\ncontract: x", sig).map(|a| hex0x(&a));
        assert_eq!(
            address.as_deref(),
            Some("0x1a642f0e3c3af545e7acbd38b07251b3990914f1")
        );
    }
}
