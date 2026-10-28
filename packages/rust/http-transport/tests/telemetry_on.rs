//! The transport in a process that installs its own OpenTelemetry, after the
//! client is open: the spans and the count of the SDK telemetry table
//! (specs/src/sdk-telemetry/telemetry.json) reach what was installed, an emit
//! carries its span's trace, and a frame's span continues its sender's. Its
//! own binary, because what a process installed is the process's.

mod telemetry_gateway;

use opentelemetry::global;
use opentelemetry::trace::SpanKind;
use opentelemetry_sdk::metrics::data::{AggregatedMetrics, MetricData};
use opentelemetry_sdk::metrics::{InMemoryMetricExporter, SdkMeterProvider};
use opentelemetry_sdk::propagation::TraceContextPropagator;
use opentelemetry_sdk::trace::{InMemorySpanExporter, SdkTracerProvider, SpanData};
use semiont::transport::{Envelope, Transport};
use telemetry_gateway::{Gateway, HEARD, SENT, sparkle};

const SENDER: &str = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01";
const EMITS: usize = 3;

/// The trace id and the span id of a `traceparent`.
fn ids(traceparent: &str) -> (String, String) {
    let parts: Vec<&str> = traceparent.split('-').collect();
    assert_eq!(parts.len(), 4, "{traceparent} is not a traceparent");
    (parts[1].to_owned(), parts[2].to_owned())
}

fn attributes(span: &SpanData) -> Vec<(String, String)> {
    span.attributes
        .iter()
        .map(|attribute| (attribute.key.to_string(), attribute.value.to_string()))
        .collect()
}

#[tokio::test(flavor = "multi_thread")]
async fn telemetry_installed_after_the_client_opened_is_what_the_transport_reports_to() {
    let gateway = Gateway::start().await;
    let transport = gateway.client().await;

    let spans = InMemorySpanExporter::default();
    let metrics = InMemoryMetricExporter::default();
    let meter_provider = SdkMeterProvider::builder()
        .with_periodic_exporter(metrics.clone())
        .build();
    global::set_text_map_propagator(TraceContextPropagator::new());
    global::set_tracer_provider(
        SdkTracerProvider::builder()
            .with_simple_exporter(spans.clone())
            .build(),
    );
    global::set_meter_provider(meter_provider.clone());

    for _ in 0..EMITS {
        transport
            .emit(SENT, sparkle(), Envelope::default())
            .await
            .expect("the emit is accepted");
    }
    let frame = gateway.deliver(&transport, SENDER).await;
    let finished = spans.get_finished_spans().expect("the spans exported");

    // Each emit left under its own span's trace.
    let emitted: Vec<&SpanData> = finished
        .iter()
        .filter(|span| span.name == format!("bus.emit:{SENT}"))
        .collect();
    assert_eq!(emitted.len(), EMITS, "one bus.emit span an emit");
    for span in &emitted {
        assert_eq!(span.span_kind, SpanKind::Producer);
        assert_eq!(
            attributes(span),
            [("bus.channel".to_owned(), SENT.to_owned())]
        );
    }
    let mut left: Vec<(String, String)> = gateway
        .traceparents()
        .into_iter()
        .map(|traceparent| ids(&traceparent.expect("an emit carries a traceparent")))
        .collect();
    let mut made: Vec<(String, String)> = emitted
        .iter()
        .map(|span| {
            (
                span.span_context.trace_id().to_string(),
                span.span_context.span_id().to_string(),
            )
        })
        .collect();
    left.sort();
    made.sort();
    assert_eq!(left, made, "each emit names its own span");

    // The frame's span continues its sender's trace, and is what is handed on.
    let (senders_trace, senders_span) = ids(SENDER);
    let received: Vec<&SpanData> = finished
        .iter()
        .filter(|span| span.name == format!("bus.recv:{HEARD}"))
        .collect();
    assert_eq!(received.len(), 1, "one bus.recv span a frame");
    let received = received[0];
    assert_eq!(received.span_kind, SpanKind::Consumer);
    assert_eq!(
        attributes(received),
        [("bus.channel".to_owned(), HEARD.to_owned())]
    );
    assert_eq!(received.span_context.trace_id().to_string(), senders_trace);
    assert_eq!(received.parent_span_id.to_string(), senders_span);
    let handed_on = ids(&frame.trace.expect("the frame carries a trace").traceparent);
    assert_eq!(
        handed_on,
        (senders_trace, received.span_context.span_id().to_string())
    );

    // The emits are one count, not one a call.
    meter_provider.force_flush().expect("the metrics exported");
    let exported = metrics.get_finished_metrics().expect("the metrics");
    let latest = exported.last().expect("an export");
    let sent: Vec<_> = latest
        .scope_metrics()
        .flat_map(|scope| scope.metrics())
        .filter(|metric| metric.name() == "semiont.bus.sent")
        .collect();
    assert_eq!(sent.len(), 1, "one semiont.bus.sent stream");
    let AggregatedMetrics::U64(MetricData::Sum(sum)) = sent[0].data() else {
        panic!("semiont.bus.sent is not a count: {:?}", sent[0].data());
    };
    let points: Vec<(u64, Vec<(String, String)>)> = sum
        .data_points()
        .map(|point| {
            (
                point.value(),
                point
                    .attributes()
                    .map(|attribute| (attribute.key.to_string(), attribute.value.to_string()))
                    .collect(),
            )
        })
        .collect();
    assert_eq!(
        points,
        [(
            EMITS as u64,
            vec![("bus.channel".to_owned(), SENT.to_owned())]
        )]
    );
}
