//! The renewal of a kept sign-in (`renew_kept`), which is the crate's own:
//! how it rides out an issuer, and every renewal of
//! protocol/specs/src/sign-in-store/cases.json over each sign-in kept here:
//! an entry of the file `semiont login` keeps, one kept in memory, and one a
//! registry keeps in its storage.

use super::renew_kept;
use axum::Router;
use axum::extract::State;
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use semiont::errors::SignInError;
use semiont::session::{MemorySignIn, SignInKept, StoredSession, kept_in, person_key};
use semiont::sign_in_store::{FILE_NAME, SignInStore};
use semiont::storage::{InMemorySessionStorage, SessionStorage};
use semiont::timing::{HTTP_REQUEST_TIMEOUT, REFRESH_RETRY};
use semiont::transport::BoxFuture;
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet, VecDeque};
use std::error::Error;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const ALICE: &str = "did:web:example.org:users:alice";

// ── An issuer that renews ───────────────────────────────────────────────

/// What the issuer answers, and what it was asked.
#[derive(Default)]
struct Staged {
    /// What each token request is answered, in order; a refused grant once
    /// they are spent. A null answer is no JSON at all.
    answers: Mutex<VecDeque<(u16, Value)>>,
    /// The form of each token request.
    forms: Mutex<Vec<HashMap<String, String>>>,
    /// Whether a token request is never answered.
    silent: Mutex<bool>,
}

fn form(body: &str) -> HashMap<String, String> {
    reqwest::Url::parse(&format!("http://form/?{body}"))
        .expect("a form")
        .query_pairs()
        .map(|(name, value)| (name.into_owned(), value.into_owned()))
        .collect()
}

async fn token(State(staged): State<Arc<Staged>>, body: String) -> Response {
    staged.forms.lock().unwrap().push(form(&body));
    let silent = *staged.silent.lock().unwrap();
    if silent {
        std::future::pending::<()>().await;
    }
    let (status, answer) = staged
        .answers
        .lock()
        .unwrap()
        .pop_front()
        .unwrap_or((400, json!({ "error": "invalid_grant" })));
    let status = StatusCode::from_u16(status).expect("a status");
    if answer.is_null() {
        return status.into_response();
    }
    (
        status,
        [(header::CONTENT_TYPE, "application/json")],
        answer.to_string(),
    )
        .into_response()
}

/// The clock of a test that waits out long times over real sockets, in a
/// test whose runtime starts paused: held still, as the runtime does while
/// a blocking task runs, and moved by hand, `STEP` for each real
/// millisecond, so an answer on its way arrives long before its deadline.
struct QuickClock(tokio::task::JoinHandle<()>);

const STEP: Duration = Duration::from_millis(250);

impl QuickClock {
    fn start() -> QuickClock {
        QuickClock(tokio::spawn(async {
            loop {
                let _ = tokio::task::spawn_blocking(|| {
                    std::thread::sleep(Duration::from_millis(1));
                })
                .await;
                tokio::time::advance(STEP).await;
            }
        }))
    }
}

impl Drop for QuickClock {
    fn drop(&mut self) {
        self.0.abort();
    }
}

struct Issuer {
    origin: String,
    staged: Arc<Staged>,
    server: tokio::task::JoinHandle<()>,
    http: reqwest::Client,
    clock: Option<QuickClock>,
}

impl Drop for Issuer {
    fn drop(&mut self) {
        self.server.abort();
    }
}

impl Issuer {
    /// For a test whose runtime starts paused.
    async fn on_a_quick_clock() -> Issuer {
        let clock = QuickClock::start();
        let mut issuer = Issuer::start().await;
        issuer.clock = Some(clock);
        issuer
    }

    async fn start() -> Issuer {
        // Already installed by another test of this process: one is enough.
        let _ = rustls::crypto::ring::default_provider().install_default();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("a port");
        let origin = format!(
            "http://127.0.0.1:{}",
            listener.local_addr().expect("an address").port()
        );
        let staged = Arc::new(Staged::default());
        let app = Router::new()
            .route("/token", post(token))
            .with_state(staged.clone());
        let server = tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        Issuer {
            origin,
            staged,
            server,
            http: reqwest::Client::new(),
            clock: None,
        }
    }

