//! A resource's view: what the events of its stream add up to.

use crate::agents::attribution;
use crate::shard::shard_path;
use crate::{Object, RecordError, ids, indented, read_object, write_whole};
use serde_json::{Value, json};
use std::path::{Path, PathBuf};

/// The views of a knowledge base: one file per resource.
pub struct Views {
    resources_dir: PathBuf,
}

fn text<'a>(object: &'a Object, key: &str) -> Option<&'a str> {
    object.get(key).and_then(Value::as_str)
}

/// A value an event may leave out, placed only when it is there.
fn place(into: &mut Object, key: &str, value: Option<&Value>) {
    if let Some(value) = value.filter(|v| !v.is_null()) {
        into.insert(key.into(), value.clone());
    }
}

/// A view no event has been applied to.
pub fn empty(resource_id: &str) -> Object {
    let mut view = Object::new();
    view.insert(
        "resource".into(),
        json!({
            "@context": "https://schema.org/",
            "@id": resource_id,
            "name": "",
            "representations": [],
            "archived": false,
            "entityTypes": [],
        }),
    );
    view.insert(
        "annotations".into(),
        json!({ "resourceId": resource_id, "annotations": [], "version": 0, "updatedAt": "" }),
    );
    view
}

/// Whether two body items are the same item: the same type and the same
/// source or value, and the same purpose when the one asked for names one.
fn same_item(item: &Value, asked: &Value) -> bool {
    let (Some(item), Some(asked)) = (item.as_object(), asked.as_object()) else {
        return false;
    };
    let Some(kind) = text(asked, "type") else {
        return false;
    };
    if item.get("type") != asked.get("type") {
        return false;
    }
    let identity = if kind == "SpecificResource" {
        "source"
    } else {
        "value"
    };
    if !item.contains_key(identity) || item.get(identity) != asked.get(identity) {
        return false;
    }
    match asked.get("purpose") {
        Some(purpose) => item.get("purpose") == Some(purpose),
        None => true,
    }
}

fn find_item(body: &[Value], asked: Option<&Value>) -> Option<usize> {
    let asked = asked?;
    body.iter().position(|item| same_item(item, asked))
}

/// The first representation: the one a resource's content is.
fn primary(resource: &mut Object) -> Option<&mut Object> {
    resource
        .get_mut("representations")?
        .as_array_mut()?
        .first_mut()?
        .as_object_mut()
}

fn representation(payload: &Object) -> Value {
    let mut representation = Object::new();
    place(&mut representation, "mediaType", payload.get("format"));
    place(
        &mut representation,
        "checksum",
        payload.get("contentChecksum"),
    );
    place(
        &mut representation,
        "byteSize",
        payload.get("contentByteSize"),
    );
    representation.insert("rel".into(), json!("original"));
    place(&mut representation, "language", payload.get("language"));
    place(&mut representation, "storageUri", payload.get("storageUri"));
    Value::Object(representation)
}

fn representations(resource: &mut Object) -> &mut Vec<Value> {
    let held = resource
        .entry("representations")
        .or_insert_with(|| json!([]));
    if !held.is_array() {
        *held = json!([held.take()]);
    }
    held.as_array_mut().expect("representations is a list")
}

/// The descriptor fields a new resource's event states, for a resource
/// created and for one cloned.
fn begin(resource: &mut Object, event: &Object, payload: &Object) {
    place(resource, "name", payload.get("name"));
    resource.insert(
        "entityTypes".into(),
        payload
            .get("entityTypes")
            .filter(|types| types.is_array())
            .cloned()
            .unwrap_or_else(|| json!([])),
    );
    place(resource, "dateCreated", event.get("timestamp"));
}

fn attribute(resource: &mut Object, event: &Object, payload: &Object) {
    let attributed = payload
        .get("wasAttributedTo")
        .filter(|v| !v.is_null())
        .cloned()
        .unwrap_or_else(|| {
            let sender = text(event, "userId").unwrap_or_default();
            match attribution(sender, sender, None) {
                Ok(attribution) => Value::Array(attribution.was_attributed_to),
                Err(_) => json!([]),
            }
        });
    resource.insert("wasAttributedTo".into(), attributed);
}

