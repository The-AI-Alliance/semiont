//! The telemetry a Semiont transport and a Semiont service share, reported to
//! whatever OpenTelemetry the process installed: nothing here exports, and
//! with nothing installed no span is recorded and no trace context travels.
//!
//! A transport reports through one function per row of the SDK telemetry
//! table (specs/src/sdk-telemetry/telemetry.json): [`bus_emit`], which is
//! also the `semiont.bus.sent` count, [`bus_recv`], [`content_put`],
//! [`content_get`] and [`content_get_graph`]. It names no span, kind or
//! attribute of its own, and puts [`active_trace`] on what it sends.
//!
//! A service's own spans are the service telemetry table's, which it states
//! itself over [`in_span`] and [`in_span_now`], continuing a caller's trace
//! with [`continued`] and a frame's with [`continuing`].
//!
//! The tracer, the meter and the propagator are taken from
//! `opentelemetry::global` at each use, so telemetry installed after a client
//! opened is reported to all the same.

#![forbid(unsafe_code)]
// A failure is a value its caller is given: outside the tests nothing
// unwraps one away.
#![cfg_attr(not(test), deny(clippy::unwrap_used, clippy::expect_used))]

use opentelemetry::context::FutureExt;
use opentelemetry::trace::{SpanKind, TraceContextExt, Tracer};
use opentelemetry::{Context, KeyValue, global};
use semiont::transport::TraceCarrier;
use std::collections::HashMap;
use std::future::Future;

/// The instrumentation scope every span and count here is made under.
const SCOPE: &str = "semiont";

// ── The SDK telemetry table ──────────────────────────────────────────────

/// `bus.emit:{channel}` and `semiont.bus.sent`: an emit a client sent, counted
/// and run in a span of the trace that sent it.
pub async fn bus_emit<T>(channel: &str, scope: Option<&str>, send: impl Future<Output = T>) -> T {
    let attributes = on_the_bus(channel, scope);
    global::meter(SCOPE)
        .u64_counter("semiont.bus.sent")
        .with_description("Emits sent")
        .build()
        .add(1, &attributes);
    in_span(
        format!("bus.emit:{channel}"),
        SpanKind::Producer,
        attributes,
        Context::current(),
        send,
    )
    .await
}

/// `bus.recv:{channel}`: a frame's arrival, in the trace it was sent under.
/// Answers the trace that what is done for the frame continues: the span's
/// own, or, when nothing records one, the one the frame came with.
pub fn bus_recv(
    channel: &str,
    scope: Option<&str>,
    sent_under: Option<TraceCarrier>,
) -> Option<TraceCarrier> {
    let parent = continued(
        sent_under.as_ref().map(|t| t.traceparent.as_str()),
        sent_under.as_ref().and_then(|t| t.tracestate.as_deref()),
    );
    in_span_now(
        format!("bus.recv:{channel}"),
        SpanKind::Consumer,
        on_the_bus(channel, scope),
        &parent,
        active_trace,
    )
    .or(sent_under)
}

/// `content.put`: an upload.
pub async fn content_put<T>(format: &str, size_bytes: u64, upload: impl Future<Output = T>) -> T {
    in_span(
        "content.put".to_owned(),
        SpanKind::Client,
        vec![
            KeyValue::new("content.format", format.to_owned()),
            KeyValue::new(
                "content.size_bytes",
                i64::try_from(size_bytes).unwrap_or(i64::MAX),
            ),
        ],
        Context::current(),
        upload,
    )
    .await
}

/// `content.get`: a read of a resource's bytes, whole or as a `stream`.
pub async fn content_get<T>(resource_id: &str, stream: bool, read: impl Future<Output = T>) -> T {
    let mut attributes = vec![KeyValue::new("resource.id", resource_id.to_owned())];
    if stream {
        attributes.push(KeyValue::new("content.stream", true));
    }
    in_span(
        "content.get".to_owned(),
        SpanKind::Client,
        attributes,
        Context::current(),
        read,
    )
    .await
}

