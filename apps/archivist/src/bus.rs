//! The Archivist on the bus: the channels it answers, a reply to each
//! request, and every appended event published as a fact.
//!
//! The rosters and the dispatch name each channel by its type, which exists
//! only for a channel the bus registry declares. `lint:spec-channel-rosters`
//! holds the two to each other and to docs/protocol/ARCHIVIST.md.

use crate::archivist::{Archivist, Refusal};
use crate::{browse, commands};
use semiont::bus::{Bus, operation};
use semiont::channels::{
    BindUpdateBody, BrowseAgentsRequested, BrowseAnchoredTextRequested,
    BrowseAnnotationHistoryRequested, BrowseAnnotationRequested, BrowseAnnotationsRequested,
    BrowseDirectoryRequested, BrowseEntityTypesRequested, BrowseEventsRequested, BrowseKbRequested,
    BrowseResourceRequested, BrowseResourcesRequested, BrowseTagSchemasRequested, Channel,
    FrameAddEntityType, FrameAddTagSchema, JobAssign, JobComplete, JobFail, JobStart, MarkArchive,
    MarkCommit, MarkCreateRequest, MarkDelete, MarkUnarchive, MarkUpdateBody,
    MarkUpdateEntityTypes, PersonProfile, SmeltSettled, YieldCloneCreate, YieldClonePersist,
    YieldCloneResourceRequested, YieldCloneTokenRequested, YieldCreate, YieldUpdate,
};
use semiont::transport::{Envelope, Frame, Frames};
use semiont_archivist_record::Object;
use semiont_observability::logging;
use serde_json::{Value, json};
use std::sync::Arc;
use std::sync::atomic::Ordering;
use tokio::sync::mpsc::UnboundedReceiver;

/// The commands: each channel's frames are handled one at a time, in the
/// order they arrive.
pub const COMMANDS: [&str; 19] = [
    YieldCreate::NAME,
    YieldClonePersist::NAME,
    YieldUpdate::NAME,
    YieldCloneCreate::NAME,
    MarkCreateRequest::NAME,
    MarkCommit::NAME,
    MarkDelete::NAME,
    MarkUpdateBody::NAME,
    BindUpdateBody::NAME,
    MarkArchive::NAME,
    MarkUnarchive::NAME,
    MarkUpdateEntityTypes::NAME,
    FrameAddEntityType::NAME,
    FrameAddTagSchema::NAME,
    PersonProfile::NAME,
    JobStart::NAME,
    JobAssign::NAME,
    JobComplete::NAME,
    JobFail::NAME,
];

/// The reads, and the Smelter's signal: answered as they arrive, in no
/// particular order.
pub const READS: [&str; 15] = [
    BrowseResourceRequested::NAME,
    BrowseResourcesRequested::NAME,
    BrowseAnnotationsRequested::NAME,
    BrowseAnnotationRequested::NAME,
    BrowseAnnotationHistoryRequested::NAME,
    BrowseEventsRequested::NAME,
    BrowseAnchoredTextRequested::NAME,
    BrowseEntityTypesRequested::NAME,
    BrowseTagSchemasRequested::NAME,
    BrowseAgentsRequested::NAME,
    BrowseKbRequested::NAME,
    BrowseDirectoryRequested::NAME,
    YieldCloneTokenRequested::NAME,
    YieldCloneResourceRequested::NAME,
    SmeltSettled::NAME,
];

/// A reply: the channel it goes on, and what it carries.
struct Reply {
    channel: &'static str,
    payload: Value,
}

fn refused(refusal: Refusal) -> Value {
    match refusal.code {
        Some(code) => json!({ "code": code, "message": refusal.message }),
        None => json!({ "message": refusal.message }),
    }
}

