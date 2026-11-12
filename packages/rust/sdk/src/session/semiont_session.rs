//! A session with one knowledge base: its client, the token the client's
//! transport sends, and who is signed in.
//!
//! Headless: it runs in an application, a script, a daemon and a test alike,
//! and shows nobody anything. What it needs of its environment it is given:
//!
//! - `refresh` renews the token: after it expires, and when the gateway
//!   refuses it. It is handed the token it renews: the one the session
//!   holds, expired or not; while it holds none, the one found stored at
//!   its start, though it has expired, or the one a renewal that got no
//!   answer was for. It is handed none only by a session that has held
//!   none. It answers the new token, nothing when there is nothing to renew
//!   with, or why it failed.
//! - `validate` asks the gateway who a token is: when the session starts,
//!   and of a token renewed because the gateway refused the one before. A
//!   session of a service has none: there is nobody to ask about.
//! - `on_auth_failed` is told when the session is over, and why: its issuer
//!   refused to renew it (`Expired`), or the gateway refused a token the
//!   issuer had just issued (`Refused`). What a person reads of it is the host's.
//!
//! What a session says, it says once, on its errors stream (`errors`),
//! beside the failures its client's transport meets, in the order they were
//! met: each failure that makes it unusable, and what goes wrong with what
//! its client keeps (a sign-in that cannot be read before a save, or cannot
//! record the person the gateway named, `session.keep-failed`; a write the
//! storage refuses, `session.save-refused`). Of what it says before anyone
//! reads its errors, the latest `ERRORS_KEPT_FOR_FIRST_READER_COUNT` are kept
//! for the first reader. The stream ends when the session ends, and what was
//! kept for a first reader who has not come by then is let go of.
//!
//! A session is built from where its sign-in is kept (`SignInKept`). A
//! session whose issuer refuses to renew it, or whose gateway refuses a
//! token its issuer has just issued, clears its token and forgets its kept
//! sign-in, so a dead credential is never used again. Forgetting a sign-in
//! a registry keeps deletes what was kept for the person it named
//! (protocol/specs/src/session/persisted-cases.json, `forget`), once the
//! session's client has stopped writing it, a write under way included. One that
//! never had a credential is only signed out: there is nothing to end, and
//! nothing is said. Whenever a token is renewed, what is kept is
//! forgotten only when the issuer refuses: a renewal that got no answer
//! leaves the session no usable token and keeps what is kept, and the
//! next refusal renews again, and so does the session on its own, on the
//! reconnect backoff.
//!
//! The token is renewed before it expires, by the schedule every Semiont
//! client keeps (`super::refresh_delay`).
//!
//! A session is a state unit: it writes its token, its user and its errors,
//! so `dispose` ends them, and stops its renewal. A renewal under way runs
//! to its end, so what it brings is kept where the sign-in is kept (an
//! issuer that rotates refresh tokens has spent the old one by then), and a
//! close waits for it (`OpenedSession::close`); each refusal waiting on it
//! is given no token, and the session does not take the token it brings.
//! It only uses its client, so it never closes it: whoever built the client
//! and the session closes the client, which makes the saves its caches owe,
//! and then ends the session, so what those saves meet is said before its
//! errors end. A session that is only dropped ends the same things. A
//! session is built inside a Tokio runtime, and owns its client from then
//! on (`SemiontClient::record_person_key`).

use super::kept::SignInKept;
use super::signals::SessionEndReason;
use super::stored::{StoredSession, is_token_expired};
use super::{renew_when_due, token_expiry};
use crate::client::{Owner, SemiontClient};
use crate::errors::{
    SemiontError, SessionError, SessionErrorCode, SignInError, SignInErrorCode, TransportErrorCode,
};
use crate::kept_for_first_reader::KeptForFirstReader;
use crate::locked;
use crate::retry::{REFRESH, RetryFacts, equal_jitter};
use crate::state::{Held, Tasks};
use crate::state_unit::StateUnit;
use crate::timing::{MAX_RECONNECT, RECONNECT};
use crate::transport::{BoxFuture, ConnectionState, Events};
use crate::types::{KbTarget, UserResponse};
use rand_core::Rng;
use std::sync::{Arc, Mutex, Weak};
use std::time::SystemTime;
use tokio::sync::{oneshot, watch};
use tokio::task::JoinHandle;

