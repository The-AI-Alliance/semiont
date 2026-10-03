//! A session with a knowledge base: the token it holds, how it starts, how it
//! is renewed and how it ends; and what a host shows about one.
//!
//! The session's environment is scripted: what `refresh` answers each time
//! it is asked, and what the gateway says of a token.

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use semiont::client::SemiontClient;
use semiont::errors::{SemiontError, SessionError, SessionErrorCode, TransportError};
use semiont::session::{
    KbIdentityConflict, KbTarget, PermissionDenied, Protocol, SemiontSession, SemiontSessionConfig,
    SessionEndReason, SessionEnded, SessionSignals, StoredSession, session_key, store_session,
    stored_session,
};
use semiont::storage::SessionStorage;
use semiont::testing::axioms::{AxiomSubject, Fresh, Surface, assert_state_unit_axioms};
use semiont::testing::{FaultyTransport, SharedStorage, TestClientOptions, create_test_client};
use semiont::types::UserResponse;
use serde_json::{Value, json};
use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
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
    }
}

fn alice() -> UserResponse {
    serde_json::from_value(json!({
        "did": "did:web:example.org:users:alice", "email": "alice@example.org",
        "name": "Alice", "image": null, "domain": "example.org",
    }))
    .expect("a user")
}

fn unauthorized() -> SemiontError {
    TransportError::of_status("HTTP 401", 401, None).into()
}

type Renewal = Result<Option<String>, String>;
type Validation = Result<UserResponse, SemiontError>;

/// A session's environment, and a record of what the session did to it.
struct World {
    storage: Arc<SharedStorage>,
    /// Another context's handle on the same storage.
    elsewhere: SharedStorage,
    transport: FaultyTransport,
    client: Arc<SemiontClient>,
    /// What `refresh` answers, in order; `Ok(None)` once it is spent.
    renewals: Arc<Mutex<VecDeque<Renewal>>>,
    renewed: Arc<Mutex<usize>>,
    /// What the gateway says of a token, in order; Alice once it is spent.
    validations: Arc<Mutex<VecDeque<Validation>>>,
    validated: Arc<Mutex<Vec<String>>>,
    auth_failed: Arc<Mutex<Vec<String>>>,
    errors: Arc<Mutex<Vec<SessionError>>>,
}

impl World {
    fn new() -> World {
        let storage = Arc::new(SharedStorage::new());
        let transport = FaultyTransport::new(vec![]);
        World {
            elsewhere: storage.context(),
            storage,
            client: create_test_client(TestClientOptions {
                transport: Some(transport.clone()),
                ..TestClientOptions::default()
            })
            .client,
            transport,
            renewals: Arc::default(),
            renewed: Arc::default(),
            validations: Arc::default(),
            validated: Arc::default(),
            auth_failed: Arc::default(),
            errors: Arc::default(),
        }
    }

    fn storing(self, access: &str) -> World {
        store_session(self.storage.as_ref(), KB, &stored(access));
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
        let (validations, validated) = (self.validations.clone(), self.validated.clone());
        let (auth_failed, errors) = (self.auth_failed.clone(), self.errors.clone());
        SemiontSessionConfig {
            kb: KbTarget::http(KB, "Alpha", "localhost", 4000, Protocol::Http),
            storage: self.storage.clone(),
            client: self.client.clone(),
            token: watch::channel(None).0,
            refresh: Some(Arc::new(move || {
                *renewed.lock().expect("renewed") += 1;
                let answer = renewals
                    .lock()
                    .expect("renewals")
                    .pop_front()
                    .unwrap_or(Ok(None));
                Box::pin(async move { answer })
            })),
            validate: Some(Arc::new(move |token| {
                validated.lock().expect("validated").push(token);
                let answer = validations
                    .lock()
                    .expect("validations")
                    .pop_front()
                    .unwrap_or_else(|| Ok(alice()));
                Box::pin(async move { answer })
            })),
            on_auth_failed: Some(Arc::new(move |reason: SessionEndReason| {
                auth_failed
                    .lock()
                    .expect("auth failed")
                    .push(reason.as_str().to_owned());
            })),
            on_error: Some(Arc::new(move |error| {
                errors.lock().expect("errors").push(error);
            })),
        }
    }

    fn session(&self) -> SemiontSession {
        SemiontSession::new(self.config())
    }

    fn renewed(&self) -> usize {
        *self.renewed.lock().expect("renewed")
    }

    fn validated(&self) -> Vec<String> {
        self.validated.lock().expect("validated").clone()
    }

