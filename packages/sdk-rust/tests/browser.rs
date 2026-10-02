//! The registry of knowledge bases an application holds: the list, the
//! active one and its session, a sign-in landing on the entry for the
//! knowledge base that answered, what is open in each, and what a session's
//! arrival checks.
//!
//! Sessions are built by `ScriptedSessions`, each over a scripted transport:
//! a test says what each knowledge base answers when asked who it is and
//! what of each resource, and reads what was asked. Every wait is bounded.

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use semiont::errors::{SessionErrorCode, TransportError};
use semiont::session::{
    ACTIVE_KEY, Expected, HttpEndpoint, KNOWLEDGE_BASES_KEY, KbEndpoint, KbIdentityConflict,
    KbRead, KbReadVerdict, KbSessionStatus, KnowledgeBase, LAST_VIEWED_RESOURCE_BY_KB_KEY,
    NewKnowledgeBase, OPEN_RESOURCES_BY_KB_KEY, OpenResource, Protocol, SemiontBrowser,
    SemiontBrowserConfig, SemiontSession, SessionNotice, SignedIn, StoredSession,
    save_knowledge_bases, session_key, store_session, stored_session,
};
use semiont::storage::SessionStorage;
use semiont::testing::{FaultyTransport, ScriptedSessions, SharedStorage};
use semiont::transport::{ConnectionState, Transport};
use semiont::types::UserResponse;
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

// ── The knowledge bases behind the factory ──────────────────────────────

/// What a knowledge base says when it is asked who it is.
#[derive(Clone)]
enum Describes {
    As(Value),
    /// It answers that it cannot say.
    Refusing,
}

#[derive(Default)]
struct Behind {
    /// By knowledge base id. One with no entry does not answer at all.
    describes: HashMap<String, Describes>,
    /// Resources the knowledge base says do not exist.
    gone: HashSet<String>,
    /// Resources whose read fails some other way.
    failing: HashSet<String>,
    media_types: HashMap<String, String>,
}

/// Scripted sessions, and what their knowledge bases say of themselves and
/// of each resource.
#[derive(Clone)]
struct Factory {
    sessions: ScriptedSessions,
    behind: Arc<Mutex<Behind>>,
}

fn alice() -> UserResponse {
    serde_json::from_value(json!({
        "did": "did:web:example.org:users:alice", "email": "alice@example.org",
        "name": "Alice", "image": null, "domain": "example.org",
    }))
    .expect("a user")
}

impl Factory {
    fn new() -> Factory {
        let behind: Arc<Mutex<Behind>> = Arc::default();
        let (answering, refusing) = (behind.clone(), behind.clone());
        let sessions = ScriptedSessions::answering(move |kb_id, operation, payload| {
            let behind = answering.lock().expect("behind");
            match operation {
                "browse:kb-requested" => match behind.describes.get(kb_id) {
                    Some(Describes::As(description)) => Ok(Some(description.clone())),
                    _ => Err("the knowledge base does not answer".to_owned()),
                },
                "browse:resource-requested" => {
                    let id = payload["resourceId"].as_str().unwrap_or_default();
                    if behind.failing.contains(id) {
                        return Err(format!("{id} could not be read"));
                    }
                    let representations: Vec<Value> = behind
                        .media_types
                        .get(id)
                        .map(|media_type| json!({ "mediaType": media_type }))
                        .into_iter()
                        .collect();
                    Ok(Some(json!({
                        "resource": {
                            "@context": "https://schema.org", "@id": id,
                            "name": format!("name-{id}"), "representations": representations,
                        },
                        "annotations": [], "entityReferences": [],
                    })))
                }
                other => Err(format!("{other} is not answered here")),
            }
        });
        sessions.refuse_when(move |kb_id, operation, payload| {
            let behind = refusing.lock().expect("behind");
            match operation {
                "browse:kb-requested" => {
                    matches!(behind.describes.get(kb_id), Some(Describes::Refusing))
                        .then(|| json!({ "message": "this knowledge base cannot say what it is" }))
                }
                "browse:resource-requested" => behind
                    .gone
                    .contains(payload["resourceId"].as_str().unwrap_or_default())
                    .then(|| json!({ "code": "not-found", "message": "no such resource" })),
                _ => None,
            }
        });
        sessions.says_who(alice());
        Factory { sessions, behind }
    }

    fn behind(&self) -> std::sync::MutexGuard<'_, Behind> {
        self.behind.lock().expect("behind")
    }

    fn describes(&self, kb_id: &str, description: Value) {
        self.behind()
            .describes
            .insert(kb_id.to_owned(), Describes::As(description));
    }

    /// The transports of the sessions built for a knowledge base, in order.
    fn transports(&self, kb_id: &str) -> Vec<FaultyTransport> {
        self.sessions.transports(kb_id)
    }

    /// The resources a knowledge base's sessions were asked about, in order.
    fn asked_about(&self, kb_id: &str) -> Vec<String> {
        self.transports(kb_id)
            .iter()
            .flat_map(|transport| transport.request_log())
            .filter(|entry| entry.channel == "browse:resource-requested")
            .filter_map(|entry| entry.payload["resourceId"].as_str().map(str::to_owned))
            .collect()
    }

    fn asked_who(&self, kb_id: &str) -> usize {
        self.transports(kb_id)
            .iter()
            .flat_map(|transport| transport.request_log())
            .filter(|entry| entry.channel == "browse:kb-requested")
            .count()
    }
}

// ── Helpers ─────────────────────────────────────────────────────────────

const A: &str = "kb-a";
const B: &str = "kb-b";
const DID_A: &str = "did:web:example.org:kb-a";
const DID_B: &str = "did:web:example.org:kb-b";

fn endpoint(host: &str, port: u16) -> KbEndpoint {
    KbEndpoint::Http(HttpEndpoint {
        host: host.to_owned(),
        port,
        protocol: Protocol::of_host(host),
    })
}

fn kb(id: &str, label: &str, did: &str, at: KbEndpoint) -> KnowledgeBase {
    KnowledgeBase {
        id: id.to_owned(),
        label: label.to_owned(),
        did: did.to_owned(),
        endpoint: at,
        last_read: None,
    }
}

fn kb_a() -> KnowledgeBase {
    kb(A, "KB A", DID_A, endpoint("localhost", 4000))
}

fn kb_b() -> KnowledgeBase {
    kb(B, "KB B", DID_B, endpoint("example.com", 443))
}

