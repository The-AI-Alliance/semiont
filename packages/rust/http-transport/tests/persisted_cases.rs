//! The runner of protocol/specs/src/session/persisted-cases.json: what a
//! client keeps of one person in a registry's storage, and when it is read,
//! written and deleted. `keys` against the key functions and the generated
//! list of persisted queries; `forget` against a registry, its sign-out, its
//! removal and its sign-in again over stand-in sessions, its session's
//! expiry and refusal over a stand-in gateway and issuer; `startup` against
//! the session the HTTP session factory builds, over a stand-in gateway that
//! names the person, or nobody, once the test lets it; `crossTab` against a
//! registry whose stored sign-in another context deletes or replaces;
//! `holder` against a registry whose stored sign-in this process forgets,
//! replaces or renews through the storage's functions, which are what holds
//! a registry session's sign-in; `resumeFrom` against the session the HTTP
//! session factory builds, over a stand-in gateway whose stream delivers
//! events on a scope the client holds. Then a save being written as the
//! session forgets its sign-in: no save lands after the delete.

use axum::Router;
use axum::body::Body;
use axum::extract::State;
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use bytes::Bytes;
use semiont::cache::CacheState;
use semiont::cached::Observed;
use semiont::channels::BRIDGED_CHANNELS;
use semiont::client::{ClientOptions, SemiontClient};
use semiont::errors::{BusRequestError, SessionError, TransportError};
use semiont::event_bus::EventBus;
use semiont::identity::kb_did;
use semiont::refresh::CacheQuery;
use semiont::session::{
    SemiontBrowser, SemiontBrowserConfig, SemiontSession, SemiontSessionConfig, SessionFactory,
    SessionFactoryOptions, SessionSignals, StoredSession, cache_key, clear_stored_session, kept_in,
    last_event_id_key, person_key, save_knowledge_bases, session_key, store_session,
    stored_session,
};
use semiont::state_unit::StateUnit;
use semiont::storage::{SessionStorage, StorageChange, StorageSubscription};
use semiont::testing::{FaultyTransport, InMemoryContent, SharedStorage, as_id};
use semiont::transport::{
    BoxFuture, ConnectionState, Envelope, Failures, Frames, PendingReply, ResourceHold, Transport,
};
use semiont::types::{
    HttpEndpoint, HttpEndpointProtocol, KbEndpoint, KnowledgeBase, LocalEndpoint,
    ResourceDescriptor, ResourceId,
};
use semiont_http_transport::session::HttpSessionFactory;
use serde_json::{Map, Value, json};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::sync::{mpsc, watch};
use tokio_stream::StreamExt;
use tokio_stream::wrappers::UnboundedReceiverStream;

fn table() -> Value {
    serde_json::from_str(include_str!(
        "../../../../protocol/specs/src/session/persisted-cases.json"
    ))
    .expect("the table is JSON")
}

fn refresh_table() -> Value {
    serde_json::from_str(include_str!(
        "../../../../protocol/specs/src/client/refresh.json"
    ))
    .expect("the refresh table is JSON")
}

fn stored_table() -> Value {
    serde_json::from_str(include_str!(
        "../../../../protocol/specs/src/session/stored.json"
    ))
    .expect("the stored table is JSON")
}

/// The knowledge base every part but `keys` is of.
const KB: &str = "kb-a";

/// How long anything here may take before it is a failure.
const PATIENCE: Duration = Duration::from_secs(10);

fn text(value: &Value, key: &str) -> String {
    value[key]
        .as_str()
        .unwrap_or_else(|| panic!("no string {key} in {value}"))
        .to_owned()
}

fn object<'a>(value: &'a Value, what: &str) -> &'a Map<String, Value> {
    value
        .as_object()
        .unwrap_or_else(|| panic!("{what} is not an object"))
}

fn rows<'a>(cases: &'a Value, part: &str) -> &'a [Value] {
    let rows = cases[part]
        .as_array()
        .unwrap_or_else(|| panic!("the table has no part {part}"));
    assert!(!rows.is_empty(), "the table's {part} has no row");
    rows
}

/// The key of the table's person `name`.
fn person(cases: &Value, name: &str) -> String {
    text(&cases["people"][name], "personKey")
}

/// Every key a person's queries and stream's places are kept under on a
/// knowledge base.
fn keys_of(kb_id: &str, person_key: &str) -> Vec<String> {
    CacheQuery::PERSISTED
        .iter()
        .map(|query| cache_key(kb_id, person_key, *query))
        .chain([last_event_id_key(kb_id, person_key)])
        .collect()
}

/// A part, or a member of a row, the table gains fails here until this
/// runner reads it.
#[test]
fn the_table_states_only_what_this_runner_reads() {
    let cases = table();
    let parts = [
        "$comment",
        "runBy",
        "notYetReached",
        "people",
        "keys",
        "forgetStorage",
        "forget",
        "whoAmI",
        "startupStorage",
        "startup",
        "crossTab",
        "holder",
        "resumeFrom",
    ];
    for part in object(&cases, "the table").keys() {
        assert!(
            parts.contains(&part.as_str()),
            "the table states {part}, which this runner does not read"
        );
    }
    let members: [(&str, &[&str]); 6] = [
        (
            "keys",
            &[
                "why",
                "kbId",
                "did",
                "personKey",
                "lastEventIdKey",
                "cacheKeys",
            ],
        ),
        (
            "forget",
            &["why", "by", "stored", "signedIn", "open", "removes"],
        ),
        (
            "startup",
            &[
                "why",
                "signedIn",
                "gateway",
                "first",
                "then",
                "recorded",
                "place",
                "untouched",
            ],
        ),
        ("crossTab", &["why", "stored", "saved"]),
        ("holder", &["why", "stored", "saved"]),
        ("resumeFrom", &["why", "frames", "resumes"]),
    ];
    for (part, read) in members {
        for row in rows(&cases, part) {
            for member in object(row, part).keys() {
                assert!(
                    read.contains(&member.as_str()),
                    "a row of {part} states {member}, which this runner does not read"
                );
            }
        }
    }
}

