//! The state units over a client: each flow's behaviour, and each unit held
//! to the state-unit axioms.
//!
//! A unit acts on what it hears a turn of the runtime later, so a test says
//! something, lets what is ready run (`settle`), and then reads. Every wait
//! here is bounded: a unit that never acts fails its test, and does not
//! hang it.

use semiont::client::SemiontClient;
use semiont::event_bus::BusFrames;
use semiont::state::{
    BeckonStateUnit, GatherStateUnit, HoverDwell, MarkStateUnit, MatchStateUnit, PendingAnnotation,
    SearchPipeline, SearchPipelineOptions, SearchState, YieldOutcome, YieldStateUnit,
};
use semiont::state_unit::StateUnit;
use semiont::testing::axioms::{AxiomSubject, Fresh, Surface, assert_state_unit_axioms};
use semiont::testing::{
    FaultAction, FaultyTransport, RequestLogEntry, TestClientOptions, create_test_client,
};
use semiont::timing::{ASSIST_SILENCE, BUS_REQUEST_TIMEOUT, HOVER_DELAY, SEARCH_DEBOUNCE};
use semiont::transport::{Envelope, Frame};
use semiont::types::{
    AnnotationSelector, GatherResourceRequestOptions, GatheredContext, GenerationJobParams,
    Motivation,
};
use serde_json::{Map, Value, json};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::mpsc;
use tokio_stream::wrappers::UnboundedReceiverStream;

const RES: &str = "res-1";

fn object(value: Value) -> Map<String, Value> {
    value.as_object().cloned().expect("an object")
}

fn client_over(transport: &FaultyTransport) -> Arc<SemiontClient> {
    create_test_client(TestClientOptions {
        transport: Some(transport.clone()),
        ..TestClientOptions::default()
    })
    .client
}

/// A transport that answers nothing, and its client.
fn world() -> (Arc<SemiontClient>, FaultyTransport) {
    let transport = FaultyTransport::new(vec![]);
    (client_over(&transport), transport)
}

/// A transport whose every request reaches the gateway and is never
/// answered, until the test answers it (`answer`).
fn unanswered() -> (Arc<SemiontClient>, FaultyTransport) {
    let transport = FaultyTransport::answering(vec![FaultAction::DropReply], |_, _| Ok(None));
    (client_over(&transport), transport)
}

/// A transport that creates `job-1` for whoever asks, and says of any job
/// that it is running.
fn jobs() -> (Arc<SemiontClient>, FaultyTransport) {
    let transport = FaultyTransport::answering(vec![], |operation, _| match operation {
        "job:create" => Ok(Some(json!({ "jobId": "job-1" }))),
        "job:status-requested" => Ok(Some(json!({
            "jobId": "job-1",
            "type": "highlight-annotation",
            "status": "running",
            "userId": "did:web:example.org:users:alice",
            "created": "2026-10-01T00:00:00.000Z",
        }))),
        other => Err(format!("{other} is refused here")),
    });
    (client_over(&transport), transport)
}

/// Let what is ready run: signals are heard, requests are sent, and replies
/// already delivered are read.
async fn settle() {
    tokio::time::sleep(Duration::from_millis(1)).await;
}

fn say(client: &SemiontClient, channel: &str, payload: Value) {
    client
        .bus()
        .emit(channel, object(payload), Envelope::default());
}

fn requests(transport: &FaultyTransport, channel: &str) -> Vec<RequestLogEntry> {
    transport
        .request_log()
        .into_iter()
        .filter(|entry| entry.channel == channel)
        .collect()
}

/// Answer the `nth` request sent on `request` with a frame on `reply`.
fn answer(transport: &FaultyTransport, request: &str, nth: usize, reply: &str, payload: Value) {
    let asked = requests(transport, request)
        .into_iter()
        .nth(nth)
        .unwrap_or_else(|| panic!("request #{nth} on {request} was not sent"));
    transport.deliver(Frame {
        channel: reply.to_owned(),
        payload: object(payload),
        correlation_id: asked.correlation_id,
        scope: None,
        trace: None,
    });
}

/// What has been said on a view so far.
async fn heard(frames: &mut BusFrames) -> Vec<Frame> {
    let mut seen = Vec::new();
    while let Ok(Some(Ok(frame))) =
        tokio::time::timeout(Duration::from_millis(1), frames.next()).await
    {
        seen.push(frame);
    }
    seen
}

fn payloads(frames: Vec<Frame>) -> Vec<Value> {
    frames
        .into_iter()
        .map(|frame| Value::Object(frame.payload))
        .collect()
}

fn context() -> Value {
    json!({
        "focus": { "kind": "resource", "resource": {
            "@context": "https://schema.org", "@id": RES, "name": "A resource",
            "representations": [{ "mediaType": "text/plain" }]
        } },
        "graph": { "nodes": [], "edges": [] },
        "metadata": {}
    })
}

fn gathered() -> GatheredContext {
    serde_json::from_value(context()).expect("a gathered context")
}

// ── Beckon ──────────────────────────────────────────────────────────────

#[tokio::test(start_paused = true)]
async fn beckon_holds_what_is_hovered_and_none_clears_it() {
    let (client, _transport) = world();
    let unit = BeckonStateUnit::new(client.clone());
    let hovered = unit.hovered();
    assert_eq!(*hovered.borrow(), None);

    client.beckon.hover(Some("ann-1"));
    settle().await;
    assert_eq!(hovered.borrow().as_deref(), Some("ann-1"));

    client.beckon.hover(None);
    settle().await;
    assert_eq!(*hovered.borrow(), None);
}

#[tokio::test(start_paused = true)]
async fn beckon_sparkles_what_is_hovered_and_nothing_when_nothing_is() {
    let (client, _transport) = world();
    let _unit = BeckonStateUnit::new(client.clone());
    let mut sparkles = client.bus().frames("beckon:sparkle");

    client.beckon.hover(Some("ann-1"));
    client.beckon.hover(None);
    settle().await;

    assert_eq!(
        payloads(heard(&mut sparkles).await),
        [json!({ "annotationId": "ann-1" })]
    );
}

#[tokio::test(start_paused = true)]
async fn beckon_turns_the_focus_to_an_annotation_that_is_opened() {
    let (client, transport) = world();
    let unit = BeckonStateUnit::new(client.clone());
    let mut focus = client.bus().frames("beckon:focus");

    // By this viewer.
    client.browse.click("ann-1");
    // By another participant, driving this one.
    transport.deliver(Frame {
        channel: "browse:click".to_owned(),
        payload: object(json!({ "annotationId": "ann-2" })),
        correlation_id: None,
        scope: None,
        trace: None,
    });
    settle().await;

    assert_eq!(
        payloads(heard(&mut focus).await),
        [
            json!({ "annotationId": "ann-1" }),
            json!({ "annotationId": "ann-2" })
        ]
    );
    assert_eq!(*unit.hovered().borrow(), None);
}

#[tokio::test(start_paused = true)]
async fn beckon_focus_says_the_focus() {
    let (client, _transport) = world();
    let unit = BeckonStateUnit::new(client.clone());
    let mut focus = client.bus().frames("beckon:focus");

    unit.focus("ann-7");

    assert_eq!(
        payloads(heard(&mut focus).await),
        [json!({ "annotationId": "ann-7" })]
    );
}

#[tokio::test(start_paused = true)]
async fn beckon_disposed_hears_nothing_and_says_nothing() {
    let (client, _transport) = world();
    let unit = BeckonStateUnit::new(client.clone());
    let mut hovered = unit.hovered();
    let mut said = client
        .bus()
        .frames_among(&["beckon:sparkle", "beckon:focus"]);
    unit.dispose();

    client.beckon.hover(Some("ann-1"));
    client.browse.click("ann-1");
    unit.focus("ann-1");
    settle().await;

    assert!(heard(&mut said).await.is_empty());
    assert!(hovered.ended());
    assert_eq!(*hovered.borrow(), None);
    // The client is the caller's still.
    assert!(!client.bus().destroyed());
}

#[tokio::test(start_paused = true)]
async fn a_state_set_to_what_it_already_is_wakes_nobody() {
    let (client, _transport) = world();
    let unit = BeckonStateUnit::new(client.clone());
    let mut hovered = unit.hovered();

    client.beckon.hover(Some("ann-1"));
    settle().await;
    assert!(hovered.moved());

    client.beckon.hover(Some("ann-1"));
    settle().await;
    assert!(!hovered.moved());
}

