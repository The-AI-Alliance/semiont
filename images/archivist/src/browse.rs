//! The reads the Archivist answers: from its views, its log, the working
//! tree and the knowledge base's engines.

use crate::archivist::{Archivist, Refusal, primary_representation, text};
use semiont::channels::{Channel, MarkAdded, MarkBodyUpdated, MarkRemoved};
use semiont::types::{JobFilter, MarkJobFilter, MarkJobFilterParams, YieldJobFilter};
use semiont_archivist_record::agents::did_to_agent;
use semiont_archivist_record::{Object, dictionary_order, kb};
use serde_json::{Value, json};
use std::path::{Component, Path};

type Answered = Result<Value, Refusal>;

const NOT_IN_VIEWS: &str = "not found in view storage";

fn required<'a>(request: &'a Object, key: &str) -> Result<&'a str, Refusal> {
    text(request, key).ok_or_else(|| Refusal::from(format!("{key} is required")))
}

fn view_of(archivist: &Archivist, resource_id: &str) -> Result<Object, Refusal> {
    archivist
        .held_view(resource_id)?
        .ok_or_else(|| Refusal::from(format!("Resource {resource_id} {NOT_IN_VIEWS}")))
}

fn annotations_of(view: &Object) -> Vec<Value> {
    view["annotations"]["annotations"]
        .as_array()
        .cloned()
        .unwrap_or_default()
}

/// Name the persons a reply mentions: every `Person` whose DID has a profile
/// carries that profile's name. With no readable projection, no one is named.
fn named(archivist: &Archivist, mut reply: Value) -> Value {
    let profiles = match tokio::task::block_in_place(|| archivist.record().projections.profiles()) {
        Ok(profiles) => profiles,
        Err(error) => {
            semiont_observability::logging::warn(
                "Profiles projection unreadable — this reply names no one",
                json!({ "component": "browser", "error": error.to_string() }),
            );
            return reply;
        }
    };
    fn walk(value: &mut Value, profiles: &Object) {
        match value {
            Value::Array(items) => items.iter_mut().for_each(|item| walk(item, profiles)),
            Value::Object(object) => {
                if object.get("@type") == Some(&json!("Person"))
                    && let Some(name) = object
                        .get("@id")
                        .and_then(Value::as_str)
                        .and_then(|did| profiles.get(did))
                        .and_then(|profile| profile.get("name"))
                        .cloned()
                {
                    object.insert("name".into(), name);
                }
                object.values_mut().for_each(|inner| walk(inner, profiles));
            }
            _ => {}
        }
    }
    if !profiles.is_empty() {
        walk(&mut reply, &profiles);
    }
    reply
}

fn body_items(annotation: &Value) -> Vec<&Value> {
    match annotation.get("body") {
        Some(Value::Array(items)) => items.iter().collect(),
        Some(Value::Null) | None => Vec::new(),
        Some(one) => vec![one],
    }
}

/// What the JSON-LD route answers: the resource and its annotations. None for
/// a resource with no events.
pub fn resource_graph(archivist: &Archivist, resource_id: &str) -> Result<Option<Value>, Refusal> {
    let view = tokio::task::block_in_place(|| archivist.record().view(resource_id))?;
    let Some(view) = view else {
        return Ok(None);
    };
    Ok(Some(named(
        archivist,
        json!({ "resource": view["resource"], "annotations": annotations_of(&view) }),
    )))
}

/// A resource's descriptor and the sequence number of its last event. Its
/// annotations are not here: their number follows the document's, and they
/// are read over HTTP.
pub async fn resource(archivist: &Archivist, request: &Object) -> Answered {
    let resource_id = required(request, "resourceId")?;
    let view = tokio::task::block_in_place(|| archivist.record().view(resource_id))?;
    match view {
        Some(view) => Ok(named(
            archivist,
            json!({ "resource": view["resource"], "lastSequence": view["lastSequence"] }),
        )),
        None => Err(Refusal {
            message: "Resource not found".to_owned(),
            code: Some("not-found"),
        }),
    }
}

fn millis(descriptor: &Value) -> i64 {
    descriptor
        .get("dateCreated")
        .and_then(Value::as_str)
        .and_then(|at| chrono::DateTime::parse_from_rfc3339(at).ok())
        .map_or(0, |at| at.timestamp_millis())
}

