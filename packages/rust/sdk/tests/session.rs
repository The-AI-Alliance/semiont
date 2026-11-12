//! A session with a knowledge base: the token it holds, how it starts, how it
//! is renewed and how it ends; and what a host shows about one.
//!
//! The session's environment is scripted: what `refresh` answers each time
//! it is asked, and what the gateway says of a token. What the session says
//! is read from its errors stream.

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use futures_core::Stream;
use semiont::channels::BRIDGED_CHANNELS;
use semiont::client::SemiontClient;
use semiont::errors::{
    SemiontError, SessionError, SessionErrorCode, SignInError, SignInErrorCode, TransportError,
};
use semiont::session::{
    OpenedSession, SemiontSession, SemiontSessionConfig, SessionEndReason, SessionSignals,
    SignInKept, StoredSession, kept_in, store_session, stored_session,
};
use semiont::state_unit::StateUnit;
use semiont::testing::axioms::{
    AxiomSubject, Fresh, StreamSurface, Surface, assert_state_unit_axioms,
};
use semiont::testing::{
    FaultyTransport, SharedStorage, TestClientOptions, TestSessionOptions, create_test_client,
    create_test_session,
};
use semiont::timing::{MAX_RECONNECT, RECONNECT};
use semiont::transport::{BoxFuture, Events};
use semiont::types::{HttpEndpointProtocol, KbTarget, UserResponse};
use serde_json::{Value, json};
use std::collections::VecDeque;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll, Waker};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::sync::watch;

const KB: &str = "kb-alpha";

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("after the epoch")
        .as_secs()
}

