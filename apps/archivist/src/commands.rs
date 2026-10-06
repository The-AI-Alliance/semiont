//! The commands the Archivist records: each checks what it is told, appends
//! what it stands for, and answers what its reply carries.

use crate::archivist::{
    Archivist, CloneToken, Refusal, event, locked, primary_representation, text,
};
use semiont::media_types::{AnchoringModel, capabilities_of};
use semiont::roles::WORKER_ROLE;
use semiont_archivist_record::agents::attribution;
use semiont_archivist_record::{Object, ids, log};
use serde_json::{Value, json};

type Answered = Result<Value, Refusal>;

/// Who sent a command: the DID the gateway stamped it with.
pub fn sender<'a>(channel: &str, command: &'a Object) -> Result<&'a str, Refusal> {
    text(command, "_userId")
        .ok_or_else(|| Refusal::from(format!("{channel} missing _userId (gateway injection)")))
}

fn holds_worker_role(command: &Object) -> bool {
    command
        .get("_roles")
        .and_then(Value::as_array)
        .is_some_and(|roles| roles.iter().any(|role| role == WORKER_ROLE))
}

fn required<'a>(channel: &str, command: &'a Object, key: &str) -> Result<&'a str, Refusal> {
    text(command, key).ok_or_else(|| Refusal::from(format!("{channel} missing {key}")))
}

/// Copy a field a command may leave out.
fn carry(into: &mut Object, key: &str, from: Option<&Value>) {
    if let Some(value) = from.filter(|v| !v.is_null()) {
        into.insert(key.into(), value.clone());
    }
}

fn entity_types(command: &Object) -> Value {
    command
        .get("entityTypes")
        .filter(|types| types.is_array())
        .cloned()
        .unwrap_or_else(|| json!([]))
}

/// Who a job was assigned for: the record of the resource it was assigned on
/// must hold the assignment, and its holder must be the writer.
fn requester_of(
    archivist: &Archivist,
    resource_id: &str,
    job_id: &str,
    writer: &str,
) -> Result<String, Refusal> {
    let events = archivist.events(resource_id)?;
    let assigned = events
        .iter()
        .find(|e| e.get("type") == Some(&json!("job:assigned")) && e["payload"]["jobId"] == job_id);
    let Some(assigned) = assigned else {
        return Err(format!(
            "refused: cites job {job_id}, but this resource's log holds no assignment for it"
        )
        .into());
    };
    let holder = assigned["payload"]["holder"].as_str().unwrap_or_default();
    if holder != writer {
        return Err(format!(
            "refused: job {job_id}'s recorded holder is {holder}, not the writer {writer}"
        )
        .into());
    }
    Ok(assigned["payload"]["requester"]
        .as_str()
        .unwrap_or_default()
        .to_owned())
}