    fn answers(&self, answers: impl IntoIterator<Item = (u16, Value)>) {
        self.staged.answers.lock().unwrap().extend(answers);
    }

    fn never_answers(&self) {
        *self.staged.silent.lock().unwrap() = true;
    }

    fn forms(&self) -> Vec<HashMap<String, String>> {
        self.staged.forms.lock().unwrap().clone()
    }

    fn token_endpoint(&self) -> String {
        format!("{}/token", self.origin)
    }

    fn stored(&self, access: &str, refresh: &str) -> StoredSession {
        StoredSession {
            access: access.to_owned(),
            refresh: refresh.to_owned(),
            client_id: "semiont-browser".to_owned(),
            token_endpoint: self.token_endpoint(),
            revocation_endpoint: Some(format!("{}/revoke", self.origin)),
            person_key: None,
        }
    }
}

fn granted(access: &str, refresh: Option<&str>) -> (u16, Value) {
    let mut answer = json!({ "access_token": access, "token_type": "Bearer" });
    if let Some(refresh) = refresh {
        answer["refresh_token"] = json!(refresh);
    }
    (200, answer)
}

/// The sign-in error a failure is.
fn sign_in_error(failure: Box<dyn Error + Send + Sync>) -> SignInError {
    match failure.downcast::<SignInError>() {
        Ok(refused) => *refused,
        Err(other) => panic!("{other} is not a sign-in error"),
    }
}

/// A registry's sign-in of "kb-a", kept in its storage, holding `sign_in`.
async fn kept_holding(sign_in: StoredSession) -> Arc<dyn SignInKept> {
    let storage: Arc<dyn SessionStorage> = Arc::new(InMemorySessionStorage::new());
    let kept = kept_in(storage, "kb-a");
    kept.keep(sign_in).await.expect("kept");
    kept
}

/// What `kept` holds: a read that fails is no answer.
async fn held_by(kept: &dyn SignInKept) -> Option<StoredSession> {
    kept.held().await.expect("the sign-in is read")
}

// ── How a renewal rides out its issuer ──────────────────────────────────

#[tokio::test(start_paused = true)]
async fn a_renewal_rides_out_an_issuer_that_says_not_now_and_keeps_the_rotation() {
    let issuer = Issuer::on_a_quick_clock().await;
    let kept = kept_holding(issuer.stored("a1", "r1")).await;
    issuer.answers([
        (503, Value::Null),
        (429, json!({ "error": "slow_down" })),
        granted("a2", Some("r2")),
    ]);

    let renewed = renew_kept(kept.as_ref(), Some("a1"), &issuer.http)
        .await
        .expect("renewed");

    assert_eq!(renewed, Some("a2".to_owned()));
    assert_eq!(issuer.forms().len(), 3);
    assert_eq!(
        held_by(kept.as_ref()).await,
        Some(issuer.stored("a2", "r2"))
    );
}

#[tokio::test]
async fn a_renewal_keeps_the_person_the_sign_in_names() {
    let issuer = Issuer::start().await;
    let naming = |access: &str, refresh: &str| StoredSession {
        person_key: Some(person_key(ALICE)),
        ..issuer.stored(access, refresh)
    };
    let kept = kept_holding(naming("a1", "r1")).await;
    issuer.answers([granted("a2", Some("r2"))]);

    let renewed = renew_kept(kept.as_ref(), Some("a1"), &issuer.http)
        .await
        .expect("renewed");

    assert_eq!(renewed, Some("a2".to_owned()));
    assert_eq!(held_by(kept.as_ref()).await, Some(naming("a2", "r2")));
}

/// With nothing kept there is nothing to renew: no failure, and the issuer
/// is not asked.
#[tokio::test]
async fn with_nothing_kept_a_renewal_gives_nothing_and_asks_nobody() {
    let issuer = Issuer::start().await;

    let renewed = renew_kept(&MemorySignIn::new(), Some("a1"), &issuer.http)
        .await
        .expect("no failure");

    assert_eq!(renewed, None);
    assert!(issuer.forms().is_empty());
}

