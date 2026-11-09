//! Signing a person in, and their sessions over a gateway: the issuer's
//! grants, a stored session's renewal, a session built over HTTP, a
//! registry's sign-in landing on the knowledge base that answered, the
//! launcher's discovery document over HTTP, and the loopback redirect. And
//! an agent's sign-in, as its account.
//!
//! One stand-in serves as the gateway and as the issuer it trusts. A test
//! says what each answers and reads what each was asked.

mod quick_clock;

use axum::Router;
use axum::body::Body;
use axum::extract::{Path as Named, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use base64::Engine;
use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use bytes::Bytes;
use futures::FutureExt;
use quick_clock::QuickClock;
use ring::signature::{RSA_PKCS1_2048_8192_SHA256, RsaPublicKeyComponents};
use semiont::annotations::{QuotedText, annotation_of_span, reconcile};
use semiont::channels::PrincipalProfile;
use semiont::claims::{ClaimOptions, HeldJob, JOB_CLAIM_CHANNELS, JOB_COMMIT_CHANNELS, JobFailure};
use semiont::client::ClientOptions;
use semiont::discovery::{
    DiscoveryAbsentReason, DiscoveryRead, DiscoveryState, DiscoveryTransport,
};
use semiont::errors::{
    BusRequestErrorCode, IdentityUnverifiable, IdentityUnverifiableReason, SemiontError,
    SessionError, SessionErrorCode, SignInError, SignInErrorCode,
};
use semiont::identity::agent_did;
use semiont::refresh::CacheQuery;
use semiont::roles::{AGENT_KIND, KIND_CLAIM, is_agent};
use semiont::session::{
    MemorySignIn, OpenedSession, SemiontBrowser, SemiontBrowserConfig, SemiontSession,
    SessionEndReason, SignInKept, StoredSession, cache_key, kept_in, last_event_id_key, person_key,
    save_knowledge_bases, store_session, stored_session,
};
use semiont::sign_in_store::{FILE_NAME, SignInStore};
use semiont::storage::{InMemorySessionStorage, SessionStorage};
use semiont::testing::as_id;
use semiont::testing::examples::{assert_blocks_are_examples, assert_readme_shows};
use semiont::timing::{DEVICE_SLOW_DOWN, HTTP_REQUEST_TIMEOUT};
use semiont::transport::{BoxFuture, Envelope, Events, Lagged, PutBinaryRequest};
use semiont::types::{
    AgentSoftware, Annotation, FailureClass, HttpEndpoint, HttpEndpointProtocol,
    JobCompleteCommand, JobProgress, KbEndpoint, KbTarget, KnowledgeBase, LocalEndpoint,
    MarkJobDone, MarkJobFilter, MarkJobFilterParams, Motivation, PrincipalProfileCommand,
};
use semiont_http_transport::agent::{AgentSignInError, AgentToken};
use semiont_http_transport::client::client;
use semiont_http_transport::client_assertion::{JWT_BEARER, LIFETIME_SECONDS, thumbprint};
use semiont_http_transport::discovery::http_discovery;
use semiont_http_transport::loopback::LoopbackRedirect;
use semiont_http_transport::oauth::{
    BeginAuthorization, DeviceCode, PENDING_AUTHORIZATION_KEY, PendingAuthorization,
    begin_authorization, code_challenge, complete_authorization, discover_issuer,
    refresh_at_issuer, renew_kept, revoke_at_issuer, sign_in_with_device_grant,
};
use semiont_http_transport::service_account::{
    Credential, KeyCredential, KeyError, SecretCredential, ServiceToken, private_key_from_pem,
};
use semiont_http_transport::session::{
    HttpSessionFactory, SessionFromKept, begin_sign_in, complete_sign_in, describe_connection,
    session_from_kept, sign_in_device, sign_out,
};
use semiont_http_transport::transport::{HttpTransportConfig, Timing, TokenRefresher};
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet, VecDeque};
use std::error::Error;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
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
    /// `issuer`, `token`, `revoke`, `document`, `content`.
    silent: Mutex<HashSet<&'static str>>,
    /// The status with which, asked who a token is, it begins its answer and
    /// never finishes it; none when it answers.
    trails_off: Mutex<Option<StatusCode>>,
    /// How long it takes to answer an upload.
    upload_takes: Mutex<Duration>,
    describes: Mutex<Describes>,
    /// What the gateway answers the other requests with: by request channel,
    /// the channel of the answer and its payload.
    answers: Mutex<HashMap<String, (String, Value)>>,
    /// The jobs its queue hands a claim, in order. A claim made when none is
    /// left is not answered.
    claimable: Mutex<VecDeque<Value>>,
    /// Every emit its bus accepted, in order.
    emitted: Mutex<Vec<Value>>,
    /// What each stream was opened with, and the token it carried.
    subscriptions: Mutex<Vec<Value>>,
    subscribed_with: Mutex<Vec<String>>,
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

/// Who the gateway says a person's token is.
const ALICE: &str = "did:web:example.org:users:alice";