/// `yield:create`: record a resource whose content is in the working tree.
pub async fn yield_create(archivist: &Archivist, command: &Object) -> Answered {
    const CHANNEL: &str = "yield:create";
    let user = sender(CHANNEL, command)?;
    let job_id = text(command, "jobId");
    if holds_worker_role(command) && job_id.is_none() {
        return Err(
            "yield:create refused: a worker-role emitter must cite the job it fulfils in `jobId`"
                .into(),
        );
    }
    let source = command.get("generatedFrom").and_then(Value::as_object);
    let source_resource = source.and_then(|s| text(s, "resourceId"));
    let source_annotation = source.and_then(|s| text(s, "annotationId"));
    let requester = match job_id {
        Some(job_id) => {
            let Some(source_resource) = source_resource else {
                return Err("yield:create refused: a create citing a job must name the source resource its job was assigned on (generatedFrom.resourceId)".into());
            };
            requester_of(archivist, source_resource, job_id, user)?
        }
        None => user.to_owned(),
    };
    if command.get("generator").is_some_and(Value::is_array) {
        return Err("yield:create refused: a multi-agent generator is not supported; derivation binds one generator to the executor".into());
    }
    let derived = attribution(
        &requester,
        user,
        command.get("generator").and_then(Value::as_object),
    )?;
    let uri = required(CHANNEL, command, "storageUri")?;
    let held = archivist
        .content
        .register(uri, text(command, "contentChecksum"))
        .await?;
    let resource_id = ids::mint();

    let mut payload = Object::new();
    carry(&mut payload, "name", command.get("name"));
    carry(&mut payload, "format", command.get("format"));
    payload.insert("contentChecksum".into(), json!(held.checksum));
    carry(&mut payload, "contentByteSize", command.get("byteSize"));
    payload.insert("storageUri".into(), json!(uri));
    payload.insert("entityTypes".into(), entity_types(command));
    if let Some(language) = text(command, "language") {
        payload.insert("language".into(), json!(language));
    }
    payload.insert(
        "isDraft".into(),
        json!(
            command
                .get("isDraft")
                .and_then(Value::as_bool)
                .unwrap_or(false)
        ),
    );
    let generated_from = source_resource.zip(source_annotation);
    if let Some((resource, annotation)) = generated_from {
        payload.insert(
            "generatedFrom".into(),
            json!({ "resourceId": resource, "annotationId": annotation }),
        );
    }
    carry(
        &mut payload,
        "generationPrompt",
        command.get("generationPrompt"),
    );
    if let Some(generator) = derived.generator {
        payload.insert("generator".into(), Value::Object(generator));
    }
    payload.insert("creator".into(), Value::Object(derived.creator));
    payload.insert(
        "wasAttributedTo".into(),
        Value::Array(derived.was_attributed_to),
    );
    archivist.append(event("yield:created", Some(&resource_id), user, payload))?;

    // The new resource is linked from the annotation it was generated for.
    if let Some((resource, annotation)) = generated_from {
        let mut link = Object::new();
        link.insert("annotationId".into(), json!(annotation));
        link.insert(
            "operations".into(),
            json!([{ "op": "add", "item": { "type": "SpecificResource", "source": resource_id, "purpose": "linking" } }]),
        );
        if let Err(refusal) =
            archivist.append(event("mark:body-updated", Some(resource), user, link))
        {
            semiont_observability::logging::warn(
                "A generated resource was not linked from its annotation",
                json!({ "component": "archivist", "resourceId": resource_id, "annotationId": annotation, "error": refusal.message }),
            );
        }
    }
    Ok(json!({ "resourceId": resource_id }))
}

/// Record a copy of `parent`, whose content is at the command's URI.
async fn clone_persist_as(
    archivist: &Archivist,
    channel: &str,
    command: &Object,
    parent: &str,
    types: Value,
) -> Result<String, Refusal> {
    let user = sender(channel, command)?;
    let derived = attribution(user, user, None)?;
    let uri = required(channel, command, "storageUri")?;
    let held = archivist
        .content
        .register(uri, text(command, "contentChecksum"))
        .await?;
    let resource_id = ids::mint();
    let mut payload = Object::new();
    carry(&mut payload, "name", command.get("name"));
    carry(&mut payload, "format", command.get("format"));
    payload.insert("contentChecksum".into(), json!(held.checksum));
    carry(&mut payload, "contentByteSize", command.get("byteSize"));
    payload.insert("storageUri".into(), json!(uri));
    payload.insert("parentResourceId".into(), json!(parent));
    payload.insert("entityTypes".into(), types);
    if let Some(language) = text(command, "language") {
        payload.insert("language".into(), json!(language));
    }
    payload.insert("creator".into(), Value::Object(derived.creator));
    payload.insert(
        "wasAttributedTo".into(),
        Value::Array(derived.was_attributed_to),
    );
    archivist.append(event("yield:cloned", Some(&resource_id), user, payload))?;
    Ok(resource_id)
}