/// Handle one frame, and answer what is to be sent back, if anything.
async fn handle(archivist: &Archivist, channel: &str, payload: &Object) -> Option<Reply> {
    // The channels that are no operation's request.
    match channel {
        SmeltSettled::NAME => {
            if let (Some(resource), Some(checksum), Some(outcome)) = (
                payload.get("resourceId").and_then(Value::as_str),
                payload.get("contentChecksum").and_then(Value::as_str),
                payload.get("outcome").and_then(Value::as_str),
            ) {
                archivist.smelt.settle(resource, checksum, outcome);
            }
            return None;
        }
        MarkUpdateBody::NAME => {
            return match commands::update_body(archivist, channel, payload).await {
                Ok(_) => None,
                Err(refusal) => Some(Reply {
                    channel: "mark:body-update-failed",
                    payload: refused(refusal),
                }),
            };
        }
        PersonProfile::NAME
        | JobStart::NAME
        | JobAssign::NAME
        | JobComplete::NAME
        | JobFail::NAME => {
            let outcome = match channel {
                PersonProfile::NAME => commands::person_profile(archivist, payload).await,
                _ => commands::job(archivist, channel, payload).await,
            };
            if let Err(refusal) = outcome {
                logging::error(
                    "A command was not recorded",
                    json!({ "component": "stower", "channel": channel, "error": refusal.message }),
                );
            }
            return None;
        }
        _ => {}
    }

    let operation = operation(channel)?;
    if channel == BrowseDirectoryRequested::NAME {
        return Some(match browse::directory(archivist, payload).await {
            Ok(response) => Reply {
                channel: operation.result,
                payload: json!({ "response": response }),
            },
            Err((path, message)) => Reply {
                channel: operation.failure,
                payload: json!({ "path": path, "message": message }),
            },
        });
    }
    let answered = match channel {
        YieldCreate::NAME => commands::yield_create(archivist, payload).await,
        YieldClonePersist::NAME => commands::yield_clone_persist(archivist, payload).await,
        YieldUpdate::NAME => commands::yield_update(archivist, payload).await,
        YieldCloneCreate::NAME => commands::clone_create(archivist, payload).await,
        YieldCloneTokenRequested::NAME => commands::clone_token(archivist, payload).await,
        YieldCloneResourceRequested::NAME => commands::clone_resource(archivist, payload).await,
        MarkCreateRequest::NAME => commands::mark_create_request(archivist, payload).await,
        MarkCommit::NAME => commands::mark_commit(archivist, payload).await,
        MarkDelete::NAME => commands::mark_delete(archivist, payload).await,
        BindUpdateBody::NAME => commands::update_body(archivist, channel, payload).await,
        MarkArchive::NAME => commands::mark_archive(archivist, payload).await,
        MarkUnarchive::NAME => commands::mark_unarchive(archivist, payload).await,
        MarkUpdateEntityTypes::NAME => commands::mark_update_entity_types(archivist, payload).await,
        FrameAddEntityType::NAME => commands::frame_add_entity_type(archivist, payload).await,
        FrameAddTagSchema::NAME => commands::frame_add_tag_schema(archivist, payload).await,
        BrowseResourceRequested::NAME => browse::resource(archivist, payload).await,
        BrowseResourcesRequested::NAME => browse::resources(archivist, payload).await,
        BrowseAnnotationsRequested::NAME => browse::annotations(archivist, payload).await,
        BrowseAnnotationRequested::NAME => browse::annotation(archivist, payload).await,
        BrowseAnnotationHistoryRequested::NAME => {
            browse::annotation_history(archivist, payload).await
        }
        BrowseEventsRequested::NAME => browse::events(archivist, payload).await,
        BrowseAnchoredTextRequested::NAME => browse::anchored(archivist, payload).await,
        BrowseEntityTypesRequested::NAME => browse::entity_types(archivist, payload).await,
        BrowseTagSchemasRequested::NAME => browse::tag_schemas(archivist, payload).await,
        BrowseAgentsRequested::NAME => browse::agents(archivist, payload).await,
        BrowseKbRequested::NAME => browse::knowledge_base(archivist, payload).await,
        _ => return None,
    };
    Some(match answered {
        // The replies that carry nothing are the empty object; the rest
        // carry what was answered as their `response`.
        Ok(response) if response.as_object().is_some_and(Object::is_empty) => Reply {
            channel: operation.result,
            payload: json!({}),
        },
        Ok(response) => Reply {
            channel: operation.result,
            payload: json!({ "response": response }),
        },
        Err(refusal) => Reply {
            channel: operation.failure,
            payload: refused(refusal),
        },
    })
}

