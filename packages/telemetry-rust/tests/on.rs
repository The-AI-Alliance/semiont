//! A process that installed its own OpenTelemetry. Every row of the SDK
//! telemetry table (specs/src/sdk-telemetry/telemetry.json) is what one of
//! this crate's functions records, of the row's kind and with its attributes,
//! and nothing else is recorded under a row's name: a row added to the table
//! with no function here fails this. Its own binary, because what a process
//! installed is the process's.

use opentelemetry::global;
use opentelemetry::trace::{SpanKind, TraceContextExt};
use opentelemetry_sdk::metrics::data::{AggregatedMetrics, MetricData};
use opentelemetry_sdk::metrics::{InMemoryMetricExporter, SdkMeterProvider};
use opentelemetry_sdk::propagation::TraceContextPropagator;
use opentelemetry_sdk::trace::{InMemorySpanExporter, SdkTracerProvider, SpanData};
use semiont::testing::examples::assert_readme_shows;
use semiont::transport::TraceCarrier;
use semiont_telemetry::{
    active_trace, active_trace_id, bus_emit, bus_recv, content_get, content_get_graph, content_put,
    continued, continuing, in_span_now,
};
use serde_json::Value;

const SENDER: &str = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01";
const SENDERS_TRACE: &str = "0af7651916cd43dd8448eb211c80319c";
const SENDERS_SPAN: &str = "b7ad6b7169203331";
const SCOPE: &str = "res-1";

fn table() -> Value {
    serde_json::from_str(include_str!("../specs/telemetry.json"))
        .expect("the SDK telemetry table is JSON")
}

fn rows<'a>(table: &'a Value, of: &str) -> &'a Vec<Value> {
    table[of].as_array().expect("the table lists them")
}

/// Whether `name` is the row's: `{channel}` stands for any channel.
fn named(row: &Value, name: &str) -> bool {
    let pattern = row["name"].as_str().expect("a row has a name");
    match pattern.strip_suffix("{channel}") {
        Some(prefix) => name.starts_with(prefix),
        None => name == pattern,
    }
}

/// `keys` against a row: every attribute the row always carries, and none it
/// does not list.
fn held_to(row: &Value, what: &str, keys: &[String]) {
    let listed = row["attributes"]
        .as_array()
        .expect("a row lists attributes");
    for attribute in listed {
        let key = attribute["key"].as_str().expect("an attribute has a key");
        if attribute.get("only").is_none() {
            assert!(keys.iter().any(|k| k == key), "{what} carries no {key}");
        }
    }
    for key in keys {
        assert!(
            listed
                .iter()
                .any(|attribute| attribute["key"] == key.as_str()),
            "{what} carries {key}, which its row does not list"
        );
    }
}

fn keys(span: &SpanData) -> Vec<String> {
    span.attributes
        .iter()
        .map(|attribute| attribute.key.to_string())
        .collect()
}

