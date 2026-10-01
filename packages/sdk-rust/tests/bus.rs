//! A bus request over a transport that misbehaves on a schedule: what it
//! sends, when, and how it settles (docs/protocol/TRANSPORT-CONTRACT.md
//! § Requests).

use semiont::bus::{Bus, Operation, operation};
use semiont::errors::SemiontError;
use semiont::testing::{FaultAction, FaultyTransport};
use semiont::transport::{ConnectionState, Frame, STREAM_BACKLOG, Transport};
use serde_json::{Map, Value, json};
use std::sync::Arc;
use std::time::Duration;

const WITHIN: Duration = Duration::from_secs(5);

fn read() -> &'static Operation {
    operation("browse:resource-requested").expect("a registry operation")
}

fn asking(resource: &str) -> Map<String, Value> {
    json!({ "resourceId": resource })
        .as_object()
        .cloned()
        .expect("an object")
}

fn bus(schedule: Vec<FaultAction>) -> (Bus, FaultyTransport) {
    let transport = FaultyTransport::new(schedule);
    (Bus::new(Arc::new(transport.clone())), transport)
}

fn code(outcome: Result<Option<Value>, SemiontError>) -> &'static str {
    outcome.expect_err("the request fails").code()
}

#[tokio::test(start_paused = true)]
async fn a_request_resolves_with_its_replys_response() {
    let (bus, transport) = bus(vec![]);
    transport.queue_reply(read().request, [Some(json!({ "name": "r" })), None]);
    assert_eq!(
        bus.request_of(read(), asking("r1"), WITHIN).await,
        Ok(Some(json!({ "name": "r" })))
    );
    // A reply that carries no response resolves with none.
    assert_eq!(bus.request_of(read(), asking("r1"), WITHIN).await, Ok(None));
    let log = transport.request_log();
    assert_eq!(log.len(), 2);
    assert!(log[0].correlation_id.is_some());
    assert_ne!(log[0].correlation_id, log[1].correlation_id);
    assert_eq!(log[0].payload, asking("r1"));
    assert!(transport.pending_replies().is_empty());
}

#[tokio::test(start_paused = true)]
async fn a_request_nobody_answers_times_out_and_is_tracked_no_more() {
    let (bus, transport) = bus(vec![FaultAction::DropReply]);
    transport.queue_reply(read().request, [None]);
    assert_eq!(
        code(bus.request_of(read(), asking("r1"), WITHIN).await),
        "bus.timeout"
    );
    assert!(transport.pending_replies().is_empty());
}

#[tokio::test(start_paused = true)]
async fn a_failure_reply_fails_under_the_code_its_own_code_becomes() {
    for (stated, expected) in [
        (Some("not-found"), "bus.not-found"),
        (Some("peer-unavailable"), "bus.peer-unavailable"),
        (Some("unauthorized"), "bus.unauthorized"),
        (Some("none-pending"), "bus.none-pending"),
        (Some("not-invented-yet"), "bus.rejected"),
        (None, "bus.rejected"),
    ] {
        let (bus, transport) = bus(vec![FaultAction::DropReply]);
        transport.queue_reply(read().request, [None]);
        let asked = tokio::spawn({
            let bus = bus.clone();
            async move { bus.request_of(read(), asking("r1"), WITHIN).await }
        });
        tokio::time::sleep(Duration::from_millis(1)).await;
        let correlation_id = transport.request_log()[0].correlation_id.clone();
        let mut payload = json!({ "message": "refused" })
            .as_object()
            .cloned()
            .expect("an object");
        if let Some(stated) = stated {
            payload.insert("code".to_owned(), json!(stated));
        }
        transport.deliver(Frame {
            channel: read().failure.to_owned(),
            payload: payload.clone(),
            correlation_id,
            scope: None,
            trace: None,
        });
        let error = asked.await.expect("the request ran").expect_err("it fails");
        assert_eq!(error.code(), expected);
        let SemiontError::Bus(error) = error else {
            panic!("a failure reply is the request's own failure");
        };
        assert_eq!(error.message, "refused");
        assert_eq!(error.failure, Some(payload));
    }
}

#[tokio::test(start_paused = true)]
async fn a_refused_emit_fails_the_request_as_the_transport_failed_it() {
    let (bus, transport) = bus(vec![FaultAction::RejectEmit]);
    let error = bus
        .request_of(read(), asking("r1"), WITHIN)
        .await
        .expect_err("the emit is refused");
    assert!(matches!(error, SemiontError::Transport(_)), "{error:?}");
    assert!(transport.pending_replies().is_empty());
}