// ── keys ────────────────────────────────────────────────────────────────

#[test]
fn keys() {
    let cases = table();
    let mut wrong = Vec::new();

    // The order is client/refresh.json's: a row's `cacheKeys` is an object,
    // and an object read here keeps no order.
    let marked: Vec<String> = refresh_table()["queries"]
        .as_array()
        .expect("the refresh table has queries")
        .iter()
        .filter(|query| query["persisted"] == json!(true))
        .map(|query| text(query, "name"))
        .collect();
    let persisted: Vec<&str> = CacheQuery::PERSISTED.iter().map(|q| q.name()).collect();
    if persisted != marked {
        wrong.push(format!(
            "the persisted queries are {persisted:?}, want {marked:?}"
        ));
    }

    for (name, stated) in object(&cases["people"], "people") {
        let made = person_key(&text(stated, "did"));
        if made != text(stated, "personKey") {
            wrong.push(format!(
                "{name}'s key is {made}, want {}",
                stated["personKey"]
            ));
        }
    }

    for row in rows(&cases, "keys") {
        let why = text(row, "why");
        let kb_id = text(row, "kbId");
        let made = person_key(&text(row, "did"));
        if made != text(row, "personKey") {
            wrong.push(format!("{why}: the person's key is {made}"));
        }
        let places = last_event_id_key(&kb_id, &made);
        if places != text(row, "lastEventIdKey") {
            wrong.push(format!(
                "{why}: the stream's places are kept under {places}"
            ));
        }
        let mut stated: Vec<&str> = object(&row["cacheKeys"], "cacheKeys")
            .keys()
            .map(String::as_str)
            .collect();
        stated.sort_unstable();
        let mut named = persisted.clone();
        named.sort_unstable();
        if stated != named {
            wrong.push(format!(
                "{why}: the row keys the queries {stated:?}, and the persisted ones are {named:?}"
            ));
        }
        for query in CacheQuery::PERSISTED {
            let key = cache_key(&kb_id, &made, *query);
            if row["cacheKeys"][query.name()] != json!(key) {
                wrong.push(format!("{why}: {} is kept under {key}", query.name()));
            }
        }
    }
    assert!(wrong.is_empty(), "{}", wrong.join("\n"));
}

// ── A sign-in, and a stand-in gateway ───────────────────────────────────

