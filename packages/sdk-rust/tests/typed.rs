//! The bus typed by channel: what the typed methods put on the wire and read
//! off it, and the shapes the annotation model's types decode.

use semiont::bus::{Bus, StreamError};
use semiont::channels::{
    BeckonFocus, BrowseEntityTypesRequested, BrowseEntityTypesResult, Channel, JobCreate,
    MarkAdded, Recorded, Request, YieldCreate,
};
use semiont::errors::SemiontError;
use semiont::testing::FaultyTransport;
use semiont::testing::as_id;
use semiont::transport::{Envelope, Frame, Transport};
use semiont::types::{
    Annotation, AnnotationBodies, AnnotationTargetValue, BeckonFocusEvent,
    BrowseEntityTypesRequest, GetAnnotationsResponse,
};
use serde_json::{Map, Value, json};
use std::sync::Arc;
use std::time::Duration;

fn object(value: Value) -> Map<String, Value> {
    value.as_object().cloned().expect("an object")
}

fn bus() -> (Bus, FaultyTransport) {
    let transport = FaultyTransport::new(vec![]);
    (Bus::new(Arc::new(transport.clone())), transport)
}

#[test]
fn a_channels_type_names_it_and_an_operations_request_names_its_replies() {
    assert_eq!(JobCreate::NAME, "job:create");
    assert_eq!(<JobCreate as Request>::Result::NAME, "job:created");
    assert_eq!(<JobCreate as Request>::Failure::NAME, "job:create-failed");
    // A stamp is the payload's only where its schema declares it.
    assert!(YieldCreate::STAMPS.contains(&"_userId"));
    assert!(BeckonFocus::STAMPS.is_empty());
}

#[tokio::test]
async fn a_typed_emit_sends_the_channels_name_and_its_payload_as_an_object() {
    let (bus, transport) = bus();
    let mut sent = transport.frames(BeckonFocus::NAME).expect("frames");
    let event: BeckonFocusEvent =
        serde_json::from_value(json!({ "annotationId": "ann-1" })).expect("an event");
    bus.emit::<BeckonFocus>(&event, Envelope::default())
        .await
        .expect("it is sent");
    let frame = sent.next().await.expect("a frame").expect("not lagged");
    assert_eq!(frame.channel, "beckon:focus");
    assert_eq!(frame.payload, object(json!({ "annotationId": "ann-1" })));
}

#[tokio::test]
async fn a_typed_stream_decodes_each_payload_and_leaves_the_gateways_stamps_out_of_it() {
    let (bus, transport) = bus();
    let mut focus = bus.stream::<BeckonFocus>().expect("a stream");
    let deliver = |payload: Value| {
        transport.deliver(Frame {
            channel: BeckonFocus::NAME.to_owned(),
            payload: object(payload),
            correlation_id: None,
            scope: Some(as_id("res-1")),
            trace: None,
        })
    };
    deliver(json!({ "annotationId": "ann-1", "_userId": "did:web:example.org:users:alice" }));
    deliver(json!({ "annotationId": 7 }));

    let delivered = focus.next().await.expect("a frame").expect("it decodes");
    assert_eq!(delivered.payload.annotation_id.as_deref(), Some("ann-1"));
    assert_eq!(
        delivered.user_id.as_deref(),
        Some("did:web:example.org:users:alice")
    );
    assert_eq!(delivered.scope.as_deref(), Some("res-1"));
    // A payload that is not the channel's is said to be so, not skipped.
    assert!(matches!(
        focus.next().await,
        Some(Err(StreamError::Undecodable(_)))
    ));
}

