//! The record as one thing: an append writes the line and changes the views,
//! and a rebuild makes the views what the log says.

use crate::index::UriIndex;
use crate::log::{Appended, Log};
use crate::projections::Projections;
use crate::view::{self, Views};
use crate::{Object, RecordError, SYSTEM};
use serde_json::Value;
use std::collections::HashSet;
use std::path::{Path, PathBuf};

pub struct Record {
    pub log: Log,
    pub views: Views,
    pub projections: Projections,
    pub index: UriIndex,
}

/// What a rebuild did.
#[derive(Debug, Default)]
pub struct Rebuilt {
    pub views: usize,
    pub reaped: Vec<PathBuf>,
    /// The streams that could not be rebuilt, each with why.
    pub failed: Vec<(String, String)>,
    /// Lines and directories of the log that were passed over.
    pub notes: Vec<String>,
}

/// An appended event, and what it left to do.
pub struct Recorded {
    /// The stored event.
    pub event: Object,
    /// The paths of the working tree the append changed.
    pub changed: Vec<PathBuf>,
}

impl Record {
    /// The record of the working tree at `root`, with its views in
    /// `state_dir`.
    pub fn new(root: &Path, state_dir: &Path) -> Record {
        Record {
            log: Log::new(root),
            views: Views::new(state_dir),
            projections: Projections::new(state_dir),
            index: UriIndex::new(state_dir),
        }
    }

    /// Append `event`: to its resource's stream, or to the knowledge base's
    /// own when it names none. The line is written, then the views changed.
    pub fn append(&mut self, event: Object) -> Result<Recorded, RecordError> {
        let stream = event
            .get("resourceId")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty())
            .unwrap_or(SYSTEM)
            .to_owned();
        let Appended { event, changed } = self.log.append(&stream, event)?;
        if stream == SYSTEM {
            self.projections.apply(&event)?;
        } else {
            let view = match self.views.get(&stream)? {
                Some(mut view) => {
                    view::apply(&mut view, &event);
                    Some(view)
                }
                None => view::build(&stream, &self.log.read(&stream)?.events),
            };
            if let Some(view) = view {
                self.views.save(&stream, &view)?;
            }
            self.index.apply(&stream, &event)?;
        }
        Ok(Recorded { event, changed })
    }

    /// A resource's view: the one held, or else the one its stream adds up
    /// to. None for a resource with no events.
    pub fn view(&self, resource_id: &str) -> Result<Option<Object>, RecordError> {
        match self.views.get(resource_id)? {
            Some(view) => Ok(Some(view)),
            None => Ok(view::build(
                resource_id,
                &self.log.read(resource_id)?.events,
            )),
        }
    }

    /// Make the views and projections what the log says: replay the
    /// knowledge base's own stream, rebuild every resource's view and its
    /// index entries, and delete every view whose resource has no stream.
    pub fn rebuild(&mut self) -> Result<Rebuilt, RecordError> {
        let mut rebuilt = Rebuilt::default();
        self.projections.clear()?;
        let system = self.log.read(SYSTEM)?;
        rebuilt.notes.extend(system.unread);
        for event in &system.events {
            self.projections.apply(event)?;
        }

        self.index.clear()?;
        let (streams, notes) = self.log.streams()?;
        rebuilt.notes.extend(notes);
        let mut known: HashSet<String> = HashSet::new();
        for stream in streams {
            known.insert(stream.clone());
            let outcome = (|| -> Result<bool, RecordError> {
                let read = self.log.read(&stream)?;
                rebuilt.notes.extend(read.unread);
                let Some(view) = view::build(&stream, &read.events) else {
                    return Ok(false);
                };
                self.views.save(&stream, &view)?;
                let mut ordered: Vec<&Object> = read.events.iter().collect();
                ordered.sort_by_key(|event| {
                    event
                        .get("metadata")
                        .and_then(|m| m.get("sequenceNumber"))
                        .and_then(Value::as_u64)
                        .unwrap_or(0)
                });
                for event in ordered {
                    self.index.apply(&stream, event)?;
                }
                Ok(true)
            })();
            match outcome {
                Ok(true) => rebuilt.views += 1,
                Ok(false) => {
                    known.remove(&stream);
                }
                Err(error) => rebuilt.failed.push((stream, error.to_string())),
            }
        }

        for (path, view) in self.views.all() {
            let of = view
                .as_ref()
                .and_then(|view| view.get("resource"))
                .and_then(|resource| resource.get("@id"))
                .and_then(Value::as_str);
            let kept = match of {
                Some(id) => known.contains(id),
                // A file that is not a view is not this pass's to judge.
                None => true,
            };
            if !kept && std::fs::remove_file(&path).is_ok() {
                rebuilt.reaped.push(path);
            }
        }
        Ok(rebuilt)
    }
}