/// A JWT carrying `claims`. Unsigned: nothing here verifies one.
fn jwt(claims: Value) -> String {
    format!(
        "{}.{}.sig",
        URL_SAFE_NO_PAD.encode(r#"{"alg":"none"}"#),
        URL_SAFE_NO_PAD.encode(claims.to_string())
    )
}

/// A token issued now that lives `lifetime` seconds, told from every other
/// by `n`.
fn token(lifetime: i64, n: u64) -> String {
    let issued = now();
    jwt(json!({ "iat": issued, "exp": issued as i64 + lifetime, "n": n }))
}

fn expired() -> String {
    let issued = now();
    jwt(json!({ "iat": issued - 600, "exp": issued - 300 }))
}

fn stored(access: &str) -> StoredSession {
    StoredSession {
        access: access.to_owned(),
        refresh: "a-refresh-token".to_owned(),
        client_id: "semiont-browser".to_owned(),
        token_endpoint: "https://issuer.test/token".to_owned(),
        revocation_endpoint: None,
        person_key: None,
    }
}

fn alice() -> UserResponse {
    serde_json::from_value(json!({
        "did": "did:web:example.org:users:alice", "email": "alice@example.org",
        "name": "Alice", "image": null, "domain": "example.org",
    }))
    .expect("a user")
}

/// Who the gateway says a token is when it accepts the `n`th ask of a case:
/// told apart from every other answer.
fn answering(n: usize) -> UserResponse {
    UserResponse {
        name: Some(format!("Alice {n}")),
        ..alice()
    }
}

fn unauthorized() -> SemiontError {
    TransportError::of_status("HTTP 401", 401, None).into()
}

fn refused_by_the_issuer() -> SignInError {
    SignInError::answered(
        SignInErrorCode::Exchange,
        "The issuer refused the token request (invalid_grant: Token is not active)",
        400,
    )
}

fn unanswered_by_the_issuer() -> SignInError {
    SignInError::new(
        SignInErrorCode::Exchange,
        "The issuer did not answer: the network is down",
    )
}

type Renewal = Result<Option<String>, SignInError>;
type Validation = Result<UserResponse, SemiontError>;

/// A session's environment, and a record of what the session did to it.
struct World {
    storage: Arc<SharedStorage>,
    transport: FaultyTransport,
    client: Arc<SemiontClient>,
    /// What `refresh` answers, in order; `Ok(None)` once it is spent.
    renewals: Arc<Mutex<VecDeque<Renewal>>>,
    renewed: Arc<Mutex<usize>>,
    /// When each renewal was asked for.
    renewed_at: Arc<Mutex<Vec<tokio::time::Instant>>>,
    /// The token each renewal was handed, in order.
    handed: Arc<Mutex<Vec<Option<String>>>>,
    /// What the gateway says of a token, in order; Alice once it is spent.
    validations: Arc<Mutex<VecDeque<Validation>>>,
    validated: Arc<Mutex<Vec<String>>>,
    /// Who the gateway last said a token is.
    answered: Arc<Mutex<Option<UserResponse>>>,
    auth_failed: Arc<Mutex<Vec<String>>>,
    /// The errors stream of each session made here, taken before the
    /// session starts.
    heard: Mutex<Vec<Events<SemiontError>>>,
    /// What the sessions said of their own on it so far, in order.
    said: Mutex<Vec<SessionError>>,
}

impl World {
    fn new() -> World {
        let storage = Arc::new(SharedStorage::new());
        let transport = FaultyTransport::new(BRIDGED_CHANNELS, vec![]);
        World {
            storage,
            client: create_test_client(TestClientOptions {
                transport: Some(transport.clone()),
                ..TestClientOptions::default()
            })
            .client,
            transport,
            renewals: Arc::default(),
            renewed: Arc::default(),
            renewed_at: Arc::default(),
            handed: Arc::default(),
            validations: Arc::default(),
            validated: Arc::default(),
            answered: Arc::default(),
            auth_failed: Arc::default(),
            heard: Mutex::default(),
            said: Mutex::default(),
        }
    }

    fn storing(self, access: &str) -> World {
        store_session(self.storage.as_ref(), KB, &stored(access)).expect("stored");
        self
    }

    fn renewing(self, renewals: impl IntoIterator<Item = Renewal>) -> World {
        self.renewals.lock().expect("renewals").extend(renewals);
        self
    }

    fn validating(self, validations: impl IntoIterator<Item = Validation>) -> World {
        self.validations
            .lock()
            .expect("validations")
            .extend(validations);
        self
    }

    fn config(&self) -> SemiontSessionConfig {
        let (renewals, renewed) = (self.renewals.clone(), self.renewed.clone());
        let (renewed_at, handed) = (self.renewed_at.clone(), self.handed.clone());
        let (validations, validated) = (self.validations.clone(), self.validated.clone());
        let answered = self.answered.clone();
        let auth_failed = self.auth_failed.clone();
        SemiontSessionConfig {
            kb: KbTarget::http(KB, "Alpha", "localhost", 4000, HttpEndpointProtocol::Http),
            kept: kept_in(self.storage.clone(), KB),
            client: self.client.clone(),
            token: watch::channel(None).0,
            refresh: Some(Arc::new(move |holding| {
                *renewed.lock().expect("renewed") += 1;
                handed.lock().expect("handed").push(holding);
                renewed_at
                    .lock()
                    .expect("renewed at")
                    .push(tokio::time::Instant::now());
                let answer = renewals
                    .lock()
                    .expect("renewals")
                    .pop_front()
                    .unwrap_or(Ok(None));
                Box::pin(async move {
                    answer.map_err(|failure| -> Arc<dyn std::error::Error + Send + Sync> {
                        Arc::new(failure)
                    })
                })
            })),
            validate: Some(Arc::new(move |token| {
                validated.lock().expect("validated").push(token);
                let answer = validations
                    .lock()
                    .expect("validations")
                    .pop_front()
                    .unwrap_or_else(|| Ok(alice()));
                if let Ok(user) = &answer {
                    *answered.lock().expect("answered") = Some(user.clone());
                }
                Box::pin(async move { answer })
            })),
            on_auth_failed: Some(Arc::new(move |reason: SessionEndReason| {
                auth_failed
                    .lock()
                    .expect("auth failed")
                    .push(reason.as_str().to_owned());
            })),
            random: None,
        }
    }

    /// A session over `config`, whose errors stream is read from before it
    /// starts: the session's start runs once the test first waits.
    fn session_of(&self, config: SemiontSessionConfig) -> SemiontSession {
        let session = SemiontSession::new(config);
        self.heard.lock().expect("heard").push(session.errors());
        session
    }

    fn session(&self) -> SemiontSession {
        self.session_of(self.config())
    }

    fn renewed(&self) -> usize {
        *self.renewed.lock().expect("renewed")
    }

    /// Every renewal so far was handed `renewing`, the token it renews
    /// (protocol/specs/src/session/cases.json): a renewal handed any other
    /// fails the test.
    fn each_renewal_was_handed(&self, renewing: Option<&str>, why: &str) {
        for (n, handed) in self.handed.lock().expect("handed").iter().enumerate() {
            assert_eq!(
                handed.as_deref(),
                renewing,
                "{why}: what renewal {n} was handed"
            );
        }
    }

    fn validated(&self) -> Vec<String> {
        self.validated.lock().expect("validated").clone()
    }

    fn answered(&self) -> Option<UserResponse> {
        self.answered.lock().expect("answered").clone()
    }

    fn auth_failed(&self) -> Vec<String> {
        self.auth_failed.lock().expect("auth failed").clone()
    }

    /// What the sessions made here have said of their own on their errors
    /// streams so far, in order: the transport's failures the streams carry
    /// beside them are not these tests'. A stream that missed any of it
    /// fails the test.
    fn errors(&self) -> Vec<(SessionErrorCode, String)> {
        let mut said = self.said.lock().expect("said");
        for errors in self.heard.lock().expect("heard").iter_mut() {
            while let Poll::Ready(Some(item)) =
                Pin::new(&mut *errors).poll_next(&mut Context::from_waker(Waker::noop()))
            {
                match item {
                    Ok(SemiontError::Session(error)) => said.push(error),
                    Ok(_) => {}
                    Err(missed) => panic!("a session's errors stream missed some: {missed}"),
                }
            }
        }
        said.iter()
            .map(|error| (error.code, error.message.clone()))
            .collect()
    }

    fn codes(&self) -> Vec<SessionErrorCode> {
        self.errors().into_iter().map(|(code, _)| code).collect()
    }

    fn has_stored(&self) -> bool {
        stored_session(self.storage.as_ref(), KB).is_some()
    }
}

/// A session that never becomes ready fails its test, and does not hang it.
async fn ready(session: &SemiontSession) {
    tokio::time::timeout(Duration::from_secs(60), session.ready())
        .await
        .expect("the session becomes ready");
}

async fn settle() {
    tokio::time::sleep(Duration::from_millis(1)).await;
}

/// The token the session holds: what a refusal of that token names.
fn held_by(session: &SemiontSession) -> Option<String> {
    session.token().borrow().clone()
}

// ── How it starts ───────────────────────────────────────────────────────

#[tokio::test(start_paused = true)]
async fn with_nothing_stored_a_session_has_no_token_and_asks_nobody() {
    let world = World::new();
    let session = world.session();
    ready(&session).await;

    assert_eq!(*session.token().borrow(), None);
    assert_eq!(*session.user().borrow(), None);
    assert_eq!(session.expires_at(), None);
    assert_eq!((world.renewed(), world.validated().len()), (0, 0));
}

#[tokio::test(start_paused = true)]
async fn a_stored_token_that_is_still_good_is_the_sessions_from_its_start_and_says_who_it_is() {
    let access = token(3600, 1);
    let world = World::new().storing(&access);
    let session = world.session();

    ready(&session).await;
    assert_eq!(session.token().borrow().as_deref(), Some(access.as_str()));
    assert_eq!(world.validated(), std::slice::from_ref(&access));
    assert_eq!(*session.user().borrow(), Some(alice()));
    assert_eq!(world.renewed(), 0);
    let expiry = session.expires_at().expect("the token names an expiry");
    assert!(expiry > SystemTime::now() + Duration::from_secs(3500));
}

#[tokio::test(start_paused = true)]
async fn a_token_the_session_was_given_is_not_replaced_by_the_stored_one() {
    let world = World::new().storing(&token(3600, 1));
    let given = token(3600, 2);
    let session = world.session_of(SemiontSessionConfig {
        token: watch::channel(Some(given.clone())).0,
        ..world.config()
    });
    ready(&session).await;

    assert_eq!(session.token().borrow().as_deref(), Some(given.as_str()));
}

#[tokio::test(start_paused = true)]
async fn a_session_of_a_service_asks_nobody_who_it_is() {
    let access = token(3600, 1);
    let world = World::new().storing(&access);
    let session = world.session_of(SemiontSessionConfig {
        validate: None,
        ..world.config()
    });
    ready(&session).await;

    assert_eq!(session.token().borrow().as_deref(), Some(access.as_str()));
    assert_eq!(*session.user().borrow(), None);
    assert!(world.validated().is_empty());
}

#[tokio::test(start_paused = true)]
async fn a_stored_token_that_has_expired_is_renewed_before_anyone_is_asked() {
    let renewed = token(3600, 2);
    let world = World::new()
        .storing(&expired())
        .renewing([Ok(Some(renewed.clone()))]);
    let session = world.session();
    assert_eq!(*session.token().borrow(), None);

    ready(&session).await;
    assert_eq!(session.token().borrow().as_deref(), Some(renewed.as_str()));
    assert_eq!(world.validated(), [renewed]);
    assert_eq!(*session.user().borrow(), Some(alice()));
}

#[tokio::test(start_paused = true)]
async fn an_expired_token_the_issuer_will_not_renew_is_forgotten_and_the_session_is_ready_anyway() {
    let answered_with_no_token = SignInError::answered(
        SignInErrorCode::Exchange,
        "The issuer refused the token request (HTTP 200)",
        200,
    );
    for renewal in [
        Ok(None),
        Err(refused_by_the_issuer()),
        Err(answered_with_no_token),
    ] {
        let world = World::new().storing(&expired()).renewing([renewal]);
        let session = world.session();
        ready(&session).await;

        assert_eq!(*session.token().borrow(), None);
        assert_eq!(*session.user().borrow(), None);
        assert!(!world.has_stored());
        assert!(world.validated().is_empty());
        // There was no session to end: nothing is said.
        assert!(world.auth_failed().is_empty());
        assert!(world.errors().is_empty());
    }
}

#[tokio::test(start_paused = true)]
async fn an_expired_token_whose_renewal_got_no_answer_is_kept_and_renewed_when_a_request_is_refused()
 {
    let spent_on_not_now = SignInError::answered(
        SignInErrorCode::Exchange,
        "The session could not be renewed after 4 attempts: HTTP 503",
        503,
    );
    for failure in [unanswered_by_the_issuer(), spent_on_not_now] {
        let renewed = token(3600, 2);
        let world = World::new()
            .storing(&expired())
            .renewing([Err(failure.clone()), Ok(Some(renewed.clone()))]);
        let session = world.session();
        ready(&session).await;

        assert_eq!(*session.token().borrow(), None);
        assert!(world.has_stored());
        assert!(world.auth_failed().is_empty());
        assert_eq!(
            world.errors(),
            [(
                SessionErrorCode::AuthFailed,
                format!("Token refresh failed: {}", failure.message)
            )]
        );
        // The issuer answers again: a request refused for want of a token
        // renews it.
        assert_eq!(
            session.refresh(held_by(&session).as_deref()).await,
            Some(renewed.clone())
        );
        assert_eq!(session.token().borrow().as_deref(), Some(renewed.as_str()));
        assert_eq!(world.renewed(), 2);
    }
}

type Failure = Box<dyn std::error::Error + Send + Sync>;

/// A sign-in kept that holds what it has, and forgets none of it: every
/// forgetting is refused.
struct Unforgetting(Arc<dyn SignInKept>);

impl SignInKept for Unforgetting {
    fn held(&self) -> BoxFuture<'_, Result<Option<StoredSession>, Failure>> {
        self.0.held()
    }

    fn keep(&self, sign_in: StoredSession) -> BoxFuture<'_, Result<(), Failure>> {
        self.0.keep(sign_in)
    }

    fn renewed<'a>(
        &'a self,
        read: &'a StoredSession,
        access: &'a str,
        refresh: &'a str,
    ) -> BoxFuture<'a, Result<Option<String>, Failure>> {
        self.0.renewed(read, access, refresh)
    }

    fn record_person_key<'a>(
        &'a self,
        access: &'a str,
        person_key: &'a str,
    ) -> BoxFuture<'a, Result<bool, Failure>> {
        self.0.record_person_key(access, person_key)
    }

    fn forget(&self) -> BoxFuture<'_, Result<(), Failure>> {
        Box::pin(async { Err("the storage is full".into()) })
    }
}