#[tokio::test(start_paused = true)]
async fn a_refused_grant_is_final_on_its_first_answer() {
    let issuer = Issuer::on_a_quick_clock().await;
    for refusal in [
        (400, json!({ "error": "invalid_grant" })),
        (401, json!({ "error": "invalid_client" })),
        (404, Value::Null),
    ] {
        let kept = kept_holding(issuer.stored("a1", "r1")).await;
        let before = issuer.forms().len();
        issuer.answers([refusal.clone(), granted("never", None)]);

        let refused = renew_kept(kept.as_ref(), Some("a1"), &issuer.http)
            .await
            .map_err(sign_in_error)
            .expect_err("the grant is refused");

        assert_eq!(refused.status, Some(refusal.0));
        assert!(
            refused
                .message
                .starts_with("The issuer refused the token request"),
            "{refused}"
        );
        assert_eq!(issuer.forms().len(), before + 1);
        assert_eq!(
            held_by(kept.as_ref()).await,
            Some(issuer.stored("a1", "r1"))
        );
        issuer.staged.answers.lock().unwrap().clear();
    }
}

#[tokio::test(start_paused = true)]
async fn a_renewal_that_is_never_answered_gives_up_and_says_how_hard_it_tried() {
    let issuer = Issuer::on_a_quick_clock().await;
    let kept = kept_holding(issuer.stored("a1", "r1")).await;
    issuer.answers((0..10).map(|_| (503, Value::Null)));

    let refused = renew_kept(kept.as_ref(), Some("a1"), &issuer.http)
        .await
        .map_err(sign_in_error)
        .expect_err("the budget is spent");

    assert_eq!(issuer.forms().len(), 4);
    assert_eq!(
        refused.message,
        "The session could not be renewed after 4 attempts: The issuer refused the token request (HTTP 503)"
    );

    // And one that got no answer at all is tried as often.
    let nowhere = kept_holding(StoredSession {
        token_endpoint: "http://127.0.0.1:9/token".to_owned(),
        ..issuer.stored("a1", "r1")
    })
    .await;
    let unanswered = renew_kept(nowhere.as_ref(), Some("a1"), &issuer.http)
        .await
        .map_err(sign_in_error)
        .expect_err("nothing is there");
    assert_eq!(unanswered.status, None);
    assert!(
        unanswered
            .message
            .starts_with("The session could not be renewed after 4 attempts:"),
        "{unanswered}"
    );
}

#[tokio::test(start_paused = true)]
async fn a_renewal_the_issuer_never_answers_is_tried_inside_the_budget_and_then_given_up() {
    let issuer = Issuer::on_a_quick_clock().await;
    issuer.never_answers();
    let kept = kept_holding(issuer.stored("a1", "r1")).await;
    let started = tokio::time::Instant::now();

    let refused = tokio::time::timeout(
        Duration::from_secs(600),
        renew_kept(kept.as_ref(), Some("a1"), &issuer.http),
    )
    .await
    .expect("it ends")
    .map_err(sign_in_error)
    .expect_err("the budget is spent");

    let attempts = REFRESH_RETRY.attempts;
    assert_eq!(issuer.forms().len(), attempts as usize);
    assert_eq!(
        refused.message,
        format!(
            "The session could not be renewed after {attempts} attempts: The issuer did not answer within 30s"
        )
    );
    // Each attempt waited out its deadline, and the backoff came between.
    assert!(started.elapsed() >= HTTP_REQUEST_TIMEOUT * attempts);
    assert!(started.elapsed() < HTTP_REQUEST_TIMEOUT * (attempts + 1));
    // The sign-in it could not renew is still the one kept.
    assert_eq!(
        held_by(kept.as_ref()).await,
        Some(issuer.stored("a1", "r1"))
    );
}

// ── What a renewal keeps while other programs renew and sign out ──────

/// The renewer's sign-in, on which another program acts between the
/// renewal's read and its write: while its grant is in flight.
struct Meanwhile {
    renewer: Arc<dyn SignInKept>,
    act: Mutex<Option<BoxFuture<'static, ()>>>,
}