/// `yield:clone-persist`.
pub async fn yield_clone_persist(archivist: &Archivist, command: &Object) -> Answered {
    const CHANNEL: &str = "yield:clone-persist";
    let parent = required(CHANNEL, command, "parentResourceId")?.to_owned();
    let resource_id =
        clone_persist_as(archivist, CHANNEL, command, &parent, entity_types(command)).await?;
    Ok(json!({ "resourceId": resource_id }))
}

/// `yield:update`: record new content for a resource.
pub async fn yield_update(archivist: &Archivist, command: &Object) -> Answered {
    const CHANNEL: &str = "yield:update";
    let user = sender(CHANNEL, command)?;
    let resource_id = required(CHANNEL, command, "resourceId")?;
    let uri = required(CHANNEL, command, "storageUri")?;
    archivist
        .content
        .register(uri, text(command, "contentChecksum"))
        .await?;
    let mut payload = Object::new();
    carry(
        &mut payload,
        "contentChecksum",
        command.get("contentChecksum"),
    );
    carry(&mut payload, "contentByteSize", command.get("byteSize"));
    archivist.append(event("yield:updated", Some(resource_id), user, payload))?;
    Ok(json!({ "resourceId": resource_id }))
}

/// Record one annotation as sent, attributed to `requester` and the sender.
fn record_annotation(
    archivist: &Archivist,
    channel: &str,
    resource_id: &str,
    user: &str,
    requester: &str,
    annotation: &Object,
) -> Result<(), Refusal> {
    let id = annotation
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if annotation.contains_key("creator") {
        return Err(format!(
            "{channel} refused: `creator` on annotation {id} is derived by the knowledge base, never sent"
        )
        .into());
    }
    if annotation.get("generator").is_some_and(Value::is_array) {
        return Err(format!(
            "{channel} refused: annotation {id} carries a multi-agent generator; derivation binds one generator to the executor"
        )
        .into());
    }
    let derived = attribution(
        requester,
        user,
        annotation.get("generator").and_then(Value::as_object),
    )?;
    let mut recorded = annotation.clone();
    recorded.insert("creator".into(), Value::Object(derived.creator));
    if let Some(generator) = derived.generator {
        recorded.insert("generator".into(), Value::Object(generator));
    }
    recorded.insert(
        "wasAttributedTo".into(),
        Value::Array(derived.was_attributed_to),
    );
    let mut payload = Object::new();
    payload.insert("annotation".into(), Value::Object(recorded));
    archivist.append(event("mark:added", Some(resource_id), user, payload))?;
    Ok(())
}

/// `mark:create-request`: assemble an annotation from its parts and record it.
pub async fn mark_create_request(archivist: &Archivist, command: &Object) -> Answered {
    const CHANNEL: &str = "mark:create-request";
    let Some(user) = text(command, "_userId") else {
        return Err("_userId is required (injected by bus gateway)".into());
    };
    let resource_id = ids::safe(required(CHANNEL, command, "resourceId")?)?;
    let none = Object::new();
    let request = command
        .get("request")
        .and_then(Value::as_object)
        .unwrap_or(&none);

    let view = archivist.held_view(resource_id)?;
    let media_type = view
        .as_ref()
        .and_then(primary_representation)
        .and_then(|r| r.get("mediaType"))
        .and_then(Value::as_str);
    let annotatable = media_type
        .and_then(capabilities_of)
        .is_some_and(|caps| caps.anchoring != AnchoringModel::None);
    if !annotatable {
        return Err(format!(
            "\"{}\" cannot be annotated",
            media_type.unwrap_or("unknown")
        )
        .into());
    }
    if text(request, "motivation").is_none() {
        return Err("motivation is required".into());
    }

    let annotation_id = ids::mint();
    let now = log::now();
    let mut annotation = Object::new();
    annotation.insert("@context".into(), json!("http://www.w3.org/ns/anno.jsonld"));
    annotation.insert("type".into(), json!("Annotation"));
    annotation.insert("id".into(), json!(annotation_id));
    carry(&mut annotation, "motivation", request.get("motivation"));
    carry(&mut annotation, "target", request.get("target"));
    carry(&mut annotation, "body", request.get("body"));
    annotation.insert("created".into(), json!(now));
    annotation.insert("modified".into(), json!(now));
    record_annotation(
        archivist,
        "mark:create",
        resource_id,
        user,
        user,
        &annotation,
    )?;
    Ok(json!({ "annotationId": annotation_id }))
}