async fn me(State(staged): State<Arc<Staged>>, headers: HeaderMap) -> Response {
    let token = bearer(&headers);
    staged.asked_who.lock().unwrap().push(token.clone());
    staged.held("who").await;
    let trailing = *staged.trails_off.lock().unwrap();
    if let Some(status) = trailing {
        let begun = tokio_stream::once(Ok::<Bytes, std::convert::Infallible>(Bytes::from_static(
            b"{\"did\":",
        )))
        .chain(tokio_stream::pending());
        return (
            status,
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
    // The holder of an agent's token is named as an agent, by its subject.
    if let Some(claims) = claims_of(&token).filter(is_agent) {
        let subject = claims["sub"]
            .as_str()
            .expect("an agent's token has a subject");
        return json_answer(
            200,
            json!({
                "did": agent_did("example.org", subject), "email": null,
                "name": null, "image": null, "domain": "example.org",
            }),
        );
    }
    json_answer(
        200,
        json!({
            "did": ALICE, "email": "alice@example.org",
            "name": "Alice", "image": null, "domain": "example.org",
        }),
    )
}

/// The claims of a token the stand-in's issuer granted; none for a token
/// that is not one.
fn claims_of(token: &str) -> Option<serde_json::Map<String, Value>> {
    let claims = URL_SAFE_NO_PAD.decode(token.split('.').nth(1)?).ok()?;
    serde_json::from_slice(&claims).ok()
}

async fn subscribe(
    State(staged): State<Arc<Staged>>,
    headers: HeaderMap,
    body: String,
) -> Response {
    staged
        .subscriptions
        .lock()
        .unwrap()
        .push(serde_json::from_str(&body).expect("a subscription"));
    staged
        .subscribed_with
        .lock()
        .unwrap()
        .push(bearer(&headers));
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
    staged.emitted.lock().unwrap().push(sent.clone());
    let asked = sent["channel"].as_str().unwrap_or_default();
    let answer = if asked == "job:claim" {
        let next = staged.claimable.lock().unwrap().pop_front();
        next.map(|job| ("job:claimed".to_owned(), json!({ "response": job })))
    } else if asked == "mark:commit" {
        // The record's acknowledgement: the batch as it was sent.
        let ids: Vec<Value> = sent["payload"]["annotations"]
            .as_array()
            .map(|batch| batch.iter().map(|sent| sent["id"].clone()).collect())
            .unwrap_or_default();
        Some((
            "mark:commit-ok".to_owned(),
            json!({ "response": { "persisted": ids.len(), "annotationIds": ids } }),
        ))
    } else if asked == "browse:kb-requested" {
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
    /// For a test whose runtime starts paused: a request that is on its way
    /// arrives long before its deadline.
    clock: Option<QuickClock>,
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
            claimable: Mutex::default(),
            emitted: Mutex::default(),
            subscriptions: Mutex::default(),
            subscribed_with: Mutex::default(),
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
        HttpEndpoint::new("127.0.0.1", self.port, HttpEndpointProtocol::Http)
    }

    fn kb(&self, id: &str) -> KbTarget {
        KbTarget::http(
            id,
            "KB A",
            "127.0.0.1",
            self.port,
            HttpEndpointProtocol::Http,
        )
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
            person_key: None,
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
    token_of(expires_in, json!({ "n": n }))
}

/// A token of an agent's account: its subject, and the kind the realm stamps
/// on every agent's.
fn agent_jwt(expires_in: i64, n: u64, subject: &str) -> String {
    token_of(
        expires_in,
        json!({ "n": n, "sub": subject, KIND_CLAIM: AGENT_KIND }),
    )
}

fn token_of(expires_in: i64, mut claims: Value) -> String {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("after the epoch")
        .as_secs() as i64;
    claims["iat"] = json!(now);
    claims["exp"] = json!(now + expires_in);
    format!(
        "{}.{}.sig",
        URL_SAFE_NO_PAD.encode(r#"{"alg":"none"}"#),
        URL_SAFE_NO_PAD.encode(claims.to_string())
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
        .map_err(sign_in_error)
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
        .map_err(sign_in_error)
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
    .map_err(sign_in_error)
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
    .map_err(sign_in_error)
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

/// The sign-in error a failure is.
fn sign_in_error(failure: Box<dyn Error + Send + Sync>) -> SignInError {
    match failure.downcast::<SignInError>() {
        Ok(refused) => *refused,
        Err(other) => panic!("{other} is not a sign-in error"),
    }
}

/// The key a pending sign-in is kept under is protocol/specs/src/session/stored.json's;
/// semiont's tests hold the table's other keys.
#[test]
fn a_pending_sign_in_is_kept_under_the_tables_key() {
    let table: Value = serde_json::from_str(include_str!(
        "../../../../protocol/specs/src/session/stored.json"
    ))
    .expect("the table");
    let key = table["keys"]
        .as_array()
        .expect("the keys")
        .iter()
        .find(|entry| entry["member"] == "pendingAuthorizationKey")
        .and_then(|entry| entry["key"].as_str())
        .expect("the table names the pending sign-in's key");
    assert_eq!(PENDING_AUTHORIZATION_KEY, key);
}

/// The members an object schema of the table names.
fn members_of(shape: &Value) -> HashSet<String> {
    shape["properties"]
        .as_object()
        .expect("the shape names its members")
        .keys()
        .cloned()
        .collect()
}

/// The members an object schema of the table requires.
fn required_of(shape: &Value) -> HashSet<String> {
    shape["required"]
        .as_array()
        .expect("the shape requires members")
        .iter()
        .map(|member| member.as_str().expect("a member is named").to_owned())
        .collect()
}

/// What is kept of a sign-in begun is protocol/specs/src/session/stored.json's
/// `pendingAuthorization`: every member it names when the person believed
/// something, and only what it requires when they named nothing.
#[tokio::test]
async fn a_sign_in_begun_is_kept_as_the_table_states_it() {
    let table: Value = serde_json::from_str(include_str!(
        "../../../../protocol/specs/src/session/stored.json"
    ))
    .expect("the table");
    let shape = &table["pendingAuthorization"];
    let issuer = &shape["properties"]["issuer"];
    let written = |storage: &InMemorySessionStorage| -> HashSet<String> {
        let record: Value = serde_json::from_str(
            &storage
                .get(PENDING_AUTHORIZATION_KEY)
                .expect("a pending sign-in"),
        )
        .expect("a pending sign-in is JSON");
        let kept: HashSet<String> = record["issuer"]
            .as_object()
            .expect("an issuer")
            .keys()
            .cloned()
            .collect();
        assert!(
            required_of(issuer).is_subset(&kept) && kept.is_subset(&members_of(issuer)),
            "its issuer is kept with {kept:?}"
        );
        record
            .as_object()
            .expect("a pending sign-in is an object")
            .keys()
            .cloned()
            .collect()
    };
    let world = World::start().await;

    let believed = InMemorySessionStorage::new();
    begin_authorization(
        BeginAuthorization {
            kb_id: Some("kb-a".to_owned()),
            expected_did: Some("did:web:example.org:kb-a".to_owned()),
            expected_name: Some("KB A".to_owned()),
            ..world.begin()
        },
        &believed,
        &world.http,
    )
    .await
    .expect("a URL");
    assert_eq!(written(&believed), members_of(shape));

    let bare = InMemorySessionStorage::new();
    begin_authorization(world.begin(), &bare, &world.http)
        .await
        .expect("a URL");
    assert_eq!(written(&bare), required_of(shape));
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
    // its five seconds, five, and then five and the step a `slow_down` adds.
    assert!(
        took(
            started.elapsed(),
            Duration::from_secs(15) + DEVICE_SLOW_DOWN
        ),
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

/// RFC 8628 §3.2 requires `expires_in` of a device authorization answer: one
/// without it has answered without what was asked for, and a code whose
/// lifetime nobody knows is shown to nobody.
#[tokio::test]
async fn a_device_authorization_answer_with_no_lifetime_is_refused() {
    let world = World::start().await;
    world
        .staged
        .device_answer
        .lock()
        .unwrap()
        .1
        .as_object_mut()
        .expect("the answer is an object")
        .remove("expires_in");
    let shown = Arc::new(Mutex::new(0));
    let showing = shown.clone();

    let refused = sign_in_with_device_grant(
        &world.target(),
        move |_| *showing.lock().unwrap() += 1,
        &world.http,
    )
    .await
    .expect_err("the answer has no lifetime");

    assert_eq!(code(&refused), (SignInErrorCode::Exchange, Some(200)));
    assert_eq!(
        refused.message,
        "The issuer refused the device authorization request (HTTP 200)"
    );
    assert_eq!(*shown.lock().unwrap(), 0);
    assert!(world.token_forms().is_empty());
}

// ── Sessions over a gateway ─────────────────────────────────────────────

/// A sign-in kept in memory, holding `access` and "r1".
async fn kept_holding(world: &World, access: &str) -> Arc<MemorySignIn> {
    let kept = Arc::new(MemorySignIn::new());
    kept.keep(world.stored(access, "r1")).await.expect("kept");
    kept
}

/// What `kept` holds: a read that fails is no answer.
async fn held_by(kept: &dyn SignInKept) -> Option<StoredSession> {
    kept.held().await.expect("the sign-in is read")
}

/// A script's session of "a-script" over the sign-in `kept` holds, which
/// asks who its token is and keeps no caches.
fn from_kept(world: &World, kept: Arc<dyn SignInKept>) -> SessionFromKept {
    SessionFromKept {
        kb: world.kb("a-script"),
        kept,
        validate: true,
        storage: None,
        on_auth_failed: None,
        http: world.http.clone(),
        random: None,
    }
}

/// What a session says of its own on its errors stream (each a
/// `SessionError`), read from the stream as it is said. The transport's
/// failures it carries beside them are other tests' to read. A reader that
/// missed any of it fails its test.
struct Said {
    errors: Events<SemiontError>,
    said: Vec<SessionError>,
}

impl Said {
    /// What `session` says from here on, and what it said before anyone
    /// read its errors: a session opened from a kept sign-in is given once
    /// it is ready, after its start has said what it says.
    fn by(session: &SemiontSession) -> Said {
        Said {
            errors: session.errors(),
            said: Vec::new(),
        }
    }

    fn heard(&mut self, item: Result<SemiontError, Lagged>) {
        match item {
            Ok(SemiontError::Session(error)) => self.said.push(error),
            Ok(_) => {}
            Err(missed) => panic!("the session's errors stream missed some: {missed}"),
        }
    }

    /// Everything said so far, in order.
    fn so_far(&mut self) -> &[SessionError] {
        while let Some(Some(item)) = self.errors.next().now_or_never() {
            self.heard(item);
        }
        &self.said
    }

    /// Everything said until the stream ends, which it must, ten seconds at
    /// the latest after its session was closed.
    async fn to_its_end(mut self) -> Vec<SessionError> {
        loop {
            let next = tokio::time::timeout(Duration::from_secs(10), self.errors.next())
                .await
                .expect("the session's errors stream ends");
            match next {
                Some(item) => self.heard(item),
                None => return self.said,
            }
        }
    }
}

fn codes(said: &[SessionError]) -> Vec<SessionErrorCode> {
    said.iter().map(|error| error.code).collect()
}

/// A sign-in kept in memory, read as a file or a keychain is read: each
/// read waits on the runtime before it answers, so a read driven where
/// nothing may wait (`futures::executor::block_on`, on the runtime's own
/// thread) never ends. It cannot be read while `unreadable` holds, and will
/// not record who the gateway named while `unrecordable` holds.
struct ReadAsAFile {
    kept: MemorySignIn,
    unreadable: AtomicBool,
    unrecordable: AtomicBool,
}

impl ReadAsAFile {
    async fn holding(sign_in: StoredSession) -> Arc<ReadAsAFile> {
        let kept = MemorySignIn::new();
        kept.keep(sign_in).await.expect("kept");
        Arc::new(ReadAsAFile {
            kept,
            unreadable: AtomicBool::new(false),
            unrecordable: AtomicBool::new(false),
        })
    }
}

impl SignInKept for ReadAsAFile {
    fn held(&self) -> BoxFuture<'_, Result<Option<StoredSession>, Box<dyn Error + Send + Sync>>> {
        Box::pin(async move {
            tokio::time::sleep(Duration::from_millis(1)).await;
            if self.unreadable.load(Ordering::SeqCst) {
                return Err("the sign-in could not be read".into());
            }
            self.kept.held().await
        })
    }

    fn keep(
        &self,
        sign_in: StoredSession,
    ) -> BoxFuture<'_, Result<(), Box<dyn Error + Send + Sync>>> {
        self.kept.keep(sign_in)
    }

    fn renewed<'a>(
        &'a self,
        read: &'a StoredSession,
        access: &'a str,
        refresh: &'a str,
    ) -> BoxFuture<'a, Result<Option<String>, Box<dyn Error + Send + Sync>>> {
        self.kept.renewed(read, access, refresh)
    }

    fn record_person_key<'a>(
        &'a self,
        access: &'a str,
        person_key: &'a str,
    ) -> BoxFuture<'a, Result<bool, Box<dyn Error + Send + Sync>>> {
        if self.unrecordable.load(Ordering::SeqCst) {
            return Box::pin(async {
                Err("the sign-in could not record who the gateway named".into())
            });
        }
        self.kept.record_person_key(access, person_key)
    }

    fn forget(&self) -> BoxFuture<'_, Result<(), Box<dyn Error + Send + Sync>>> {
        self.kept.forget()
    }
}

impl World {
    /// The gateway answers who asks for the entity types: a query
    /// client/refresh.json marks persisted.
    fn answers_entity_types(&self) {
        self.staged.answers.lock().unwrap().insert(
            "browse:entity-types-requested".to_owned(),
            (
                "browse:entity-types-result".to_owned(),
                json!({ "response": { "entityTypes": ["Person", "Place"] } }),
            ),
        );
    }
}

#[tokio::test]
async fn a_session_over_a_kept_sign_in_is_ready_and_says_who_it_is() {
    let world = World::start().await;
    let access = jwt(3600, 1);
    let kept = kept_holding(&world, &access).await;

    let opened = session_from_kept(from_kept(&world, kept.clone()))
        .await
        .expect("a session");
    let session = opened.session();

    assert_eq!(session.token().borrow().as_deref(), Some(access.as_str()));
    assert_eq!(
        held_by(kept.as_ref()).await,
        Some(world.stored(&access, "r1"))
    );
    assert_eq!(*world.staged.asked_who.lock().unwrap(), [access]);
    assert_eq!(
        session
            .user()
            .borrow()
            .as_ref()
            .and_then(|user| user.email.clone()),
        Some("alice@example.org".to_owned())
    );
    opened.close().await;
}

/// A script's session given a storage keeps its caches there, as a
/// registry's session does, for the person the gateway names: what a query
/// client/refresh.json marks persisted held is written under its key for
/// the knowledge base and that person, by the time the session's client
/// has closed (protocol/contract/CACHE-SEMANTICS.md B17).
#[tokio::test]
async fn a_scripts_session_given_a_storage_keeps_its_caches_there_for_the_person_named() {
    let world = World::start().await;
    world.answers_entity_types();
    let kept = kept_holding(&world, &jwt(3600, 1)).await;
    let storage: Arc<dyn SessionStorage> = Arc::new(InMemorySessionStorage::new());

    let opened = session_from_kept(SessionFromKept {
        storage: Some(storage.clone()),
        ..from_kept(&world, kept)
    })
    .await
    .expect("a session");
    let entity_types = opened
        .session()
        .client()
        .browse
        .entity_types()
        .fresh()
        .await
        .expect("the entity types");
    assert_eq!(entity_types, ["Person", "Place"]);
    opened.close().await;

    let key = cache_key("a-script", &person_key(ALICE), CacheQuery::EntityTypes);
    let document: Value = serde_json::from_str(
        &storage
            .get(&key)
            .unwrap_or_else(|| panic!("nothing is kept under {key}")),
    )
    .expect("the document is JSON");
    let entries = document["entries"].as_array().expect("its entries");
    assert_eq!(entries.len(), 1, "{document}");
    assert_eq!(entries[0][0], json!("_"), "{document}");
    assert_eq!(entries[0][1], json!(["Person", "Place"]), "{document}");
}

/// What the session's client still owes as the script closes it is saved
/// before the session's errors end: a closing save whose sign-in cannot be
/// read is said once, as `session.keep-failed`, and then the stream ends.
/// The check before the save awaits its read of the sign-in, as a read of a
/// file is awaited.
#[tokio::test]
async fn a_closing_save_whose_sign_in_cannot_be_read_is_said_before_the_sessions_errors_end() {
    let world = World::start().await;
    world.answers_entity_types();
    let kept = ReadAsAFile::holding(world.stored(&jwt(3600, 1), "r1")).await;
    let storage: Arc<dyn SessionStorage> = Arc::new(InMemorySessionStorage::new());
    let opened = session_from_kept(SessionFromKept {
        storage: Some(storage.clone()),
        ..from_kept(&world, kept.clone())
    })
    .await
    .expect("a session");
    let said = Said::by(opened.session());
    opened
        .session()
        .client()
        .browse
        .entity_types()
        .fresh()
        .await
        .expect("the entity types");

    // Owed, and not yet written, when the sign-in can be read no more.
    kept.unreadable.store(true, Ordering::SeqCst);
    opened.close().await;

    assert_eq!(
        codes(&said.to_its_end().await),
        [SessionErrorCode::KeepFailed]
    );
    let key = cache_key("a-script", &person_key(ALICE), CacheQuery::EntityTypes);
    assert_eq!(storage.get(&key), None, "what was owed is not written");
}

/// A sign-in that will not record who the gateway named is not known to
/// name them: nothing is kept for them, and the session says so once, as
/// `session.keep-failed`, and goes on, signed in.
#[tokio::test]
async fn a_sign_in_that_cannot_record_who_the_gateway_named_keeps_nothing_and_says_so_once() {
    let world = World::start().await;
    world.answers_entity_types();
    let kept = ReadAsAFile::holding(world.stored(&jwt(3600, 1), "r1")).await;
    kept.unrecordable.store(true, Ordering::SeqCst);
    let storage: Arc<dyn SessionStorage> = Arc::new(InMemorySessionStorage::new());

    let opened = session_from_kept(SessionFromKept {
        storage: Some(storage.clone()),
        ..from_kept(&world, kept.clone())
    })
    .await
    .expect("a session");
    // Said as the session started, before it was given.
    let said = Said::by(opened.session());
    assert_eq!(
        opened
            .session()
            .user()
            .borrow()
            .as_ref()
            .and_then(|user| user.email.clone()),
        Some("alice@example.org".to_owned())
    );
    opened
        .session()
        .client()
        .browse
        .entity_types()
        .fresh()
        .await
        .expect("the entity types");
    opened.close().await;

    let said = said.to_its_end().await;
    assert_eq!(codes(&said), [SessionErrorCode::KeepFailed]);
    assert!(
        said[0]
            .message
            .contains("the sign-in could not record who the gateway named"),
        "{}",
        said[0].message
    );
    for key in kept_for("a-script", ALICE) {
        assert_eq!(storage.get(&key), None, "{key}");
    }
}

/// A sign-in that cannot be read as its session is opened is the opener's
/// failure, as it is in every SDK: no session is given, with a storage or
/// without one, and neither the gateway nor the issuer is asked anything.
#[tokio::test]
async fn a_sign_in_that_cannot_be_read_as_its_session_is_opened_fails_the_opening() {
    let world = World::start().await;
    let storages: [Option<Arc<dyn SessionStorage>>; 2] =
        [None, Some(Arc::new(InMemorySessionStorage::new()))];
    for storage in storages {
        let kept = ReadAsAFile::holding(world.stored(&jwt(3600, 1), "r1")).await;
        kept.unreadable.store(true, Ordering::SeqCst);

        let refused = session_from_kept(SessionFromKept {
            storage,
            ..from_kept(&world, kept)
        })
        .await
        .err()
        .expect("no session is given");

        assert!(
            refused
                .to_string()
                .contains("the sign-in could not be read"),
            "{refused}"
        );
    }
    assert!(world.staged.asked_who.lock().unwrap().is_empty());
    assert!(world.token_forms().is_empty());
}

/// A script renews a sign-in it keeps with no session over it
/// (`renew_kept`): at the issuer the sign-in names, as the client it was
/// issued to, and what the issuer rotated is kept. With nothing kept there
/// is nothing to renew, and nobody is asked.
#[tokio::test]
async fn a_script_renews_a_sign_in_it_keeps_at_the_issuer_the_sign_in_names() {
    let world = World::start().await;
    let (first, second) = (jwt(3600, 1), jwt(3600, 2));
    world.answers([granted(&second, Some("r2"))]);
    let kept = kept_holding(&world, &first).await;

    let renewed = renew_kept(kept.as_ref(), Some(first.as_str()), &world.http, None)
        .await
        .expect("renewed");

    assert_eq!(renewed, Some(second.clone()));
    let forms = world.token_forms();
    assert_eq!(forms.len(), 1);
    assert_eq!(forms[0]["grant_type"], "refresh_token");
    assert_eq!(forms[0]["refresh_token"], "r1");
    assert_eq!(forms[0]["client_id"], "semiont-browser");
    assert_eq!(
        held_by(kept.as_ref()).await,
        Some(world.stored(&second, "r2"))
    );

    let nothing = MemorySignIn::new();
    assert_eq!(
        renew_kept(&nothing, None, &world.http, None)
            .await
            .expect("nothing to renew"),
        None
    );
    assert_eq!(world.token_forms().len(), 1);
}

/// With nothing kept, the session is signed out: it has no token, nobody is
/// asked who it is, and a request through its client is refused without a
/// renewal.
#[tokio::test]
async fn with_nothing_kept_a_session_is_signed_out() {
    let world = World::start().await;
    let kept = Arc::new(MemorySignIn::new());

    let opened = session_from_kept(from_kept(&world, kept.clone()))
        .await
        .expect("a session");
    let session = opened.session();

    assert_eq!(*session.token().borrow(), None);
    assert_eq!(*session.user().borrow(), None);
    assert!(world.staged.asked_who.lock().unwrap().is_empty());
    let auth = session.client().auth.as_ref().expect("auth");
    assert!(ends(auth.me()).await.is_err());
    assert!(world.token_forms().is_empty());
    assert_eq!(held_by(kept.as_ref()).await, None);
    opened.close().await;
}

/// A knowledge base reached any other way than over HTTP has no session
/// over a gateway: refused before anything is asked.
#[tokio::test]
async fn a_knowledge_base_not_reached_over_http_has_no_session_over_a_gateway() {
    let world = World::start().await;
    let kept = kept_holding(&world, &jwt(3600, 1)).await;

    let refused = session_from_kept(SessionFromKept {
        kb: KbTarget {
            id: "in-process".to_owned(),
            label: "Here".to_owned(),
            endpoint: KbEndpoint::LocalEndpoint(LocalEndpoint::new("here")),
        },
        ..from_kept(&world, kept)
    })
    .await
    .err()
    .expect("no session is built");

    assert_eq!(refused.code, SessionErrorCode::ConstructFailed);
    assert_eq!(refused.kb_id.as_deref(), Some("in-process"));
    assert!(world.staged.asked_who.lock().unwrap().is_empty());
}

/// Every key a person's queries and stream's places are kept under on a
/// knowledge base.
fn kept_for(kb_id: &str, did: &str) -> Vec<String> {
    let person = person_key(did);
    CacheQuery::PERSISTED
        .iter()
        .map(|query| cache_key(kb_id, &person, *query))
        .chain([last_event_id_key(kb_id, &person)])
        .collect()
}

const BOB: &str = "did:web:example.org:users:bob";

/// What a client kept for alice and for bob on "a-script", and for alice on
/// another knowledge base, each under every key of theirs; and a sign-in of
/// "a-script" that names alice, or nobody.
fn kept_and_signed_in(world: &World, names: Option<&str>) -> Arc<InMemorySessionStorage> {
    let storage = Arc::new(InMemorySessionStorage::new());
    for key in kept_for("a-script", ALICE)
        .into_iter()
        .chain(kept_for("a-script", BOB))
        .chain(kept_for("another", ALICE))
    {
        storage.set(&key, "kept").expect("stored");
    }
    store_session(
        storage.as_ref(),
        "a-script",
        &StoredSession {
            person_key: names.map(person_key),
            ..world.stored("a0", "r0")
        },
    )
    .expect("stored");
    storage
}

/// Saving a new sign-in into a storage replaces the one it holds, and
/// forgets it: what was kept for the person it named is deleted, though the
/// new one may turn out to be theirs, as it names nobody until its gateway
/// names them (protocol/specs/src/session/persisted-cases.json, `forget`).
/// Nobody else's is, nor theirs on another knowledge base.
#[tokio::test]
async fn a_new_sign_in_saved_over_one_naming_a_person_deletes_what_was_kept_for_them() {
    let world = World::start().await;
    let storage = kept_and_signed_in(&world, Some(ALICE));
    let access = jwt(3600, 1);

    store_session(storage.as_ref(), "a-script", &world.stored(&access, "r1")).expect("stored");

    assert_eq!(
        stored_session(storage.as_ref(), "a-script"),
        Some(world.stored(&access, "r1"))
    );
    let left: Vec<String> = kept_for("a-script", ALICE)
        .into_iter()
        .filter(|key| storage.get(key).is_some())
        .collect();
    assert!(left.is_empty(), "alice's keys left: {left:?}");
    for key in kept_for("a-script", BOB)
        .into_iter()
        .chain(kept_for("another", ALICE))
    {
        assert_eq!(storage.get(&key).as_deref(), Some("kept"), "{key}");
    }
}

/// A sign-in that named nobody leaves nothing known to be anyone's: saving
/// a new one over it deletes nothing.
#[tokio::test]
async fn a_new_sign_in_saved_over_one_naming_nobody_deletes_nothing() {
    let world = World::start().await;
    let storage = kept_and_signed_in(&world, None);
    let access = jwt(3600, 1);

    store_session(storage.as_ref(), "a-script", &world.stored(&access, "r1")).expect("stored");

    assert_eq!(
        stored_session(storage.as_ref(), "a-script"),
        Some(world.stored(&access, "r1"))
    );
    for key in kept_for("a-script", ALICE)
        .into_iter()
        .chain(kept_for("a-script", BOB))
        .chain(kept_for("another", ALICE))
    {
        assert_eq!(storage.get(&key).as_deref(), Some("kept"), "{key}");
    }
}

#[tokio::test]
async fn asking_who_a_token_is_opens_no_stream_of_its_own() {
    let world = World::start().await;
    let access = jwt(3600, 1);
    let kept = kept_holding(&world, &access).await;

    let opened = session_from_kept(from_kept(&world, kept))
        .await
        .expect("a session");
    until("the session's stream is open", || {
        !world.staged.subscriptions.lock().unwrap().is_empty()
    })
    .await;
    tokio::time::sleep(Duration::from_millis(200)).await;

    // The session's own stream, and no other: the gateway was asked who the
    // token is by one request.
    assert_eq!(*world.staged.asked_who.lock().unwrap(), [access]);
    assert_eq!(world.staged.subscriptions.lock().unwrap().len(), 1);
    opened.close().await;
}

/// An issuer that goes on renewing a credential the gateway goes on
/// refusing: unchecked, a storm of renewals and asks from one session.
#[tokio::test(start_paused = true)]
async fn a_gateway_that_refuses_what_its_issuer_issues_is_asked_twice_and_then_left_alone() {
    let world = World::on_a_quick_clock().await;
    *world.staged.refuses_everyone.lock().unwrap() = true;
    // An issuer that renews for as long as it is asked.
    world.answers((2..60).map(|n| granted(&jwt(3600, n), Some("r"))));
    let kept = kept_holding(&world, &jwt(3600, 1)).await;
    let told: Arc<Mutex<Vec<SessionEndReason>>> = Arc::default();
    let telling = told.clone();

    let opened = ends(session_from_kept(SessionFromKept {
        on_auth_failed: Some(Arc::new(move |reason| {
            telling.lock().unwrap().push(reason);
        })),
        ..from_kept(&world, kept.clone())
    }))
    .await
    .expect("a session");
    let session = opened.session();
    // Said as the session started, before it was given.
    let mut said = Said::by(session);

    assert_eq!(world.staged.asked_who.lock().unwrap().len(), 2);
    assert_eq!(*told.lock().unwrap(), [SessionEndReason::Refused]);
    assert_eq!(codes(said.so_far()), [SessionErrorCode::CredentialRefused]);
    // The sign-in the gateway refused is forgotten.
    assert_eq!(held_by(kept.as_ref()).await, None);

    // And then the gateway and the issuer are left alone, however long the
    // session is held: its stream asked with the kept token and with the
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
    assert_eq!(codes(said.so_far()), [SessionErrorCode::CredentialRefused]);
    opened.close().await;
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
    let kept = kept_holding(&world, &first).await;
    let told: Arc<Mutex<Vec<SessionEndReason>>> = Arc::default();
    let telling = told.clone();
    let opened = ends(session_from_kept(SessionFromKept {
        on_auth_failed: Some(Arc::new(move |reason| {
            telling.lock().unwrap().push(reason);
        })),
        ..from_kept(&world, kept.clone())
    }))
    .await
    .expect("a session");
    let session = opened.session();
    let mut said = Said::by(session);
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
    assert_eq!(codes(said.so_far()), [SessionErrorCode::CredentialRefused]);
    assert_eq!(held_by(kept.as_ref()).await, None);
    assert_eq!(*session.token().borrow(), None);

    // A request after that is refused as it is: nothing is renewed for it,
    // and nobody is asked who anyone is.
    let _ = me().await;
    tokio::time::sleep(Duration::from_secs(120)).await;
    assert_eq!(world.token_forms().len(), 1);
    assert_eq!(world.staged.asked_who.lock().unwrap().len(), 4);
    assert_eq!(said.so_far().len(), 1);
    opened.close().await;
}

/// A session renews through the sign-in it was built from: at the issuer
/// the sign-in names, as the client it was issued to, and what the issuer
/// issued is kept there (`renewed`). A refused renewal ends it, and the
/// sign-in is forgotten (`forget`).
#[tokio::test]
async fn a_session_renews_through_the_sign_in_it_was_built_from() {
    let world = World::start().await;
    let (first, second) = (jwt(3600, 1), jwt(3600, 2));
    let kept = kept_holding(&world, &first).await;
    let opened = session_from_kept(from_kept(&world, kept.clone()))
        .await
        .expect("a session");
    let session = opened.session();
    world.answers([granted(&second, Some("r2"))]);

    assert_eq!(session.refresh(Some(&first)).await, Some(second.clone()));

    assert_eq!(world.token_forms()[0]["refresh_token"], "r1");
    assert_eq!(world.token_forms()[0]["client_id"], "semiont-browser");
    assert_eq!(
        held_by(kept.as_ref()).await,
        Some(world.stored(&second, "r2"))
    );

    // A refused renewal ends it: no token, and nothing kept.
    assert_eq!(session.refresh(Some(&second)).await, None);
    assert_eq!(*session.token().borrow(), None);
    assert_eq!(held_by(kept.as_ref()).await, None);
    opened.close().await;
}

/// Another holder of the same sign-in renewed it: the session takes the
/// token it kept, and spends no refresh token another already replaced.
#[tokio::test]
async fn a_session_takes_the_renewal_another_holder_of_its_sign_in_made() {
    let world = World::start().await;
    let (first, theirs) = (jwt(3600, 1), jwt(3600, 9));
    let kept = kept_holding(&world, &first).await;
    let opened = session_from_kept(SessionFromKept {
        validate: false,
        ..from_kept(&world, kept.clone())
    })
    .await
    .expect("a session");
    let session = opened.session();
    let given = kept
        .renewed(&world.stored(&first, "r1"), &theirs, "r9")
        .await
        .expect("renewed");
    assert_eq!(given.as_deref(), Some(theirs.as_str()));

    assert_eq!(session.refresh(Some(&first)).await, Some(theirs.clone()));

    assert!(world.token_forms().is_empty());
    assert_eq!(
        held_by(kept.as_ref()).await,
        Some(world.stored(&theirs, "r9"))
    );
    opened.close().await;
}

#[tokio::test]
async fn a_token_the_gateway_refuses_is_renewed_and_the_request_made_again() {
    let world = World::start().await;
    let (first, second) = (jwt(3600, 1), jwt(3600, 2));
    let kept = kept_holding(&world, &first).await;
    let opened = session_from_kept(SessionFromKept {
        validate: false,
        ..from_kept(&world, kept)
    })
    .await
    .expect("a session");
    let session = opened.session();
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

    assert_eq!(user.email.as_deref(), Some("alice@example.org"));
    assert_eq!(
        *world.staged.asked_who.lock().unwrap(),
        [first, second.clone()]
    );
    assert_eq!(session.token().borrow().as_deref(), Some(second.as_str()));
    opened.close().await;
}

/// A sign-in by the device grant is kept where the script says, as the
/// script client's, and a session is then built from it.
#[tokio::test(start_paused = true)]
async fn a_script_signs_in_by_the_device_grant_and_keeps_the_sign_in() {
    let world = World::on_a_quick_clock().await;
    let kept = Arc::new(MemorySignIn::new());
    let access = jwt(3600, 1);
    world.answers([granted(&access, Some("a-refresh-token"))]);

    sign_in_device(&world.kb("a-script"), kept.as_ref(), |_| {}, &world.http)
        .await
        .expect("signed in");

    assert_eq!(
        held_by(kept.as_ref()).await,
        Some(StoredSession {
            access: access.clone(),
            refresh: "a-refresh-token".to_owned(),
            client_id: "semiont-cli".to_owned(),
            token_endpoint: format!("{}/token", world.issuer()),
            revocation_endpoint: Some(format!("{}/revoke", world.issuer())),
            person_key: None,
        })
    );
    let opened = session_from_kept(SessionFromKept {
        validate: false,
        ..from_kept(&world, kept.clone())
    })
    .await
    .expect("a session");
    assert_eq!(
        opened.session().token().borrow().as_deref(),
        Some(access.as_str())
    );
    opened.close().await;

    let local = sign_in_device(
        &KbTarget {
            id: "in-process".to_owned(),
            label: "Here".to_owned(),
            endpoint: KbEndpoint::LocalEndpoint(LocalEndpoint::new("here")),
        },
        kept.as_ref(),
        |_| {},
        &world.http,
    )
    .await;
    assert_eq!(
        local.err().map(|refused| sign_in_error(refused).message),
        Some(
            "The device grant needs an HTTP endpoint; this knowledge base's is \"local\""
                .to_owned()
        )
    );
}

/// A sign-in by the device grant kept in the file `semiont login` keeps is
/// the launcher's: written as the launcher writes one, and held by a store
/// of its own.
#[tokio::test(start_paused = true)]
async fn a_device_sign_in_kept_in_the_launchers_file_is_the_launchers() {
    let world = World::on_a_quick_clock().await;
    let home = StateHome::new();
    // The file keeps a sign-in whose token names the issuer it was made at.
    let access = token_of(
        3600,
        json!({ "iss": world.issuer(), "email": "alice@example.org" }),
    );
    world.answers([granted(&access, Some("a-refresh-token"))]);

    sign_in_device(
        &world.kb("local"),
        SignInStore::at(home.0.join(FILE_NAME))
            .entry("local")
            .as_ref(),
        |_| {},
        &world.http,
    )
    .await
    .expect("signed in");

    let document: Value = serde_json::from_str(
        &std::fs::read_to_string(home.0.join(FILE_NAME)).expect("the file is there"),
    )
    .expect("the file is JSON");
    assert_eq!(document["local"]["token"], access);
    assert_eq!(document["local"]["refreshToken"], "a-refresh-token");
    assert_eq!(document["local"]["issuer"], world.issuer());
    assert_eq!(
        held_by(
            SignInStore::at(home.0.join(FILE_NAME))
                .entry("local")
                .as_ref()
        )
        .await
        .map(|held| held.access),
        Some(access)
    );
}

/// A script signs out of the sign-in it keeps: the issuer is told to forget
/// its refresh token, as the client it was issued to, and the sign-in is
/// kept no more.
#[tokio::test]
async fn a_script_signs_out_by_revoking_at_the_issuer_and_forgetting_the_sign_in() {
    let world = World::start().await;
    let kept = kept_holding(&world, &jwt(3600, 1)).await;

    sign_out(kept.as_ref(), &world.http)
        .await
        .expect("signed out");

    let revoked = world.staged.revoke_forms.lock().unwrap().clone();
    assert_eq!(revoked.len(), 1);
    assert_eq!(revoked[0]["token"], "r1");
    assert_eq!(revoked[0]["client_id"], "semiont-browser");
    assert_eq!(held_by(kept.as_ref()).await, None);
}

/// The sign-in is forgotten whatever the issuer answers, and one whose
/// issuer names no revocation endpoint is forgotten without a word to it.
#[tokio::test]
async fn a_script_is_signed_out_whatever_its_issuer_answers() {
    let world = World::start().await;
    *world.staged.revoke_status.lock().unwrap() = 503;
    let refusing = kept_holding(&world, &jwt(3600, 1)).await;

    sign_out(refusing.as_ref(), &world.http)
        .await
        .expect("signed out");

    assert_eq!(world.staged.revoke_forms.lock().unwrap().len(), 1);
    assert_eq!(held_by(refusing.as_ref()).await, None);

    let unnamed = Arc::new(MemorySignIn::new());
    unnamed
        .keep(StoredSession {
            revocation_endpoint: None,
            ..world.stored(&jwt(3600, 2), "r2")
        })
        .await
        .expect("kept");
    sign_out(unnamed.as_ref(), &world.http)
        .await
        .expect("signed out");
    assert_eq!(world.staged.revoke_forms.lock().unwrap().len(), 1);
    assert_eq!(held_by(unnamed.as_ref()).await, None);
}

/// With nothing kept there is nothing to sign out of: nobody is asked.
#[tokio::test]
async fn a_script_with_nothing_kept_signs_out_of_nothing() {
    let world = World::start().await;

    sign_out(&MemorySignIn::new(), &world.http)
        .await
        .expect("signed out");

    assert!(world.staged.revoke_forms.lock().unwrap().is_empty());
}

/// Signing out of a sign-in a registry keeps deletes what was kept for the
/// person it named, and nobody else's.
#[tokio::test]
async fn a_script_signing_out_of_a_registrys_sign_in_deletes_what_was_kept_for_its_person() {
    let world = World::start().await;
    let storage = kept_and_signed_in(&world, Some(ALICE));

    sign_out(kept_in(storage.clone(), "a-script").as_ref(), &world.http)
        .await
        .expect("signed out");

    assert_eq!(stored_session(storage.as_ref(), "a-script"), None);
    let left: Vec<String> = kept_for("a-script", ALICE)
        .into_iter()
        .filter(|key| storage.get(key).is_some())
        .collect();
    assert!(left.is_empty(), "alice's keys left: {left:?}");
    for key in kept_for("a-script", BOB)
        .into_iter()
        .chain(kept_for("another", ALICE))
    {
        assert_eq!(storage.get(&key).as_deref(), Some("kept"), "{key}");
    }
}

// ── A registry over HTTP ────────────────────────────────────────────────

fn registered(world: &World, id: &str, did: &str) -> KnowledgeBase {
    KnowledgeBase {
        id: id.to_owned(),
        label: "KB A".to_owned(),
        did: did.to_owned(),
        endpoint: KbEndpoint::HttpEndpoint(world.target()),
        last_read: None,
    }
}

fn browser(world: &World, storage: Arc<InMemorySessionStorage>) -> SemiontBrowser {
    SemiontBrowser::new(SemiontBrowserConfig {
        storage,
        session_factory: Arc::new(HttpSessionFactory::new(world.http.clone(), None)),
    })
    .expect("a browser")
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
    save_knowledge_bases(storage.as_ref(), &[registered(&world, "kb-a", DID_A)]).expect("stored");
    let renewed = jwt(3600, 2);
    store_session(storage.as_ref(), "kb-a", &world.stored(&jwt(-60, 1), "r1")).expect("stored");
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
        Some(ALICE.to_owned())
    );
    // The renewed sign-in, which records the person the gateway named.
    assert_eq!(
        stored_session(storage.as_ref(), "kb-a"),
        Some(StoredSession {
            person_key: Some(person_key(ALICE)),
            ..world.stored(&renewed, "r2")
        })
    );
    browser.close().await.expect("closed");
}

