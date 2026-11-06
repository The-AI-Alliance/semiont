//! The runner of protocol/specs/src/session/persisted-cases.json: what a
//! client keeps of one person in a registry's storage, and when it is read,
//! written and deleted. `keys` against the key functions and the generated
//! list of persisted queries; `signOut` against a registry; `startup`
//! against the session the HTTP session factory builds, over a stand-in
//! gateway that names the person, or nobody, once the test lets it;
//! `crossTab` against a registry whose stored sign-in another context
//! deletes or replaces.

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
use semiont::client::{ClientOptions, SemiontClient};
use semiont::errors::{BusRequestError, SessionError, TransportError};
use semiont::event_bus::EventBus;
use semiont::identity::kb_did;
use semiont::refresh::CacheQuery;
use semiont::session::{
    SemiontBrowser, SemiontBrowserConfig, SemiontSession, SemiontSessionConfig, SessionFactory,
    SessionFactoryOptions, SessionSignals, StoredSession, cache_key, last_event_id_key, person_key,
    save_knowledge_bases, session_key, store_session, stored_session,
};
use semiont::state_unit::StateUnit;
use semiont::storage::SessionStorage;
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
        "signOutStorage",
        "signOut",
        "whoAmI",
        "startupStorage",
        "startup",
        "crossTab",
    ];
    for part in object(&cases, "the table").keys() {
        assert!(
            parts.contains(&part.as_str()),
            "the table states {part}, which this runner does not read"
        );
    }
    let members: [(&str, &[&str]); 4] = [
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
        ("signOut", &["why", "signedIn", "open", "removes"]),
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

/// An access token good for an hour: nothing renews it.
fn jwt(n: u64) -> String {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("after the epoch")
        .as_secs();
    let claims = json!({ "n": n, "iat": now, "exp": now + 3600 });
    format!(
        "{}.{}.sig",
        URL_SAFE_NO_PAD.encode(r#"{"alg":"none"}"#),
        URL_SAFE_NO_PAD.encode(claims.to_string())
    )
}

/// The `n`th sign-in, naming the person whose key is `person_key`, or
/// nobody. Its issuer has no revocation endpoint, so a sign-out tells
/// nobody.
fn sign_in(n: u64, person_key: Option<&str>) -> StoredSession {
    StoredSession {
        access: jwt(n),
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
}

struct Staged {
    who: Who,
    who_am_i: Value,
    /// Shut until the test lets the gateway say who a token is.
    who_answers: watch::Sender<bool>,
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
}

async fn me(State(staged): State<Arc<Staged>>) -> Response {
    let mut answers = staged.who_answers.subscribe();
    let _ = answers.wait_for(|answers| *answers).await;
    match staged.who {
        Who::Names => json_answer(200, staged.who_am_i.clone()),
        // An answer that names nobody, and that a client does not ask again
        // for, as it would a 503.
        Who::Unreachable => StatusCode::NOT_FOUND.into_response(),
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
            subscriptions: Mutex::default(),
            streams: Mutex::default(),
            opened: watch::channel(0).0,
        });
        let app = Router::new()
            .route("/api/users/me", get(me))
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

    /// The event id the first stream that held `scope` resumed it from,
    /// null for none; `None` while no stream has held it.
    fn resumed_from(&self, scope: &str) -> Option<Value> {
        self.staged
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
            .find(|scoped| scoped["scope"] == scope)
            .map(|scoped| scoped["lastEventId"].clone())
    }
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

// ── signOut ─────────────────────────────────────────────────────────────

/// A transport that answers nothing, and whose closing writes under `key`,
/// as a client closing with a save pending could.
struct ClosingWrites {
    answers_nothing: FaultyTransport,
    storage: Arc<dyn SessionStorage>,
    key: String,
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
            self.storage
                .set(&self.key, "written as the client closed")
                .expect("written");
            self.answers_nothing.close().await;
        })
    }
}

/// Builds each session over a `ClosingWrites`: the session of the table's
/// open client, kept for jo, whose closing writes under jo's `resource` key.
struct ClosingSessions {
    key: String,
}

impl SessionFactory for ClosingSessions {
    fn session(&self, options: SessionFactoryOptions) -> Result<SemiontSession, SessionError> {
        let transport = ClosingWrites {
            answers_nothing: FaultyTransport::new(vec![]),
            storage: options.storage.clone(),
            key: self.key.clone(),
        };
        let client = Arc::new(SemiontClient::new(
            Arc::new(transport),
            Arc::new(InMemoryContent::new()),
            None,
            ClientOptions::default(),
        ));
        Ok(SemiontSession::new(SemiontSessionConfig {
            kb: options.kb.target(),
            storage: options.storage,
            client,
            token: watch::channel(None).0,
            refresh: None,
            validate: None,
            on_auth_failed: None,
            on_error: Some(options.on_error),
        }))
    }

