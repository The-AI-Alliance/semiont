//! A client's queries over a scripted transport: what each event on the bus,
//! and the reopening of a dropped stream, asks again for; what an event
//! writes and what it ends; the windows refetches fold into; the scopes
//! watching holds; and what a returning client is shown
//! (docs/protocol/CACHE-SEMANTICS.md B12–B13b, B16–B20). The same
//! behaviour, against a real gateway, is the live layer of
//! tests/conformance/sdk.

use semiont::cache::CacheState;
use semiont::cached::Observed;
use semiont::client::{CachePersistence, ClientOptions, ClientTiming, SemiontClient};
use semiont::namespaces::ResourceFilters;
use semiont::storage::InMemorySessionStorage;
use semiont::testing::as_id;
use semiont::testing::liveness::{LivenessScenario, LivenessSpec, assert_liveness_axioms};
use semiont::testing::{FaultyTransport, TestClientOptions, create_test_client};
use semiont::transport::{ConnectionState, Envelope, STREAM_BACKLOG};
use semiont::types::MatchResourcesResponse;
use serde_json::{Map, Value, json};
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

const WINDOW: Duration = Duration::from_millis(100);

fn object(value: Value) -> Map<String, Value> {
    value.as_object().cloned().expect("an object")
}

fn descriptor(id: &str, name: &str) -> Value {
    json!({ "@context": "https://schema.org", "@id": id, "name": name, "representations": [] })
}

fn annotation(id: &str, resource: &str, note: &str) -> Value {
    json!({
        "@context": "http://www.w3.org/ns/anno.jsonld",
        "type": "Annotation",
        "id": id,
        "motivation": "commenting",
        "created": "2026-10-01T12:00:00.000Z",
        "target": { "source": resource },
        "body": { "type": "TextualBody", "value": note, "purpose": "commenting" },
    })
}

/// What a knowledge base answers each read with. Every answer says which
/// ask it was, so a test can tell a value from the one before it.
fn answers(
    silent: &'static [&'static str],
) -> impl Fn(&str, &Map<String, Value>) -> Result<Option<Value>, String> + Send + Sync + 'static {
    let asked = AtomicUsize::new(0);
    move |operation, payload| {
        if silent.contains(&operation) {
            return Err(format!("{operation} is not answered"));
        }
        let n = asked.fetch_add(1, Ordering::SeqCst) + 1;
        let resource = payload
            .get("resourceId")
            .and_then(Value::as_str)
            .unwrap_or("");
        Ok(Some(match operation {
            "browse:resource-requested" => json!({
                "resource": descriptor(resource, &format!("as of ask {n}")),
                "annotations": [], "entityReferences": [],
            }),
            "browse:resources-requested" => json!({
                "resources": [], "total": n, "offset": 0, "limit": 100, "matchKind": "lexical",
            }),
            "browse:annotations-requested" => json!({
                "annotations": [annotation("ann-1", resource, &format!("as of ask {n}"))],
                "total": 1,
            }),
            "browse:annotation-requested" => json!({
                "annotation": annotation(
                    payload.get("annotationId").and_then(Value::as_str).unwrap_or(""),
                    resource,
                    &format!("as of ask {n}"),
                ),
            }),
            "browse:entity-types-requested" => json!({ "entityTypes": [format!("Type{n}")] }),
            "browse:tag-schemas-requested" => json!({ "tagSchemas": [] }),
            "browse:agents-requested" => json!({ "agents": [
                { "agent": { "@type": "Software", "name": "Reader", "provider": "anthropic", "model": "reader-1" },
                  "servesJobTypes": ["highlight-annotation"] },
                { "agent": { "@type": "Software", "name": "Writer", "provider": "anthropic", "model": "writer-1" } },
            ] }),
            "job:limits-requested" => json!({ "limits": [
                { "provider": "anthropic", "model": "reader-1", "limits": { "contextTokens": 1000.0, "maxOutputTokens": 100.0 } },
            ] }),
            "gather:limits-requested" | "match:limits-requested" => json!({ "limits": [
                { "provider": "anthropic", "model": "writer-1", "limits": { "contextTokens": 2000.0, "maxOutputTokens": 200.0 } },
            ] }),
            "gather:referenced-by-requested" => json!({ "referencedBy": [] }),
            "match:resources-requested" => json!({
                "resources": [], "total": n, "offset": 0, "limit": 100, "matchKind": "semantic",
            }),
            "browse:events-requested" => {
                json!({ "events": [], "total": n, "resourceId": resource })
            }
            other => return Err(format!("{other} is not a read this knowledge base answers")),
        }))
    }
}

fn options(persistence: Option<CachePersistence>) -> ClientOptions {
    ClientOptions {
        timing: ClientTiming {
            bus_request: Duration::from_secs(1),
            invalidation_window: WINDOW,
            ..ClientTiming::default()
        },
        cache_persistence: persistence,
    }
}