#[tokio::test]
async fn renewals_asked_for_together_are_one_request_of_the_issuer() {
    let world = World::start().await;
    let storage = Arc::new(InMemorySessionStorage::new());
    save_knowledge_bases(storage.as_ref(), &[registered(&world, "kb-a", DID_A)]).expect("stored");
    store_session(storage.as_ref(), "kb-a", &world.stored(&jwt(3600, 1), "r1")).expect("stored");
    let browser = browser(&world, storage);
    let session = live(&browser).await;
    let renewed = jwt(3600, 2);
    world.answers([granted(&renewed, Some("r2"))]);

    let refused = session.token().borrow().clone();
    let (one, two, three) = tokio::join!(
        session.refresh(refused.as_deref()),
        session.refresh(refused.as_deref()),
        session.refresh(refused.as_deref())
    );

    assert_eq!(
        [one, two, three],
        [Some(renewed.clone()), Some(renewed.clone()), Some(renewed)]
    );
    assert_eq!(world.token_forms().len(), 1);
    browser.close().await.expect("closed");
}

#[tokio::test]
async fn a_registry_over_http_cannot_build_a_session_for_what_is_not_at_a_gateway() {
    let world = World::start().await;
    let storage = Arc::new(InMemorySessionStorage::new());
    save_knowledge_bases(
        storage.as_ref(),
        &[KnowledgeBase {
            endpoint: KbEndpoint::LocalEndpoint(LocalEndpoint::new("here")),
            ..registered(&world, "kb-local", DID_A)
        }],
    )
    .expect("stored");
    let browser = browser(&world, storage);
    let mut errors = browser.errors();

    let refused = tokio::time::timeout(Duration::from_secs(10), errors.next())
        .await
        .expect("the failure is said")
        .expect("the browser lives")
        .expect("no failure was missed");

    assert_eq!(refused.code, SessionErrorCode::ConstructFailed);
    assert_eq!(
        refused.message,
        "A session over HTTP cannot be built for endpoint kind \"local\""
    );
    browser.close().await.expect("closed");
}

