//! A session with one knowledge base: its client, the token the client's
//! transport sends, and who is signed in.
//!
//! Headless: it runs in an application, a script, a daemon and a test alike,
//! and shows nobody anything. What it needs of its environment it is given:
//!
//! - `refresh` renews the token: after it expires, and when the gateway
//!   refuses it. It answers the new token, nothing when there is nothing to
//!   renew with, or why it failed.
//! - `validate` asks the gateway who a token is: when the session starts,
//!   and of a token renewed because the gateway refused the one before. A
//!   session of a service has none: there is nobody to ask about.
//! - `on_auth_failed` is told when the session is over, and why: it could
//!   not be renewed (`Expired`), or the gateway refused a token the issuer
//!   had just issued (`Refused`). What a person reads of it is the host's.
//!   `on_error` is told of every failure that makes the session unusable.
//!
//! A session that cannot be renewed clears its token and what it stored, so a
//! dead credential is never used again. One that never had a credential is
//! only signed out: there is nothing to end, and nothing is said.
//!
//! The token is renewed before it expires, by the schedule every Semiont
//! client keeps (`super::refresh_delay`). What another context writes under
//! this knowledge base's key is taken up: a token it renewed, or a sign-out.
//!
//! `close` is the graceful end: the client is closed, and the token and the
//! user end. A session that is only dropped ends the same things, and leaves
//! its client to whoever else holds it. A session is built inside a Tokio
//! runtime.

use super::knowledge_base::KbTarget;
use super::signals::SessionEndReason;
use super::stored::{
    StoredSession, clear_stored_session, is_token_expired, session_key, stored_session,
};
use super::{renew_when_due, token_expiry};
use crate::client::SemiontClient;
use crate::errors::{SemiontError, SessionError, SessionErrorCode, TransportErrorCode};
use crate::locked;
use crate::state::{Held, Tasks};
use crate::storage::{SessionStorage, StorageSubscription};
use crate::transport::{BoxFuture, ConnectionState, Failures};
use crate::types::UserResponse;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, Weak};
use std::time::SystemTime;
use tokio::sync::watch;

/// Renew the token: the new one, `None` when there is nothing to renew
/// with, or why the renewal failed.
pub type Refresh =
    Arc<dyn Fn() -> BoxFuture<'static, Result<Option<String>, String>> + Send + Sync>;

/// Ask the gateway who `token` is.
pub type Validate =
    Arc<dyn Fn(String) -> BoxFuture<'static, Result<UserResponse, SemiontError>> + Send + Sync>;

/// Told that the session is over, and why.
pub type OnAuthFailed = Arc<dyn Fn(SessionEndReason) + Send + Sync>;

/// Told of a failure that makes the session unusable.
pub type OnSessionError = Arc<dyn Fn(SessionError) + Send + Sync>;

/// Why a renewal gave no token, for whoever reads the error.
fn not_renewed(failure: Option<String>) -> String {
    match failure {
        Some(failure) => format!("Token refresh failed: {failure}"),
        None => "Token refresh failed".to_owned(),
    }
}

pub struct SemiontSessionConfig {
    pub kb: KbTarget,
    /// Where the session's tokens are kept.
    pub storage: Arc<dyn SessionStorage>,
    /// The client, already built over its transport.
    pub client: Arc<SemiontClient>,
    /// The token the client's transport sends: the transport holds a
    /// receiver of this sender, and the session writes each renewed token
    /// into it.
    pub token: watch::Sender<Option<String>>,
    pub refresh: Option<Refresh>,
    pub validate: Option<Validate>,
    pub on_auth_failed: Option<OnAuthFailed>,
    pub on_error: Option<OnSessionError>,
}

struct Shared {
    id: String,
    kb: KbTarget,
    client: Arc<SemiontClient>,
    storage: Arc<dyn SessionStorage>,
    token: Held<Option<String>>,
    user: Held<Option<UserResponse>>,
    ready: Held<bool>,
    refresh: Option<Refresh>,
    validate: Option<Validate>,
    on_auth_failed: Option<OnAuthFailed>,
    on_error: Option<OnSessionError>,
    tasks: Tasks,
    storage_changes: Mutex<Option<StorageSubscription>>,
    closed: AtomicBool,
    /// Held while a refusal is being answered, so that the refusals that
    /// arrive during it are answered by it.
    answering: tokio::sync::Mutex<()>,
}