pub async fn resources(archivist: &Archivist, request: &Object) -> Answered {
    let offset = request.get("offset").and_then(Value::as_u64).unwrap_or(0) as usize;
    let limit = request.get("limit").and_then(Value::as_u64).unwrap_or(50) as usize;
    let archived = request.get("archived").and_then(Value::as_bool);
    let entity_type = text(request, "entityType");
    let views = tokio::task::block_in_place(|| archivist.record().views.all());
    let mut matching: Vec<Value> = views
        .into_iter()
        .filter_map(|(_, view)| view?.remove("resource"))
        .filter(|d| {
            archived.is_none_or(|wanted| {
                d.get("archived").and_then(Value::as_bool).unwrap_or(false) == wanted
            })
        })
        .filter(|d| {
            entity_type.is_none_or(|wanted| {
                d.get("entityTypes")
                    .and_then(Value::as_array)
                    .is_some_and(|types| types.iter().any(|t| t == wanted))
            })
        })
        .collect();
    let id = |d: &Value| {
        d.get("@id")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned()
    };
    matching.sort_by(|a, b| millis(b).cmp(&millis(a)).then_with(|| id(a).cmp(&id(b))));
    let total = matching.len();
    let page: Vec<Value> = matching.into_iter().skip(offset).take(limit).collect();
    Ok(named(
        archivist,
        json!({ "resources": page, "total": total, "offset": offset, "limit": limit }),
    ))
}

/// Every annotation on a resource, the persons it mentions named, and how
/// many there are: what the annotations route answers. None for a resource with no
/// events.
pub fn resource_annotations(
    archivist: &Archivist,
    resource_id: &str,
) -> Result<Option<Value>, Refusal> {
    let Some(view) = archivist.held_view(resource_id)? else {
        return Ok(None);
    };
    let held = annotations_of(&view);
    let total = held.len();
    Ok(Some(named(
        archivist,
        json!({ "annotations": held, "total": total }),
    )))
}

/// The profiles of the principals asked after, by DID. One with no profile
/// is left out.
pub async fn profiles(archivist: &Archivist, request: &Object) -> Answered {
    let Some(dids) = request.get("dids").and_then(Value::as_array) else {
        return Err(Refusal::from("dids is required"));
    };
    let profiles = tokio::task::block_in_place(|| archivist.record().projections.profiles())?;
    let asked: Object = dids
        .iter()
        .filter_map(Value::as_str)
        .filter_map(|did| {
            profiles
                .get(did)
                .map(|profile| (did.to_owned(), profile.clone()))
        })
        .collect();
    Ok(json!({ "profiles": asked }))
}

fn annotation_in(view: &Object, annotation_id: &str) -> Result<Value, Refusal> {
    annotations_of(view)
        .into_iter()
        .find(|a| a.get("id").and_then(Value::as_str) == Some(annotation_id))
        .ok_or_else(|| Refusal::from("Annotation not found"))
}

pub async fn annotation(archivist: &Archivist, request: &Object) -> Answered {
    let view = view_of(archivist, required(request, "resourceId")?)?;
    let annotation = annotation_in(&view, required(request, "annotationId")?)?;
    let linked = body_items(&annotation)
        .into_iter()
        .find(|item| item.get("type") == Some(&json!("SpecificResource")))
        .and_then(|item| item.get("source"))
        .and_then(Value::as_str);
    let resolved = match linked {
        Some(source) => archivist
            .held_view(source)?
            .and_then(|mut v| v.remove("resource")),
        None => None,
    };
    Ok(named(
        archivist,
        json!({ "annotation": annotation, "resource": view["resource"], "resolvedResource": resolved }),
    ))
}

/// Each event with its sender beside it, as an agent.
fn attributed(archivist: &Archivist, events: Vec<Object>) -> Value {
    let with_agents: Vec<Value> = events
        .into_iter()
        .map(|mut event| {
            let sender = event
                .get("userId")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let agent = Value::Object(did_to_agent(sender));
            event.insert("agent".into(), agent);
            Value::Object(event)
        })
        .collect();
    let mut wrapped = json!({ "events": with_agents });
    // Only the agents are named: an event's payload is as recorded.
    if let Some(events) = wrapped["events"].as_array_mut() {
        for event in events {
            if let Some(agent) = event.get_mut("agent") {
                *agent = named(archivist, agent.take());
            }
        }
    }
    wrapped["events"].take()
}