/// A sign-in kept that holds what it has until `unreadable` holds, and from
/// then on cannot be read.
struct Unreadable {
    kept: Arc<dyn SignInKept>,
    unreadable: AtomicBool,
}

impl Unreadable {
    fn over(kept: Arc<dyn SignInKept>) -> Arc<Unreadable> {
        Arc::new(Unreadable {
            kept,
            unreadable: AtomicBool::new(false),
        })
    }
}

impl SignInKept for Unreadable {
    fn held(&self) -> BoxFuture<'_, Result<Option<StoredSession>, Failure>> {
        if self.unreadable.load(Ordering::SeqCst) {
            return Box::pin(async { Err("the sign-in could not be read".into()) });
        }
        self.kept.held()
    }

    fn keep(&self, sign_in: StoredSession) -> BoxFuture<'_, Result<(), Failure>> {
        self.kept.keep(sign_in)
    }

    fn renewed<'a>(
        &'a self,
        read: &'a StoredSession,
        access: &'a str,
        refresh: &'a str,
    ) -> BoxFuture<'a, Result<Option<String>, Failure>> {
        self.kept.renewed(read, access, refresh)
    }

    fn record_person_key<'a>(
        &'a self,
        access: &'a str,
        person_key: &'a str,
    ) -> BoxFuture<'a, Result<bool, Failure>> {
        self.kept.record_person_key(access, person_key)
    }

    fn forget(&self) -> BoxFuture<'_, Result<(), Failure>> {
        self.kept.forget()
    }
}

#[tokio::test(start_paused = true)]
async fn an_expired_token_the_storage_will_not_forget_is_said_at_the_start() {
    let world = World::new()
        .storing(&expired())
        .renewing([Err(refused_by_the_issuer())]);
    let session = world.session_of(SemiontSessionConfig {
        kept: Arc::new(Unforgetting(kept_in(world.storage.clone(), KB))),
        ..world.config()
    });
    ready(&session).await;

    assert_eq!(*session.token().borrow(), None);
    assert!(world.has_stored());
    assert_eq!(
        world.errors(),
        [(
            SessionErrorCode::RefreshExhausted,
            "Token refresh failed: The issuer refused the token request (invalid_grant: Token is not active); and the sign-in could not be forgotten: the storage is full".to_owned()
        )]
    );
    assert!(world.auth_failed().is_empty());
}

#[tokio::test(start_paused = true)]
async fn a_token_the_gateway_refuses_is_renewed_once_and_asked_about_again() {
    let (access, renewed) = (token(3600, 1), token(3600, 2));
    let world = World::new()
        .storing(&access)
        .validating([Err(unauthorized())])
        .renewing([Ok(Some(renewed.clone()))]);
    let session = world.session();
    ready(&session).await;

    assert_eq!(world.validated(), [access, renewed.clone()]);
    assert_eq!(session.token().borrow().as_deref(), Some(renewed.as_str()));
    assert_eq!(*session.user().borrow(), Some(alice()));
    assert!(world.auth_failed().is_empty());
}

#[tokio::test(start_paused = true)]
async fn a_token_the_gateway_refuses_and_nothing_renews_ends_the_session() {
    let world = World::new()
        .storing(&token(3600, 1))
        .validating([Err(unauthorized())]);
    let session = world.session();
    ready(&session).await;

    assert_eq!(*session.token().borrow(), None);
    assert_eq!(*session.user().borrow(), None);
    assert!(!world.has_stored());
    assert_eq!(world.auth_failed(), ["expired"]);
}

#[tokio::test(start_paused = true)]
async fn a_token_that_could_not_be_asked_about_is_kept_and_the_failure_is_said() {
    let access = token(3600, 1);
    let world = World::new()
        .storing(&access)
        .validating([Err(TransportError::of_status("HTTP 503", 503, None).into())]);
    let session = world.session();
    ready(&session).await;

    // Not a refusal: the token may be perfectly good.
    assert_eq!(session.token().borrow().as_deref(), Some(access.as_str()));
    assert!(world.has_stored());
    assert_eq!(world.renewed(), 0);
    assert_eq!(
        world.errors(),
        [(SessionErrorCode::AuthFailed, "HTTP 503".to_owned())]
    );
    assert!(world.auth_failed().is_empty());
}

/// What a row that ended signed out and kept what is stored comes to once
/// the reconnect wait has passed: its `then`, stated of every such row and
/// of no other.
fn then(case: &Value) -> Option<&Value> {
    let later = case.get("then");
    let kept_with_no_token = case["ends"] == "signed-out" && case["kept"] == true;
    assert_eq!(
        later.is_some(),
        kept_with_no_token,
        "{}: `then` is stated of every row that kept what is stored with no token, and of no other",
        case["why"]
    );
    later
}

/// The session stood as `later` states once the reconnect wait passed.
fn then_ends_as_stated(why: &str, later: &Value, world: &World, session: &SemiontSession) {
    let ends = match (
        session.token().borrow().is_some(),
        session.user().borrow().is_some(),
    ) {
        (false, _) => "signed-out",
        (true, false) => "unconfirmed",
        (true, true) => "signed-in",
    };
    assert_eq!(
        ends,
        later["ends"].as_str().expect("ends"),
        "{why}: how the session stood once the reconnect wait passed"
    );
    if ends == "signed-in" {
        assert_eq!(
            *session.user().borrow(),
            world.answered(),
            "{why}: who the gateway last said the token is"
        );
    }
}