/// Apply one event of a resource's stream to its view.
pub fn apply(view: &mut Object, event: &Object) {
    let kind = text(event, "type").unwrap_or_default().to_owned();
    let none = Object::new();
    let payload = event
        .get("payload")
        .and_then(Value::as_object)
        .unwrap_or(&none);
    let timestamp = event.get("timestamp").cloned().unwrap_or(Value::Null);

    if let Some(resource) = view.get_mut("resource").and_then(Value::as_object_mut) {
        match kind.as_str() {
            "yield:created" => {
                begin(resource, event, payload);
                attribute(resource, event, payload);
                representations(resource).push(representation(payload));
                place(resource, "isDraft", payload.get("isDraft"));
                place(
                    resource,
                    "wasDerivedFrom",
                    payload
                        .get("generatedFrom")
                        .and_then(|from| from.get("resourceId")),
                );
                place(resource, "generator", payload.get("generator"));
            }
            "yield:cloned" => {
                begin(resource, event, payload);
                place(
                    resource,
                    "sourceResourceId",
                    payload.get("parentResourceId"),
                );
                attribute(resource, event, payload);
                representations(resource).push(representation(payload));
            }
            "yield:updated" => {
                if let Some(primary) = primary(resource) {
                    place(primary, "checksum", payload.get("contentChecksum"));
                    match payload.get("contentByteSize").filter(|v| !v.is_null()) {
                        Some(size) => {
                            primary.insert("byteSize".into(), size.clone());
                        }
                        None => {
                            primary.shift_remove("byteSize");
                        }
                    }
                }
                resource.insert("dateModified".into(), timestamp.clone());
            }
            "yield:moved" => {
                if let Some(primary) = primary(resource) {
                    place(primary, "storageUri", payload.get("toUri"));
                }
                resource.insert("dateModified".into(), timestamp.clone());
            }
            "yield:representation-added" => {
                if let Some(added) = payload.get("representation") {
                    let held = representations(resource);
                    if !held
                        .iter()
                        .any(|r| r.get("checksum") == added.get("checksum"))
                    {
                        held.push(added.clone());
                    }
                }
            }
            "yield:representation-removed" => {
                let removed = payload.get("checksum");
                representations(resource).retain(|r| r.get("checksum") != removed);
            }
            "mark:archived" => {
                resource.insert("archived".into(), json!(true));
            }
            "mark:unarchived" => {
                resource.insert("archived".into(), json!(false));
            }
            "mark:entity-tag-added" => {
                if let Some(added) = payload.get("entityType") {
                    let types = resource.entry("entityTypes").or_insert_with(|| json!([]));
                    if let Some(types) = types.as_array_mut()
                        && !types.contains(added)
                    {
                        types.push(added.clone());
                    }
                }
            }
            "mark:entity-tag-removed" => {
                let removed = payload.get("entityType");
                if let Some(types) = resource
                    .get_mut("entityTypes")
                    .and_then(Value::as_array_mut)
                {
                    types.retain(|held| Some(held) != removed);
                }
            }
            _ => {}
        }
    }

    if let Some(annotations) = view.get_mut("annotations").and_then(Value::as_object_mut) {
        if let Some(held) = annotations
            .get_mut("annotations")
            .and_then(Value::as_array_mut)
        {
            match kind.as_str() {
                "mark:added" => {
                    if let Some(added) = payload.get("annotation")
                        && !held.iter().any(|a| a.get("id") == added.get("id"))
                    {
                        held.push(added.clone());
                    }
                }
                "mark:removed" => {
                    let removed = payload.get("annotationId");
                    held.retain(|a| a.get("id") != removed);
                }
                "mark:body-updated" => {
                    let named = payload.get("annotationId");
                    if let Some(annotation) = held
                        .iter_mut()
                        .find(|a| a.get("id") == named)
                        .and_then(Value::as_object_mut)
                    {
                        let body = match annotation.get("body") {
                            Some(Value::Array(items)) => items.clone(),
                            Some(Value::Null) | None => Vec::new(),
                            Some(one) => vec![one.clone()],
                        };
                        let mut body = body;
                        let operations = payload
                            .get("operations")
                            .and_then(Value::as_array)
                            .map(Vec::as_slice)
                            .unwrap_or_default();
                        for operation in operations {
                            match operation.get("op").and_then(Value::as_str) {
                                Some("add") => {
                                    if let Some(item) = operation.get("item")
                                        && find_item(&body, Some(item)).is_none()
                                    {
                                        body.push(item.clone());
                                    }
                                }
                                Some("remove") => {
                                    if let Some(at) = find_item(&body, operation.get("item")) {
                                        body.remove(at);
                                    }
                                }
                                Some("replace") => {
                                    if let Some(at) = find_item(&body, operation.get("oldItem"))
                                        && let Some(new) = operation.get("newItem")
                                    {
                                        body[at] = new.clone();
                                    }
                                }
                                _ => {}
                            }
                        }
                        annotation.insert("body".into(), Value::Array(body));
                        annotation.insert("modified".into(), timestamp.clone());
                    }
                }
                _ => {}
            }
        }
        let version = annotations
            .get("version")
            .and_then(Value::as_u64)
            .unwrap_or(0);
        annotations.insert("version".into(), json!(version + 1));
        annotations.insert("updatedAt".into(), timestamp);
    }

    let sequence = event
        .get("metadata")
        .and_then(|m| m.get("sequenceNumber"))
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let last = view
        .get("lastSequence")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    view.insert("lastSequence".into(), json!(last.max(sequence)));
}