struct Beckons;

impl AxiomSubject for Beckons {
    type Unit = BeckonStateUnit;

    fn setup(&self) -> Fresh<BeckonStateUnit> {
        let (client, _transport) = world();
        Fresh::of(BeckonStateUnit::new(client.clone())).given(client)
    }

    fn surfaces(&self, unit: &BeckonStateUnit) -> Vec<Box<dyn Surface>> {
        vec![Box::new(unit.hovered())]
    }

    fn invocations<'a>(&self, unit: &'a BeckonStateUnit) -> Vec<Box<dyn Fn() + 'a>> {
        vec![Box::new(|| unit.focus("ann-1"))]
    }
}

#[test]
fn beckon_keeps_the_state_unit_axioms() {
    assert_eq!(assert_state_unit_axioms(&Beckons), Ok(()));
}

// ── The hover dwell ─────────────────────────────────────────────────────

type Said = Arc<Mutex<Vec<Option<String>>>>;

fn dwell(delay: Duration) -> (HoverDwell, Said) {
    let said: Said = Arc::default();
    let record = said.clone();
    let dwell = HoverDwell::new(
        move |hovered| {
            record
                .lock()
                .expect("said")
                .push(hovered.map(str::to_owned))
        },
        delay,
    );
    (dwell, said)
}

fn said(said: &Said) -> Vec<Option<String>> {
    said.lock().expect("said").clone()
}

#[tokio::test(start_paused = true)]
async fn a_pointer_that_rests_hovers_and_one_that_leaves_stops_at_once() {
    let (dwell, hovers) = dwell(HOVER_DELAY);

    dwell.enter("ann-1");
    tokio::time::sleep(HOVER_DELAY - Duration::from_millis(1)).await;
    assert!(said(&hovers).is_empty());
    tokio::time::sleep(Duration::from_millis(2)).await;
    assert_eq!(said(&hovers), [Some("ann-1".to_owned())]);

    dwell.leave();
    assert_eq!(said(&hovers), [Some("ann-1".to_owned()), None]);
}

#[tokio::test(start_paused = true)]
async fn a_pointer_that_passes_over_hovers_nothing() {
    let (dwell, hovers) = dwell(HOVER_DELAY);

    dwell.enter("ann-1");
    tokio::time::sleep(HOVER_DELAY / 2).await;
    dwell.leave();
    tokio::time::sleep(HOVER_DELAY * 2).await;

    // It never hovered, so there is nothing to stop either.
    assert!(said(&hovers).is_empty());
}

#[tokio::test(start_paused = true)]
async fn a_pointer_that_moves_on_hovers_only_where_it_rests() {
    let (dwell, hovers) = dwell(HOVER_DELAY);

    dwell.enter("ann-1");
    tokio::time::sleep(HOVER_DELAY / 2).await;
    dwell.enter("ann-2");
    tokio::time::sleep(HOVER_DELAY * 2).await;

    assert_eq!(said(&hovers), [Some("ann-2".to_owned())]);
}

#[tokio::test(start_paused = true)]
async fn an_annotation_already_hovered_is_not_said_again() {
    let (dwell, hovers) = dwell(HOVER_DELAY);

    dwell.enter("ann-1");
    tokio::time::sleep(HOVER_DELAY * 2).await;
    dwell.enter("ann-1");
    tokio::time::sleep(HOVER_DELAY * 2).await;

    assert_eq!(said(&hovers), [Some("ann-1".to_owned())]);
}

#[tokio::test(start_paused = true)]
async fn a_dwell_that_is_dropped_forgets_the_rest_it_was_waiting_out() {
    let (dwell, hovers) = dwell(HOVER_DELAY);

    dwell.enter("ann-1");
    drop(dwell);
    tokio::time::sleep(HOVER_DELAY * 2).await;

    assert!(said(&hovers).is_empty());
}

// ── Match ───────────────────────────────────────────────────────────────

fn search_request(reference_id: &str) -> Value {
    json!({ "resourceId": RES, "referenceId": reference_id, "context": context() })
}

fn ask_for_a_search(client: &SemiontClient, reference_id: &str, correlation_id: &str) {
    client.match_.request_search(
        serde_json::from_value(search_request(reference_id)).expect("a search request"),
        correlation_id,
    );
}

#[tokio::test(start_paused = true)]
async fn match_runs_the_search_it_is_asked_for_and_answers_under_the_askers_id() {
    let (client, transport) = unanswered();
    let _unit = MatchStateUnit::new(client.clone());
    let mut results = client.bus().frames("match:search-results");
    settle().await;
    assert!(transport.request_log().is_empty());

    ask_for_a_search(&client, "ref-1", "asked-1");
    settle().await;
    let sent = requests(&transport, "match:search-requested");
    assert_eq!(sent.len(), 1);
    assert_eq!(sent[0].payload["referenceId"], "ref-1");
    assert_eq!(sent[0].payload["resourceId"], RES);

    answer(
        &transport,
        "match:search-requested",
        0,
        "match:search-results",
        json!({ "referenceId": "ref-1", "response": [] }),
    );
    settle().await;

    // The wire's reply, under the request's own id, and then the unit's,
    // under the asker's.
    let said = heard(&mut results).await;
    let under: Vec<Option<&str>> = said
        .iter()
        .map(|frame| frame.correlation_id.as_deref())
        .collect();
    assert_eq!(under, [sent[0].correlation_id.as_deref(), Some("asked-1")]);
    assert_eq!(
        Value::Object(said[1].payload.clone()),
        json!({ "referenceId": "ref-1", "response": [] })
    );
}

#[tokio::test(start_paused = true)]
async fn match_says_a_search_that_failed_with_its_reference_and_the_reason() {
    let (client, transport) = unanswered();
    let _unit = MatchStateUnit::new(client.clone());
    let mut failures = client.bus().frames("match:search-failed");

    ask_for_a_search(&client, "ref-1", "asked-1");
    settle().await;
    answer(
        &transport,
        "match:search-requested",
        0,
        "match:search-failed",
        json!({ "referenceId": "ref-1", "error": "the index is down" }),
    );
    settle().await;

    let said = heard(&mut failures).await;
    let ours: Vec<&Frame> = said
        .iter()
        .filter(|frame| frame.correlation_id.as_deref() == Some("asked-1"))
        .collect();
    assert_eq!(ours.len(), 1);
    assert_eq!(
        Value::Object(ours[0].payload.clone()),
        json!({ "referenceId": "ref-1", "error": "the index is down" })
    );
}

#[tokio::test(start_paused = true)]
async fn match_says_a_search_never_answered_as_failed_at_the_requests_deadline() {
    let (client, _transport) = unanswered();
    let _unit = MatchStateUnit::new(client.clone());
    let mut failures = client.bus().frames("match:search-failed");

    ask_for_a_search(&client, "ref-1", "asked-1");
    tokio::time::sleep(BUS_REQUEST_TIMEOUT - Duration::from_secs(1)).await;
    assert!(heard(&mut failures).await.is_empty());
    tokio::time::sleep(Duration::from_secs(2)).await;

    let said = heard(&mut failures).await;
    assert_eq!(said.len(), 1);
    assert_eq!(said[0].correlation_id.as_deref(), Some("asked-1"));
    assert_eq!(said[0].payload["referenceId"], "ref-1");
}

#[tokio::test(start_paused = true)]
async fn match_disposed_runs_nothing() {
    let (client, transport) = unanswered();
    let unit = MatchStateUnit::new(client.clone());
    unit.dispose();

    ask_for_a_search(&client, "ref-1", "asked-1");
    settle().await;

    assert!(transport.request_log().is_empty());
    assert!(!client.bus().destroyed());
}

struct Matches;

impl AxiomSubject for Matches {
    type Unit = MatchStateUnit;

    fn setup(&self) -> Fresh<MatchStateUnit> {
        let (client, _transport) = world();
        Fresh::of(MatchStateUnit::new(client.clone())).given(client)
    }
}

#[test]
fn match_keeps_the_state_unit_axioms() {
    assert_eq!(assert_state_unit_axioms(&Matches), Ok(()));
}