#[tokio::test]
async fn signing_out_of_a_registry_revokes_the_refresh_token_at_its_issuer() {
    let world = World::start().await;
    let storage = Arc::new(InMemorySessionStorage::new());
    save_knowledge_bases(storage.as_ref(), &[registered(&world, "kb-a", DID_A)]).expect("stored");
    store_session(storage.as_ref(), "kb-a", &world.stored(&jwt(3600, 1), "r1")).expect("stored");
    let browser = browser(&world, storage.clone());
    live(&browser).await;

    browser.sign_out("kb-a").await.expect("signed out");
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
    browser.close().await.expect("closed");
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
    let outcome = complete_sign_in(&browser, &callback, &world.http, None)
        .await
        .expect("the sign-in completes");

    assert_eq!(outcome.kb.did, DID_A);
    assert_eq!(outcome.kb.label, "KB A");
    assert_eq!(
        outcome.kb.endpoint,
        KbEndpoint::HttpEndpoint(world.target())
    );
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
    // Its session is up, and has recorded the person the gateway named.
    assert_eq!(
        stored_session(storage.as_ref(), &outcome.kb.id),
        Some(StoredSession {
            access: access.clone(),
            refresh: "a-refresh-token".to_owned(),
            client_id: "semiont-browser".to_owned(),
            token_endpoint: format!("{}/token", world.issuer()),
            revocation_endpoint: Some(format!("{}/revoke", world.issuer())),
            person_key: Some(person_key(ALICE)),
        })
    );
    assert_eq!(live(&browser).await.kb().id, outcome.kb.id);
    browser.close().await.expect("closed");
}