async fn answer(archivist: &Archivist, bus: &Bus, frame: Frame) {
    let trace = frame.trace.clone();
    semiont_telemetry::continuing(trace.as_ref(), async {
        let Some(reply) = handle(archivist, &frame.channel, &frame.payload).await else {
            return;
        };
        let Value::Object(payload) = reply.payload else {
            return;
        };
        let envelope = Envelope {
            correlation_id: frame.correlation_id.clone(),
            scope: None,
        };
        if let Err(error) = bus.emit_on(reply.channel, payload, envelope).await {
            logging::error(
                "A reply was not sent",
                json!({ "component": "archivist", "channel": reply.channel, "correlationId": frame.correlation_id, "error": error.to_string() }),
            );
        }
    })
    .await
}

async fn next(frames: &mut Frames, channel: &str) -> Option<Frame> {
    loop {
        match frames.next().await? {
            Ok(frame) => return Some(frame),
            Err(lagged) => logging::error(
                "Frames missed",
                json!({ "component": "archivist", "channel": channel, "missed": lagged.0 }),
            ),
        }
    }
}

/// Answer `channel`'s frames one at a time, in the order they arrive.
pub fn in_order(archivist: Arc<Archivist>, bus: Bus, channel: &'static str, mut frames: Frames) {
    tokio::spawn(async move {
        while let Some(frame) = next(&mut frames, channel).await {
            answer(&archivist, &bus, frame).await;
        }
    });
}

/// Answer `channel`'s frames as they arrive.
pub fn as_they_arrive(
    archivist: Arc<Archivist>,
    bus: Bus,
    channel: &'static str,
    mut frames: Frames,
) {
    tokio::spawn(async move {
        while let Some(frame) = next(&mut frames, channel).await {
            let (archivist, bus) = (archivist.clone(), bus.clone());
            tokio::spawn(async move { answer(&archivist, &bus, frame).await });
        }
    });
}

/// Publish every appended event, one at a time in the order appended: with
/// no scope, and, for a resource's event, scoped to its resource. A publish
/// that fails is logged, and the services that follow the facts catch up
/// from the log.
pub fn publish_facts(archivist: Arc<Archivist>, bus: Bus, mut facts: UnboundedReceiver<Object>) {
    tokio::spawn(async move {
        while let Some(event) = facts.recv().await {
            let kind = event
                .get("type")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned();
            let resource = event
                .get("resourceId")
                .and_then(Value::as_str)
                .map(str::to_owned);
            let scope = resource
                .as_deref()
                .and_then(|id| serde_json::from_value(json!(id)).ok());
            let unscoped = bus.emit_on(&kind, event.clone(), Envelope::default());
            let outcomes = match scope {
                Some(scope) => {
                    let scoped = bus.emit_on(
                        &kind,
                        event.clone(),
                        Envelope {
                            correlation_id: None,
                            scope: Some(scope),
                        },
                    );
                    let (a, b) = tokio::join!(unscoped, scoped);
                    vec![a, b]
                }
                None => vec![unscoped.await],
            };
            for error in outcomes.into_iter().filter_map(Result::err) {
                logging::error(
                    "Fact publish failed — projectors will heal on their next catch-up",
                    json!({
                        "component": "archivist", "type": kind, "resourceId": resource,
                        "sequenceNumber": event["metadata"]["sequenceNumber"], "error": error.to_string(),
                    }),
                );
            }
            archivist.unpublished.fetch_sub(1, Ordering::SeqCst);
        }
    });
}
