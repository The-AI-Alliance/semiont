//! A client's sessions with knowledge bases.
//!
//! - `SemiontSession` is one session: a client, the token its transport
//!   sends, and who is signed in. It runs anywhere and shows nobody
//!   anything.
//! - `SemiontBrowser` is what an application holds: the knowledge bases it
//!   has registered, which of them is active, the active one's session, and
//!   what a person has open in each. It builds sessions through the
//!   `SessionFactory` it is given, and so knows nothing of how a knowledge
//!   base is reached.
//! - `SessionSignals` is what a host shows about a session, apart from it.
//!
//! Signing in at an issuer, and building a session over HTTP, are the HTTP
//! transport crate's: this one does no HTTP.
//!
//! **How a token is held** is one rule for every SDK
//! (specs/src/session/cases.json, which this crate's tests run): when a token
//! expires, read from its own claims, and how long to wait before renewing
//! it. The margin before expiry is half the token's lifetime, capped at
//! `REFRESH_BEFORE_EXP`. A fixed margin can equal the lifetime an issuer
//! mints, and then every renewal is due the moment it is issued; half a
//! lifetime cannot, for any lifetime. The wait is never under
//! `MIN_REFRESH_DELAY`, so a token already past its renewal point is renewed
//! once per interval, not in a loop.

mod browser;
mod factory;
mod knowledge_base;
mod open_resource;
mod semiont_session;
mod signals;
mod stored;

pub use browser::{
    Expected, KbReadVerdict, SemiontBrowser, SemiontBrowserConfig, SignInOutcome, SignedIn,
};
pub use factory::{SessionFactory, SessionFactoryOptions};
pub use knowledge_base::{
    HttpEndpoint, KbEndpoint, KbRead, KbSessionStatus, KbTarget, KnowledgeBase, NewKnowledgeBase,
    Protocol, is_valid_hostname,
};
pub use open_resource::{OpenResource, TabCheck, apply_tab_checks, sort_open_resources};
pub use semiont_session::{
    OnAuthFailed, OnSessionError, Refresh, SemiontSession, SemiontSessionConfig, SessionRenewer,
    Validate,
};
pub use signals::{
    KbIdentityConflict, PermissionDenied, SessionEndReason, SessionEnded, SessionSignals,
};
pub use stored::{
    ACTIVE_KEY, KNOWLEDGE_BASES_KEY, LAST_VIEWED_RESOURCE_BY_KB_KEY, OPEN_RESOURCES_BY_KB_KEY,
    StoredSession, clear_stored_session, is_token_expired, kb_of_session_key, load_knowledge_bases,
    save_knowledge_bases, session_key, store_session, stored_session,
};

include!(concat!(env!("OUT_DIR"), "/oauth_clients.rs"));

use crate::timing::{MIN_REFRESH_DELAY, REFRESH_BEFORE_EXP};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use serde_json::Value;
use std::future::Future;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::sync::watch;

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

/// A claim of a token that is text, when the token carries one.
pub fn text_claim(token: &str, name: &str) -> Option<String> {
    claims(token)?[name].as_str().map(str::to_owned)
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

/// Renew a token whenever it is due, for as long as somebody holds it: wait
/// what `refresh_delay` says of the token as it is, and call `renew`. The
/// wait is counted from each token as it arrives, so one renewed some other
/// way starts a wait of its own, and a renewal that changed nothing is due
/// again a floor later. A token that names no expiry schedules nothing: it
/// is renewed when whoever it is shown to refuses it.
pub async fn renew_when_due<Fut: Future<Output = ()>>(
    mut token: watch::Receiver<Option<String>>,
    mut renew: impl FnMut() -> Fut,
) {
    loop {
        let due = token
            .borrow_and_update()
            .as_deref()
            .and_then(|token| refresh_delay(token, SystemTime::now()));
        match due {
            Some(due) => {
                tokio::select! {
                    () = tokio::time::sleep(due) => {}
                    changed = token.changed() => match changed {
                        Ok(()) => continue,
                        Err(_) => return,
                    },
                }
            }
            None => match token.changed().await {
                Ok(()) => continue,
                Err(_) => return,
            },
        }
        renew().await;
    }
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