/// `mark:commit`: record a batch, each annotation once.
pub async fn mark_commit(archivist: &Archivist, command: &Object) -> Answered {
    const CHANNEL: &str = "mark:commit";
    let user = sender(CHANNEL, command)?;
    let resource_id = required(CHANNEL, command, "resourceId")?;
    let annotations: Vec<&Object> = command
        .get("annotations")
        .and_then(Value::as_array)
        .map(|sent| sent.iter().filter_map(Value::as_object).collect())
        .unwrap_or_default();
    let job_id = text(command, "jobId");
    if holds_worker_role(command) && job_id.is_none() {
        return Err(
            "mark:commit refused: a worker-role emitter must cite the job it fulfils in `jobId`"
                .into(),
        );
    }
    let requester = match job_id {
        Some(job_id) => requester_of(archivist, resource_id, job_id, user)?,
        None => user.to_owned(),
    };
    let mut present: Vec<Value> = archivist
        .held_view(resource_id)?
        .and_then(|view| view["annotations"]["annotations"].as_array().cloned())
        .unwrap_or_default()
        .iter()
        .filter_map(|held| held.get("id").cloned())
        .collect();
    for annotation in &annotations {
        let Some(id) = annotation.get("id") else {
            continue;
        };
        if present.contains(id) {
            continue;
        }
        record_annotation(
            archivist,
            CHANNEL,
            resource_id,
            user,
            &requester,
            annotation,
        )?;
        present.push(id.clone());
    }
    let ids: Vec<&Value> = annotations.iter().filter_map(|a| a.get("id")).collect();
    Ok(json!({ "persisted": annotations.len(), "annotationIds": ids }))
}

/// `mark:delete`.
pub async fn mark_delete(archivist: &Archivist, command: &Object) -> Answered {
    const CHANNEL: &str = "mark:delete";
    let user = sender(CHANNEL, command)?;
    let resource_id = required(CHANNEL, command, "resourceId")?;
    let mut payload = Object::new();
    carry(&mut payload, "annotationId", command.get("annotationId"));
    archivist.append(event("mark:removed", Some(resource_id), user, payload))?;
    Ok(json!({ "annotationId": command.get("annotationId") }))
}

/// `mark:update-body` and `bind:update-body`: record body operations.
pub async fn update_body(archivist: &Archivist, channel: &str, command: &Object) -> Answered {
    let Some(user) = text(command, "_userId") else {
        return Err("_userId is required (injected by bus gateway)".into());
    };
    let resource_id = required(channel, command, "resourceId")?;
    let mut payload = Object::new();
    carry(&mut payload, "annotationId", command.get("annotationId"));
    carry(&mut payload, "operations", command.get("operations"));
    archivist.append(event("mark:body-updated", Some(resource_id), user, payload))?;
    Ok(json!({}))
}

/// `frame:add-entity-type`.
pub async fn frame_add_entity_type(archivist: &Archivist, command: &Object) -> Answered {
    let user = sender("frame:add-entity-type", command)?;
    let mut payload = Object::new();
    carry(&mut payload, "entityType", command.get("tag"));
    archivist.append(event("frame:entity-type-added", None, user, payload))?;
    Ok(json!({}))
}

/// `frame:add-tag-schema`.
pub async fn frame_add_tag_schema(archivist: &Archivist, command: &Object) -> Answered {
    let user = sender("frame:add-tag-schema", command)?;
    let mut payload = Object::new();
    carry(&mut payload, "schema", command.get("schema"));
    archivist.append(event("frame:tag-schema-added", None, user, payload))?;
    Ok(json!({}))
}