pub async fn events(archivist: &Archivist, request: &Object) -> Answered {
    let resource_id = required(request, "resourceId")?;
    let kind = text(request, "type");
    let user = text(request, "userId");
    let mut events: Vec<Object> = archivist
        .events(resource_id)?
        .into_iter()
        .filter(|e| user.is_none_or(|u| e.get("userId").and_then(Value::as_str) == Some(u)))
        .filter(|e| kind.is_none_or(|k| e.get("type").and_then(Value::as_str) == Some(k)))
        .collect();
    if let Some(limit) = request
        .get("limit")
        .and_then(Value::as_u64)
        .filter(|l| *l > 0)
    {
        events.truncate(limit as usize);
    }
    let total = events.len();
    Ok(
        json!({ "events": attributed(archivist, events), "total": total, "resourceId": resource_id }),
    )
}

pub async fn annotation_history(archivist: &Archivist, request: &Object) -> Answered {
    let resource_id = required(request, "resourceId")?;
    let annotation_id = required(request, "annotationId")?;
    annotation_in(&view_of(archivist, resource_id)?, annotation_id)?;
    let about = |event: &Object| -> bool {
        let payload = &event["payload"];
        let named = match event.get("type").and_then(Value::as_str) {
            Some(MarkAdded::NAME) => payload["annotation"].get("id"),
            Some(MarkRemoved::NAME | MarkBodyUpdated::NAME) => payload.get("annotationId"),
            _ => None,
        };
        named.and_then(Value::as_str) == Some(annotation_id)
    };
    let mut events: Vec<Object> = archivist
        .events(resource_id)?
        .into_iter()
        .filter(about)
        .collect();
    events.sort_by_key(|e| e["metadata"]["sequenceNumber"].as_u64().unwrap_or(0));
    let total = events.len();
    Ok(json!({
        "events": attributed(archivist, events), "total": total,
        "annotationId": annotation_id, "resourceId": resource_id,
    }))
}

pub async fn entity_types(archivist: &Archivist, _: &Object) -> Answered {
    let types = tokio::task::block_in_place(|| archivist.record().projections.entity_types())?;
    Ok(json!({ "entityTypes": types }))
}

pub async fn tag_schemas(archivist: &Archivist, _: &Object) -> Answered {
    let schemas = tokio::task::block_in_place(|| archivist.record().projections.tag_schemas())?;
    Ok(json!({ "tagSchemas": schemas }))
}

/// The knowledge base's engines: each once, in the order it is first named,
/// with the jobs it is used for, each named as a claim would name it. The
/// order is the engines document's own: a `mark` job of each motivation it
/// names, a `yield` job, then the actors. An engine is a provider and a
/// model, not a principal: it carries no identity of its own.
pub async fn engines(archivist: &Archivist, _: &Object) -> Answered {
    const ACTORS: [&str; 2] = ["gatherer", "matcher"];
    let unreadable = |error: serde_json::Error| Refusal::from(error.to_string());
    let engines = &archivist.config.engines;
    let mut uses: Vec<(Value, Option<JobFilter>)> = Vec::new();
    let marking = serde_json::to_value(&engines.jobs.mark).map_err(unreadable)?;
    for (motivation, engine) in marking.as_object().into_iter().flatten() {
        let motivation =
            serde_json::from_value(Value::String(motivation.clone())).map_err(unreadable)?;
        let filter = MarkJobFilter::new(MarkJobFilterParams { motivation });
        uses.push((engine.clone(), Some(filter.into())));
    }
    if let Some(engine) = &engines.jobs.r#yield {
        uses.push((
            serde_json::to_value(engine).map_err(unreadable)?,
            Some(YieldJobFilter::new().into()),
        ));
    }
    let actors = serde_json::to_value(&engines.actors).map_err(unreadable)?;
    for actor in ACTORS {
        if let Some(engine) = actors.get(actor) {
            uses.push((engine.clone(), None));
        }
    }

    let mut entries: Vec<(Value, Vec<JobFilter>)> = Vec::new();
    for (engine, job) in uses {
        let engine = json!({ "provider": engine["provider"], "model": engine["model"] });
        let at = match entries.iter().position(|(held, _)| *held == engine) {
            Some(at) => at,
            None => {
                entries.push((engine, Vec::new()));
                entries.len() - 1
            }
        };
        entries[at].1.extend(job);
    }
    let listed: Vec<Value> = entries
        .into_iter()
        .map(|(engine, jobs)| {
            if jobs.is_empty() {
                json!({ "engine": engine })
            } else {
                json!({ "engine": engine, "jobs": jobs })
            }
        })
        .collect();
    Ok(json!({ "engines": listed }))
}