/// `content.get_graph`: a read of a resource's description.
pub async fn content_get_graph<T>(resource_id: &str, read: impl Future<Output = T>) -> T {
    in_span(
        "content.get_graph".to_owned(),
        SpanKind::Client,
        vec![KeyValue::new("resource.id", resource_id.to_owned())],
        Context::current(),
        read,
    )
    .await
}

/// What a span or a count of the bus carries: the channel, and the scope
/// when there is one.
pub fn on_the_bus(channel: &str, scope: Option<&str>) -> Vec<KeyValue> {
    let mut attributes = vec![KeyValue::new("bus.channel", channel.to_owned())];
    if let Some(scope) = scope {
        attributes.push(KeyValue::new("bus.scope", scope.to_owned()));
    }
    attributes
}

// ── Trace context ────────────────────────────────────────────────────────

/// The W3C trace context a caller sent (`traceparent`, `tracestate`), as the
/// parent of what is done for it; the current context when it sent none, or
/// when the process installed no propagator.
pub fn continued(traceparent: Option<&str>, tracestate: Option<&str>) -> Context {
    let Some(traceparent) = traceparent else {
        return Context::current();
    };
    let mut carrier = HashMap::from([("traceparent".to_owned(), traceparent.to_owned())]);
    if let Some(state) = tracestate {
        carrier.insert("tracestate".to_owned(), state.to_owned());
    }
    global::get_text_map_propagator(|propagator| {
        propagator.extract_with_context(&Context::current(), &carrier)
    })
}

/// Run `work` in the trace a frame arrived in: what is done for it, and what
/// is sent in answer, belongs to the sender's trace.
pub async fn continuing<T>(trace: Option<&TraceCarrier>, work: impl Future<Output = T>) -> T {
    let context = continued(
        trace.map(|t| t.traceparent.as_str()),
        trace.and_then(|t| t.tracestate.as_deref()),
    );
    work.with_context(context).await
}

/// The active span's W3C trace context, when a span is active: what a
/// transport puts on what it sends.
pub fn active_trace() -> Option<TraceCarrier> {
    let context = Context::current();
    if !context.span().span_context().is_valid() {
        return None;
    }
    let mut carrier: HashMap<String, String> = HashMap::new();
    global::get_text_map_propagator(|propagator| {
        propagator.inject_context(&context, &mut carrier);
    });
    Some(TraceCarrier {
        traceparent: carrier.remove("traceparent")?,
        tracestate: carrier.remove("tracestate").filter(|s| !s.is_empty()),
    })
}

/// The active span's trace id, when a span is active: what the bus log's
/// `trace=` field reads (`semiont::bus_log::set_trace_id_provider`).
pub fn active_trace_id() -> Option<String> {
    let context = Context::current();
    let span = context.span();
    let span_context = span.span_context();
    span_context
        .is_valid()
        .then(|| span_context.trace_id().to_string())
}

fn started(name: String, kind: SpanKind, attributes: Vec<KeyValue>, parent: &Context) -> Context {
    let tracer = global::tracer(SCOPE);
    let span = tracer
        .span_builder(name)
        .with_kind(kind)
        .with_attributes(attributes)
        .start_with_context(&tracer, parent);
    parent.with_span(span)
}

/// Run `work` in a span, a child of `parent`.
pub async fn in_span<T>(
    name: String,
    kind: SpanKind,
    attributes: Vec<KeyValue>,
    parent: Context,
    work: impl Future<Output = T>,
) -> T {
    let context = started(name, kind, attributes, &parent);
    let out = work.with_context(context.clone()).await;
    context.span().end();
    out
}

/// The same, for work that does not wait.
pub fn in_span_now<T>(
    name: String,
    kind: SpanKind,
    attributes: Vec<KeyValue>,
    parent: &Context,
    work: impl FnOnce() -> T,
) -> T {
    let context = started(name, kind, attributes, parent);
    let out = {
        let _attached = context.clone().attach();
        work()
    };
    context.span().end();
    out
}