// ── Gather ──────────────────────────────────────────────────────────────

/// Everything a gather unit holds, as it is now.
#[derive(Debug, PartialEq)]
struct Gathers {
    context: Option<GatheredContext>,
    loading: bool,
    error: Option<String>,
    annotation_id: Option<String>,
    resource_context: Option<GatheredContext>,
    resource_loading: bool,
    resource_error: Option<String>,
}

impl Gathers {
    fn of(unit: &GatherStateUnit) -> Gathers {
        Gathers {
            context: unit.context().borrow().clone(),
            loading: *unit.loading().borrow(),
            error: unit.error().borrow().as_ref().map(ToString::to_string),
            annotation_id: unit.annotation_id().borrow().clone(),
            resource_context: unit.resource_context().borrow().clone(),
            resource_loading: *unit.resource_loading().borrow(),
            resource_error: unit
                .resource_error()
                .borrow()
                .as_ref()
                .map(ToString::to_string),
        }
    }

    fn nothing() -> Gathers {
        Gathers {
            context: None,
            loading: false,
            error: None,
            annotation_id: None,
            resource_context: None,
            resource_loading: false,
            resource_error: None,
        }
    }
}

fn ask_for_a_gather(client: &SemiontClient, annotation_id: &str, options: Value) {
    let mut request = object(json!({ "annotationId": annotation_id, "resourceId": "elsewhere" }));
    if !options.is_null() {
        request.insert("options".to_owned(), options);
    }
    client
        .bus()
        .emit("gather:requested", request, Envelope::default());
}

fn annotation_gathered(transport: &FaultyTransport, nth: usize, annotation_id: &str) {
    answer(
        transport,
        "gather:requested",
        nth,
        "gather:complete",
        json!({ "annotationId": annotation_id, "response": context() }),
    );
}

#[tokio::test(start_paused = true)]
async fn gather_begins_with_nothing_and_asks_for_nothing() {
    let (client, transport) = unanswered();
    let unit = GatherStateUnit::new(client.clone(), RES);
    settle().await;

    assert_eq!(Gathers::of(&unit), Gathers::nothing());
    assert!(transport.request_log().is_empty());
}

#[tokio::test(start_paused = true)]
async fn gather_asks_for_an_annotations_context_of_its_own_resource_and_holds_it() {
    let (client, transport) = unanswered();
    let unit = GatherStateUnit::new(client.clone(), RES);

    ask_for_a_gather(&client, "ann-1", Value::Null);
    settle().await;
    assert_eq!(
        Gathers::of(&unit),
        Gathers {
            loading: true,
            annotation_id: Some("ann-1".to_owned()),
            ..Gathers::nothing()
        }
    );
    let sent = requests(&transport, "gather:requested");
    assert_eq!(sent.len(), 1);
    assert_eq!(
        Value::Object(sent[0].payload.clone()),
        json!({ "annotationId": "ann-1", "resourceId": RES, "options": { "contextWindow": 2000 } })
    );

    annotation_gathered(&transport, 0, "ann-1");
    settle().await;
    assert_eq!(
        Gathers::of(&unit),
        Gathers {
            context: Some(gathered()),
            annotation_id: Some("ann-1".to_owned()),
            ..Gathers::nothing()
        }
    );
}

#[tokio::test(start_paused = true)]
async fn gather_takes_the_window_it_is_asked_for() {
    let (client, transport) = unanswered();
    let _unit = GatherStateUnit::new(client.clone(), RES);

    ask_for_a_gather(&client, "ann-1", json!({ "contextWindow": 500 }));
    settle().await;

    let sent = requests(&transport, "gather:requested");
    assert_eq!(sent[0].payload["options"], json!({ "contextWindow": 500 }));
}

#[tokio::test(start_paused = true)]
async fn gather_holds_the_failure_of_a_gather_and_the_next_one_clears_it() {
    let (client, transport) = unanswered();
    let unit = GatherStateUnit::new(client.clone(), RES);

    ask_for_a_gather(&client, "ann-1", Value::Null);
    settle().await;
    answer(
        &transport,
        "gather:requested",
        0,
        "gather:failed",
        json!({ "annotationId": "ann-1", "message": "no such annotation" }),
    );
    settle().await;
    assert_eq!(
        Gathers::of(&unit),
        Gathers {
            error: Some("no such annotation".to_owned()),
            annotation_id: Some("ann-1".to_owned()),
            ..Gathers::nothing()
        }
    );

    ask_for_a_gather(&client, "ann-2", Value::Null);
    settle().await;
    assert_eq!(
        Gathers::of(&unit),
        Gathers {
            loading: true,
            annotation_id: Some("ann-2".to_owned()),
            ..Gathers::nothing()
        }
    );

    annotation_gathered(&transport, 1, "ann-2");
    settle().await;
    ask_for_a_gather(&client, "ann-3", Value::Null);
    settle().await;
    // The context the last one left is gone while this one is asked for.
    assert_eq!(
        Gathers::of(&unit),
        Gathers {
            loading: true,
            annotation_id: Some("ann-3".to_owned()),
            ..Gathers::nothing()
        }
    );
}

#[tokio::test(start_paused = true)]
async fn gather_fails_a_gather_never_answered_at_the_requests_deadline() {
    let (client, _transport) = unanswered();
    let unit = GatherStateUnit::new(client.clone(), RES);

    ask_for_a_gather(&client, "ann-1", Value::Null);
    tokio::time::sleep(BUS_REQUEST_TIMEOUT - Duration::from_secs(1)).await;
    assert!(*unit.loading().borrow());
    tokio::time::sleep(Duration::from_secs(2)).await;

    assert!(!*unit.loading().borrow());
    let error = unit.error().borrow().clone().expect("the gather failed");
    assert_eq!(error.code(), "bus.timeout");
}

#[tokio::test(start_paused = true)]
async fn gather_resource_is_loading_when_the_call_returns_and_then_holds_the_context() {
    let (client, transport) = unanswered();
    let unit = GatherStateUnit::new(client.clone(), RES);

    unit.gather_resource("res-9", GatherResourceRequestOptions::default());
    // Before anything else has run.
    assert_eq!(
        Gathers::of(&unit),
        Gathers {
            resource_loading: true,
            ..Gathers::nothing()
        }
    );
    settle().await;
    let sent = requests(&transport, "gather:resource-requested");
    assert_eq!(sent.len(), 1);
    assert_eq!(sent[0].payload["resourceId"], "res-9");

    answer(
        &transport,
        "gather:resource-requested",
        0,
        "gather:resource-complete",
        json!({ "resourceId": "res-9", "response": context() }),
    );
    settle().await;
    assert_eq!(
        Gathers::of(&unit),
        Gathers {
            resource_context: Some(gathered()),
            ..Gathers::nothing()
        }
    );
}

#[tokio::test(start_paused = true)]
async fn gather_resource_holds_its_failure_and_the_next_one_clears_it() {
    let (client, transport) = unanswered();
    let unit = GatherStateUnit::new(client.clone(), RES);

    unit.gather_resource("res-9", GatherResourceRequestOptions::default());
    settle().await;
    answer(
        &transport,
        "gather:resource-requested",
        0,
        "gather:resource-failed",
        json!({ "resourceId": "res-9", "message": "no such resource" }),
    );
    settle().await;
    assert_eq!(
        Gathers::of(&unit),
        Gathers {
            resource_error: Some("no such resource".to_owned()),
            ..Gathers::nothing()
        }
    );

    unit.gather_resource("res-9", GatherResourceRequestOptions::default());
    assert_eq!(
        Gathers::of(&unit),
        Gathers {
            resource_loading: true,
            ..Gathers::nothing()
        }
    );
}

#[tokio::test(start_paused = true)]
async fn gather_keeps_an_annotations_gather_and_a_resources_apart() {
    let (client, transport) = unanswered();
    let unit = GatherStateUnit::new(client.clone(), RES);

    ask_for_a_gather(&client, "ann-1", Value::Null);
    unit.gather_resource("res-9", GatherResourceRequestOptions::default());
    settle().await;
    answer(
        &transport,
        "gather:resource-requested",
        0,
        "gather:resource-failed",
        json!({ "resourceId": "res-9", "message": "no such resource" }),
    );
    settle().await;
    assert_eq!(
        Gathers::of(&unit),
        Gathers {
            loading: true,
            annotation_id: Some("ann-1".to_owned()),
            resource_error: Some("no such resource".to_owned()),
            ..Gathers::nothing()
        }
    );

    annotation_gathered(&transport, 0, "ann-1");
    settle().await;
    assert_eq!(
        Gathers::of(&unit),
        Gathers {
            context: Some(gathered()),
            annotation_id: Some("ann-1".to_owned()),
            resource_error: Some("no such resource".to_owned()),
            ..Gathers::nothing()
        }
    );
}