#[tokio::test]
async fn a_knowledge_base_that_cannot_say_who_it_is_is_not_registered() {
    let world = World::start().await;
    let storage = Arc::new(InMemorySessionStorage::new());
    let browser = browser(&world, storage.clone());

    *world.staged.describes.lock().unwrap() = Describes::Refusing;
    world.answers([granted(&jwt(3600, 1), Some("r"))]);
    let callback = sent_back(&world, &browser, world.begin()).await;
    let refused = complete_sign_in(&browser, &callback, &world.http, None)
        .await
        .expect_err("it cannot say who it is");
    let unverifiable = refused
        .downcast_ref::<IdentityUnverifiable>()
        .expect("an identity failure");
    assert_eq!(unverifiable.reason, IdentityUnverifiableReason::NotReported);

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
    let unreached = complete_sign_in(&browser, &callback, &world.http, None)
        .await
        .expect_err("it was not reached");
    let unverifiable = unreached
        .downcast_ref::<IdentityUnverifiable>()
        .expect("an identity failure");
    assert_eq!(unverifiable.reason, IdentityUnverifiableReason::Unreachable);

    assert!(browser.kbs().borrow().is_empty());
    assert_eq!(*browser.active_kb_id().borrow(), None);
    browser.close().await.expect("closed");
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
        None,
    )
    .await
    .expect_err("the state is another's");

    assert_eq!(
        refused.downcast_ref::<SignInError>(),
        Some(&SignInError::new(
            SignInErrorCode::State,
            "The sign-in response does not belong to the pending sign-in"
        ))
    );
    assert!(browser.kbs().borrow().is_empty());
    browser.close().await.expect("closed");
}

#[tokio::test]
async fn asked_with_a_token_the_knowledge_base_says_who_it_is() {
    let world = World::start().await;

    let identity = describe_connection(&world.target(), &jwt(3600, 1), &world.http, None)
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
        "browse:resource-requested".to_owned(),
        (
            "browse:resource-result".to_owned(),
            json!({ "response": {
                "resource": { "@context": "https://schema.org", "@id": "res-1", "name": "res-1", "representations": [] },
                "lastSequence": 1,
            } }),
        ),
    );
    let storage = Arc::new(InMemorySessionStorage::new());
    save_knowledge_bases(storage.as_ref(), &[registered(&world, "kb-a", DID_A)]).expect("stored");
    store_session(
        storage.as_ref(),
        "kb-a",
        &StoredSession {
            person_key: Some(person_key(ALICE)),
            ..world.stored(&jwt(3600, 1), "r1")
        },
    )
    .expect("stored");
    let places_key = last_event_id_key("kb-a", &person_key(ALICE));
    storage
        .set(&places_key, &json!({ "res-1": "p-res-1-5" }).to_string())
        .expect("stored");
    let browser = browser(&world, storage.clone());
    let session = live(&browser).await;

    // Watching a query of the resource holds its scope. The resource's
    // description is a cache that is persisted, so taking an event in writes.
    let _watching = session.client().browse.resource(&as_id("res-1")).watch();
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
    assert_eq!(resumed_from(), Some(json!("p-res-1-5")));

    // A recorded event of the scope moves the place, and the place is kept
    // once the caches have taken the event in and written what they hold.
    let frame = json!({ "channel": "mark:archived", "scope": "res-1", "payload": {} });
    let event = Bytes::from(format!(
        "event: bus-event\nid: p-res-1-9\ndata: {frame}\n\n"
    ));
    for stream in world.staged.streams.lock().unwrap().iter() {
        let _ = stream.send(event.clone());
    }
    let kept = || {
        storage
            .get(&places_key)
            .and_then(|kept| serde_json::from_str::<Value>(&kept).ok())
    };
    until("the place is kept", || {
        kept() == Some(json!({ "res-1": "p-res-1-9" }))
    })
    .await;
    browser.close().await.expect("closed");
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

// ── An agent ────────────────────────────────────────────────────────────
//
// An agent is an account, as a person is: the token its issuer grants is its
// bearer at the gateway, and the gateway names it by that account.

/// The subject the issuer asserts for the indexer's account.
const INDEXER: &str = "service-account-semiont-indexer";

impl World {
    /// An agent signed in at the gateway as the account `client_id` names.
    async fn sign_agent_in(&self, client_id: &str) -> Result<Arc<AgentToken>, AgentSignInError> {
        AgentToken::sign_in(
            &self.origin,
            ServiceToken::new(
                Credential::Secret(SecretCredential {
                    issuer: self.issuer(),
                    client_id: client_id.to_owned(),
                    client_secret: "a-secret".to_owned(),
                }),
                self.http.clone(),
            ),
            self.http.clone(),
            None,
        )
        .await
    }
}

// The DID is the gateway's, under the knowledge base's own domain, and an
// agent carries it verbatim. Re-derived from the URL the process happens to
// dial, one agent has two DIDs.
#[tokio::test]
async fn an_agent_signs_in_as_its_account_and_carries_the_did_its_gateway_names() {
    let world = World::start().await;
    let token = agent_jwt(3600, 1, INDEXER);
    world.answers([granted(&token, None)]);

    let agent = world
        .sign_agent_in("semiont-indexer")
        .await
        .expect("signed in");

    assert_eq!(
        agent.did().as_str(),
        "did:web:example.org:agents:service-account-semiont-indexer"
    );
    assert!(
        !world.origin.contains("example.org"),
        "the gateway is dialled somewhere else"
    );
    // Its bearer is the token its issuer granted: nothing is exchanged for
    // it, and the gateway is asked who holds it.
    assert_eq!(agent.token().borrow().as_deref(), Some(token.as_str()));
    assert_eq!(*world.staged.asked_who.lock().unwrap(), [token]);
    let grants = world.token_forms();
    assert_eq!(grants.len(), 1);
    assert_eq!(grants[0]["grant_type"], "client_credentials");
    assert_eq!(grants[0]["client_id"], "semiont-indexer");
}

// A refused token is renewed by a new grant, though the one held is not yet
// due. A refusal of a token already replaced is answered with the one held.
// A grant the issuer refuses leaves the agent the token it had.
#[tokio::test]
async fn a_refusal_of_the_agents_token_is_answered_by_a_new_grant() {
    let world = World::start().await;
    let (first, second) = (agent_jwt(3600, 1, INDEXER), agent_jwt(3600, 2, INDEXER));
    world.answers([granted(&first, None), granted(&second, None)]);
    let agent = world
        .sign_agent_in("semiont-indexer")
        .await
        .expect("signed in");

    assert_eq!(agent.refresh(Some(&first)).await, Some(second.clone()));
    assert_eq!(agent.token().borrow().as_deref(), Some(second.as_str()));
    assert_eq!(world.token_forms().len(), 2);

    // A refusal of the token it has replaced was answered by that renewal:
    // the one it holds is given, and the issuer is not asked.
    assert_eq!(agent.refresh(Some(&first)).await, Some(second.clone()));
    assert_eq!(world.token_forms().len(), 2);

    // The issuer has no grant left to give, and refuses.
    assert_eq!(agent.refresh(Some(&second)).await, None);
    assert_eq!(world.token_forms().len(), 3);
    assert_eq!(agent.token().borrow().as_deref(), Some(second.as_str()));
}

#[tokio::test]
async fn an_agent_whose_token_the_gateway_refuses_is_not_signed_in() {
    let world = World::start().await;
    let token = agent_jwt(3600, 1, INDEXER);
    world.answers([granted(&token, None)]);
    world.staged.refused.lock().unwrap().push(token);

    let refused = world
        .sign_agent_in("semiont-indexer")
        .await
        .err()
        .expect("the gateway refused the token");

    assert_eq!(refused, AgentSignInError::CredentialRefused { status: 401 });
}

// ── A service account that proves itself with a key ─────────────────────
//
// Each grant carries an assertion signed for it alone, and no secret. What
// an issuer does with the assertion is done here by hand: its signature is
// checked with the key's public half, and its claims read. The shape the
// table states is tests/client_assertion_cases.rs's.