/// The view every event of a stream adds up to, applied in sequence order.
/// None for a stream with no events.
pub fn build(resource_id: &str, events: &[Object]) -> Option<Object> {
    if events.is_empty() {
        return None;
    }
    let mut ordered: Vec<&Object> = events.iter().collect();
    ordered.sort_by_key(|event| {
        event
            .get("metadata")
            .and_then(|m| m.get("sequenceNumber"))
            .and_then(Value::as_u64)
            .unwrap_or(0)
    });
    let mut view = empty(resource_id);
    for event in ordered {
        apply(&mut view, event);
    }
    Some(view)
}

impl Views {
    pub fn new(state_dir: &Path) -> Views {
        Views {
            resources_dir: state_dir.join("resources"),
        }
    }

    pub fn path(&self, resource_id: &str) -> Result<PathBuf, RecordError> {
        let id = ids::safe(resource_id)?;
        let (ab, cd) = shard_path(id);
        Ok(self
            .resources_dir
            .join(ab)
            .join(cd)
            .join(format!("{id}.json")))
    }

    /// A resource's view, or none: when there is no file, and when the file
    /// is not a view, which is left for the next write to replace.
    pub fn get(&self, resource_id: &str) -> Result<Option<Object>, RecordError> {
        let path = self.path(resource_id)?;
        match read_object(&path) {
            Ok(view) => Ok(view),
            Err(_) if path.exists() => Ok(None),
            Err(error) => Err(error),
        }
    }

    pub fn save(&self, resource_id: &str, view: &Object) -> Result<(), RecordError> {
        write_whole(&self.path(resource_id)?, &indented(view))
    }

    /// Every view file, with the resource it says it is of.
    pub fn all(&self) -> Vec<(PathBuf, Option<Object>)> {
        let mut found = Vec::new();
        let mut pending = vec![self.resources_dir.clone()];
        while let Some(dir) = pending.pop() {
            let Ok(entries) = std::fs::read_dir(&dir) else {
                continue;
            };
            let mut paths: Vec<PathBuf> =
                entries.filter_map(Result::ok).map(|e| e.path()).collect();
            paths.sort();
            for path in paths {
                if path.is_dir() {
                    pending.push(path);
                } else if path.extension().is_some_and(|e| e == "json") {
                    let view = read_object(&path).ok().flatten();
                    found.push((path, view));
                }
            }
        }
        found
    }
}
