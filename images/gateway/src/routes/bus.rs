//! `POST /bus/emit`: answer a repeat by its key, validate a frame, stamp who
//! sent it, name a principal on the record when it writes, claim a request's
//! reply for its client, and publish it on the plane.

use crate::app::App;
use crate::composition::Composition;
use crate::http::{ApiError, Authenticated, conforming, idempotency_key, json_body};
use crate::ledger::ClaimOutcome;
use crate::principal::Principal;
use crate::signal::{Meta, SignalPlane, Unavailable};
use crate::{limits, metrics};
use axum::body::Body;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::Response;
use opentelemetry::trace::SpanKind;
use semiont::bus_log::bus_log;
use semiont::channels::{Channel, PrincipalProfile};
use semiont::transport::TraceCarrier;
use semiont::types::{BusEmitAccepted, BusEmitRequest, LimitRefusalCode};
use semiont_core::spec::spec;
use semiont_observability::logging;
use semiont_observability::telemetry;
use serde_json::{Map, Value, json};
use std::sync::Arc;

const OPERATION: &str = "POST /bus/emit";

fn bus(fields: Value) -> Value {
    let mut fields = fields;
    fields["component"] = json!("bus");
    fields
}

/// The envelope a frame is published under: its correlation id, and the
/// trace the publishing runs in, so every plane delivers both alike.
pub fn envelope(correlation_id: Option<&str>) -> Option<Meta> {
    let mut meta = Meta::new();
    if let Some(TraceCarrier {
        traceparent,
        tracestate,
    }) = semiont_telemetry::active_trace()
    {
        meta.insert("traceparent".to_owned(), traceparent);
        if let Some(state) = tracestate {
            meta.insert("tracestate".to_owned(), state);
        }
    }
    if let Some(cid) = correlation_id {
        meta.insert("correlationId".to_owned(), cid.to_owned());
    }
    (!meta.is_empty()).then_some(meta)
}

/// A principal's name, for a write it is making: `principal:profile`, a
/// person's and an agent's alike. Silent for a token that carries no name.
pub async fn publish_profile(
    plane: &dyn SignalPlane,
    principal: &Principal,
) -> Result<(), Unavailable> {
    let Some(name) = principal.name.as_ref() else {
        return Ok(());
    };
    plane
        .ingest(
            PrincipalProfile::NAME.to_owned(),
            json!({ "_userId": principal.did, "name": name }),
            None,
            None,
        )
        .await?;
    Ok(())
}

pub async fn emit(
    State(app): State<Arc<App>>,
    Authenticated(principal): Authenticated,
    headers: HeaderMap,
    body: Body,
) -> Result<Response, ApiError> {
    // Before the body is read, and before any correlation claim: a refused
    // emit costs little and claims nothing, so its retry is no conflict.
    if let Err(retry_after) = app.emit_rates.admit(&principal) {
        return Err(ApiError::limited(
            StatusCode::TOO_MANY_REQUESTS,
            LimitRefusalCode::EmitRate,
            "This principal's emits have used its bucket",
            retry_after,
        ));
    }
    let key = idempotency_key(&headers, &limits::limits().emit_key_length)?;
    let request = json_body(body, OPERATION).await?;
    let get = |name: &str| headers.get(name).and_then(|v| v.to_str().ok());
    let parent = semiont_telemetry::continued(get("traceparent"), get("tracestate"));
    // The emit runs as a task of its own once its key is in hand: it owns what it reads.
    let (owner, emitter) = (app.clone(), principal.clone());
    Ok(app
        .bus
        .keys
        .answer(&principal.did, key, request, move |request| async move {
            carry_out(&owner.bus, &emitter, request, parent).await
        })
        .await)
}

