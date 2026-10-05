//! Signing a person in, and their sessions over a gateway: the issuer's
//! grants, a stored session's renewal, a session built over HTTP, a
//! registry's sign-in landing on the knowledge base that answered, the
//! launcher's discovery document over HTTP, and the loopback redirect.
//!
//! One stand-in serves as the gateway and as the issuer it trusts. A test
//! says what each answers and reads what each was asked.

use axum::Router;
use axum::body::Body;
use axum::extract::{Path as Named, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use bytes::Bytes;
use semiont::client::ClientOptions;
use semiont::discovery::{
    DiscoveryAbsentReason, DiscoveryRead, DiscoveryState, DiscoveryTransport,
};
use semiont::errors::{IdentityUnverifiableReason, SessionErrorCode, SignInError, SignInErrorCode};
use semiont::session::{
    HttpEndpoint, KbEndpoint, KbTarget, KnowledgeBase, Protocol, SemiontBrowser,
    SemiontBrowserConfig, SemiontSession, SessionEndReason, StoredSession, save_knowledge_bases,
    session_key, store_session, stored_session,
};
use semiont::sign_in_store::{FILE_NAME, SignInStore};
use semiont::storage::{InMemorySessionStorage, SessionStorage};
use semiont::testing::as_id;
use semiont::testing::examples::assert_readme_shows;
use semiont::timing::{HTTP_REQUEST_TIMEOUT, REFRESH_RETRY};
use semiont::transport::PutBinaryRequest;
use semiont::types::JobCompleteCommand;
use semiont_http_transport::agent::{Agent, AgentToken};
use semiont_http_transport::client::client;
use semiont_http_transport::discovery::http_discovery;
use semiont_http_transport::loopback::LoopbackRedirect;
use semiont_http_transport::oauth::{
    BeginAuthorization, DeviceCode, PENDING_AUTHORIZATION_KEY, PendingAuthorization,
    begin_authorization, code_challenge, complete_authorization, discover_issuer,
    refresh_at_issuer, refresh_stored_session, revoke_at_issuer, sign_in_with_device_grant,
};
use semiont_http_transport::service_account::{Credential, ServiceToken};
use semiont_http_transport::session::{
    CompleteSignInError, HttpSessionFactory, IssuedSession, SignInDevice, StoredSignIn,
    begin_sign_in, complete_sign_in, describe_connection, session_from_issued, session_from_stored,
    sign_in_device,
};
use semiont_http_transport::transport::{HttpTransportConfig, Timing};
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet, VecDeque};
use std::error::Error;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::sync::mpsc;
use tokio_stream::StreamExt;
use tokio_stream::wrappers::UnboundedReceiverStream;

// ── The stand-in ────────────────────────────────────────────────────────

/// What the knowledge base says when it is asked who it is.
#[derive(Clone)]
enum Describes {
    As(Value),
    Refusing,
}

struct Staged {
    origin: Mutex<String>,
    /// The issuers the gateway's resource metadata lists; `None` is no
    /// metadata at all.
    trusts: Mutex<Option<Vec<String>>>,
    /// The issuer the discovery document says it is of.
    names_itself: Mutex<Option<String>>,
    offers_device: Mutex<bool>,
    /// What the token endpoint answers, in order; a refused grant once spent.
    token_answers: Mutex<VecDeque<(u16, Value)>>,
    token_forms: Mutex<Vec<HashMap<String, String>>>,
    device_answer: Mutex<(u16, Value)>,
    device_forms: Mutex<Vec<HashMap<String, String>>>,
    revoke_status: Mutex<u16>,
    revoke_forms: Mutex<Vec<HashMap<String, String>>>,
    /// The tokens the gateway refuses when it is asked who they are.
    refused: Mutex<Vec<String>>,
    /// Whether the gateway refuses every token: asked who it is, and asked
    /// for a stream.
    refuses_everyone: Mutex<bool>,
    /// The tokens whose emits its bus refuses outright.
    refused_on_the_bus: Mutex<Vec<String>>,
    /// The tokens it was asked about, in order.
    asked_who: Mutex<Vec<String>>,
    /// What it accepts a request for and never answers: `who`, `metadata`,
    /// `issuer`, `token`, `revoke`, `agent`, `document`, `content`.
    silent: Mutex<HashSet<&'static str>>,
    /// Whether, asked who a token is, it begins its answer and never
    /// finishes it.
    trails_off: Mutex<bool>,
    /// How long it takes to answer an upload.
    upload_takes: Mutex<Duration>,
    describes: Mutex<Describes>,
    /// What the gateway answers the other requests with: by request channel,
    /// the channel of the answer and its payload.
    answers: Mutex<HashMap<String, (String, Value)>>,
    /// What each stream was opened with.
    subscriptions: Mutex<Vec<Value>>,
    streams: Mutex<Vec<mpsc::UnboundedSender<Bytes>>>,
    /// The discovery document: its status, content type, body and tag.
    discovery: Mutex<(u16, String, String, Option<String>)>,
    discovery_reads: Mutex<usize>,
}

fn form(body: &str) -> HashMap<String, String> {
    reqwest::Url::parse(&format!("http://form/?{body}"))
        .expect("a form")
        .query_pairs()
        .map(|(name, value)| (name.into_owned(), value.into_owned()))
        .collect()
}

fn bearer(headers: &HeaderMap) -> String {
    headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .unwrap_or_default()
        .to_owned()
}

fn json_answer(status: u16, body: Value) -> Response {
    (
        StatusCode::from_u16(status).expect("a status"),
        [(header::CONTENT_TYPE, "application/json")],
        body.to_string(),
    )
        .into_response()
}

impl Staged {
    /// Never returns when the test said this is never answered.
    async fn held(&self, what: &str) {
        if self.silent.lock().unwrap().contains(what) {
            std::future::pending::<()>().await;
        }
    }
}

async fn resource_metadata(State(staged): State<Arc<Staged>>) -> Response {
    staged.held("metadata").await;
    match staged.trusts.lock().unwrap().clone() {
        None => StatusCode::NOT_FOUND.into_response(),
        Some(issuers) => json_answer(
            200,
            json!({
                "resource": "https://example.org/kb-a",
                "authorization_servers": issuers,
                "bearer_methods_supported": ["header"],
            }),
        ),
    }
}

async fn openid_configuration(State(staged): State<Arc<Staged>>) -> Response {
    staged.held("issuer").await;
    let origin = staged.origin.lock().unwrap().clone();
    let issuer = format!("{origin}/realms/semiont");
    let mut document = json!({
        "issuer": staged.names_itself.lock().unwrap().clone().unwrap_or(issuer.clone()),
        "authorization_endpoint": format!("{issuer}/auth"),
        "token_endpoint": format!("{issuer}/token"),
        "revocation_endpoint": format!("{issuer}/revoke"),
    });
    if *staged.offers_device.lock().unwrap() {
        document["device_authorization_endpoint"] = json!(format!("{issuer}/device"));
    }
    json_answer(200, document)
}

async fn token(State(staged): State<Arc<Staged>>, body: String) -> Response {
    staged.token_forms.lock().unwrap().push(form(&body));
    staged.held("token").await;
    let (status, answer) = staged
        .token_answers
        .lock()
        .unwrap()
        .pop_front()
        .unwrap_or((400, json!({ "error": "invalid_grant" })));
    // An answer that is not JSON at all, for the issuer that is not there.
    if answer.is_null() {
        return StatusCode::from_u16(status)
            .expect("a status")
            .into_response();
    }
    json_answer(status, answer)
}

async fn device(State(staged): State<Arc<Staged>>, body: String) -> Response {
    staged.device_forms.lock().unwrap().push(form(&body));
    let (status, answer) = staged.device_answer.lock().unwrap().clone();
    json_answer(status, answer)
}

async fn revoke(State(staged): State<Arc<Staged>>, body: String) -> Response {
    staged.revoke_forms.lock().unwrap().push(form(&body));
    staged.held("revoke").await;
    StatusCode::from_u16(*staged.revoke_status.lock().unwrap())
        .expect("a status")
        .into_response()
}

