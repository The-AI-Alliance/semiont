//! The gateway's own instruments, made on the service's meter: the metrics
//! specs/src/gateway-telemetry/telemetry.json lists beside the process's and
//! the ones every process shares (`semiont.bus.emit`, observability's).

use opentelemetry::KeyValue;
use opentelemetry::metrics::{Counter, UpDownCounter};
use semiont_observability::telemetry;
use std::sync::OnceLock;

struct Instruments {
    replies_suppressed: Counter<u64>,
    resume_gaps: Counter<u64>,
    unanswerable: Counter<u64>,
    refusals: Counter<u64>,
    subscribers: UpDownCounter<i64>,
}

static INSTRUMENTS: OnceLock<Option<Instruments>> = OnceLock::new();

/// Made on first use, after telemetry is initialized; none when nothing is exported.
fn instruments() -> Option<&'static Instruments> {
    INSTRUMENTS
        .get_or_init(|| {
            let meter = telemetry::meter()?;
            Some(Instruments {
                replies_suppressed: meter
                    .u64_counter("semiont.bus.reply.suppressed")
                    .with_description("Correlated replies withheld from a non-owning subscriber")
                    .build(),
                resume_gaps: meter
                    .u64_counter("semiont.bus.resume_gap")
                    .with_description("SSE resumes that degraded to a gap because replay was unavailable")
                    .build(),
                unanswerable: meter
                    .u64_counter("semiont.bus.unanswerable")
                    .with_description(
                        "Request emits that reached zero subscribers and were failed at the gateway",
                    )
                    .build(),
                refusals: meter
                    .u64_counter("semiont.gateway.refused")
                    .with_description("Requests a limit refused, and connections closed at the cap")
                    .build(),
                subscribers: meter
                    .i64_up_down_counter("semiont.sse.subscribers")
                    .with_description("Active SSE subscribers")
                    .build(),
            })
        })
        .as_ref()
}

pub fn record_reply_suppressed(channel: &str) {
    if let Some(t) = instruments() {
        t.replies_suppressed
            .add(1, &[KeyValue::new("bus.channel", channel.to_owned())]);
    }
}

pub fn record_resume_gap(reason: &str) {
    if let Some(t) = instruments() {
        t.resume_gaps.add(
            1,
            &[KeyValue::new("bus.resume_gap.reason", reason.to_owned())],
        );
    }
}

/// A refusal by a limit (the LimitRefusal code), or `connections` at the cap.
pub fn record_refused(reason: &str) {
    if let Some(t) = instruments() {
        t.refusals
            .add(1, &[KeyValue::new("refused.reason", reason.to_owned())]);
    }
}

pub fn record_unanswerable(channel: &str) {
    if let Some(t) = instruments() {
        t.unanswerable
            .add(1, &[KeyValue::new("bus.channel", channel.to_owned())]);
    }
}

pub fn subscriber_connected() {
    if let Some(t) = instruments() {
        t.subscribers.add(1, &[]);
    }
}

pub fn subscriber_disconnected() {
    if let Some(t) = instruments() {
        t.subscribers.add(-1, &[]);
    }
}

/// `semiont.bus.correlation.size`: the claims this replica's ledger holds, and their cap.
pub fn register_correlation_size(occupancy: impl Fn() -> (u64, u64) + Send + Sync + 'static) {
    let Some(meter) = telemetry::meter() else {
        return;
    };
    meter
        .u64_observable_gauge("semiont.bus.correlation.size")
        .with_description("Correlation registry occupancy: live claims")
        .with_callback(move |observer| {
            let (claims, claims_max) = occupancy();
            observer.observe(claims, &[KeyValue::new("correlation.kind", "claims")]);
            observer.observe(
                claims_max,
                &[KeyValue::new("correlation.kind", "claims_max")],
            );
        })
        .build();
}