/// `mark:archive`: remove the file the command names, and record the archive.
pub async fn mark_archive(archivist: &Archivist, command: &Object) -> Answered {
    const CHANNEL: &str = "mark:archive";
    let user = sender(CHANNEL, command)?;
    let resource_id = required(CHANNEL, command, "resourceId")?;
    if let Some(uri) = text(command, "storageUri") {
        let keep = command
            .get("keepFile")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        archivist.content.remove(uri, keep).await?;
    }
    archivist.append(event(
        "mark:archived",
        Some(resource_id),
        user,
        Object::new(),
    ))?;
    Ok(json!({}))
}

/// `mark:unarchive`.
pub async fn mark_unarchive(archivist: &Archivist, command: &Object) -> Answered {
    const CHANNEL: &str = "mark:unarchive";
    let user = sender(CHANNEL, command)?;
    let resource_id = required(CHANNEL, command, "resourceId")?;
    if let Some(uri) = text(command, "storageUri")
        && !archivist.content.exists(uri).await?
    {
        return Err(format!("Cannot unarchive: file not found at {uri}").into());
    }
    archivist.append(event(
        "mark:unarchived",
        Some(resource_id),
        user,
        Object::new(),
    ))?;
    Ok(json!({}))
}

/// `mark:update-entity-types`: add and remove what the two lists differ by.
pub async fn mark_update_entity_types(archivist: &Archivist, command: &Object) -> Answered {
    const CHANNEL: &str = "mark:update-entity-types";
    let user = sender(CHANNEL, command)?;
    let resource_id = required(CHANNEL, command, "resourceId")?;
    let list = |key: &str| -> Vec<Value> {
        command
            .get(key)
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
    };
    let (current, updated) = (list("currentEntityTypes"), list("updatedEntityTypes"));
    let added: Vec<&Value> = updated.iter().filter(|t| !current.contains(t)).collect();
    let removed: Vec<&Value> = current.iter().filter(|t| !updated.contains(t)).collect();
    if !added.is_empty() {
        let known = tokio::task::block_in_place(|| archivist.record().projections.entity_types())?;
        let unknown: Vec<&str> = added
            .iter()
            .filter(|t| !known.contains(t))
            .filter_map(|t| t.as_str())
            .collect();
        if !unknown.is_empty() {
            return Err(format!("Entity type not registered: {}", unknown.join(", ")).into());
        }
    }
    for (kind, types) in [
        ("mark:entity-tag-added", added),
        ("mark:entity-tag-removed", removed),
    ] {
        for entity_type in types {
            let mut payload = Object::new();
            payload.insert("entityType".into(), entity_type.clone());
            archivist.append(event(kind, Some(resource_id), user, payload))?;
        }
    }
    Ok(json!({}))
}

/// `person:profile`: record the sender's name, when it is new.
pub async fn person_profile(archivist: &Archivist, command: &Object) -> Answered {
    let user = sender("person:profile", command)?;
    let people = tokio::task::block_in_place(|| archivist.record().projections.people())?;
    if people.get(user).and_then(|profile| profile.get("name")) == command.get("name") {
        return Ok(json!({}));
    }
    let mut payload = Object::new();
    carry(&mut payload, "name", command.get("name"));
    archivist.append(event("person:profiled", None, user, payload))?;
    Ok(json!({}))
}

/// `job:start`, `job:assign`, `job:complete`, `job:fail`: the lifecycle of a
/// job, recorded in the stream of the resource it runs on.
pub async fn job(archivist: &Archivist, channel: &str, command: &Object) -> Answered {
    let user = sender(channel, command)?;
    let resource_id = required(channel, command, "resourceId")?;
    let (kind, fields): (&str, &[&str]) = match channel {
        "job:start" => ("job:started", &["jobId", "jobType", "annotationId"]),
        "job:assign" => (
            "job:assigned",
            &["jobId", "jobType", "resourceId", "holder", "requester"],
        ),
        "job:complete" => (
            "job:completed",
            &[
                "jobId",
                "jobType",
                "annotationId",
                "result",
                "attempt",
                "durability",
            ],
        ),
        _ => (
            "job:failed",
            &[
                "jobId",
                "jobType",
                "annotationId",
                "error",
                "attempt",
                "failureClass",
                "willRetry",
                "durability",
            ],
        ),
    };
    let mut payload = Object::new();
    for field in fields {
        carry(&mut payload, field, command.get(*field));
    }
    archivist.append(event(kind, Some(resource_id), user, payload))?;
    Ok(json!({}))
}