/// The `n`th access token, which expires at `expires`.
fn jwt(n: u64, expires: SystemTime) -> String {
    let seconds = |at: SystemTime| {
        at.duration_since(UNIX_EPOCH)
            .expect("after the epoch")
            .as_secs()
    };
    let claims = json!({ "n": n, "iat": seconds(SystemTime::now()), "exp": seconds(expires) });
    format!(
        "{}.{}.sig",
        URL_SAFE_NO_PAD.encode(r#"{"alg":"none"}"#),
        URL_SAFE_NO_PAD.encode(claims.to_string())
    )
}

/// An hour from now: nothing renews a token that expires then.
fn in_an_hour() -> SystemTime {
    SystemTime::now() + Duration::from_secs(3600)
}

/// The `n`th sign-in, naming the person whose key is `person_key`, or
/// nobody, its token good for an hour. Its issuer has no revocation
/// endpoint, so a sign-out tells nobody.
fn sign_in(n: u64, person_key: Option<&str>) -> StoredSession {
    StoredSession {
        access: jwt(n, in_an_hour()),
        refresh: format!("refresh-{n}"),
        client_id: "semiont-browser".to_owned(),
        token_endpoint: "http://127.0.0.1:9/token".to_owned(),
        revocation_endpoint: None,
        person_key: person_key.map(str::to_owned),
    }
}

/// What the knowledge base says it is.
const DOMAIN: &str = "example.org:kb-a";

fn kb_at(endpoint: KbEndpoint) -> KnowledgeBase {
    KnowledgeBase {
        id: KB.to_owned(),
        label: "KB A".to_owned(),
        did: kb_did(DOMAIN),
        endpoint,
        last_read: None,
    }
}

/// A knowledge base loaded in this process, by its id.
fn loaded(id: &str) -> KnowledgeBase {
    KnowledgeBase {
        id: id.to_owned(),
        label: id.to_owned(),
        did: kb_did(&format!("example.org:{id}")),
        endpoint: KbEndpoint::LocalEndpoint(LocalEndpoint::new(id)),
        last_read: None,
    }
}

fn descriptor(id: &str, name: &str) -> Value {
    json!({ "@context": "https://schema.org/", "@id": id, "name": name, "representations": [] })
}

fn json_answer(status: u16, body: Value) -> Response {
    (
        StatusCode::from_u16(status).expect("a status"),
        [(header::CONTENT_TYPE, "application/json")],
        body.to_string(),
    )
        .into_response()
}

/// What the stand-in answers when asked who a token is.
#[derive(Clone, Copy)]
enum Who {
    /// The table's `whoAmI`.
    Names,
    /// Nobody.
    Unreachable,
    /// Every token is refused.
    Refuses,
}

struct Staged {
    who: Who,
    who_am_i: Value,
    /// Shut until the test lets the gateway say who a token is.
    who_answers: watch::Sender<bool>,
    /// Whether the issuer renews a sign-in; it refuses to until the test
    /// lets it.
    renews: AtomicBool,
    /// What each stream was opened with.
    subscriptions: Mutex<Vec<Value>>,
    streams: Mutex<Vec<mpsc::UnboundedSender<Bytes>>>,
    /// How many streams have been opened.
    opened: watch::Sender<usize>,
}

impl Staged {
    fn streaming(&self) -> bool {
        self.streams
            .lock()
            .unwrap()
            .iter()
            .any(|stream| !stream.is_closed())
    }

    /// Send a reply on every open stream, once one is open: one sent before
    /// the client's stream opens would reach nobody.
    async fn deliver(&self, reply: &str, correlation_id: &str, payload: Value) {
        let mut opened = self.opened.subscribe();
        let _ = opened.wait_for(|_| self.streaming()).await;
        let frame =
            json!({ "channel": reply, "correlationId": correlation_id, "payload": payload });
        let event = Bytes::from(format!(
            "event: bus-event\nid: e-{reply}:{correlation_id}\ndata: {frame}\n\n"
        ));
        for stream in self.streams.lock().unwrap().iter() {
            let _ = stream.send(event.clone());
        }
    }

    /// Send, on every open stream, an event of `scope` whose id is `id`:
    /// the resource was archived.
    fn deliver_on(&self, scope: &str, id: &str) {
        let frame = json!({ "channel": ARCHIVED, "scope": scope, "payload": {} });
        let event = Bytes::from(format!("event: bus-event\nid: {id}\ndata: {frame}\n\n"));
        for stream in self.streams.lock().unwrap().iter() {
            let _ = stream.send(event.clone());
        }
    }
}

/// The channel of the events `resumeFrom` delivers on a scope.
const ARCHIVED: &str = "mark:archived";

async fn me(State(staged): State<Arc<Staged>>) -> Response {
    let mut answers = staged.who_answers.subscribe();
    let _ = answers.wait_for(|answers| *answers).await;
    match staged.who {
        Who::Names => json_answer(200, staged.who_am_i.clone()),
        // An answer that names nobody, and that a client does not ask again
        // for, as it would a 503.
        Who::Unreachable => StatusCode::NOT_FOUND.into_response(),
        Who::Refuses => StatusCode::UNAUTHORIZED.into_response(),
    }
}

/// The issuer's answer to a renewal: a new token, or a refusal.
async fn token(State(staged): State<Arc<Staged>>) -> Response {
    if staged.renews.load(Ordering::SeqCst) {
        json_answer(
            200,
            json!({ "access_token": jwt(2, in_an_hour()), "refresh_token": "refresh-2" }),
        )
    } else {
        json_answer(400, json!({ "error": "invalid_grant" }))
    }
}

async fn subscribe(State(staged): State<Arc<Staged>>, body: String) -> Response {
    staged
        .subscriptions
        .lock()
        .unwrap()
        .push(serde_json::from_str(&body).expect("a subscription"));
    let (events, stream) = mpsc::unbounded_channel();
    staged.streams.lock().unwrap().push(events);
    staged.opened.send_modify(|opened| *opened += 1);
    let body = UnboundedReceiverStream::new(stream).map(Ok::<Bytes, std::convert::Infallible>);
    (
        [(header::CONTENT_TYPE, "text/event-stream")],
        Body::from_stream(body),
    )
        .into_response()
}

/// A read of a resource is answered with the resource named `fresh`, and
/// the knowledge base says what it is.
async fn emit(State(staged): State<Arc<Staged>>, body: String) -> Response {
    let sent: Value = serde_json::from_str(&body).expect("an emit");
    let Some(correlation_id) = sent["correlationId"].as_str().map(str::to_owned) else {
        return json_answer(202, json!({}));
    };
    match sent["channel"].as_str() {
        Some("browse:resource-requested") => {
            let resource = text(&sent["payload"], "resourceId");
            let staged = staged.clone();
            tokio::spawn(async move {
                let payload = json!({ "response": {
                    "resource": descriptor(&resource, "fresh"), "lastSequence": 1,
                } });
                staged
                    .deliver("browse:resource-result", &correlation_id, payload)
                    .await;
            });
        }
        Some("browse:kb-requested") => {
            let staged = staged.clone();
            tokio::spawn(async move {
                let payload = json!({ "response": {
                    "name": "KB A", "domain": DOMAIN, "gitBranch": "main",
                } });
                staged
                    .deliver("browse:kb-result", &correlation_id, payload)
                    .await;
            });
        }
        _ => {}
    }
    json_answer(202, json!({}))
}

struct Gateway {
    port: u16,
    staged: Arc<Staged>,
    server: tokio::task::JoinHandle<()>,
    http: reqwest::Client,
}

impl Drop for Gateway {
    fn drop(&mut self) {
        self.server.abort();
    }
}

impl Gateway {
    async fn start(who: Who, who_am_i: Value) -> Gateway {
        // Already installed by another test of this process: one is enough.
        let _ = rustls::crypto::ring::default_provider().install_default();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("a port");
        let port = listener.local_addr().expect("an address").port();
        let staged = Arc::new(Staged {
            who,
            who_am_i,
            who_answers: watch::channel(false).0,
            renews: AtomicBool::new(false),
            subscriptions: Mutex::default(),
            streams: Mutex::default(),
            opened: watch::channel(0).0,
        });
        let app = Router::new()
            .route("/api/users/me", get(me))
            .route("/token", post(token))
            .route("/bus/subscribe", post(subscribe))
            .route("/bus/emit", post(emit))
            .with_state(staged.clone());
        let server = tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        Gateway {
            port,
            staged,
            server,
            http: reqwest::Client::new(),
        }
    }

    fn kb(&self) -> KnowledgeBase {
        kb_at(KbEndpoint::HttpEndpoint(HttpEndpoint::new(
            "127.0.0.1",
            self.port,
            HttpEndpointProtocol::Http,
        )))
    }

    fn let_who_answer(&self) {
        self.staged.who_answers.send_replace(true);
    }

    fn let_the_issuer_renew(&self) {
        self.staged.renews.store(true, Ordering::SeqCst);
    }

    fn token_endpoint(&self) -> String {
        format!("http://127.0.0.1:{}/token", self.port)
    }

    /// The event id the first stream that held `scope` resumed it from,
    /// null for none; `None` while no stream has held it.
    fn resumed_from(&self, scope: &str) -> Option<Value> {
        resumed_in(&self.first_holding(scope)?, scope)
    }

    /// What the first stream that held `scope` was opened with; `None` while
    /// no stream has held it.
    fn first_holding(&self, scope: &str) -> Option<Value> {
        self.staged
            .subscriptions
            .lock()
            .unwrap()
            .iter()
            .find(|subscription| resumed_in(subscription, scope).is_some())
            .cloned()
    }
}

/// The event id a stream opened with `subscription` resumes `scope` from,
/// null for none; `None` when it does not hold `scope`.
fn resumed_in(subscription: &Value, scope: &str) -> Option<Value> {
    subscription["scoped"]
        .as_array()?
        .iter()
        .find(|scoped| scoped["scope"] == scope)
        .map(|scoped| scoped["lastEventId"].clone())
}

/// Whether `probe` holds within the test's patience.
async fn settled(probe: impl Fn() -> bool) -> bool {
    let deadline = tokio::time::Instant::now() + PATIENCE;
    while !probe() {
        if tokio::time::Instant::now() >= deadline {
            return false;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    true
}

async fn live(browser: &SemiontBrowser) -> Arc<SemiontSession> {
    let mut session = browser.active_session();
    let session = tokio::time::timeout(PATIENCE, session.wait_for(Option::is_some))
        .await
        .expect("a session comes up")
        .expect("the browser lives")
        .clone();
    session.expect("a session")
}

/// The next state a watcher is given; `None` once it ends, or when it is
/// given none in time.
async fn next_state(
    watcher: &mut Observed<ResourceDescriptor>,
) -> Option<CacheState<ResourceDescriptor>> {
    tokio::time::timeout(PATIENCE, watcher.next())
        .await
        .ok()
        .flatten()
}

/// The next value a watcher is given; `None` when it is given a failure,
/// ends, or is given none in time.
async fn next_value(watcher: &mut Observed<ResourceDescriptor>) -> Option<ResourceDescriptor> {
    loop {
        match next_state(watcher).await? {
            CacheState::Ready(value) => return Some(value),
            CacheState::Pending => {}
            CacheState::Failed(_) => return None,
        }
    }
}

/// How a watcher is not given what a row says it is: `kept`, the kept value
/// at once and then, asked for again, the gateway's (B18); `fresh`, the
/// gateway's, with no value shown before it.
async fn given_as(watcher: &mut Observed<ResourceDescriptor>, said: &str) -> Option<String> {
    let first = next_state(watcher).await;
    match said {
        "kept" => {
            let Some(CacheState::Ready(kept)) = &first else {
                return Some(format!("was given {first:?} at once, not the kept value"));
            };
            if kept.name != "kept" {
                return Some(format!("was given {kept:?} at once, not the kept value"));
            }
            let then = next_value(watcher).await;
            (then.as_ref().map(|value| value.name.as_str()) != Some("fresh"))
                .then(|| format!("the kept value was followed by {then:?}, not asked for again"))
        }
        "fresh" => {
            let value = match first {
                Some(CacheState::Ready(value)) => Some(value),
                Some(CacheState::Pending) => next_value(watcher).await,
                Some(CacheState::Failed(_)) | None => None,
            };
            (value.as_ref().map(|value| value.name.as_str()) != Some("fresh"))
                .then(|| format!("was given {value:?}, not the gateway's answer"))
        }
        other => panic!("a row says a read gives {other}"),
    }
}

// ── forget ──────────────────────────────────────────────────────────────

/// A transport that answers nothing, and whose closing writes under `key`,
/// when it has one, as a client closing with a save pending could.
struct ClosingWrites {
    answers_nothing: FaultyTransport,
    storage: Arc<dyn SessionStorage>,
    key: Option<String>,
}

impl Transport for ClosingWrites {
    fn base_url(&self) -> &str {
        self.answers_nothing.base_url()
    }

    fn emit<'a>(
        &'a self,
        channel: &'a str,
        payload: Map<String, Value>,
        envelope: Envelope,
    ) -> BoxFuture<'a, Result<Option<u64>, TransportError>> {
        self.answers_nothing.emit(channel, payload, envelope)
    }

    fn frames(&self, channel: &str) -> Result<Frames, BusRequestError> {
        self.answers_nothing.frames(channel)
    }

    fn is_subscribed(&self, channel: &str) -> bool {
        self.answers_nothing.is_subscribed(channel)
    }

    fn subscribe_to_resource(&self, resource_id: &ResourceId) -> ResourceHold {
        self.answers_nothing.subscribe_to_resource(resource_id)
    }

    fn state(&self) -> watch::Receiver<ConnectionState> {
        self.answers_nothing.state()
    }

    fn failures(&self) -> Failures {
        self.answers_nothing.failures()
    }

    fn track_reply(&self, correlation_id: &str, reply_channels: &[&str]) -> PendingReply {
        self.answers_nothing
            .track_reply(correlation_id, reply_channels)
    }

    fn bridge_into(&self, bus: Arc<EventBus>) {
        self.answers_nothing.bridge_into(bus);
    }

    fn close(&self) -> BoxFuture<'_, ()> {
        Box::pin(async move {
            if let Some(key) = &self.key {
                self.storage
                    .set(key, "written as the client closed")
                    .expect("written");
            }
            self.answers_nothing.close().await;
        })
    }
}

