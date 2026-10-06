//! What the knowledge base's own stream adds up to: its entity types, its
//! tag schemas, and what its people are called.

use crate::{Object, RecordError, dictionary_order, indented, read_object};
use serde_json::{Value, json};
use std::path::{Path, PathBuf};

pub struct Projections {
    dir: PathBuf,
}

const ENTITY_TYPES: (&str, &str) = ("entitytypes.json", "entityTypes");
const TAG_SCHEMAS: (&str, &str) = ("tagschemas.json", "tagSchemas");
const PEOPLE: (&str, &str) = ("people.json", "people");

impl Projections {
    pub fn new(state_dir: &Path) -> Projections {
        Projections {
            dir: state_dir.join("projections").join("__system__"),
        }
    }

    fn read(&self, (file, key): (&str, &str), empty: Value) -> Result<Object, RecordError> {
        let mut projection = read_object(&self.dir.join(file))?.unwrap_or_default();
        if !projection.contains_key(key) {
            projection.insert(key.into(), empty);
        }
        Ok(projection)
    }

    fn write(&self, (file, _): (&str, &str), projection: &Object) -> Result<(), RecordError> {
        crate::write_whole(&self.dir.join(file), &indented(projection))
    }

    /// Every entity type added, each once, sorted.
    pub fn entity_types(&self) -> Result<Vec<Value>, RecordError> {
        Ok(self.read(ENTITY_TYPES, json!([]))?[ENTITY_TYPES.1]
            .as_array()
            .cloned()
            .unwrap_or_default())
    }

    /// Every tag schema added, sorted by id.
    pub fn tag_schemas(&self) -> Result<Vec<Value>, RecordError> {
        Ok(self.read(TAG_SCHEMAS, json!([]))?[TAG_SCHEMAS.1]
            .as_array()
            .cloned()
            .unwrap_or_default())
    }

    /// Each person's profile, by DID.
    pub fn people(&self) -> Result<Object, RecordError> {
        Ok(self.read(PEOPLE, json!({}))?[PEOPLE.1]
            .as_object()
            .cloned()
            .unwrap_or_default())
    }

    /// Start every projection from nothing: for a rebuild from the log.
    pub fn clear(&self) -> Result<(), RecordError> {
        for (file, _) in [ENTITY_TYPES, TAG_SCHEMAS, PEOPLE] {
            match std::fs::remove_file(self.dir.join(file)) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => {
                    return Err(crate::failed("cannot remove", &self.dir.join(file), error));
                }
            }
        }
        Ok(())
    }

    /// Apply one event of the knowledge base's own stream.
    pub fn apply(&self, event: &Object) -> Result<(), RecordError> {
        let none = Object::new();
        let payload = event
            .get("payload")
            .and_then(Value::as_object)
            .unwrap_or(&none);
        match event.get("type").and_then(Value::as_str) {
            Some("frame:entity-type-added") => {
                let Some(added) = payload.get("entityType").and_then(Value::as_str) else {
                    return Ok(());
                };
                let mut projection = self.read(ENTITY_TYPES, json!([]))?;
                let mut types: Vec<String> = projection[ENTITY_TYPES.1]
                    .as_array()
                    .map(|held| {
                        held.iter()
                            .filter_map(Value::as_str)
                            .map(str::to_owned)
                            .collect()
                    })
                    .unwrap_or_default();
                if !types.iter().any(|held| held == added) {
                    types.push(added.to_owned());
                }
                types.sort_by(|a, b| dictionary_order(a, b));
                projection.insert(ENTITY_TYPES.1.into(), json!(types));
                self.write(ENTITY_TYPES, &projection)
            }
            Some("frame:tag-schema-added") => {
                let Some(added) = payload.get("schema") else {
                    return Ok(());
                };
                let mut projection = self.read(TAG_SCHEMAS, json!([]))?;
                let mut schemas = projection[TAG_SCHEMAS.1]
                    .as_array()
                    .cloned()
                    .unwrap_or_default();
                match schemas
                    .iter()
                    .position(|held| held.get("id") == added.get("id"))
                {
                    Some(at) => schemas[at] = added.clone(),
                    None => schemas.push(added.clone()),
                }
                let id = |schema: &Value| {
                    schema
                        .get("id")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_owned()
                };
                schemas.sort_by(|a, b| dictionary_order(&id(a), &id(b)));
                projection.insert(TAG_SCHEMAS.1.into(), Value::Array(schemas));
                self.write(TAG_SCHEMAS, &projection)
            }
            Some("person:profiled") => {
                let (Some(did), Some(name)) = (
                    event.get("userId").and_then(Value::as_str),
                    payload.get("name"),
                ) else {
                    return Ok(());
                };
                let mut projection = self.read(PEOPLE, json!({}))?;
                let people = projection[PEOPLE.1].as_object_mut();
                if let Some(people) = people {
                    people.insert(
                        did.to_owned(),
                        json!({ "name": name, "since": event.get("timestamp") }),
                    );
                }
                self.write(PEOPLE, &projection)
            }
            _ => Ok(()),
        }
    }
}