impl SignInKept for Meanwhile {
    fn held(&self) -> BoxFuture<'_, Result<Option<StoredSession>, Box<dyn Error + Send + Sync>>> {
        Box::pin(async move {
            let found = self.renewer.held().await;
            let act = self.act.lock().unwrap().take();
            if let Some(act) = act {
                act.await;
            }
            found
        })
    }

    fn keep(
        &self,
        sign_in: StoredSession,
    ) -> BoxFuture<'_, Result<(), Box<dyn Error + Send + Sync>>> {
        self.renewer.keep(sign_in)
    }

    fn renewed<'a>(
        &'a self,
        read: &'a StoredSession,
        access: &'a str,
        refresh: &'a str,
    ) -> BoxFuture<'a, Result<Option<String>, Box<dyn Error + Send + Sync>>> {
        self.renewer.renewed(read, access, refresh)
    }

    fn record_person_key<'a>(
        &'a self,
        access: &'a str,
        person_key: &'a str,
    ) -> BoxFuture<'a, Result<bool, Box<dyn Error + Send + Sync>>> {
        self.renewer.record_person_key(access, person_key)
    }

    fn forget(&self) -> BoxFuture<'_, Result<(), Box<dyn Error + Send + Sync>>> {
        self.renewer.forget()
    }
}

/// A directory of its own, removed when the test is done with it.
struct Home(std::path::PathBuf);