/// Builds each session over a `ClosingWrites`: the session of the table's
/// open client, kept for the person its knowledge base's stored sign-in
/// names as it is built, whose closing writes under that person's
/// `resource` key. One built over a sign-in that names nobody, or over none,
/// keeps nothing, and its closing writes nothing.
struct ClosingSessions;

impl SessionFactory for ClosingSessions {
    fn session(&self, options: SessionFactoryOptions) -> Result<SemiontSession, SessionError> {
        let kb_id = options.kb.id.clone();
        let kept_for = stored_session(options.storage.as_ref(), &kb_id)
            .and_then(|stored| stored.person_key)
            .map(|person_key| cache_key(&kb_id, &person_key, CacheQuery::Resource));
        let transport = ClosingWrites {
            answers_nothing: FaultyTransport::new(BRIDGED_CHANNELS, vec![]),
            storage: options.storage.clone(),
            key: kept_for,
        };
        let client = Arc::new(SemiontClient::new(
            Arc::new(transport),
            Arc::new(InMemoryContent::new()),
            None,
            ClientOptions::default(),
        ));
        Ok(SemiontSession::new(SemiontSessionConfig {
            kb: options.kb.target(),
            kept: kept_in(options.storage, &kb_id),
            client,
            token: watch::channel(None).0,
            refresh: None,
            validate: None,
            on_auth_failed: None,
            random: None,
        }))
    }