fn assertion_table() -> Value {
    serde_json::from_str(include_str!(
        "../../../../protocol/specs/src/session/client-assertion-cases.json"
    ))
    .expect("the table is JSON")
}

/// RFC 7517's example RSA key (Appendix A.2), by its JWK members in the
/// order an `RSAPrivateKey` holds them: n, e, d, p, q, dp, dq, qi. A key
/// published to be an example, and the one RFC 7638 takes the thumbprint
/// of: the table's key.
const EXAMPLE_KEY: [&str; 8] = [
    "0vx7agoebGcQSuuPiLJXZptN9nndrQmbXEps2aiAFbWhM78LhWx4cbbfAAtVT86zwu1RK7aPFFxuhDR1L6tSoc_BJECPebWKRXjBZCiFV4n3oknjhMstn64tZ_2W-5JsGY4Hc5n9yBXArwl93lqt7_RN5w6Cf0h4QyQ5v-65YGjQR0_FDW2QvzqY368QQMicAtaSqzs8KJZgnYb9c7d0zgdAZHzu6qMQvRL5hajrn1n91CbOpbISD08qNLyrdkt-bFTWhAI4vMQFh6WeZu0fM4lFd2NcRwr3XPksINHaQ-G_xBniIqbw0Ls1jF44-csFCur-kEgU8awapJzKnqDKgw",
    "AQAB",
    "X4cTteJY_gn4FYPsXB8rdXix5vwsg1FLN5E3EaG6RJoVH-HLLKD9M7dx5oo7GURknchnrRweUkC7hT5fJLM0WbFAKNLWY2vv7B6NqXSzUvxT0_YSfqijwp3RTzlBaCxWp4doFk5N2o8Gy_nHNKroADIkJ46pRUohsXywbReAdYaMwFs9tv8d_cPVY3i07a3t8MN6TNwm0dSawm9v47UiCl3Sk5ZiG7xojPLu4sbg1U2jx4IBTNBznbJSzFHK66jT8bgkuqsk0GjskDJk19Z4qwjwbsnn4j2WBii3RL-Us2lGVkY8fkFzme1z0HbIkfz0Y6mqnOYtqc0X4jfcKoAC8Q",
    "83i-7IvMGXoMXCskv73TKr8637FiO7Z27zv8oj6pbWUQyLPQBQxtPVnwD20R-60eTDmD2ujnMt5PoqMrm8RfmNhVWDtjjMmCMjOpSXicFHj7XOuVIYQyqVWlWEh6dN36GVZYk93N8Bc9vY41xy8B9RzzOGVQzXvNEvn7O0nVbfs",
    "3dfOR9cuYq-0S-mkFLzgItgMEfFzB2q3hWehMuG0oCuqnb3vobLyumqjVZQO1dIrdwgTnCdpYzBcOfW5r370AFXjiWft_NGEiovonizhKpo9VVS78TzFgxkIdrecRezsZ-1kYd_s1qDbxtkDEgfAITAG9LUnADun4vIcb6yelxk",
    "G4sPXkc6Ya9y8oJW9_ILj4xuppu0lzi_H7VTkS8xj5SdX3coE0oimYwxIi2emTAue0UOa5dpgFGyBJ4c8tQ2VF402XRugKDTP8akYhFo5tAA77Qe_NmtuYZc3C3m3I24G2GvR5sSDxUyAN2zq8Lfn9EUms6rY3Ob8YeiKkTiBj0",
    "s9lAH9fggBsoFR8Oac2R_E2gw282rT2kGOAhvIllETE1efrA6huUUvMfBcMpn8lqeW6vzznYY5SSQF7pMdC_agI3nG8Ibp1BUb0JUiraRNqUfLhcQb_d9GF4Dh7e74WbRsobRonujTYN1xCaP6TO61jvWrX-L18txXw494Q_cgk",
    "GyM_p6JrXySiz1toFgKbWV-JdI3jQ4ypu9rbMWx3rQJBfmt0FoYzgUIZEVFEcOqwemRN81zoDAaa-Bk0KWNGDjJHZDdDmFhW3AN7lI-puxk_mHZGJ11rxyR8O55XLSe3SPmRfKwZI6yU24ZxvQKFYItdldUKGzO6Ia6zTKhAVRU",
];

/// The public half of RFC 7515's example RSA key (Appendix A.2), n and e: a
/// key the account does not hold.
const ANOTHER_KEY: [&str; 2] = [
    "ofgWCuLjybRlzo0tZWJjNiuSfb4p4fAkd_wWJcyQoTbji9k0l8W26mPddxHmfHQp-Vaw-4qPCJrcS2mJPMEzP1Pt0Bm4d4QlL-yRT-SFd2lZS-pCgNMsD1W_YpRPEwOWvG6b32690r2jZ47soMZo9wGzjb_7OMg0LOL-bSf63kpaSHSXndS5z5rexMdbBYUsLA9e-KXBdQOS-UTo7WTBEMa2R2CapHg665xsmtdVMTBQY4uDZlxvb3qCo5ZwKh9kG4LT6_I5IhlJH7aGhyxXFvUK-DWNmoudF8NAco9_h9iaGNj8q2ethFkMLs91kzk2PAcDTW9gb54h4FRWyuXpoQ",
    "AQAB",
];

fn number(member: &str) -> Vec<u8> {
    URL_SAFE_NO_PAD.decode(member).expect("a base64url number")
}

/// A DER element: its tag, its length and its content.
fn der(tag: u8, content: &[u8]) -> Vec<u8> {
    let mut element = vec![tag];
    if content.len() < 0x80 {
        element.push(content.len() as u8);
    } else {
        let length: Vec<u8> = content
            .len()
            .to_be_bytes()
            .into_iter()
            .skip_while(|byte| *byte == 0)
            .collect();
        element.push(0x80 | length.len() as u8);
        element.extend(length);
    }
    element.extend_from_slice(content);
    element
}

/// A DER INTEGER of an unsigned big-endian number.
fn integer(magnitude: &[u8]) -> Vec<u8> {
    let mut content = Vec::new();
    if magnitude.first().is_some_and(|byte| byte & 0x80 != 0) {
        content.push(0);
    }
    content.extend_from_slice(magnitude);
    der(0x02, &content)
}

/// rsaEncryption's AlgorithmIdentifier: its OID, 1.2.840.113549.1.1.1, and
/// no parameters.
const RSA_ENCRYPTION: [u8; 13] = [
    0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00,
];

/// An elliptic-curve key's AlgorithmIdentifier: id-ecPublicKey,
/// 1.2.840.10045.2.1, on P-256, 1.2.840.10045.3.1.7.
const EC_P256: [u8; 19] = [
    0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01, 0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d,
    0x03, 0x01, 0x07,
];

/// A PKCS#8 PrivateKeyInfo (RFC 5958) of `key` under `algorithm`, as a PEM.
fn pkcs8_pem(algorithm: &[u8], key: &[u8]) -> String {
    let info = der(
        0x30,
        &[integer(&[0]), der(0x30, algorithm), der(0x04, key)].concat(),
    );
    let base64 = STANDARD.encode(info);
    let lines: Vec<&str> = base64
        .as_bytes()
        .chunks(64)
        .map(|line| std::str::from_utf8(line).expect("base64 is ASCII"))
        .collect();
    format!(
        "-----BEGIN PRIVATE KEY-----\n{}\n-----END PRIVATE KEY-----\n",
        lines.join("\n")
    )
}

/// RFC 7517's example key as a worker is handed its key: a PKCS#8 PEM.
fn example_key() -> String {
    let members: Vec<u8> = EXAMPLE_KEY
        .iter()
        .flat_map(|member| integer(&number(member)))
        .collect();
    pkcs8_pem(
        &RSA_ENCRYPTION,
        &der(0x30, &[integer(&[0]), members].concat()),
    )
}

/// The client id of the account that proves itself with the example key.
const KEYED: &str = "semiont-worker-alice-laptop";

impl World {
    fn keyed(&self, key: &str) -> KeyCredential {
        KeyCredential {
            issuer: self.issuer(),
            client_id: KEYED.to_owned(),
            private_key: private_key_from_pem(key).expect("an RSA key"),
        }
    }
}

/// The names of a form's fields, in order.
fn fields(form: &HashMap<String, String>) -> Vec<&str> {
    let mut names: Vec<&str> = form.keys().map(String::as_str).collect();
    names.sort_unstable();
    names
}

/// The fields the table says a grant by assertion posts, in order.
fn assertion_form(table: &Value) -> Vec<&str> {
    let mut names: Vec<&str> = table["form"]
        .as_array()
        .expect("the table states a form")
        .iter()
        .map(|name| name.as_str().expect("a field's name"))
        .collect();
    names.sort_unstable();
    names
}

/// The header and claims of `assertion`, once its signature is checked with
/// the public key `n`, `e`, as an issuer checks it.
fn checked(assertion: &str, n: &[u8], e: &[u8]) -> Option<(Value, Value)> {
    let (signing_input, signature) = assertion.rsplit_once('.').expect("a signature");
    RsaPublicKeyComponents { n, e }
        .verify(
            &RSA_PKCS1_2048_8192_SHA256,
            signing_input.as_bytes(),
            &URL_SAFE_NO_PAD.decode(signature).expect("base64url"),
        )
        .ok()?;
    let (head, body) = signing_input.split_once('.').expect("a header and claims");
    let read = |part: &str| -> Value {
        serde_json::from_slice(&URL_SAFE_NO_PAD.decode(part).expect("base64url")).expect("JSON")
    };
    Some((read(head), read(body)))
}

#[tokio::test]
async fn each_grant_carries_an_assertion_signed_for_it_alone_and_no_secret() {
    let world = World::start().await;
    world.answers([
        granted(&agent_jwt(300, 1, INDEXER), None),
        granted(&agent_jwt(300, 2, INDEXER), None),
    ]);
    let service = ServiceToken::new(
        Credential::Key(Box::new(world.keyed(&example_key()))),
        world.http.clone(),
    );
    service.token(false).await.expect("granted");
    service.token(true).await.expect("granted again");

    let table = assertion_table();
    let (n, e) = (number(EXAMPLE_KEY[0]), number(EXAMPLE_KEY[1]));
    let mut jtis = Vec::new();
    for sent in world.token_forms() {
        assert_eq!(fields(&sent), assertion_form(&table));
        assert_eq!(
            sent["grant_type"],
            table["grantType"].as_str().expect("a grant type")
        );
        assert_eq!(sent["client_assertion_type"], JWT_BEARER);
        let (head, claims) =
            checked(&sent["client_assertion"], &n, &e).expect("signed with the account's key");
        assert_eq!(head, json!({ "alg": "RS256", "kid": thumbprint(&n, &e) }));
        assert_eq!(claims["iss"], KEYED);
        assert_eq!(claims["sub"], KEYED);
        assert_eq!(claims["aud"], format!("{}/token", world.issuer()));
        let issued = claims["iat"].as_u64().expect("whole seconds");
        let expires = claims["exp"].as_u64().expect("whole seconds");
        assert_eq!(expires - issued, LIFETIME_SECONDS);
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("after 1970")
            .as_secs();
        assert!(now.abs_diff(issued) < 60, "issued at {issued}, now {now}");
        jtis.push(claims["jti"].as_str().expect("a jti").to_owned());
    }
    assert_eq!(jtis.len(), 2);
    assert_ne!(jtis[0], jtis[1], "a grant's assertion is never sent twice");
}

