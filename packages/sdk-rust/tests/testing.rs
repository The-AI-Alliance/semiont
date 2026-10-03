//! What a consumer's tests are built on (`semiont::testing`): a real client
//! and a real session over doubles, and a factory of scripted sessions for a
//! registry. A double answers what a test told it to and refuses the rest by
//! name. It never answers with a value of its own making.

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use semiont::client::{ClientOptions, ClientTiming};
use semiont::errors::{SemiontError, SessionError, SessionErrorCode};
use semiont::session::{
    KbEndpoint, KbTarget, KnowledgeBase, Protocol, SessionFactory, SessionFactoryOptions,
    SessionSignals, StoredSession, store_session,
};
use semiont::storage::InMemorySessionStorage;
use semiont::testing::as_id;
use semiont::testing::{
    FaultyTransport, InMemoryContent, ScriptedSessions, StubGateway, TestClientOptions,
    TestSessionOptions, create_test_client, create_test_session,
};
use semiont::transport::{ConnectionState, Content, Transport};
use semiont::types::UserResponse;
use serde_json::json;
use std::sync::{Arc, Mutex};
use std::time::Duration;

fn message(error: SemiontError) -> String {
    match error {
        SemiontError::Bus(error) => error.message,
        SemiontError::Transport(error) => error.message,
        SemiontError::Job(error) => error.message,
    }
}

// ── A client ────────────────────────────────────────────────────────────

#[tokio::test(start_paused = true)]
async fn a_test_client_given_nothing_refuses_every_request_by_name() {
    let test = create_test_client(TestClientOptions::default());

    let refused = test
        .client
        .browse
        .kb()
        .await
        .expect_err("nothing was scripted");
    assert!(
        message(refused).contains("No response scripted for bus operation \"browse:kb-requested\""),
    );
    // It was asked: the transport that came back is the client's.
    assert_eq!(test.transport.request_log().len(), 1);
    // A client over a transport with no gateway has neither namespace.
    assert!(test.client.auth.is_none() && test.client.system.is_none());
    // And nothing was stored for it to read.
    let unread = test
        .client
        .browse
        .resource_content(&as_id("res-1"))
        .await
        .expect_err("nothing was stored");
    assert!(message(unread).contains("res-1"));
}

#[tokio::test(start_paused = true)]
async fn a_test_client_is_built_over_what_the_test_gives_it() {
    let transport = FaultyTransport::new(vec![]);
    transport.queue_reply(
        "browse:kb-requested",
        [Some(
            json!({ "name": "A knowledge base", "domain": "example.org" }),
        )],
    );
    let gateway = StubGateway::new();
    let content = InMemoryContent::new();
    let timing = ClientTiming {
        bus_request: Duration::from_secs(3),
        ..ClientTiming::default()
    };

    let test = create_test_client(TestClientOptions {
        transport: Some(transport.clone()),
        content: Some(content.clone()),
        gateway: Some(Arc::new(gateway.clone())),
        client: ClientOptions {
            timing,
            cache_persistence: None,
        },
    });

    let description = test.client.browse.kb().await.expect("it was scripted");
    assert_eq!(description.name, "A knowledge base");
    assert_eq!(transport.request_log().len(), 1);

    // The content is the one given: what the test stored in it is read.
    content.seed(
        &as_id("res-1"),
        Content {
            bytes: bytes::Bytes::from_static(b"hello"),
            content_type: "text/plain".to_owned(),
        },
    );
    assert_eq!(
        test.client
            .browse
            .resource_content(&as_id("res-1"))
            .await
            .expect("it was stored"),
        "hello"
    );

    // The gateway is the one given, and it too answers only what it was told.
    let auth = test.client.auth.as_ref().expect("a gateway was given");
    let refused = auth.me().await.expect_err("nothing was scripted");
    assert!(message(refused).contains("not scripted: get_current_user"));
    assert_eq!(gateway.calls(), ["get_current_user"]);

    // The deadline is the one given: a request nobody answers is given up
    // on after three seconds, not the client's thirty.
    let silent =
        FaultyTransport::answering(vec![semiont::testing::FaultAction::DropReply], |_, _| {
            Ok(None)
        });
    let impatient = create_test_client(TestClientOptions {
        transport: Some(silent),
        client: ClientOptions {
            timing,
            cache_persistence: None,
        },
        ..TestClientOptions::default()
    });
    let started = tokio::time::Instant::now();
    impatient.client.browse.kb().await.expect_err("no answer");
    assert_eq!(started.elapsed(), Duration::from_secs(3));
}

// ── A session ───────────────────────────────────────────────────────────