    fn revoke(&self, _: StoredSession) -> BoxFuture<'static, ()> {
        Box::pin(async {})
    }
}

/// The registry signs out of kb-a, removes it, or signs in to it again with
/// a new sign-in (`by`), over stand-in sessions whose closing writes under
/// the `resource` key of the person their sign-in named; kb-a is active
/// when `open`. A sign-in is of a registered knowledge base, so for one kb-a
/// is registered whether or not it is open, and when it is not, kb-b is the
/// active one. How it is not that a sign-in left its new sign-in stored.
async fn forgotten_by_the_registry(
    storage: &Arc<SharedStorage>,
    by: &str,
    signed_in: Option<StoredSession>,
    open: bool,
) -> Option<String> {
    if let Some(signed_in) = &signed_in {
        store_session(storage.as_ref(), KB, signed_in).expect("stored");
    }
    // A knowledge base that is not registered has no client to open.
    let registered = match (by, open) {
        (_, true) => vec![loaded(KB)],
        ("signIn", false) => vec![loaded("kb-b"), loaded(KB)],
        (_, false) => Vec::new(),
    };
    save_knowledge_bases(storage.as_ref(), &registered).expect("stored");
    let browser = SemiontBrowser::new(SemiontBrowserConfig {
        storage: storage.clone(),
        session_factory: Arc::new(ClosingSessions),
    })
    .expect("a browser");
    if !registered.is_empty() {
        live(&browser).await;
    }
    let new = sign_in(2, None);
    match by {
        "signOut" => browser.sign_out(KB).await.expect("signed out"),
        "removal" => browser.remove_kb(KB).await.expect("removed"),
        "signIn" => browser.sign_in(KB, &new).await.expect("signed in"),
        other => panic!("the registry forgets by {other}"),
    }
    browser.close().await.expect("closed");
    let stored = stored_session(storage.as_ref(), KB);
    (by == "signIn" && stored.as_ref() != Some(&new))
        .then(|| format!("kb-a's stored sign-in is {stored:?}, not the new one"))
}

/// kb-a's session, the registry's own over the HTTP session factory, ends
/// while its client is open: its gateway refuses every token, and its
/// issuer refuses to renew (`expiry`), or renews (`refusal`), the token
/// `stored` says. How it is not that the session forgot its stored sign-in.
async fn forgotten_by_the_session(
    cases: &Value,
    storage: &Arc<SharedStorage>,
    row: &Value,
    signed_in: StoredSession,
) -> Option<String> {
    let gateway = Gateway::start(Who::Refuses, cases["whoAmI"].clone()).await;
    gateway.let_who_answer();
    match text(row, "by").as_str() {
        "expiry" => {}
        "refusal" => gateway.let_the_issuer_renew(),
        other => panic!("a session forgets by {other}"),
    }
    let expires = match text(row, "stored").as_str() {
        "expired" => SystemTime::now() - Duration::from_secs(60),
        "unexpired" => in_an_hour(),
        other => panic!("a row's stored token is {other}"),
    };
    store_session(
        storage.as_ref(),
        KB,
        &StoredSession {
            access: jwt(1, expires),
            token_endpoint: gateway.token_endpoint(),
            ..signed_in
        },
    )
    .expect("stored");
    save_knowledge_bases(storage.as_ref(), &[gateway.kb()]).expect("stored");
    let browser = SemiontBrowser::new(SemiontBrowserConfig {
        storage: storage.clone(),
        session_factory: Arc::new(HttpSessionFactory::new(gateway.http.clone(), None)),
    })
    .expect("a browser");
    let ended = settled(|| stored_session(storage.as_ref(), KB).is_none()).await;
    browser.close().await.expect("closed");
    (!ended).then(|| "the session never forgot its stored sign-in".to_owned())
}

/// How one row of `forget` is not what forgetting kb-a's stored sign-in
/// deleted, looked at once kb-a's client has closed.
async fn forgotten(cases: &Value, row: &Value) -> Vec<String> {
    let jo = person(cases, "jo");
    let storage = Arc::new(SharedStorage::new());
    let seeded = object(&cases["forgetStorage"], "forgetStorage");
    for (key, value) in seeded {
        storage
            .set(key, value.as_str().expect("a stored value is text"))
            .expect("stored");
    }
    let signed_in = text(row, "signedIn");
    let named = (signed_in == "named").then(|| jo.clone());
    let stored = match signed_in.as_str() {
        "named" | "unnamed" => Some(sign_in(1, named.as_deref())),
        "none" => None,
        other => panic!("a row is signed in {other}"),
    };
    let open = row["open"].as_bool().expect("open is a boolean");
    let by = text(row, "by");

    let mut wrong = Vec::new();
    match by.as_str() {
        "signOut" | "removal" | "signIn" => {
            wrong.extend(forgotten_by_the_registry(&storage, &by, stored, open).await);
        }
        _ => {
            assert!(open, "a session that ends is kb-a's active one");
            let stored = stored.expect("a session that ends was signed in");
            wrong.extend(forgotten_by_the_session(cases, &storage, row, stored).await);
        }
    }

    let removed = match (text(row, "removes").as_str(), &named) {
        ("person", Some(named)) => keys_of(KB, named),
        ("person", None) => panic!("a row removes the person of a sign-in that names nobody"),
        ("nothing", _) => Vec::new(),
        (other, _) => panic!("a row removes {other}"),
    };
    for key in &removed {
        if let Some(left) = storage.get(key) {
            wrong.push(format!("{key} still holds {left}"));
        }
    }
    for (key, value) in seeded {
        if !removed.contains(key) && storage.get(key).as_deref() != value.as_str() {
            wrong.push(format!("{key} holds {:?}, want {value}", storage.get(key)));
        }
    }
    wrong
}