#[tokio::test]
async fn a_typed_request_resolves_with_its_results_payload() {
    let (bus, transport) = bus();
    transport.queue_reply(
        BrowseEntityTypesRequested::NAME,
        [Some(json!({ "entityTypes": ["Person", "Place"] }))],
    );
    let result = bus
        .request::<BrowseEntityTypesRequested>(&BrowseEntityTypesRequest {}, Duration::from_secs(5))
        .await
        .expect("it is answered");
    assert_eq!(result.response.entity_types, ["Person", "Place"]);
    assert_eq!(
        <BrowseEntityTypesRequested as Request>::Result::NAME,
        BrowseEntityTypesResult::NAME
    );

    // A result that is not the operation's is a failure, never a default.
    transport.queue_reply(BrowseEntityTypesRequested::NAME, [Some(json!("not it"))]);
    let error = bus
        .request::<BrowseEntityTypesRequested>(&BrowseEntityTypesRequest {}, Duration::from_secs(5))
        .await
        .expect_err("it does not decode");
    assert!(matches!(error, SemiontError::Transport(_)), "{error:?}");
}

fn annotation(body: Value, target: Value) -> Value {
    json!({
        "@context": "http://www.w3.org/ns/anno.jsonld",
        "type": "Annotation",
        "id": "ann-1",
        "motivation": "highlighting",
        "created": "2026-10-01T12:00:00.000Z",
        "target": target,
        "body": body,
    })
}

#[test]
fn an_annotation_decodes_with_one_body_or_several_and_a_target_that_is_text_or_an_object() {
    let body = json!({ "type": "TextualBody", "value": "a note", "purpose": "commenting" });
    let one: Annotation = serde_json::from_value(annotation(body.clone(), json!("res-1")))
        .expect("one body and a text target");
    assert!(matches!(
        one.body,
        Some(AnnotationBodies::AnnotationBody(_))
    ));
    assert!(matches!(one.target, AnnotationTargetValue::ResourceId(ref id) if id == "res-1"));

    let wire = annotation(json!([body.clone(), body]), json!({ "source": "res-1" }));
    let several: Annotation = serde_json::from_value(wire.clone()).expect("several bodies");
    assert!(matches!(several.body, Some(AnnotationBodies::List(ref bodies)) if bodies.len() == 2));
    assert!(matches!(
        several.target,
        AnnotationTargetValue::AnnotationTarget(_)
    ));
    assert_eq!(serde_json::to_value(&several).expect("it encodes"), wire);
}

#[test]
fn a_property_that_is_optional_and_nullable_keeps_absent_null_and_a_value_apart() {
    let read = |wire: Value| -> GetAnnotationsResponse {
        serde_json::from_value(wire).expect("it decodes")
    };
    let absent = json!({ "annotations": [], "total": 0 });
    let null = json!({ "annotations": [], "total": 0, "motivation": null });
    let stated = json!({ "annotations": [], "total": 0, "motivation": "highlighting" });
    assert_eq!(read(absent.clone()).motivation, None);
    assert_eq!(read(null.clone()).motivation, Some(None));
    assert!(matches!(read(stated.clone()).motivation, Some(Some(_))));
    // Each survives being written and read again as what it was.
    for wire in [absent, null, stated] {
        let written = serde_json::to_value(read(wire.clone())).expect("it encodes");
        assert_eq!(written.get("motivation"), wire.get("motivation"));
        assert_eq!(read(written), read(wire));
    }
}

#[test]
fn a_recorded_channel_gives_the_events_own_payload() {
    let stored = json!({
        "id": "0e2f8c0a-4a34-4a8e-9b47-0d6d5a3f8a11",
        "type": "mark:added",
        "timestamp": "2026-10-01T12:00:00.000Z",
        "userId": "did:web:example.org:users:alice",
        "resourceId": "res-1",
        "version": 1,
        "payload": { "annotation": annotation(json!([]), json!("res-1")) },
        "metadata": { "sequenceNumber": 3 },
    });
    let stored: <MarkAdded as Channel>::Payload =
        serde_json::from_value(stored).expect("a stored event decodes");
    let event = MarkAdded::event(&stored).expect("its payload is the channel's");
    assert_eq!(event.annotation.id, "ann-1");
}