#[tokio::test]
async fn every_row_of_the_sdk_telemetry_table_is_what_a_function_here_records() {
    let spans = InMemorySpanExporter::default();
    let metrics = InMemoryMetricExporter::default();
    let meter_provider = SdkMeterProvider::builder()
        .with_periodic_exporter(metrics.clone())
        .build();
    let tracer_provider = SdkTracerProvider::builder()
        .with_simple_exporter(spans.clone())
        .build();
    // <readme:install>
    // A tracer provider, a meter provider and the W3C propagator, as the
    // process's: what this crate, and so the transport, reports to.
    global::set_text_map_propagator(TraceContextPropagator::new());
    global::set_tracer_provider(tracer_provider);
    global::set_meter_provider(meter_provider.clone());
    // The bus log's `trace=` field is the active span's trace.
    semiont::bus_log::set_trace_id_provider(semiont_telemetry::active_trace_id);
    // </readme:install>

    // Each function, with and without what its row lists as conditional.
    let leaving = bus_emit("beckon:sparkle", None, async { active_trace() })
        .await
        .expect("an emit runs in a span");
    bus_emit("mark:added", Some(SCOPE), async {}).await;
    let handed_on = bus_recv(
        "beckon:focus",
        None,
        Some(TraceCarrier {
            traceparent: SENDER.to_owned(),
            tracestate: None,
        }),
    )
    .expect("a frame's trace is handed on");
    bus_recv("mark:added", Some(SCOPE), None);
    let upload = async { "res-2" };
    // <readme:row>
    // The span's name, its kind and its attributes are the table's.
    let created = content_put("image/png", 256, upload).await;
    // </readme:row>
    assert_eq!(created, "res-2");
    content_get(SCOPE, false, async {}).await;
    content_get(SCOPE, true, async {}).await;
    content_get_graph(SCOPE, async {}).await;

    let table = table();
    let finished = spans.get_finished_spans().expect("the spans exported");
    for row in rows(&table, "spans") {
        let name = row["name"].as_str().expect("a row has a name");
        let of_row: Vec<&SpanData> = finished
            .iter()
            .filter(|span| named(row, &span.name))
            .collect();
        assert!(!of_row.is_empty(), "no function here records {name}");
        let kind = match row["kind"].as_str().expect("a span row has a kind") {
            "producer" => SpanKind::Producer,
            "consumer" => SpanKind::Consumer,
            "client" => SpanKind::Client,
            other => panic!("{name} is of kind {other}, which no function here records"),
        };
        for span in of_row {
            assert_eq!(span.span_kind, kind, "{}", span.name);
            held_to(row, &span.name, &keys(span));
        }
    }
    for span in &finished {
        assert!(
            rows(&table, "spans")
                .iter()
                .any(|row| named(row, &span.name)),
            "{} is no row of the table",
            span.name
        );
    }

    meter_provider.force_flush().expect("the metrics exported");
    let exported = metrics.get_finished_metrics().expect("the metrics");
    let latest = exported.last().expect("an export");
    let counted: Vec<_> = latest
        .scope_metrics()
        .flat_map(|scope| scope.metrics())
        .collect();
    for row in rows(&table, "metrics") {
        let name = row["name"].as_str().expect("a row has a name");
        assert_eq!(row["instrument"], "counter", "{name}");
        let of_row: Vec<_> = counted
            .iter()
            .filter(|metric| metric.name() == name)
            .collect();
        assert_eq!(of_row.len(), 1, "one {name} stream");
        let AggregatedMetrics::U64(MetricData::Sum(sum)) = of_row[0].data() else {
            panic!("{name} is not a count: {:?}", of_row[0].data());
        };
        assert!(sum.is_monotonic(), "{name}");
        // One emit on each of two channels: two points, of one each.
        let points: Vec<_> = sum.data_points().collect();
        assert_eq!(points.len(), 2, "{name}");
        for point in points {
            assert_eq!(point.value(), 1, "{name}");
            let keys: Vec<String> = point.attributes().map(|a| a.key.to_string()).collect();
            held_to(row, name, &keys);
        }
    }
    for metric in &counted {
        assert!(
            rows(&table, "metrics")
                .iter()
                .any(|row| row["name"] == metric.name()),
            "{} is no row of the table",
            metric.name()
        );
    }

    // An emit leaves under its own span's trace.
    let emitted = finished
        .iter()
        .find(|span| span.name == "bus.emit:beckon:sparkle")
        .expect("the emit's span");
    assert_eq!(
        leaving.traceparent,
        format!(
            "00-{}-{}-01",
            emitted.span_context.trace_id(),
            emitted.span_context.span_id()
        )
    );

    // A frame's span continues its sender's trace, and is what is handed on.
    let received = finished
        .iter()
        .find(|span| span.name == "bus.recv:beckon:focus")
        .expect("the frame's span");
    assert_eq!(received.span_context.trace_id().to_string(), SENDERS_TRACE);
    assert_eq!(received.parent_span_id.to_string(), SENDERS_SPAN);
    assert_eq!(
        handed_on.traceparent,
        format!("00-{SENDERS_TRACE}-{}-01", received.span_context.span_id())
    );

    // What is done for a frame, or for a caller, is in the trace it came in.
    let sent_under = TraceCarrier {
        traceparent: SENDER.to_owned(),
        tracestate: None,
    };
    assert_eq!(
        continuing(Some(&sent_under), async { active_trace_id() }).await,
        Some(SENDERS_TRACE.to_owned())
    );
    let caller = continued(Some(SENDER), None);
    assert_eq!(
        caller.span().span_context().span_id().to_string(),
        SENDERS_SPAN
    );
    let within = in_span_now(
        "a service's own".to_owned(),
        SpanKind::Server,
        Vec::new(),
        &caller,
        active_trace_id,
    );
    assert_eq!(within, Some(SENDERS_TRACE.to_owned()));
}

#[test]
fn the_readmes_examples_are_this_files() {
    assert_readme_shows(include_str!("../README.md"), &[include_str!("on.rs")])
        .expect("the README shows what runs here");
}