#[tokio::test]
async fn forget() {
    let cases = table();
    let mut wrong = Vec::new();
    for row in rows(&cases, "forget") {
        let why = text(row, "why");
        wrong.extend(
            forgotten(&cases, row)
                .await
                .into_iter()
                .map(|differs| format!("{why}: {differs}")),
        );
    }
    assert!(wrong.is_empty(), "{}", wrong.join("\n"));
}

// ── startup ─────────────────────────────────────────────────────────────

/// How one row of `startup` is not what the HTTP session factory's session
/// did.
async fn started(cases: &Value, row: &Value) -> Vec<String> {
    let jo = person(cases, "jo");
    let who = match text(row, "gateway").as_str() {
        "names" => Who::Names,
        "unreachable" => Who::Unreachable,
        other => panic!("a row's gateway {other}"),
    };
    let gateway = Gateway::start(who, cases["whoAmI"].clone()).await;
    let storage = Arc::new(SharedStorage::new());
    let kept = object(&cases["startupStorage"], "startupStorage");
    for (key, value) in kept {
        storage
            .set(key, value.as_str().expect("a stored value is text"))
            .expect("stored");
    }
    let named = match text(row, "signedIn").as_str() {
        "named" => Some(jo.as_str()),
        "unnamed" => None,
        other => panic!("a row is signed in {other}"),
    };
    store_session(storage.as_ref(), KB, &sign_in(1, named)).expect("stored");
    let recorded_now = || stored_session(storage.as_ref(), KB).and_then(|stored| stored.person_key);

    let session = HttpSessionFactory::new(gateway.http.clone(), None)
        .session(SessionFactoryOptions {
            kb: gateway.kb(),
            storage: storage.clone(),
            signals: Arc::new(SessionSignals::new()),
        })
        .expect("a session");
    let client = session.client().clone();
    let mut wrong = Vec::new();

    // Asked while the gateway has not said who the token is.
    let mut res_2 = client.browse.resource(&as_id("res-2")).watch();
    if let Some(differs) = given_as(&mut res_2, &text(row, "first")).await {
        wrong.push(format!("first: res-2 {differs}"));
    }

    gateway.let_who_answer();
    if tokio::time::timeout(PATIENCE, session.ready())
        .await
        .is_err()
    {
        wrong.push("the session was not ready once the gateway answered".to_owned());
    }
    if let Some(recorded) = row["recorded"].as_str() {
        settled(|| recorded_now().as_deref() == Some(recorded)).await;
    }

    let mut res_1 = client.browse.resource(&as_id("res-1")).watch();
    if let Some(differs) = given_as(&mut res_1, &text(row, "then")).await {
        wrong.push(format!("then: res-1 {differs}"));
    }

    let recorded = recorded_now();
    if recorded.as_deref() != row["recorded"].as_str() {
        wrong.push(format!(
            "the stored sign-in names {recorded:?}, want {}",
            row["recorded"]
        ));
    }

    settled(|| gateway.resumed_from("res-1").is_some()).await;
    let place = gateway.resumed_from("res-1");
    if place.as_ref() != Some(&row["place"]) {
        wrong.push(format!(
            "res-1's scope resumed from {place:?}, want {}",
            row["place"]
        ));
    }

    client.close().await;
    session.dispose();

    if let Some(untouched) = row["untouched"].as_bool() {
        let stored = stored_table();
        let prefixes = [
            text(&stored["cacheKeyPrefix"], "prefix"),
            text(&stored["lastEventIdKeyPrefix"], "prefix"),
        ];
        let changed: Vec<&String> = kept
            .iter()
            .filter(|(key, value)| storage.get(key).as_deref() != value.as_str())
            .map(|(key, _)| key)
            .collect();
        let written: Vec<String> = storage
            .keys()
            .into_iter()
            .filter(|key| {
                prefixes
                    .iter()
                    .any(|prefix| key.starts_with(prefix.as_str()))
                    && !kept.contains_key(key)
            })
            .collect();
        let was = changed.is_empty() && written.is_empty();
        if was != untouched {
            wrong.push(format!(
                "untouched is {was}, want {untouched}: changed {changed:?}, written {written:?}"
            ));
        }
    }
    wrong
}

#[tokio::test]
async fn startup() {
    let cases = table();
    let mut wrong = Vec::new();
    for row in rows(&cases, "startup") {
        let why = text(row, "why");
        wrong.extend(
            started(&cases, row)
                .await
                .into_iter()
                .map(|differs| format!("{why}: {differs}")),
        );
    }
    assert!(wrong.is_empty(), "{}", wrong.join("\n"));
}

// ── crossTab ────────────────────────────────────────────────────────────

/// The value kept of `entry` in the cache document under `key`.
fn kept_value(storage: &SharedStorage, key: &str, entry: &str) -> Option<Value> {
    let document: Value = serde_json::from_str(&storage.get(key)?).ok()?;
    document["entries"]
        .as_array()?
        .iter()
        .find(|kept| kept[0] == entry)
        .map(|kept| kept[1].clone())
}

/// Where kb-a's stored sign-in is changed while its client holds a value it
/// has not written.
#[derive(Clone, Copy)]
enum Changed {
    /// By another context, writing the storage (`crossTab`).
    Elsewhere,
    /// In this process, through what holds the registry session's sign-in:
    /// the storage's functions (`holder`). Forgotten by the public clear,
    /// replaced by the save of a new sign-in, renewed by a write of the
    /// stored session that keeps its person.
    ThroughTheHolder,
}

