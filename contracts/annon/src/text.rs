//! How amounts and times read in the texts a wallet signs, so a person can check them.

/// USDC base units (6 decimals) as a decimal: 10000 reads "0.01".
pub(crate) fn usdc(units: u128) -> String {
    let (whole, part) = (units / 1_000_000, units % 1_000_000);
    if part == 0 {
        return whole.to_string();
    }
    format!("{whole}.{}", format!("{part:06}").trim_end_matches('0'))
}

/// Unix seconds as a UTC date and time: 0 reads "1970-01-01 00:00:00 UTC".
pub(crate) fn utc(secs: u64) -> String {
    let (days, time) = (secs / 86_400, secs % 86_400);
    // Days since 1970-01-01 to a calendar date (Howard Hinnant's civil_from_days, unsigned
    // because a deadline is never before 1970).
    let z = days + 719_468;
    let (era, doe) = (z / 146_097, z % 146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = era * 400 + yoe + u64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02} {:02}:{:02}:{:02} UTC",
        time / 3_600,
        time / 60 % 60,
        time % 60
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn usdc_reads_as_a_decimal() {
        for (units, text) in [
            (1, "0.000001"),
            (10_000, "0.01"),
            (1_000_000, "1"),
            (1_500_000, "1.5"),
            (123_456_789, "123.456789"),
            (u128::MAX, "340282366920938463463374607431768.211455"),
        ] {
            assert_eq!(usdc(units), text);
        }
    }

    #[test]
    fn utc_matches_javascript_dates() {
        // From `new Date(t * 1000).toISOString()` in Node, not from this code.
        for (t, text) in [
            (0, "1970-01-01 00:00:00 UTC"),
            (951_782_400, "2000-02-29 00:00:00 UTC"),
            (951_868_799, "2000-02-29 23:59:59 UTC"),
            (1_793_000_000, "2026-10-26 07:33:20 UTC"),
            (1_793_800_706, "2026-11-04 13:58:26 UTC"),
            (4_102_444_799, "2099-12-31 23:59:59 UTC"),
            (4_107_542_400, "2100-03-01 00:00:00 UTC"),
        ] {
            assert_eq!(utc(t), text);
        }
    }

    #[test]
    fn the_largest_deadline_still_formats() {
        assert!(utc(u64::MAX).ends_with(" UTC"));
    }
}