#[tokio::test]
async fn an_assertion_another_key_signed_is_not_this_accounts() {
    let world = World::start().await;
    world.answers([granted(&agent_jwt(300, 1, INDEXER), None)]);
    ServiceToken::new(
        Credential::Key(Box::new(world.keyed(&example_key()))),
        world.http.clone(),
    )
    .token(false)
    .await
    .expect("granted");

    let assertion = &world.token_forms()[0]["client_assertion"];
    let (n, e) = (number(ANOTHER_KEY[0]), number(ANOTHER_KEY[1]));
    assert_eq!(checked(assertion, &n, &e), None);
}

#[tokio::test]
async fn a_key_credential_never_shows_its_key_and_a_refused_grant_never_shows_its_assertion() {
    let world = World::start().await;
    let credential = world.keyed(&example_key());
    assert_eq!(
        format!("{credential:?}"),
        format!(
            r#"KeyCredential {{ issuer: "{}", client_id: "{KEYED}", .. }}"#,
            world.issuer()
        )
    );
    let secret = SecretCredential {
        issuer: world.issuer(),
        client_id: KEYED.to_owned(),
        client_secret: "a-secret".to_owned(),
    };
    assert!(!format!("{:?}", Credential::Secret(secret)).contains("a-secret"));

    // An error body can echo what it was sent: the status is said, never the
    // body.
    world.answers([(
        401,
        json!({ "error": "invalid_client", "error_description": "echo" }),
    )]);
    let refused = ServiceToken::new(Credential::Key(Box::new(credential)), world.http.clone())
        .token(false)
        .await
        .expect_err("refused");
    assert_eq!(
        refused.to_string(),
        format!(
            "Client-credentials grant for {KEYED} at {} failed (HTTP 401)",
            world.issuer()
        )
    );
    let assertion = &world.token_forms()[0]["client_assertion"];
    assert!(!refused.to_string().contains(assertion.as_str()));
    assert!(!format!("{refused:?}").contains(assertion.as_str()));
}