/// One emit, once its key is in hand: whatever it returns is the emit's
/// answer, and settles its key.
async fn carry_out(
    composition: &Composition,
    principal: &Principal,
    request: Value,
    parent: opentelemetry::Context,
) -> Result<BusEmitAccepted, ApiError> {
    let BusEmitRequest {
        channel,
        mut payload,
        scope,
        correlation_id,
        client_id,
    } = conforming(request, OPERATION)?;
    // An empty clientId is no clientId.
    let client_id = client_id.filter(|c| !c.is_empty());

    let Some(schema) = spec().channel_schema(&channel) else {
        return Err(ApiError::bad_request(format!("Unknown channel: {channel}")));
    };
    if let Some(schema) = schema {
        let candidate = Value::Object(payload.clone());
        if let Some(problems) = semiont_core::spec::problems(schema, &candidate) {
            logging::warn(
                "Bus emit validation failed",
                bus(
                    json!({ "channel": channel, "scope": scope, "schemaName": schema, "errorMessage": problems }),
                ),
            );
            return Err(ApiError::bad_request(format!(
                "Invalid payload for {channel}: {problems}"
            )));
        }
    }

    // Refused before anything is recorded: a claim made now would stand for a
    // request the plane cannot carry.
    let plane = composition.plane.as_ref();
    if !plane.available() {
        return Err(Unavailable.into());
    }

    // The verified emitter, over whatever the caller wrote.
    payload.remove("_roles");
    payload.insert("_userId".to_owned(), json!(principal.did));
    if let Some(roles) = principal.roles.as_ref().filter(|r| !r.is_empty()) {
        payload.insert("_roles".to_owned(), json!(roles));
    }
    // A principal writing is when the record learns what it is called.
    if spec().writes(&channel) {
        publish_profile(plane, principal).await?;
    }

    let operation = spec().operation(&channel).cloned();
    let mut claimed = None;
    if let (Some(_), Some(cid)) = (&operation, &correlation_id) {
        let Some(client) = &client_id else {
            return Err(ApiError::bad_request(format!(
                "clientId is required to emit {channel} with a correlationId"
            )));
        };
        match composition
            .ledger
            .claim(cid, client, Some(&principal.did))
            .await
            .map_err(|e| ApiError::unrecorded("claiming a correlationId", e))?
        {
            ClaimOutcome::Ok => claimed = Some(cid.clone()),
            ClaimOutcome::Conflict => {
                logging::warn(
                    "[bus CLAIM-CONFLICT] correlationId already claimed",
                    bus(json!({ "channel": channel, "correlationId": cid })),
                );
                return Err(ApiError::new(
                    StatusCode::CONFLICT,
                    format!("correlationId {cid} is already claimed"),
                ));
            }
            ClaimOutcome::AtCapacity { retry_after } => {
                let max = limits::limits().pending_replies_max;
                return Err(ApiError::limited(
                    StatusCode::TOO_MANY_REQUESTS,
                    LimitRefusalCode::UnansweredRequests,
                    format!("client has {max} unanswered requests; retry when one settles"),
                    retry_after,
                ));
            }
        }
    }

    let attributes = semiont_telemetry::on_the_bus(&channel, scope.as_deref());
    let dispatched = semiont_telemetry::in_span(format!("bus.dispatch:{channel}"), SpanKind::Server, attributes, parent, async {
        let payload = Value::Object(payload);
        let echo = payload.clone();
        bus_log("EMIT", &channel, &payload, scope.as_deref(), correlation_id.as_deref());
        // A request the gateway answers for when nobody hears it asks the plane to observe that.
        let answered_if_unheard = operation.is_some() && correlation_id.is_some();
        let meta = envelope(correlation_id.as_deref());
        let receipt = if answered_if_unheard {
            plane
                .ingest_request(channel.clone(), payload, scope.clone().map(String::from), meta)
                .await?
        } else {
            plane
                .ingest(channel.clone(), payload, scope.clone().map(String::from), meta)
                .await?
        };
        telemetry::record_bus_emit(&channel, scope.as_deref());
        logging::info(
            "emit",
            bus(json!({ "channel": channel, "scope": scope, "subscribers": receipt.observers, "clientId": client_id, "correlationId": correlation_id })),
        );
        if receipt.observers == Some(0) {
            logging::warn(
                "emit reached no subscribers",
                bus(json!({ "channel": channel, "scope": scope, "hint": "Nothing on this gateway subscribes to that channel. For a UI signal meant to cross to a participant, check that a client subscribed to it." })),
            );
            if let (Some(operation), Some(cid)) = (&operation, &correlation_id) {
                answer_unanswerable(plane, &channel, &operation.failure, cid, echo).await?;
            }
        }
        Ok::<_, Unavailable>(receipt.observers)
    })
    .await;

    match dispatched {
        Ok(observers) => Ok(BusEmitAccepted {
            subscribers: observers.map(|n| n as u64),
        }),
        Err(unavailable) => {
            // So the attempt after this 503 may claim the id again.
            if let Some(cid) = claimed
                && let Err(error) = composition.ledger.let_go(&cid).await
            {
                logging::warn(
                    "[bus CLAIM-KEPT] a claim whose request was not carried out could not be let go",
                    bus(json!({ "channel": channel, "correlationId": cid, "error": error })),
                );
            }
            Err(unavailable.into())
        }
    }
}