fn client_over(
    transport: &FaultyTransport,
    persistence: Option<CachePersistence>,
) -> Arc<SemiontClient> {
    create_test_client(TestClientOptions {
        transport: Some(transport.clone()),
        client: options(persistence),
        ..TestClientOptions::default()
    })
    .client
}

fn world() -> (Arc<SemiontClient>, FaultyTransport) {
    let transport = FaultyTransport::answering(vec![], answers(&[]));
    (client_over(&transport, None), transport)
}

/// Let what is ready run.
async fn settle() {
    tokio::time::sleep(Duration::from_millis(1)).await;
}

/// The watcher's next state, or `None` at its end. A watcher that is given
/// neither is a failure, not a wait: an hour of the test's clock is longer
/// than anything here takes.
async fn given<T>(watcher: &mut Observed<T>) -> Option<CacheState<T>> {
    tokio::time::timeout(Duration::from_secs(3600), watcher.next())
        .await
        .expect("the watcher is given a state")
}

/// The state a watcher holds once what is ready has run.
async fn holds<T>(watcher: &mut Observed<T>) -> CacheState<T> {
    settle().await;
    let mut held = None;
    while let Ok(Some(state)) = tokio::time::timeout(Duration::from_millis(1), watcher.next()).await
    {
        held = Some(state);
    }
    held.expect("a watcher always holds a state")
}

/// How many times each of these has been asked, in order.
fn asked<const N: usize>(transport: &FaultyTransport, operations: [&str; N]) -> [usize; N] {
    let log = transport.request_log();
    operations.map(|operation| {
        log.iter()
            .filter(|entry| entry.channel == operation)
            .count()
    })
}

fn asked_of(transport: &FaultyTransport, operation: &str, resource: &str) -> usize {
    transport
        .request_log()
        .iter()
        .filter(|entry| {
            entry.channel == operation
                && entry.payload.get("resourceId").and_then(Value::as_str) == Some(resource)
        })
        .count()
}

/// An event of a resource's record, as the stream carries it.
fn recorded(resource: &str, payload: Value, more: Value) -> Map<String, Value> {
    let mut event = object(json!({
        "id": "evt-1", "type": "recorded", "timestamp": "2026-10-01T12:00:00.000Z",
        "userId": "did:web:example.org:users:alice", "resourceId": resource, "version": 1,
        "payload": payload, "metadata": { "sequenceNumber": 1 },
    }));
    event.extend(object(more));
    event
}

/// An event of the record about the knowledge base itself: it names no
/// resource.
fn recorded_of_the_knowledge_base() -> Map<String, Value> {
    let mut event = recorded("res-1", json!({}), json!({}));
    event.remove("resourceId");
    event
}

fn heard(client: &SemiontClient, channel: &str, payload: Map<String, Value>) {
    client.bus().emit(channel, payload, Envelope::default());
}

const READS: [&str; 10] = [
    "browse:resource-requested",
    "browse:resources-requested",
    "browse:annotations-requested",
    "browse:annotation-requested",
    "browse:events-requested",
    "gather:referenced-by-requested",
    "browse:entity-types-requested",
    "browse:tag-schemas-requested",
    "browse:agents-requested",
    "match:resources-requested",
];

/// A watcher of every query, of two resources: what a busy viewer holds.
struct Everything {
    transport: FaultyTransport,
    client: Arc<SemiontClient>,
    _watching: Vec<Box<dyn std::any::Any + Send>>,
    before: [usize; 10],
}

async fn watching_everything() -> Everything {
    let (client, transport) = world();
    let mut watching: Vec<Box<dyn std::any::Any + Send>> = Vec::new();
    for resource in ["res-1", "res-2"] {
        watching.push(Box::new(client.browse.resource(&as_id(resource)).watch()));
        watching.push(Box::new(
            client.browse.annotations(&as_id(resource)).watch(),
        ));
        watching.push(Box::new(client.browse.events(&as_id(resource)).watch()));
        watching.push(Box::new(
            client.gather.referenced_by(&as_id(resource)).watch(),
        ));
    }
    watching.push(Box::new(
        client
            .browse
            .annotation(&as_id("res-1"), &as_id("ann-1"))
            .watch(),
    ));
    watching.push(Box::new(
        client
            .browse
            .annotation(&as_id("res-2"), &as_id("ann-2"))
            .watch(),
    ));
    watching.push(Box::new(
        client.browse.resources(ResourceFilters::default()).watch(),
    ));
    watching.push(Box::new(
        client
            .match_
            .resources("cat", ResourceFilters::default())
            .watch(),
    ));
    watching.push(Box::new(client.browse.entity_types().watch()));
    watching.push(Box::new(client.browse.tag_schemas().watch()));
    watching.push(Box::new(client.browse.agents().watch()));
    settle().await;
    let before = asked(&transport, READS);
    assert_eq!(
        before,
        [2, 1, 2, 2, 2, 2, 1, 1, 1, 1],
        "one ask per key watched"
    );
    Everything {
        transport,
        client,
        _watching: watching,
        before,
    }
}

