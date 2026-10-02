//! The README's examples, compiled and run over the testing doubles. Each
//! fenced Rust block of README.md is one of the regions marked here, word
//! for word (`semiont::testing::examples`).

use semiont::client::SemiontClient;
use semiont::errors::SemiontError;
use semiont::namespaces::{JobEvent, MarkAssistOptions};
use semiont::session::{
    HttpEndpoint, KbEndpoint, KnowledgeBase, Protocol, SemiontBrowser, SemiontBrowserConfig,
    SemiontSession, SessionFactory, SessionFactoryOptions, StoredSession, save_knowledge_bases,
};
use semiont::state::{MarkStateUnit, PendingAnnotation};
use semiont::storage::SessionStorage;
use semiont::testing::as_id;
use semiont::testing::examples::assert_readme_shows;
use semiont::testing::{
    FaultyTransport, ScriptedSessions, SharedStorage, TestClientOptions, create_test_client,
};
use semiont::transport::{BoxFuture, Envelope};
use semiont::types::{InvalidIdentifier, JobCompleteCommand, Motivation, ResourceId};
use serde_json::{Map, Value, json};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::{mpsc, watch};

// ── The examples ────────────────────────────────────────────────────────

fn ids() -> Result<ResourceId, InvalidIdentifier> {
    // <readme:ids>
    // An id is made from text by its kind's rule.
    let resource_id: ResourceId = "5bcd259ab1464cf68a556bbad21f513f".parse()?;
    // Text the rule refuses is refused here, before anything is sent.
    assert!(ResourceId::new("../another").is_err());
    // It reads as the text it is.
    println!("{resource_id}, {} characters", resource_id.len());
    // </readme:ids>
    Ok(resource_id)
}

async fn a_script(
    client: &SemiontClient,
    resource_id: ResourceId,
) -> Result<JobEvent, SemiontError> {
    // <readme:script>
    // Asked once, answered once.
    let about = client.browse.kb().await?;
    println!("{} at {}", about.name, about.domain);

    // A query, read once.
    let resource = client.browse.resource(&resource_id).fresh().await?;
    println!("{}", resource.name);

    // A long-running operation, awaited for its final value.
    let done = client
        .mark
        .assist(
            &resource_id,
            Motivation::Highlighting,
            MarkAssistOptions::default(),
        )
        .await?;
    // </readme:script>
    Ok(done)
}

async fn a_daemon(client: &SemiontClient, mut done: impl FnMut(JobCompleteCommand)) {
    // <readme:daemon>
    // Every job that completes, from now on, until the client closes.
    let mut completed = client.job.complete();
    while let Some(event) = completed.next().await {
        match event {
            Ok(job) => done(job.payload),
            // A reader that fell behind is told how far, and reads on.
            Err(behind) => eprintln!("{behind}"),
        }
    }
    // </readme:daemon>
}

async fn an_application(
    storage: Arc<dyn SessionStorage>,
    session_factory: Arc<dyn SessionFactory>,
    resource_id: ResourceId,
    mut render: impl FnMut(Option<&PendingAnnotation>),
) -> Result<(), watch::error::RecvError> {
    // <readme:application>
    // What an application holds: its knowledge bases, which one is active,
    // and the active one's session.
    let browser = SemiontBrowser::new(SemiontBrowserConfig {
        storage,
        session_factory,
    });
    let mut live = browser.active_session();
    let session = live.wait_for(Option::is_some).await?.clone();

    // A flow, held as state over the session's client: here, the annotation
    // being composed on a resource.
    if let Some(session) = session {
        let marking = MarkStateUnit::new(session.client().clone(), &resource_id);
        let mut pending = marking.pending();
        while pending.changed().await.is_ok() {
            render(pending.borrow_and_update().as_ref());
        }
    }
    // </readme:application>
    Ok(())
}

async fn a_test() -> Result<(), SemiontError> {
    // <readme:testing>
    // A real client over doubles: script the transport, observe the client.
    let test = create_test_client(TestClientOptions::default());
    test.transport.queue_reply(
        "browse:kb-requested",
        [Some(
            json!({ "name": "A knowledge base", "domain": "example.org" }),
        )],
    );
    assert_eq!(test.client.browse.kb().await?.name, "A knowledge base");

    // What nobody scripted is refused, naming the operation.
    let refused = test.client.browse.entity_types().fresh().await;
    assert!(refused.is_err());
    // </readme:testing>
    Ok(())
}

// ── Run ─────────────────────────────────────────────────────────────────

fn object(value: Value) -> Map<String, Value> {
    value.as_object().cloned().expect("an object")
}

async fn settle() {
    tokio::time::sleep(Duration::from_millis(1)).await;
}

fn a_knowledge_base(
    operation: &str,
    payload: &Map<String, Value>,
) -> Result<Option<Value>, String> {
    match operation {
        "browse:kb-requested" => Ok(Some(
            json!({ "name": "A knowledge base", "domain": "example.org" }),
        )),
        "browse:resource-requested" => {
            let id = payload["resourceId"].as_str().unwrap_or_default();
            Ok(Some(json!({
                "resource": {
                    "@context": "https://schema.org", "@id": id,
                    "name": format!("name-{id}"), "representations": [],
                },
                "annotations": [], "entityReferences": [],
            })))
        }
        "job:create" => Ok(Some(json!({ "jobId": "job-1" }))),
        other => Err(format!("{other} is not answered here")),
    }
}