    fn revoke(&self, _: StoredSession) -> BoxFuture<'static, ()> {
        Box::pin(async {})
    }
}

/// How one row of `signOut` is not what the registry did.
async fn signed_out(cases: &Value, row: &Value) -> Vec<String> {
    let jo = person(cases, "jo");
    let storage = Arc::new(SharedStorage::new());
    let seeded = object(&cases["signOutStorage"], "signOutStorage");
    for (key, value) in seeded {
        storage
            .set(key, value.as_str().expect("a stored value is text"))
            .expect("stored");
    }
    let signed_in = text(row, "signedIn");
    let named = (signed_in == "named").then(|| jo.clone());
    match signed_in.as_str() {
        "named" | "unnamed" => {
            store_session(storage.as_ref(), KB, &sign_in(1, named.as_deref())).expect("stored");
        }
        "none" => {}
        other => panic!("a row is signed in {other}"),
    }
    let open = row["open"].as_bool().expect("open is a boolean");
    // A knowledge base that is not registered has no client to open.
    if open {
        save_knowledge_bases(
            storage.as_ref(),
            &[kb_at(KbEndpoint::LocalEndpoint(LocalEndpoint::new(KB)))],
        )
        .expect("stored");
    }
    let browser = SemiontBrowser::new(SemiontBrowserConfig {
        storage: storage.clone(),
        session_factory: Arc::new(ClosingSessions {
            key: cache_key(KB, &jo, CacheQuery::Resource),
        }),
    })
    .expect("a browser");
    if open {
        live(&browser).await;
    }

    browser.sign_out(KB).await.expect("signed out");

    let removed = match (text(row, "removes").as_str(), &named) {
        ("person", Some(named)) => keys_of(KB, named),
        ("person", None) => panic!("a row removes the person of a sign-in that names nobody"),
        ("nothing", _) => Vec::new(),
        (other, _) => panic!("a row removes {other}"),
    };
    let mut wrong = Vec::new();
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
    browser.close().await.expect("closed");
    wrong
}

#[tokio::test]
async fn sign_out() {
    let cases = table();
    let mut wrong = Vec::new();
    for row in rows(&cases, "signOut") {
        let why = text(row, "why");
        wrong.extend(
            signed_out(&cases, row)
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

    let session = HttpSessionFactory::new(gateway.http.clone())
        .session(SessionFactoryOptions {
            kb: gateway.kb(),
            storage: storage.clone(),
            signals: Arc::new(SessionSignals::new()),
            on_error: Arc::new(|_: SessionError| {}),
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

    session.dispose();
    client.close().await;

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

/// How one row of `crossTab` is not what the registry's client wrote.
///
/// In the table's order: the client is given res-1 and owes its save, the
/// other context writes before that save's wait is over, and the client
/// closes. Nothing is awaited between the value's arrival and the other
/// context's write, so the save cannot be made between them on this
/// runtime's one thread, unless its wait was already over when the value
/// arrived; a save written before the other context wrote fails the row,
/// which was then not run in its order.
async fn across(cases: &Value, row: &Value) -> Vec<String> {
    let jo = person(cases, "jo");
    let gateway = Gateway::start(Who::Names, cases["whoAmI"].clone()).await;
    gateway.let_who_answer();
    let storage = Arc::new(SharedStorage::new());
    let elsewhere = storage.context();
    save_knowledge_bases(storage.as_ref(), &[gateway.kb()]).expect("stored");
    store_session(storage.as_ref(), KB, &sign_in(1, Some(&jo))).expect("stored");
    let browser = SemiontBrowser::new(SemiontBrowserConfig {
        storage: storage.clone(),
        session_factory: Arc::new(HttpSessionFactory::new(gateway.http.clone())),
    })
    .expect("a browser");
    let session = live(&browser).await;
    let kept_for_jo = cache_key(KB, &jo, CacheQuery::Resource);

    let mut res_1 = session.client().browse.resource(&as_id("res-1")).watch();
    let held = next_value(&mut res_1).await;
    let written_before = kept_value(&storage, &kept_for_jo, "res-1");
    match &row["stored"] {
        Value::Null => elsewhere.delete(&session_key(KB)).expect("deleted"),
        stated => store_session(&elsewhere, KB, &sign_in(2, stated["personKey"].as_str()))
            .expect("stored"),
    }
    browser.close().await.expect("closed");

    let Some(held) = held else {
        return vec!["the client was given no value of res-1".to_owned()];
    };
    if let Some(written) = written_before {
        return vec![format!(
            "res-1's save, {written}, was written before the other context wrote: the row was not run in its order"
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
            across(&cases, row)
                .await
                .into_iter()
                .map(|differs| format!("{why}: {differs}")),
        );
    }
    assert!(wrong.is_empty(), "{}", wrong.join("\n"));
}