/// What a session does with the credential it finds stored, as
/// protocol/specs/src/session/cases.json states it for every SDK: each row scripts
/// the gateway and the issuer, and says how often each is asked and how the
/// session ends.
#[tokio::test(start_paused = true)]
async fn a_session_starts_as_each_case_of_the_shared_table_states() {
    let table: Value = serde_json::from_str(include_str!("../specs/session/cases.json"))
        .expect("the table is JSON");
    let cases = table["startup"].as_array().expect("startup cases");
    assert!(!cases.is_empty(), "the table has no startup case");
    // The `n`th answer of a script whose last answer repeats.
    let answer = |script: &Value, n: usize| -> String {
        let script = script.as_array().expect("a script");
        script[n.min(script.len() - 1)]
            .as_str()
            .expect("an answer")
            .to_owned()
    };

    for case in cases {
        let why = case["why"].as_str().expect("why");
        let count = |key: &str| case[key].as_u64().expect("a count") as usize;
        let (asks, renewals) = (count("asks"), count("renewals"));
        let later = then(case);
        let (answered_asks, answered_renewals) = later.map_or((asks, renewals), |later| {
            (
                later["asks"].as_u64().expect("a count") as usize,
                later["renewals"].as_u64().expect("a count") as usize,
            )
        });
        // The script's last answer repeats, so a session that asks without
        // end is stopped by one answer more than the case allows: of the
        // gateway, an answer that is no refusal; of the issuer, none.
        let validations = (0..answered_asks)
            .map(|n| match answer(&case["gateway"], n).as_str() {
                "accepts" => Ok(answering(n)),
                "refuses" => Err(unauthorized()),
                "unreachable" => Err(TransportError::of_status("HTTP 503", 503, None).into()),
                other => panic!("{why}: the gateway {other}"),
            })
            .chain([Err(TransportError::of_status(
                "asked more than the case allows",
                500,
                None,
            )
            .into())]);
        let renewed_tokens: Vec<String> = (0..answered_renewals)
            .map(|n| token(3600, n as u64 + 1))
            .collect();
        let renewing = (0..answered_renewals).map(|n| match answer(&case["issuer"], n).as_str() {
            "renews" => Ok(Some(renewed_tokens[n].clone())),
            "refuses" => Err(refused_by_the_issuer()),
            "unreachable" => Err(unanswered_by_the_issuer()),
            other => panic!("{why}: the issuer {other}"),
        });
        let world = World::new().validating(validations).renewing(renewing);
        let stored = match case["stored"].as_str().expect("stored") {
            "none" => None,
            "unexpired" => Some(token(3600, 0)),
            "expired" => Some(expired()),
            other => panic!("{why}: a stored token that is {other}"),
        };
        let world = match &stored {
            Some(access) => world.storing(access),
            None => world,
        };
        let session = world.session();
        ready(&session).await;

        assert_eq!(
            (world.validated().len(), world.renewed()),
            (asks, renewals),
            "{why}: how often the gateway and the issuer were asked"
        );
        world.each_renewal_was_handed(stored.as_deref(), why);
        let ends = match (
            session.token().borrow().is_some(),
            session.user().borrow().is_some(),
        ) {
            (false, _) => "signed-out",
            (true, false) => "unconfirmed",
            (true, true) => "signed-in",
        };
        assert_eq!(ends, case["ends"].as_str().expect("ends"), "{why}");
        if ends == "signed-in" {
            assert_eq!(
                *session.user().borrow(),
                world.answered(),
                "{why}: who the gateway last said the token is"
            );
        }
        let told: Vec<String> = case["told"]
            .as_str()
            .map(str::to_owned)
            .into_iter()
            .collect();
        assert_eq!(world.auth_failed(), told, "{why}: why the session ended");
        let reported: Vec<&str> = world
            .errors()
            .iter()
            .map(|(code, _)| code.as_str())
            .collect();
        let error: Vec<&str> = case["error"].as_str().into_iter().collect();
        assert_eq!(reported, error, "{why}: the error reported");
        assert_eq!(
            world.has_stored(),
            case["kept"].as_bool().expect("kept"),
            "{why}: whether a session is still stored"
        );

        // A session that ended signed out and kept what is stored renews it
        // once more when the reconnect wait has passed, and asks nobody; one
        // that kept nothing asks nobody anything afterwards, however long it
        // is held.
        if let Some(later) = later {
            // Past the latest its renewal on the backoff falls due, and
            // short of the earliest a second can.
            tokio::time::sleep(RECONNECT * 6 / 5).await;
            settle().await;
            assert_eq!(
                (world.validated().len(), world.renewed()),
                (answered_asks, answered_renewals),
                "{why}: what was asked and renewed once the reconnect wait passed"
            );
            world.each_renewal_was_handed(stored.as_deref(), why);
            then_ends_as_stated(why, later, &world, &session);
        } else if ends == "signed-out" {
            tokio::time::sleep(Duration::from_secs(2 * 60 * 60)).await;
            assert_eq!(
                (world.validated().len(), world.renewed()),
                (asks, renewals),
                "{why}: what was asked once the session was over"
            );
        }
        session.dispose();
    }
}

/// What a running session does when the gateway refuses its token, as
/// protocol/specs/src/session/cases.json states it for every SDK (`refusal`).
#[tokio::test(start_paused = true)]
async fn a_refused_session_renews_and_asks_as_each_case_of_the_shared_table_states() {
    let table: Value = serde_json::from_str(include_str!("../specs/session/cases.json"))
        .expect("the table is JSON");
    let cases = table["refusal"].as_array().expect("refusal cases");
    assert!(!cases.is_empty(), "the table has no refusal case");
    let answer = |script: &Value, n: usize| -> String {
        let script = script.as_array().expect("a script");
        script[n.min(script.len() - 1)]
            .as_str()
            .expect("an answer")
            .to_owned()
    };

    for case in cases {
        let why = case["why"].as_str().expect("why");
        let count = |key: &str| case[key].as_u64().expect("a count") as usize;
        let (asks, renewals) = (count("asks"), count("renewals"));
        let later = then(case);
        let (answered_asks, answered_renewals) = later.map_or((asks, renewals), |later| {
            (
                later["asks"].as_u64().expect("a count") as usize,
                later["renewals"].as_u64().expect("a count") as usize,
            )
        });
        // The session starts signed in: the gateway accepts the stored token.
        // Then the case's answers, and one more than it allows: of the
        // gateway, an answer that is no refusal; of the issuer, none.
        let validations = std::iter::once(Ok(alice()))
            .chain(
                (0..answered_asks).map(|n| match answer(&case["gateway"], n).as_str() {
                    "accepts" => Ok(answering(n)),
                    "refuses" => Err(unauthorized()),
                    "unreachable" => Err(TransportError::of_status("HTTP 503", 503, None).into()),
                    other => panic!("{why}: the gateway {other}"),
                }),
            )
            .chain([Err(TransportError::of_status(
                "asked more than the case allows",
                500,
                None,
            )
            .into())]);
        let renewed_token = token(3600, 1);
        let renewing = (0..answered_renewals).map(|n| match answer(&case["issuer"], n).as_str() {
            "renews" => Ok(Some(renewed_token.clone())),
            "refuses" => Err(refused_by_the_issuer()),
            "unreachable" => Err(unanswered_by_the_issuer()),
            other => panic!("{why}: the issuer {other}"),
        });
        let started_on = token(3600, 0);
        let world = World::new()
            .storing(&started_on)
            .validating(validations)
            .renewing(renewing);
        let session = world.session();
        ready(&session).await;
        assert_eq!(
            *session.user().borrow(),
            Some(alice()),
            "{why}: it starts signed in"
        );
        assert_eq!((world.validated().len(), world.renewed()), (1, 0));

        // The gateway refused a token: its transport asks the session to
        // refresh, and tells it which.
        let refused = match case["refused"].as_str().expect("refused") {
            "held" => held_by(&session),
            "replaced" => Some(token(3600, 2)),
            other => panic!("{why}: a refused token the table calls {other}"),
        };
        let given = session.refresh(refused.as_deref()).await;

        assert_eq!(
            (world.validated().len() - 1, world.renewed()),
            (asks, renewals),
            "{why}: how often the gateway and the issuer were asked"
        );
        world.each_renewal_was_handed(Some(&started_on), why);
        assert_eq!(
            given.is_some(),
            case["given"].as_bool().expect("given"),
            "{why}: whether refresh gives a token"
        );
        if given.is_some() {
            assert_eq!(given, *session.token().borrow(), "{why}");
        }
        let ends = match (
            session.token().borrow().is_some(),
            session.user().borrow().is_some(),
        ) {
            (false, _) => "signed-out",
            (true, false) => "unconfirmed",
            (true, true) => "signed-in",
        };
        assert_eq!(ends, case["ends"].as_str().expect("ends"), "{why}");
        if ends == "signed-in" {
            assert_eq!(
                *session.user().borrow(),
                world.answered(),
                "{why}: who the gateway last said the token is"
            );
        }
        let told: Vec<String> = case["told"]
            .as_str()
            .map(str::to_owned)
            .into_iter()
            .collect();
        assert_eq!(world.auth_failed(), told, "{why}: why the session ended");
        let reported: Vec<&str> = world
            .errors()
            .iter()
            .map(|(code, _)| code.as_str())
            .collect();
        let error: Vec<&str> = case["error"].as_str().into_iter().collect();
        assert_eq!(reported, error, "{why}: the error reported");
        assert_eq!(
            world.has_stored(),
            case["kept"].as_bool().expect("kept"),
            "{why}: whether a session is still stored"
        );
        if let Some(later) = later {
            // Past the latest its renewal on the backoff falls due, and
            // short of the earliest a second can.
            tokio::time::sleep(RECONNECT * 6 / 5).await;
            settle().await;
            assert_eq!(
                (world.validated().len() - 1, world.renewed()),
                (answered_asks, answered_renewals),
                "{why}: what was asked and renewed once the reconnect wait passed"
            );
            world.each_renewal_was_handed(Some(&started_on), why);
            then_ends_as_stated(why, later, &world, &session);
        } else if ends == "signed-out" {
            tokio::time::sleep(Duration::from_secs(2 * 60 * 60)).await;
            assert_eq!(
                (world.validated().len() - 1, world.renewed()),
                (asks, renewals),
                "{why}: what was asked once the session was over"
            );
        }
        session.dispose();
    }
}

