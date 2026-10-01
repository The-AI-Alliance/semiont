//! How a client holds a session's token, as every SDK computes it
//! (specs/src/session/cases.json, which this crate's tests run): when a token
//! expires, read from its own claims, and how long to wait before renewing
//! it.
//!
//! The margin before expiry is half the token's lifetime, capped at
//! `REFRESH_BEFORE_EXP`. A fixed margin can equal the lifetime an issuer
//! mints, and then every renewal is due the moment it is issued; half a
//! lifetime cannot, for any lifetime. The wait is never under
//! `MIN_REFRESH_DELAY`, so a token already past its renewal point is renewed
//! once per interval, not in a loop.

use crate::timing::{MIN_REFRESH_DELAY, REFRESH_BEFORE_EXP};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use serde_json::Value;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// The claims of a JWT: its second segment of three, base64url without
/// padding, UTF-8 JSON.
fn claims(token: &str) -> Option<Value> {
    let mut segments = token.split('.');
    let (_, payload, _) = (segments.next()?, segments.next()?, segments.next()?);
    if segments.next().is_some() {
        return None;
    }
    serde_json::from_slice(&URL_SAFE_NO_PAD.decode(payload).ok()?).ok()
}

/// A numeric claim, in seconds; absent, or zero, is none.
fn seconds(claims: &Value, name: &str) -> Option<f64> {
    claims[name].as_f64().filter(|s| *s != 0.0)
}

/// When a token expires, by its `exp` claim; `None` when it names no time.
pub fn token_expiry(token: &str) -> Option<SystemTime> {
    let exp = seconds(&claims(token)?, "exp")?;
    UNIX_EPOCH.checked_add(Duration::try_from_secs_f64(exp).ok()?)
}

/// How long to wait before renewing a token that lives `lifetime` in all and
/// has `remaining` of it left.
pub fn renewal_delay(lifetime: Duration, remaining: Duration) -> Duration {
    let margin = REFRESH_BEFORE_EXP.min(lifetime / 2);
    remaining.saturating_sub(margin).max(MIN_REFRESH_DELAY)
}

/// How long to wait, from `now`, before renewing `token`; `None` when it has
/// no readable `exp`, and nothing is scheduled. The lifetime is the one the
/// issuer chose (`exp - iat`); with no `iat`, what remains of it.
pub fn refresh_delay(token: &str, now: SystemTime) -> Option<Duration> {
    let claims = claims(token)?;
    let exp = seconds(&claims, "exp")?;
    let now = now.duration_since(UNIX_EPOCH).ok()?.as_secs_f64();
    let remaining = Duration::try_from_secs_f64((exp - now).max(0.0)).ok()?;
    let lifetime = match seconds(&claims, "iat") {
        Some(iat) => Duration::try_from_secs_f64((exp - iat).max(0.0)).ok()?,
        None => remaining,
    };
    Some(renewal_delay(lifetime, remaining))
}
