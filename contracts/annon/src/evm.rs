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

    const MESSAGE: &str = "Annon: list a file for sale\ncontract: x";
    const VIEM_SIG: &str = "0xa0b1241b6a8e97f459e365636c15fe34dceece91c6f78ec04fb79c69bef010592472ee3522a86fdef71d7117ccd342deb84ad74a90768cbb550af1afd10a11691b";
    const SIGNER: &str = "0x1a642f0e3c3af545e7acbd38b07251b3990914f1";

    fn recover(sig: &[u8]) -> Option<String> {
        context(NearToken::from_yoctonear(0));
        recover_eip191(MESSAGE, &hex0x(sig)).map(|a| hex0x(&a))
    }

    fn viem() -> Vec<u8> {
        hex::decode(&VIEM_SIG[2..]).unwrap()
    }

    #[test]
    fn v_may_be_0_1_or_27_28() {
        let mut sig = viem();
        sig[64] -= 27;
        assert_eq!(recover(&sig).as_deref(), Some(SIGNER));
    }

    #[test]
    fn the_other_s_of_a_valid_signature_is_refused() {
        // (r, n - s) with the flipped v recovers the same key; the host call must refuse it.
        use k256::elliptic_curve::PrimeField;
        let mut sig = viem();
        let s_bytes: [u8; 32] = sig[32..64].try_into().unwrap();
        let s = k256::Scalar::from_repr(s_bytes.into()).unwrap();
        sig[32..64].copy_from_slice(&(-s).to_bytes());
        sig[64] = if sig[64] == 27 { 28 } else { 27 };
        assert_eq!(recover(&sig), None);
        // Control: without the low-s rule the same bytes name the same signer, so the refusal
        // above comes from that rule and not from a broken vector.
        let prefixed = format!("\x19Ethereum Signed Message:\n{}{MESSAGE}", MESSAGE.len());
        let lax = env::ecrecover(
            &env::keccak256_array(prefixed.as_bytes()),
            &sig[..64],
            sig[64] - 27,
            false,
        )
        .map(|k| hex0x(&env::keccak256_array(k)[12..]));
        assert_eq!(lax.as_deref(), Some(SIGNER));
    }

    #[test]
    fn other_v_values_are_refused() {
        for v in [2u8, 26, 29, 35, 255] {
            let mut sig = viem();
            sig[64] = v;
            assert_eq!(recover(&sig), None, "v = {v}");
        }
    }

    #[test]
    fn wrong_lengths_and_zero_scalars_are_refused() {
        let sig = viem();
        assert_eq!(recover(&sig[..64]), None, "64 bytes (EIP-2098 compact)");
        assert_eq!(recover(&[sig.clone(), vec![0]].concat()), None, "66 bytes");
        let mut zero_r = sig.clone();
        zero_r[..32].fill(0);
        assert_eq!(recover(&zero_r), None, "r = 0");
        let mut zero_s = sig;
        zero_s[32..64].fill(0);
        assert_eq!(recover(&zero_s), None, "s = 0");
        context(NearToken::from_yoctonear(0));
        assert_eq!(recover_eip191(MESSAGE, "0xnot-hex"), None);
    }

    #[test]
    fn a_signature_over_another_message_names_another_signer() {
        context(NearToken::from_yoctonear(0));
        let other =
            recover_eip191("Annon: list a file for sale\ncontract: y", VIEM_SIG).map(|a| hex0x(&a));
        assert_ne!(other.as_deref(), Some(SIGNER));
    }
}