// ── Clone tokens ──────────────────────────────────────────────────────────

/// How long a clone token lets its holder copy.
const TOKEN_LIFETIME: chrono::Duration = chrono::Duration::minutes(15);

fn instant(at: chrono::DateTime<chrono::Utc>) -> String {
    at.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// The resource a token names and when it expires. An expired token is
/// forgotten as it is refused.
fn token_of(archivist: &Archivist, token: &str) -> Result<(String, String), Refusal> {
    let mut tokens = locked(&archivist.tokens);
    let Some(held) = tokens.get(token) else {
        return Err("Invalid or expired token".into());
    };
    if chrono::Utc::now() > held.expires_at {
        tokens.remove(token);
        return Err("Token expired".into());
    }
    Ok((held.resource_id.clone(), instant(held.expires_at)))
}

/// `yield:clone-token-requested`.
pub async fn clone_token(archivist: &Archivist, command: &Object) -> Answered {
    let resource_id = required("yield:clone-token-requested", command, "resourceId")?;
    let Some(view) = archivist.held_view(resource_id)? else {
        return Err("Resource not found".into());
    };
    let uri = primary_representation(&view)
        .and_then(|r| r.get("storageUri"))
        .and_then(Value::as_str);
    let there = match uri {
        Some(uri) => archivist.content.exists(uri).await.unwrap_or(false),
        None => false,
    };
    if !there {
        return Err("Resource content not found".into());
    }
    let random: [u8; 16] = *uuid::Uuid::new_v4().as_bytes();
    let token = format!(
        "clone_{}",
        random
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>()
    );
    let expires_at = chrono::Utc::now() + TOKEN_LIFETIME;
    locked(&archivist.tokens).insert(
        token.clone(),
        CloneToken {
            resource_id: resource_id.to_owned(),
            expires_at,
        },
    );
    Ok(json!({ "token": token, "expiresAt": instant(expires_at), "resource": view["resource"] }))
}

/// `yield:clone-resource-requested`: the token stays valid.
pub async fn clone_resource(archivist: &Archivist, command: &Object) -> Answered {
    let token = required("yield:clone-resource-requested", command, "token")?;
    let (resource_id, expires_at) = token_of(archivist, token)?;
    let Some(view) = archivist.held_view(&resource_id)? else {
        return Err("Source resource not found".into());
    };
    Ok(json!({ "sourceResource": view["resource"], "expiresAt": expires_at }))
}

/// `yield:clone-create`: spend a token on a copy.
pub async fn clone_create(archivist: &Archivist, command: &Object) -> Answered {
    const CHANNEL: &str = "yield:clone-create";
    let user = sender(CHANNEL, command)?;
    let token = required(CHANNEL, command, "token")?;
    let (source_id, _) = token_of(archivist, token)?;
    let Some(source) = archivist.held_view(&source_id)? else {
        return Err("Source resource not found".into());
    };
    let types = source["resource"]
        .get("entityTypes")
        .filter(|t| t.is_array())
        .cloned()
        .unwrap_or_else(|| json!([]));
    let mut persist = command.clone();
    persist.remove("language");
    let resource_id = clone_persist_as(archivist, CHANNEL, &persist, &source_id, types).await?;
    let archive = command
        .get("archiveOriginal")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if archive && source["resource"]["archived"] != true {
        archivist.append(event(
            "mark:archived",
            Some(&source_id),
            user,
            Object::new(),
        ))?;
    }
    locked(&archivist.tokens).remove(token);
    Ok(json!({ "resourceId": resource_id }))
}