/// A session whose gateway holds its answer about the stored token until
/// `release` is notified, refuses that token, and answers `of_renewed` about
/// any other. What it was asked about, in order.
fn starting_slowly(
    world: &World,
    stored_token: &str,
    of_renewed: Validation,
) -> (
    SemiontSession,
    Arc<Mutex<Vec<String>>>,
    Arc<tokio::sync::Notify>,
) {
    let asked: Arc<Mutex<Vec<String>>> = Arc::default();
    let release = Arc::new(tokio::sync::Notify::new());
    let (asking, held, stored_token) = (asked.clone(), release.clone(), stored_token.to_owned());
    let session = world.session_of(SemiontSessionConfig {
        validate: Some(Arc::new(move |token| {
            asking.lock().expect("asked").push(token.clone());
            let (held, stored_token, of_renewed) =
                (held.clone(), stored_token.clone(), of_renewed.clone());
            Box::pin(async move {
                if token != stored_token {
                    return of_renewed;
                }
                held.notified().await;
                Err(unauthorized())
            })
        })),
        ..world.config()
    });
    (session, asked, release)
}

// The session's stream opens with the stored token as the session starts
// asking who that token is, so the stream's refusal can land first. While
// the session is starting, a refusal only renews: the start finds the renewed
// token and asks about it. One renewal, one ask about it, one ending.
#[tokio::test(start_paused = true)]
async fn a_stream_refused_while_the_session_is_starting_costs_one_renewal_and_one_ending() {
    let (access, renewed) = (token(3600, 1), token(3600, 2));
    let world = World::new()
        .storing(&access)
        .renewing([Ok(Some(renewed.clone())), Ok(Some(token(3600, 3)))]);
    let (session, asked, release) = starting_slowly(&world, &access, Err(unauthorized()));
    settle().await;

    // The stream's refusal arrives before the start has its answer.
    let refreshing = tokio::spawn({
        let renewer = session.renewer();
        let refused = held_by(&session);
        async move { renewer.refresh(refused.as_deref()).await }
    });
    settle().await;
    release.notify_one();
    ready(&session).await;

    assert_eq!(
        refreshing.await.expect("the refresh ran"),
        Some(renewed.clone())
    );
    assert_eq!(*asked.lock().expect("asked"), [access, renewed]);
    assert_eq!(world.renewed(), 1);
    assert_eq!(world.auth_failed().len(), 1);
    assert_eq!(
        world
            .errors()
            .iter()
            .map(|(code, _)| *code)
            .collect::<Vec<_>>(),
        [SessionErrorCode::CredentialRefused]
    );
    assert_eq!(*session.token().borrow(), None);
}

#[tokio::test(start_paused = true)]
async fn the_start_does_the_asking_when_it_and_the_stream_are_both_waiting_on_one_renewal() {
    let (access, renewed) = (token(3600, 1), token(3600, 2));
    let world = World::new().storing(&access);
    // One renewal serves both askers, as renewals asked for together do; and
    // the gateway refuses the stored token at once, and holds its answer
    // about the renewed one until released.
    let (issue, release) = (
        Arc::new(tokio::sync::Notify::new()),
        Arc::new(tokio::sync::Notify::new()),
    );
    let asked: Arc<Mutex<Vec<String>>> = Arc::default();
    let renewals = Arc::new(Mutex::new(0usize));
    let (issuing, renewing, issued) = (issue.clone(), renewals.clone(), renewed.clone());
    let (asking, holding, held_token) = (asked.clone(), release.clone(), renewed.clone());
    let session = world.session_of(SemiontSessionConfig {
        refresh: Some(Arc::new(move |_holding| {
            *renewing.lock().expect("renewals") += 1;
            let (issuing, issued) = (issuing.clone(), issued.clone());
            Box::pin(async move {
                issuing.notified().await;
                Ok(Some(issued))
            })
        })),
        validate: Some(Arc::new(move |token| {
            asking.lock().expect("asked").push(token.clone());
            let (holding, held_token) = (holding.clone(), held_token.clone());
            Box::pin(async move {
                if token == held_token {
                    holding.notified().await;
                }
                Err(unauthorized())
            })
        })),
        ..world.config()
    });
    settle().await;

    // The start is refused and asks for a renewal; so does the stream.
    let refreshing = tokio::spawn({
        let renewer = session.renewer();
        let refused = held_by(&session);
        async move { renewer.refresh(refused.as_deref()).await }
    });
    settle().await;
    assert_eq!(*renewals.lock().expect("renewals"), 2);
    issue.notify_waiters();
    settle().await;
    assert_eq!(*asked.lock().expect("asked"), [access, renewed.clone()]);
    release.notify_one();
    ready(&session).await;

    assert_eq!(refreshing.await.expect("the refresh ran"), Some(renewed));
    assert_eq!(asked.lock().expect("asked").len(), 2);
    assert_eq!(world.auth_failed().len(), 1);
    assert_eq!(
        world
            .errors()
            .iter()
            .map(|(code, _)| *code)
            .collect::<Vec<_>>(),
        [SessionErrorCode::CredentialRefused]
    );
}

#[tokio::test(start_paused = true)]
async fn a_token_renewed_while_the_session_is_starting_is_taken_up_and_not_renewed_again() {
    let (access, renewed) = (token(3600, 1), token(3600, 2));
    let world = World::new()
        .storing(&access)
        .renewing([Ok(Some(renewed.clone())), Ok(Some(token(3600, 3)))]);
    let (session, asked, release) = starting_slowly(&world, &access, Ok(alice()));
    settle().await;

    let refreshing = tokio::spawn({
        let renewer = session.renewer();
        let refused = held_by(&session);
        async move { renewer.refresh(refused.as_deref()).await }
    });
    settle().await;
    release.notify_one();
    ready(&session).await;

    assert_eq!(
        refreshing.await.expect("the refresh ran"),
        Some(renewed.clone())
    );
    assert_eq!(*asked.lock().expect("asked"), [access, renewed.clone()]);
    assert_eq!(world.renewed(), 1);
    assert_eq!(session.token().borrow().as_deref(), Some(renewed.as_str()));
    assert_eq!(*session.user().borrow(), Some(alice()));
    assert!(world.auth_failed().is_empty());
}

#[tokio::test(start_paused = true)]
async fn refusals_that_arrive_together_cost_one_renewal_and_one_ask() {
    let (access, renewed) = (token(3600, 1), token(3600, 2));
    let world = World::new().storing(&access);
    // An issuer that takes a moment, as one does: the refusals overlap.
    let renewals = Arc::new(Mutex::new(0usize));
    let (renewing, issued) = (renewals.clone(), renewed.clone());
    let session = world.session_of(SemiontSessionConfig {
        refresh: Some(Arc::new(move |_holding| {
            *renewing.lock().expect("renewals") += 1;
            let issued = issued.clone();
            Box::pin(async move {
                tokio::time::sleep(Duration::from_millis(10)).await;
                Ok(Some(issued))
            })
        })),
        ..world.config()
    });
    ready(&session).await;

    // Three requests refused at once: each asks the session to refresh.
    let refused = held_by(&session);
    let (a, b, c) = tokio::join!(
        session.refresh(refused.as_deref()),
        session.refresh(refused.as_deref()),
        session.refresh(refused.as_deref())
    );

    assert_eq!(
        [a, b, c],
        [
            Some(renewed.clone()),
            Some(renewed.clone()),
            Some(renewed.clone())
        ]
    );
    assert_eq!(*renewals.lock().expect("renewals"), 1);
    assert_eq!(world.validated(), [access, renewed]);

    // A refusal after that is a new one.
    session.refresh(held_by(&session).as_deref()).await;
    assert_eq!(*renewals.lock().expect("renewals"), 2);
}

