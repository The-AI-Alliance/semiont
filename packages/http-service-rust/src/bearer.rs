//! The bearer credential.

use axum::http::{HeaderMap, header};

/// The token an `Authorization: Bearer …` header carries: the scheme in any
/// case, whatever follows it trimmed; nothing following it is no token.
pub fn bearer_token(headers: &HeaderMap) -> Option<String> {
    let value = headers.get(header::AUTHORIZATION)?.to_str().ok()?;
    let scheme = value.get(..6)?;
    if !scheme.eq_ignore_ascii_case("bearer") {
        return None;
    }
    let rest = &value[6..];
    if !rest.is_empty() && !rest.starts_with([' ', '\t']) {
        return None;
    }
    let token = rest.trim_matches(|c: char| c.is_whitespace());
    (!token.is_empty()).then(|| token.to_owned())
}
