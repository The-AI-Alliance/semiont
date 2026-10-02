//! `POST /bus/emit`: validate a frame, stamp who sent it, name a person on
//! the record when they write, claim a request's reply for its client, and
//! publish it on the plane.

use crate::app::App;
use crate::http::{ApiError, Authenticated, json_response, typed_body};
use crate::ledger::ClaimOutcome;
use crate::principal::Principal;
use crate::signal::{Meta, Unavailable};
use crate::{limits, metrics};
use axum::body::Body;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use opentelemetry::KeyValue;
use opentelemetry::trace::SpanKind;
use semiont::bus_log::bus_log;
use semiont::identity;
use semiont::types::{BusEmitAccepted, BusEmitRequest, LimitRefusalCode};
use semiont_core::spec::spec;
use semiont_observability::logging;
use semiont_observability::telemetry;
use serde_json::{Map, Value, json};
use std::sync::Arc;

impl From<Unavailable> for ApiError {
    fn from(unavailable: Unavailable) -> ApiError {
        ApiError::new(StatusCode::SERVICE_UNAVAILABLE, unavailable.to_string())
    }
}

fn bus(fields: Value) -> Value {
    let mut fields = fields;
    fields["component"] = json!("bus");
    fields
}

/// The envelope a frame is published under: its correlation id, and the
/// trace the publishing runs in, so every plane delivers both alike.
pub fn envelope(correlation_id: Option<&str>) -> Option<Meta> {
    let mut meta = Meta::new();
    if let Some((traceparent, tracestate)) = telemetry::active_trace() {
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

/// A person's name, for a write they are making: `person:profile`. Silent for
/// an agent, and for a token that carries no name.
pub async fn publish_profile(app: &App, principal: &Principal) -> Result<(), Unavailable> {
    let Some(name) = principal.name.as_ref() else {
        return Ok(());
    };
    if identity::names_software(&principal.did) {
        return Ok(());
    }
    app.bus
        .plane
        .ingest(
            "person:profile".to_owned(),
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
    let BusEmitRequest {
        channel,
        mut payload,
        scope,
        correlation_id,
        client_id,
    } = typed_body(body, "POST /bus/emit").await?;
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
    let plane = &app.bus.plane;
    if !plane.available() {
        return Err(Unavailable.into());
    }

    // The verified emitter, over whatever the caller wrote.
    payload.remove("_roles");
    payload.insert("_userId".to_owned(), json!(principal.did));
    if let Some(roles) = principal.roles.as_ref().filter(|r| !r.is_empty()) {
        payload.insert("_roles".to_owned(), json!(roles));
    }
    // A person writing is when the record learns what they are called.
    if spec().writes(&channel) {
        publish_profile(&app, &principal).await?;
    }

    let operation = spec().operation(&channel).cloned();
    if let (Some(_), Some(cid)) = (&operation, &correlation_id) {
        let Some(client) = &client_id else {
            return Err(ApiError::bad_request(format!(
                "clientId is required to emit {channel} with a correlationId"
            )));
        };
        match app
            .bus
            .ledger
            .claim(cid, client, Some(&principal.did))
            .await
            .map_err(|e| ApiError::internal("claiming a correlationId", e))?
        {
            ClaimOutcome::Ok => {}
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

    let get = |name: &str| headers.get(name).and_then(|v| v.to_str().ok());
    let parent = telemetry::continued(get("traceparent"), get("tracestate"));
    let mut attributes = vec![KeyValue::new("bus.channel", channel.clone())];
    if let Some(scope) = &scope {
        attributes.push(KeyValue::new("bus.scope", scope.to_string()));
    }
    let dispatched = telemetry::in_span(format!("bus.dispatch:{channel}"), SpanKind::Server, attributes, parent, async {
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
                answer_unanswerable(&app, &channel, &operation.failure, cid, echo).await?;
            }
        }
        Ok::<_, Unavailable>(receipt.observers)
    })
    .await?;

    let accepted = BusEmitAccepted {
        subscribers: dispatched.map(|n| n as u64),
    };
    Ok(json_response(StatusCode::ACCEPTED, &accepted).into_response())
}

/// A request nobody subscribes to can never be answered: its operation's
/// failure is published at once, echoing the request's fields, so the caller
/// learns in milliseconds that the service that answers it is not connected.
async fn answer_unanswerable(
    app: &App,
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
    app.bus
        .plane
        .ingest(
            failure_channel.to_owned(),
            Value::Object(failure),
            None,
            envelope(Some(cid)),
        )
        .await?;
    Ok(())
}