#[tokio::test(start_paused = true)]
async fn gather_disposed_is_inert_and_an_answer_that_comes_later_lands_nowhere() {
    let (client, transport) = unanswered();
    let unit = GatherStateUnit::new(client.clone(), RES);
    ask_for_a_gather(&client, "ann-1", Value::Null);
    unit.gather_resource("res-9", GatherResourceRequestOptions::default());
    settle().await;
    let mut held = unit.context();
    let mut held_of_the_resource = unit.resource_context();

    unit.dispose();
    annotation_gathered(&transport, 0, "ann-1");
    answer(
        &transport,
        "gather:resource-requested",
        0,
        "gather:resource-complete",
        json!({ "resourceId": "res-9", "response": context() }),
    );
    ask_for_a_gather(&client, "ann-2", Value::Null);
    unit.gather_resource("res-9", GatherResourceRequestOptions::default());
    settle().await;

    assert!(held.ended() && held_of_the_resource.ended());
    assert_eq!(*held.borrow(), None);
    assert_eq!(*held_of_the_resource.borrow(), None);
    assert_eq!(requests(&transport, "gather:requested").len(), 1);
    assert_eq!(requests(&transport, "gather:resource-requested").len(), 1);
    assert!(!client.bus().destroyed());
}

struct Gatherings;

impl AxiomSubject for Gatherings {
    type Unit = GatherStateUnit;

    fn setup(&self) -> Fresh<GatherStateUnit> {
        let (client, _transport) = world();
        Fresh::of(GatherStateUnit::new(client.clone(), RES)).given(client)
    }

    fn surfaces(&self, unit: &GatherStateUnit) -> Vec<Box<dyn Surface>> {
        vec![
            Box::new(unit.context()),
            Box::new(unit.loading()),
            Box::new(unit.error()),
            Box::new(unit.annotation_id()),
            Box::new(unit.resource_context()),
            Box::new(unit.resource_loading()),
            Box::new(unit.resource_error()),
        ]
    }

    fn invocations<'a>(&self, unit: &'a GatherStateUnit) -> Vec<Box<dyn Fn() + 'a>> {
        vec![Box::new(|| {
            unit.gather_resource(RES, GatherResourceRequestOptions::default());
        })]
    }
}

#[test]
fn gather_keeps_the_state_unit_axioms() {
    assert_eq!(assert_state_unit_axioms(&Gatherings), Ok(()));
}

// ── Yield ───────────────────────────────────────────────────────────────

fn generation(more: Value) -> GenerationJobParams {
    let mut params = object(json!({
        "title": "A title",
        "storageUri": "file://generated.md",
        "context": context(),
    }));
    params.extend(object(more));
    serde_json::from_value(Value::Object(params)).expect("generation params")
}

fn job_frame(job_type: &str, more: Value) -> Value {
    let mut frame = object(json!({ "resourceId": RES, "jobId": "job-1", "jobType": job_type }));
    frame.extend(object(more));
    Value::Object(frame)
}

fn progress(job_type: &str, percentage: f64) -> Value {
    job_frame(
        job_type,
        json!({ "percentage": percentage, "progress": { "percentage": percentage } }),
    )
}

/// Everything a yield unit holds: whether it generates, the percentage of
/// its progress, and its outcome.
fn yielding(unit: &YieldStateUnit) -> (bool, Option<f64>, Option<YieldOutcome>) {
    (
        *unit.is_generating().borrow(),
        unit.progress().borrow().as_ref().map(|p| p.percentage),
        unit.outcome().borrow().clone(),
    )
}

fn generated(truncated: bool) -> Value {
    job_frame(
        "generation",
        json!({ "result": {
            "kind": "generation", "resourceId": "res-new", "resourceName": "New", "truncated": truncated
        } }),
    )
}

fn outcome(truncated: bool) -> YieldOutcome {
    YieldOutcome {
        resource_id: "res-new".to_owned(),
        resource_name: "New".to_owned(),
        truncated,
    }
}

#[tokio::test(start_paused = true)]
async fn yield_begins_idle_and_generates_in_its_locale_unless_a_language_is_stated() {
    let (client, transport) = jobs();
    let unit = YieldStateUnit::new(client.clone(), "fr");
    assert_eq!(yielding(&unit), (false, None, None));

    unit.generate(generation(json!({})), None);
    unit.generate(
        generation(json!({ "language": "de", "maxTokens": 900 })),
        None,
    );
    unit.generate(generation(json!({ "language": "" })), None);
    settle().await;

    let created = requests(&transport, "job:create");
    let languages: Vec<&Value> = created
        .iter()
        .map(|entry| &entry.payload["params"]["language"])
        .collect();
    assert_eq!(languages, [&json!("fr"), &json!("de"), &json!("fr")]);
    assert_eq!(created[0].payload["jobType"], "generation");
    // What is asked for is sent as it was asked, and nothing is added to it.
    assert_eq!(
        created[1].payload["params"],
        json!({
            "title": "A title", "storageUri": "file://generated.md", "context": context(),
            "language": "de", "maxTokens": 900.0
        })
    );
}

#[tokio::test(start_paused = true)]
async fn yield_shows_a_runs_progress_and_keeps_it_with_the_outcome_when_the_run_ends() {
    let (client, _transport) = jobs();
    let unit = YieldStateUnit::new(client.clone(), "en");
    unit.generate(generation(json!({})), None);
    settle().await;
    // Not generating until the job says so.
    assert_eq!(yielding(&unit), (false, None, None));

    say(&client, "job:report-progress", progress("generation", 5.0));
    settle().await;
    assert_eq!(yielding(&unit), (true, Some(5.0), None));

    say(&client, "job:report-progress", progress("generation", 95.0));
    settle().await;
    assert_eq!(yielding(&unit), (true, Some(95.0), None));

    say(&client, "job:complete", generated(true));
    settle().await;
    assert_eq!(yielding(&unit), (false, Some(95.0), Some(outcome(true))));
}

#[tokio::test(start_paused = true)]
async fn yield_has_no_outcome_from_a_completion_that_carries_no_generation() {
    let (client, _transport) = jobs();
    let unit = YieldStateUnit::new(client.clone(), "en");
    unit.generate(generation(json!({})), None);
    settle().await;
    say(&client, "job:report-progress", progress("generation", 5.0));
    say(&client, "job:complete", job_frame("generation", json!({})));
    settle().await;

    assert_eq!(yielding(&unit), (false, Some(5.0), None));
}

#[tokio::test(start_paused = true)]
async fn yield_clears_the_progress_of_a_run_that_fails() {
    let (client, _transport) = jobs();
    let unit = YieldStateUnit::new(client.clone(), "en");
    unit.generate(generation(json!({})), None);
    settle().await;
    say(&client, "job:report-progress", progress("generation", 5.0));
    settle().await;
    assert_eq!(yielding(&unit), (true, Some(5.0), None));

    assert_eq!(*unit.failure().borrow(), None);
    say(
        &client,
        "job:fail",
        job_frame("generation", json!({ "error": "the model refused" })),
    );
    settle().await;
    assert_eq!(yielding(&unit), (false, None, None));
    // Why it ended is held, for whoever shows the run.
    assert_eq!(
        failure(&unit),
        Some(("job.failed", "the model refused".to_owned()))
    );
}

/// Why a yield unit's last run ended without a result: its code and what it said.
fn failure(unit: &YieldStateUnit) -> Option<(&'static str, String)> {
    unit.failure()
        .borrow()
        .as_ref()
        .map(|failure| (failure.code(), failure.to_string()))
}