/// A sign-in written as the stored session, as a renewal writes it: no save
/// of a new sign-in, which forgets whom the one it replaces named.
fn written_over(
    storage: &dyn SessionStorage,
    signed_in: &StoredSession,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    storage.set(&session_key(KB), &signed_in.written())
}

/// How one row of `crossTab` or `holder` is not what the registry's client
/// wrote.
///
/// In the table's order: the client is given res-1 and owes its save, the
/// stored sign-in is changed before that save's wait is over, and the
/// client closes. Nothing is awaited between the value's arrival and the
/// change, so the save cannot be made between them on this runtime's one
/// thread, unless its wait was already over when the value arrived; a save
/// written before the change fails the row, which was then not run in its
/// order.
async fn across(cases: &Value, row: &Value, changed: Changed) -> Vec<String> {
    let jo = person(cases, "jo");
    let gateway = Gateway::start(Who::Names, cases["whoAmI"].clone()).await;
    gateway.let_who_answer();
    let storage = Arc::new(SharedStorage::new());
    let elsewhere = storage.context();
    save_knowledge_bases(storage.as_ref(), &[gateway.kb()]).expect("stored");
    store_session(storage.as_ref(), KB, &sign_in(1, Some(&jo))).expect("stored");
    let browser = SemiontBrowser::new(SemiontBrowserConfig {
        storage: storage.clone(),
        session_factory: Arc::new(HttpSessionFactory::new(gateway.http.clone(), None)),
    })
    .expect("a browser");
    let session = live(&browser).await;
    let kept_for_jo = cache_key(KB, &jo, CacheQuery::Resource);

    let mut res_1 = session.client().browse.resource(&as_id("res-1")).watch();
    let held = next_value(&mut res_1).await;
    let written_before = kept_value(&storage, &kept_for_jo, "res-1");
    let stated = &row["stored"];
    let naming = stated["personKey"].as_str();
    match (changed, stated) {
        (Changed::Elsewhere, Value::Null) => elsewhere.delete(&session_key(KB)),
        (Changed::Elsewhere, _) => written_over(&elsewhere, &sign_in(2, naming)),
        (Changed::ThroughTheHolder, Value::Null) => clear_stored_session(storage.as_ref(), KB),
        (Changed::ThroughTheHolder, _) if naming == Some(jo.as_str()) => {
            written_over(storage.as_ref(), &sign_in(2, naming))
        }
        (Changed::ThroughTheHolder, _) => store_session(storage.as_ref(), KB, &sign_in(2, naming)),
    }
    .expect("the stored sign-in changed");
    browser.close().await.expect("closed");

    let Some(held) = held else {
        return vec!["the client was given no value of res-1".to_owned()];
    };
    if let Some(written) = written_before {
        return vec![format!(
            "res-1's save, {written}, was written before the stored sign-in changed: the row was not run in its order"
        )];
    }
    let saved = kept_value(&storage, &kept_for_jo, "res-1")
        == Some(serde_json::to_value(&held).expect("a resource serializes"));
    let want = row["saved"].as_bool().expect("saved is a boolean");
    if saved == want {
        Vec::new()
    } else {
        vec![format!("res-1's value saved is {saved}, want {want}")]
    }
}

#[tokio::test]
async fn cross_tab() {
    let cases = table();
    let mut wrong = Vec::new();
    for row in rows(&cases, "crossTab") {
        let why = text(row, "why");
        wrong.extend(
            across(&cases, row, Changed::Elsewhere)
                .await
                .into_iter()
                .map(|differs| format!("{why}: {differs}")),
        );
    }
    assert!(wrong.is_empty(), "{}", wrong.join("\n"));
}

// ── holder ──────────────────────────────────────────────────────────────

#[tokio::test]
async fn holder() {
    let cases = table();
    let mut wrong = Vec::new();
    for row in rows(&cases, "holder") {
        let why = text(row, "why");
        wrong.extend(
            across(&cases, row, Changed::ThroughTheHolder)
                .await
                .into_iter()
                .map(|differs| format!("{why}: {differs}")),
        );
    }
    assert!(wrong.is_empty(), "{}", wrong.join("\n"));
}

// ── resumeFrom ──────────────────────────────────────────────────────────

/// How one row of `resumeFrom` is not what the HTTP session factory's
/// session resumed res-1's scope from. Its client, kept for jo, holds res-1;
/// once its stream has delivered the row's events on res-1's scope, and its
/// client has been given each, the client comes to hold res-2 too, and the
/// stream that then holds both is the one res-1's scope is next subscribed
/// to on.
async fn resumed(cases: &Value, row: &Value) -> Option<String> {
    let jo = person(cases, "jo");
    let gateway = Gateway::start(Who::Names, cases["whoAmI"].clone()).await;
    gateway.let_who_answer();
    let storage = Arc::new(SharedStorage::new());
    store_session(storage.as_ref(), KB, &sign_in(1, Some(&jo))).expect("stored");
    let session = HttpSessionFactory::new(gateway.http.clone(), None)
        .session(SessionFactoryOptions {
            kb: gateway.kb(),
            storage: storage.clone(),
            signals: Arc::new(SessionSignals::new()),
        })
        .expect("a session");
    let client = session.client().clone();
    let ids: Vec<&str> = row["frames"]
        .as_array()
        .expect("a row's frames are a list")
        .iter()
        .map(|id| id.as_str().expect("a frame is an event's id"))
        .collect();

    let mut given = client.bus().frames(ARCHIVED);
    let _res_1 = client.browse.resource(&as_id("res-1")).watch();
    let wrong = if !settled(|| gateway.first_holding("res-1").is_some()).await {
        Some("no stream held res-1".to_owned())
    } else {
        for id in &ids {
            gateway.staged.deliver_on("res-1", id);
        }
        let mut taken = 0;
        while taken < ids.len()
            && matches!(
                tokio::time::timeout(PATIENCE, given.next()).await,
                Ok(Some(Ok(Ok(_))))
            )
        {
            taken += 1;
        }
        let _res_2 = client.browse.resource(&as_id("res-2")).watch();
        let next = settled(|| gateway.first_holding("res-2").is_some())
            .await
            .then(|| gateway.first_holding("res-2"))
            .flatten();
        match (taken == ids.len(), next) {
            (false, _) => Some(format!(
                "the client was given {taken} of the {} events",
                ids.len()
            )),
            (true, None) => Some("no stream held res-2".to_owned()),
            (true, Some(next)) => match resumed_in(&next, "res-1") {
                None => Some("the stream that held res-2 did not hold res-1".to_owned()),
                Some(resumes) if resumes == row["resumes"] => None,
                Some(resumes) => Some(format!(
                    "res-1's scope resumed from {resumes}, want {}",
                    row["resumes"]
                )),
            },
        }
    };
    client.close().await;
    session.dispose();
    wrong
}