#[test]
fn a_worker_reads_its_key_from_a_pkcs8_pem_and_nothing_else() {
    let key = example_key();
    let public = |pem: &str| {
        RsaPublicKeyComponents::<Vec<u8>>::from(
            private_key_from_pem(pem).expect("an RSA key").public(),
        )
    };
    let read = public(&key);
    assert_eq!(
        (read.n, read.e),
        (number(EXAMPLE_KEY[0]), number(EXAMPLE_KEY[1]))
    );
    // As an environment variable may hold it: its lines ended otherwise, and
    // space around it.
    let carried = format!("\n  {}  \n", key.replace('\n', "\r\n"));
    assert_eq!(public(&carried).n, number(EXAMPLE_KEY[0]));

    let refused = |pem: &str| private_key_from_pem(pem).err();
    // Armoured otherwise: PKCS#1, or encrypted.
    let pkcs1 = key.replace("PRIVATE KEY", "RSA PRIVATE KEY");
    assert_eq!(refused(&pkcs1), Some(KeyError::NotPkcs8Pem));
    let encrypted = key.replace("PRIVATE KEY", "ENCRYPTED PRIVATE KEY");
    assert_eq!(refused(&encrypted), Some(KeyError::NotPkcs8Pem));
    let unarmoured: String = key
        .lines()
        .filter(|line| !line.starts_with("-----"))
        .collect();
    assert_eq!(refused(&unarmoured), Some(KeyError::NotPkcs8Pem));
    let not_base64 = "-----BEGIN PRIVATE KEY-----\n!!!!\n-----END PRIVATE KEY-----\n";
    assert_eq!(refused(not_base64), Some(KeyError::NotPkcs8Pem));
    // PKCS#8, and not RSA.
    let elliptic = pkcs8_pem(&EC_P256, &der(0x30, &integer(&[1])));
    assert_eq!(
        refused(&elliptic),
        Some(KeyError::NotRsa("WrongAlgorithm".to_owned()))
    );
    // What it says names what the key is not, and nothing of what it was.
    assert_eq!(
        KeyError::NotPkcs8Pem.to_string(),
        "not an unencrypted PKCS#8 PEM private key (-----BEGIN PRIVATE KEY-----)"
    );
    assert_eq!(
        KeyError::NotRsa("WrongAlgorithm".to_owned()).to_string(),
        "not an RSA key to sign assertions with RS256 (WrongAlgorithm)"
    );
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
                random: None,
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
        semiont::errors::SemiontError::Session(error) => error.message,
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
    *world.staged.trails_off.lock().unwrap() = Some(StatusCode::OK);
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
async fn a_refusal_whose_body_never_ends_is_the_refusal_with_no_words_at_the_deadline() {
    let world = World::on_a_quick_clock().await;
    *world.staged.trails_off.lock().unwrap() = Some(StatusCode::NOT_FOUND);
    let client = world.client("a-token");
    let started = tokio::time::Instant::now();

    let auth = client.auth.as_ref().expect("a gateway");
    let refused = ends(auth.me()).await.expect_err("it was refused");

    assert!(
        took(started.elapsed(), HTTP_REQUEST_TIMEOUT),
        "{:?}",
        started.elapsed()
    );
    assert_eq!(refused.code(), "not-found");
    assert_eq!(message(refused), "HTTP 404: Not Found");
    client.close().await;
}

#[tokio::test(start_paused = true)]
async fn a_session_whose_gateway_never_says_who_it_is_is_ready_at_the_deadline_and_keeps_its_token()
{
    let world = World::on_a_quick_clock().await;
    world.never_answers("who");
    let access = jwt(3600, 1);
    let kept = kept_holding(&world, &access).await;
    let started = tokio::time::Instant::now();

    let opened = ends(session_from_kept(from_kept(&world, kept)))
        .await
        .expect("a session");
    let session = opened.session();
    // Said as the session started, before it was given.
    let mut said = Said::by(session);

    assert!(
        took(started.elapsed(), HTTP_REQUEST_TIMEOUT),
        "{:?}",
        started.elapsed()
    );
    assert_eq!(session.token().borrow().as_deref(), Some(access.as_str()));
    assert_eq!(*session.user().borrow(), None);
    let heard = said.so_far();
    assert_eq!(codes(heard), [SessionErrorCode::AuthFailed], "{heard:?}");
    assert!(
        heard[0]
            .message
            .contains("GET /api/users/me got no answer within 30s"),
        "{heard:?}"
    );
    opened.close().await;
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
            .resource(PutBinaryRequest::new(
                "A note",
                Bytes::from_static(b"hello"),
                "text/plain",
                "file://a-note.txt",
            ))
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
async fn a_service_whose_sign_in_is_never_answered_fails_at_the_deadline() {
    let world = World::on_a_quick_clock().await;

    // The gateway's answer to who the agent is.
    world.answers([granted(&agent_jwt(3600, 1, INDEXER), None)]);
    world.never_answers("who");
    let started = tokio::time::Instant::now();
    let named = ends(world.sign_agent_in("semiont-indexer"))
        .await
        .err()
        .expect("nobody answered");
    assert!(
        took(started.elapsed(), HTTP_REQUEST_TIMEOUT),
        "{:?}",
        started.elapsed()
    );
    assert!(
        named.to_string().contains("got no answer within 30s"),
        "{named}"
    );

    // The issuer's grant to the account.
    world.never_answers("token");
    let started = tokio::time::Instant::now();
    let grant = ends(world.sign_agent_in("semiont-indexer"))
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
    let discovery = ends(world.sign_agent_in("semiont-indexer"))
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
) -> Result<String, Box<dyn Error + Send + Sync>> {
    // <readme:script>
    // The sign-in `semiont login` made for the knowledge base running here. Its key
    // is the knowledge base's id.
    let kept = SignInStore::at(state_home.join(FILE_NAME)).entry("local");
    if kept.held().await?.is_none() {
        return Err("Not signed in. Run `semiont login`.".into());
    }
    let opened = session_from_kept(SessionFromKept {
        kb: KbTarget::http(
            "local",
            "Local",
            &gateway.host,
            gateway.port,
            gateway.protocol,
        ),
        kept,
        validate: true,
        storage: None,
        on_auth_failed: None,
        http,
        random: None,
    })
    .await?;

    let about = opened.session().client().browse.kb().await?;
    // The session, then the client it was built with.
    opened.close().await;
    // </readme:script>
    Ok(about.name)
}

async fn a_first_sign_in(
    kb: KbTarget,
    kept: Arc<dyn SignInKept>,
    http: reqwest::Client,
) -> Result<OpenedSession, Box<dyn Error + Send + Sync>> {
    // <readme:device>
    // The issuer mints a code, and the person approves it wherever they
    // have a browser. No password passes through this process. The sign-in
    // is kept in `kept`, and the session is built from it.
    sign_in_device(
        &kb,
        kept.as_ref(),
        |code| {
            println!(
                "Open {} and enter {}",
                code.verification_uri, code.user_code
            )
        },
        &http,
    )
    .await?;
    let opened = session_from_kept(SessionFromKept {
        kb,
        kept,
        validate: true,
        storage: None,
        on_auth_failed: None,
        http,
        random: None,
    })
    .await?;
    // </readme:device>
    Ok(opened)
}

async fn a_daemon(
    gateway: &str,
    credential: Credential,
    http: reqwest::Client,
    mut done: impl FnMut(JobCompleteCommand),
) -> Result<(), Box<dyn Error>> {
    // <readme:daemon>
    // A service signs in as itself, an agent with an account at the issuer,
    // and stays signed in for as long as it holds the token.
    let agent = AgentToken::sign_in(
        gateway,
        ServiceToken::new(credential, http.clone()),
        http.clone(),
        None,
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
            random: None,
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

/// The example's model: the passages of a text it would highlight, each as
/// the words it quoted. This one quotes the first line.
async fn passages(text: &str) -> Vec<QuotedText> {
    vec![QuotedText::new(text.lines().next().unwrap_or_default())]
}

async fn a_worker(
    gateway: &str,
    issuer: String,
    client_id: String,
    key: &str,
    http: reqwest::Client,
) -> Result<(), Box<dyn Error>> {
    // <readme:worker>
    // Its account at the issuer proves itself with the worker's key, the
    // PKCS#8 PEM in `SEMIONT_OIDC_CLIENT_KEY`: each grant carries an
    // assertion signed with it, and no secret.
    let credential = KeyCredential {
        issuer,
        client_id,
        private_key: private_key_from_pem(key)?,
    };
    // What the agent says it is called: here, its client id.
    let called = credential.client_id.clone();
    // A worker signs in as a daemon does: as itself, the agent its work is
    // attributed to.
    let agent = AgentToken::sign_in(
        gateway,
        ServiceToken::new(Credential::Key(Box::new(credential)), http.clone()),
        http.clone(),
        None,
    )
    .await?;
    println!("working as {}", agent.did());
    // What made the annotations it commits: the agent, as the gateway names
    // it, and the engine it ran. It carries no name: readers name the agent
    // by what it says it is called.
    let (provider, model) = ("ollama", "gemma3:4b");
    let generator = AgentSoftware {
        id: Some(agent.did().to_string()),
        provider: Some(provider.to_owned()),
        model: Some(model.to_owned()),
        ..AgentSoftware::new()
    }
    .into();
    // Its stream names what claiming and committing read. This worker awaits
    // nothing else, so it names nothing else.
    let mut channels = JOB_CLAIM_CHANNELS.map(str::to_owned).to_vec();
    channels.extend(JOB_COMMIT_CHANNELS.map(str::to_owned));
    let client = client(
        HttpTransportConfig {
            base_url: agent.gateway().to_owned(),
            token: agent.token(),
            refresher: Some(agent.clone()),
            channels: Some(channels),
            http,
            timing: Timing::default(),
            random: None,
        },
        ClientOptions::default(),
    );
    // It says what it is called, as itself, once. Readers name it by the
    // last name it said, as they name a person.
    client
        .wire()
        .emit::<PrincipalProfile>(
            &PrincipalProfileCommand {
                _user_id: None,
                name: called,
            },
            Envelope::default(),
        )
        .await?;

    // What it accepts: the `mark` jobs of one motivation.
    let highlighting = MarkJobFilter::new(MarkJobFilterParams {
        motivation: Motivation::Highlighting,
    });
    let claims = client
        .job
        .claim(ClaimOptions::new(vec![highlighting.into()]));

    // Each job the worker comes to hold, one at a time. The next is claimed
    // when this one settles.
    while let Some(handed) = claims.next().await {
        match handed {
            Ok(HeldJob::Mark(job)) => {
                job.start().await?;
                // Your work: read the resource, have its passages quoted,
                // and commit a highlight of each one the text has.
                let resource_id = job.resource_id().clone();
                let text = client.browse.resource_content(&resource_id).await?;
                let quoted = passages(&text).await;
                job.progress(JobProgress::new(50.0)).await?;
                let mut highlights: Vec<Annotation> = Vec::new();
                for quote in &quoted {
                    // What a model quotes is not trusted: it is found in
                    // the text, as the text has it, or it is dropped.
                    let Some(found) = reconcile(&text, quote) else {
                        continue;
                    };
                    let built = annotation_of_span(
                        &text,
                        &found.span,
                        &resource_id,
                        Motivation::Highlighting,
                        &generator,
                        None,
                    )?;
                    // An annotation's id is worked out from what it is, so
                    // a passage quoted twice is one annotation.
                    if !highlights.iter().any(|kept| kept.id == built.id) {
                        highlights.push(built);
                    }
                }
                let result = MarkJobDone::new(quoted.len() as u64, highlights.len() as u64);
                job.commit(&resource_id, highlights).await?;
                // A settle takes the job, so it cannot be settled twice. A
                // job dropped unsettled is failed, and the queue retries it.
                job.complete(result.into()).await?;
            }
            Ok(HeldJob::Yield(job)) => {
                let never = JobFailure {
                    failure_class: Some(FailureClass::Deterministic),
                    ..JobFailure::default()
                };
                job.fail("this worker runs no yield job", never).await?;
            }
            Err(refusal) => {
                eprintln!("claim refused: {}", refusal.message);
                // This credential can never claim. Stop, so that whoever
                // runs the worker sees it.
                if refusal.code == Some(BusRequestErrorCode::Unauthorized) {
                    break;
                }
            }
        }
    }
    // Stopping fails a job the worker still holds.
    claims.stop().await;
    // </readme:worker>
    Ok(())
}

async fn an_application(
    storage: Arc<dyn SessionStorage>,
    gateway: HttpEndpoint,
    http: reqwest::Client,
    open: impl FnOnce(&str),
) -> Result<KnowledgeBase, Box<dyn Error + Send + Sync>> {
    // <readme:application>
    // The registry an application holds, with its sessions over HTTP.
    let browser = SemiontBrowser::new(SemiontBrowserConfig {
        storage,
        session_factory: Arc::new(HttpSessionFactory::new(http.clone(), None)),
    })?;

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
    let signed_in = complete_sign_in(&browser, &callback, &http, None).await?;
    // </readme:application>
    browser.close().await?;
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
async fn a_session_over_a_kept_sign_in_renews_at_the_issuer_the_sign_in_names() {
    let world = World::start().await;
    let kept = kept_holding(&world, &jwt(3600, 1)).await;
    let renewed = jwt(3600, 2);
    world.answers([granted(&renewed, Some("r2"))]);

    let opened = session_from_kept(SessionFromKept {
        validate: false,
        ..from_kept(&world, kept.clone())
    })
    .await
    .expect("a session");
    let session = opened.session();

    let held = session.token().borrow().clone();
    assert_eq!(
        session.refresh(held.as_deref()).await,
        Some(renewed.clone())
    );
    assert_eq!(
        held_by(kept.as_ref()).await,
        Some(world.stored(&renewed, "r2"))
    );
    assert_eq!(world.token_forms().len(), 1);
    // It was not asked who it is: nobody said to.
    assert!(world.staged.asked_who.lock().unwrap().is_empty());
    opened.close().await;
}

#[tokio::test(start_paused = true)]
async fn a_first_sign_in_shows_the_code_and_gives_a_session_that_knows_who_it_is() {
    let world = World::on_a_quick_clock().await;
    let kept = Arc::new(MemorySignIn::new());
    let access = jwt(3600, 1);
    world.answers([granted(&access, Some("a-refresh-token"))]);

    let opened = a_first_sign_in(world.kb("a-script"), kept.clone(), world.http.clone())
        .await
        .expect("a session");
    let session = opened.session();

    assert_eq!(session.token().borrow().as_deref(), Some(access.as_str()));
    assert_eq!(
        *world.staged.asked_who.lock().unwrap(),
        std::slice::from_ref(&access)
    );
    assert_eq!(
        held_by(kept.as_ref()).await.map(|held| held.access),
        Some(access)
    );
    opened.close().await;
}

#[tokio::test]
async fn the_daemon_signs_in_as_an_agent_and_is_given_each_completion() {
    let world = World::start().await;
    // The account's own token, from the issuer's client-credentials grant.
    let token = agent_jwt(3600, 1, INDEXER);
    world.answers([granted(&token, None)]);
    let (seen, mut completions) = mpsc::unbounded_channel();
    let running = tokio::spawn({
        let (gateway, issuer, http) = (world.origin.clone(), world.issuer(), world.http.clone());
        async move {
            a_daemon(
                &gateway,
                Credential::Secret(SecretCredential {
                    issuer,
                    client_id: "semiont-indexer".to_owned(),
                    client_secret: "a-secret".to_owned(),
                }),
                http,
                move |job| {
                    if let JobCompleteCommand::MarkJobCompleteCommand(job) = job {
                        let _ = seen.send(job.job_id);
                    }
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
        "resourceId": "res-1", "jobId": "job-1", "jobType": "mark",
    }});
    let event = Bytes::from(format!("event: bus-event\nid: e-1\ndata: {frame}\n\n"));
    for stream in world.staged.streams.lock().unwrap().iter() {
        let _ = stream.send(event.clone());
    }

    let completed = tokio::time::timeout(Duration::from_secs(10), completions.recv())
        .await
        .expect("the completion arrives");
    assert_eq!(completed.as_deref(), Some("job-1"));
    // The stream was opened as the agent, with the token its issuer granted.
    assert_eq!(
        world.token_forms()[0].get("grant_type").map(String::as_str),
        Some("client_credentials")
    );
    assert_eq!(*world.staged.subscribed_with.lock().unwrap(), [token]);
    running.abort();
}

#[tokio::test]
async fn the_worker_says_what_it_is_called_claims_as_its_agent_says_the_lifecycle_of_the_job_it_is_handed_and_claims_again()
 {
    let world = World::start().await;
    world.answers([granted(
        &agent_jwt(3600, 1, "service-account-my-worker"),
        None,
    )]);
    world.staged.claimable.lock().unwrap().push_back(json!({
        "status": "running",
        "metadata": {
            "id": "job-1", "type": "mark", "userId": "did:web:kb.example:users:u",
            "created": "2026-01-01T00:00:00.000Z", "retryCount": 0, "maxRetries": 1,
        },
        "params": { "resourceId": "res-1", "motivation": "highlighting" },
        "startedAt": "2026-01-01T00:00:01.000Z",
        "progress": {},
    }));
    let running = tokio::spawn({
        let (gateway, issuer, http) = (world.origin.clone(), world.issuer(), world.http.clone());
        async move {
            a_worker(
                &gateway,
                issuer,
                "my-worker".to_owned(),
                &example_key(),
                http,
            )
            .await
            .map_err(|failed| failed.to_string())
        }
    });
    let said = || -> Vec<String> {
        let emitted = world.staged.emitted.lock().unwrap();
        emitted
            .iter()
            .map(|emit| emit["channel"].as_str().unwrap_or_default().to_owned())
            .collect()
    };
    // Settling the job is an idle moment, and so the next claim.
    until("the worker's second claim", || {
        said()
            .iter()
            .filter(|channel| *channel == "job:claim")
            .count()
            == 2
    })
    .await;

    assert_eq!(
        said(),
        [
            "principal:profile",
            "job:claim",
            "job:start",
            "job:report-progress",
            "mark:commit",
            "job:complete",
            "job:claim"
        ]
    );
    // It signed in by its key: its grant carried an assertion, and no secret.
    assert_eq!(
        fields(&world.token_forms()[0]),
        assertion_form(&assertion_table())
    );
    let emitted = world.staged.emitted.lock().unwrap().clone();
    // It said it is called by its client id, before it claimed.
    assert_eq!(emitted[0]["payload"], json!({ "name": "my-worker" }));
    assert_eq!(
        emitted[1]["payload"],
        json!({ "accepts": [{ "jobType": "mark", "params": { "motivation": "highlighting" } }] })
    );
    assert_eq!(emitted[2]["payload"]["jobId"], "job-1");
    // What it committed: one highlight, of the first line of the bytes the
    // gateway served, for the job it holds, made by the agent it works as
    // with the engine it ran.
    let commit = &emitted[4]["payload"];
    assert_eq!(commit["jobId"], "job-1");
    assert_eq!(commit["resourceId"], "res-1");
    let highlights = commit["annotations"].as_array().expect("a batch");
    assert_eq!(highlights.len(), 1);
    assert_eq!(highlights[0]["motivation"], "highlighting");
    assert_eq!(
        highlights[0]["target"],
        json!({ "type": "SpecificResource", "source": "res-1", "selector": [
            { "type": "TextPositionSelector", "start": 0, "end": 18 },
            { "type": "TextQuoteSelector", "exact": "the bytes of res-1" },
        ]})
    );
    assert_eq!(
        highlights[0]["generator"],
        json!({
            "@type": "Software", "@id": "did:web:example.org:agents:service-account-my-worker",
            "provider": "ollama", "model": "gemma3:4b",
        })
    );
    // And it reports what it proposed and what the record holds, established
    // by the record's acknowledgement.
    assert_eq!(
        emitted[5]["payload"],
        json!({
            "resourceId": "res-1", "jobId": "job-1", "jobType": "mark", "attempt": 1,
            "result": { "found": 1, "persisted": 1 }, "durability": "acknowledged",
        })
    );
    // Its stream names what claiming and committing read, and nothing else.
    let named: Vec<&str> = JOB_CLAIM_CHANNELS
        .into_iter()
        .chain(JOB_COMMIT_CHANNELS)
        .collect();
    assert_eq!(
        world.staged.subscriptions.lock().unwrap()[0]["global"],
        json!(named)
    );
    // Stopped while it holds nothing, it has failed nothing.
    assert!(!running.is_finished());
    running.abort();
    assert!(!said().iter().any(|channel| channel == "job:fail"));
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

/// The `semiont-worker` skill shows a worker in Rust. What it shows is the
/// worker that ran here.
#[test]
fn every_rust_block_of_the_worker_skill_is_an_example_that_ran_here() {
    assert_blocks_are_examples(
        include_str!("../../../../docs/builder/skills/semiont-worker/SKILL.md"),
        &[include_str!("sign_in.rs")],
    )
    .unwrap_or_else(|odd| panic!("{odd}"));
}