/// See the module's documentation.
pub struct SemiontSession {
    shared: Arc<Shared>,
}

impl SemiontSession {
    pub fn new(config: SemiontSessionConfig) -> SemiontSession {
        let shared = Arc::new(Shared {
            id: format!("session-{}", uuid::Uuid::new_v4()),
            kb: config.kb,
            client: config.client,
            storage: config.storage,
            token: Held::of(config.token),
            user: Held::new(None),
            ready: Held::new(false),
            refresh: config.refresh,
            validate: config.validate,
            on_auth_failed: config.on_auth_failed,
            on_error: config.on_error,
            tasks: Tasks::new(),
            storage_changes: Mutex::new(None),
            closed: AtomicBool::new(false),
            answering: tokio::sync::Mutex::new(()),
        });

        // A stored token that is still good is what the transport sends
        // first, unless it was given one already.
        let stored = stored_session(shared.storage.as_ref(), &shared.kb.id);
        if let Some(stored) = &stored
            && !is_token_expired(&stored.access, SystemTime::now())
            && shared.token.now().is_none()
        {
            shared.token.set(Some(stored.access.clone()));
        }

        let renewing = shared.clone();
        shared
            .tasks
            .spawn(renew_when_due(shared.token.read(), move || {
                let shared = renewing.clone();
                async move {
                    shared.renew().await;
                }
            }));

        let heard = Arc::downgrade(&shared);
        *locked(&shared.storage_changes) = shared.storage.subscribe(Arc::new(move |key, value| {
            if let Some(shared) = heard.upgrade() {
                shared.written_elsewhere(key, value);
            }
        }));

        let starting = shared.clone();
        shared.tasks.spawn(async move {
            starting.validate(stored).await;
            starting.ready.set(true);
        });
        SemiontSession { shared }
    }

    /// Which live session this is: a new one for the same knowledge base has
    /// another. What is derived from a session is kept by this, so it is not
    /// kept past the session it was derived from.
    pub fn id(&self) -> &str {
        &self.shared.id
    }

    pub fn kb(&self) -> &KbTarget {
        &self.shared.kb
    }

    pub fn client(&self) -> &Arc<SemiontClient> {
        &self.shared.client
    }

    /// The token the transport sends: the current one, and each after it.
    pub fn token(&self) -> watch::Receiver<Option<String>> {
        self.shared.token.read()
    }

    /// Who is signed in, once the gateway has said; none for a service.
    pub fn user(&self) -> watch::Receiver<Option<UserResponse>> {
        self.shared.user.read()
    }

    /// The state of the client's connection.
    pub fn stream_state(&self) -> watch::Receiver<ConnectionState> {
        self.shared.client.state()
    }

    /// The failures the client's transport meets, from now on. A host routes
    /// them: a refusal for want of a valid token is a reason to `refresh`.
    pub fn errors(&self) -> Failures {
        self.shared.client.transport().failures()
    }

    /// Resolves when the session has done what it does at its start: renewed
    /// a stored token that had expired, and asked who the token is. It
    /// resolves whatever that came to.
    pub async fn ready(&self) {
        let mut ready = self.shared.ready.read();
        // An ended session is as ready as it will be.
        let _ = ready.wait_for(|ready| *ready).await;
    }

    /// When the token the session holds expires.
    pub fn expires_at(&self) -> Option<SystemTime> {
        token_expiry(&self.shared.token.now()?)
    }

    /// The gateway refused the session's token: renew it, and ask the
    /// gateway who the new one is. The token the session then holds, or
    /// none: it holds no token, and if it had a stored credential it is
    /// over. See `SessionRenewer`, through which a transport asks.
    pub async fn refresh(&self) -> Option<String> {
        self.shared.refused().await
    }

    /// A handle that renews this session's token, for the transport under
    /// the session's client: a transport is built before the session that
    /// holds it, and asks through this when the gateway refuses a token.
    pub fn renewer(&self) -> SessionRenewer {
        SessionRenewer {
            shared: Arc::downgrade(&self.shared),
        }
    }