#[tokio::test]
async fn resume_from() {
    let cases = table();
    let mut wrong = Vec::new();
    for row in rows(&cases, "resumeFrom") {
        let why = text(row, "why");
        wrong.extend(
            resumed(&cases, row)
                .await
                .map(|differs| format!("{why}: {differs}")),
        );
    }
    assert!(wrong.is_empty(), "{}", wrong.join("\n"));
}

// ── A save being written as the session forgets its sign-in ─────────────

/// A storage whose first write under `key` says it has begun, then waits
/// until the test lets it go: a save that found the sign-in naming its
/// person, still being written.
struct HeldWrite {
    beneath: SharedStorage,
    key: String,
    begun: Mutex<Option<std::sync::mpsc::Sender<()>>>,
    let_go: Mutex<std::sync::mpsc::Receiver<()>>,
}

impl SessionStorage for HeldWrite {
    fn get(&self, key: &str) -> Option<String> {
        self.beneath.get(key)
    }

    fn set(&self, key: &str, value: &str) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let begun = if key == self.key {
            self.begun.lock().unwrap().take()
        } else {
            None
        };
        if let Some(begun) = begun {
            begun.send(()).expect("the test listens");
            self.let_go
                .lock()
                .unwrap()
                .recv()
                .expect("the test lets it go");
        }
        self.beneath.set(key, value)
    }

    fn delete(&self, key: &str) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        self.beneath.delete(key)
    }

    fn update(
        &self,
        key: &str,
        change: &mut dyn FnMut(Option<&str>) -> Option<String>,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        self.beneath.update(key, change)
    }

    fn subscribe(&self, on_change: StorageChange) -> Option<StorageSubscription> {
        self.beneath.subscribe(on_change)
    }
}

/// How long a forget is given to finish while the save it met is held: one
/// whose delete waits for that save cannot finish until it is let go.
const A_MOMENT: Duration = Duration::from_millis(200);

/// The session the HTTP session factory builds, its client kept for jo,
/// forgets its sign-in (the gateway refused its token, and its issuer
/// refuses to renew it) while a save of res-1, which found the sign-in
/// naming jo, is being written. Once both have finished, no key of jo's on
/// kb-a holds anything: the check and the write are one step, and the
/// forget's delete is not made while that step is under way.
///
/// The save is held from before the forget begins, and let go only after
/// the session has given up its token, from which its forget runs to its
/// delete with nothing awaited, and after the forget has had a moment to
/// finish.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_save_being_written_as_the_session_forgets_its_sign_in_is_not_left_after_the_delete() {
    let cases = table();
    let jo = person(&cases, "jo");
    let gateway = Gateway::start(Who::Names, cases["whoAmI"].clone()).await;
    gateway.let_who_answer();
    let (begun, has_begun) = std::sync::mpsc::channel();
    let (let_go, letting_go) = std::sync::mpsc::channel();
    let storage = Arc::new(HeldWrite {
        beneath: SharedStorage::new(),
        key: cache_key(KB, &jo, CacheQuery::Resource),
        begun: Mutex::new(Some(begun)),
        let_go: Mutex::new(letting_go),
    });
    store_session(
        storage.as_ref(),
        KB,
        &StoredSession {
            token_endpoint: gateway.token_endpoint(),
            ..sign_in(1, Some(&jo))
        },
    )
    .expect("stored");
    let session = Arc::new(
        HttpSessionFactory::new(gateway.http.clone(), None)
            .session(SessionFactoryOptions {
                kb: gateway.kb(),
                storage: storage.clone(),
                signals: Arc::new(SessionSignals::new()),
            })
            .expect("a session"),
    );
    tokio::time::timeout(PATIENCE, session.ready())
        .await
        .expect("the session is ready");
    let client = session.client().clone();

    let mut res_1 = client.browse.resource(&as_id("res-1")).watch();
    assert!(
        next_value(&mut res_1).await.is_some(),
        "the client was given no value of res-1"
    );
    tokio::task::spawn_blocking(move || has_begun.recv_timeout(PATIENCE))
        .await
        .expect("the wait ran")
        .expect("res-1's save is written");

    let mut token = session.token();
    let refused = token.borrow().clone();
    let mut forgetting = tokio::spawn({
        let session = session.clone();
        async move { session.refresh(refused.as_deref()).await }
    });
    tokio::time::timeout(PATIENCE, token.wait_for(Option::is_none))
        .await
        .expect("the session gives up its token")
        .expect("the session lives");
    let _ = tokio::time::timeout(A_MOMENT, &mut forgetting).await;
    let_go.send(()).expect("the save waits");
    tokio::time::timeout(PATIENCE, forgetting)
        .await
        .expect("the forget finishes")
        .expect("the forget ran");
    client.close().await;
    session.dispose();

    assert!(
        stored_session(storage.as_ref(), KB).is_none(),
        "the session did not forget its sign-in"
    );
    let left: Vec<String> = keys_of(KB, &jo)
        .into_iter()
        .filter_map(|key| storage.get(&key).map(|held| format!("{key} holds {held}")))
        .collect();
    assert!(
        left.is_empty(),
        "once the forget and the save it met have both finished:\n{}",
        left.join("\n")
    );
}
