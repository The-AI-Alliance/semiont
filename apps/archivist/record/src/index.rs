//! The storage-uri index: which resource's content is at a place in the
//! working tree.

use crate::shard::shard_path;
use crate::{Object, RecordError, failed, indented, read_object, write_whole};
use ring::digest::{SHA256, digest};
use semiont::channels::{Channel, YieldCloned, YieldCreated, YieldMoved};
use serde_json::{Value, json};
use std::path::{Path, PathBuf};

pub struct UriIndex {
    dir: PathBuf,
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

impl UriIndex {
    pub fn new(state_dir: &Path) -> UriIndex {
        UriIndex {
            dir: state_dir.join("projections").join("storage-uri"),
        }
    }

    fn path(&self, uri: &str) -> PathBuf {
        let (ab, cd) = shard_path(uri);
        self.dir.join(ab).join(cd).join(format!(
            "{}.json",
            hex(digest(&SHA256, uri.as_bytes()).as_ref())
        ))
    }

    /// The resource whose content is at `uri`, if the index holds one.
    pub fn resolve(&self, uri: &str) -> Result<Option<String>, RecordError> {
        Ok(read_object(&self.path(uri))?.and_then(|entry| {
            entry
                .get("resourceId")
                .and_then(Value::as_str)
                .map(str::to_owned)
        }))
    }

    fn put(&self, uri: &str, resource_id: &str) -> Result<(), RecordError> {
        let mut entry = Object::new();
        entry.insert("uri".into(), json!(uri));
        entry.insert("resourceId".into(), json!(resource_id));
        write_whole(&self.path(uri), &indented(&entry))
    }

    fn drop(&self, uri: &str) -> Result<(), RecordError> {
        let path = self.path(uri);
        match std::fs::remove_file(&path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(failed("cannot remove", &path, error)),
        }
    }

    /// Start the index from nothing: for a rebuild from the log.
    pub fn clear(&self) -> Result<(), RecordError> {
        match std::fs::remove_dir_all(&self.dir) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(failed("cannot remove", &self.dir, error)),
        }
    }

    /// Apply one event of a resource's stream.
    pub fn apply(&self, resource_id: &str, event: &Object) -> Result<(), RecordError> {
        let none = Object::new();
        let payload = event
            .get("payload")
            .and_then(Value::as_object)
            .unwrap_or(&none);
        let text = |key: &str| {
            payload
                .get(key)
                .and_then(Value::as_str)
                .filter(|v| !v.is_empty())
        };
        match event.get("type").and_then(Value::as_str) {
            Some(YieldCreated::NAME | YieldCloned::NAME) => match text("storageUri") {
                Some(uri) => self.put(uri, resource_id),
                None => Ok(()),
            },
            Some(YieldMoved::NAME) => {
                if let Some(from) = text("fromUri") {
                    self.drop(from)?;
                }
                match text("toUri") {
                    Some(to) => self.put(to, resource_id),
                    None => Ok(()),
                }
            }
            _ => Ok(()),
        }
    }
}