#[tokio::test(start_paused = true)]
async fn a_session_is_not_ended_by_the_refusal_of_a_token_it_no_longer_holds() {
    let (access, renewed, other) = (token(3600, 1), token(3600, 2), token(3600, 9));
    let world = World::new()
        .storing(&access)
        .renewing([Ok(Some(renewed.clone()))]);
    // The gateway holds its answer about the renewed token until released.
    let release = Arc::new(tokio::sync::Notify::new());
    let (holding, held_token) = (release.clone(), renewed.clone());
    let sends = watch::channel(None).0;
    let session = world.session_of(SemiontSessionConfig {
        token: sends.clone(),
        validate: Some(Arc::new(move |token| {
            let (holding, held_token) = (holding.clone(), held_token.clone());
            Box::pin(async move {
                if token != held_token {
                    return Ok(alice());
                }
                holding.notified().await;
                Err(unauthorized())
            })
        })),
        ..world.config()
    });
    ready(&session).await;

    let refreshing = tokio::spawn({
        let renewer = session.renewer();
        let refused = held_by(&session);
        async move { renewer.refresh(refused.as_deref()).await }
    });
    settle().await;
    // The token is replaced while the gateway is being asked.
    sends.send_replace(Some(other.clone()));
    release.notify_one();

    assert_eq!(
        refreshing.await.expect("the refresh ran"),
        Some(other.clone())
    );
    assert_eq!(session.token().borrow().as_deref(), Some(other.as_str()));
    assert!(world.auth_failed().is_empty());
}

// ── How it is renewed ───────────────────────────────────────────────────

#[tokio::test(start_paused = true)]
async fn refresh_gives_the_new_token_and_makes_it_the_sessions() {
    let renewed = token(3600, 2);
    let world = World::new()
        .storing(&token(3600, 1))
        .renewing([Ok(Some(renewed.clone()))]);
    let session = world.session();
    ready(&session).await;

    assert_eq!(
        session.refresh(held_by(&session).as_deref()).await,
        Some(renewed.clone())
    );
    assert_eq!(session.token().borrow().as_deref(), Some(renewed.as_str()));
    assert!(world.auth_failed().is_empty());
}

#[tokio::test(start_paused = true)]
async fn an_idle_session_renews_its_token_once_per_half_life_and_no_oftener() {
    // A five-minute token, and every renewal gives another: a margin of five
    // minutes would make each one due the moment it was issued.
    let world = World::new().storing(&token(300, 0));
    world
        .renewals
        .lock()
        .expect("renewals")
        .extend((1..100).map(|n| Ok(Some(token(300, n)))));
    let session = world.session();
    ready(&session).await;

    // Half its life is 150 seconds, less whatever of a second had passed
    // when it was issued.
    tokio::time::sleep(Duration::from_secs(140)).await;
    assert_eq!(world.renewed(), 0);
    tokio::time::sleep(Duration::from_secs(12)).await;
    assert_eq!(world.renewed(), 1);

    tokio::time::sleep(Duration::from_secs(600)).await;
    assert_eq!(world.renewed(), 5);
    // A renewal on the session's own schedule follows no refusal: the
    // gateway was asked who the token is when the session started, and not
    // since.
    assert_eq!(world.validated().len(), 1);
    drop(session);
}

// The stored token falls due while a refusal's renewal of it is under way.
// The wait was for the token that renewal replaces: the schedule waits for
// the renewal, finds the token replaced, and renews nothing.
#[tokio::test(start_paused = true)]
async fn a_token_that_falls_due_while_a_refusal_renews_it_is_renewed_once() {
    // A minute: due at half of it.
    let (access, renewed) = (token(60, 1), token(3600, 2));
    let world = World::new().storing(&access);
    // An issuer that holds its answer until released.
    let release = Arc::new(tokio::sync::Notify::new());
    let renewals = Arc::new(Mutex::new(0usize));
    let (renewing, holding, issued) = (renewals.clone(), release.clone(), renewed.clone());
    let session = world.session_of(SemiontSessionConfig {
        refresh: Some(Arc::new(move |_holding| {
            *renewing.lock().expect("renewals") += 1;
            let (holding, issued) = (holding.clone(), issued.clone());
            Box::pin(async move {
                holding.notified().await;
                Ok(Some(issued))
            })
        })),
        ..world.config()
    });
    ready(&session).await;

    let refreshing = tokio::spawn({
        let renewer = session.renewer();
        let refused = held_by(&session);
        async move { renewer.refresh(refused.as_deref()).await }
    });
    settle().await;
    tokio::time::sleep(Duration::from_secs(60)).await;
    assert_eq!(*renewals.lock().expect("renewals"), 1);
    release.notify_waiters();

    assert_eq!(
        refreshing.await.expect("the refresh ran"),
        Some(renewed.clone())
    );
    settle().await;
    assert_eq!(*renewals.lock().expect("renewals"), 1);
    assert_eq!(session.token().borrow().as_deref(), Some(renewed.as_str()));
}

#[tokio::test(start_paused = true)]
async fn a_session_that_cannot_be_renewed_is_over_and_says_so_once() {
    let world = World::new().storing(&token(3600, 1));
    let session = world.session();
    ready(&session).await;

    assert_eq!(session.refresh(held_by(&session).as_deref()).await, None);
    assert_eq!(*session.token().borrow(), None);
    // The dead credential is not kept to be used again.
    assert!(!world.has_stored());
    assert_eq!(world.auth_failed(), ["expired"]);
    assert_eq!(
        world.errors(),
        [(
            SessionErrorCode::RefreshExhausted,
            "Token refresh failed".to_owned()
        )]
    );

    // What follows finds nothing stored, and is quiet.
    assert_eq!(session.refresh(held_by(&session).as_deref()).await, None);
    assert_eq!(world.auth_failed().len(), 1);
    assert_eq!(world.errors().len(), 1);
}

#[tokio::test(start_paused = true)]
async fn a_session_whose_credential_the_storage_will_not_forget_says_so_as_it_ends() {
    let world = World::new().storing(&token(3600, 1));
    let session = world.session_of(SemiontSessionConfig {
        kept: Arc::new(Unforgetting(kept_in(world.storage.clone(), KB))),
        ..world.config()
    });
    ready(&session).await;

    assert_eq!(session.refresh(held_by(&session).as_deref()).await, None);
    assert_eq!(*session.token().borrow(), None);
    assert!(world.has_stored());
    assert_eq!(world.auth_failed(), ["expired"]);
    assert_eq!(
        world.errors(),
        [(
            SessionErrorCode::RefreshExhausted,
            "Token refresh failed; and the sign-in could not be forgotten: the storage is full"
                .to_owned()
        )]
    );
}

#[tokio::test(start_paused = true)]
async fn a_renewal_the_issuer_refused_ends_the_session_and_names_its_cause() {
    let world = World::new()
        .storing(&token(3600, 1))
        .renewing([Err(refused_by_the_issuer())]);
    let session = world.session();
    ready(&session).await;

    assert_eq!(session.refresh(held_by(&session).as_deref()).await, None);
    assert!(!world.has_stored());
    assert_eq!(world.auth_failed(), ["expired"]);
    assert_eq!(
        world.errors(),
        [(
            SessionErrorCode::RefreshExhausted,
            format!("Token refresh failed: {}", refused_by_the_issuer().message)
        )]
    );
}