#[tokio::test(start_paused = true)]
async fn a_test_session_is_ready_at_once_and_signed_in_as_nobody() {
    let test = create_test_session(TestSessionOptions::default());

    tokio::time::timeout(Duration::from_millis(1), test.session.ready())
        .await
        .expect("it is ready at once");
    assert_eq!(*test.session.token().borrow(), None);
    assert_eq!(*test.session.user().borrow(), None);
    assert_eq!(
        *test.session.kb(),
        KbTarget::http("test-kb", "Test KB", "localhost", 4000, Protocol::Http)
    );
    // Its client is the one that came back, over the transport that did.
    assert!(Arc::ptr_eq(test.session.client(), &test.client));
    test.client
        .browse
        .kb()
        .await
        .expect_err("nothing was scripted");
    assert_eq!(test.transport.request_log().len(), 1);
}

#[tokio::test(start_paused = true)]
async fn a_test_session_holds_the_token_its_storage_held_and_then_the_one_the_test_sends() {
    let kb = KbTarget::http("mine", "Mine", "example.org", 443, Protocol::Https);
    let storage = Arc::new(InMemorySessionStorage::new());
    let stored = token();
    store_session(
        storage.as_ref(),
        "mine",
        &StoredSession {
            access: stored.clone(),
            refresh: "r".to_owned(),
            client_id: "semiont-cli".to_owned(),
            token_endpoint: "https://issuer.test/token".to_owned(),
            revocation_endpoint: None,
        },
    );

    let test = create_test_session(TestSessionOptions {
        kb: Some(kb.clone()),
        storage: Some(storage.clone()),
        ..TestSessionOptions::default()
    });
    test.session.ready().await;

    assert_eq!(*test.session.kb(), kb);
    assert!(Arc::ptr_eq(&test.storage, &storage));
    assert_eq!(*test.session.token().borrow(), Some(stored));
    // Nobody is asked who it is: no gateway was scripted to say.
    assert_eq!(*test.session.user().borrow(), None);

    test.token.send_replace(Some("another".to_owned()));
    assert_eq!(test.session.token().borrow().as_deref(), Some("another"));

    test.session.close().await;
    assert_eq!(*test.transport.state().borrow(), ConnectionState::Closed);
}

// ── Scripted sessions ───────────────────────────────────────────────────

fn alice() -> UserResponse {
    serde_json::from_value(json!({
        "did": "did:web:example.org:users:alice", "email": "alice@example.org",
        "name": "Alice", "image": null, "domain": "example.org",
    }))
    .expect("a user")
}

fn kb(id: &str) -> KnowledgeBase {
    KnowledgeBase {
        id: id.to_owned(),
        label: id.to_owned(),
        did: format!("did:web:example.org:{id}"),
        endpoint: KbEndpoint::Http(semiont::session::HttpEndpoint {
            host: "localhost".to_owned(),
            port: 4000,
            protocol: Protocol::Http,
        }),
        last_read: None,
    }
}