#[tokio::test(start_paused = true)]
async fn a_request_waits_for_the_stream_to_open_inside_its_own_deadline() {
    let (bus, transport) = bus(vec![]);
    transport.queue_reply(read().request, [None, None]);
    transport.set_state(ConnectionState::Connecting);
    let asked = tokio::spawn({
        let bus = bus.clone();
        async move { bus.request_of(read(), asking("r1"), WITHIN).await }
    });
    tokio::time::sleep(Duration::from_secs(1)).await;
    assert!(
        transport.request_log().is_empty(),
        "nothing is sent before the stream is open"
    );
    assert!(
        transport.pending_replies().is_empty(),
        "and nothing is tracked"
    );
    transport.set_state(ConnectionState::Open);
    assert_eq!(asked.await.expect("the request ran"), Ok(None));
    assert_eq!(transport.request_log().len(), 1);

    // A stream that never opens: the wait is the request's deadline.
    transport.set_state(ConnectionState::Reconnecting);
    assert_eq!(
        code(bus.request_of(read(), asking("r1"), WITHIN).await),
        "bus.timeout"
    );
    assert_eq!(transport.request_log().len(), 1, "it was never sent");
}

#[tokio::test(start_paused = true)]
async fn a_request_of_a_closed_bus_fails_at_once_and_sends_nothing() {
    let (bus, transport) = bus(vec![]);
    transport.close().await;
    let started = tokio::time::Instant::now();
    assert_eq!(
        code(bus.request_of(read(), asking("r1"), WITHIN).await),
        "bus.closed"
    );
    assert_eq!(started.elapsed(), Duration::ZERO);
    assert!(transport.request_log().is_empty());
}

#[tokio::test(start_paused = true)]
async fn a_bus_closed_while_a_request_waits_fails_it_as_closed() {
    let (bus, transport) = bus(vec![FaultAction::DropReply]);
    transport.queue_reply(read().request, [None]);
    let asked = tokio::spawn({
        let bus = bus.clone();
        async move { bus.request_of(read(), asking("r1"), WITHIN).await }
    });
    tokio::time::sleep(Duration::from_millis(1)).await;
    transport.close().await;
    assert_eq!(code(asked.await.expect("the request ran")), "bus.closed");
}

#[tokio::test(start_paused = true)]
async fn an_abandoned_request_is_tracked_no_more() {
    let (bus, transport) = bus(vec![FaultAction::DropReply]);
    transport.queue_reply(read().request, [None]);
    let asked = tokio::spawn({
        let bus = bus.clone();
        async move { bus.request_of(read(), asking("r1"), WITHIN).await }
    });
    tokio::time::sleep(Duration::from_millis(1)).await;
    assert_eq!(transport.pending_replies().len(), 1);
    asked.abort();
    let _ = asked.await;
    assert!(transport.pending_replies().is_empty());
    assert_eq!(transport.request_log().len(), 1, "what was sent stays sent");
}

/// A reply is not read off the stream its channel's other traffic rides. Here
/// the reply arrives and, before its request is next run, the reply's own
/// channel carries a burst larger than any reader's backlog: a request that
/// read the channel would find its reply evicted, and time out.
#[tokio::test(start_paused = true)]
async fn a_reply_buried_under_its_channels_traffic_is_still_delivered() {
    let (bus, transport) = bus(vec![FaultAction::DropReply]);
    transport.queue_reply(read().request, [None]);
    let asked = tokio::spawn({
        let bus = bus.clone();
        async move { bus.request_of(read(), asking("r1"), WITHIN).await }
    });
    tokio::time::sleep(Duration::from_millis(1)).await;
    let correlation_id = transport.request_log()[0].correlation_id.clone();
    let frame = |correlation_id: Option<String>, response: Value| Frame {
        channel: read().result.to_owned(),
        payload: json!({ "response": response })
            .as_object()
            .cloned()
            .expect("an object"),
        correlation_id,
        scope: None,
        trace: None,
    };
    transport.deliver(frame(correlation_id, json!("the reply")));
    for n in 0..(STREAM_BACKLOG * 3) {
        transport.deliver(frame(Some(format!("another-clients-{n}")), json!("not it")));
    }
    assert_eq!(
        asked.await.expect("the request ran"),
        Ok(Some(json!("the reply")))
    );
}
