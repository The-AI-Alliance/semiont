//! The state units over a client: each held to the state-unit axioms, and
//! what the behaviour table (specs/src/client/state-units.json, run by
//! `state_cases.rs`) cannot state.
//!
//! A unit acts on what it hears a turn of the runtime later, so a test says
//! something, lets what is ready run (`settle`), and then reads. Every wait
//! here is bounded: a unit that never acts fails its test, and does not
//! hang it.

use semiont::client::SemiontClient;
use semiont::state::{
    BeckonStateUnit, GatherStateUnit, HoverDwell, MarkStateUnit, MatchStateUnit, PendingAnnotation,
    SearchPipeline, SearchPipelineOptions, YieldStateUnit,
};
use semiont::testing::as_id;
use semiont::testing::axioms::{AxiomSubject, Fresh, Surface, assert_state_unit_axioms};
use semiont::testing::{FaultyTransport, TestClientOptions, create_test_client};
use semiont::timing::HOVER_DELAY;
use semiont::types::{
    AnnotationSelector, GatherAnnotationOptions, GatherResourceRequestOptions, GenerationJobParams,
    MarkJobParams, Motivation,
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

/// Let what is ready run: signals are heard, requests are sent, and replies
/// already delivered are read.
async fn settle() {
    tokio::time::sleep(Duration::from_millis(1)).await;
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

#[tokio::test(start_paused = true)]
async fn a_state_set_to_what_it_already_is_wakes_nobody() {
    let (client, _transport) = world();
    let unit = BeckonStateUnit::new(client.clone());
    let mut hovered = unit.hovered_annotation_id();

    client.beckon.hover(Some(&as_id("ann-1")));
    settle().await;
    assert!(hovered.moved());

    client.beckon.hover(Some(&as_id("ann-1")));
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
        vec![Box::new(unit.hovered_annotation_id())]
    }

    fn invocations<'a>(&self, unit: &'a BeckonStateUnit) -> Vec<Box<dyn Fn() + 'a>> {
        vec![Box::new(|| unit.focus(&as_id("ann-1")))]
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
                .push(hovered.map(ToString::to_string))
        },
        delay,
    );
    (dwell, said)
}

struct Dwells;

impl AxiomSubject for Dwells {
    type Unit = HoverDwell;

    fn setup(&self) -> Fresh<HoverDwell> {
        Fresh::of(dwell(HOVER_DELAY).0)
    }

    fn invocations<'a>(&self, unit: &'a HoverDwell) -> Vec<Box<dyn Fn() + 'a>> {
        vec![
            Box::new(|| unit.enter(&as_id("ann-1"))),
            Box::new(|| unit.leave()),
        ]
    }
}

#[test]
fn the_dwell_keeps_the_state_unit_axioms() {
    assert_eq!(assert_state_unit_axioms(&Dwells), Ok(()));
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

struct Gatherings;

impl AxiomSubject for Gatherings {
    type Unit = GatherStateUnit;

    fn setup(&self) -> Fresh<GatherStateUnit> {
        let (client, _transport) = world();
        Fresh::of(GatherStateUnit::new(client.clone(), &as_id(RES))).given(client)
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
        vec![
            Box::new(|| {
                unit.gather_annotation(&as_id("ann-1"), GatherAnnotationOptions::default())
            }),
            Box::new(|| {
                unit.gather_resource(&as_id(RES), GatherResourceRequestOptions::default());
            }),
        ]
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
            Box::new(unit.job_id()),
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

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn mark_acts_on_what_it_hears_in_the_order_it_was_said() {
    let (client, _transport) = world();
    let unit = MarkStateUnit::new(client.clone(), &as_id(RES));
    let mut pending = unit.pending_annotation();

    for round in 0..150 {
        let last = format!("round-{round}");
        client.mark.request(
            &as_id(RES),
            requested_selector("first"),
            Motivation::Highlighting,
        );
        unit.cancel_pending();
        client.mark.request(
            &as_id(RES),
            requested_selector(&last),
            Motivation::Commenting,
        );

        let wanted = pending_of(quote(&last), Motivation::Commenting);
        tokio::time::timeout(
            Duration::from_secs(10),
            pending.wait_for(|held| *held == wanted),
        )
        .await
        .expect("the last selection becomes the pending one")
        .expect("the unit lives");
        // The cancellation was asked before it, so nothing is left to undo it.
        tokio::time::sleep(Duration::from_millis(2)).await;
        assert_eq!(*pending.borrow(), wanted, "round {round}");
    }
}

fn highlighting() -> MarkJobParams {
    serde_json::from_value(json!({ "motivation": "highlighting" })).expect("mark params")
}

struct Marks;

impl AxiomSubject for Marks {
    type Unit = MarkStateUnit;

    fn setup(&self) -> Fresh<MarkStateUnit> {
        let (client, _transport) = world();
        Fresh::of(MarkStateUnit::new(client.clone(), &as_id(RES))).given(client)
    }

    fn surfaces(&self, unit: &MarkStateUnit) -> Vec<Box<dyn Surface>> {
        vec![
            Box::new(unit.pending_annotation()),
            Box::new(unit.delegating_motivation()),
            Box::new(unit.progress()),
            Box::new(unit.progress_motivation()),
            Box::new(unit.failure()),
            Box::new(unit.job_id()),
        ]
    }

    fn invocations<'a>(&self, unit: &'a MarkStateUnit) -> Vec<Box<dyn Fn() + 'a>> {
        vec![
            Box::new(|| unit.request_delegate(highlighting())),
            Box::new(|| unit.cancel_pending()),
            Box::new(|| unit.dismiss_progress()),
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