/// A request nobody subscribes to can never be answered: its operation's
/// failure is published at once, echoing the request's fields, so the caller
/// learns in milliseconds that the service that answers it is not connected.
async fn answer_unanswerable(
    plane: &dyn SignalPlane,
    channel: &str,
    failure_channel: &str,
    cid: &str,
    request: Value,
) -> Result<(), Unavailable> {
    let mut failure: Map<String, Value> = match request {
        Value::Object(fields) => fields,
        _ => Map::new(),
    };
    failure.remove("_userId");
    failure.remove("_roles");
    failure.insert("code".to_owned(), json!("peer-unavailable"));
    failure.insert(
        "message".to_owned(),
        json!(format!(
            "No subscriber for {channel}: the service that answers it is not connected"
        )),
    );
    metrics::record_unanswerable(channel);
    logging::warn(
        "[bus UNANSWERABLE] synthesizing failure for an unsubscribed request",
        bus(json!({ "channel": channel, "failureChannel": failure_channel, "correlationId": cid })),
    );
    plane
        .ingest(
            failure_channel.to_owned(),
            Value::Object(failure),
            None,
            envelope(Some(cid)),
        )
        .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::composition::compose;
    use crate::signal::in_process::InProcessPlane;
    use crate::signal::{ClientSubscription, IngestReceipt, SharedTable, Subscription};
    use futures::FutureExt;
    use futures::future::BoxFuture;
    use semiont::identity::person_did;
    use semiont::types::UserId;
    use std::sync::Mutex;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::time::Duration;

    /// The in-process plane, which refuses its next publish as a plane whose
    /// broker went away does.
    struct RefusesNextPublish {
        inner: InProcessPlane,
        refuse: AtomicBool,
    }

    impl RefusesNextPublish {
        fn refused(&self) -> bool {
            self.refuse.swap(false, Ordering::SeqCst)
        }
    }

    impl SignalPlane for RefusesNextPublish {
        fn available(&self) -> bool {
            true
        }

        fn ingest(
            &self,
            channel: String,
            payload: Value,
            scope: Option<String>,
            meta: Option<Meta>,
        ) -> BoxFuture<'_, Result<IngestReceipt, Unavailable>> {
            if self.refused() {
                return async { Err(Unavailable) }.boxed();
            }
            self.inner.ingest(channel, payload, scope, meta)
        }

        fn ingest_request(
            &self,
            channel: String,
            payload: Value,
            scope: Option<String>,
            meta: Option<Meta>,
        ) -> BoxFuture<'_, Result<IngestReceipt, Unavailable>> {
            if self.refused() {
                return async { Err(Unavailable) }.boxed();
            }
            self.inner.ingest_request(channel, payload, scope, meta)
        }

        fn subscribe_client(
            &self,
            subscription: ClientSubscription,
        ) -> BoxFuture<'_, Result<Subscription, String>> {
            self.inner.subscribe_client(subscription)
        }

        fn flush(&self) -> BoxFuture<'_, Result<(), String>> {
            self.inner.flush()
        }

        fn table(
            &self,
            name: String,
            ttl: Duration,
        ) -> BoxFuture<'_, Result<Arc<dyn SharedTable>, String>> {
            self.inner.table(name, ttl)
        }
    }

    /// An emit as `emit` answers it once its body is read, under one key.
    async fn send(
        composition: &Arc<Composition>,
        principal: &Principal,
        request: Value,
    ) -> Response {
        let (owner, emitter) = (composition.clone(), principal.clone());
        composition
            .keys
            .answer(
                &principal.did,
                "key-1",
                request,
                move |request| async move {
                    carry_out(&owner, &emitter, request, opentelemetry::Context::new()).await
                },
            )
            .await
    }

    #[tokio::test]
    async fn a_request_whose_publish_failed_is_published_when_sent_again_with_its_key() {
        let plane = Arc::new(RefusesNextPublish {
            inner: InProcessPlane::new(),
            refuse: AtomicBool::new(false),
        });
        let composition = Arc::new(compose(plane.clone()).await.expect("the plane composes"));
        let channel = "browse:kb-requested";
        let heard: Arc<Mutex<Vec<Option<String>>>> = Arc::new(Mutex::new(Vec::new()));
        let ear = heard.clone();
        let _listening = plane
            .subscribe_client(ClientSubscription {
                global: vec![channel.to_owned()],
                scoped: Vec::new(),
                on_frame: Arc::new(move |frame| {
                    let cid = frame
                        .meta
                        .and_then(|meta| meta.get("correlationId").cloned());
                    ear.lock().expect("not poisoned").push(cid);
                }),
            })
            .await
            .expect("subscribed");
        let principal = Principal {
            did: UserId::new(person_did("example.org", "alice")).expect("a person's DID"),
            email: None,
            name: None,
            image: None,
            domain: "example.org".to_owned(),
            roles: None,
        };
        let request = json!({ "channel": channel, "payload": {}, "correlationId": "c-1", "clientId": "client-1" });

        plane.refuse.store(true, Ordering::SeqCst);
        let refused = send(&composition, &principal, request.clone()).await;
        assert_eq!(refused.status(), StatusCode::SERVICE_UNAVAILABLE);
        assert!(heard.lock().expect("not poisoned").is_empty());

        let accepted = send(&composition, &principal, request).await;
        assert_eq!(
            accepted.status(),
            StatusCode::ACCEPTED,
            "the claim was let go with the 503, so its id is no conflict"
        );
        assert_eq!(
            *heard.lock().expect("not poisoned"),
            vec![Some("c-1".to_owned())]
        );
    }
}
