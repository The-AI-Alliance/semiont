//! A process that installed no OpenTelemetry: the work is done, nothing is
//! recorded and no trace context travels. Its own binary, because what a
//! process installed is the process's.

use opentelemetry::trace::TraceContextExt;
use semiont::transport::TraceCarrier;
use semiont_telemetry::{
    active_trace, active_trace_id, bus_emit, bus_recv, content_get, content_get_graph, content_put,
    continued, continuing,
};

const SENDER: &str = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01";

#[tokio::test]
async fn with_nothing_installed_the_work_is_done_and_no_trace_travels() {
    let sent_under = TraceCarrier {
        traceparent: SENDER.to_owned(),
        tracestate: None,
    };

    assert_eq!(
        bus_emit("beckon:sparkle", None, async { active_trace() }).await,
        None
    );
    assert_eq!(
        content_put("image/png", 3, async { active_trace_id() }).await,
        None
    );
    assert_eq!(content_get("res-1", true, async { 7 }).await, 7);
    assert_eq!(content_get_graph("res-1", async { 7 }).await, 7);

    // A frame's own trace is handed on as it came, and is not a span here.
    assert_eq!(
        bus_recv("beckon:focus", None, Some(sent_under.clone())),
        Some(sent_under.clone())
    );
    assert_eq!(bus_recv("beckon:focus", None, None), None);
    assert!(
        !continued(Some(SENDER), None)
            .span()
            .span_context()
            .is_valid()
    );
    assert_eq!(
        continuing(Some(&sent_under), async { active_trace() }).await,
        None
    );
}