/// Renew the token it is handed, the one the session renews (see the
/// module's documentation; none only when the session has held none): the
/// new one, `None` when there is nothing to renew with, or why the renewal
/// failed: a `SignInError` of the issuer's answer, or of its absence, or the
/// failure of whatever else the renewal needed.
pub type Refresh = Arc<
    dyn Fn(
            Option<String>,
        )
            -> BoxFuture<'static, Result<Option<String>, Arc<dyn std::error::Error + Send + Sync>>>
        + Send
        + Sync,
>;

/// Ask the gateway who `token` is.
pub type Validate =
    Arc<dyn Fn(String) -> BoxFuture<'static, Result<UserResponse, SemiontError>> + Send + Sync>;

/// Told that the session is over, and why.
pub type OnAuthFailed = Arc<dyn Fn(SessionEndReason) + Send + Sync>;

/// Why a renewal gave no token, for whoever reads the error.
fn not_renewed(failure: Option<&(dyn std::error::Error + Send + Sync)>) -> String {
    match failure {
        Some(failure) => format!("Token refresh failed: {failure}"),
        None => "Token refresh failed".to_owned(),
    }
}

/// Whether a renewal failed because the issuer refused it: an answer the
/// `refresh` rule does not try again. No answer, and one it tries again
/// until the budget is spent, is no refusal.
fn refused(failure: &(dyn std::error::Error + Send + Sync + 'static)) -> bool {
    failure
        .downcast_ref::<SignInError>()
        .is_some_and(|failure| {
            failure.code == SignInErrorCode::Exchange
                && failure.status.is_some()
                && !REFRESH.retryable(&RetryFacts {
                    status: failure.status,
                    method: Some("POST"),
                    keyed: false,
                })
        })
}

/// Why a session failed, and why its credential could not be forgotten.
fn not_forgotten(why: String, forgotten: &(dyn std::error::Error + Send + Sync)) -> String {
    format!("{why}; and the sign-in could not be forgotten: {forgotten}")
}

pub struct SemiontSessionConfig {
    pub kb: KbTarget,
    /// Where the session's sign-in is kept: what it starts from and forgets.
    pub kept: Arc<dyn SignInKept>,
    /// The client, already built over its transport.
    pub client: Arc<SemiontClient>,
    /// The token the client's transport sends: the transport holds a
    /// receiver of this sender, and the session writes each renewed token
    /// into it.
    pub token: watch::Sender<Option<String>>,
    pub refresh: Option<Refresh>,
    pub validate: Option<Validate>,
    pub on_auth_failed: Option<OnAuthFailed>,
    /// What the renewal retry's jitter is drawn from; the system's source
    /// when none is given.
    pub random: Option<Arc<Mutex<dyn Rng + Send>>>,
}

struct Shared {
    id: String,
    kb: KbTarget,
    client: Arc<SemiontClient>,
    kept: Arc<dyn SignInKept>,
    token: Held<Option<String>>,
    user: Held<Option<UserResponse>>,
    ready: Held<bool>,
    /// Holds while a renewal that got no answer is owed another attempt.
    unanswered: Held<bool>,
    /// The token the last renewal was handed: what the next is handed while
    /// the session holds none (`Shared::renewing`).
    renewed_for: Mutex<Option<String>>,
    refresh: Option<Refresh>,
    validate: Option<Validate>,
    on_auth_failed: Option<OnAuthFailed>,
    /// What the session says on its errors stream.
    errors: Arc<KeptForFirstReader<SemiontError>>,
    random: Option<Arc<Mutex<dyn Rng + Send>>>,
    tasks: Tasks,
    /// Whether the session has ended, which whoever waits on a renewal
    /// waits on too.
    closed: watch::Sender<bool>,
    /// Each renewal begun, which a task of its own drives to its end
    /// whoever waits on it: a close waits for those its end let finish
    /// (`SemiontSession::renewals_finished`).
    renewals: Mutex<Vec<JoinHandle<()>>>,
    /// Held while a refusal is being answered, and while a token whose wait
    /// ran out is renewed: the refusals that arrive during either are
    /// answered by it, and a wait that runs out during either finds the token
    /// it was for replaced.
    answering: tokio::sync::Mutex<()>,
}

/// See the module's documentation.
pub struct SemiontSession {
    shared: Arc<Shared>,
}

impl SemiontSession {
    pub fn new(config: SemiontSessionConfig) -> SemiontSession {
        let errors = Arc::new(KeptForFirstReader::new());
        // Each failure the transport meets is said within the transport's
        // telling of it, so before whatever the session says next.
        let relaying = Arc::downgrade(&errors);
        config
            .client
            .transport()
            .tell_failures_to(Box::new(move |failure| {
                if let Some(errors) = relaying.upgrade() {
                    errors.say(SemiontError::Transport(failure.clone()));
                }
            }));
        let saying = Arc::downgrade(&errors);
        let kb_id = config.kb.id.clone();
        // Before anything runs: what goes wrong with what the client keeps
        // is the session's to say from the first save on.
        config.client.owned_by(Owner {
            kept: config.kept.clone(),
            says: Arc::new(move |code, message| {
                if let Some(errors) = saying.upgrade() {
                    errors.say(SemiontError::Session(SessionError::new(
                        code, message, &kb_id,
                    )));
                }
            }),
        });
        let shared = Arc::new(Shared {
            id: format!("session-{}", uuid::Uuid::new_v4()),
            kb: config.kb,
            client: config.client,
            kept: config.kept,
            token: Held::of(config.token),
            user: Held::new(None),
            ready: Held::new(false),
            unanswered: Held::new(false),
            renewed_for: Mutex::new(None),
            refresh: config.refresh,
            validate: config.validate,
            on_auth_failed: config.on_auth_failed,
            errors,
            random: config.random,
            tasks: Tasks::new(),
            closed: watch::channel(false).0,
            renewals: Mutex::default(),
            answering: tokio::sync::Mutex::new(()),
        });

        let renewing = shared.clone();
        shared
            .tasks
            .spawn(renew_when_due(shared.token.read(), move |due| {
                let shared = renewing.clone();
                async move {
                    shared.fell_due(due).await;
                }
            }));

        let retrying = shared.clone();
        shared
            .tasks
            .spawn(async move { retrying.renew_when_unanswered().await });

        let starting = shared.clone();
        shared.tasks.spawn(async move {
            starting.start().await;
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

    /// What the session says, each once: what it says of its own (a
    /// `SessionError`), and the failures its client's transport meets, in
    /// the order they were met. The first reader is given the latest
    /// `ERRORS_KEPT_FOR_FIRST_READER_COUNT` said since the session was made,
    /// the oldest dropped beyond that; each later one, what is said from then
    /// on. It ends when the session ends: a failure met before then is said
    /// before it ends, and one met after is said nowhere. A reader who comes
    /// after the end, the first among them, is given nothing. A refusal for want
    /// of a valid token among the transport's failures is the transport's
    /// to renew, not its reader's. A registry is the one reader of the
    /// errors of each session it holds (`super::SemiontBrowser`).
    pub fn errors(&self) -> Events<SemiontError> {
        self.shared.errors.read()
    }

    /// Resolves when the session has done what it does at its start: read
    /// its kept sign-in, renewed a token that had expired, and asked who the
    /// token is. It resolves whatever that came to.
    pub async fn ready(&self) {
        let mut ready = self.shared.ready.read();
        // An ended session is as ready as it will be.
        let _ = ready.wait_for(|ready| *ready).await;
    }

    /// When the token the session holds expires.
    pub fn expires_at(&self) -> Option<SystemTime> {
        token_expiry(&self.shared.token.now()?)
    }

    /// The gateway refused `refused`, the token a request carried (`None`
    /// when it carried none): renew it, and ask the gateway who the new one
    /// is. The token the session then holds, or none: it holds no token, and
    /// if the issuer refused to renew a kept credential it is over. A token
    /// the session no longer holds was answered already, however late the
    /// refusal arrives: the token it holds is given, and nothing is renewed
    /// or asked. Once the session has ended, a refusal is given none,
    /// whatever token it names, and the issuer is not asked; one waiting on
    /// a renewal as the session ends is given none at once. See
    /// `SessionRenewer`, through which a transport asks.
    pub async fn refresh(&self, refused: Option<&str>) -> Option<String> {
        self.shared.refused(refused).await
    }

    /// Resolves once each renewal the session's end let finish has ended,
    /// and kept what it brought where the sign-in is kept: whoever closes the
    /// session waits for this once it has ended it.
    pub(crate) async fn renewals_finished(&self) {
        let begun = std::mem::take(&mut *locked(&self.shared.renewals));
        for renewal in begun {
            // A renewal that panicked has finished too: its panic is not the
            // close's to give.
            let _ = renewal.await;
        }
    }

    /// A handle that renews this session's token, for the transport under
    /// the session's client: a transport is built before the session that
    /// holds it, and asks through this when the gateway refuses a token.
    pub fn renewer(&self) -> SessionRenewer {
        SessionRenewer {
            shared: Arc::downgrade(&self.shared),
        }
    }
}

impl StateUnit for SemiontSession {
    /// End the session: it renews nothing more, and its token, its user,
    /// its readiness and its errors end. A renewal under way finishes, and
    /// keeps what it brings where the sign-in is kept, but whoever waits on
    /// it is given no token, and the session does not take it. Its client is
    /// left to whoever built it. Ending twice is ending once.
    fn dispose(&self) {
        self.shared.end();
    }
}

/// A session and the client it was built with, which whoever holds this
/// ends together: what a script's sign-in gives. The session only uses its
/// client, so ending the session alone would leave the client open.
pub struct OpenedSession {
    session: SemiontSession,
}

impl OpenedSession {
    /// The session, over the client it was built with.
    pub fn new(session: SemiontSession) -> OpenedSession {
        OpenedSession { session }
    }

    pub fn session(&self) -> &SemiontSession {
        &self.session
    }

    /// Close the client, which makes the saves its caches owe, and then end
    /// the session: what those saves meet is said before the session's
    /// errors end. A renewal under way finishes before this returns, so
    /// what it brings is kept where the sign-in is kept by then. Closing
    /// twice is closing once.
    pub async fn close(&self) {
        self.session.client().close().await;
        self.session.dispose();
        self.session.renewals_finished().await;
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
    pub async fn refresh(&self, refused: Option<&str>) -> Option<String> {
        match self.shared.upgrade() {
            Some(shared) => shared.refused(refused).await,
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
        *self.closed.borrow()
    }

    /// Stop everything the session runs and end what it holds.
    fn end(&self) {
        if self.closed.send_replace(true) {
            return;
        }
        self.tasks.stop();
        self.token.end();
        self.user.end();
        self.ready.end();
        self.unanswered.end();
        self.errors.end();
    }

    /// The token a renewal of `holding` is handed, which is remembered:
    /// `holding`, the token the session was found holding, expired or not;
    /// while it holds none, the one found stored at its start, or the one the
    /// renewal that left it none was for. None only when it has held none
    /// (protocol/specs/src/session/cases.json). The token is not read again
    /// here: one another renewal wrote since `holding` was read is not this
    /// renewal's to renew.
    fn renewing(&self, holding: Option<String>) -> Option<String> {
        let mut renewed_for = locked(&self.renewed_for);
        if holding.is_some() {
            *renewed_for = holding;
        }
        renewed_for.clone()
    }

    /// Ask `refresh` to renew `holding`, the token the session was found
    /// holding, with a failure to ask read as there being no token: a
    /// renewal that could not be made and one that was refused both leave
    /// the session without one. The reason is kept for whoever reads why.
    /// A task of its own drives the renewal to its end, so a caller that
    /// stops waiting does not stop it. `None` once the session has ended,
    /// and when it ends first: the renewal finishes, and what it brings is
    /// kept where the sign-in is kept, but its token is not taken and
    /// nothing is decided of it.
    async fn try_refresh(
        &self,
        holding: Option<String>,
    ) -> Option<(
        Option<String>,
        Option<Arc<dyn std::error::Error + Send + Sync>>,
    )> {
        let Some(refresh) = &self.refresh else {
            return Some((None, None));
        };
        let (answered, answer) = oneshot::channel();
        {
            let mut renewals = locked(&self.renewals);
            // Decided with the renewals held, so every renewal begun is one
            // a close waits for.
            if self.closed() {
                return None;
            }
            renewals.retain(|begun| !begun.is_finished());
            let renewal = refresh(self.renewing(holding));
            renewals.push(tokio::spawn(async move {
                // Whoever waited may have stopped: the renewal goes on to
                // its end all the same.
                let _ = answered.send(renewal.await);
            }));
        }
        let mut ended = self.closed.subscribe();
        tokio::select! {
            biased;
            _ = ended.wait_for(|closed| *closed) => None,
            given = answer => match given {
                Ok(Ok(token)) => Some((token, None)),
                Ok(Err(failure)) => Some((None, Some(failure))),
                // Its task ends without answering only by panicking.
                Err(unanswered) => panic!("a renewal panicked: {unanswered}"),
            },
        }
    }

    /// The wait for `due` ran out: renew it on the session's schedule, while
    /// it is still the token the session holds. A token renewed some other
    /// way meanwhile has a wait of its own, and this renews nothing. A
    /// refusal being answered as the wait runs out is waited for, so the
    /// token it renews is renewed once.
    async fn fell_due(&self, due: String) {
        let _answering = self.answering.lock().await;
        if self.token.now().as_deref() == Some(due.as_str()) {
            self.renew(Some(due)).await;
        }
    }

    /// Renew `holding`, the token the session was found holding, at the
    /// issuer, with nobody asked afterwards: what the session does on its
    /// own schedule, where no refusal came first.
    async fn renew(&self, holding: Option<String>) -> Option<String> {
        self.refresh.as_ref()?;
        let (renewed, failure) = self.try_refresh(holding).await?;
        if let Some(token) = renewed {
            self.unanswered.set(false);
            self.token.set(Some(token.clone()));
            return Some(token);
        }
        self.token.set(None);
        // A session that never had a credential cannot expire: it is signed
        // out, which is no failure. Ending the session below also forgets the
        // credential, so the refusals that follow it are quiet too. A
        // sign-in that cannot be read is not known to have ended: the
        // renewal got no answer, and is tried again on the backoff.
        match self.kept.held().await {
            Ok(Some(_)) => self.unrenewed(failure).await,
            Ok(None) => self.unanswered.set(false),
            Err(unread) => {
                self.unanswered.set(true);
                self.failed(
                    SessionErrorCode::RefreshExhausted,
                    format!(
                        "{}; and the sign-in could not be read: {unread}",
                        not_renewed(failure.as_deref())
                    ),
                );
            }
        }
        None
    }

    /// After a renewal that got no answer, renew again on the reconnect
    /// backoff: each wait is the equal jitter of its step, the step
    /// `RECONNECT` doubling to `MAX_RECONNECT`. It stops when a renewal is
    /// made or refused, when a token arrives some other way, and when the
    /// session ends. A renewal made while nobody has said who the session's
    /// token is asks the gateway once, as the start would have.
    async fn renew_when_unanswered(&self) {
        let mut owed = self.unanswered.read();
        loop {
            if owed.wait_for(|owed| *owed).await.is_err() {
                return;
            }
            let mut step = RECONNECT;
            while self.unanswered.now() {
                tokio::time::sleep(equal_jitter(step, self.random.as_deref())).await;
                if self.token.now().is_some() {
                    self.unanswered.set(false);
                } else if self.unanswered.now() {
                    if self.user.now().is_none() {
                        self.refused(None).await;
                    } else {
                        self.renew(None).await;
                    }
                }
                step = (step * 2).min(MAX_RECONNECT);
            }
        }
    }

    /// A renewal of what is kept gave no token, and the session holds none.
    /// The issuer's refusal, or nothing left to renew with, ends the
    /// session; any other failure keeps what is kept, and says why: the
    /// next refusal renews again, and so does the reconnect backoff.
    async fn unrenewed(&self, failure: Option<Arc<dyn std::error::Error + Send + Sync>>) {
        self.token.set(None);
        let why = not_renewed(failure.as_deref());
        match failure {
            Some(failure) if !refused(failure.as_ref()) => {
                self.unanswered.set(true);
                self.failed(SessionErrorCode::RefreshExhausted, why);
            }
            _ => {
                self.signed_out(
                    SessionEndReason::Expired,
                    SessionErrorCode::RefreshExhausted,
                    why,
                )
                .await
            }
        }
    }

    /// The gateway refused the session's token: renew it, and ask the
    /// gateway who the new one is. The rule is the start's
    /// (protocol/specs/src/session/cases.json, `refusal`): a token the issuer has
    /// just issued and the gateway refuses is final, and the session ends as
    /// `CredentialRefused`. So one refusal costs at most one renewal and one
    /// ask, and a gateway that refuses whatever its issuer issues is not
    /// asked again for every request that follows. Who the gateway says the
    /// renewed token is, is who is signed in. A gateway that cannot be asked
    /// refuses nothing: the renewed token is given. A session of a service,
    /// which has nobody to ask about, only renews.
    ///
    /// One refusal is answered at a time, and none while a token whose wait
    /// ran out is renewed, so however many requests were refused at once,
    /// they cost one renewal and one ask. Once the session has ended, a
    /// refusal is given no token, whatever token it names. A refusal of a
    /// token the session no longer holds was answered already: the token it
    /// holds is given. The renewal is handed the token checked here, never
    /// one read later.
    async fn refused(&self, refused: Option<&str>) -> Option<String> {
        let _answering = self.answering.lock().await;
        if self.closed() {
            return None;
        }
        let held = self.token.now();
        if held.as_deref() != refused {
            return held;
        }
        let renewed = self.renew(held).await?;
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
        // Only a token the session still holds is its to be refused, or to say
        // who it is: one replaced while the gateway was being asked (renewed
        // on its schedule meanwhile) is not.
        if self.token.now().as_deref() == Some(renewed.as_str()) {
            match answer {
                Ok(user) => self.user.set(Some(user)),
                Err(SemiontError::Transport(refusal))
                    if refusal.code == TransportErrorCode::Unauthorized =>
                {
                    self.signed_out(
                        SessionEndReason::Refused,
                        SessionErrorCode::CredentialRefused,
                        "The gateway refused a token its issuer had just issued".to_owned(),
                    )
                    .await;
                }
                Err(_) => {}
            }
        }
        self.token.now()
    }

    /// The session is over: its credential is forgotten, and the person and
    /// the application are each told why. The one teardown, whichever way
    /// the session ended.
    async fn signed_out(&self, told: SessionEndReason, code: SessionErrorCode, why: String) {
        self.unanswered.set(false);
        self.token.set(None);
        let why = match self.forget_sign_in().await {
            Ok(()) => why,
            Err(forgotten) => not_forgotten(why, forgotten.as_ref()),
        };
        if let Some(on_auth_failed) = &self.on_auth_failed {
            on_auth_failed(told);
        }
        self.failed(code, why);
    }

    /// Say `message`, under `code`, once, on the session's errors stream.
    fn failed(&self, code: SessionErrorCode, message: String) {
        self.errors.say(SemiontError::Session(SessionError::new(
            code,
            message,
            &self.kb.id,
        )));
    }

    /// Forget the session's kept sign-in, and with it what was kept for the
    /// person it named. Its client writes nothing more first: a save already
    /// past its check of the sign-in finishes before anything is deleted,
    /// and none is made after, so nothing deleted here is put back.
    async fn forget_sign_in(&self) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        self.client.stop_persisting().await;
        self.kept.forget().await
    }

    /// Read the kept sign-in: a token of it that is still good is what the
    /// transport sends first, unless it was given one already, and the
    /// token it holds, good or not, is what a renewal renews while the
    /// session holds none. Then what a session does at its start with it
    /// (`validate`). A sign-in that cannot be read says why, and the session
    /// starts with none. (Whoever opens a session from a kept sign-in reads
    /// it first, and is given its failure: `session_from_kept`.)
    async fn start(&self) {
        let held = match self.kept.held().await {
            Ok(held) => held,
            Err(unread) => {
                self.failed(
                    SessionErrorCode::AuthFailed,
                    format!("The sign-in could not be read: {unread}"),
                );
                return;
            }
        };
        if self.closed() {
            return;
        }
        if let Some(held) = &held {
            *locked(&self.renewed_for) = Some(held.access.clone());
            if !is_token_expired(&held.access, SystemTime::now()) && self.token.now().is_none() {
                self.token.set(Some(held.access.clone()));
            }
        }
        self.validate(held).await;
    }

    /// What a session does at its start, with the credential it found
    /// kept: renew it if it has expired, then ask the gateway who it is.
    /// A token the gateway refuses is renewed once and asked about once
    /// more. A token the issuer has just issued and the gateway refuses is
    /// final: renewing again cannot change the answer, and asking for as
    /// long as the issuer goes on issuing is a loop with no end. So the
    /// gateway is asked at most twice and the issuer at most once
    /// (protocol/specs/src/session/cases.json, `startup`).
    async fn validate(&self, held: Option<StoredSession>) {
        let Some(held) = held else { return };
        let expired = is_token_expired(&held.access, SystemTime::now());
        let mut token = if expired {
            let Some(answer) = self.try_refresh(Some(held.access.clone())).await else {
                return;
            };
            match answer {
                (Some(renewed), _) => renewed,
                (None, Some(failure)) if !refused(failure.as_ref()) => {
                    // The issuer did not refuse it: the credential is kept,
                    // and renewed on the reconnect backoff or when a request
                    // is refused.
                    self.unanswered.set(true);
                    self.failed(
                        SessionErrorCode::AuthFailed,
                        not_renewed(Some(failure.as_ref())),
                    );
                    return;
                }
                (None, failure) => {
                    // There was no session to end: the credential is
                    // forgotten, and nothing is said unless it could not be.
                    if let Err(forgotten) = self.forget_sign_in().await {
                        self.failed(
                            SessionErrorCode::RefreshExhausted,
                            not_forgotten(not_renewed(failure.as_deref()), forgotten.as_ref()),
                        );
                    }
                    return;
                }
            }
        } else {
            held.access.clone()
        };
        if token != held.access {
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
                        )
                        .await;
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
                    let Some((renewed, failure)) = self.try_refresh(current).await else {
                        return;
                    };
                    match renewed {
                        Some(renewed) => {
                            self.token.set(Some(renewed.clone()));
                            token = renewed;
                            just_issued = true;
                        }
                        None => {
                            self.unrenewed(failure).await;
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
}

#[cfg(test)]
mod tests {
    //! A session's own errors and its transport's failures are one stream,
    //! in the order they were met. Every way to make a session say one of
    //! its own from outside waits on something, and a wait lets whatever
    //! else runs have its turn, so these say them themselves.

    use super::*;
    use crate::errors::TransportError;
    use crate::testing::{TestSession, TestSessionOptions, create_test_session};
    use crate::timing::ERRORS_KEPT_FOR_FIRST_READER_COUNT;

    /// Each kind in turn: the session's own, its transport's, its own, its
    /// transport's.
    fn each_kind_in_turn() -> Vec<SemiontError> {
        vec![
            SemiontError::Session(SessionError::new(
                SessionErrorCode::KeepFailed,
                "The sign-in could not be read",
                "test-kb",
            )),
            SemiontError::Transport(TransportError::of_status("HTTP 503", 503, None)),
            SemiontError::Session(SessionError::new(
                SessionErrorCode::SaveRefused,
                "The storage refused a write of what the client keeps",
                "test-kb",
            )),
            SemiontError::Transport(TransportError::of_status("HTTP 401", 401, None)),
        ]
    }

    /// Meet each of `met` in turn, with nothing else run between them: the
    /// session's own as the session says it, a failure as its transport
    /// reports it.
    fn meet(test: &TestSession, met: &[SemiontError]) {
        for error in met {
            match error {
                SemiontError::Session(own) => {
                    test.session.shared.failed(own.code, own.message.clone())
                }
                SemiontError::Transport(failure) => test.transport.fail(failure.clone()),
                other => panic!("{other:?} is neither a session's own nor its transport's"),
            }
        }
    }

    /// Everything `errors` says, to its end.
    async fn heard(mut errors: Events<SemiontError>) -> Vec<SemiontError> {
        let mut heard = Vec::new();
        while let Some(said) = errors.next().await {
            heard.push(said.expect("no error was missed"));
        }
        heard
    }

    #[tokio::test]
    async fn a_sessions_own_errors_and_its_transports_failures_are_said_in_the_order_met() {
        let test = create_test_session(TestSessionOptions::default());
        // Before anyone reads: all kept for the first reader.
        meet(&test, &each_kind_in_turn());
        // Whatever else the session runs has its turn before anyone reads.
        tokio::task::yield_now().await;
        let errors = test.session.errors();
        test.session.dispose();

        assert_eq!(heard(errors).await, each_kind_in_turn());
    }

    #[tokio::test]
    async fn a_session_nobody_has_read_keeps_the_latest_of_what_it_says_for_its_first_reader() {
        let test = create_test_session(TestSessionOptions::default());
        let beyond = 5;
        let met: Vec<SemiontError> = (0..ERRORS_KEPT_FOR_FIRST_READER_COUNT + beyond)
            .map(|n| match n % 2 {
                0 => SemiontError::Session(SessionError::new(
                    SessionErrorCode::KeepFailed,
                    format!("failure {n}"),
                    "test-kb",
                )),
                _ => SemiontError::Transport(TransportError::of_status(
                    format!("failure {n}"),
                    503,
                    None,
                )),
            })
            .collect();
        meet(&test, &met);
        // Whatever else the session runs has its turn before anyone reads.
        tokio::task::yield_now().await;
        let errors = test.session.errors();
        test.session.dispose();

        assert_eq!(heard(errors).await, met[beyond..].to_vec());
    }

    #[tokio::test]
    async fn a_reader_already_listening_hears_them_in_the_order_met_and_all_before_the_end() {
        let test = create_test_session(TestSessionOptions::default());
        let hearing = tokio::spawn(heard(test.session.errors()));
        // The reader is waiting.
        tokio::task::yield_now().await;
        meet(&test, &each_kind_in_turn());
        // Ended before anything else runs.
        test.session.dispose();

        assert_eq!(
            hearing.await.expect("the reader reads to the end"),
            each_kind_in_turn()
        );
    }

    #[tokio::test]
    async fn a_first_reader_who_comes_after_the_session_has_ended_hears_nothing() {
        let test = create_test_session(TestSessionOptions::default());
        meet(&test, &each_kind_in_turn());
        // Whatever else the session runs has its turn before it ends.
        tokio::task::yield_now().await;
        test.session.dispose();

        assert_eq!(
            heard(test.session.errors()).await,
            Vec::<SemiontError>::new()
        );
    }
}