    fn auth_failed(&self) -> Vec<String> {
        self.auth_failed.lock().expect("auth failed").clone()
    }

    fn errors(&self) -> Vec<(SessionErrorCode, String)> {
        self.errors
            .lock()
            .expect("errors")
            .iter()
            .map(|error| (error.code, error.message.clone()))
            .collect()
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
async fn a_stored_token_that_is_still_good_is_the_sessions_at_once_and_says_who_it_is() {
    let access = token(3600, 1);
    let world = World::new().storing(&access);
    let session = world.session();
    // Before anything has run: it is what the transport sends first.
    assert_eq!(session.token().borrow().as_deref(), Some(access.as_str()));

    ready(&session).await;
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
    let session = SemiontSession::new(SemiontSessionConfig {
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
    let session = SemiontSession::new(SemiontSessionConfig {
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
async fn an_expired_token_that_cannot_be_renewed_is_forgotten_and_the_session_is_ready_anyway() {
    for renewal in [Ok(None), Err("the network is down".to_owned())] {
        let world = World::new().storing(&expired()).renewing([renewal]);
        let session = world.session();
        ready(&session).await;

        assert_eq!(*session.token().borrow(), None);
        assert_eq!(*session.user().borrow(), None);
        assert!(!world.has_stored());
        assert!(world.validated().is_empty());
    }
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

/// What a session does with the credential it finds stored, as
/// specs/src/session/cases.json states it for every SDK: each row scripts
/// the gateway and the issuer, and says how often each is asked and how the
/// session ends.
#[tokio::test(start_paused = true)]
async fn a_session_starts_as_each_case_of_the_shared_table_states() {
    let table: Value = serde_json::from_str(include_str!("../../../specs/src/session/cases.json"))
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
        // The script's last answer repeats, so a session that asks without
        // end is stopped by one answer more than the case allows: of the
        // gateway, an answer that is no refusal; of the issuer, none.
        let validations = (0..asks)
            .map(|n| match answer(&case["gateway"], n).as_str() {
                "accepts" => Ok(alice()),
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
        let renewed_tokens: Vec<String> =
            (0..renewals).map(|n| token(3600, n as u64 + 1)).collect();
        let renewing = (0..renewals).map(|n| match answer(&case["issuer"], n).as_str() {
            "renews" => Ok(Some(renewed_tokens[n].clone())),
            "refuses" => Ok(None),
            other => panic!("{why}: the issuer {other}"),
        });
        let world = World::new().validating(validations).renewing(renewing);
        let world = match case["stored"].as_str().expect("stored") {
            "none" => world,
            "unexpired" => world.storing(&token(3600, 0)),
            "expired" => world.storing(&expired()),
            other => panic!("{why}: a stored token that is {other}"),
        };
        let session = world.session();
        ready(&session).await;

        assert_eq!(
            (world.validated().len(), world.renewed()),
            (asks, renewals),
            "{why}: how often the gateway and the issuer were asked"
        );
        let ends = match (
            session.token().borrow().is_some(),
            session.user().borrow().is_some(),
        ) {
            (false, _) => "signed-out",
            (true, false) => "unconfirmed",
            (true, true) => "signed-in",
        };
        assert_eq!(ends, case["ends"].as_str().expect("ends"), "{why}");
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

        // A session that ended signed out asks nobody anything afterwards,
        // however long it is held.
        if ends == "signed-out" {
            tokio::time::sleep(Duration::from_secs(2 * 60 * 60)).await;
            assert_eq!(
                (world.validated().len(), world.renewed()),
                (asks, renewals),
                "{why}: what was asked once the session was over"
            );
        }
        session.close().await;
    }
}

/// What a running session does when the gateway refuses its token, as
/// specs/src/session/cases.json states it for every SDK (`refusal`).
#[tokio::test(start_paused = true)]
async fn a_refused_session_renews_and_asks_as_each_case_of_the_shared_table_states() {
    let table: Value = serde_json::from_str(include_str!("../../../specs/src/session/cases.json"))
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
        // The session starts signed in: the gateway accepts the stored token.
        // Then the case's answers, and one more than it allows: of the
        // gateway, an answer that is no refusal; of the issuer, none.
        let validations = std::iter::once(Ok(alice()))
            .chain(
                (0..asks).map(|n| match answer(&case["gateway"], n).as_str() {
                    "accepts" => Ok(alice()),
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
        let renewing = (0..renewals).map(|n| match answer(&case["issuer"], n).as_str() {
            "renews" => Ok(Some(renewed_token.clone())),
            "refuses" => Ok(None),
            other => panic!("{why}: the issuer {other}"),
        });
        let world = World::new()
            .storing(&token(3600, 0))
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

        // The gateway refused the session's token: its transport asks it to refresh.
        let given = session.refresh().await;

        assert_eq!(
            (world.validated().len() - 1, world.renewed()),
            (asks, renewals),
            "{why}: how often the gateway and the issuer were asked"
        );
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
        if ends == "signed-out" {
            tokio::time::sleep(Duration::from_secs(2 * 60 * 60)).await;
            assert_eq!(
                (world.validated().len() - 1, world.renewed()),
                (asks, renewals),
                "{why}: what was asked once the session was over"
            );
        }
        session.close().await;
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
    let session = SemiontSession::new(SemiontSessionConfig {
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
        async move { renewer.refresh().await }
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
    let session = SemiontSession::new(SemiontSessionConfig {
        refresh: Some(Arc::new(move || {
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
        async move { renewer.refresh().await }
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
        async move { renewer.refresh().await }
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
    let session = SemiontSession::new(SemiontSessionConfig {
        refresh: Some(Arc::new(move || {
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
    let (a, b, c) = tokio::join!(session.refresh(), session.refresh(), session.refresh());

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
    session.refresh().await;
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
    let session = SemiontSession::new(SemiontSessionConfig {
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
        async move { renewer.refresh().await }
    });
    settle().await;
    // Another context signs in again while the gateway is being asked.
    world
        .elsewhere
        .set(&session_key(KB), &stored(&other).written());
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

    assert_eq!(session.refresh().await, Some(renewed.clone()));
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

#[tokio::test(start_paused = true)]
async fn a_session_that_cannot_be_renewed_is_over_and_says_so_once() {
    let world = World::new().storing(&token(3600, 1));
    let session = world.session();
    ready(&session).await;

    assert_eq!(session.refresh().await, None);
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
    assert_eq!(session.refresh().await, None);
    assert_eq!(world.auth_failed().len(), 1);
    assert_eq!(world.errors().len(), 1);
}

#[tokio::test(start_paused = true)]
async fn a_renewal_that_failed_ends_the_session_as_a_refusal_does_and_names_its_cause() {
    let world = World::new()
        .storing(&token(3600, 1))
        .renewing([Err("the network is down".to_owned())]);
    let session = world.session();
    ready(&session).await;

    assert_eq!(session.refresh().await, None);
    assert!(!world.has_stored());
    assert_eq!(world.auth_failed(), ["expired"]);
    assert_eq!(
        world.errors(),
        [(
            SessionErrorCode::RefreshExhausted,
            "Token refresh failed: the network is down".to_owned()
        )]
    );
}

#[tokio::test(start_paused = true)]
async fn a_session_that_never_signed_in_cannot_expire() {
    let world = World::new();
    let session = world.session();
    ready(&session).await;

    assert_eq!(session.refresh().await, None);
    assert_eq!(world.renewed(), 1);
    assert!(world.auth_failed().is_empty());
    assert!(world.errors().is_empty());
}

#[tokio::test(start_paused = true)]
async fn a_session_given_no_way_to_renew_asks_nothing_and_ends_nothing() {
    let access = token(3600, 1);
    let world = World::new().storing(&access);
    let session = SemiontSession::new(SemiontSessionConfig {
        refresh: None,
        ..world.config()
    });
    ready(&session).await;

    assert_eq!(session.refresh().await, None);
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
    first.close().await;
    assert_eq!(first.id(), id);
}

// ── How it ends ─────────────────────────────────────────────────────────

#[tokio::test(start_paused = true)]
async fn closing_a_session_ends_what_it_holds_and_closes_its_client() {
    let world = World::new()
        .storing(&token(300, 1))
        .renewing([Ok(Some(token(300, 2)))]);
    let session = world.session();
    ready(&session).await;
    let (mut held, mut user) = (session.token(), session.user());

    session.close().await;
    session.close().await;

    assert!(held.ended() && user.ended());
    assert!(world.client.bus().destroyed());
    // Nothing it had scheduled runs, and nothing it is told does anything.
    tokio::time::sleep(Duration::from_secs(600)).await;
    assert_eq!(world.renewed(), 0);
    assert_eq!(session.refresh().await, None);
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

// ── What another context writes ─────────────────────────────────────────

#[tokio::test(start_paused = true)]
async fn a_token_another_context_renewed_is_taken_up() {
    let world = World::new().storing(&token(3600, 1));
    let session = world.session();
    ready(&session).await;

    let renewed = token(3600, 2);
    world
        .elsewhere
        .set(&session_key(KB), &stored(&renewed).written());

    assert_eq!(session.token().borrow().as_deref(), Some(renewed.as_str()));
    assert_eq!(*session.user().borrow(), Some(alice()));
}

#[tokio::test(start_paused = true)]
async fn a_sign_out_in_another_context_signs_this_one_out() {
    let world = World::new().storing(&token(3600, 1));
    let session = world.session();
    ready(&session).await;

    world.elsewhere.delete(&session_key(KB));

    assert_eq!(*session.token().borrow(), None);
    assert_eq!(*session.user().borrow(), None);
    // Signed out, not expired: nobody is told the session failed.
    assert!(world.auth_failed().is_empty());
}

#[tokio::test(start_paused = true)]
async fn what_another_context_writes_elsewhere_or_unreadably_changes_nothing() {
    let access = token(3600, 1);
    let world = World::new().storing(&access);
    let session = world.session();
    ready(&session).await;

    world.elsewhere.set(
        &session_key("another-kb"),
        &stored(&token(3600, 2)).written(),
    );
    world.elsewhere.set("semiont.knowledgeBases", "[]");
    world.elsewhere.set(&session_key(KB), "not a session");
    world.elsewhere.set(&session_key(KB), r#"{"access": 7}"#);

    assert_eq!(session.token().borrow().as_deref(), Some(access.as_str()));
    assert_eq!(*session.user().borrow(), Some(alice()));
}

#[tokio::test(start_paused = true)]
async fn a_closed_session_hears_nothing_of_the_storage() {
    let access = token(3600, 1);
    let world = World::new().storing(&access);
    let session = world.session();
    ready(&session).await;
    session.close().await;

    world
        .elsewhere
        .set(&session_key(KB), &stored(&token(3600, 2)).written());
    settle().await;

    // What it held when it ended is what it shows: nothing after is taken up.
    assert_eq!(session.token().borrow().as_deref(), Some(access.as_str()));
}

// ── What a host shows about a session ───────────────────────────────────

fn ended(reason: SessionEndReason) -> Option<SessionEnded> {
    Some(SessionEnded { reason })
}

fn denied(detail: Option<&str>) -> Option<PermissionDenied> {
    Some(PermissionDenied {
        detail: detail.map(str::to_owned),
    })
}

#[test]
fn nothing_is_raised_until_something_is() {
    let signals = SessionSignals::new();
    assert_eq!(*signals.session_ended().borrow(), None);
    assert_eq!(*signals.permission_denied().borrow(), None);
    assert_eq!(*signals.kb_identity_conflict().borrow(), None);
}

#[test]
fn a_notice_carries_what_happened_not_a_sentence() {
    let signals = SessionSignals::new();
    signals.notify_session_ended(SessionEndReason::Refused);
    signals.notify_permission_denied(Some("Archiving needs the curator role."));
    assert_eq!(
        *signals.session_ended().borrow(),
        ended(SessionEndReason::Refused)
    );
    assert_eq!(
        *signals.permission_denied().borrow(),
        denied(Some("Archiving needs the curator role."))
    );
}

#[test]
fn a_gateway_that_said_nothing_is_no_detail_never_a_sentence_made_up_for_it() {
    let signals = SessionSignals::new();
    signals.notify_permission_denied(None);
    assert_eq!(*signals.permission_denied().borrow(), denied(None));
}

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

#[test]
fn acknowledging_a_signal_lowers_it() {
    let signals = SessionSignals::new();
    let conflict = KbIdentityConflict {
        expected_did: "did:web:example.org:kb-a".to_owned(),
        observed_did: "did:web:example.org:kb-b".to_owned(),
    };
    signals.notify_session_ended(SessionEndReason::Expired);
    signals.notify_permission_denied(None);
    signals.notify_kb_identity_conflict(conflict.clone());
    assert_eq!(*signals.kb_identity_conflict().borrow(), Some(conflict));

    signals.acknowledge_session_ended();
    signals.acknowledge_permission_denied();
    signals.acknowledge_kb_identity_conflict();
    assert_eq!(*signals.session_ended().borrow(), None);
    assert_eq!(*signals.permission_denied().borrow(), None);
    assert_eq!(*signals.kb_identity_conflict().borrow(), None);
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