#[tokio::test(start_paused = true)]
async fn yield_keeps_generating_through_an_attempt_that_will_be_tried_again() {
    let (client, _transport) = jobs();
    let unit = YieldStateUnit::new(client.clone(), "en");
    unit.generate(generation(json!({})), None);
    settle().await;
    say(&client, "job:report-progress", progress("generation", 5.0));
    say(
        &client,
        "job:fail",
        job_frame("generation", json!({ "error": "busy", "willRetry": true })),
    );
    settle().await;

    assert_eq!(yielding(&unit), (true, Some(5.0), None));
}

#[tokio::test(start_paused = true)]
async fn yield_stops_generating_when_a_run_stalls() {
    let (client, _transport) = jobs();
    let unit = YieldStateUnit::new(client.clone(), "en");
    unit.generate(generation(json!({})), Some(Duration::from_secs(5)));
    settle().await;
    say(&client, "job:report-progress", progress("generation", 5.0));
    settle().await;
    assert_eq!(yielding(&unit), (true, Some(5.0), None));

    tokio::time::sleep(Duration::from_secs(6)).await;
    assert_eq!(yielding(&unit), (false, None, None));
    // A stall is said nowhere else: the unit is where it is learned.
    assert_eq!(failure(&unit).map(|(code, _)| code), Some("job.stalled"));
}

#[tokio::test(start_paused = true)]
async fn yield_holds_why_a_run_failed_until_it_is_dismissed_or_another_begins() {
    let (client, _transport) = jobs();
    let unit = YieldStateUnit::new(client.clone(), "en");
    let fail = |client: &SemiontClient| {
        say(
            client,
            "job:fail",
            job_frame("generation", json!({ "error": "the model refused" })),
        );
    };

    unit.generate(generation(json!({})), None);
    settle().await;
    fail(&client);
    settle().await;
    assert!(failure(&unit).is_some());
    unit.dismiss_progress();
    assert_eq!(failure(&unit), None);

    unit.generate(generation(json!({})), None);
    settle().await;
    fail(&client);
    settle().await;
    assert!(failure(&unit).is_some());
    // The next run does not begin with the last one's failure: it is gone
    // when the call returns.
    unit.generate(generation(json!({})), None);
    assert_eq!(failure(&unit), None);

    // And a setback the queue will retry is not one.
    settle().await;
    say(
        &client,
        "job:fail",
        job_frame("generation", json!({ "error": "busy", "willRetry": true })),
    );
    settle().await;
    assert_eq!(failure(&unit), None);
}

#[tokio::test(start_paused = true)]
async fn yield_dismissed_or_begun_again_clears_what_the_last_run_left() {
    let (client, _transport) = jobs();
    let unit = YieldStateUnit::new(client.clone(), "en");
    let finish = |client: &SemiontClient| {
        say(client, "job:report-progress", progress("generation", 95.0));
        say(client, "job:complete", generated(false));
    };

    unit.generate(generation(json!({})), None);
    settle().await;
    finish(&client);
    settle().await;
    assert_eq!(yielding(&unit), (false, Some(95.0), Some(outcome(false))));

    unit.dismiss_progress();
    assert_eq!(yielding(&unit), (false, None, None));

    unit.generate(generation(json!({})), None);
    settle().await;
    finish(&client);
    settle().await;
    assert_eq!(yielding(&unit).2, Some(outcome(false)));

    // The next run's display does not carry this one's link: it is gone
    // when the call returns.
    unit.generate(generation(json!({})), None);
    assert_eq!(yielding(&unit).2, None);
}

#[tokio::test(start_paused = true)]
async fn yield_disposed_is_inert() {
    let (client, transport) = jobs();
    let unit = YieldStateUnit::new(client.clone(), "en");
    unit.generate(generation(json!({})), None);
    settle().await;
    let mut generating = unit.is_generating();
    let mut shown = unit.progress();

    unit.dispose();
    say(&client, "job:report-progress", progress("generation", 5.0));
    unit.generate(generation(json!({})), None);
    unit.dismiss_progress();
    settle().await;

    assert!(generating.ended() && shown.ended());
    assert!(!*generating.borrow());
    assert_eq!(*shown.borrow(), None);
    assert_eq!(requests(&transport, "job:create").len(), 1);
    assert!(!client.bus().destroyed());
}

struct Yields;

impl AxiomSubject for Yields {
    type Unit = YieldStateUnit;

    fn setup(&self) -> Fresh<YieldStateUnit> {
        let (client, _transport) = world();
        Fresh::of(YieldStateUnit::new(client.clone(), "en")).given(client)
    }

    fn surfaces(&self, unit: &YieldStateUnit) -> Vec<Box<dyn Surface>> {
        vec![
            Box::new(unit.is_generating()),
            Box::new(unit.progress()),
            Box::new(unit.outcome()),
            Box::new(unit.failure()),
        ]
    }

    fn invocations<'a>(&self, unit: &'a YieldStateUnit) -> Vec<Box<dyn Fn() + 'a>> {
        vec![
            Box::new(|| unit.generate(generation(json!({})), None)),
            Box::new(|| unit.dismiss_progress()),
        ]
    }
}

#[test]
fn yield_keeps_the_state_unit_axioms() {
    assert_eq!(assert_state_unit_axioms(&Yields), Ok(()));
}

// ── Mark ────────────────────────────────────────────────────────────────

fn quote(exact: &str) -> Value {
    json!({ "type": "TextQuoteSelector", "exact": exact })
}

fn requested_selector(exact: &str) -> AnnotationSelector {
    serde_json::from_value(quote(exact)).expect("a selector")
}

fn pending_of(selector: Value, motivation: Motivation) -> Option<PendingAnnotation> {
    Some(PendingAnnotation {
        selector: serde_json::from_value::<AnnotationSelector>(selector).expect("a selector"),
        motivation,
    })
}

fn submit(client: &SemiontClient, source: &str, exact: &str) {
    client.mark.submit(
        serde_json::from_value(json!({
            "source": source,
            "motivation": "commenting",
            "selector": quote(exact),
            "body": [{ "type": "TextualBody", "value": "a comment", "purpose": "commenting" }],
        }))
        .expect("a submission"),
    );
}

#[tokio::test(start_paused = true)]
async fn mark_holds_the_annotation_a_selection_asks_for_until_it_is_cancelled() {
    let (client, _transport) = world();
    let unit = MarkStateUnit::new(client.clone(), RES);
    assert_eq!(*unit.pending().borrow(), None);
    assert_eq!(*unit.assisting().borrow(), None);
    assert_eq!(*unit.progress().borrow(), None);

    client
        .mark
        .request(RES, requested_selector("hello"), Motivation::Highlighting);
    settle().await;
    assert_eq!(
        *unit.pending().borrow(),
        pending_of(quote("hello"), Motivation::Highlighting)
    );

    client.mark.cancel_pending();
    settle().await;
    assert_eq!(*unit.pending().borrow(), None);
}

#[tokio::test(start_paused = true)]
async fn mark_carries_a_selector_of_several_as_it_was_given() {
    let (client, _transport) = world();
    let unit = MarkStateUnit::new(client.clone(), RES);
    let several = json!([
        { "type": "TextPositionSelector", "start": 3.0, "end": 8.0 },
        { "type": "TextQuoteSelector", "exact": "hello", "prefix": "oh ", "suffix": " there" },
        { "type": "SvgSelector", "value": "<svg/>" },
        { "type": "FragmentSelector", "value": "page=2", "conformsTo": "http://tools.ietf.org/rfc/rfc3778" },
    ]);

    client.mark.request(
        RES,
        serde_json::from_value(several.clone()).expect("selectors"),
        Motivation::Linking,
    );
    settle().await;

    assert_eq!(
        *unit.pending().borrow(),
        pending_of(several, Motivation::Linking)
    );
}