pub async fn knowledge_base(archivist: &Archivist, _: &Object) -> Answered {
    let Some(domain) = kb::committed(&archivist.root)?.domain else {
        return Err(
            "The knowledge base commits no .semiont/config.yaml, so declares no site.domain".into(),
        );
    };
    let branch = archivist
        .staging
        .current_branch()
        .await
        .map_err(|e| Refusal::from(e.to_string()))?;
    let mut described = json!({ "name": archivist.kb.name, "domain": domain });
    if let Some(branch) = branch {
        described["gitBranch"] = json!(branch);
    }
    Ok(described)
}

fn modified(metadata: Option<&std::fs::Metadata>) -> String {
    let at: chrono::DateTime<chrono::Utc> = metadata
        .and_then(|m| m.modified().ok())
        .map_or(chrono::DateTime::UNIX_EPOCH, Into::into);
    at.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// The directories and regular files at a path of the working tree.
pub async fn directory(archivist: &Archivist, request: &Object) -> Result<Value, (String, String)> {
    let asked = request
        .get("path")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    let refuse = |message: &str| (asked.clone(), message.to_owned());
    let relative = Path::new(&asked);
    let mut inside = Vec::new();
    for part in relative.components() {
        match part {
            Component::Normal(name) => inside.push(name),
            Component::CurDir => {}
            Component::ParentDir => {
                if inside.pop().is_none() {
                    return Err(refuse("path escapes project root"));
                }
            }
            _ => return Err(refuse("path escapes project root")),
        }
    }
    let relative: std::path::PathBuf = inside.iter().collect();
    let dir = archivist.root.join(&relative);
    let entries = tokio::task::block_in_place(|| std::fs::read_dir(&dir));
    let entries = match entries {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Err(refuse("path not found"));
        }
        Err(error) => return Err(refuse(&error.to_string())),
    };
    let sort = request
        .get("sort")
        .and_then(Value::as_str)
        .unwrap_or("name")
        .to_owned();

    // The resources whose content is in this directory, by file.
    let views = tokio::task::block_in_place(|| archivist.record().views.all());
    let tracked = |file: &Path| -> Option<&Object> {
        let uri = archivist.content.uri_of(file)?;
        views
            .iter()
            .filter_map(|(_, view)| view.as_ref())
            .find(|view| {
                primary_representation(view)
                    .and_then(|r| r.get("storageUri"))
                    .and_then(Value::as_str)
                    == Some(&uri)
            })
    };

    let mut listed: Vec<Value> = Vec::new();
    for entry in entries.filter_map(Result::ok) {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') {
            continue;
        }
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        let path = relative.join(&name).to_string_lossy().into_owned();
        let metadata = entry.metadata().ok();
        if kind.is_dir() {
            listed.push(json!({ "type": "dir", "name": name, "path": path, "mtime": modified(metadata.as_ref()) }));
        } else if kind.is_file() {
            let mut file = json!({
                "type": "file", "name": name, "path": path,
                "size": metadata.as_ref().map_or(0, std::fs::Metadata::len),
                "mtime": modified(metadata.as_ref()),
            });
            match tracked(&entry.path()) {
                Some(view) => {
                    file["tracked"] = json!(true);
                    file["resourceId"] = view["resource"]["@id"].clone();
                    file["entityTypes"] = view["resource"]
                        .get("entityTypes")
                        .cloned()
                        .unwrap_or_else(|| json!([]));
                    file["annotationCount"] = json!(annotations_of(view).len());
                    if let Some(creator) = view["resource"]["wasAttributedTo"]
                        .get(0)
                        .and_then(|a| a.get("@id"))
                    {
                        file["creator"] = creator.clone();
                    }
                }
                None => file["tracked"] = json!(false),
            }
            listed.push(file);
        }
    }
    let name = |entry: &Value| entry["name"].as_str().unwrap_or_default().to_owned();
    match sort.as_str() {
        "mtime" => listed.sort_by(|a, b| b["mtime"].as_str().cmp(&a["mtime"].as_str())),
        "annotationCount" => {
            listed.sort_by_key(|e| std::cmp::Reverse(e["annotationCount"].as_u64().unwrap_or(0)))
        }
        _ => listed.sort_by(|a, b| dictionary_order(&name(a), &name(b))),
    }
    Ok(named(
        archivist,
        json!({ "path": asked, "entries": listed }),
    ))
}
