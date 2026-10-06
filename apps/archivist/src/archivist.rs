//! The Archivist's state: the record and what stands around it. One lock
//! holds the record, so an event is appended, its views changed and its fact
//! queued before the next is begun.

use crate::anchored::SmeltProgress;
use crate::content::Content;
use semiont_archivist_record::kb::Committed;
use semiont_archivist_record::record::Record;
use semiont_archivist_record::{Object, SYSTEM};
use semiont_archivist_staging::Staging;
use semiont_core::types::ArchivistConfig;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use tokio::sync::mpsc::UnboundedSender;

/// A clone token: the resource it lets its holder copy, and until when.
pub struct CloneToken {
    pub resource_id: String,
    pub expires_at: chrono::DateTime<chrono::Utc>,
}

pub struct Archivist {
    pub config: ArchivistConfig,
    pub root: PathBuf,
    /// What the knowledge base said of itself at boot.
    pub kb: Committed,
    record: Mutex<Record>,
    pub content: Content,
    pub staging: Arc<dyn Staging>,
    pub tokens: Mutex<HashMap<String, CloneToken>>,
    pub smelt: SmeltProgress,
    facts: UnboundedSender<Object>,
    /// Events appended and not yet published.
    pub unpublished: Arc<AtomicI64>,
}

/// A command refused, or a read that could not be answered.
#[derive(Debug)]
pub struct Refusal {
    pub message: String,
    pub code: Option<&'static str>,
}

impl From<String> for Refusal {
    fn from(message: String) -> Refusal {
        Refusal {
            message,
            code: None,
        }
    }
}

impl From<&str> for Refusal {
    fn from(message: &str) -> Refusal {
        Refusal::from(message.to_owned())
    }
}

impl From<semiont_archivist_record::RecordError> for Refusal {
    fn from(error: semiont_archivist_record::RecordError) -> Refusal {
        Refusal::from(error.to_string())
    }
}

pub fn locked<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// An event as a command builds one: its type, the resource it is about when
/// it is about one, who sent the command, and its payload.
pub fn event(kind: &str, resource_id: Option<&str>, user: &str, payload: Object) -> Object {
    let mut event = Object::new();
    event.insert("type".into(), json!(kind));
    if let Some(resource_id) = resource_id {
        event.insert("resourceId".into(), json!(resource_id));
    }
    event.insert("userId".into(), json!(user));
    event.insert("version".into(), json!(1));
    event.insert("payload".into(), Value::Object(payload));
    event
}

impl Archivist {
    pub fn new(
        config: ArchivistConfig,
        root: PathBuf,
        kb: Committed,
        record: Record,
        staging: Arc<dyn Staging>,
        facts: UnboundedSender<Object>,
    ) -> Archivist {
        Archivist {
            content: Content::new(&root, staging.clone()),
            config,
            root,
            kb,
            record: Mutex::new(record),
            staging,
            tokens: Mutex::new(HashMap::new()),
            smelt: SmeltProgress::default(),
            facts,
            unpublished: Arc::new(AtomicI64::new(0)),
        }
    }

    /// The record, held: nothing else reads or appends until it is let go.
    pub fn record(&self) -> MutexGuard<'_, Record> {
        locked(&self.record)
    }

    /// Append an event: write its line, change the views, stage what
    /// changed, and queue its fact, carrying its annotation when its type
    /// calls for one. Answers the stored event.
    pub fn append(&self, event: Object) -> Result<Object, Refusal> {
        tokio::task::block_in_place(|| {
            let mut record = self.record();
            let recorded = record.append(event)?;
            for path in &recorded.changed {
                self.staging.stage(path);
            }
            let stored = recorded.event;
            let mut published = stored.clone();
            let annotation_id = match stored.get("type").and_then(Value::as_str) {
                Some("mark:added") => stored["payload"]["annotation"].get("id").cloned(),
                Some("mark:body-updated") => stored["payload"].get("annotationId").cloned(),
                _ => None,
            };
            if let (Some(annotation_id), Some(resource_id)) = (
                annotation_id,
                stored.get("resourceId").and_then(Value::as_str),
            ) && let Some(view) = record.views.get(resource_id)?
                && let Some(annotation) = view["annotations"]["annotations"]
                    .as_array()
                    .and_then(|held| held.iter().find(|a| a.get("id") == Some(&annotation_id)))
            {
                published.insert("annotation".into(), annotation.clone());
            }
            self.unpublished.fetch_add(1, Ordering::SeqCst);
            let _ = self.facts.send(published);
            Ok(stored)
        })
    }

    /// A resource's view as held, or none.
    pub fn held_view(&self, resource_id: &str) -> Result<Option<Object>, Refusal> {
        Ok(tokio::task::block_in_place(|| {
            self.record().views.get(resource_id)
        })?)
    }

    /// Every event of a stream, oldest first.
    pub fn events(&self, stream: &str) -> Result<Vec<Object>, Refusal> {
        Ok(tokio::task::block_in_place(|| self.record().log.read(stream))?.events)
    }

    /// Every event of the knowledge base's own stream.
    pub fn system_events(&self) -> Result<Vec<Object>, Refusal> {
        self.events(SYSTEM)
    }
}

/// A text field of a payload, when it holds one that is not empty.
pub fn text<'a>(payload: &'a Object, key: &str) -> Option<&'a str> {
    payload
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
}

/// The first representation of a view's resource.
pub fn primary_representation(view: &Object) -> Option<&Object> {
    view.get("resource")?
        .get("representations")?
        .as_array()?
        .first()?
        .as_object()
}