#[tokio::test(start_paused = true)]
async fn mark_reads_a_quick_selection_as_the_selector_it_states() {
    let (client, _transport) = world();
    let unit = MarkStateUnit::new(client.clone(), RES);
    let cases = [
        (
            "mark:select-comment",
            json!({ "exact": "hello", "start": 0, "end": 5, "prefix": "oh ", "suffix": "" }),
            json!({ "type": "TextQuoteSelector", "exact": "hello", "prefix": "oh " }),
            Motivation::Commenting,
        ),
        (
            "mark:select-tag",
            json!({ "exact": "hello", "start": 0, "end": 5, "svgSelector": "<svg/>", "fragmentSelector": "page=2" }),
            json!({ "type": "SvgSelector", "value": "<svg/>" }),
            Motivation::Tagging,
        ),
        (
            "mark:select-assessment",
            json!({ "exact": "hello", "start": 0, "end": 5, "fragmentSelector": "page=2", "conformsTo": "http://tools.ietf.org/rfc/rfc3778" }),
            json!([
                { "type": "FragmentSelector", "value": "page=2", "conformsTo": "http://tools.ietf.org/rfc/rfc3778" },
                { "type": "TextQuoteSelector", "exact": "hello" },
            ]),
            Motivation::Assessing,
        ),
        (
            "mark:select-reference",
            json!({ "exact": "", "start": 0, "end": 0, "fragmentSelector": "page=2" }),
            json!([{ "type": "FragmentSelector", "value": "page=2" }]),
            Motivation::Linking,
        ),
    ];

    for (channel, selection, selector, motivation) in cases {
        say(&client, channel, selection);
        settle().await;
        assert_eq!(
            *unit.pending().borrow(),
            pending_of(selector, motivation),
            "{channel}"
        );
    }
}

#[tokio::test(start_paused = true)]
async fn mark_creates_what_is_submitted_and_it_stops_being_pending_once_recorded() {
    let transport = FaultyTransport::new(vec![FaultAction::Delay(Duration::from_secs(1))]);
    transport.queue_reply(
        "mark:create-request",
        [Some(json!({ "annotationId": "ann-new" }))],
    );
    let client = client_over(&transport);
    let unit = MarkStateUnit::new(client.clone(), RES);
    client
        .mark
        .request(RES, requested_selector("hello"), Motivation::Commenting);
    submit(&client, RES, "hello");
    settle().await;

    let sent = requests(&transport, "mark:create-request");
    assert_eq!(sent.len(), 1);
    assert_eq!(
        Value::Object(sent[0].payload.clone()),
        json!({
            "resourceId": RES,
            "request": {
                "motivation": "commenting",
                "target": { "source": RES, "selector": quote("hello") },
                "body": [{ "type": "TextualBody", "value": "a comment", "purpose": "commenting" }],
            },
        })
    );
    // Still pending: the knowledge base has not said it is recorded.
    assert!(unit.pending().borrow().is_some());

    tokio::time::sleep(Duration::from_secs(1)).await;
    settle().await;
    assert_eq!(*unit.pending().borrow(), None);
}

#[tokio::test(start_paused = true)]
async fn mark_keeps_its_pending_annotation_when_another_creation_is_recorded() {
    let (client, transport) = world();
    let unit = MarkStateUnit::new(client.clone(), RES);
    client
        .mark
        .request(RES, requested_selector("hello"), Motivation::Commenting);
    settle().await;

    // Another viewer's creation, replied to on the same client.
    transport.deliver(Frame {
        channel: "mark:create-ok".to_owned(),
        payload: object(json!({ "response": { "annotationId": "ann-other" } })),
        correlation_id: Some("somebody-else".to_owned()),
        scope: None,
        trace: None,
    });
    settle().await;

    assert!(unit.pending().borrow().is_some());
}

#[tokio::test(start_paused = true)]
async fn mark_says_a_creation_that_failed_and_keeps_the_annotation_pending() {
    let (client, _transport) = jobs();
    let unit = MarkStateUnit::new(client.clone(), RES);
    let mut errors = client.bus().frames("mark:create-error");
    client
        .mark
        .request(RES, requested_selector("hello"), Motivation::Commenting);
    submit(&client, RES, "hello");
    settle().await;

    assert_eq!(
        payloads(heard(&mut errors).await),
        [json!({ "resourceId": RES, "message": "mark:create-request is refused here" })]
    );
    assert!(unit.pending().borrow().is_some());
}

#[tokio::test(start_paused = true)]
async fn mark_deletes_an_annotation_of_its_resource_and_says_a_deletion_that_failed() {
    let (client, transport) = world();
    transport.queue_reply("mark:delete", [Some(json!({ "annotationId": "ann-1" }))]);
    let _unit = MarkStateUnit::new(client.clone(), RES);
    let mut errors = client.bus().frames("mark:delete-error");

    say(
        &client,
        "mark:delete",
        json!({ "annotationId": "ann-1", "resourceId": RES }),
    );
    settle().await;
    let sent = requests(&transport, "mark:delete");
    assert_eq!(sent.len(), 1);
    assert_eq!(
        Value::Object(sent[0].payload.clone()),
        json!({ "annotationId": "ann-1", "resourceId": RES })
    );
    assert!(heard(&mut errors).await.is_empty());

    // Nothing is scripted to answer the second.
    say(
        &client,
        "mark:delete",
        json!({ "annotationId": "ann-2", "resourceId": RES }),
    );
    settle().await;
    let said = payloads(heard(&mut errors).await);
    assert_eq!(said.len(), 1);
    assert_eq!(said[0]["resourceId"], RES);
    assert!(
        said[0]["message"]
            .as_str()
            .is_some_and(|m| m.contains("mark:delete")),
        "{said:?}"
    );
}

#[tokio::test(start_paused = true)]
async fn mark_deletes_only_what_is_said_to_be_of_its_resource() {
    let (client, transport) = world();
    transport.queue_reply("mark:delete", [Some(json!({ "annotationId": "ann-1" }))]);
    // Two resources are open on one client, each with its unit.
    let _here = MarkStateUnit::new(client.clone(), RES);
    let _there = MarkStateUnit::new(client.clone(), "res-2");

    say(
        &client,
        "mark:delete",
        json!({ "annotationId": "ann-1", "resourceId": "res-2" }),
    );
    // One that names no resource is no unit's to act on.
    say(&client, "mark:delete", json!({ "annotationId": "ann-9" }));
    settle().await;

    let sent: Vec<Value> = requests(&transport, "mark:delete")
        .into_iter()
        .map(|entry| Value::Object(entry.payload))
        .collect();
    assert_eq!(
        sent,
        [json!({ "annotationId": "ann-1", "resourceId": "res-2" })]
    );
}

fn ask_for_an_assist(client: &SemiontClient, options: Value) {
    client.mark.request_assist(
        Motivation::Highlighting,
        serde_json::from_value(options).expect("assist options"),
    );
}

/// The motivation a mark unit assists with, and the percentage it shows.
fn assisting(unit: &MarkStateUnit) -> (Option<Motivation>, Option<f64>) {
    (
        *unit.assisting().borrow(),
        unit.progress().borrow().as_ref().map(|p| p.percentage),
    )
}

const HIGHLIGHT: &str = "highlight-annotation";

#[tokio::test(start_paused = true)]
async fn mark_runs_the_assist_it_is_asked_for_and_shows_its_progress() {
    let (client, transport) = jobs();
    let unit = MarkStateUnit::new(client.clone(), RES);

    ask_for_an_assist(
        &client,
        json!({ "instructions": "the dates", "tone": "scholarly", "density": 3.0, "language": "fr" }),
    );
    settle().await;
    assert_eq!(assisting(&unit), (Some(Motivation::Highlighting), None));
    let created = requests(&transport, "job:create");
    assert_eq!(created.len(), 1);
    assert_eq!(
        Value::Object(created[0].payload.clone()),
        json!({
            "jobType": HIGHLIGHT,
            "resourceId": RES,
            "params": { "instructions": "the dates", "tone": "scholarly", "density": 3.0, "language": "fr" },
        })
    );

    say(&client, "job:report-progress", progress(HIGHLIGHT, 40.0));
    settle().await;
    assert_eq!(
        assisting(&unit),
        (Some(Motivation::Highlighting), Some(40.0))
    );

    // The finished run stays on show: only its motivation is let go.
    say(&client, "job:complete", job_frame(HIGHLIGHT, json!({})));
    settle().await;
    assert_eq!(assisting(&unit), (None, Some(40.0)));

    client.mark.dismiss_progress();
    settle().await;
    assert_eq!(assisting(&unit), (None, None));
}