/// A token that is good for an hour.
fn token() -> String {
    let exp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("after 1970")
        .as_secs()
        + 3600;
    format!(
        "{}.{}.sig",
        URL_SAFE_NO_PAD.encode(r#"{"alg":"none"}"#),
        URL_SAFE_NO_PAD.encode(json!({ "exp": exp }).to_string())
    )
}

struct Asked {
    storage: Arc<InMemorySessionStorage>,
    signals: Arc<SessionSignals>,
    errors: Arc<Mutex<Vec<SessionError>>>,
}

impl Asked {
    fn new() -> Asked {
        Asked {
            storage: Arc::new(InMemorySessionStorage::new()),
            signals: Arc::new(SessionSignals::new()),
            errors: Arc::default(),
        }
    }

    /// What a registry asks a factory with.
    fn of(&self, kb_id: &str) -> SessionFactoryOptions {
        let errors = self.errors.clone();
        SessionFactoryOptions {
            kb: kb(kb_id),
            storage: self.storage.clone(),
            signals: self.signals.clone(),
            on_error: Arc::new(move |error| errors.lock().expect("errors").push(error)),
        }
    }

    fn signed_in(&self, kb_id: &str) {
        store_session(
            self.storage.as_ref(),
            kb_id,
            &StoredSession {
                access: token(),
                refresh: "r".to_owned(),
                client_id: "semiont-browser".to_owned(),
                token_endpoint: "https://issuer.test/token".to_owned(),
                revocation_endpoint: None,
            },
        );
    }

    fn errors(&self) -> Vec<SessionError> {
        self.errors.lock().expect("errors").clone()
    }
}

#[tokio::test(start_paused = true)]
async fn scripted_sessions_answer_what_each_knowledge_base_was_told_to_and_refuse_the_rest_by_name()
{
    let sessions = ScriptedSessions::answering(|kb_id, operation, _| match (kb_id, operation) {
        ("kb-a", "browse:kb-requested") => Ok(Some(json!({ "name": "A", "domain": "a.example" }))),
        _ => Err(format!("{kb_id} does not answer {operation}")),
    });
    let asked = Asked::new();
    let of_a = sessions.session(asked.of("kb-a")).expect("a session");
    let of_b = sessions.session(asked.of("kb-b")).expect("a session");
    of_a.ready().await;
    of_b.ready().await;

    assert_eq!(of_a.client().browse.kb().await.expect("scripted").name, "A");
    let refused = of_b.client().browse.kb().await.expect_err("not scripted");
    assert!(message(refused).contains("kb-b does not answer browse:kb-requested"));

    // Each session has a transport of its own, kept by knowledge base.
    assert_eq!(sessions.transports("kb-a").len(), 1);
    assert_eq!(sessions.transports("kb-b").len(), 1);
    assert_eq!(sessions.transports("kb-a")[0].request_log().len(), 1);
    assert_eq!(sessions.transports("kb-c").len(), 0);

    // One built with nothing to answer refuses everything, naming both.
    let silent = ScriptedSessions::new();
    let of_c = silent.session(asked.of("kb-c")).expect("a session");
    let refused = of_c.client().browse.kb().await.expect_err("not scripted");
    assert!(
        message(refused).contains(
            "No response scripted for \"browse:kb-requested\" of knowledge base \"kb-c\""
        ),
    );

    // And a refusal a knowledge base was told to give is the one given.
    sessions.refuse_when(|kb_id, operation, _| {
        (kb_id == "kb-a" && operation == "browse:kb-requested")
            .then(|| json!({ "message": "it will not say" }))
    });
    let refused = of_a.client().browse.kb().await.expect_err("refused");
    assert!(message(refused).contains("it will not say"));
}

#[tokio::test(start_paused = true)]
async fn scripted_sessions_say_who_a_token_is_only_when_told_and_after_as_long_as_told() {
    let sessions = ScriptedSessions::new();
    let asked = Asked::new();
    asked.signed_in("kb-a");

    // Nobody said who: the session is ready, knows nobody, and says why.
    let unnamed = sessions.session(asked.of("kb-a")).expect("a session");
    unnamed.ready().await;
    assert_eq!(*unnamed.user().borrow(), None);
    let said = asked.errors();
    assert_eq!(said.len(), 1, "{said:?}");
    assert!(
        said[0]
            .message
            .contains("ScriptedSessions: not scripted: who a token of \"kb-a\" is"),
        "{said:?}"
    );

    sessions.says_who(alice());
    sessions.answers_after(Duration::from_secs(2));
    let started = tokio::time::Instant::now();
    let named = sessions.session(asked.of("kb-a")).expect("a session");
    named.ready().await;
    assert_eq!(started.elapsed(), Duration::from_secs(2));
    assert_eq!(*named.user().borrow(), Some(alice()));
}

#[tokio::test(start_paused = true)]
async fn scripted_sessions_renew_as_told_in_order_and_refuse_a_renewal_nobody_scripted() {
    let sessions = ScriptedSessions::new();
    sessions.says_who(alice());
    let asked = Asked::new();
    asked.signed_in("kb-a");
    let session = sessions.session(asked.of("kb-a")).expect("a session");
    session.ready().await;
    sessions.queue_renewals([Ok(Some("renewed".to_owned()))]);

    assert_eq!(session.refresh().await.as_deref(), Some("renewed"));
    assert_eq!(sessions.renewed(), 1);
    assert!(asked.signals.session_ended().borrow().is_none());

    // A renewal nobody scripted is a renewal that failed, and says so: the
    // session ends as it does when its issuer cannot be reached.
    assert_eq!(session.refresh().await, None);
    assert_eq!(sessions.renewed(), 2);
    let said = asked.errors();
    assert!(
        said.iter().any(|error| error
            .message
            .contains("ScriptedSessions: not scripted: a renewal of \"kb-a\"")),
        "{said:?}"
    );
    // The session says it is over through the signals the registry gave.
    assert!(asked.signals.session_ended().borrow().is_some());
}

#[tokio::test(start_paused = true)]
async fn scripted_sessions_can_refuse_to_build_and_keep_what_was_revoked() {
    let sessions = ScriptedSessions::new();
    let asked = Asked::new();

    sessions.refuse_to_build(Some("this knowledge base cannot be reached"));
    let refused = sessions
        .session(asked.of("kb-a"))
        .err()
        .expect("it refuses");
    assert_eq!(refused.code, SessionErrorCode::ConstructFailed);
    assert_eq!(refused.message, "this knowledge base cannot be reached");
    assert_eq!(refused.kb_id.as_deref(), Some("kb-a"));
    assert!(sessions.transports("kb-a").is_empty());

    sessions.refuse_to_build(None);
    sessions.session(asked.of("kb-a")).expect("a session");
    assert_eq!(sessions.transports("kb-a").len(), 1);

    let stored = StoredSession {
        access: "a".to_owned(),
        refresh: "r".to_owned(),
        client_id: "semiont-browser".to_owned(),
        token_endpoint: "https://issuer.test/token".to_owned(),
        revocation_endpoint: Some("https://issuer.test/revoke".to_owned()),
    };
    sessions.revoke(stored.clone()).await;
    assert_eq!(sessions.revoked(), [stored]);
}
