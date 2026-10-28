//! A time as RFC 3339 writes it, in UTC.

use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// How long after the start of 1970 a time is. A time before it is taken for
/// the start of 1970.
fn since_1970(at: SystemTime) -> Duration {
    at.duration_since(UNIX_EPOCH).unwrap_or_default()
}

/// The date and the time of day, to the second, that are `seconds` after the
/// start of 1970: `2026-10-01T15:50:30`.
fn date_and_time(seconds: u64) -> String {
    let (days, of_day) = (seconds / 86_400, seconds % 86_400);
    // The civil date of a count of days since 1970-01-01, in the proleptic
    // Gregorian calendar, by eras of 400 years that begin on a March 1st.
    let shifted = days + 719_468;
    let (era, day_of_era) = (shifted / 146_097, shifted % 146_097);
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let shifted_month = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * shifted_month + 2) / 5 + 1;
    let month = if shifted_month < 10 {
        shifted_month + 3
    } else {
        shifted_month - 9
    };
    let year = year_of_era + era * 400 + u64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}",
        of_day / 3_600,
        of_day % 3_600 / 60,
        of_day % 60
    )
}

/// A time as RFC 3339 in UTC, to the second.
pub(crate) fn to_the_second(at: SystemTime) -> String {
    format!("{}Z", date_and_time(since_1970(at).as_secs()))
}

/// A time as RFC 3339 in UTC, to the millisecond.
pub(crate) fn to_the_millisecond(at: SystemTime) -> String {
    let since = since_1970(at);
    format!(
        "{}.{:03}Z",
        date_and_time(since.as_secs()),
        since.subsec_millis()
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_time_is_written_as_rfc_3339_in_utc() {
        let at = |seconds: u64| to_the_second(UNIX_EPOCH + Duration::from_secs(seconds));
        assert_eq!(at(0), "1970-01-01T00:00:00Z");
        assert_eq!(at(951_782_400), "2000-02-29T00:00:00Z");
        assert_eq!(at(1_790_869_830), "2026-10-01T15:50:30Z");
        assert_eq!(at(4_102_444_799), "2099-12-31T23:59:59Z");
    }

    #[test]
    fn to_the_millisecond_it_has_three_digits_of_a_second_and_the_rest_is_dropped() {
        let at = |millis: u64, nanos: u64| {
            to_the_millisecond(
                UNIX_EPOCH + Duration::from_millis(millis) + Duration::from_nanos(nanos),
            )
        };
        assert_eq!(at(0, 0), "1970-01-01T00:00:00.000Z");
        assert_eq!(at(1_790_869_830_007, 0), "2026-10-01T15:50:30.007Z");
        assert_eq!(at(1_790_869_830_999, 999_999), "2026-10-01T15:50:30.999Z");
    }
}