fn completion(job_id: &str) -> Map<String, Value> {
    object(json!({
        "resourceId": "res-1", "jobId": job_id, "jobType": "highlight-annotation",
    }))
}

#[tokio::test(start_paused = true)]
async fn the_script_asks_reads_and_awaits_a_job_to_its_completion() {
    let test = create_test_client(TestClientOptions {
        transport: Some(FaultyTransport::answering(vec![], a_knowledge_base)),
        ..TestClientOptions::default()
    });
    let (client, script) = (test.client.clone(), test.client.clone());
    let running = tokio::spawn(async move { a_script(&script, as_id("res-1")).await });
    settle().await;

    client
        .bus()
        .emit("job:complete", completion("job-1"), Envelope::default());

    let done = tokio::time::timeout(Duration::from_secs(60), running)
        .await
        .expect("the script ends")
        .expect("the script ran")
        .expect("nothing failed");
    assert!(matches!(done, JobEvent::Complete(complete) if complete.job_id == "job-1"));
    let asked: Vec<String> = test
        .transport
        .request_log()
        .into_iter()
        .map(|entry| entry.channel)
        .collect();
    assert_eq!(
        asked,
        [
            "browse:kb-requested",
            "browse:resource-requested",
            "job:create"
        ]
    );
}

#[tokio::test(start_paused = true)]
async fn the_daemon_is_given_each_completion_until_the_client_closes() {
    let test = create_test_client(TestClientOptions::default());
    let (client, daemon) = (test.client.clone(), test.client.clone());
    let seen: Arc<Mutex<Vec<String>>> = Arc::default();
    let recording = seen.clone();
    let running = tokio::spawn(async move {
        a_daemon(&daemon, |job| {
            recording.lock().expect("seen").push(job.job_id.to_string());
        })
        .await;
    });
    settle().await;

    for job_id in ["job-1", "job-2"] {
        client
            .bus()
            .emit("job:complete", completion(job_id), Envelope::default());
    }
    settle().await;
    assert_eq!(*seen.lock().expect("seen"), ["job-1", "job-2"]);

    client.close().await;
    tokio::time::timeout(Duration::from_secs(60), running)
        .await
        .expect("the daemon ends when its client closes")
        .expect("the daemon ran");
}

/// Scripted sessions that keep each session's client, for a test that
/// speaks on it.
struct Keeping {
    sessions: ScriptedSessions,
    clients: Arc<Mutex<Vec<Arc<SemiontClient>>>>,
}

impl SessionFactory for Keeping {
    fn session(
        &self,
        options: SessionFactoryOptions,
    ) -> Result<SemiontSession, semiont::errors::SessionError> {
        let session = self.sessions.session(options)?;
        self.clients
            .lock()
            .expect("clients")
            .push(session.client().clone());
        Ok(session)
    }

    fn revoke(&self, stored: StoredSession) -> BoxFuture<'static, ()> {
        self.sessions.revoke(stored)
    }
}

#[tokio::test(start_paused = true)]
async fn the_application_renders_the_annotation_being_composed_in_the_active_knowledge_base() {
    let storage = Arc::new(SharedStorage::new());
    save_knowledge_bases(
        storage.as_ref(),
        &[KnowledgeBase {
            id: "kb".to_owned(),
            label: "A knowledge base".to_owned(),
            did: "did:web:example.org".to_owned(),
            endpoint: KbEndpoint::Http(HttpEndpoint {
                host: "localhost".to_owned(),
                port: 4000,
                protocol: Protocol::Http,
            }),
            last_read: None,
        }],
    );
    let clients: Arc<Mutex<Vec<Arc<SemiontClient>>>> = Arc::default();
    let factory = Keeping {
        sessions: ScriptedSessions::answering(|_, operation, payload| {
            a_knowledge_base(operation, payload)
        }),
        clients: clients.clone(),
    };
    let (rendered, mut renders) = mpsc::unbounded_channel();
    let running = tokio::spawn(an_application(
        storage,
        Arc::new(factory),
        as_id("res-1"),
        move |pending| {
            let _ = rendered.send(pending.map(|pending| pending.motivation));
        },
    ));
    settle().await;

    let client = clients.lock().expect("clients")[0].clone();
    client.mark.request(
        "res-1",
        serde_json::from_value(json!({ "type": "TextQuoteSelector", "exact": "hello" }))
            .expect("a selector"),
        Motivation::Highlighting,
    );

    let shown = tokio::time::timeout(Duration::from_secs(60), renders.recv())
        .await
        .expect("it is rendered");
    assert_eq!(shown, Some(Some(Motivation::Highlighting)));
    running.abort();
}

#[test]
fn the_ids_example_makes_an_id_and_refuses_what_is_not_one() {
    assert_eq!(
        ids().expect("the text is an id"),
        "5bcd259ab1464cf68a556bbad21f513f"
    );
}

#[tokio::test(start_paused = true)]
async fn the_testing_example_passes() {
    a_test().await.expect("the scripted answer is given");
}

// ── The README shows these, and nothing else ────────────────────────────

#[test]
fn every_rust_block_of_the_readme_is_an_example_that_ran_here() {
    assert_readme_shows(include_str!("../README.md"), &[include_str!("readme.rs")])
        .unwrap_or_else(|odd| panic!("{odd}"));
}