    /// End the session and close its client. Closing twice is closing once.
    pub async fn close(&self) {
        if self.shared.end() {
            self.shared.client.close().await;
        }
    }
}

/// See `SemiontSession::renewer`. It does not keep the session alive: one
/// that has ended renews nothing.
#[derive(Clone)]
pub struct SessionRenewer {
    shared: Weak<Shared>,
}

impl SessionRenewer {
    /// As `SemiontSession::refresh`.
    pub async fn refresh(&self) -> Option<String> {
        match self.shared.upgrade() {
            Some(shared) => shared.refused().await,
            None => None,
        }
    }
}

impl Drop for SemiontSession {
    fn drop(&mut self) {
        self.shared.end();
    }
}

impl Shared {
    fn closed(&self) -> bool {
        self.closed.load(Ordering::SeqCst)
    }

    /// Stop everything the session runs and end what it holds. Whether this
    /// call was the one that ended it.
    fn end(&self) -> bool {
        if self.closed.swap(true, Ordering::SeqCst) {
            return false;
        }
        self.tasks.stop();
        *locked(&self.storage_changes) = None;
        self.token.end();
        self.user.end();
        self.ready.end();
        true
    }

    /// Ask `refresh`, with a failure to ask read as there being no token:
    /// a renewal that could not be made and one that was refused both leave
    /// the session without one. The reason is kept for whoever reads why.
    async fn try_refresh(&self) -> (Option<String>, Option<String>) {
        match &self.refresh {
            None => (None, None),
            Some(refresh) => match refresh().await {
                Ok(token) => (token, None),
                Err(failure) => (None, Some(failure)),
            },
        }
    }

    /// Renew the token at the issuer, with nobody asked afterwards: what
    /// the session does on its own schedule, where no refusal came first.
    async fn renew(&self) -> Option<String> {
        if self.closed() || self.refresh.is_none() {
            return None;
        }
        let (renewed, failure) = self.try_refresh().await;
        if self.closed() {
            return None;
        }
        if let Some(token) = renewed {
            self.token.set(Some(token.clone()));
            return Some(token);
        }
        self.token.set(None);
        // A session that never had a credential cannot expire: it is signed
        // out, which is no failure. Ending the session below also clears the
        // credential, so the refusals that follow it are quiet too.
        stored_session(self.storage.as_ref(), &self.kb.id)?;
        self.signed_out(
            SessionEndReason::Expired,
            SessionErrorCode::RefreshExhausted,
            not_renewed(failure),
        );
        None
    }

    /// The gateway refused the session's token: renew it, and ask the
    /// gateway who the new one is. The rule is the start's
    /// (specs/src/session/cases.json, `refusal`): a token the issuer has
    /// just issued and the gateway refuses is final, and the session ends as
    /// `CredentialRefused`. So one refusal costs at most one renewal and one
    /// ask, and a gateway that refuses whatever its issuer issues is not
    /// asked again for every request that follows. A gateway that cannot be
    /// asked refuses nothing: the renewed token is given. A session of a
    /// service, which has nobody to ask about, only renews.
    ///
    /// One refusal is answered at a time, so however many requests were
    /// refused at once, they cost one renewal and one ask.
    async fn refused(&self) -> Option<String> {
        // Refusals that arrive together are answered together: the first
        // renews and asks, and the rest find that the session's token is no
        // longer the one they were refused with.
        let refused_with = self.token.now();
        let _answering = self.answering.lock().await;
        if self.token.now() != refused_with {
            return self.token.now();
        }
        let renewed = self.renew().await?;
        let Some(validate) = &self.validate else {
            return Some(renewed);
        };
        // While the session is starting, its start is what asks: it finds
        // the token renewed here and takes it up as the just-issued one.
        // Asking here too would be a second ask about one renewal.
        if !self.ready.now() {
            return Some(renewed);
        }
        let answer = validate(renewed.clone()).await;
        if self.closed() {
            return None;
        }
        if let Err(SemiontError::Transport(refusal)) = &answer
            && refusal.code == TransportErrorCode::Unauthorized
            // Only a token the session still holds ends it: one replaced
            // while the gateway was being asked (another context signed in,
            // or renewed) is no longer the session's to be refused.
            && self.token.now().as_deref() == Some(renewed.as_str())
        {
            self.signed_out(
                SessionEndReason::Refused,
                SessionErrorCode::CredentialRefused,
                "The gateway refused a token its issuer had just issued".to_owned(),
            );
        }
        self.token.now()
    }

