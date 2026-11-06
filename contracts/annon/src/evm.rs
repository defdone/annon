//! EVM helpers: hex fields, EIP-191 signature recovery and block headers.
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

/// The block number and timestamp (fields 8 and 11) of an RLP block header, if `rlp` is exactly
/// one RLP list whose first twelve items are well formed. Later fields are not read, so a header
/// that grows new fields keeps working; whether the bytes are the real header is the caller's
/// check (their keccak256 must be the verified block hash).
pub(crate) fn header_number_and_time(rlp: &[u8]) -> Option<(u64, u64)> {
    let (mut fields, rest) = rlp_item(rlp, true)?;
    if !rest.is_empty() {
        return None;
    }
    let (mut number, mut time) = (0, 0);
    for i in 0..12 {
        let (field, rest) = rlp_item(fields, false)?;
        fields = rest;
        match i {
            8 => number = uint(field)?,
            11 => time = uint(field)?,
            _ => {}
        }
    }
    Some((number, time))
}

/// The first RLP item of `b` (a list if `list`, else a string): its payload and what follows.
fn rlp_item(b: &[u8], list: bool) -> Option<(&[u8], &[u8])> {
    let prefix = *b.first()?;
    let (start, len) = match (prefix, list) {
        (0x00..=0x7f, false) => (0, 1),
        (0x80..=0xb7, false) => (1, usize::from(prefix - 0x80)),
        (0xb8..=0xbf, false) => long_length(b, prefix - 0xb7)?,
        (0xc0..=0xf7, true) => (1, usize::from(prefix - 0xc0)),
        (0xf8..=0xff, true) => long_length(b, prefix - 0xf7)?,
        _ => return None,
    };
    let end = start.checked_add(len)?;
    (end <= b.len()).then(|| (&b[start..end], &b[end..]))
}

/// A long RLP length in the `n` bytes after the prefix. Checked arithmetic: `usize` is 32 bits on
/// wasm, so a shift would silently drop high bytes of a five-byte length.
fn long_length(b: &[u8], n: u8) -> Option<(usize, usize)> {
    let n = usize::from(n);
    let len = b.get(1..1 + n)?.iter().try_fold(0usize, |a, x| {
        a.checked_mul(256)?.checked_add(usize::from(*x))
    })?;
    Some((1 + n, len))
}

fn uint(b: &[u8]) -> Option<u64> {
    (b.len() <= 8).then(|| b.iter().fold(0, |a, x| (a << 8) | u64::from(*x)))
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

    /// Real Base mainnet headers (`specs/vectors/base-headers.json`), before and after Denim.
    fn base_headers() -> Vec<(Vec<u8>, u64, u64, [u8; 32])> {
        let v: near_sdk::serde_json::Value = near_sdk::serde_json::from_str(include_str!(
            "../../../specs/vectors/base-headers.json"
        ))
        .unwrap();
        v["cases"]
            .as_array()
            .unwrap()
            .iter()
            .map(|c| {
                let h = |k: &str| hex::decode(&c[k].as_str().unwrap()[2..]).unwrap();
                (
                    h("rlp"),
                    c["number"].as_u64().unwrap(),
                    c["timestamp"].as_u64().unwrap(),
                    h("hash").try_into().unwrap(),
                )
            })
            .collect()
    }

    #[test]
    fn reads_real_base_headers_that_hash_to_their_block() {
        context(NearToken::from_yoctonear(0));
        let headers = base_headers();
        assert_eq!(headers.len(), 5);
        for (rlp, number, time, hash) in headers {
            assert_eq!(env::keccak256_array(&rlp), hash, "block {number}");
            assert_eq!(header_number_and_time(&rlp), Some((number, time)));
        }
    }

    #[test]
    fn keeps_reading_a_header_that_grows_a_field() {
        let (rlp, number, time, _) = base_headers().remove(4);
        // Re-wrap the same items with one more 32-byte field at the end.
        let (body, _) = rlp_item(&rlp, true).unwrap();
        let mut grown = body.to_vec();
        grown.push(0xa0);
        grown.extend([0x77; 32]);
        let mut out = vec![0xf9, (grown.len() >> 8) as u8, grown.len() as u8];
        out.extend(grown);
        assert_eq!(header_number_and_time(&out), Some((number, time)));
    }

    #[test]
    fn refuses_what_is_not_one_header_without_panicking() {
        let (rlp, ..) = base_headers().remove(2);
        for cut in 0..rlp.len() {
            assert_eq!(header_number_and_time(&rlp[..cut]), None, "cut at {cut}");
        }
        assert_eq!(
            header_number_and_time(&[rlp.clone(), vec![0]].concat()),
            None
        );
        assert_eq!(header_number_and_time(&[0xc1, 0x80]), None, "one field");
        assert_eq!(
            header_number_and_time(&[0x80]),
            None,
            "a string, not a list"
        );
        assert_eq!(header_number_and_time(&[0x05]), None, "a byte, not a list");
        // A list whose length takes eight bytes: no input is that long, and the length must not
        // wrap around a 32-bit usize to something that fits.
        let mut huge = vec![0xff, 1, 0, 0, 0, 0, 0, 0, 0x10];
        huge.extend([0x80; 16]);
        assert_eq!(header_number_and_time(&huge), None, "an eight-byte length");
        assert_eq!(
            long_length(&[0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff], 8)
                .filter(|_| usize::BITS == 64),
            Some((9, usize::MAX))
        );
        // Twelve fields, but the block number (8) is a list.
        let mut fields = vec![0x80; 8];
        fields.push(0xc0);
        fields.extend([0x80; 3]);
        let mut nested = vec![0xc0 + fields.len() as u8];
        nested.extend(fields);
        assert_eq!(
            header_number_and_time(&nested),
            None,
            "a list where a number belongs"
        );
        // A number of nine bytes does not fit a u64.
        let mut fields = vec![0x80; 8];
        fields.extend([0x89, 1, 0, 0, 0, 0, 0, 0, 0, 0]);
        fields.extend([0x80; 3]);
        let mut big = vec![0xc0 + fields.len() as u8];
        big.extend(fields);
        assert_eq!(header_number_and_time(&big), None);
    }

    #[test]
    fn a_changed_header_never_panics() {
        let (rlp, ..) = base_headers().remove(1);
        for bit in 0..rlp.len() * 8 {
            let mut f = rlp.clone();
            f[bit / 8] ^= 1 << (bit % 8);
            let _ = header_number_and_time(&f);
        }
    }
}