impl Everything {
    /// How many more times each read has been asked since the watchers
    /// settled, once the window has closed and what it owed has run.
    async fn more(&self) -> [usize; 10] {
        tokio::time::sleep(WINDOW * 3).await;
        let now = asked(&self.transport, READS);
        std::array::from_fn(|i| now[i] - self.before[i])
    }
}

// ── B12, B20: an event asks again for what its row names, of what is held ──

#[tokio::test(start_paused = true)]
async fn b12_an_annotation_added_asks_again_for_that_resources_annotations_and_history_and_nothing_else()
 {
    let all = watching_everything().await;
    heard(
        &all.client,
        "mark:added",
        recorded("res-1", json!({}), json!({})),
    );
    assert_eq!(all.more().await, [0, 0, 1, 0, 1, 0, 0, 0, 0, 0]);
    assert_eq!(
        asked_of(&all.transport, "browse:annotations-requested", "res-1"),
        2
    );
    assert_eq!(
        asked_of(&all.transport, "browse:annotations-requested", "res-2"),
        1
    );
}

#[tokio::test(start_paused = true)]
async fn a_resource_event_heard_by_every_client_asks_again_for_the_resource_and_every_list_and_search()
 {
    let all = watching_everything().await;
    heard(
        &all.client,
        "yield:updated",
        recorded("res-2", json!({}), json!({})),
    );
    assert_eq!(all.more().await, [1, 1, 0, 0, 0, 0, 0, 0, 0, 1]);
    assert_eq!(
        asked_of(&all.transport, "browse:resource-requested", "res-2"),
        2
    );
}

#[tokio::test(start_paused = true)]
async fn a_change_to_the_vocabulary_asks_again_for_it() {
    let all = watching_everything().await;
    heard(
        &all.client,
        "frame:entity-type-added",
        recorded_of_the_knowledge_base(),
    );
    heard(
        &all.client,
        "frame:tag-schema-added",
        recorded_of_the_knowledge_base(),
    );
    assert_eq!(all.more().await, [0, 0, 0, 0, 0, 0, 1, 1, 0, 0]);
}