#[tokio::test(start_paused = true)]
async fn a_renewal_that_got_no_answer_keeps_what_is_stored_and_the_next_refusal_renews_again() {
    let spent_on_not_now = SignInError::answered(
        SignInErrorCode::Exchange,
        "The session could not be renewed after 4 attempts: HTTP 503",
        503,
    );
    for failure in [unanswered_by_the_issuer(), spent_on_not_now] {
        let renewed = token(3600, 2);
        let world = World::new()
            .storing(&token(3600, 1))
            .renewing([Err(failure.clone()), Ok(Some(renewed.clone()))]);
        let session = world.session();
        ready(&session).await;

        assert_eq!(session.refresh(held_by(&session).as_deref()).await, None);
        // No usable token, what is stored stays, and the session is not over.
        assert_eq!(*session.token().borrow(), None);
        assert!(world.has_stored());
        assert!(world.auth_failed().is_empty());
        assert_eq!(
            world.errors(),
            [(
                SessionErrorCode::RefreshExhausted,
                format!("Token refresh failed: {}", failure.message)
            )]
        );
        assert_eq!(
            session.refresh(held_by(&session).as_deref()).await,
            Some(renewed.clone())
        );
        assert_eq!(session.token().borrow().as_deref(), Some(renewed.as_str()));
    }
}

#[tokio::test(start_paused = true)]
async fn a_renewal_that_got_no_answer_is_tried_again_on_the_reconnect_backoff_until_one_is_made() {
    let waits: Vec<Duration> = (0..6)
        .map(|n| (RECONNECT * 2u32.pow(n)).min(MAX_RECONNECT))
        .collect();
    let renewed = token(3600, 2);
    let world = World::new().storing(&token(3600, 1)).renewing(
        waits
            .iter()
            .map(|_| Err(unanswered_by_the_issuer()))
            .chain([Ok(Some(renewed.clone()))]),
    );
    let session = world.session();
    ready(&session).await;

    assert_eq!(session.refresh(held_by(&session).as_deref()).await, None);
    // Past every wait at its longest: the renewal made ends them.
    tokio::time::sleep(waits.iter().sum::<Duration>() + Duration::from_secs(30)).await;
    settle().await;
    assert_eq!(world.renewed(), waits.len() + 1);
    // Each wait is the equal jitter of its step, the step doubling from the
    // reconnect wait up to the longest.
    let renewed_at = world.renewed_at.lock().expect("renewed at").clone();
    for (pair, wait) in renewed_at.windows(2).zip(&waits) {
        let gap = pair[1] - pair[0];
        assert!(
            gap >= *wait / 2 && gap <= *wait + Duration::from_millis(1),
            "waited {gap:?} for a step of {wait:?}"
        );
    }
    assert_eq!(session.token().borrow().as_deref(), Some(renewed.as_str()));
    // The renewal made ends the waits, and asks nobody.
    tokio::time::sleep(MAX_RECONNECT * 4).await;
    assert_eq!(
        (world.renewed(), world.validated().len()),
        (waits.len() + 1, 1)
    );
}

#[tokio::test(start_paused = true)]
async fn the_issuers_refusal_ends_the_renewals_on_the_reconnect_backoff() {
    let world = World::new().storing(&token(3600, 1)).renewing([
        Err(unanswered_by_the_issuer()),
        Err(refused_by_the_issuer()),
    ]);
    let session = world.session();
    ready(&session).await;

    assert_eq!(session.refresh(held_by(&session).as_deref()).await, None);
    tokio::time::sleep(RECONNECT * 6 / 5).await;
    settle().await;
    assert_eq!(world.renewed(), 2);
    assert!(!world.has_stored());
    assert_eq!(world.auth_failed(), ["expired"]);
    tokio::time::sleep(Duration::from_secs(2 * 60 * 60)).await;
    assert_eq!(world.renewed(), 2);
}

/// A renewal that gave no token, of a sign-in that then cannot be read, got
/// no answer: nothing says what is kept is over, so the session says why as
/// `session.refresh-exhausted`, ends nothing, and renews again on the
/// reconnect backoff until a renewal is made.
#[tokio::test(start_paused = true)]
async fn a_renewal_whose_sign_in_cannot_be_read_got_no_answer_and_is_tried_again_on_the_backoff() {
    let renewed = token(3600, 2);
    let world = World::new()
        .storing(&token(3600, 1))
        .renewing([Err(unanswered_by_the_issuer()), Ok(Some(renewed.clone()))]);
    let kept = Unreadable::over(kept_in(world.storage.clone(), KB));
    let session = world.session_of(SemiontSessionConfig {
        kept: kept.clone(),
        ..world.config()
    });
    ready(&session).await;
    kept.unreadable.store(true, Ordering::SeqCst);

    assert_eq!(session.refresh(held_by(&session).as_deref()).await, None);
    assert_eq!(world.codes(), [SessionErrorCode::RefreshExhausted]);
    assert!(world.auth_failed().is_empty());

    // Past the latest its renewal on the backoff falls due.
    tokio::time::sleep(RECONNECT * 6 / 5).await;
    settle().await;
    assert_eq!(world.renewed(), 2);
    assert_eq!(session.token().borrow().as_deref(), Some(renewed.as_str()));
    assert_eq!(world.codes(), [SessionErrorCode::RefreshExhausted]);
}

/// At its start, a renewal that got no answer says so as
/// `session.auth-failed`. The renewal on the backoff after it, whose
/// sign-in then cannot be read, got no answer either: it says so as
/// `session.refresh-exhausted`, and the backoff goes on until a renewal is
/// made, which asks the gateway who the token is, as the start would have.
#[tokio::test(start_paused = true)]
async fn a_start_whose_renewals_find_the_sign_in_unreadable_goes_on_renewing_on_the_backoff() {
    let renewed = token(3600, 3);
    let world = World::new().storing(&expired()).renewing([
        Err(unanswered_by_the_issuer()),
        Err(unanswered_by_the_issuer()),
        Ok(Some(renewed.clone())),
    ]);
    let kept = Unreadable::over(kept_in(world.storage.clone(), KB));
    let session = world.session_of(SemiontSessionConfig {
        kept: kept.clone(),
        ..world.config()
    });
    ready(&session).await;
    assert_eq!(world.codes(), [SessionErrorCode::AuthFailed]);
    kept.unreadable.store(true, Ordering::SeqCst);

    // The first wait is at most the reconnect wait, and the second at least
    // as long again.
    tokio::time::sleep(RECONNECT * 6 / 5).await;
    settle().await;
    assert_eq!(world.renewed(), 2);
    assert_eq!(
        world.codes(),
        [
            SessionErrorCode::AuthFailed,
            SessionErrorCode::RefreshExhausted
        ]
    );

    tokio::time::sleep(RECONNECT * 12 / 5).await;
    settle().await;
    assert_eq!(world.renewed(), 3);
    assert_eq!(session.token().borrow().as_deref(), Some(renewed.as_str()));
    assert_eq!(*session.user().borrow(), Some(alice()));
    assert!(world.auth_failed().is_empty());
}

#[tokio::test(start_paused = true)]
async fn a_session_that_never_signed_in_cannot_expire() {
    let world = World::new();
    let session = world.session();
    ready(&session).await;

    assert_eq!(session.refresh(held_by(&session).as_deref()).await, None);
    assert_eq!(world.renewed(), 1);
    assert!(world.auth_failed().is_empty());
    assert!(world.errors().is_empty());
}

#[tokio::test(start_paused = true)]
async fn a_session_given_no_way_to_renew_asks_nothing_and_ends_nothing() {
    let access = token(3600, 1);
    let world = World::new().storing(&access);
    let session = world.session_of(SemiontSessionConfig {
        refresh: None,
        ..world.config()
    });
    ready(&session).await;

    assert_eq!(session.refresh(held_by(&session).as_deref()).await, None);
    assert_eq!(session.token().borrow().as_deref(), Some(access.as_str()));
    assert!(world.has_stored());
}