#[tokio::test(start_paused = true)]
async fn mark_begins_each_assist_without_the_last_ones_progress() {
    let (client, _transport) = jobs();
    let unit = MarkStateUnit::new(client.clone(), RES);
    ask_for_an_assist(&client, json!({}));
    settle().await;
    say(&client, "job:report-progress", progress(HIGHLIGHT, 40.0));
    say(&client, "job:complete", job_frame(HIGHLIGHT, json!({})));
    settle().await;
    assert_eq!(assisting(&unit), (None, Some(40.0)));

    ask_for_an_assist(&client, json!({}));
    settle().await;
    assert_eq!(assisting(&unit), (Some(Motivation::Highlighting), None));
}

#[tokio::test(start_paused = true)]
async fn mark_clears_an_assist_that_fails_and_says_no_silence_of_it() {
    let (client, _transport) = jobs();
    let unit = MarkStateUnit::new(client.clone(), RES);
    let mut silences = client.bus().frames("mark:assist-timeout");
    ask_for_an_assist(&client, json!({}));
    settle().await;
    say(&client, "job:report-progress", progress(HIGHLIGHT, 40.0));
    settle().await;

    say(
        &client,
        "job:fail",
        job_frame(HIGHLIGHT, json!({ "error": "the model refused" })),
    );
    settle().await;
    assert_eq!(assisting(&unit), (None, None));

    tokio::time::sleep(ASSIST_SILENCE * 2).await;
    assert!(heard(&mut silences).await.is_empty());
}

#[tokio::test(start_paused = true)]
async fn mark_clears_an_assist_that_could_not_be_started() {
    // Nothing answers `job:create`.
    let (client, _transport) = world();
    let unit = MarkStateUnit::new(client.clone(), RES);

    ask_for_an_assist(&client, json!({}));
    settle().await;

    assert_eq!(assisting(&unit), (None, None));
}

#[tokio::test(start_paused = true)]
async fn mark_says_once_that_an_assist_has_gone_quiet_and_keeps_following_it() {
    let (client, _transport) = jobs();
    let unit = MarkStateUnit::new(client.clone(), RES);
    let mut silences = client.bus().frames("mark:assist-timeout");
    ask_for_an_assist(&client, json!({}));

    tokio::time::sleep(ASSIST_SILENCE - Duration::from_secs(1)).await;
    assert!(heard(&mut silences).await.is_empty());
    assert_eq!(assisting(&unit), (Some(Motivation::Highlighting), None));

    tokio::time::sleep(Duration::from_secs(2)).await;
    assert_eq!(
        payloads(heard(&mut silences).await),
        [json!({ "resourceId": RES, "motivation": "highlighting" })]
    );
    // Still assisting, as far as anyone here knows, and with something to show.
    assert_eq!(
        assisting(&unit),
        (Some(Motivation::Highlighting), Some(0.0))
    );

    // Said once, however long the silence lasts.
    tokio::time::sleep(ASSIST_SILENCE * 3).await;
    assert!(heard(&mut silences).await.is_empty());

    // A completion that arrives after all that still ends it.
    say(&client, "job:complete", job_frame(HIGHLIGHT, json!({})));
    settle().await;
    assert_eq!(assisting(&unit), (None, Some(0.0)));
}

#[tokio::test(start_paused = true)]
async fn mark_counts_an_assists_silence_from_the_last_thing_it_said() {
    let (client, _transport) = jobs();
    let unit = MarkStateUnit::new(client.clone(), RES);
    let mut silences = client.bus().frames("mark:assist-timeout");
    ask_for_an_assist(&client, json!({}));

    for step in 1..=3 {
        tokio::time::sleep(ASSIST_SILENCE - Duration::from_secs(10)).await;
        say(
            &client,
            "job:report-progress",
            progress(HIGHLIGHT, 10.0 * f64::from(step)),
        );
        settle().await;
    }
    // Three windows' worth of time, and never one of silence.
    assert!(heard(&mut silences).await.is_empty());
    assert_eq!(
        assisting(&unit),
        (Some(Motivation::Highlighting), Some(30.0))
    );

    // What it showed is left as it was when the silence does come.
    tokio::time::sleep(ASSIST_SILENCE + Duration::from_secs(1)).await;
    assert_eq!(heard(&mut silences).await.len(), 1);
    assert_eq!(
        assisting(&unit),
        (Some(Motivation::Highlighting), Some(30.0))
    );

    // And the next thing the job says starts the count again.
    say(&client, "job:report-progress", progress(HIGHLIGHT, 50.0));
    tokio::time::sleep(ASSIST_SILENCE + Duration::from_secs(1)).await;
    assert_eq!(heard(&mut silences).await.len(), 1);
}