fn jwt(expires_in: i64) -> String {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("after the epoch")
        .as_secs() as i64;
    format!(
        "{}.{}.sig",
        URL_SAFE_NO_PAD.encode(r#"{"alg":"none"}"#),
        URL_SAFE_NO_PAD.encode(json!({ "iat": now, "exp": now + expires_in }).to_string())
    )
}

fn tokens(refresh: &str) -> StoredSession {
    StoredSession {
        access: jwt(3600),
        refresh: refresh.to_owned(),
        client_id: "semiont-browser".to_owned(),
        token_endpoint: "https://issuer.test/token".to_owned(),
        revocation_endpoint: Some("https://issuer.test/revoke".to_owned()),
    }
}

/// A storage, a factory, and a browser over them.
struct World {
    storage: Arc<SharedStorage>,
    factory: Factory,
}

impl World {
    fn new() -> World {
        World {
            storage: Arc::new(SharedStorage::new()),
            factory: Factory::new(),
        }
    }

    /// A storage that already holds these knowledge bases, signed in, with
    /// the first of them active.
    fn with(kbs: &[KnowledgeBase]) -> World {
        let world = World::new();
        save_knowledge_bases(world.storage.as_ref(), kbs);
        for kb in kbs {
            store_session(world.storage.as_ref(), &kb.id, &tokens("r"));
        }
        if let Some(first) = kbs.first() {
            world.storage.set(ACTIVE_KEY, &first.id);
        }
        world
    }

    fn browser(&self) -> SemiontBrowser {
        self.browser_over(self.storage.clone())
    }

    fn browser_over(&self, storage: Arc<SharedStorage>) -> SemiontBrowser {
        SemiontBrowser::new(SemiontBrowserConfig {
            storage,
            session_factory: Arc::new(self.factory.sessions.clone()),
        })
    }

    fn stored<T: serde::de::DeserializeOwned + Default>(&self, key: &str) -> T {
        self.storage
            .get(key)
            .map(|stored| serde_json::from_str(&stored).expect("what is stored reads"))
            .unwrap_or_default()
    }

    fn stored_open(&self, kb_id: &str) -> Vec<String> {
        self.stored::<HashMap<String, Vec<OpenResource>>>(OPEN_RESOURCES_BY_KB_KEY)
            .remove(kb_id)
            .unwrap_or_default()
            .into_iter()
            .map(|resource| resource.id)
            .collect()
    }

    fn stored_last_viewed(&self) -> HashMap<String, String> {
        self.stored(LAST_VIEWED_RESOURCE_BY_KB_KEY)
    }
}

async fn settle() {
    tokio::time::sleep(Duration::from_millis(1)).await;
}

/// The browser's live session, once it has one.
async fn live(browser: &SemiontBrowser) -> Arc<SemiontSession> {
    let mut session = browser.active_session();
    let session = tokio::time::timeout(Duration::from_secs(60), session.wait_for(Option::is_some))
        .await
        .expect("a session comes up")
        .expect("the browser lives")
        .clone();
    // Let what its arrival starts run: who it is, and what is open.
    settle().await;
    session.expect("a session")
}

fn session_of(browser: &SemiontBrowser) -> Option<String> {
    browser
        .active_session()
        .borrow()
        .as_ref()
        .map(|session| session.kb().id.clone())
}

fn open(browser: &SemiontBrowser) -> Vec<String> {
    browser
        .open_resources()
        .borrow()
        .iter()
        .map(|resource| resource.id.clone())
        .collect()
}

fn closed(transport: &FaultyTransport) -> bool {
    *transport.state().borrow() == ConnectionState::Closed
}

fn description(name: &str, domain: &str, branch: Option<&str>) -> Value {
    let mut said = json!({ "name": name, "domain": domain });
    if let Some(branch) = branch {
        said["gitBranch"] = json!(branch);
    }
    said
}

// ── The knowledge bases ─────────────────────────────────────────────────

#[tokio::test(start_paused = true)]
async fn a_knowledge_base_that_is_added_is_kept_signed_in_and_made_active() {
    let world = World::new();
    let browser = world.browser();
    assert!(browser.kbs().borrow().is_empty());
    assert_eq!(*browser.active_kb_id().borrow(), None);

    let read = KbRead {
        at: UNIX_EPOCH + Duration::from_millis(1_800_000_000_000),
        git_branch: Some("main".to_owned()),
    };
    let added = browser
        .add_kb(
            NewKnowledgeBase {
                label: "KB A".to_owned(),
                did: DID_A.to_owned(),
                endpoint: endpoint("localhost", 4000),
                last_read: Some(read.clone()),
            },
            &tokens("r"),
        )
        .await;

    assert_eq!(*browser.kbs().borrow(), std::slice::from_ref(&added));
    assert_eq!(*browser.active_kb_id().borrow(), Some(added.id.clone()));
    assert_eq!(session_of(&browser), Some(added.id.clone()));
    assert_eq!(world.storage.get(ACTIVE_KEY), Some(added.id.clone()));
    assert!(stored_session(world.storage.as_ref(), &added.id).is_some());

    // Its identity and what it last said survive a new browser on the storage.
    browser.close().await;
    let reopened = world.browser();
    assert_eq!(*reopened.kbs().borrow(), std::slice::from_ref(&added));
    assert_eq!(reopened.kbs().borrow()[0].did, DID_A);
    assert_eq!(reopened.kbs().borrow()[0].last_read, Some(read));
    assert_eq!(live(&reopened).await.kb().id, added.id);
}

#[tokio::test(start_paused = true)]
async fn an_entry_that_is_not_a_knowledge_base_with_a_did_is_dropped_from_the_storage_too() {
    let world = World::new();
    world.storage.set(
        KNOWLEDGE_BASES_KEY,
        &json!([
            { "id": "old", "label": "No did", "endpoint": { "kind": "http", "host": "localhost", "port": 4000, "protocol": "http" } },
            { "id": A, "label": "KB A", "did": DID_A, "email": "someone@example.org",
              "endpoint": { "kind": "http", "host": "localhost", "port": 4000, "protocol": "http" } },
            "not an entry",
        ])
        .to_string(),
    );
    world.storage.set(ACTIVE_KEY, "old");
    let browser = world.browser();

    assert_eq!(*browser.kbs().borrow(), [kb_a()]);
    // The active one was the one dropped: the first that is left takes over.
    assert_eq!(browser.active_kb_id().borrow().as_deref(), Some(A));
    // What is written back is what was read, and nothing else an entry carried.
    assert_eq!(
        world.stored::<Value>(KNOWLEDGE_BASES_KEY),
        json!([{ "id": A, "label": "KB A", "did": DID_A,
                 "endpoint": { "kind": "http", "host": "localhost", "port": 4000, "protocol": "http" } }])
    );
}

#[tokio::test(start_paused = true)]
async fn removing_a_knowledge_base_forgets_it_and_the_next_one_takes_over() {
    let world = World::with(&[kb_a(), kb_b()]);
    let browser = world.browser();
    live(&browser).await;
    browser.add_open_resource("res-1", "One", None, None);
    browser.set_last_viewed_resource("res-1");
    assert_eq!(world.stored_open(A), ["res-1"]);

    browser.remove_kb(A).await;
    assert_eq!(*browser.kbs().borrow(), [kb_b()]);
    assert_eq!(session_of(&browser).as_deref(), Some(B));
    assert!(stored_session(world.storage.as_ref(), A).is_none());
    assert!(world.stored_open(A).is_empty());
    assert!(!world.stored_last_viewed().contains_key(A));
    assert!(closed(&world.factory.transports(A)[0]));

    browser.remove_kb(B).await;
    assert!(browser.kbs().borrow().is_empty());
    assert_eq!(*browser.active_kb_id().borrow(), None);
    assert_eq!(session_of(&browser), None);
    assert_eq!(world.storage.get(ACTIVE_KEY), None);
}

#[tokio::test(start_paused = true)]
async fn an_entry_takes_what_its_knowledge_base_last_said_and_keeps_its_did() {
    let world = World::with(&[kb_a(), kb_b()]);
    let browser = world.browser();
    let read = KbRead {
        at: SystemTime::now(),
        git_branch: None,
    };

    browser.update_kb(B, Some("Renamed"), Some(read.clone()));

    let kbs = browser.kbs().borrow().clone();
    assert_eq!(kbs[0], kb_a());
    assert_eq!(
        (kbs[1].label.as_str(), kbs[1].did.as_str()),
        ("Renamed", DID_B)
    );
    assert_eq!(
        kbs[1].last_read.as_ref().map(|r| &r.git_branch),
        Some(&None)
    );
    assert_eq!(world.stored::<Vec<KnowledgeBase>>(KNOWLEDGE_BASES_KEY), kbs);
}

#[tokio::test(start_paused = true)]
async fn a_stored_credential_says_whether_it_is_good_expired_or_not_there() {
    let world = World::with(&[kb_a(), kb_b()]);
    store_session(
        world.storage.as_ref(),
        B,
        &StoredSession {
            access: jwt(-60),
            ..tokens("r")
        },
    );
    let browser = world.browser();

    assert_eq!(browser.kb_session_status(A), KbSessionStatus::Authenticated);
    assert_eq!(browser.kb_session_status(B), KbSessionStatus::Expired);
    assert_eq!(
        browser.kb_session_status("another"),
        KbSessionStatus::SignedOut
    );
}

#[tokio::test(start_paused = true)]
async fn the_identity_token_is_what_it_was_last_set_to() {
    let browser = World::new().browser();
    assert_eq!(*browser.identity_token().borrow(), None);
    browser.set_identity_token(Some("an-identity-token"));
    assert_eq!(
        browser.identity_token().borrow().as_deref(),
        Some("an-identity-token")
    );
    browser.set_identity_token(None);
    assert_eq!(*browser.identity_token().borrow(), None);
}

// ── The active session ──────────────────────────────────────────────────

#[tokio::test(start_paused = true)]
async fn making_another_knowledge_base_active_shows_no_session_and_then_the_new_one() {
    let world = World::with(&[kb_a(), kb_b()]);
    let browser = world.browser();
    let first = live(&browser).await;

    let seen: Arc<Mutex<Vec<Option<String>>>> = Arc::default();
    let (recording, mut session) = (seen.clone(), browser.active_session());
    let watching = tokio::spawn(async move {
        loop {
            let now = session
                .borrow_and_update()
                .as_ref()
                .map(|s| s.kb().id.clone());
            recording.lock().expect("seen").push(now);
            if session.changed().await.is_err() {
                return;
            }
        }
    });
    settle().await;

    browser.set_active_kb(Some(B)).await;
    settle().await;

    assert_eq!(
        *seen.lock().expect("seen"),
        [Some(A.to_owned()), None, Some(B.to_owned())]
    );
    assert_eq!(world.storage.get(ACTIVE_KEY).as_deref(), Some(B));
    // The session it replaced is closed, and its client with it.
    assert!(closed(&world.factory.transports(A)[0]));
    assert!(first.client().bus().destroyed());
    assert!(!closed(&world.factory.transports(B)[0]));
    watching.abort();
}

#[tokio::test(start_paused = true)]
async fn making_none_active_closes_the_session_and_leaves_none() {
    let world = World::with(&[kb_a()]);
    let browser = world.browser();
    live(&browser).await;

    browser.set_active_kb(None).await;

    assert_eq!(session_of(&browser), None);
    assert_eq!(*browser.active_kb_id().borrow(), None);
    assert!(browser.active_signals().borrow().is_none());
    assert!(!*browser.session_activating().borrow());
    assert!(closed(&world.factory.transports(A)[0]));
    assert_eq!(world.storage.get(ACTIVE_KEY), None);
}

#[tokio::test(start_paused = true)]
async fn making_the_active_one_active_again_changes_nothing() {
    let world = World::with(&[kb_a()]);
    let browser = world.browser();
    let session = live(&browser).await;

    browser.set_active_kb(Some(A)).await;

    assert_eq!(live(&browser).await.id(), session.id());
    assert_eq!(world.factory.transports(A).len(), 1);
}

#[tokio::test(start_paused = true)]
async fn of_two_activations_asked_for_together_the_last_one_asked_for_stands() {
    let world = World::with(&[kb_a(), kb_b()]);
    let browser = world.browser();
    live(&browser).await;

    tokio::join!(
        browser.set_active_kb(Some(B)),
        browser.set_active_kb(Some(A)),
        browser.set_active_kb(Some(B)),
    );

    assert_eq!(session_of(&browser).as_deref(), Some(B));
    assert_eq!(browser.active_kb_id().borrow().as_deref(), Some(B));
    assert!(!*browser.session_activating().borrow());
    // Every session but the one that stands is closed.
    let built: Vec<FaultyTransport> = [A, B]
        .iter()
        .flat_map(|kb| world.factory.transports(kb))
        .collect();
    assert_eq!(
        built.iter().filter(|transport| !closed(transport)).count(),
        1
    );
}

#[tokio::test(start_paused = true)]
async fn an_activation_overtaken_while_it_waited_its_turn_builds_no_session() {
    let world = World::with(&[kb_a(), kb_b()]);
    let browser = world.browser();
    live(&browser).await;
    // The first activation holds the turn while its session comes up, and
    // the other two are asked for behind it.
    world.factory.sessions.answers_after(Duration::from_secs(2));

    tokio::join!(
        browser.set_active_kb(Some(B)),
        browser.set_active_kb(Some(A)),
        browser.set_active_kb(Some(B)),
    );

    assert_eq!(session_of(&browser).as_deref(), Some(B));
    // A had the session it started with, and no other was built for it.
    assert_eq!(world.factory.transports(A).len(), 1);
}

#[tokio::test(start_paused = true)]
async fn a_session_that_comes_up_after_its_knowledge_base_stopped_being_active_is_never_shown() {
    let world = World::with(&[kb_a(), kb_b()]);
    let browser = Arc::new(world.browser());
    live(&browser).await;
    world.factory.sessions.answers_after(Duration::from_secs(2));

    // Every session shown: the knowledge base that was active then, and
    // the session's own.
    type Shown = Vec<(Option<String>, String)>;
    let shown: Arc<Mutex<Shown>> = Arc::default();
    let (recording, watched) = (shown.clone(), browser.clone());
    let mut session = browser.active_session();
    let watching = tokio::spawn(async move {
        while session.changed().await.is_ok() {
            let live = session
                .borrow_and_update()
                .as_ref()
                .map(|session| session.kb().id.clone());
            if let Some(live) = live {
                let active = watched.active_kb_id().borrow().clone();
                recording.lock().expect("shown").push((active, live));
            }
        }
    });

    let (to_b, to_a) = (browser.clone(), browser.clone());
    let overtaken = tokio::spawn(async move { to_b.set_active_kb(Some(B)).await });
    // B's session is still coming up when A is asked for again.
    settle().await;
    let standing = tokio::spawn(async move { to_a.set_active_kb(Some(A)).await });
    overtaken.await.expect("the first activation ends");
    standing.await.expect("the second activation ends");
    settle().await;

    assert_eq!(
        *shown.lock().expect("shown"),
        [(Some(A.to_owned()), A.to_owned())]
    );
    // The session that came up too late was closed, and not left running.
    assert!(closed(&world.factory.transports(B)[0]));
    watching.abort();
}

#[tokio::test(start_paused = true)]
async fn a_session_being_brought_up_is_said_to_be_on_its_way() {
    let world = World::with(&[kb_a()]);
    // A session that takes a moment to come up: one that is up at once is
    // up before anyone could be told it was coming.
    world.factory.sessions.answers_after(Duration::from_secs(2));
    let browser = world.browser();
    let mut activating = browser.session_activating();

    tokio::time::timeout(Duration::from_secs(60), activating.wait_for(|on| *on))
        .await
        .expect("it is said to be activating")
        .expect("the browser lives");
    assert_eq!(session_of(&browser), None);

    live(&browser).await;
    assert!(!*browser.session_activating().borrow());
}

#[tokio::test(start_paused = true)]
async fn a_session_that_cannot_be_built_is_said_and_there_is_none() {
    let world = World::with(&[kb_a()]);
    world
        .factory
        .sessions
        .refuse_to_build(Some("this factory builds nothing"));
    let browser = world.browser();
    let mut errors = browser.errors();

    let refused = tokio::time::timeout(Duration::from_secs(60), errors.next())
        .await
        .expect("the failure is said")
        .expect("the browser lives")
        .expect("no failure was missed");
    settle().await;

    assert_eq!(refused.code, SessionErrorCode::ConstructFailed);
    assert_eq!(refused.kb_id.as_deref(), Some(A));
    assert_eq!(session_of(&browser), None);
    assert!(browser.active_signals().borrow().is_none());
    assert!(!*browser.session_activating().borrow());
}

#[tokio::test(start_paused = true)]
async fn what_a_host_shows_about_a_session_is_there_exactly_when_the_session_is() {
    let world = World::with(&[kb_a()]);
    let browser = world.browser();
    assert!(browser.active_signals().borrow().is_none());

    live(&browser).await;
    let first = browser.active_signals().borrow().clone().expect("signals");
    assert_eq!(*first.session_expired().borrow(), None);

    // A sign-in on the active knowledge base replaces both together.
    browser.sign_in(A, &tokens("r2")).await;
    live(&browser).await;
    let second = browser.active_signals().borrow().clone().expect("signals");
    assert!(!Arc::ptr_eq(&first, &second));
    assert!(first.session_expired().has_changed().is_err());

    browser.sign_out(A).await;
    assert!(browser.active_signals().borrow().is_none());
    assert_eq!(session_of(&browser), None);
}

// ── Signing in ──────────────────────────────────────────────────────────

fn signed_in(at: KbEndpoint, description: Value, refresh: &str) -> SignedIn {
    SignedIn {
        endpoint: at,
        description: serde_json::from_value(description).expect("a description"),
        session: tokens(refresh),
        kb_id: None,
        expected_did: None,
        expected_name: None,
    }
}

#[tokio::test(start_paused = true)]
async fn new_tokens_for_the_active_knowledge_base_replace_its_session() {
    let world = World::with(&[kb_a()]);
    let browser = world.browser();
    let first = live(&browser).await;

    browser.sign_in(A, &tokens("renewed")).await;
    let second = live(&browser).await;

    assert_ne!(first.id(), second.id());
    assert!(closed(&world.factory.transports(A)[0]));
    assert_eq!(
        stored_session(world.storage.as_ref(), A).map(|stored| stored.refresh),
        Some("renewed".to_owned())
    );
}

#[tokio::test(start_paused = true)]
async fn a_sign_in_at_a_new_address_registers_the_knowledge_base_under_what_it_says_it_is() {
    let world = World::new();
    let browser = world.browser();

    let outcome = browser
        .signed_in(signed_in(
            endpoint("localhost", 4000),
            description("KB A", "example.org:kb-a", Some("main")),
            "r",
        ))
        .await;

    assert_eq!(outcome.expected, None);
    assert_eq!(
        (outcome.kb.did.as_str(), outcome.kb.label.as_str()),
        (DID_A, "KB A")
    );
    assert_eq!(
        outcome
            .kb
            .last_read
            .as_ref()
            .and_then(|read| read.git_branch.as_deref()),
        Some("main")
    );
    assert_eq!(*browser.kbs().borrow(), std::slice::from_ref(&outcome.kb));
    assert_eq!(session_of(&browser), Some(outcome.kb.id.clone()));
    assert_eq!(
        stored_session(world.storage.as_ref(), &outcome.kb.id).map(|stored| stored.refresh),
        Some("r".to_owned())
    );
}

#[tokio::test(start_paused = true)]
async fn a_sign_in_reports_what_the_person_believed_they_clicked() {
    let browser = World::new().browser();

    let outcome = browser
        .signed_in(SignedIn {
            expected_did: Some(DID_B.to_owned()),
            expected_name: Some("KB B".to_owned()),
            ..signed_in(
                endpoint("localhost", 4000),
                description("KB A", "example.org:kb-a", None),
                "r",
            )
        })
        .await;

    // The knowledge base that answered is the one registered. What was
    // believed is said back, for a host to set against it.
    assert_eq!(outcome.kb.did, DID_A);
    assert_eq!(
        outcome.expected,
        Some(Expected {
            did: DID_B.to_owned(),
            name: Some("KB B".to_owned())
        })
    );
}

#[tokio::test(start_paused = true)]
async fn a_sign_in_to_a_registered_knowledge_base_takes_what_it_and_the_issuer_now_say() {
    for by_id in [true, false] {
        let world = World::with(&[kb_a()]);
        let browser = world.browser();
        let first = live(&browser).await;

        let outcome = browser
            .signed_in(SignedIn {
                kb_id: by_id.then(|| A.to_owned()),
                ..signed_in(
                    endpoint("localhost", 4000),
                    description("KB A, renamed", "example.org:kb-a", Some("feature")),
                    "r2",
                )
            })
            .await;

        // The same entry, under the name it gives itself now.
        assert_eq!(outcome.kb.id, A);
        assert_eq!(outcome.kb.label, "KB A, renamed");
        assert_eq!(browser.kbs().borrow().len(), 1);
        assert_eq!(*browser.kbs().borrow(), std::slice::from_ref(&outcome.kb));
        // What was believed is the entry as it was, under the label it had.
        assert_eq!(
            outcome.expected,
            Some(Expected {
                did: DID_A.to_owned(),
                name: Some("KB A".to_owned())
            })
        );
        assert_eq!(
            stored_session(world.storage.as_ref(), A).map(|stored| stored.refresh),
            Some("r2".to_owned())
        );
        assert_ne!(live(&browser).await.id(), first.id());
    }
}

#[tokio::test(start_paused = true)]
async fn a_sign_in_a_different_knowledge_base_answers_leaves_the_entry_and_lands_on_a_new_one() {
    let believed = KnowledgeBase {
        last_read: Some(KbRead {
            at: UNIX_EPOCH + Duration::from_millis(1_800_000_000_000),
            git_branch: Some("main".to_owned()),
        }),
        ..kb_a()
    };
    let world = World::with(std::slice::from_ref(&believed));
    let before = stored_session(world.storage.as_ref(), A);
    let browser = world.browser();
    live(&browser).await;

    let outcome = browser
        .signed_in(SignedIn {
            kb_id: Some(A.to_owned()),
            ..signed_in(
                endpoint("localhost", 4000),
                description("KB B", "example.org:kb-b", Some("other")),
                "for-b",
            )
        })
        .await;

    // The entry the person believed they were signing in to is as it was:
    // its did, its name, what it last said, and its credentials.
    let kbs = browser.kbs().borrow().clone();
    assert_eq!(kbs[0], believed);
    assert_eq!(stored_session(world.storage.as_ref(), A), before);
    // The knowledge base that answered has an entry of its own, at the same
    // address, and it is the one signed in and active.
    assert_eq!(kbs.len(), 2);
    assert_eq!(kbs[1], outcome.kb);
    assert_eq!(
        (outcome.kb.did.as_str(), outcome.kb.label.as_str()),
        (DID_B, "KB B")
    );
    assert_eq!(outcome.kb.endpoint, believed.endpoint);
    assert_ne!(outcome.kb.id, A);
    assert_eq!(session_of(&browser), Some(outcome.kb.id.clone()));
    assert_eq!(
        stored_session(world.storage.as_ref(), &outcome.kb.id).map(|stored| stored.refresh),
        Some("for-b".to_owned())
    );
    assert_eq!(
        outcome.expected,
        Some(Expected {
            did: DID_A.to_owned(),
            name: Some("KB A".to_owned())
        })
    );
}

#[tokio::test(start_paused = true)]
async fn of_two_entries_at_one_address_a_sign_in_lands_on_the_one_whose_did_answered() {
    let twin = kb("kb-a2", "KB B here", DID_B, endpoint("localhost", 4000));
    let world = World::with(&[kb_a(), twin.clone()]);
    let browser = world.browser();
    live(&browser).await;

    let outcome = browser
        .signed_in(signed_in(
            endpoint("localhost", 4000),
            description("KB B", "example.org:kb-b", None),
            "for-b",
        ))
        .await;

    assert_eq!(outcome.kb.id, twin.id);
    assert_eq!(browser.kbs().borrow().len(), 2);
    assert_eq!(browser.kbs().borrow()[0], kb_a());
    assert_eq!(session_of(&browser).as_deref(), Some("kb-a2"));
    // An address with two entries singles out no belief.
    assert_eq!(outcome.expected, None);
}

#[tokio::test(start_paused = true)]
async fn an_entry_at_another_address_with_the_same_did_is_not_the_one_signed_in() {
    // One knowledge base in two places is two entries.
    let world = World::with(&[kb_a()]);
    let browser = world.browser();
    live(&browser).await;

    let outcome = browser
        .signed_in(signed_in(
            endpoint("localhost", 4100),
            description("KB A", "example.org:kb-a", None),
            "r",
        ))
        .await;

    assert_ne!(outcome.kb.id, A);
    assert_eq!(outcome.kb.did, DID_A);
    assert_eq!(browser.kbs().borrow().len(), 2);
    assert_eq!(outcome.expected, None);
}

#[tokio::test(start_paused = true)]
async fn signing_out_forgets_the_tokens_closes_the_session_and_has_the_issuer_told() {
    let world = World::with(&[kb_a()]);
    let before = stored_session(world.storage.as_ref(), A).expect("a stored session");
    let browser = world.browser();
    live(&browser).await;
    let mut kbs = browser.kbs();
    kbs.borrow_and_update();

    browser.sign_out(A).await;
    settle().await;

    assert!(stored_session(world.storage.as_ref(), A).is_none());
    assert_eq!(session_of(&browser), None);
    assert!(closed(&world.factory.transports(A)[0]));
    assert_eq!(world.factory.sessions.revoked(), [before]);
    // Still registered, and still the active one: only signed out.
    assert_eq!(*browser.kbs().borrow(), [kb_a()]);
    assert_eq!(browser.active_kb_id().borrow().as_deref(), Some(A));
    // The list is said again, so whoever shows its status reads it anew.
    assert!(kbs.has_changed().expect("the browser lives"));
    assert_eq!(browser.kb_session_status(A), KbSessionStatus::SignedOut);

    // Signing out of what is not signed in tells the issuer nothing.
    browser.sign_out(A).await;
    settle().await;
    assert_eq!(world.factory.sessions.revoked().len(), 1);
}

// ── What is open ────────────────────────────────────────────────────────

#[tokio::test(start_paused = true)]
async fn resources_are_opened_renamed_closed_and_moved_in_the_active_knowledge_base() {
    let world = World::with(&[kb_a()]);
    let browser = world.browser();
    live(&browser).await;

    browser.add_open_resource("r1", "One", Some("text/plain"), None);
    browser.add_open_resource("r2", "Two", None, Some("file://two.md"));
    browser.add_open_resource("r3", "Three", None, None);
    assert_eq!(open(&browser), ["r1", "r2", "r3"]);

    // Opening what is open already takes what is stated of it, in place.
    browser.add_open_resource("r1", "One, renamed", None, None);
    browser.update_open_resource_name("r2", "Two, renamed");
    let shown = browser.open_resources().borrow().clone();
    assert_eq!(open(&browser), ["r1", "r2", "r3"]);
    assert_eq!(shown[0].name, "One, renamed");
    assert_eq!(shown[0].media_type.as_deref(), Some("text/plain"));
    assert_eq!(shown[1].name, "Two, renamed");
    assert_eq!(shown[1].storage_uri.as_deref(), Some("file://two.md"));

    browser.reorder_open_resources(0, 2);
    assert_eq!(open(&browser), ["r2", "r3", "r1"]);
    // A place that is not in the list moves nothing.
    browser.reorder_open_resources(0, 3);
    browser.reorder_open_resources(7, 0);
    assert_eq!(open(&browser), ["r2", "r3", "r1"]);

    browser.remove_open_resource("r3");
    assert_eq!(open(&browser), ["r2", "r1"]);
    assert_eq!(world.stored_open(A).len(), 2);
}

#[tokio::test(start_paused = true)]
async fn a_resource_opened_after_a_removal_does_not_take_a_place_that_is_taken() {
    let world = World::with(&[kb_a()]);
    let browser = world.browser();
    live(&browser).await;
    for id in ["r1", "r2", "r3"] {
        browser.add_open_resource(id, id, None, None);
    }

    browser.remove_open_resource("r2");
    browser.add_open_resource("r4", "r4", None, None);

    let places: Vec<u64> = browser
        .open_resources()
        .borrow()
        .iter()
        .map(|resource| resource.order)
        .collect();
    assert_eq!(open(&browser), ["r1", "r3", "r4"]);
    assert_eq!(places, [0, 2, 3]);
}

#[tokio::test(start_paused = true)]
async fn nothing_is_open_or_opened_or_viewed_without_a_live_session() {
    let world = World::with(&[kb_a()]);
    world.storage.set(
        OPEN_RESOURCES_BY_KB_KEY,
        &json!({ A: [{ "id": "r1", "name": "One", "openedAt": 1, "order": 0 }] }).to_string(),
    );
    world.storage.set(
        LAST_VIEWED_RESOURCE_BY_KB_KEY,
        &json!({ A: "r1" }).to_string(),
    );
    let browser = world.browser();
    live(&browser).await;
    assert_eq!(open(&browser), ["r1"]);
    assert_eq!(
        browser.last_viewed_resource().borrow().as_deref(),
        Some("r1")
    );

    browser.sign_out(A).await;
    assert!(open(&browser).is_empty());
    assert_eq!(*browser.last_viewed_resource().borrow(), None);
    browser.add_open_resource("r2", "Two", None, None);
    browser.set_last_viewed_resource("r2");
    browser.remove_open_resource("r1");
    // Hidden, not forgotten: the storage holds what it held.
    assert_eq!(world.stored_open(A), ["r1"]);
    assert_eq!(
        world.stored_last_viewed().get(A).map(String::as_str),
        Some("r1")
    );

    browser.sign_in(A, &tokens("r")).await;
    live(&browser).await;
    assert_eq!(open(&browser), ["r1"]);
    assert_eq!(
        browser.last_viewed_resource().borrow().as_deref(),
        Some("r1")
    );
}

#[tokio::test(start_paused = true)]
async fn each_knowledge_base_keeps_what_is_open_in_it_and_where_the_person_was() {
    let world = World::with(&[kb_a(), kb_b()]);
    let browser = world.browser();
    live(&browser).await;
    browser.add_open_resource("in-a", "In A", None, None);
    browser.set_last_viewed_resource("in-a");

    browser.set_active_kb(Some(B)).await;
    live(&browser).await;
    assert!(open(&browser).is_empty());
    assert_eq!(*browser.last_viewed_resource().borrow(), None);
    browser.add_open_resource("in-b", "In B", None, None);
    browser.set_last_viewed_resource("in-b");

    browser.set_active_kb(Some(A)).await;
    live(&browser).await;
    assert_eq!(open(&browser), ["in-a"]);
    assert_eq!(
        browser.last_viewed_resource().borrow().as_deref(),
        Some("in-a")
    );
    assert_eq!(world.stored_open(B), ["in-b"]);
    assert_eq!(
        world.stored_last_viewed(),
        HashMap::from([
            (A.to_owned(), "in-a".to_owned()),
            (B.to_owned(), "in-b".to_owned())
        ])
    );
}

#[tokio::test(start_paused = true)]
async fn what_another_context_opens_or_views_is_shown_and_neither_loses_the_others() {
    let world = World::with(&[kb_a()]);
    let here = world.browser();
    let there = world.browser_over(Arc::new(world.storage.context()));
    live(&here).await;
    live(&there).await;

    here.add_open_resource("from-here", "Here", None, None);
    there.add_open_resource("from-there", "There", None, None);
    there.set_last_viewed_resource("from-there");

    // Each wrote against what the storage held, so both are there, in both.
    assert_eq!(world.stored_open(A), ["from-here", "from-there"]);
    assert_eq!(open(&here), ["from-here", "from-there"]);
    assert_eq!(open(&there), ["from-here", "from-there"]);
    assert_eq!(
        here.last_viewed_resource().borrow().as_deref(),
        Some("from-there")
    );
}

#[tokio::test(start_paused = true)]
async fn a_change_to_what_is_open_is_made_against_what_the_storage_holds() {
    let world = World::with(&[kb_a()]);
    let browser = world.browser();
    live(&browser).await;
    browser.add_open_resource("mine", "Mine", None, None);

    // Written to the storage with nobody told: what the browser has in
    // memory is behind, and what it writes next must not put it back.
    world.storage.set(
        OPEN_RESOURCES_BY_KB_KEY,
        &json!({ A: [
            { "id": "mine", "name": "Mine", "openedAt": 1, "order": 0 },
            { "id": "theirs", "name": "Theirs", "openedAt": 2, "order": 1 },
        ] })
        .to_string(),
    );
    world.storage.set(
        LAST_VIEWED_RESOURCE_BY_KB_KEY,
        &json!({ B: "in-b" }).to_string(),
    );
    browser.add_open_resource("another", "Another", None, None);
    browser.set_last_viewed_resource("mine");

    assert_eq!(world.stored_open(A), ["mine", "theirs", "another"]);
    assert_eq!(open(&browser), ["mine", "theirs", "another"]);
    assert_eq!(
        world.stored_last_viewed(),
        HashMap::from([
            (A.to_owned(), "mine".to_owned()),
            (B.to_owned(), "in-b".to_owned())
        ])
    );
}

// ── What a session's arrival checks ─────────────────────────────────────

fn opened(world: &World, kb_id: &str, ids: &[&str]) {
    let mut by_kb: HashMap<String, Vec<Value>> = world.stored(OPEN_RESOURCES_BY_KB_KEY);
    by_kb.insert(
        kb_id.to_owned(),
        ids.iter()
            .enumerate()
            .map(|(place, id)| json!({ "id": id, "name": format!("stale-{id}"), "openedAt": place, "order": place }))
            .collect(),
    );
    world
        .storage
        .set(OPEN_RESOURCES_BY_KB_KEY, &json!(by_kb).to_string());
}

#[tokio::test(start_paused = true)]
async fn only_a_resource_the_knowledge_base_says_is_gone_is_closed() {
    let world = World::with(&[kb_a()]);
    opened(&world, A, &["kept", "gone", "unreadable"]);
    {
        let mut behind = world.factory.behind();
        behind.gone.insert("gone".to_owned());
        behind.failing.insert("unreadable".to_owned());
        behind
            .media_types
            .insert("kept".to_owned(), "application/pdf".to_owned());
    }
    let browser = world.browser();
    live(&browser).await;

    assert_eq!(open(&browser), ["kept", "unreadable"]);
    assert_eq!(world.stored_open(A), ["kept", "unreadable"]);
    let shown = browser.open_resources().borrow().clone();
    // What was found is shown under the name and type it has now.
    assert_eq!(shown[0].name, "name-kept");
    assert_eq!(shown[0].media_type.as_deref(), Some("application/pdf"));
    // What could not be read is left exactly as it was.
    assert_eq!(shown[1].name, "stale-unreadable");
}

#[tokio::test(start_paused = true)]
async fn what_is_open_is_checked_once_per_session_and_again_for_the_next() {
    let world = World::with(&[kb_a(), kb_b()]);
    opened(&world, A, &["a1", "a2", "a3", "a4", "a5", "a6"]);
    opened(&world, B, &["b1"]);
    let browser = world.browser();
    live(&browser).await;
    assert_eq!(world.factory.asked_about(A).len(), 6);

    // Changing what is open shows the list again, and checks nothing.
    browser.add_open_resource("a7", "Seven", None, None);
    browser.reorder_open_resources(0, 1);
    settle().await;
    assert_eq!(world.factory.asked_about(A).len(), 6);

    browser.set_active_kb(Some(B)).await;
    live(&browser).await;
    assert_eq!(world.factory.asked_about(B), ["b1"]);
}

#[tokio::test(start_paused = true)]
async fn a_resource_another_context_opened_while_the_checks_ran_is_left_open() {
    let world = World::with(&[kb_a()]);
    opened(&world, A, &["gone"]);
    world.factory.behind().gone.insert("gone".to_owned());
    let elsewhere = world.storage.context();
    let browser = world.browser();
    // Before the session is up: the other context opens one more.
    let mut by_kb: HashMap<String, Vec<Value>> = world.stored(OPEN_RESOURCES_BY_KB_KEY);
    by_kb
        .entry(A.to_owned())
        .or_default()
        .push(json!({ "id": "sibling", "name": "Sibling", "openedAt": 9, "order": 9 }));
    elsewhere.set(OPEN_RESOURCES_BY_KB_KEY, &json!(by_kb).to_string());

    live(&browser).await;

    assert_eq!(open(&browser), ["sibling"]);
    assert_eq!(world.stored_open(A), ["sibling"]);
}

fn conflict(browser: &SemiontBrowser) -> Option<KbIdentityConflict> {
    let signals = browser.active_signals().borrow().clone()?;
    signals.kb_identity_conflict().borrow().clone()
}

#[tokio::test(start_paused = true)]
async fn a_different_knowledge_base_answering_voids_what_was_open_and_is_raised() {
    let world = World::with(&[kb_a(), kb_b()]);
    opened(&world, A, &["a1", "a2"]);
    opened(&world, B, &["b1"]);
    world.storage.set(
        LAST_VIEWED_RESOURCE_BY_KB_KEY,
        &json!({ A: "a1", B: "b1" }).to_string(),
    );
    world
        .factory
        .describes(A, description("KB B", "example.org:kb-b", Some("main")));
    let browser = world.browser();
    live(&browser).await;

    assert!(open(&browser).is_empty());
    assert!(world.stored_open(A).is_empty());
    assert_eq!(*browser.last_viewed_resource().borrow(), None);
    // Only the active one's: the other keeps both.
    assert_eq!(world.stored_open(B), ["b1"]);
    assert_eq!(
        world.stored_last_viewed(),
        HashMap::from([(B.to_owned(), "b1".to_owned())])
    );
    assert_eq!(
        conflict(&browser),
        Some(KbIdentityConflict {
            expected_did: DID_A.to_owned(),
            observed_did: DID_B.to_owned(),
        })
    );
    // The entry is as it was written: nothing of the other is put on it.
    assert_eq!(browser.kbs().borrow()[0], kb_a());
    // And no resource was asked about: those answers would be the wrong one's.
    assert!(world.factory.asked_about(A).is_empty());
}

#[tokio::test(start_paused = true)]
async fn the_knowledge_base_answering_as_itself_changes_nothing_and_is_recorded() {
    let world = World::with(&[kb_a()]);
    opened(&world, A, &["a1"]);
    world.factory.describes(
        A,
        description("KB A, as it says", "example.org:kb-a", Some("main")),
    );
    let browser = world.browser();
    live(&browser).await;

    assert_eq!(open(&browser), ["a1"]);
    assert_eq!(conflict(&browser), None);
    let entry = browser.kbs().borrow()[0].clone();
    assert_eq!(entry.label, "KB A, as it says");
    assert_eq!(
        entry
            .last_read
            .as_ref()
            .and_then(|read| read.git_branch.as_deref()),
        Some("main")
    );

    // And a new browser on the storage reads what was recorded.
    browser.close().await;
    assert_eq!(world.browser().kbs().borrow()[0], entry);
}

#[tokio::test(start_paused = true)]
async fn no_answer_and_a_refusal_to_say_are_no_verdict_and_void_nothing() {
    for says in [None, Some(Describes::Refusing)] {
        let world = World::with(&[kb_a()]);
        opened(&world, A, &["a1"]);
        if let Some(says) = says {
            world.factory.behind().describes.insert(A.to_owned(), says);
        }
        let browser = world.browser();
        live(&browser).await;

        assert_eq!(open(&browser), ["a1"]);
        assert_eq!(conflict(&browser), None);
        assert_eq!(browser.kbs().borrow()[0], kb_a());
        // The resources were checked all the same.
        assert_eq!(world.factory.asked_about(A), ["a1"]);
        assert_eq!(browser.read_active_kb().await, KbReadVerdict::NoVerdict);
    }
}

#[tokio::test(start_paused = true)]
async fn asking_the_active_knowledge_base_again_records_what_it_says_now() {
    let world = World::with(&[kb_a()]);
    world
        .factory
        .describes(A, description("KB A", "example.org:kb-a", Some("main")));
    let browser = world.browser();
    live(&browser).await;
    let asked = world.factory.asked_who(A);

    world
        .factory
        .describes(A, description("KB A", "example.org:kb-a", None));
    assert_eq!(browser.read_active_kb().await, KbReadVerdict::Recorded);

    assert_eq!(world.factory.asked_who(A), asked + 1);
    // A tree that is on no branch is recorded as on none.
    let read = browser.kbs().borrow()[0].last_read.clone().expect("a read");
    assert_eq!(read.git_branch, None);
}

#[tokio::test(start_paused = true)]
async fn asking_again_reports_a_different_knowledge_base_and_acts_on_nothing() {
    let world = World::with(&[kb_a()]);
    opened(&world, A, &["a1"]);
    world
        .factory
        .describes(A, description("KB A", "example.org:kb-a", None));
    let browser = world.browser();
    live(&browser).await;
    browser.set_last_viewed_resource("a1");

    world
        .factory
        .describes(A, description("KB B", "example.org:kb-b", None));
    let verdict = browser.read_active_kb().await;

    assert_eq!(
        verdict,
        KbReadVerdict::Conflict {
            observed_did: DID_B.to_owned(),
            observed_name: "KB B".to_owned(),
        }
    );
    // Asking is not activating: nothing is voided, and nothing is raised.
    assert_eq!(open(&browser), ["a1"]);
    assert_eq!(
        browser.last_viewed_resource().borrow().as_deref(),
        Some("a1")
    );
    assert_eq!(conflict(&browser), None);
    assert_eq!(browser.kbs().borrow()[0].label, "KB A");
}

#[tokio::test(start_paused = true)]
async fn asking_again_does_not_raise_a_conflict_that_was_acknowledged() {
    let world = World::with(&[kb_a()]);
    world
        .factory
        .describes(A, description("KB B", "example.org:kb-b", None));
    let browser = world.browser();
    live(&browser).await;
    assert!(conflict(&browser).is_some());
    let signals = browser.active_signals().borrow().clone().expect("signals");
    signals.acknowledge_kb_identity_conflict();

    assert!(matches!(
        browser.read_active_kb().await,
        KbReadVerdict::Conflict { .. }
    ));
    assert_eq!(conflict(&browser), None);
}

#[tokio::test(start_paused = true)]
async fn with_no_session_there_is_nothing_to_ask() {
    let browser = World::new().browser();
    assert_eq!(browser.read_active_kb().await, KbReadVerdict::NoVerdict);
}

// ── What the session's transport fails at ───────────────────────────────

fn refusal(status: u16) -> TransportError {
    TransportError::of_status(format!("HTTP {status}"), status, None)
}

fn notice(browser: &SemiontBrowser, expired: bool) -> Option<SessionNotice> {
    let signals = browser.active_signals().borrow().clone()?;
    if expired {
        signals.session_expired().borrow().clone()
    } else {
        signals.permission_denied().borrow().clone()
    }
}

#[tokio::test(start_paused = true)]
async fn a_refusal_for_want_of_a_token_renews_the_session_quietly_when_it_can() {
    let world = World::with(&[kb_a()]);
    let renewed = jwt(7200);
    world
        .factory
        .sessions
        .queue_renewals([Ok(Some(renewed.clone()))]);
    let browser = world.browser();
    let session = live(&browser).await;

    world.factory.transports(A)[0].fail(refusal(401));
    settle().await;

    assert_eq!(world.factory.sessions.renewed(), 1);
    assert_eq!(session.token().borrow().as_deref(), Some(renewed.as_str()));
    assert_eq!(notice(&browser, true), None);
    assert!(stored_session(world.storage.as_ref(), A).is_some());
}

#[tokio::test(start_paused = true)]
async fn a_session_that_cannot_be_renewed_is_said_to_have_expired_and_its_credential_is_gone() {
    let world = World::with(&[kb_a()]);
    // The issuer has nothing to renew it with.
    world.factory.sessions.queue_renewals([Ok(None)]);
    let browser = world.browser();
    let mut errors = browser.errors();
    live(&browser).await;

    world.factory.transports(A)[0].fail(refusal(401));
    settle().await;

    assert_eq!(
        notice(&browser, true),
        Some(SessionNotice {
            message: "Your session has expired. Please sign in again.".to_owned()
        })
    );
    assert!(stored_session(world.storage.as_ref(), A).is_none());
    let said = tokio::time::timeout(Duration::from_secs(1), errors.next())
        .await
        .expect("the failure is said")
        .expect("the browser lives")
        .expect("no failure was missed");
    assert_eq!(said.code, SessionErrorCode::RefreshExhausted);

    // The refusals that follow find nothing stored, and say nothing more.
    signals_acknowledged(&browser);
    world.factory.transports(A)[0].fail(refusal(401));
    settle().await;
    assert_eq!(notice(&browser, true), None);
}

fn signals_acknowledged(browser: &SemiontBrowser) {
    if let Some(signals) = browser.active_signals().borrow().clone() {
        signals.acknowledge_session_expired();
    }
}

#[tokio::test(start_paused = true)]
async fn a_refusal_with_nothing_stored_is_being_signed_out_and_not_an_expiry() {
    let world = World::new();
    save_knowledge_bases(world.storage.as_ref(), &[kb_a()]);
    let browser = world.browser();
    live(&browser).await;

    world.factory.transports(A)[0].fail(refusal(401));
    settle().await;

    assert_eq!(notice(&browser, true), None);
}

#[tokio::test(start_paused = true)]
async fn a_refusal_for_lack_of_permission_is_said_and_any_other_failure_is_not() {
    let world = World::with(&[kb_a()]);
    let browser = world.browser();
    live(&browser).await;
    let transport = world.factory.transports(A)[0].clone();

    for status in [404, 409, 500, 503] {
        transport.fail(refusal(status));
    }
    settle().await;
    assert_eq!(notice(&browser, false), None);
    assert_eq!(notice(&browser, true), None);
    assert_eq!(world.factory.sessions.renewed(), 0);

    transport.fail(refusal(403));
    settle().await;
    assert_eq!(
        notice(&browser, false),
        Some(SessionNotice {
            message: "HTTP 403".to_owned()
        })
    );
    assert_eq!(notice(&browser, true), None);
}

// ── How it ends ─────────────────────────────────────────────────────────

#[tokio::test(start_paused = true)]
async fn closing_the_browser_closes_its_session_and_ends_what_it_holds() {
    let world = World::with(&[kb_a()]);
    let browser = world.browser();
    live(&browser).await;
    let (kbs, session, signals) = (
        browser.kbs(),
        browser.active_session(),
        browser.active_signals(),
    );
    let mut errors = browser.errors();

    browser.close().await;
    browser.close().await;

    assert!(closed(&world.factory.transports(A)[0]));
    assert!(kbs.has_changed().is_err());
    assert!(session.has_changed().is_err());
    assert!(signals.has_changed().is_err());
    assert!(browser.bus().destroyed());
    assert!(
        tokio::time::timeout(Duration::from_secs(1), errors.next())
            .await
            .expect("the failures end")
            .is_none()
    );
    // Nothing it is told afterwards does anything, and what is stored stays.
    browser.set_active_kb(None).await;
    browser.sign_in(A, &tokens("late")).await;
    assert_eq!(world.storage.get(ACTIVE_KEY).as_deref(), Some(A));
    assert_eq!(
        stored_session(world.storage.as_ref(), A).map(|stored| stored.refresh),
        Some("r".to_owned())
    );
    assert!(world.storage.get(&session_key(A)).is_some());
}

#[tokio::test(start_paused = true)]
async fn a_browser_that_is_dropped_ends_what_it_holds() {
    let world = World::with(&[kb_a()]);
    let browser = world.browser();
    live(&browser).await;
    let kbs = browser.kbs();

    drop(browser);
    settle().await;

    assert!(kbs.has_changed().is_err());
}