// ── Which session it is ─────────────────────────────────────────────────

#[tokio::test(start_paused = true)]
async fn each_session_has_an_id_of_its_own_even_for_one_knowledge_base() {
    let world = World::new();
    let (first, second) = (world.session(), world.session());

    assert_ne!(first.id(), second.id());
    assert_eq!(first.kb().id, second.kb().id);
    let id = first.id().to_owned();
    first.dispose();
    assert_eq!(first.id(), id);
}

// ── How it ends ─────────────────────────────────────────────────────────

#[tokio::test(start_paused = true)]
async fn ending_a_session_ends_what_it_holds_and_leaves_its_client_open() {
    let world = World::new()
        .storing(&token(300, 1))
        .renewing([Ok(Some(token(300, 2)))]);
    let session = world.session();
    ready(&session).await;
    let (mut held, mut user) = (session.token(), session.user());
    let mut errors = StreamSurface(session.errors());

    session.dispose();
    session.dispose();
    settle().await;

    assert!(held.ended() && user.ended() && errors.ended());
    assert!(!world.client.bus().destroyed());
    // Nothing it had scheduled runs, and nothing it is told does anything.
    tokio::time::sleep(Duration::from_secs(600)).await;
    assert_eq!(world.renewed(), 0);
    assert_eq!(session.refresh(held_by(&session).as_deref()).await, None);
    assert_eq!(world.renewed(), 0);
    session.ready().await;
}

#[tokio::test(start_paused = true)]
async fn dropping_a_session_ends_what_it_holds_and_leaves_its_client_open() {
    let world = World::new().storing(&token(300, 1));
    let session = world.session();
    ready(&session).await;
    let mut held = session.token();

    drop(session);
    tokio::time::sleep(Duration::from_secs(600)).await;

    assert!(held.ended());
    assert_eq!(world.renewed(), 0);
    assert!(!world.client.bus().destroyed());
    assert!(world.transport.request_log().is_empty());
}

// The session is closed while a refusal's renewal of its token is under way.
// The refusal is given no token at once. The renewal finishes, and the close
// waits for it, so the rotation it brings is kept where the sign-in is kept;
// the closed session does not take its token. A refusal once the session is
// closed is given none, whatever token it names, and asks the issuer nothing.
// Nothing the close let finish is a sign-out.
#[tokio::test(start_paused = true)]
async fn a_session_closed_while_renewing_gives_the_refusal_no_token_and_keeps_the_rotation() {
    let (access, renewed) = (token(3600, 1), token(3600, 2));
    let world = World::new().storing(&access);
    // An issuer that holds its answer until released, whose rotation is kept
    // where the sign-in is kept, as a kept sign-in's renewal keeps it.
    let release = Arc::new(tokio::sync::Notify::new());
    let renewals = Arc::new(Mutex::new(0usize));
    let (renewing, holding) = (renewals.clone(), release.clone());
    let (storage, issued) = (world.storage.clone(), renewed.clone());
    let session = world.session_of(SemiontSessionConfig {
        refresh: Some(Arc::new(move |_holding| {
            *renewing.lock().expect("renewals") += 1;
            let (holding, storage, issued) = (holding.clone(), storage.clone(), issued.clone());
            Box::pin(async move {
                holding.notified().await;
                let rotated = StoredSession {
                    refresh: "a-rotated-refresh-token".to_owned(),
                    ..stored(&issued)
                };
                store_session(storage.as_ref(), KB, &rotated).expect("kept");
                Ok(Some(issued))
            })
        })),
        ..world.config()
    });
    ready(&session).await;

    let refreshing = tokio::spawn({
        let renewer = session.renewer();
        let refused = held_by(&session);
        async move { renewer.refresh(refused.as_deref()).await }
    });
    settle().await;
    assert_eq!(*renewals.lock().expect("renewals"), 1);
    let closing = tokio::spawn(async move {
        let opened = OpenedSession::new(session);
        opened.close().await;
        opened
    });

    let given = tokio::time::timeout(Duration::from_secs(1), refreshing)
        .await
        .expect("the refusal is answered at the close")
        .expect("the refresh ran");
    assert_eq!(given, None);
    assert!(!closing.is_finished(), "the close waits for the renewal");
    release.notify_waiters();
    let opened = tokio::time::timeout(Duration::from_secs(1), closing)
        .await
        .expect("the close returns once the renewal has finished")
        .expect("the close ran");

    let kept = stored_session(world.storage.as_ref(), KB).expect("the sign-in is kept");
    assert_eq!(kept.refresh, "a-rotated-refresh-token");
    let session = opened.session();
    assert_eq!(session.token().borrow().as_deref(), Some(access.as_str()));
    assert_eq!(session.refresh(Some(access.as_str())).await, None);
    // A token the session does not hold is given no token either.
    assert_eq!(session.refresh(Some(renewed.as_str())).await, None);
    assert_eq!(*renewals.lock().expect("renewals"), 1);
    assert!(world.auth_failed().is_empty());
    assert!(world.errors().is_empty());
}

// ── What a host shows about a session ───────────────────────────────────

#[test]
fn a_reason_is_named_as_the_table_names_it() {
    assert_eq!(SessionEndReason::Expired.as_str(), "expired");
    assert_eq!(SessionEndReason::Refused.as_str(), "refused");
}

#[test]
fn a_second_occurrence_is_told_even_when_it_says_the_same() {
    let signals = SessionSignals::new();
    let mut ended = signals.session_ended();
    let mut denied = signals.permission_denied();

    signals.notify_session_ended(SessionEndReason::Expired);
    signals.notify_permission_denied(None);
    assert!(ended.moved() && denied.moved());
    signals.notify_session_ended(SessionEndReason::Expired);
    signals.notify_permission_denied(None);
    assert!(ended.moved() && denied.moved());
}

struct Signals;

impl AxiomSubject for Signals {
    type Unit = SessionSignals;

    fn setup(&self) -> Fresh<SessionSignals> {
        Fresh::of(SessionSignals::new())
    }

    fn surfaces(&self, unit: &SessionSignals) -> Vec<Box<dyn Surface>> {
        vec![
            Box::new(unit.session_ended()),
            Box::new(unit.permission_denied()),
            Box::new(unit.kb_identity_conflict()),
        ]
    }

    fn invocations<'a>(&self, unit: &'a SessionSignals) -> Vec<Box<dyn Fn() + 'a>> {
        vec![
            Box::new(|| unit.notify_session_ended(SessionEndReason::Expired)),
            Box::new(|| unit.notify_permission_denied(Some("no"))),
            Box::new(|| unit.acknowledge_session_ended()),
            Box::new(|| unit.acknowledge_kb_identity_conflict()),
        ]
    }
}

#[test]
fn the_signals_keep_the_state_unit_axioms() {
    assert_eq!(assert_state_unit_axioms(&Signals), Ok(()));
}

struct Sessions;

impl AxiomSubject for Sessions {
    type Unit = SemiontSession;

    fn setup(&self) -> Fresh<SemiontSession> {
        let test = create_test_session(TestSessionOptions::default());
        Fresh::of(test.session).given(test.client)
    }

    // Its stream state is its client's, and ends with the client. Its errors
    // are its own, its transport's failures among them, and end with the
    // session.
    fn surfaces(&self, unit: &SemiontSession) -> Vec<Box<dyn Surface>> {
        vec![
            Box::new(unit.token()),
            Box::new(unit.user()),
            Box::new(StreamSurface(unit.errors())),
        ]
    }
}

#[test]
fn a_session_keeps_the_state_unit_axioms_and_never_closes_its_client() {
    assert_eq!(assert_state_unit_axioms(&Sessions), Ok(()));
}