#[tokio::test(start_paused = true)]
async fn mark_units_of_two_resources_on_one_client_each_answer_for_their_own() {
    let transport = FaultyTransport::new(vec![]);
    transport.queue_reply(
        "mark:create-request",
        [Some(json!({ "annotationId": "ann-new" }))],
    );
    let client = client_over(&transport);
    let first = MarkStateUnit::new(client.clone(), "res-a");
    let second = MarkStateUnit::new(client.clone(), "res-b");

    client.mark.request(
        "res-a",
        requested_selector("hello"),
        Motivation::Highlighting,
    );
    settle().await;
    assert!(first.pending().borrow().is_some());
    assert_eq!(*second.pending().borrow(), None);

    submit(&client, "res-a", "hello");
    settle().await;
    let sent = requests(&transport, "mark:create-request");
    assert_eq!(sent.len(), 1);
    assert_eq!(sent[0].payload["resourceId"], "res-a");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn mark_acts_on_what_it_hears_in_the_order_it_was_said() {
    let (client, _transport) = world();
    let unit = MarkStateUnit::new(client.clone(), RES);
    let mut pending = unit.pending();

    for round in 0..150 {
        let last = format!("round-{round}");
        client
            .mark
            .request(RES, requested_selector("first"), Motivation::Highlighting);
        client.mark.cancel_pending();
        client
            .mark
            .request(RES, requested_selector(&last), Motivation::Commenting);

        let wanted = pending_of(quote(&last), Motivation::Commenting);
        tokio::time::timeout(
            Duration::from_secs(10),
            pending.wait_for(|held| *held == wanted),
        )
        .await
        .expect("the last selection becomes the pending one")
        .expect("the unit lives");
        // The cancellation was said before it, so nothing is left to undo it.
        tokio::time::sleep(Duration::from_millis(2)).await;
        assert_eq!(*pending.borrow(), wanted, "round {round}");
    }
}

#[tokio::test(start_paused = true)]
async fn mark_disposed_is_inert() {
    let (client, transport) = jobs();
    let unit = MarkStateUnit::new(client.clone(), RES);
    ask_for_an_assist(&client, json!({}));
    settle().await;
    let mut pending = unit.pending();
    let mut motivation = unit.assisting();
    let mut shown = unit.progress();
    let mut said = client.bus().frames_among(&[
        "mark:assist-timeout",
        "mark:create-error",
        "mark:delete-error",
    ]);

    unit.dispose();
    client
        .mark
        .request(RES, requested_selector("hello"), Motivation::Commenting);
    submit(&client, RES, "hello");
    say(
        &client,
        "mark:delete",
        json!({ "annotationId": "ann-1", "resourceId": RES }),
    );
    say(&client, "job:report-progress", progress(HIGHLIGHT, 40.0));
    ask_for_an_assist(&client, json!({}));
    tokio::time::sleep(ASSIST_SILENCE * 2).await;

    assert!(pending.ended() && motivation.ended() && shown.ended());
    assert_eq!(*pending.borrow(), None);
    assert_eq!(*shown.borrow(), None);
    assert!(heard(&mut said).await.is_empty());
    assert_eq!(requests(&transport, "job:create").len(), 1);
    assert!(requests(&transport, "mark:create-request").is_empty());
    assert!(requests(&transport, "mark:delete").is_empty());
    assert!(!client.bus().destroyed());
}

struct Marks;

impl AxiomSubject for Marks {
    type Unit = MarkStateUnit;

    fn setup(&self) -> Fresh<MarkStateUnit> {
        let (client, _transport) = world();
        Fresh::of(MarkStateUnit::new(client.clone(), RES)).given(client)
    }

    fn surfaces(&self, unit: &MarkStateUnit) -> Vec<Box<dyn Surface>> {
        vec![
            Box::new(unit.pending()),
            Box::new(unit.assisting()),
            Box::new(unit.progress()),
        ]
    }
}

#[test]
fn mark_keeps_the_state_unit_axioms() {
    assert_eq!(assert_state_unit_axioms(&Marks), Ok(()));
}

// ── The search pipeline ─────────────────────────────────────────────────

type Answers = mpsc::UnboundedSender<Option<Vec<String>>>;

/// What a pipeline searches with here: it records each query, and answers
/// when the test says so, through the sender it keeps for that search.
#[derive(Clone, Default)]
struct Searches {
    asked: Arc<Mutex<Vec<(String, Answers)>>>,
}

impl Searches {
    fn pipeline(&self, options: SearchPipelineOptions) -> SearchPipeline<String> {
        let asked = self.asked.clone();
        SearchPipeline::new(
            move |query: &str| {
                let (answers, stream) = mpsc::unbounded_channel();
                asked
                    .lock()
                    .expect("asked")
                    .push((query.to_owned(), answers));
                UnboundedReceiverStream::new(stream)
            },
            options,
        )
    }

    fn queries(&self) -> Vec<String> {
        self.asked
            .lock()
            .expect("asked")
            .iter()
            .map(|(query, _)| query.clone())
            .collect()
    }

    /// Answer the `nth` search.
    fn answer(&self, nth: usize, results: Option<&[&str]>) {
        let answer = results.map(|found| found.iter().map(|one| (*one).to_owned()).collect());
        // A search that was abandoned has nobody to answer.
        let _ = self.asked.lock().expect("asked")[nth].1.send(answer);
    }
}

fn found(results: &[&str], is_searching: bool) -> SearchState<String> {
    SearchState {
        results: results.iter().map(|one| (*one).to_owned()).collect(),
        is_searching,
    }
}

fn typing(initial_query: &str) -> SearchPipelineOptions {
    SearchPipelineOptions {
        initial_query: initial_query.to_owned(),
        ..SearchPipelineOptions::default()
    }
}

async fn settled() {
    tokio::time::sleep(SEARCH_DEBOUNCE + Duration::from_millis(1)).await;
}

#[tokio::test(start_paused = true)]
async fn a_search_begins_idle_and_a_query_of_nothing_searches_for_nothing() {
    let searches = Searches::default();
    let pipeline = searches.pipeline(SearchPipelineOptions::default());
    assert_eq!(*pipeline.state().borrow(), found(&[], false));
    assert_eq!(*pipeline.query().borrow(), "");

    settled().await;
    pipeline.set_query("   ");
    settled().await;

    assert!(searches.queries().is_empty());
    assert_eq!(*pipeline.state().borrow(), found(&[], false));
}

#[tokio::test(start_paused = true)]
async fn a_search_waits_for_the_query_to_stay_the_same() {
    let searches = Searches::default();
    let pipeline = searches.pipeline(SearchPipelineOptions::default());

    for typed in ["p", "pa", "par", "pari", "paris"] {
        pipeline.set_query(typed);
        // The query is what was typed, at once.
        assert_eq!(*pipeline.query().borrow(), typed);
        tokio::time::sleep(SEARCH_DEBOUNCE / 2).await;
    }
    assert!(searches.queries().is_empty());

    settled().await;
    assert_eq!(searches.queries(), ["paris"]);
}

#[tokio::test(start_paused = true)]
async fn a_search_waits_as_long_as_it_was_told() {
    let searches = Searches::default();
    let pipeline = searches.pipeline(SearchPipelineOptions {
        debounce: Duration::from_secs(2),
        ..SearchPipelineOptions::default()
    });

    pipeline.set_query("paris");
    tokio::time::sleep(Duration::from_millis(1900)).await;
    assert!(searches.queries().is_empty());
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(searches.queries(), ["paris"]);
}

#[tokio::test(start_paused = true)]
async fn a_search_begun_with_a_query_searches_for_it_once_it_has_settled() {
    let searches = Searches::default();
    let pipeline = searches.pipeline(typing(" paris "));
    assert_eq!(*pipeline.query().borrow(), " paris ");
    assert!(searches.queries().is_empty());

    settled().await;
    // Searched for without the spaces around it.
    assert_eq!(searches.queries(), ["paris"]);
}

#[tokio::test(start_paused = true)]
async fn a_search_is_searching_until_its_results_are_known_and_follows_them_after() {
    let searches = Searches::default();
    let pipeline = searches.pipeline(typing("paris"));
    settled().await;
    assert_eq!(*pipeline.state().borrow(), found(&[], true));

    // An answer on its way is still a search.
    searches.answer(0, None);
    settle().await;
    assert_eq!(*pipeline.state().borrow(), found(&[], true));

    searches.answer(0, Some(&["Paris", "Paris, Texas"]));
    settle().await;
    assert_eq!(
        *pipeline.state().borrow(),
        found(&["Paris", "Paris, Texas"], false)
    );

    // The results change under a query that did not.
    searches.answer(0, Some(&["Paris"]));
    settle().await;
    assert_eq!(*pipeline.state().borrow(), found(&["Paris"], false));
}

#[tokio::test(start_paused = true)]
async fn a_new_query_abandons_the_search_before_it() {
    let searches = Searches::default();
    let pipeline = searches.pipeline(typing("paris"));
    settled().await;

    pipeline.set_query("rome");
    settled().await;
    assert_eq!(searches.queries(), ["paris", "rome"]);
    assert_eq!(*pipeline.state().borrow(), found(&[], true));

    // The first search's answer comes late, and is nobody's.
    searches.answer(0, Some(&["Paris"]));
    settle().await;
    assert_eq!(*pipeline.state().borrow(), found(&[], true));

    searches.answer(1, Some(&["Rome"]));
    settle().await;
    assert_eq!(*pipeline.state().borrow(), found(&["Rome"], false));
}

#[tokio::test(start_paused = true)]
async fn a_query_already_searched_for_is_not_searched_for_again() {
    let searches = Searches::default();
    let pipeline = searches.pipeline(typing("paris"));
    settled().await;
    searches.answer(0, Some(&["Paris"]));

    // Typed away from and back to, inside the debounce.
    pipeline.set_query("pari");
    pipeline.set_query("paris");
    settled().await;

    assert_eq!(searches.queries(), ["paris"]);
    assert_eq!(*pipeline.state().borrow(), found(&["Paris"], false));
}

#[tokio::test(start_paused = true)]
async fn a_query_that_is_cleared_has_no_results_and_abandons_its_search() {
    let searches = Searches::default();
    let pipeline = searches.pipeline(typing("paris"));
    settled().await;
    searches.answer(0, Some(&["Paris"]));
    settle().await;

    pipeline.set_query("");
    settled().await;
    assert_eq!(*pipeline.state().borrow(), found(&[], false));

    searches.answer(0, Some(&["Paris", "Paris, Texas"]));
    settle().await;
    assert_eq!(*pipeline.state().borrow(), found(&[], false));
    assert_eq!(searches.queries(), ["paris"]);
}

#[tokio::test(start_paused = true)]
async fn a_search_disposed_is_inert() {
    let searches = Searches::default();
    let pipeline = searches.pipeline(typing("paris"));
    let mut query = pipeline.query();
    let mut state = pipeline.state();

    pipeline.dispose();
    pipeline.set_query("rome");
    settled().await;

    assert!(query.ended() && state.ended());
    assert_eq!(*query.borrow(), "paris");
    assert!(searches.queries().is_empty());
}

struct Pipelines;

impl AxiomSubject for Pipelines {
    type Unit = SearchPipeline<String>;

    fn setup(&self) -> Fresh<SearchPipeline<String>> {
        Fresh::of(Searches::default().pipeline(SearchPipelineOptions::default()))
    }

    fn surfaces(&self, unit: &SearchPipeline<String>) -> Vec<Box<dyn Surface>> {
        vec![Box::new(unit.query()), Box::new(unit.state())]
    }

    fn invocations<'a>(&self, unit: &'a SearchPipeline<String>) -> Vec<Box<dyn Fn() + 'a>> {
        vec![
            Box::new(|| unit.set_query("paris")),
            Box::new(|| unit.set_query("rome")),
        ]
    }
}

#[test]
fn the_search_pipeline_keeps_the_state_unit_axioms() {
    assert_eq!(assert_state_unit_axioms(&Pipelines), Ok(()));
}