    /// The session is over: its credential is forgotten, and the person and
    /// the application are each told why. The one teardown, whichever way
    /// the session ended.
    fn signed_out(&self, told: SessionEndReason, code: SessionErrorCode, why: String) {
        self.token.set(None);
        clear_stored_session(self.storage.as_ref(), &self.kb.id);
        if let Some(on_auth_failed) = &self.on_auth_failed {
            on_auth_failed(told);
        }
        self.failed(code, why);
    }

    fn failed(&self, code: SessionErrorCode, message: String) {
        if let Some(on_error) = &self.on_error {
            on_error(SessionError::new(code, message, &self.kb.id));
        }
    }

    /// What a session does at its start, with the credential it found
    /// stored: renew it if it has expired, then ask the gateway who it is.
    /// A token the gateway refuses is renewed once and asked about once
    /// more. A token the issuer has just issued and the gateway refuses is
    /// final: renewing again cannot change the answer, and asking for as
    /// long as the issuer goes on issuing is a loop with no end. So the
    /// gateway is asked at most twice and the issuer at most once
    /// (specs/src/session/cases.json, `startup`).
    async fn validate(&self, stored: Option<StoredSession>) {
        let Some(stored) = stored else { return };
        let expired = is_token_expired(&stored.access, SystemTime::now());
        let mut token = if expired {
            match self.try_refresh().await.0 {
                Some(renewed) => renewed,
                None => {
                    clear_stored_session(self.storage.as_ref(), &self.kb.id);
                    return;
                }
            }
        } else {
            stored.access.clone()
        };
        if token != stored.access {
            self.token.set(Some(token.clone()));
        }
        let Some(validate) = &self.validate else {
            return;
        };
        let mut just_issued = expired;
        loop {
            if self.closed() {
                return;
            }
            let answer = validate(token.clone()).await;
            if self.closed() {
                return;
            }
            match answer {
                Ok(user) => {
                    self.user.set(Some(user));
                    return;
                }
                Err(SemiontError::Transport(refusal))
                    if refusal.code == TransportErrorCode::Unauthorized =>
                {
                    if just_issued {
                        self.signed_out(
                            SessionEndReason::Refused,
                            SessionErrorCode::CredentialRefused,
                            "The gateway refused a token its issuer had just issued".to_owned(),
                        );
                        return;
                    }
                    // The session's token is no longer the one asked about:
                    // the stream was refused with it too, and `refused` has
                    // renewed it meanwhile. That token is the just-issued
                    // one, and is not renewed again.
                    let current = self.token.now();
                    if current.as_deref() != Some(token.as_str()) {
                        let Some(current) = current else { return };
                        token = current;
                        just_issued = true;
                        continue;
                    }
                    let (renewed, failure) = self.try_refresh().await;
                    if self.closed() {
                        return;
                    }
                    match renewed {
                        Some(renewed) => {
                            self.token.set(Some(renewed.clone()));
                            token = renewed;
                            just_issued = true;
                        }
                        None => {
                            self.signed_out(
                                SessionEndReason::Expired,
                                SessionErrorCode::RefreshExhausted,
                                not_renewed(failure),
                            );
                            return;
                        }
                    }
                }
                Err(other) => {
                    self.failed(SessionErrorCode::AuthFailed, other.to_string());
                    return;
                }
            }
        }
    }

    /// Another context wrote this knowledge base's session: it renewed the
    /// token, or signed out.
    fn written_elsewhere(&self, key: &str, value: Option<&str>) {
        if self.closed() || key != session_key(&self.kb.id) {
            return;
        }
        match value {
            None => {
                self.token.set(None);
                self.user.set(None);
            }
            Some(written) => {
                // What is not a session is nobody's news.
                if let Some(session) = StoredSession::read(written) {
                    self.token.set(Some(session.access));
                }
            }
        }
    }
}