#[tokio::test(start_paused = true)]
async fn b20_an_event_about_what_nothing_asked_for_costs_no_request() {
    let (client, transport) = world();
    let _resource = client.browse.resource(&as_id("res-1")).watch();
    settle().await;

    // Another resource, imported by somebody else; and an annotation added
    // to this one, whose annotations and history nobody here looks at.
    for imported in ["res-7", "res-8", "res-9"] {
        heard(
            &client,
            "yield:created",
            recorded(imported, json!({}), json!({})),
        );
    }
    heard(
        &client,
        "mark:added",
        recorded("res-1", json!({}), json!({})),
    );
    tokio::time::sleep(WINDOW * 3).await;
    assert_eq!(asked(&transport, READS), [1, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
}

#[tokio::test(start_paused = true)]
async fn b20_a_value_the_cache_still_holds_is_refreshed_though_its_watcher_has_left() {
    let (client, transport) = world();
    drop(client.browse.resource(&as_id("res-1")).watch());
    settle().await;
    heard(
        &client,
        "yield:updated",
        recorded("res-1", json!({}), json!({})),
    );
    tokio::time::sleep(WINDOW * 3).await;
    assert_eq!(
        asked_of(&transport, "browse:resource-requested", "res-1"),
        2
    );
}

// ── B13: a stream that reopens ──────────────────────────────────────────

#[tokio::test(start_paused = true)]
async fn b13_after_a_drop_what_events_without_a_position_feed_is_asked_for_again() {
    let all = watching_everything().await;
    all.transport.set_state(ConnectionState::Reconnecting);
    settle().await;
    all.transport.set_state(ConnectionState::Open);
    // Lists, searches, resources, the vocabulary and the directory: not
    // what a scope replays.
    assert_eq!(all.more().await, [2, 1, 0, 0, 0, 0, 1, 1, 1, 1]);
}

#[tokio::test(start_paused = true)]
async fn b13_a_stream_that_stays_open_and_the_first_open_ask_for_nothing() {
    let all = watching_everything().await;
    // A handoff: the state never leaves open.
    all.transport.set_state(ConnectionState::Open);
    assert_eq!(all.more().await, [0; 10]);

    // A client whose stream opens for the first time missed nothing either.
    let transport = FaultyTransport::answering(vec![], answers(&[]));
    transport.set_state(ConnectionState::Connecting);
    let client = client_over(&transport, None);
    let _watching = client.browse.entity_types().watch();
    settle().await;
    transport.set_state(ConnectionState::Open);
    tokio::time::sleep(Duration::from_secs(3)).await;
    assert_eq!(asked(&transport, ["browse:entity-types-requested"]), [1]);
}

#[tokio::test(start_paused = true)]
async fn b13_a_gap_the_gateway_could_not_replay_asks_again_for_what_is_held_of_that_scope() {
    let all = watching_everything().await;
    heard(
        &all.client,
        "bus:resume-gap",
        object(
            json!({ "scope": "res-1", "lastSeenId": "p-res-1-4", "reason": "retention-exceeded" }),
        ),
    );
    assert_eq!(all.more().await, [1, 0, 1, 1, 1, 1, 0, 0, 0, 0]);
    for read in [
        "browse:resource-requested",
        "browse:annotations-requested",
        "browse:events-requested",
        "gather:referenced-by-requested",
    ] {
        assert_eq!(asked_of(&all.transport, read, "res-2"), 1, "{read}");
    }
}

#[tokio::test(start_paused = true)]
async fn an_event_that_was_missed_or_cannot_be_read_asks_again_for_everything_held() {
    let all = watching_everything().await;
    // Not an event of the record: nothing says what it names.
    heard(
        &all.client,
        "mark:added",
        object(json!({ "resourceId": 7 })),
    );
    assert_eq!(all.more().await, [2, 1, 2, 2, 2, 2, 1, 1, 1, 1]);

    let all = watching_everything().await;
    for _ in 0..(STREAM_BACKLOG + 10) {
        heard(
            &all.client,
            "mark:archived",
            recorded("res-9", json!({}), json!({})),
        );
    }
    let more = all.more().await;
    assert!(more.iter().all(|asks| *asks >= 1), "{more:?}");
}

// ── B13a, B13b: an event that ends a key, and one that carries its value ──

#[tokio::test(start_paused = true)]
async fn b13a_an_annotation_that_is_gone_fails_its_watchers_as_not_found_and_asks_for_nothing() {
    for (channel, event) in [
        (
            "mark:removed",
            recorded("res-1", json!({ "annotationId": "ann-1" }), json!({})),
        ),
        (
            "mark:delete-ok",
            object(json!({ "response": { "annotationId": "ann-1" } })),
        ),
    ] {
        let (client, transport) = world();
        let mut watcher = client
            .browse
            .annotation(&as_id("res-1"), &as_id("ann-1"))
            .watch();
        assert!(holds(&mut watcher).await.is_ready());

        heard(&client, channel, event);
        match holds(&mut watcher).await {
            CacheState::Failed(gone) => assert_eq!(gone.code(), "bus.not-found", "{channel}"),
            other => panic!("{channel}: the key was to fail, not be {other:?}"),
        }
        tokio::time::sleep(WINDOW * 3).await;
        assert_eq!(
            asked(&transport, ["browse:annotation-requested"]),
            [1],
            "{channel}"
        );

        // A watcher arriving afterwards asks the service.
        let mut arriving = client
            .browse
            .annotation(&as_id("res-1"), &as_id("ann-1"))
            .watch();
        assert!(holds(&mut arriving).await.is_ready());
        assert_eq!(
            asked(&transport, ["browse:annotation-requested"]),
            [2],
            "{channel}"
        );
    }
}

#[tokio::test(start_paused = true)]
async fn b13a_an_annotation_nothing_asked_for_is_not_marked_gone() {
    let (client, transport) = world();
    heard(
        &client,
        "mark:removed",
        recorded("res-1", json!({ "annotationId": "ann-9" }), json!({})),
    );
    settle().await;
    // Its first watcher asks, and is answered: nothing was held against it.
    let mut watcher = client
        .browse
        .annotation(&as_id("res-1"), &as_id("ann-9"))
        .watch();
    assert!(holds(&mut watcher).await.is_ready());
    assert_eq!(asked(&transport, ["browse:annotation-requested"]), [1]);
}

#[tokio::test(start_paused = true)]
async fn b13b_a_body_update_that_carries_the_annotation_writes_it_and_asks_only_for_the_history() {
    let all = watching_everything().await;
    let mut list = all.client.browse.annotations(&as_id("res-1")).watch();
    let mut one = all
        .client
        .browse
        .annotation(&as_id("res-1"), &as_id("ann-1"))
        .watch();
    holds(&mut list).await;
    holds(&mut one).await;

    heard(
        &all.client,
        "mark:body-updated",
        recorded(
            "res-1",
            json!({ "annotationId": "ann-1", "operations": [] }),
            json!({ "annotation": annotation("ann-1", "res-1", "as the event says") }),
        ),
    );
    let said = |state: CacheState<semiont::types::Annotation>| {
        serde_json::to_value(state.ready().expect("a value")).expect("it serializes")["body"]["value"]
            .clone()
    };
    assert_eq!(said(holds(&mut one).await), json!("as the event says"));
    let listed = holds(&mut list).await;
    let listed = listed.ready().expect("a list");
    assert_eq!(listed.len(), 1, "written where it was, not beside it");
    assert_eq!(
        serde_json::to_value(&listed[0]).expect("it serializes")["body"]["value"],
        json!("as the event says")
    );
    assert_eq!(all.more().await, [0, 0, 0, 0, 1, 0, 0, 0, 0, 0]);
}

#[tokio::test(start_paused = true)]
async fn a_body_update_that_does_not_carry_the_annotation_asks_again_for_it() {
    let all = watching_everything().await;
    heard(
        &all.client,
        "mark:body-updated",
        recorded(
            "res-1",
            json!({ "annotationId": "ann-1", "operations": [] }),
            json!({}),
        ),
    );
    assert_eq!(all.more().await, [0, 0, 1, 1, 1, 0, 0, 0, 0, 0]);
}

// ── B19: the refetches one key is asked for fold into one per window ────

#[tokio::test(start_paused = true)]
async fn b19_one_event_refetches_at_once_and_a_storm_refetches_once_per_window_ending_on_the_last()
{
    let (client, transport) = world();
    let _watching = client.browse.annotations(&as_id("res-1")).watch();
    settle().await;

    heard(
        &client,
        "mark:added",
        recorded("res-1", json!({}), json!({})),
    );
    settle().await;
    assert_eq!(
        asked(&transport, ["browse:annotations-requested"]),
        [2],
        "at once"
    );

    // Fifty more inside the window: one refetch is owed, and runs when it closes.
    for _ in 0..50 {
        heard(
            &client,
            "mark:added",
            recorded("res-1", json!({}), json!({})),
        );
    }
    settle().await;
    assert_eq!(asked(&transport, ["browse:annotations-requested"]), [2]);
    tokio::time::sleep(WINDOW * 3).await;
    assert_eq!(asked(&transport, ["browse:annotations-requested"]), [3]);
}

#[tokio::test(start_paused = true)]
async fn b16_b19_a_closed_client_drops_what_its_windows_owed_and_no_event_asks_anything_of_it() {
    let (client, transport) = world();
    let mut watcher = client.browse.annotations(&as_id("res-1")).watch();
    holds(&mut watcher).await;
    heard(
        &client,
        "mark:added",
        recorded("res-1", json!({}), json!({})),
    );
    heard(
        &client,
        "mark:added",
        recorded("res-1", json!({}), json!({})),
    );
    settle().await;
    let before = asked(&transport, ["browse:annotations-requested"]);

    client.close().await;
    client.close().await;
    tokio::time::sleep(WINDOW * 5).await;
    assert_eq!(asked(&transport, ["browse:annotations-requested"]), before);
    // Whatever state it had not read yet, and then its end.
    while tokio::time::timeout(Duration::from_secs(1), watcher.next())
        .await
        .expect("a closed client's watcher ends")
        .is_some()
    {}

    // A read of a closed client fails as closed, and a watcher of one is
    // given nothing.
    let refusal = client
        .browse
        .resource(&as_id("res-1"))
        .fresh()
        .await
        .expect_err("it is closed");
    assert_eq!(refusal.code(), "bus.closed");
    assert_eq!(given(&mut client.browse.entity_types().watch()).await, None);
}

// ── Scope by observation ────────────────────────────────────────────────

#[tokio::test(start_paused = true)]
async fn watching_a_query_of_a_resource_holds_its_scope_and_a_one_shot_read_holds_none() {
    let (client, transport) = world();
    let _ = client.browse.annotations(&as_id("res-1")).fresh().await;
    assert_eq!(transport.holds(&as_id("res-1")), 0);

    let annotations = client.browse.annotations(&as_id("res-1")).watch();
    assert_eq!(transport.holds(&as_id("res-1")), 1);
    let resource = client.browse.resource(&as_id("res-1")).watch();
    let events = client.browse.events(&as_id("res-1")).watch();
    let referenced = client.gather.referenced_by(&as_id("res-1")).watch();
    let annotation = client
        .browse
        .annotation(&as_id("res-1"), &as_id("ann-1"))
        .watch();
    assert_eq!(transport.holds(&as_id("res-1")), 5);
    let other = client.browse.resource(&as_id("res-2")).watch();
    assert_eq!(
        (
            transport.holds(&as_id("res-1")),
            transport.holds(&as_id("res-2"))
        ),
        (5, 1)
    );

    drop((annotations, resource, events, referenced, annotation));
    assert_eq!(
        (
            transport.holds(&as_id("res-1")),
            transport.holds(&as_id("res-2"))
        ),
        (0, 1)
    );
    drop(other);
    assert_eq!(transport.holds(&as_id("res-2")), 0);
}

#[tokio::test(start_paused = true)]
async fn a_query_of_the_knowledge_base_as_a_whole_holds_no_scope() {
    let (client, transport) = world();
    let _watching = (
        client.browse.resources(ResourceFilters::default()).watch(),
        client
            .match_
            .resources("cat", ResourceFilters::default())
            .watch(),
        client.browse.entity_types().watch(),
        client.browse.tag_schemas().watch(),
        client.browse.agents().watch(),
    );
    settle().await;
    assert!(transport.scopes().is_empty(), "{:?}", transport.scopes());
}

// ── Lists, by their filters ─────────────────────────────────────────────

#[tokio::test(start_paused = true)]
async fn a_list_is_kept_per_set_of_filters_and_every_list_held_is_asked_for_again_as_one() {
    let (client, transport) = world();
    let mut all = client.browse.resources(ResourceFilters::default()).watch();
    let mut people = client
        .browse
        .resources(ResourceFilters {
            entity_type: Some("Person".to_owned()),
            ..ResourceFilters::default()
        })
        .watch();
    let mut same = client.browse.resources(ResourceFilters::default()).watch();
    holds(&mut all).await;
    holds(&mut people).await;
    holds(&mut same).await;
    assert_eq!(asked(&transport, ["browse:resources-requested"]), [2]);

    heard(
        &client,
        "yield:created",
        recorded("res-5", json!({}), json!({})),
    );
    tokio::time::sleep(WINDOW * 3).await;
    assert_eq!(asked(&transport, ["browse:resources-requested"]), [4]);
}

// ── Searches, by their text and their filters ───────────────────────────

/// What each search asked the knowledge base, in order.
fn searched(transport: &FaultyTransport) -> Vec<Value> {
    transport
        .request_log()
        .iter()
        .filter(|entry| entry.channel == "match:resources-requested")
        .map(|entry| Value::Object(entry.payload.clone()))
        .collect()
}

#[tokio::test(start_paused = true)]
async fn a_search_asks_for_its_text_among_the_resources_its_filters_admit() {
    let (client, transport) = world();
    let found = client
        .match_
        .resources("cat", ResourceFilters::default())
        .fresh()
        .await
        .expect("an answer");
    // The answer whole: the page, and which kind of answer it is.
    assert_eq!(
        serde_json::to_value(&found).expect("it serializes"),
        json!({ "resources": [], "total": 1.0, "offset": 0.0, "limit": 100.0, "matchKind": "semantic" })
    );
    let _ = client
        .match_
        .resources(
            "cat",
            ResourceFilters {
                limit: Some(5),
                archived: Some(false),
                entity_type: Some("Person".to_owned()),
            },
        )
        .fresh()
        .await;
    assert_eq!(
        searched(&transport),
        [
            json!({ "search": "cat", "limit": 100, "offset": 0 }),
            json!({ "search": "cat", "archived": false, "entityType": "Person", "limit": 5, "offset": 0 }),
        ]
    );
    // A list is asked for with no text, and of another operation.
    let _ = client
        .browse
        .resources(ResourceFilters::default())
        .fresh()
        .await;
    assert_eq!(
        transport
            .request_log()
            .iter()
            .filter(|entry| entry.channel == "browse:resources-requested")
            .map(|entry| Value::Object(entry.payload.clone()))
            .collect::<Vec<_>>(),
        [json!({ "limit": 100, "offset": 0 })]
    );
}

/// A watcher of three searches, two of them the same: of one text, of that
/// text among people, and of another text.
async fn searching() -> (
    Arc<SemiontClient>,
    FaultyTransport,
    Vec<Observed<MatchResourcesResponse>>,
) {
    let (client, transport) = world();
    let people = || ResourceFilters {
        entity_type: Some("Person".to_owned()),
        ..ResourceFilters::default()
    };
    let mut watching = vec![
        client
            .match_
            .resources("cat", ResourceFilters::default())
            .watch(),
        client.match_.resources("cat", people()).watch(),
        client
            .match_
            .resources("dog", ResourceFilters::default())
            .watch(),
        client
            .match_
            .resources("cat", ResourceFilters::default())
            .watch(),
    ];
    for watcher in &mut watching {
        assert!(holds(watcher).await.is_ready());
    }
    assert_eq!(
        asked(&transport, ["match:resources-requested"]),
        [3],
        "one ask per search and set of filters"
    );
    (client, transport, watching)
}

#[tokio::test(start_paused = true)]
async fn a_search_is_kept_per_text_and_set_of_filters_and_every_search_held_is_asked_for_again_as_one()
 {
    let (client, transport, mut watching) = searching().await;
    // The two watchers of one search are shown one answer.
    let first = client
        .match_
        .resources("cat", ResourceFilters::default())
        .fresh()
        .await
        .expect("an answer");
    assert_eq!(
        holds(&mut watching[0]).await,
        CacheState::Ready(first.clone())
    );
    assert_eq!(holds(&mut watching[3]).await, CacheState::Ready(first));
    let before = asked(&transport, ["match:resources-requested"])[0];

    // Three resources created inside one window: each search is asked for
    // again at once, and once more when the window closes.
    for created in ["res-5", "res-6", "res-7"] {
        heard(
            &client,
            "yield:created",
            recorded(created, json!({}), json!({})),
        );
    }
    settle().await;
    assert_eq!(
        asked(&transport, ["match:resources-requested"]),
        [before + 3],
        "at once"
    );
    tokio::time::sleep(WINDOW * 3).await;
    assert_eq!(
        asked(&transport, ["match:resources-requested"]),
        [before + 6]
    );
    let again = searched(&transport);
    for search in [
        json!({ "search": "cat", "limit": 100, "offset": 0 }),
        json!({ "search": "cat", "entityType": "Person", "limit": 100, "offset": 0 }),
        json!({ "search": "dog", "limit": 100, "offset": 0 }),
    ] {
        assert_eq!(
            again[before..]
                .iter()
                .filter(|asked| **asked == search)
                .count(),
            2,
            "{search}"
        );
    }
}

#[tokio::test(start_paused = true)]
async fn b13_a_stream_that_reopens_asks_again_for_every_search_held() {
    let (_client, transport, _watching) = searching().await;
    transport.set_state(ConnectionState::Reconnecting);
    settle().await;
    transport.set_state(ConnectionState::Open);
    tokio::time::sleep(WINDOW * 3).await;
    assert_eq!(asked(&transport, ["match:resources-requested"]), [6]);
}

#[tokio::test(start_paused = true)]
async fn b20_an_event_asks_for_no_search_when_none_is_held() {
    let (client, transport) = world();
    let _list = client.browse.resources(ResourceFilters::default()).watch();
    settle().await;
    heard(
        &client,
        "yield:created",
        recorded("res-5", json!({}), json!({})),
    );
    tokio::time::sleep(WINDOW * 3).await;
    assert_eq!(
        asked(
            &transport,
            ["browse:resources-requested", "match:resources-requested"]
        ),
        [2, 0]
    );
}

#[tokio::test(start_paused = true)]
async fn a_search_can_be_said_to_be_out_of_date_and_ends_with_its_client() {
    let (client, transport) = world();
    let search = client.match_.resources("cat", ResourceFilters::default());
    let mut watcher = search.watch();
    assert!(holds(&mut watcher).await.is_ready());
    search.invalidate();
    settle().await;
    assert_eq!(asked(&transport, ["match:resources-requested"]), [2]);

    client.close().await;
    while tokio::time::timeout(Duration::from_secs(1), watcher.next())
        .await
        .expect("a closed client's watcher ends")
        .is_some()
    {}
    heard(
        &client,
        "yield:created",
        recorded("res-5", json!({}), json!({})),
    );
    tokio::time::sleep(WINDOW * 3).await;
    assert_eq!(asked(&transport, ["match:resources-requested"]), [2]);
}

// ── What refers to a resource ───────────────────────────────────────────

#[tokio::test(start_paused = true)]
async fn what_refers_to_a_resource_is_asked_of_the_gather_flow_by_the_resource_alone() {
    let (client, transport) = world();
    let referring = client
        .gather
        .referenced_by(&as_id("res-1"))
        .fresh()
        .await
        .expect("an answer");
    assert!(referring.is_empty());
    let log = transport.request_log();
    let asked: Vec<(&str, Value)> = log
        .iter()
        .map(|entry| (entry.channel.as_str(), Value::Object(entry.payload.clone())))
        .collect();
    assert_eq!(
        asked,
        [(
            "gather:referenced-by-requested",
            json!({ "resourceId": "res-1" })
        )]
    );
}

#[tokio::test(start_paused = true)]
async fn b13_a_gap_asks_again_for_what_refers_to_the_resource_it_names_and_to_no_other() {
    let (client, transport) = world();
    let _watching = (
        client.gather.referenced_by(&as_id("res-1")).watch(),
        client.gather.referenced_by(&as_id("res-2")).watch(),
    );
    settle().await;
    let gap = |scope: &str| {
        object(json!({ "scope": scope, "lastSeenId": "p-4", "reason": "retention-exceeded" }))
    };
    heard(&client, "bus:resume-gap", gap("res-1"));
    // A resource nobody asked about: nothing is held of it (B20).
    heard(&client, "bus:resume-gap", gap("res-3"));
    tokio::time::sleep(WINDOW * 3).await;
    let of = |resource| asked_of(&transport, "gather:referenced-by-requested", resource);
    assert_eq!((of("res-1"), of("res-2"), of("res-3")), (2, 1, 0));

    // And a stream that reopens asks for none of them: a scope's events are
    // replayed, or a gap says they could not be.
    transport.set_state(ConnectionState::Reconnecting);
    settle().await;
    transport.set_state(ConnectionState::Open);
    tokio::time::sleep(WINDOW * 3).await;
    assert_eq!(asked(&transport, ["gather:referenced-by-requested"]), [3]);
}

// ── The collaborator directory ──────────────────────────────────────────

fn limits_of(collaborators: &[semiont::namespaces::Collaborator]) -> Vec<Option<f64>> {
    collaborators
        .iter()
        .map(|collaborator| {
            collaborator
                .limits
                .as_ref()
                .map(|limits| limits.context_tokens)
        })
        .collect()
}

#[tokio::test(start_paused = true)]
async fn the_directory_has_each_models_limits_as_its_key_holder_reports_them() {
    let (client, transport) = world();
    let mut watcher = client.browse.agents().watch();
    let directory = holds(&mut watcher).await;
    let directory = directory.ready().expect("a directory");
    assert_eq!(limits_of(directory), [Some(1000.0), Some(2000.0)]);
    // An entry is given as the directory states it.
    assert_eq!(
        serde_json::to_value(&directory[0]).expect("it serializes")["servesJobTypes"],
        json!(["highlight-annotation"])
    );
    assert_eq!(
        asked(
            &transport,
            ["browse:agents-requested", "job:limits-requested"]
        ),
        [1, 1]
    );

    let read = client.browse.agents().fresh().await.expect("a directory");
    assert_eq!(limits_of(&read), [Some(1000.0), Some(2000.0)]);
}

#[tokio::test(start_paused = true)]
async fn a_key_holder_that_does_not_answer_holds_up_nothing_but_its_own_models_limits() {
    let transport = FaultyTransport::answering(
        vec![],
        answers(&["gather:limits-requested", "match:limits-requested"]),
    );
    let client = client_over(&transport, None);
    let mut watcher = client.browse.agents().watch();
    let directory = holds(&mut watcher).await;
    assert_eq!(
        limits_of(directory.ready().expect("a directory")),
        [Some(1000.0), None]
    );
    let read = client.browse.agents().fresh().await.expect("a directory");
    assert_eq!(limits_of(&read), [Some(1000.0), None]);
}

#[tokio::test(start_paused = true)]
async fn a_stream_that_reopens_asks_the_directory_and_the_key_holders_again() {
    let (client, transport) = world();
    let _watching = client.browse.agents().watch();
    settle().await;
    transport.set_state(ConnectionState::Reconnecting);
    settle().await;
    transport.set_state(ConnectionState::Open);
    tokio::time::sleep(WINDOW * 3).await;
    assert_eq!(
        asked(
            &transport,
            [
                "browse:agents-requested",
                "job:limits-requested",
                "gather:limits-requested"
            ]
        ),
        [2, 2, 2]
    );
}

// ── B17, B18: a returning client ────────────────────────────────────────

#[tokio::test(start_paused = true)]
async fn b17_b18_a_returning_client_is_shown_what_the_last_one_had_and_asks_once_more() {
    let storage = Arc::new(InMemorySessionStorage::new());
    let persistence = || {
        Some(CachePersistence {
            storage: storage.clone(),
            key_prefix: "kb-1".to_owned(),
        })
    };
    let transport = FaultyTransport::answering(vec![], answers(&[]));
    let first = client_over(&transport, persistence());
    let _ = first.browse.events(&as_id("res-1")).fresh().await;
    let had = first
        .browse
        .resource(&as_id("res-1"))
        .fresh()
        .await
        .expect("a resource");
    first.close().await;

    let transport = FaultyTransport::answering(vec![], answers(&[]));
    let returning = client_over(&transport, persistence());
    let mut watcher = returning.browse.resource(&as_id("res-1")).watch();
    // At once, and what was had; then what it is now.
    assert_eq!(
        given(&mut watcher).await,
        Some(CacheState::Ready(had.clone()))
    );
    let now = holds(&mut watcher).await;
    assert_ne!(now, CacheState::Ready(had));
    assert_eq!(asked(&transport, ["browse:resource-requested"]), [1]);

    // A history is not kept: its first watcher waits for it.
    let mut history = returning.browse.events(&as_id("res-1")).watch();
    assert_eq!(given(&mut history).await, Some(CacheState::Pending));

    // And another knowledge base's client is shown none of it.
    let elsewhere = client_over(
        &FaultyTransport::answering(vec![], answers(&[])),
        Some(CachePersistence {
            storage: storage.clone(),
            key_prefix: "kb-2".to_owned(),
        }),
    );
    assert_eq!(
        given(&mut elsewhere.browse.resource(&as_id("res-1")).watch()).await,
        Some(CacheState::Pending)
    );
}

// ── Liveness: under any behaviour of the wire, a watcher is told something ──

#[test]
fn l1_l2_a_watcher_is_given_a_value_or_a_failure_and_a_read_settles_under_every_schedule() {
    const TIMEOUT: Duration = Duration::from_millis(200);
    let outcome = assert_liveness_axioms(LivenessSpec {
        setup: |transport: FaultyTransport| {
            let client = create_test_client(TestClientOptions {
                transport: Some(transport),
                client: ClientOptions {
                    timing: ClientTiming {
                        bus_request: TIMEOUT,
                        ..ClientTiming::default()
                    },
                    cache_persistence: None,
                },
                ..TestClientOptions::default()
            })
            .client;
            let said = |mut watcher: Observed<_>, client: Arc<SemiontClient>| async move {
                while let Some(state) = watcher.next().await {
                    if state != CacheState::Pending {
                        break;
                    }
                }
                drop(client);
            };
            let reading = client.clone();
            LivenessScenario {
                outputs: vec![
                    Box::pin(said(
                        client.browse.resource(&as_id("res-1")).watch(),
                        client.clone(),
                    )),
                    Box::pin(said(
                        client.browse.resource(&as_id("res-2")).watch(),
                        client.clone(),
                    )),
                ],
                settlements: vec![Box::pin(async move {
                    let _ = reading.browse.resource(&as_id("res-3")).fresh().await;
                })],
            }
        },
        timeout: TIMEOUT,
        // B14: a fetch for the live view is tried once more.
        retry_budget: 1,
        schedules: None,
        respond: Some(Arc::new(answers(&[]))),
        cases: 60,
    });
    assert_eq!(outcome, Ok(()));
}