async fn me(State(staged): State<Arc<Staged>>, headers: HeaderMap) -> Response {
    let token = bearer(&headers);
    staged.asked_who.lock().unwrap().push(token.clone());
    staged.held("who").await;
    if *staged.trails_off.lock().unwrap() {
        let begun = tokio_stream::once(Ok::<Bytes, std::convert::Infallible>(Bytes::from_static(
            b"{\"did\":",
        )))
        .chain(tokio_stream::pending());
        return (
            [(header::CONTENT_TYPE, "application/json")],
            Body::from_stream(begun),
        )
            .into_response();
    }
    if token.is_empty()
        || *staged.refuses_everyone.lock().unwrap()
        || staged.refused.lock().unwrap().contains(&token)
    {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    json_answer(
        200,
        json!({
            "did": "did:web:example.org:users:alice", "email": "alice@example.org",
            "name": "Alice", "image": null, "domain": "example.org",
        }),
    )
}

/// The gateway's exchange of a service account's token for an agent's.
async fn agent_token(State(staged): State<Arc<Staged>>, headers: HeaderMap) -> Response {
    staged.held("agent").await;
    if bearer(&headers).is_empty() {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    json_answer(
        200,
        json!({ "token": jwt(3600, 99), "did": "did:web:example.org:agents:indexer" }),
    )
}

async fn subscribe(State(staged): State<Arc<Staged>>, body: String) -> Response {
    staged
        .subscriptions
        .lock()
        .unwrap()
        .push(serde_json::from_str(&body).expect("a subscription"));
    if *staged.refuses_everyone.lock().unwrap() {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let (events, stream) = mpsc::unbounded_channel();
    staged.streams.lock().unwrap().push(events);
    let body = UnboundedReceiverStream::new(stream).map(Ok::<Bytes, std::convert::Infallible>);
    (
        [(header::CONTENT_TYPE, "text/event-stream")],
        Body::from_stream(body),
    )
        .into_response()
}

async fn emit(State(staged): State<Arc<Staged>>, headers: HeaderMap, body: String) -> Response {
    if staged
        .refused_on_the_bus
        .lock()
        .unwrap()
        .contains(&bearer(&headers))
    {
        return StatusCode::BAD_REQUEST.into_response();
    }
    let sent: Value = serde_json::from_str(&body).expect("an emit");
    let asked = sent["channel"].as_str().unwrap_or_default();
    let answer = if asked == "browse:kb-requested" {
        Some(match staged.describes.lock().unwrap().clone() {
            Describes::As(description) => (
                "browse:kb-result".to_owned(),
                json!({ "response": description }),
            ),
            Describes::Refusing => (
                "browse:kb-failed".to_owned(),
                json!({ "message": "this knowledge base cannot say what it is" }),
            ),
        })
    } else {
        staged.answers.lock().unwrap().get(asked).cloned()
    };
    if let (Some((channel, payload)), Some(correlation_id)) =
        (answer, sent["correlationId"].as_str())
    {
        let frame =
            json!({ "channel": channel, "correlationId": correlation_id, "payload": payload });
        let event = Bytes::from(format!(
            "event: bus-event\nid: e-{channel}:{correlation_id}\ndata: {frame}\n\n"
        ));
        for stream in staged.streams.lock().unwrap().iter() {
            let _ = stream.send(event.clone());
        }
    }
    json_answer(202, json!({}))
}

/// A resource's bytes.
async fn content(State(staged): State<Arc<Staged>>, Named(id): Named<String>) -> Response {
    staged.held("content").await;
    (
        [(header::CONTENT_TYPE, "text/plain")],
        format!("the bytes of {id}"),
    )
        .into_response()
}

/// An upload, answered once it has taken as long as the test said.
async fn upload(State(staged): State<Arc<Staged>>) -> Response {
    let takes = *staged.upload_takes.lock().unwrap();
    tokio::time::sleep(takes).await;
    json_answer(201, json!({ "resourceId": "res-new" }))
}

async fn discovery(State(staged): State<Arc<Staged>>, headers: HeaderMap) -> Response {
    *staged.discovery_reads.lock().unwrap() += 1;
    staged.held("document").await;
    let (status, content_type, body, etag) = staged.discovery.lock().unwrap().clone();
    let known = headers
        .get(header::IF_NONE_MATCH)
        .and_then(|value| value.to_str().ok());
    if etag.is_some() && known == etag.as_deref() {
        return StatusCode::NOT_MODIFIED.into_response();
    }
    let mut response = (
        StatusCode::from_u16(status).expect("a status"),
        [(header::CONTENT_TYPE, content_type)],
        body,
    )
        .into_response();
    if let Some(etag) = etag {
        response
            .headers_mut()
            .insert(header::ETAG, etag.parse().expect("a tag"));
    }
    response
}

struct World {
    origin: String,
    port: u16,
    staged: Arc<Staged>,
    server: tokio::task::JoinHandle<()>,
    http: reqwest::Client,
    clock: Option<QuickClock>,
}

/// The clock of a test that waits out long times over real sockets, in a
/// test whose runtime starts paused.
///
/// A paused clock alone will not do. It runs ahead to the next timer
/// whenever nothing is runnable, and a request that is on its way is not
/// runnable: its deadline would pass before its answer could arrive. So the
/// clock is held still, which the runtime does while a blocking task runs,
/// and moved by hand, `STEP` for each real millisecond. An answer that is on
/// its way arrives long before its deadline, and thirty seconds take an
/// eighth of one.
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

/// Whether `elapsed` is `expected`: no less, and no more than the quick
/// clock moves while the requests before and after it are answered.
fn took(elapsed: Duration, expected: Duration) -> bool {
    elapsed >= expected && elapsed < expected + Duration::from_secs(2)
}

impl Drop for World {
    fn drop(&mut self) {
        self.server.abort();
    }
}

impl World {
    /// For a test whose runtime starts paused.
    async fn on_a_quick_clock() -> World {
        let clock = QuickClock::start();
        let mut world = World::start().await;
        world.clock = Some(clock);
        world
    }

    async fn start() -> World {
        // Already installed by another test of this process: one is enough.
        let _ = rustls::crypto::ring::default_provider().install_default();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("a port");
        let port = listener.local_addr().expect("an address").port();
        let origin = format!("http://127.0.0.1:{port}");
        let staged = Arc::new(Staged {
            origin: Mutex::new(origin.clone()),
            trusts: Mutex::new(Some(vec![format!("{origin}/realms/semiont")])),
            names_itself: Mutex::new(None),
            offers_device: Mutex::new(true),
            token_answers: Mutex::default(),
            token_forms: Mutex::default(),
            device_answer: Mutex::new((
                200,
                json!({
                    "device_code": "a-device-code", "user_code": "WDJB-MJHT",
                    "verification_uri": "https://issuer.test/device",
                    "verification_uri_complete": "https://issuer.test/device?user_code=WDJB-MJHT",
                    "expires_in": 600, "interval": 5,
                }),
            )),
            device_forms: Mutex::default(),
            revoke_status: Mutex::new(200),
            revoke_forms: Mutex::default(),
            refused: Mutex::default(),
            refuses_everyone: Mutex::default(),
            refused_on_the_bus: Mutex::default(),
            asked_who: Mutex::default(),
            silent: Mutex::default(),
            trails_off: Mutex::default(),
            upload_takes: Mutex::default(),
            describes: Mutex::new(Describes::As(
                json!({ "name": "KB A", "domain": "example.org:kb-a", "gitBranch": "main" }),
            )),
            answers: Mutex::default(),
            subscriptions: Mutex::default(),
            streams: Mutex::default(),
            discovery: Mutex::new((404, "text/plain".to_owned(), String::new(), None)),
            discovery_reads: Mutex::default(),
        });
        let app = Router::new()
            .route(
                "/.well-known/oauth-protected-resource",
                get(resource_metadata),
            )
            .route("/api/users/me", get(me))
            .route("/api/tokens/agent", post(agent_token))
            .route("/resources/{id}", get(content))
            .route("/resources", post(upload))
            .route("/bus/subscribe", post(subscribe))
            .route("/bus/emit", post(emit))
            .route(
                "/realms/semiont/.well-known/openid-configuration",
                get(openid_configuration),
            )
            .route("/realms/semiont/token", post(token))
            .route("/realms/semiont/device", post(device))
            .route("/realms/semiont/revoke", post(revoke))
            .route("/discovery/kbs.json", get(discovery))
            .with_state(staged.clone());
        let server = tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        World {
            origin,
            port,
            staged,
            server,
            http: reqwest::Client::new(),
            clock: None,
        }
    }

    fn issuer(&self) -> String {
        format!("{}/realms/semiont", self.origin)
    }

    fn target(&self) -> HttpEndpoint {
        HttpEndpoint {
            host: "127.0.0.1".to_owned(),
            port: self.port,
            protocol: Protocol::Http,
        }
    }

    fn kb(&self, id: &str) -> KbTarget {
        KbTarget::http(id, "KB A", "127.0.0.1", self.port, Protocol::Http)
    }

    fn answers(&self, answers: impl IntoIterator<Item = (u16, Value)>) {
        self.staged.token_answers.lock().unwrap().extend(answers);
    }

    fn token_forms(&self) -> Vec<HashMap<String, String>> {
        self.staged.token_forms.lock().unwrap().clone()
    }

    fn stored(&self, access: &str, refresh: &str) -> StoredSession {
        StoredSession {
            access: access.to_owned(),
            refresh: refresh.to_owned(),
            client_id: "semiont-browser".to_owned(),
            token_endpoint: format!("{}/token", self.issuer()),
            revocation_endpoint: Some(format!("{}/revoke", self.issuer())),
        }
    }

    fn begin(&self) -> BeginAuthorization {
        BeginAuthorization {
            target: self.target(),
            redirect_uri: "http://127.0.0.1:9/callback".to_owned(),
            kb_id: None,
            expected_did: None,
            expected_name: None,
        }
    }
}

fn jwt(expires_in: i64, n: u64) -> String {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("after the epoch")
        .as_secs() as i64;
    format!(
        "{}.{}.sig",
        URL_SAFE_NO_PAD.encode(r#"{"alg":"none"}"#),
        URL_SAFE_NO_PAD.encode(json!({ "iat": now, "exp": now + expires_in, "n": n }).to_string())
    )
}

fn granted(access: &str, refresh: Option<&str>) -> (u16, Value) {
    let mut answer = json!({ "access_token": access, "token_type": "Bearer" });
    if let Some(refresh) = refresh {
        answer["refresh_token"] = json!(refresh);
    }
    (200, answer)
}

fn query(url: &str) -> HashMap<String, String> {
    reqwest::Url::parse(url)
        .expect("a URL")
        .query_pairs()
        .map(|(name, value)| (name.into_owned(), value.into_owned()))
        .collect()
}

fn pending(storage: &dyn SessionStorage) -> Option<PendingAuthorization> {
    serde_json::from_str(&storage.get(PENDING_AUTHORIZATION_KEY)?).ok()
}

/// Wait, up to ten seconds, for `probe` to hold.
async fn until(what: &str, probe: impl Fn() -> bool) {
    for _ in 0..1000 {
        if probe() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("never happened: {what}");
}

fn code(error: &SignInError) -> (SignInErrorCode, Option<u16>) {
    (error.code, error.status)
}

// ── PKCE ────────────────────────────────────────────────────────────────

#[test]
fn the_challenge_is_the_one_rfc_7636_gives_for_its_verifier() {
    assert_eq!(
        code_challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
        "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
    );
}

// ── Finding the issuer ──────────────────────────────────────────────────

#[tokio::test]
async fn the_knowledge_base_names_its_issuer_and_the_issuer_names_its_endpoints() {
    let world = World::start().await;
    let issuer = discover_issuer(&world.target(), &world.http)
        .await
        .expect("an issuer");

    assert_eq!(issuer.issuer, world.issuer());
    assert_eq!(issuer.authorization, format!("{}/auth", world.issuer()));
    assert_eq!(issuer.token, format!("{}/token", world.issuer()));
    assert_eq!(issuer.device, Some(format!("{}/device", world.issuer())));
    assert_eq!(
        issuer.revocation,
        Some(format!("{}/revoke", world.issuer()))
    );
}

#[tokio::test]
async fn a_knowledge_base_that_trusts_no_issuer_is_named_as_one() {
    let world = World::start().await;
    for trusts in [None, Some(Vec::new())] {
        *world.staged.trusts.lock().unwrap() = trusts;
        let refused = discover_issuer(&world.target(), &world.http)
            .await
            .expect_err("there is no issuer");
        assert_eq!(refused.code, SignInErrorCode::NoIssuer);
    }
}

#[tokio::test]
async fn an_issuer_that_describes_another_issuer_is_refused() {
    let world = World::start().await;
    *world.staged.names_itself.lock().unwrap() = Some("https://elsewhere.test".to_owned());

    let refused = discover_issuer(&world.target(), &world.http)
        .await
        .expect_err("the document is another issuer's");

    assert_eq!(refused.code, SignInErrorCode::Discovery);
    assert!(refused.message.contains(&world.issuer()), "{refused}");
}

#[tokio::test]
async fn a_knowledge_base_that_cannot_be_reached_is_a_failure_to_discover_not_a_lack_of_issuer() {
    let world = World::start().await;
    let nowhere = HttpEndpoint {
        port: 9,
        ..world.target()
    };
    let refused = discover_issuer(&nowhere, &world.http)
        .await
        .expect_err("nothing is there");
    assert_eq!(code(&refused), (SignInErrorCode::Discovery, None));
}

// ── The authorization-code grant ────────────────────────────────────────

#[tokio::test]
async fn beginning_a_sign_in_remembers_it_and_builds_the_url_around_what_it_remembered() {
    let world = World::start().await;
    let storage = InMemorySessionStorage::new();

    let url = begin_authorization(
        BeginAuthorization {
            kb_id: Some("kb-a".to_owned()),
            expected_did: Some("did:web:example.org:kb-a".to_owned()),
            expected_name: Some("KB A".to_owned()),
            ..world.begin()
        },
        &storage,
        &world.http,
    )
    .await
    .expect("a URL");

    let record = pending(&storage).expect("a pending sign-in");
    assert!(
        url.starts_with(&format!("{}/auth?", world.issuer())),
        "{url}"
    );
    assert_eq!(
        query(&url),
        HashMap::from(
            [
                ("response_type", "code"),
                ("client_id", "semiont-browser"),
                ("redirect_uri", "http://127.0.0.1:9/callback"),
                ("scope", "openid email profile offline_access"),
                ("state", record.state.as_str()),
                ("code_challenge", code_challenge(&record.verifier).as_str()),
                ("code_challenge_method", "S256"),
            ]
            .map(|(name, value)| (name.to_owned(), value.to_owned()))
        )
    );
    assert_eq!(record.target, world.target());
    assert_eq!(record.issuer.token, format!("{}/token", world.issuer()));
    assert_eq!(record.kb_id.as_deref(), Some("kb-a"));
    assert_eq!(record.expected_name.as_deref(), Some("KB A"));
    // Neither is guessable, and neither is the other.
    assert!(record.verifier.len() >= 43 && record.state.len() >= 32);
    assert_ne!(record.verifier, record.state);
}

async fn begun(world: &World, storage: &dyn SessionStorage) -> PendingAuthorization {
    begin_authorization(world.begin(), storage, &world.http)
        .await
        .expect("a URL");
    pending(storage).expect("a pending sign-in")
}

#[tokio::test]
async fn completing_a_sign_in_exchanges_the_code_with_its_verifier_once() {
    let world = World::start().await;
    let storage = InMemorySessionStorage::new();
    let record = begun(&world, &storage).await;
    world.answers([granted("an-access-token", Some("a-refresh-token"))]);
    let callback = format!(
        "http://127.0.0.1:9/callback?state={}&code=the-code",
        record.state
    );

    let (completed, tokens) = complete_authorization(&callback, &storage, &world.http)
        .await
        .expect("tokens");

    assert_eq!(completed, record);
    assert_eq!(
        (tokens.access.as_str(), tokens.refresh.as_str()),
        ("an-access-token", "a-refresh-token")
    );
    assert_eq!(
        world.token_forms(),
        [HashMap::from(
            [
                ("grant_type", "authorization_code"),
                ("code", "the-code"),
                ("redirect_uri", "http://127.0.0.1:9/callback"),
                ("client_id", "semiont-browser"),
                ("code_verifier", record.verifier.as_str()),
            ]
            .map(|(name, value)| (name.to_owned(), value.to_owned()))
        )]
    );
    // The pending record is gone: the same callback again completes nothing.
    assert_eq!(storage.get(PENDING_AUTHORIZATION_KEY), None);
    let replayed = complete_authorization(&callback, &storage, &world.http)
        .await
        .expect_err("nothing is pending");
    assert_eq!(replayed.code, SignInErrorCode::NoPending);
    assert_eq!(world.token_forms().len(), 1);
}

#[tokio::test]
async fn a_response_that_is_not_the_pending_sign_ins_is_refused_and_nothing_is_exchanged() {
    let world = World::start().await;
    let storage = InMemorySessionStorage::new();
    let cases = [
        (
            "state=another&code=the-code".to_owned(),
            SignInErrorCode::State,
        ),
        (
            "error=access_denied&error_description=The+person+said+no".to_owned(),
            SignInErrorCode::Denied,
        ),
        ("error=server_error".to_owned(), SignInErrorCode::Exchange),
    ];
    for (response, expected) in cases {
        begun(&world, &storage).await;
        let refused = complete_authorization(
            &format!("http://127.0.0.1:9/callback?{response}"),
            &storage,
            &world.http,
        )
        .await
        .expect_err("the response is refused");
        assert_eq!(refused.code, expected, "{response}");
        // Refused or not, a sign-in is completed once.
        assert_eq!(storage.get(PENDING_AUTHORIZATION_KEY), None);
    }
    assert!(world.token_forms().is_empty());

    let record = begun(&world, &storage).await;
    let without_a_code = complete_authorization(
        &format!("http://127.0.0.1:9/callback?state={}", record.state),
        &storage,
        &world.http,
    )
    .await
    .expect_err("there is no code");
    assert_eq!(without_a_code.code, SignInErrorCode::Exchange);
}

#[tokio::test]
async fn tokens_with_no_refresh_token_are_refused() {
    let world = World::start().await;
    let storage = InMemorySessionStorage::new();
    let record = begun(&world, &storage).await;
    world.answers([granted("an-access-token", None)]);

    let refused = complete_authorization(
        &format!("http://127.0.0.1:9/callback?state={}&code=c", record.state),
        &storage,
        &world.http,
    )
    .await
    .expect_err("the session could not outlive its first token");

    assert_eq!(refused.code, SignInErrorCode::Exchange);
    assert!(refused.message.contains("no refresh token"), "{refused}");
}

// ── Renewal and revocation ──────────────────────────────────────────────

#[tokio::test]
async fn a_renewal_takes_a_rotated_refresh_token_and_keeps_the_one_held_otherwise() {
    let world = World::start().await;
    let endpoint = format!("{}/token", world.issuer());
    world.answers([granted("a2", None), granted("a3", Some("r3"))]);

    let kept = refresh_at_issuer(&world.http, &endpoint, "semiont-browser", "r1")
        .await
        .expect("tokens");
    let rotated = refresh_at_issuer(&world.http, &endpoint, "semiont-browser", "r1")
        .await
        .expect("tokens");

    assert_eq!((kept.access.as_str(), kept.refresh.as_str()), ("a2", "r1"));
    assert_eq!(
        (rotated.access.as_str(), rotated.refresh.as_str()),
        ("a3", "r3")
    );
    assert_eq!(
        world.token_forms()[0],
        HashMap::from(
            [
                ("grant_type", "refresh_token"),
                ("refresh_token", "r1"),
                ("client_id", "semiont-browser"),
            ]
            .map(|(name, value)| (name.to_owned(), value.to_owned()))
        )
    );
}

#[tokio::test]
async fn a_refused_renewal_says_what_the_issuer_said_and_the_status_it_answered() {
    let world = World::start().await;
    world.answers([(
        400,
        json!({ "error": "invalid_grant", "error_description": "Token is not active" }),
    )]);

    let refused = refresh_at_issuer(
        &world.http,
        &format!("{}/token", world.issuer()),
        "semiont-browser",
        "r1",
    )
    .await
    .expect_err("the grant is refused");

    assert_eq!(code(&refused), (SignInErrorCode::Exchange, Some(400)));
    assert_eq!(
        refused.message,
        "The issuer refused the token request (invalid_grant: Token is not active)"
    );
}

fn storing(world: &World, kb_id: &str, access: &str) -> Arc<InMemorySessionStorage> {
    let storage = Arc::new(InMemorySessionStorage::new());
    store_session(storage.as_ref(), kb_id, &world.stored(access, "r1"));
    storage
}

#[tokio::test(start_paused = true)]
async fn a_stored_sessions_renewal_rides_out_an_issuer_that_says_not_now_and_keeps_the_rotation() {
    let world = World::on_a_quick_clock().await;
    let storage = storing(&world, "kb-a", "a1");
    world.answers([
        (503, Value::Null),
        (429, json!({ "error": "slow_down" })),
        granted("a2", Some("r2")),
    ]);

    let renewed = refresh_stored_session(storage.as_ref(), "kb-a", &world.http).await;

    assert_eq!(renewed, Ok(Some("a2".to_owned())));
    assert_eq!(world.token_forms().len(), 3);
    assert_eq!(
        stored_session(storage.as_ref(), "kb-a"),
        Some(world.stored("a2", "r2"))
    );
}

#[tokio::test(start_paused = true)]
async fn a_refused_grant_is_final_on_its_first_answer() {
    let world = World::on_a_quick_clock().await;
    for refusal in [
        (400, json!({ "error": "invalid_grant" })),
        (401, json!({ "error": "invalid_client" })),
        (404, Value::Null),
    ] {
        let storage = storing(&world, "kb-a", "a1");
        let before = world.token_forms().len();
        world.answers([refusal.clone(), granted("never", None)]);

        let refused = refresh_stored_session(storage.as_ref(), "kb-a", &world.http)
            .await
            .expect_err("the grant is refused");

        assert_eq!(refused.status, Some(refusal.0));
        assert!(
            refused
                .message
                .starts_with("The issuer refused the token request"),
            "{refused}"
        );
        assert_eq!(world.token_forms().len(), before + 1);
        assert_eq!(
            stored_session(storage.as_ref(), "kb-a"),
            Some(world.stored("a1", "r1"))
        );
        world.staged.token_answers.lock().unwrap().clear();
    }
}

#[tokio::test(start_paused = true)]
async fn a_renewal_that_is_never_answered_gives_up_and_says_how_hard_it_tried() {
    let world = World::on_a_quick_clock().await;
    let storage = storing(&world, "kb-a", "a1");
    world.answers((0..10).map(|_| (503, Value::Null)));

    let refused = refresh_stored_session(storage.as_ref(), "kb-a", &world.http)
        .await
        .expect_err("the budget is spent");

    assert_eq!(world.token_forms().len(), 4);
    assert_eq!(
        refused.message,
        "The session could not be renewed after 4 attempts: The issuer refused the token request (HTTP 503)"
    );

    // And one that got no answer at all is tried as often.
    let nowhere = Arc::new(InMemorySessionStorage::new());
    store_session(
        nowhere.as_ref(),
        "kb-a",
        &StoredSession {
            token_endpoint: "http://127.0.0.1:9/token".to_owned(),
            ..world.stored("a1", "r1")
        },
    );
    let unanswered = refresh_stored_session(nowhere.as_ref(), "kb-a", &world.http)
        .await
        .expect_err("nothing is there");
    assert_eq!(unanswered.status, None);
    assert!(
        unanswered
            .message
            .starts_with("The session could not be renewed after 4 attempts:"),
        "{unanswered}"
    );
}

#[tokio::test]
async fn with_nothing_stored_there_is_nothing_to_renew_and_that_is_no_failure() {
    let world = World::start().await;
    let storage = InMemorySessionStorage::new();

    assert_eq!(
        refresh_stored_session(&storage, "kb-a", &world.http).await,
        Ok(None)
    );
    assert!(world.token_forms().is_empty());
}

#[tokio::test]
async fn a_session_signed_out_while_it_was_renewed_is_not_written_back_and_is_given_no_token() {
    /// A storage that forgets the session the moment it is first read.
    struct SignedOutMeanwhile(InMemorySessionStorage);
    impl SessionStorage for SignedOutMeanwhile {
        fn get(&self, key: &str) -> Option<String> {
            let stored = self.0.get(key);
            self.0.delete(key);
            stored
        }
        fn set(&self, key: &str, value: &str) {
            self.0.set(key, value);
        }
        fn delete(&self, key: &str) {
            self.0.delete(key);
        }
        fn update(&self, key: &str, change: &mut dyn FnMut(Option<&str>) -> Option<String>) {
            self.0.update(key, change);
        }
        fn subscribe(
            &self,
            _: semiont::storage::StorageChange,
        ) -> Option<semiont::storage::StorageSubscription> {
            None
        }
    }
    let world = World::start().await;
    let storage = SignedOutMeanwhile(InMemorySessionStorage::new());
    store_session(&storage, "kb-a", &world.stored("a1", "r1"));
    world.answers([granted("a2", Some("r2"))]);

    let renewed = refresh_stored_session(&storage, "kb-a", &world.http).await;

    // The issuer renewed it, and there is no session left to hold the token.
    assert_eq!(world.token_forms().len(), 1);
    assert_eq!(renewed, Ok(None));
    assert_eq!(storage.0.get(&session_key("kb-a")), None);
}

#[tokio::test]
async fn revoking_tells_the_issuer_as_the_client_the_token_was_issued_to() {
    let world = World::start().await;
    let endpoint = format!("{}/revoke", world.issuer());

    assert_eq!(
        revoke_at_issuer(&world.http, &endpoint, "semiont-cli", "r1").await,
        Ok(())
    );
    assert_eq!(
        *world.staged.revoke_forms.lock().unwrap(),
        [HashMap::from(
            [
                ("token", "r1"),
                ("token_type_hint", "refresh_token"),
                ("client_id", "semiont-cli"),
            ]
            .map(|(name, value)| (name.to_owned(), value.to_owned()))
        )]
    );

    *world.staged.revoke_status.lock().unwrap() = 503;
    let refused = revoke_at_issuer(&world.http, &endpoint, "semiont-cli", "r1")
        .await
        .expect_err("the issuer refused");
    assert_eq!(code(&refused), (SignInErrorCode::Exchange, Some(503)));
}

// ── The device grant ────────────────────────────────────────────────────

#[tokio::test(start_paused = true)]
async fn the_device_grant_shows_the_code_and_asks_until_the_person_approves() {
    let world = World::on_a_quick_clock().await;
    world.answers([
        (400, json!({ "error": "authorization_pending" })),
        (400, json!({ "error": "slow_down" })),
        granted("an-access-token", Some("a-refresh-token")),
    ]);
    let shown: Arc<Mutex<Option<DeviceCode>>> = Arc::default();
    let showing = shown.clone();
    let started = tokio::time::Instant::now();

    let (issuer, tokens) = sign_in_with_device_grant(
        &world.target(),
        move |code| *showing.lock().unwrap() = Some(code),
        &world.http,
    )
    .await
    .expect("tokens");

    assert_eq!(issuer.issuer, world.issuer());
    assert_eq!(
        (tokens.access.as_str(), tokens.refresh.as_str()),
        ("an-access-token", "a-refresh-token")
    );
    assert_eq!(
        *shown.lock().unwrap(),
        Some(DeviceCode {
            user_code: "WDJB-MJHT".to_owned(),
            verification_uri: "https://issuer.test/device".to_owned(),
            verification_uri_complete: Some(
                "https://issuer.test/device?user_code=WDJB-MJHT".to_owned()
            ),
            expires_in: Duration::from_secs(600),
        })
    );
    assert_eq!(
        *world.staged.device_forms.lock().unwrap(),
        [HashMap::from(
            [
                ("client_id", "semiont-cli"),
                ("scope", "openid email profile offline_access"),
            ]
            .map(|(name, value)| (name.to_owned(), value.to_owned()))
        )]
    );
    assert_eq!(world.token_forms().len(), 3);
    assert_eq!(
        world.token_forms()[0],
        HashMap::from(
            [
                ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
                ("device_code", "a-device-code"),
                ("client_id", "semiont-cli"),
            ]
            .map(|(name, value)| (name.to_owned(), value.to_owned()))
        )
    );
    // At the issuer's interval, and more slowly once it said to slow down:
    // five seconds, five, and then ten.
    assert!(
        took(started.elapsed(), Duration::from_secs(20)),
        "{:?}",
        started.elapsed()
    );
}

#[tokio::test(start_paused = true)]
async fn the_device_grant_ends_when_the_person_refuses_or_the_code_runs_out() {
    let world = World::on_a_quick_clock().await;
    let no_code = |_: DeviceCode| {};

    world.answers([(400, json!({ "error": "access_denied" }))]);
    let denied = sign_in_with_device_grant(&world.target(), no_code, &world.http)
        .await
        .expect_err("the person refused");
    assert_eq!(denied.code, SignInErrorCode::Denied);

    world.answers([(400, json!({ "error": "expired_token" }))]);
    let expired = sign_in_with_device_grant(&world.target(), no_code, &world.http)
        .await
        .expect_err("the code ran out");
    assert_eq!(expired.code, SignInErrorCode::Expired);

    // The issuer never says so, and the code's own lifetime ends it.
    world.staged.device_answer.lock().unwrap().1["expires_in"] = json!(12);
    world.answers((0..10).map(|_| (400, json!({ "error": "authorization_pending" }))));
    let outlived = sign_in_with_device_grant(&world.target(), no_code, &world.http)
        .await
        .expect_err("the code ran out");
    assert_eq!(outlived.code, SignInErrorCode::Expired);

    world.staged.token_answers.lock().unwrap().clear();
    world.answers([(400, json!({ "error": "invalid_client" }))]);
    let refused = sign_in_with_device_grant(&world.target(), no_code, &world.http)
        .await
        .expect_err("the issuer refused");
    assert_eq!(code(&refused), (SignInErrorCode::Exchange, Some(400)));
}

#[tokio::test]
async fn an_issuer_with_no_device_endpoint_is_refused_naming_the_client() {
    let world = World::start().await;
    *world.staged.offers_device.lock().unwrap() = false;

    let refused = sign_in_with_device_grant(&world.target(), |_| {}, &world.http)
        .await
        .expect_err("there is no device endpoint");

    assert_eq!(refused.code, SignInErrorCode::Discovery);
    assert!(refused.message.contains("semiont-cli"), "{refused}");
    assert!(world.staged.device_forms.lock().unwrap().is_empty());
}

// ── Sessions over a gateway ─────────────────────────────────────────────

fn issued(world: &World, storage: Arc<InMemorySessionStorage>, access: &str) -> IssuedSession {
    IssuedSession {
        kb: world.kb("a-script"),
        storage,
        base_url: world.origin.clone(),
        session: world.stored(access, "r1"),
        validate: true,
        on_auth_failed: None,
        on_error: None,
        http: world.http.clone(),
    }
}

#[tokio::test]
async fn a_session_over_issued_tokens_keeps_them_is_ready_and_says_who_it_is() {
    let world = World::start().await;
    let storage = Arc::new(InMemorySessionStorage::new());
    let access = jwt(3600, 1);

    let session = session_from_issued(issued(&world, storage.clone(), &access)).await;

    assert_eq!(session.token().borrow().as_deref(), Some(access.as_str()));
    assert_eq!(
        stored_session(storage.as_ref(), "a-script"),
        Some(world.stored(&access, "r1"))
    );
    assert_eq!(*world.staged.asked_who.lock().unwrap(), [access]);
    assert_eq!(
        session
            .user()
            .borrow()
            .as_ref()
            .map(|user| user.email.clone()),
        Some("alice@example.org".to_owned())
    );
    session.close().await;
}

#[tokio::test]
async fn asking_who_a_token_is_opens_no_stream_of_its_own() {
    let world = World::start().await;
    let storage = Arc::new(InMemorySessionStorage::new());
    let access = jwt(3600, 1);

    let session = session_from_issued(issued(&world, storage, &access)).await;
    until("the session's stream is open", || {
        !world.staged.subscriptions.lock().unwrap().is_empty()
    })
    .await;
    tokio::time::sleep(Duration::from_millis(200)).await;

    // The session's own stream, and no other: the gateway was asked who the
    // token is by one request.
    assert_eq!(*world.staged.asked_who.lock().unwrap(), [access]);
    assert_eq!(world.staged.subscriptions.lock().unwrap().len(), 1);
    session.close().await;
}

/// An issuer that goes on renewing a credential the gateway goes on
/// refusing: unchecked, a storm of renewals and asks from one session.
#[tokio::test(start_paused = true)]
async fn a_gateway_that_refuses_what_its_issuer_issues_is_asked_twice_and_then_left_alone() {
    let world = World::on_a_quick_clock().await;
    *world.staged.refuses_everyone.lock().unwrap() = true;
    // An issuer that renews for as long as it is asked.
    world.answers((2..60).map(|n| granted(&jwt(3600, n), Some("r"))));
    let storage = Arc::new(InMemorySessionStorage::new());
    let told: Arc<Mutex<Vec<SessionEndReason>>> = Arc::default();
    let reported: Arc<Mutex<Vec<SessionErrorCode>>> = Arc::default();
    let (telling, reporting) = (told.clone(), reported.clone());

    let session = ends(session_from_issued(IssuedSession {
        on_auth_failed: Some(Arc::new(move |reason| {
            telling.lock().unwrap().push(reason);
        })),
        on_error: Some(Arc::new(move |error| {
            reporting.lock().unwrap().push(error.code);
        })),
        ..issued(&world, storage.clone(), &jwt(3600, 1))
    }))
    .await;

    assert_eq!(world.staged.asked_who.lock().unwrap().len(), 2);
    assert_eq!(*told.lock().unwrap(), [SessionEndReason::Refused]);
    assert_eq!(
        *reported.lock().unwrap(),
        [SessionErrorCode::CredentialRefused]
    );
    assert_eq!(stored_session(storage.as_ref(), "a-script"), None);

    // And then the gateway and the issuer are left alone, however long the
    // session is held: its stream asked with the stored token and with the
    // renewed one, and waits for a different credential with no request.
    tokio::time::sleep(Duration::from_secs(120)).await;
    assert_eq!(*session.token().borrow(), None);
    assert_eq!(world.staged.asked_who.lock().unwrap().len(), 2);
    let streams_asked_for = world.staged.subscriptions.lock().unwrap().len();
    assert!(
        streams_asked_for <= 2,
        "{streams_asked_for} streams were asked for"
    );
    let renewals = world.token_forms().len();
    assert!(renewals <= 2, "the issuer was asked {renewals} times");
    session.close().await;
}

#[tokio::test(start_paused = true)]
async fn a_running_session_whose_gateway_starts_refusing_ends_on_the_first_refusal() {
    let world = World::on_a_quick_clock().await;
    let (first, renewed) = (jwt(3600, 1), jwt(3600, 2));
    // An issuer that renews for as long as it is asked.
    world.answers(
        std::iter::once(granted(&renewed, Some("r")))
            .chain((3..60).map(|n| granted(&jwt(3600, n), Some("r")))),
    );
    let storage = Arc::new(InMemorySessionStorage::new());
    let told: Arc<Mutex<Vec<SessionEndReason>>> = Arc::default();
    let reported: Arc<Mutex<Vec<SessionErrorCode>>> = Arc::default();
    let (telling, reporting) = (told.clone(), reported.clone());
    let session = ends(session_from_issued(IssuedSession {
        on_auth_failed: Some(Arc::new(move |reason| {
            telling.lock().unwrap().push(reason);
        })),
        on_error: Some(Arc::new(move |error| {
            reporting.lock().unwrap().push(error.code);
        })),
        ..issued(&world, storage.clone(), &first)
    }))
    .await;
    assert_eq!(
        *world.staged.asked_who.lock().unwrap(),
        std::slice::from_ref(&first)
    );
    let me = || async {
        let auth = session.client().auth.as_ref().expect("auth");
        ends(auth.me()).await
    };

    // The gateway stops accepting anything, and the issuer goes on renewing.
    *world.staged.refuses_everyone.lock().unwrap() = true;
    let refusal = me().await.expect_err("the request is refused");

    // The request, refused; one renewal; the renewed token, asked about once
    // and refused.
    assert!(message(refusal).contains("401"));
    assert_eq!(world.token_forms().len(), 1);
    assert_eq!(
        *world.staged.asked_who.lock().unwrap(),
        [first.clone(), first, renewed]
    );
    assert_eq!(*told.lock().unwrap(), [SessionEndReason::Refused]);
    assert_eq!(
        *reported.lock().unwrap(),
        [SessionErrorCode::CredentialRefused]
    );
    assert_eq!(stored_session(storage.as_ref(), "a-script"), None);
    assert_eq!(*session.token().borrow(), None);

    // A request after that is refused as it is: nothing is renewed for it,
    // and nobody is asked who anyone is.
    let _ = me().await;
    tokio::time::sleep(Duration::from_secs(120)).await;
    assert_eq!(world.token_forms().len(), 1);
    assert_eq!(world.staged.asked_who.lock().unwrap().len(), 4);
    assert_eq!(reported.lock().unwrap().len(), 1);
    session.close().await;
}

#[tokio::test]
async fn a_session_renews_at_the_issuer_its_stored_session_names() {
    let world = World::start().await;
    let storage = Arc::new(InMemorySessionStorage::new());
    let (first, second) = (jwt(3600, 1), jwt(3600, 2));
    let session = session_from_issued(issued(&world, storage.clone(), &first)).await;
    world.answers([granted(&second, Some("r2"))]);

    assert_eq!(session.refresh().await, Some(second.clone()));

    assert_eq!(world.token_forms()[0]["refresh_token"], "r1");
    assert_eq!(world.token_forms()[0]["client_id"], "semiont-browser");
    assert_eq!(
        stored_session(storage.as_ref(), "a-script"),
        Some(world.stored(&second, "r2"))
    );

    // A refused renewal ends it: no token, and nothing stored.
    assert_eq!(session.refresh().await, None);
    assert_eq!(*session.token().borrow(), None);
    assert_eq!(stored_session(storage.as_ref(), "a-script"), None);
    session.close().await;
}

#[tokio::test]
async fn a_token_the_gateway_refuses_is_renewed_and_the_request_made_again() {
    let world = World::start().await;
    let storage = Arc::new(InMemorySessionStorage::new());
    let (first, second) = (jwt(3600, 1), jwt(3600, 2));
    let session = session_from_issued(IssuedSession {
        validate: false,
        ..issued(&world, storage, &first)
    })
    .await;
    world.staged.refused.lock().unwrap().push(first.clone());
    world.answers([granted(&second, Some("r2"))]);

    let user = session
        .client()
        .auth
        .as_ref()
        .expect("a client over a gateway has auth")
        .me()
        .await
        .expect("the request succeeds on the renewed token");

    assert_eq!(user.email, "alice@example.org");
    assert_eq!(
        *world.staged.asked_who.lock().unwrap(),
        [first, second.clone()]
    );
    assert_eq!(session.token().borrow().as_deref(), Some(second.as_str()));
    session.close().await;
}

#[tokio::test(start_paused = true)]
async fn a_script_signs_in_by_the_device_grant_and_holds_a_ready_session() {
    let world = World::on_a_quick_clock().await;
    let storage = Arc::new(InMemorySessionStorage::new());
    let access = jwt(3600, 1);
    world.answers([granted(&access, Some("a-refresh-token"))]);

    let session: SemiontSession = sign_in_device(
        SignInDevice {
            kb: world.kb("a-script"),
            storage: storage.clone(),
            validate: false,
            on_auth_failed: None,
            on_error: None,
            http: world.http.clone(),
        },
        |_| {},
    )
    .await
    .expect("a session");

    assert_eq!(session.token().borrow().as_deref(), Some(access.as_str()));
    assert_eq!(
        stored_session(storage.as_ref(), "a-script"),
        Some(StoredSession {
            access,
            refresh: "a-refresh-token".to_owned(),
            client_id: "semiont-cli".to_owned(),
            token_endpoint: format!("{}/token", world.issuer()),
            revocation_endpoint: Some(format!("{}/revoke", world.issuer())),
        })
    );
}

// ── A registry over HTTP ────────────────────────────────────────────────

fn registered(world: &World, id: &str, did: &str) -> KnowledgeBase {
    KnowledgeBase {
        id: id.to_owned(),
        label: "KB A".to_owned(),
        did: did.to_owned(),
        endpoint: KbEndpoint::Http(world.target()),
        last_read: None,
    }
}

fn browser(world: &World, storage: Arc<InMemorySessionStorage>) -> SemiontBrowser {
    SemiontBrowser::new(SemiontBrowserConfig {
        storage,
        session_factory: Arc::new(HttpSessionFactory::new(world.http.clone())),
    })
}

async fn live(browser: &SemiontBrowser) -> Arc<SemiontSession> {
    let mut session = browser.active_session();
    let session = tokio::time::timeout(Duration::from_secs(10), session.wait_for(Option::is_some))
        .await
        .expect("a session comes up")
        .expect("the browser lives")
        .clone();
    session.expect("a session")
}

const DID_A: &str = "did:web:example.org:kb-a";

#[tokio::test]
async fn a_registry_brings_up_a_session_that_says_who_it_is_and_renews_an_expired_token() {
    let world = World::start().await;
    let storage = Arc::new(InMemorySessionStorage::new());
    save_knowledge_bases(storage.as_ref(), &[registered(&world, "kb-a", DID_A)]);
    let renewed = jwt(3600, 2);
    store_session(storage.as_ref(), "kb-a", &world.stored(&jwt(-60, 1), "r1"));
    world.answers([granted(&renewed, Some("r2"))]);

    let browser = browser(&world, storage.clone());
    let session = live(&browser).await;

    assert_eq!(session.token().borrow().as_deref(), Some(renewed.as_str()));
    assert_eq!(
        *world.staged.asked_who.lock().unwrap(),
        std::slice::from_ref(&renewed)
    );
    assert_eq!(
        session
            .user()
            .borrow()
            .as_ref()
            .map(|user| user.did.to_string()),
        Some("did:web:example.org:users:alice".to_owned())
    );
    assert_eq!(
        stored_session(storage.as_ref(), "kb-a"),
        Some(world.stored(&renewed, "r2"))
    );
    browser.close().await;
}

#[tokio::test]
async fn renewals_asked_for_together_are_one_request_of_the_issuer() {
    let world = World::start().await;
    let storage = Arc::new(InMemorySessionStorage::new());
    save_knowledge_bases(storage.as_ref(), &[registered(&world, "kb-a", DID_A)]);
    store_session(storage.as_ref(), "kb-a", &world.stored(&jwt(3600, 1), "r1"));
    let browser = browser(&world, storage);
    let session = live(&browser).await;
    let renewed = jwt(3600, 2);
    world.answers([granted(&renewed, Some("r2"))]);

    let (one, two, three) = tokio::join!(session.refresh(), session.refresh(), session.refresh());

    assert_eq!(
        [one, two, three],
        [Some(renewed.clone()), Some(renewed.clone()), Some(renewed)]
    );
    assert_eq!(world.token_forms().len(), 1);
    browser.close().await;
}

#[tokio::test]
async fn signing_out_of_a_registry_revokes_the_refresh_token_at_its_issuer() {
    let world = World::start().await;
    let storage = Arc::new(InMemorySessionStorage::new());
    save_knowledge_bases(storage.as_ref(), &[registered(&world, "kb-a", DID_A)]);
    store_session(storage.as_ref(), "kb-a", &world.stored(&jwt(3600, 1), "r1"));
    let browser = browser(&world, storage.clone());
    live(&browser).await;

    browser.sign_out("kb-a").await;
    until("the issuer is told", || {
        !world.staged.revoke_forms.lock().unwrap().is_empty()
    })
    .await;

    assert_eq!(world.staged.revoke_forms.lock().unwrap()[0]["token"], "r1");
    assert_eq!(
        world.staged.revoke_forms.lock().unwrap()[0]["client_id"],
        "semiont-browser"
    );
    assert_eq!(stored_session(storage.as_ref(), "kb-a"), None);
    browser.close().await;
}

/// Begin a sign-in through the registry and give the callback URL the
/// issuer would send the person back to.
async fn sent_back(world: &World, browser: &SemiontBrowser, options: BeginAuthorization) -> String {
    let url = begin_sign_in(browser, options, &world.http)
        .await
        .expect("a URL");
    format!(
        "http://127.0.0.1:9/callback?state={}&code=the-code",
        query(&url)["state"]
    )
}

#[tokio::test]
async fn a_registrys_sign_in_registers_the_knowledge_base_under_what_it_says_it_is() {
    let world = World::start().await;
    let storage = Arc::new(InMemorySessionStorage::new());
    let browser = browser(&world, storage.clone());
    let access = jwt(3600, 1);
    world.answers([granted(&access, Some("a-refresh-token"))]);

    let callback = sent_back(
        &world,
        &browser,
        BeginAuthorization {
            expected_did: Some("did:web:example.org:another".to_owned()),
            expected_name: Some("Another".to_owned()),
            ..world.begin()
        },
    )
    .await;
    let outcome = complete_sign_in(&browser, &callback, &world.http)
        .await
        .expect("the sign-in completes");

    assert_eq!(outcome.kb.did, DID_A);
    assert_eq!(outcome.kb.label, "KB A");
    assert_eq!(outcome.kb.endpoint, KbEndpoint::Http(world.target()));
    assert_eq!(
        outcome
            .kb
            .last_read
            .as_ref()
            .and_then(|read| read.git_branch.as_deref()),
        Some("main")
    );
    // What the person believed they clicked is said back, not acted on.
    assert_eq!(
        outcome.expected.map(|expected| expected.did),
        Some("did:web:example.org:another".to_owned())
    );
    assert_eq!(*browser.kbs().borrow(), std::slice::from_ref(&outcome.kb));
    assert_eq!(
        stored_session(storage.as_ref(), &outcome.kb.id),
        Some(StoredSession {
            access: access.clone(),
            refresh: "a-refresh-token".to_owned(),
            client_id: "semiont-browser".to_owned(),
            token_endpoint: format!("{}/token", world.issuer()),
            revocation_endpoint: Some(format!("{}/revoke", world.issuer())),
        })
    );
    assert_eq!(live(&browser).await.kb().id, outcome.kb.id);
    browser.close().await;
}

#[tokio::test]
async fn a_knowledge_base_that_cannot_say_who_it_is_is_not_registered() {
    let world = World::start().await;
    let storage = Arc::new(InMemorySessionStorage::new());
    let browser = browser(&world, storage.clone());

    *world.staged.describes.lock().unwrap() = Describes::Refusing;
    world.answers([granted(&jwt(3600, 1), Some("r"))]);
    let callback = sent_back(&world, &browser, world.begin()).await;
    let refused = complete_sign_in(&browser, &callback, &world.http)
        .await
        .expect_err("it cannot say who it is");
    match refused {
        CompleteSignInError::Identity(unverifiable) => {
            assert_eq!(unverifiable.reason, IdentityUnverifiableReason::NotReported);
        }
        other => panic!("an identity failure was expected, not {other:?}"),
    }

    // An emit the gateway refuses reaches nobody to ask.
    let unwelcome = jwt(3600, 2);
    world
        .staged
        .refused_on_the_bus
        .lock()
        .unwrap()
        .push(unwelcome.clone());
    world.answers([granted(&unwelcome, Some("r"))]);
    let callback = sent_back(&world, &browser, world.begin()).await;
    let unreached = complete_sign_in(&browser, &callback, &world.http)
        .await
        .expect_err("it was not reached");
    match unreached {
        CompleteSignInError::Identity(unverifiable) => {
            assert_eq!(unverifiable.reason, IdentityUnverifiableReason::Unreachable);
        }
        other => panic!("an identity failure was expected, not {other:?}"),
    }

    assert!(browser.kbs().borrow().is_empty());
    assert_eq!(*browser.active_kb_id().borrow(), None);
    browser.close().await;
}

#[tokio::test]
async fn a_callback_that_is_not_the_pending_sign_ins_registers_nothing() {
    let world = World::start().await;
    let browser = browser(&world, Arc::new(InMemorySessionStorage::new()));
    sent_back(&world, &browser, world.begin()).await;

    let refused = complete_sign_in(
        &browser,
        "http://127.0.0.1:9/callback?state=another&code=the-code",
        &world.http,
    )
    .await
    .expect_err("the state is another's");

    assert_eq!(
        refused,
        CompleteSignInError::SignIn(SignInError::new(
            SignInErrorCode::State,
            "The sign-in response does not belong to the pending sign-in"
        ))
    );
    assert!(browser.kbs().borrow().is_empty());
    browser.close().await;
}

#[tokio::test]
async fn asked_with_a_token_the_knowledge_base_says_who_it_is() {
    let world = World::start().await;

    let identity = describe_connection(&world.target(), &jwt(3600, 1), &world.http)
        .await
        .expect("it says who it is");

    assert_eq!(identity.did, DID_A);
    assert_eq!(identity.description.name, "KB A");
    assert_eq!(identity.description.git_branch.as_deref(), Some("main"));
}

#[tokio::test]
async fn a_registrys_session_resumes_its_stream_from_the_place_its_storage_kept() {
    let world = World::start().await;
    world.staged.answers.lock().unwrap().insert(
        "browse:annotations-requested".to_owned(),
        (
            "browse:annotations-result".to_owned(),
            json!({ "response": { "annotations": [], "total": 0 } }),
        ),
    );
    let storage = Arc::new(InMemorySessionStorage::new());
    save_knowledge_bases(storage.as_ref(), &[registered(&world, "kb-a", DID_A)]);
    store_session(storage.as_ref(), "kb-a", &world.stored(&jwt(3600, 1), "r1"));
    storage.set(
        "semiont.lastEventId.kb-a",
        &json!({ "res-1": "p-5" }).to_string(),
    );
    let browser = browser(&world, storage.clone());
    let session = live(&browser).await;

    // Watching a query of the resource holds its scope.
    let _watching = session.client().browse.annotations(&as_id("res-1")).watch();
    let resumed_from = || {
        world
            .staged
            .subscriptions
            .lock()
            .unwrap()
            .iter()
            .flat_map(|subscription| {
                subscription["scoped"]
                    .as_array()
                    .cloned()
                    .unwrap_or_default()
            })
            .find(|scoped| scoped["scope"] == "res-1")
            .map(|scoped| scoped["lastEventId"].clone())
    };
    until("the stream names the scope", || resumed_from().is_some()).await;
    assert_eq!(resumed_from(), Some(json!("p-5")));

    // A recorded event of the scope moves the place, and the place is kept
    // once the caches have taken the event in and written what they hold.
    let frame = json!({ "channel": "mark:added", "scope": "res-1", "payload": {} });
    let event = Bytes::from(format!("event: bus-event\nid: p-9\ndata: {frame}\n\n"));
    for stream in world.staged.streams.lock().unwrap().iter() {
        let _ = stream.send(event.clone());
    }
    let kept = || {
        storage
            .get("semiont.lastEventId.kb-a")
            .and_then(|kept| serde_json::from_str::<Value>(&kept).ok())
    };
    until("the place is kept", || {
        kept() == Some(json!({ "res-1": "p-9" }))
    })
    .await;
    browser.close().await;
}

// ── The launcher's document over HTTP ───────────────────────────────────

fn serving(world: &World, status: u16, content_type: &str, body: &str, etag: Option<&str>) {
    *world.staged.discovery.lock().unwrap() = (
        status,
        content_type.to_owned(),
        body.to_owned(),
        etag.map(str::to_owned),
    );
}

fn absent_for(read: &DiscoveryRead) -> Option<DiscoveryAbsentReason> {
    match read {
        DiscoveryRead::State(DiscoveryState::Absent { reason, .. }) => Some(*reason),
        _ => None,
    }
}

#[tokio::test]
async fn a_document_that_has_not_changed_is_not_read_again() {
    let world = World::start().await;
    let document = json!({ "version": 1, "kbs": [{
        "host": "localhost", "port": 4000, "placement": "local",
        "managedBy": "semiont-launcher", "did": DID_A,
    }] })
    .to_string();
    serving(&world, 200, "application/json", &document, Some("\"v1\""));
    let discovery = http_discovery(
        &format!("{}/discovery/kbs.json", world.origin),
        world.http.clone(),
    );

    match discovery.read().await {
        DiscoveryRead::State(DiscoveryState::Managed { kbs }) => assert_eq!(kbs.len(), 1),
        other => panic!("a managed state was expected, not {other:?}"),
    }
    assert_eq!(discovery.read().await, DiscoveryRead::Unchanged);

    // A new document has a new tag, and is read.
    serving(
        &world,
        200,
        "application/json; charset=utf-8",
        &json!({ "version": 1, "kbs": [] }).to_string(),
        Some("\"v2\""),
    );
    assert_eq!(
        discovery.read().await,
        DiscoveryRead::State(DiscoveryState::Managed { kbs: vec![] })
    );
    assert_eq!(*world.staged.discovery_reads.lock().unwrap(), 3);
}

#[tokio::test]
async fn what_is_not_a_document_at_the_address_is_absent() {
    let world = World::start().await;
    let discovery = http_discovery(
        &format!("{}/discovery/kbs.json", world.origin),
        world.http.clone(),
    );

    // A server that answers every path with its own page.
    serving(
        &world,
        200,
        "text/html",
        "<!doctype html>",
        Some("\"page\""),
    );
    assert_eq!(
        absent_for(&discovery.read().await),
        Some(DiscoveryAbsentReason::NotFound)
    );
    // Its tag was not kept: it is not believed the next time.
    assert_eq!(
        absent_for(&discovery.read().await),
        Some(DiscoveryAbsentReason::NotFound)
    );

    serving(&world, 404, "text/plain", "", None);
    assert_eq!(
        absent_for(&discovery.read().await),
        Some(DiscoveryAbsentReason::NotFound)
    );

    serving(&world, 200, "application/json", "{", Some("\"bad\""));
    assert_eq!(
        absent_for(&discovery.read().await),
        Some(DiscoveryAbsentReason::NotJson)
    );
    serving(&world, 200, "application/json", "{", Some("\"bad\""));
    assert_eq!(
        absent_for(&discovery.read().await),
        Some(DiscoveryAbsentReason::NotJson)
    );

    let nowhere = http_discovery("http://127.0.0.1:9/discovery/kbs.json", world.http.clone());
    assert_eq!(
        absent_for(&nowhere.read().await),
        Some(DiscoveryAbsentReason::Unreadable)
    );
}

// ── The loopback redirect ───────────────────────────────────────────────

#[tokio::test]
async fn the_loopback_redirect_gives_the_url_the_person_was_sent_back_to() {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let redirect = LoopbackRedirect::bind().await.expect("a port");
    let redirect_uri = redirect.redirect_uri();
    assert!(
        redirect_uri.starts_with("http://127.0.0.1:"),
        "{redirect_uri}"
    );
    assert!(redirect_uri.ends_with("/callback"), "{redirect_uri}");
    let waiting = tokio::spawn(redirect.callback());
    let http = reqwest::Client::new();

    // A browser asks for other things first, and is told there are none.
    let other = http
        .get(redirect_uri.replace("/callback", "/favicon.ico"))
        .send()
        .await
        .expect("an answer");
    assert_eq!(other.status().as_u16(), 404);

    let sent_back = format!("{redirect_uri}?state=s-1&code=the-code");
    let answer = http.get(&sent_back).send().await.expect("an answer");
    assert_eq!(answer.status().as_u16(), 200);
    assert!(answer.text().await.expect("a page").contains("signed in"));

    let callback = tokio::time::timeout(Duration::from_secs(10), waiting)
        .await
        .expect("the callback arrives")
        .expect("the listener ran")
        .expect("no failure");
    assert_eq!(callback, sent_back);
}

// ── A request that is never answered ────────────────────────────────────
//
// The stand-in accepts the request and says nothing, so what ends the
// request is its own deadline, and the time it took is the deadline.

impl World {
    fn never_answers(&self, what: &'static str) {
        self.staged.silent.lock().unwrap().insert(what);
    }

    /// A client of the gateway, signed in with `token`.
    fn client(&self, token: &str) -> semiont::client::SemiontClient {
        client(
            HttpTransportConfig {
                base_url: self.origin.clone(),
                token: tokio::sync::watch::channel(Some(token.to_owned())).1,
                refresher: None,
                channels: Some(Vec::new()),
                http: self.http.clone(),
                timing: Timing::default(),
                bookmarks: None,
            },
            ClientOptions::default(),
        )
    }
}

/// What `waited` gives. One that never ends is a failure and not a hang:
/// ten minutes of this clock is longer than anything here takes.
async fn ends<T>(waited: impl std::future::Future<Output = T>) -> T {
    tokio::time::timeout(Duration::from_secs(600), waited)
        .await
        .expect("it ends")
}

fn message(error: semiont::errors::SemiontError) -> String {
    match error {
        semiont::errors::SemiontError::Bus(error) => error.message,
        semiont::errors::SemiontError::Transport(error) => error.message,
        semiont::errors::SemiontError::Job(error) => error.message,
    }
}

#[tokio::test]
async fn a_refusal_with_no_body_is_worded_as_the_typescript_transport_words_it() {
    let world = World::start().await;
    *world.staged.refuses_everyone.lock().unwrap() = true;
    let client = world.client("a-token");

    let refused = client
        .auth
        .as_ref()
        .expect("a gateway")
        .me()
        .await
        .expect_err("the gateway refuses everyone");

    assert_eq!(refused.code(), "unauthorized");
    assert_eq!(message(refused), "HTTP 401: Unauthorized");
}

#[tokio::test(start_paused = true)]
async fn a_gateway_operation_that_is_never_answered_fails_at_the_deadline_and_is_not_asked_again() {
    let world = World::on_a_quick_clock().await;
    world.never_answers("who");
    let client = world.client("a-token");
    let started = tokio::time::Instant::now();

    let auth = client.auth.as_ref().expect("a gateway");
    let unanswered = ends(auth.me()).await.expect_err("nobody answered");

    assert!(
        took(started.elapsed(), HTTP_REQUEST_TIMEOUT),
        "{:?}",
        started.elapsed()
    );
    assert_eq!(unanswered.code(), "unavailable");
    assert_eq!(
        message(unanswered),
        "GET /api/users/me got no answer within 30s"
    );
    // A deadline is not a dropped connection: the request is not made again.
    assert_eq!(world.staged.asked_who.lock().unwrap().len(), 1);

    // An answer that begins and never ends has the same deadline again.
    world.staged.silent.lock().unwrap().clear();
    *world.staged.trails_off.lock().unwrap() = true;
    let started = tokio::time::Instant::now();
    let unfinished = ends(auth.me()).await.expect_err("it never finished");
    assert!(
        took(started.elapsed(), HTTP_REQUEST_TIMEOUT),
        "{:?}",
        started.elapsed()
    );
    assert_eq!(
        message(unfinished),
        "GET /api/users/me got no answer within 30s"
    );
    client.close().await;
}

#[tokio::test(start_paused = true)]
async fn a_session_whose_gateway_never_says_who_it_is_is_ready_at_the_deadline_and_keeps_its_token()
{
    let world = World::on_a_quick_clock().await;
    world.never_answers("who");
    let access = jwt(3600, 1);
    let storage = storing(&world, "a-script", &access);
    let said: Arc<Mutex<Vec<String>>> = Arc::default();
    let saying = said.clone();
    let started = tokio::time::Instant::now();

    let session = ends(session_from_stored(StoredSignIn {
        kb: world.kb("a-script"),
        storage,
        base_url: world.origin.clone(),
        validate: true,
        on_auth_failed: None,
        on_error: Some(Arc::new(move |error| {
            saying.lock().unwrap().push(error.message)
        })),
        http: world.http.clone(),
    }))
    .await
    .expect("a sign-in is stored");

    assert!(
        took(started.elapsed(), HTTP_REQUEST_TIMEOUT),
        "{:?}",
        started.elapsed()
    );
    assert_eq!(session.token().borrow().as_deref(), Some(access.as_str()));
    assert_eq!(*session.user().borrow(), None);
    let said = said.lock().unwrap().clone();
    assert_eq!(said.len(), 1, "{said:?}");
    assert!(
        said[0].contains("GET /api/users/me got no answer within 30s"),
        "{said:?}"
    );
    session.close().await;
}

#[tokio::test(start_paused = true)]
async fn a_resources_bytes_that_never_begin_fail_at_the_deadline_and_an_upload_takes_as_long_as_it_takes()
 {
    let world = World::on_a_quick_clock().await;
    let client = world.client("a-token");

    // Longer than the deadline, and answered: an upload has none.
    *world.staged.upload_takes.lock().unwrap() = HTTP_REQUEST_TIMEOUT * 3;
    let started = tokio::time::Instant::now();
    let created = ends(async {
        client
            .yield_
            .resource(PutBinaryRequest {
                name: "A note".to_owned(),
                bytes: Bytes::from_static(b"hello"),
                format: "text/plain".to_owned(),
                storage_uri: "file://a-note.txt".to_owned(),
                entity_types: Vec::new(),
                language: None,
                source_annotation_id: None,
                source_resource_id: None,
                generation_prompt: None,
                generator: None,
                job_id: None,
                is_draft: None,
                clone_token: None,
                archive_original: None,
            })
            .await
    })
    .await
    .expect("the upload is answered");
    assert!(
        took(started.elapsed(), HTTP_REQUEST_TIMEOUT * 3),
        "{:?}",
        started.elapsed()
    );
    assert_eq!(created.resource_id, "res-new");

    assert_eq!(
        client
            .browse
            .resource_content(&as_id("res-1"))
            .await
            .expect("it answers"),
        "the bytes of res-1"
    );
    world.never_answers("content");
    let started = tokio::time::Instant::now();
    let unanswered = ends(client.browse.resource_content(&as_id("res-1")))
        .await
        .expect_err("nobody answered");
    assert!(
        took(started.elapsed(), HTTP_REQUEST_TIMEOUT),
        "{:?}",
        started.elapsed()
    );
    assert_eq!(
        message(unanswered),
        "GET /resources/res-1 got no answer within 30s"
    );
    client.close().await;
}

#[tokio::test(start_paused = true)]
async fn an_issuer_that_never_answers_fails_each_request_at_the_deadline() {
    let world = World::on_a_quick_clock().await;

    world.never_answers("token");
    let started = tokio::time::Instant::now();
    let grant = ends(refresh_at_issuer(
        &world.http,
        &format!("{}/token", world.issuer()),
        "semiont-browser",
        "r1",
    ))
    .await
    .expect_err("nobody answered");
    assert!(
        took(started.elapsed(), HTTP_REQUEST_TIMEOUT),
        "{:?}",
        started.elapsed()
    );
    assert_eq!(code(&grant), (SignInErrorCode::Exchange, None));
    assert_eq!(grant.message, "The issuer did not answer within 30s");

    world.never_answers("revoke");
    let started = tokio::time::Instant::now();
    let revocation = ends(revoke_at_issuer(
        &world.http,
        &format!("{}/revoke", world.issuer()),
        "semiont-browser",
        "r1",
    ))
    .await
    .expect_err("nobody answered");
    assert!(
        took(started.elapsed(), HTTP_REQUEST_TIMEOUT),
        "{:?}",
        started.elapsed()
    );
    assert_eq!(revocation.message, "The issuer did not answer within 30s");

    world.never_answers("issuer");
    let started = tokio::time::Instant::now();
    let discovery = ends(discover_issuer(&world.target(), &world.http))
        .await
        .expect_err("nobody answered");
    assert!(
        took(started.elapsed(), HTTP_REQUEST_TIMEOUT),
        "{:?}",
        started.elapsed()
    );
    assert_eq!(code(&discovery), (SignInErrorCode::Discovery, None));
    assert_eq!(
        discovery.message,
        format!(
            "Issuer {}: discovery was not answered within 30s",
            world.issuer()
        )
    );

    world.never_answers("metadata");
    let started = tokio::time::Instant::now();
    let metadata = ends(discover_issuer(&world.target(), &world.http))
        .await
        .expect_err("nobody answered");
    assert!(
        took(started.elapsed(), HTTP_REQUEST_TIMEOUT),
        "{:?}",
        started.elapsed()
    );
    assert_eq!(code(&metadata), (SignInErrorCode::Discovery, None));
}

#[tokio::test(start_paused = true)]
async fn a_renewal_the_issuer_never_answers_is_tried_inside_the_budget_and_then_given_up() {
    let world = World::on_a_quick_clock().await;
    world.never_answers("token");
    let storage = storing(&world, "kb-a", "a1");
    let started = tokio::time::Instant::now();

    let refused = ends(refresh_stored_session(
        storage.as_ref(),
        "kb-a",
        &world.http,
    ))
    .await
    .expect_err("the budget is spent");

    let attempts = REFRESH_RETRY.attempts;
    assert_eq!(world.token_forms().len(), attempts as usize);
    assert_eq!(
        refused.message,
        format!(
            "The session could not be renewed after {attempts} attempts: The issuer did not answer within 30s"
        )
    );
    // Each attempt waited out its deadline, and the backoff came between.
    assert!(started.elapsed() >= HTTP_REQUEST_TIMEOUT * attempts);
    assert!(started.elapsed() < HTTP_REQUEST_TIMEOUT * (attempts + 1));
    // The session it could not renew is still the one stored.
    assert_eq!(
        stored_session(storage.as_ref(), "kb-a"),
        Some(world.stored("a1", "r1"))
    );
}

#[tokio::test(start_paused = true)]
async fn a_service_whose_sign_in_is_never_answered_fails_at_the_deadline() {
    let world = World::on_a_quick_clock().await;
    let credential = || Credential {
        issuer: world.issuer(),
        client_id: "semiont-indexer".to_owned(),
        client_secret: "a-secret".to_owned(),
    };
    let agent = || Agent {
        provider: "example".to_owned(),
        model: "indexer".to_owned(),
    };

    // The gateway's exchange for the agent's token.
    world.answers([granted(&jwt(3600, 1), None)]);
    world.never_answers("agent");
    let started = tokio::time::Instant::now();
    let exchange = ends(AgentToken::sign_in(
        &world.origin,
        agent(),
        ServiceToken::new(credential(), world.http.clone()),
        world.http.clone(),
    ))
    .await
    .err()
    .expect("nobody answered");
    assert!(
        took(started.elapsed(), HTTP_REQUEST_TIMEOUT),
        "{:?}",
        started.elapsed()
    );
    assert!(
        exchange.to_string().contains("got no answer within 30s"),
        "{exchange}"
    );

    // The issuer's grant to the account.
    world.never_answers("token");
    let started = tokio::time::Instant::now();
    let grant = ends(AgentToken::sign_in(
        &world.origin,
        agent(),
        ServiceToken::new(credential(), world.http.clone()),
        world.http.clone(),
    ))
    .await
    .err()
    .expect("nobody answered");
    assert!(
        took(started.elapsed(), HTTP_REQUEST_TIMEOUT),
        "{:?}",
        started.elapsed()
    );
    assert!(
        grant.to_string().contains("got no answer within 30s"),
        "{grant}"
    );

    // The issuer's own description.
    world.never_answers("issuer");
    let started = tokio::time::Instant::now();
    let discovery = ends(AgentToken::sign_in(
        &world.origin,
        agent(),
        ServiceToken::new(credential(), world.http.clone()),
        world.http.clone(),
    ))
    .await
    .err()
    .expect("nobody answered");
    assert!(
        took(started.elapsed(), HTTP_REQUEST_TIMEOUT),
        "{:?}",
        started.elapsed()
    );
    assert!(
        discovery.to_string().contains("got no answer within 30s"),
        "{discovery}"
    );
}

#[tokio::test(start_paused = true)]
async fn a_launchers_document_that_is_never_served_is_unreadable_at_the_deadline() {
    let world = World::on_a_quick_clock().await;
    world.never_answers("document");
    let reader = http_discovery(
        &format!("{}/discovery/kbs.json", world.origin),
        world.http.clone(),
    );
    let started = tokio::time::Instant::now();

    let read = ends(reader.read()).await;

    assert!(
        took(started.elapsed(), HTTP_REQUEST_TIMEOUT),
        "{:?}",
        started.elapsed()
    );
    assert_eq!(absent_for(&read), Some(DiscoveryAbsentReason::Unreadable));
    match read {
        DiscoveryRead::State(DiscoveryState::Absent { diagnostic, .. }) => assert_eq!(
            diagnostic.as_deref(),
            Some("the document was not served within 30s")
        ),
        other => panic!("{other:?}"),
    }
}

// ── The README's examples ───────────────────────────────────────────────
//
// Each fenced Rust block of README.md is one of the regions marked below,
// word for word, and each is run here against the stand-in.

async fn a_script(
    state_home: &Path,
    gateway: &HttpEndpoint,
    http: reqwest::Client,
) -> Result<String, Box<dyn Error>> {
    // <readme:script>
    // The sign-in `semiont login` made for the local stack. The stack's key
    // is the knowledge base's id.
    let store = SignInStore::at(
        state_home.join(FILE_NAME),
        Arc::new(InMemorySessionStorage::new()),
        Arc::new(|why| eprintln!("{why}")),
    );
    let session = session_from_stored(StoredSignIn {
        kb: KbTarget::http(
            "local",
            "Local",
            &gateway.host,
            gateway.port,
            gateway.protocol,
        ),
        storage: Arc::new(store),
        base_url: gateway.gateway_url()?,
        validate: true,
        on_auth_failed: None,
        on_error: None,
        http,
    })
    .await
    .ok_or("Not signed in. Run `semiont login`.")?;

    let about = session.client().browse.kb().await?;
    session.close().await;
    // </readme:script>
    Ok(about.name)
}

async fn a_first_sign_in(
    kb: KbTarget,
    storage: Arc<dyn SessionStorage>,
    http: reqwest::Client,
) -> Result<SemiontSession, SignInError> {
    // <readme:device>
    // The issuer mints a code, and the person approves it wherever they
    // have a browser. No password passes through this process.
    let session = sign_in_device(
        SignInDevice {
            kb,
            storage,
            validate: true,
            on_auth_failed: None,
            on_error: None,
            http,
        },
        |code| {
            println!(
                "Open {} and enter {}",
                code.verification_uri, code.user_code
            )
        },
    )
    .await?;
    // </readme:device>
    Ok(session)
}

async fn a_daemon(
    gateway: &str,
    credential: Credential,
    http: reqwest::Client,
    mut done: impl FnMut(JobCompleteCommand),
) -> Result<(), Box<dyn Error>> {
    // <readme:daemon>
    // A service signs in with its account, as the agent its work runs as,
    // and stays signed in for as long as it holds the token.
    let agent = AgentToken::sign_in(
        gateway,
        Agent {
            provider: "example".to_owned(),
            model: "indexer".to_owned(),
        },
        ServiceToken::new(credential, http.clone()),
        http.clone(),
    )
    .await?;
    let client = client(
        HttpTransportConfig {
            base_url: agent.gateway().to_owned(),
            token: agent.token(),
            refresher: Some(agent.clone()),
            channels: None,
            http,
            timing: Timing::default(),
            bookmarks: None,
        },
        ClientOptions::default(),
    );

    // Every job that completes, from now on.
    let mut completed = client.job.complete();
    while let Some(event) = completed.next().await {
        if let Ok(job) = event {
            done(job.payload);
        }
    }
    // </readme:daemon>
    Ok(())
}

async fn an_application(
    storage: Arc<dyn SessionStorage>,
    gateway: HttpEndpoint,
    http: reqwest::Client,
    open: impl FnOnce(&str),
) -> Result<KnowledgeBase, Box<dyn Error>> {
    // <readme:application>
    // The registry an application holds, with its sessions over HTTP.
    let browser = SemiontBrowser::new(SemiontBrowserConfig {
        storage,
        session_factory: Arc::new(HttpSessionFactory::new(http.clone())),
    });

    // A person signs in at the issuer the knowledge base trusts, in their
    // own browser, and is sent back to a port on this machine.
    let redirect = LoopbackRedirect::bind().await?;
    let url = begin_sign_in(
        &browser,
        BeginAuthorization {
            target: gateway,
            redirect_uri: redirect.redirect_uri(),
            kb_id: None,
            expected_did: None,
            expected_name: None,
        },
        &http,
    )
    .await?;
    open(&url);
    let callback = redirect.callback().await?;

    // The knowledge base that answered is registered, signed in and active.
    let signed_in = complete_sign_in(&browser, &callback, &http).await?;
    // </readme:application>
    browser.close().await;
    Ok(signed_in.kb)
}

/// A state home of its own, removed when the test is done with it.
struct StateHome(std::path::PathBuf);

impl StateHome {
    fn new() -> StateHome {
        let dir = std::env::temp_dir().join(format!("semiont-readme-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("a directory");
        StateHome(dir)
    }
}

impl Drop for StateHome {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[tokio::test]
async fn the_script_uses_the_sign_in_the_launcher_kept_and_says_so_when_there_is_none() {
    let world = World::start().await;
    let home = StateHome::new();

    let none = a_script(&home.0, &world.target(), world.http.clone()).await;
    assert_eq!(
        none.err().map(|refused| refused.to_string()),
        Some("Not signed in. Run `semiont login`.".to_owned())
    );
    assert!(world.staged.asked_who.lock().unwrap().is_empty());

    // As `semiont login` writes it: issued to the script client.
    let access = jwt(3600, 1);
    std::fs::write(
        home.0.join(FILE_NAME),
        json!({ "local": {
            "token": access, "refreshToken": "r1", "email": "alice@example.org",
            "obtainedAt": "2026-10-01T12:00:00Z", "issuer": world.issuer(),
            "tokenEndpoint": format!("{}/token", world.issuer()),
        }})
        .to_string(),
    )
    .expect("a file");

    let name = a_script(&home.0, &world.target(), world.http.clone())
        .await
        .expect("it is signed in");

    assert_eq!(name, "KB A");
    // The token the launcher kept is the one the gateway was asked about.
    assert_eq!(*world.staged.asked_who.lock().unwrap(), [access]);
}

#[tokio::test]
async fn a_session_over_a_stored_sign_in_renews_at_the_issuer_the_sign_in_names() {
    let world = World::start().await;
    let storage = storing(&world, "a-script", &jwt(3600, 1));
    let renewed = jwt(3600, 2);
    world.answers([granted(&renewed, Some("r2"))]);

    let session = session_from_stored(StoredSignIn {
        kb: world.kb("a-script"),
        storage: storage.clone(),
        base_url: world.origin.clone(),
        validate: false,
        on_auth_failed: None,
        on_error: None,
        http: world.http.clone(),
    })
    .await
    .expect("a sign-in is stored");

    assert_eq!(session.refresh().await, Some(renewed.clone()));
    assert_eq!(
        stored_session(storage.as_ref(), "a-script"),
        Some(world.stored(&renewed, "r2"))
    );
    assert_eq!(world.token_forms().len(), 1);
    // It was not asked who it is: nobody said to.
    assert!(world.staged.asked_who.lock().unwrap().is_empty());
    session.close().await;
}

#[tokio::test(start_paused = true)]
async fn a_first_sign_in_shows_the_code_and_gives_a_session_that_knows_who_it_is() {
    let world = World::on_a_quick_clock().await;
    let storage = Arc::new(InMemorySessionStorage::new());
    let access = jwt(3600, 1);
    world.answers([granted(&access, Some("a-refresh-token"))]);

    let session = a_first_sign_in(world.kb("a-script"), storage.clone(), world.http.clone())
        .await
        .expect("a session");

    assert_eq!(session.token().borrow().as_deref(), Some(access.as_str()));
    assert_eq!(*world.staged.asked_who.lock().unwrap(), [access]);
    assert!(stored_session(storage.as_ref(), "a-script").is_some());
    session.close().await;
}

#[tokio::test]
async fn the_daemon_signs_in_as_an_agent_and_is_given_each_completion() {
    let world = World::start().await;
    // The account's own token, from the issuer's client-credentials grant.
    world.answers([granted(&jwt(3600, 1), None)]);
    let (seen, mut completions) = mpsc::unbounded_channel();
    let running = tokio::spawn({
        let (gateway, issuer, http) = (world.origin.clone(), world.issuer(), world.http.clone());
        async move {
            a_daemon(
                &gateway,
                Credential {
                    issuer,
                    client_id: "semiont-indexer".to_owned(),
                    client_secret: "a-secret".to_owned(),
                },
                http,
                move |job| {
                    let _ = seen.send(job.job_id);
                },
            )
            .await
            .map_err(|failed| failed.to_string())
        }
    });
    until("the daemon's stream is open", || {
        !world.staged.streams.lock().unwrap().is_empty()
    })
    .await;

    let frame = json!({ "channel": "job:complete", "payload": {
        "resourceId": "res-1", "jobId": "job-1", "jobType": "highlight-annotation",
    }});
    let event = Bytes::from(format!("event: bus-event\nid: e-1\ndata: {frame}\n\n"));
    for stream in world.staged.streams.lock().unwrap().iter() {
        let _ = stream.send(event.clone());
    }

    let completed = tokio::time::timeout(Duration::from_secs(10), completions.recv())
        .await
        .expect("the completion arrives");
    assert_eq!(completed.as_deref(), Some("job-1"));
    // The stream was opened as the agent, with the token the gateway gave.
    assert_eq!(
        world.token_forms()[0].get("grant_type").map(String::as_str),
        Some("client_credentials")
    );
    running.abort();
}

#[tokio::test]
async fn the_application_signs_a_person_in_through_the_loopback_redirect() {
    let world = World::start().await;
    let storage = Arc::new(InMemorySessionStorage::new());
    let access = jwt(3600, 1);
    world.answers([granted(&access, Some("a-refresh-token"))]);
    let person = world.http.clone();

    let kb = an_application(storage.clone(), world.target(), world.http.clone(), |url| {
        // The person's browser: the issuer sends it back with a code.
        let asked = query(url);
        let sent_back = format!(
            "{}?state={}&code=the-code",
            asked["redirect_uri"], asked["state"]
        );
        tokio::spawn(async move { person.get(sent_back).send().await });
    })
    .await
    .expect("the sign-in completes");

    assert_eq!(kb.did, DID_A);
    assert_eq!(
        stored_session(storage.as_ref(), &kb.id).map(|stored| stored.access),
        Some(access)
    );
}

#[test]
fn every_rust_block_of_the_readme_is_an_example_that_ran_here() {
    assert_readme_shows(include_str!("../README.md"), &[include_str!("sign_in.rs")])
        .unwrap_or_else(|odd| panic!("{odd}"));
}