impl Home {
    fn new() -> Home {
        let dir = std::env::temp_dir().join(format!("semiont-renewal-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("a directory");
        Home(dir)
    }
}

impl Drop for Home {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// The name of an access token a renewal row minted: its `jti`.
fn named(token: &str) -> String {
    token
        .split('.')
        .nth(1)
        .and_then(|claims| URL_SAFE_NO_PAD.decode(claims).ok())
        .and_then(|claims| serde_json::from_slice::<Value>(&claims).ok())
        .and_then(|claims| claims["jti"].as_str().map(str::to_owned))
        .unwrap_or_else(|| token.to_owned())
}

/// Each access token a renewal row names, as a JWT of its own: it names who
/// signed in and at which issuer, and expires an hour from now, or an hour
/// ago when the row lists it in `expired`.
fn minting(issuer: &Issuer, row: &Value) -> impl Fn(&str) -> String {
    let expired: Vec<String> = row["expired"]
        .as_array()
        .expect("expired")
        .iter()
        .map(|name| name.as_str().expect("a name").to_owned())
        .collect();
    let at = issuer.origin.clone();
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("after the epoch")
        .as_secs() as i64;
    move |name: &str| {
        let expiry = if expired.iter().any(|lapsed| lapsed == name) {
            now - 3600
        } else {
            now + 3600
        };
        let claims = json!({ "email": "alice@example.org", "iss": at, "exp": expiry, "jti": name });
        format!(
            "{}.{}.sig",
            URL_SAFE_NO_PAD.encode(r#"{"alg":"none"}"#),
            URL_SAFE_NO_PAD.encode(claims.to_string())
        )
    }
}

/// A sign-in as a renewal row states one: of the script client, at the
/// issuer.
fn stated_sign_in(
    issuer: &Issuer,
    token: &impl Fn(&str) -> String,
    stated: &Value,
) -> StoredSession {
    StoredSession {
        access: token(stated["token"].as_str().expect("a token")),
        refresh: stated["refreshToken"]
            .as_str()
            .expect("a refresh token")
            .to_owned(),
        client_id: "semiont-cli".to_owned(),
        token_endpoint: issuer.token_endpoint(),
        revocation_endpoint: None,
        person_key: None,
    }
}

/// Each way what a renewal did is not what its row says: the grants it
/// made, the access token it gave, and what is kept after it.
fn judged(
    issuer: &Issuer,
    row: &Value,
    given: Result<Option<String>, Box<dyn Error + Send + Sync>>,
    left: Option<StoredSession>,
) -> Vec<String> {
    let mut wrong = Vec::new();
    let spent: Vec<String> = issuer
        .forms()
        .iter()
        .map(|form| form["refresh_token"].clone())
        .collect();
    let spends: Vec<String> = row["spends"]
        .as_str()
        .map(str::to_owned)
        .into_iter()
        .collect();
    if spent != spends {
        wrong.push(format!("grants were made with {spent:?}, want {spends:?}"));
    }
    match given {
        Ok(given) => {
            let given = given.as_deref().map(named);
            let gives = row["gives"].as_str().map(str::to_owned);
            if given != gives {
                wrong.push(format!("gave {given:?}, want {gives:?}"));
            }
        }
        Err(failed) => wrong.push(format!("the renewal failed: {failed}")),
    }
    let left = left.map(|left| (named(&left.access), left.refresh));
    let leaves = row["leaves"].as_object().map(|leaves| {
        (
            leaves["token"].as_str().expect("a token").to_owned(),
            leaves["refreshToken"]
                .as_str()
                .expect("a refresh token")
                .to_owned(),
        )
    });
    if left != leaves {
        wrong.push(format!("the store holds {left:?}, want {leaves:?}"));
    }
    wrong
}

/// What one renewal row comes to, over one sign-in kept: each way it is
/// not the row's.
async fn renewed_as_the_row_says(row: &Value, store: &str) -> Vec<String> {
    let issuer = Issuer::start().await;
    let home = Home::new();
    // The renewer's sign-in, and another program's.
    let (renewer, another): (Arc<dyn SignInKept>, Arc<dyn SignInKept>) = match store {
        "SignInStore" => (
            SignInStore::at(home.0.join(FILE_NAME)).entry("local"),
            SignInStore::at(home.0.join(FILE_NAME)).entry("local"),
        ),
        "MemorySignIn" => {
            let shared: Arc<dyn SignInKept> = Arc::new(MemorySignIn::new());
            (shared.clone(), shared)
        }
        "kept_in" => {
            let shared: Arc<dyn SessionStorage> = Arc::new(InMemorySessionStorage::new());
            (kept_in(shared.clone(), "local"), kept_in(shared, "local"))
        }
        other => panic!("no store is {other}"),
    };
    let token = minting(&issuer, row);
    another
        .keep(stated_sign_in(&issuer, &token, &row["kept"]))
        .await
        .expect("kept");
    let meanwhile = &row["meanwhile"];
    let act: Option<BoxFuture<'static, ()>> = match meanwhile["does"].as_str() {
        None => None,
        Some("renews") => {
            let (another, theirs) = (
                another.clone(),
                stated_sign_in(&issuer, &token, &meanwhile["theirs"]),
            );
            Some(Box::pin(async move {
                another.keep(theirs).await.expect("kept");
            }))
        }
        Some("signs-out") => {
            let another = another.clone();
            Some(Box::pin(async move {
                another.forget().await.expect("forgotten");
            }))
        }
        Some(other) => panic!("another program {other}"),
    };
    let issues = &row["issues"];
    issuer.answers([granted(
        &token(issues["token"].as_str().expect("a token")),
        issues["refreshToken"].as_str(),
    )]);
    let renewing: Arc<dyn SignInKept> = match (meanwhile["when"].as_str(), act) {
        (_, None) => renewer.clone(),
        (Some("before"), Some(act)) => {
            act.await;
            renewer.clone()
        }
        (Some("during"), Some(act)) => Arc::new(Meanwhile {
            renewer: renewer.clone(),
            act: Mutex::new(Some(act)),
        }),
        (when, _) => panic!("another program acts {when:?}"),
    };
    let holding = row["holding"].as_str().map(&token);

    let given = renew_kept(renewing.as_ref(), holding.as_deref(), &issuer.http).await;

    let left = renewer.held().await.expect("what is kept is read");
    judged(&issuer, row, given, left)
}

#[tokio::test]
async fn every_renewal_is_the_tables() {
    let table: Value = serde_json::from_str(include_str!(
        "../../../../../protocol/specs/src/sign-in-store/cases.json"
    ))
    .expect("the table");
    let rows = table["renewals"].as_array().expect("the renewals");
    assert!(!rows.is_empty(), "the table has no renewals");
    let members = HashSet::from([
        "why",
        "kept",
        "holding",
        "meanwhile",
        "expired",
        "issues",
        "spends",
        "leaves",
        "gives",
    ]);
    let mut wrong = Vec::new();
    for row in rows {
        let stated: HashSet<&str> = row
            .as_object()
            .expect("a row")
            .keys()
            .map(String::as_str)
            .collect();
        assert_eq!(stated, members, "{row}");
        let why = row["why"].as_str().expect("why");
        for store in ["SignInStore", "MemorySignIn", "kept_in"] {
            for failure in renewed_as_the_row_says(row, store).await {
                wrong.push(format!("{store}, {why}: {failure}"));
            }
        }
    }
    assert!(wrong.is_empty(), "{}", wrong.join("\n"));
}
