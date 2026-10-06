//! The Archivist's record, as docs/protocol/ARCHIVIST.md states it: the event
//! log, the views and the projections, and where each is filed.
//!
//! This crate reaches no network and runs no other program: it links no HTTP
//! client or server and no git. The HTTP surface, the bus and the staging
//! drivers are the crates around it, and the Archivist's binary composes
//! them.
//!
//! Events, views and annotations are held as JSON objects whose keys keep
//! the order they were given in: the files are read by other processes, and
//! are written byte for byte as the protocol says.

#![forbid(unsafe_code)]

pub mod agents;
pub mod ids;
pub mod index;
pub mod kb;
pub mod log;
pub mod projections;
pub mod record;
pub mod shard;
pub mod view;

use serde_json::{Map, Value};
use std::fmt;
use std::path::Path;

/// The order names are kept in, as a dictionary has them: by their letters,
/// whatever their accents and their case; then an unaccented letter before
/// an accented one; then a small letter before its capital.
pub fn dictionary_order(a: &str, b: &str) -> std::cmp::Ordering {
    use unicode_normalization::UnicodeNormalization;
    use unicode_normalization::char::is_combining_mark;
    let letters = |s: &str| -> String {
        s.nfd()
            .filter(|c| !is_combining_mark(*c))
            .flat_map(char::to_lowercase)
            .collect()
    };
    let accents = |s: &str| -> String { s.nfd().flat_map(char::to_lowercase).collect() };
    letters(a)
        .cmp(&letters(b))
        .then_with(|| accents(a).cmp(&accents(b)))
        .then_with(|| b.cmp(a))
}

/// A JSON object whose keys keep their order.
pub type Object = Map<String, Value>;

/// The stream of events about the knowledge base itself.
pub const SYSTEM: &str = "__system__";

/// Why the record could not do what it was asked.
#[derive(Debug)]
pub struct RecordError(pub String);

impl fmt::Display for RecordError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for RecordError {}

pub(crate) fn failed(what: &str, path: &Path, error: impl fmt::Display) -> RecordError {
    RecordError(format!("{what} {}: {error}", path.display()))
}

/// Write `text` at `path` so that a reader sees the whole of it or what was
/// there before: to a file beside it, renamed onto it.
pub(crate) fn write_whole(path: &Path, text: &str) -> Result<(), RecordError> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| failed("cannot create", parent, e))?;
    }
    let beside = path.with_extension(format!(
        "json.{}.{}.tmp",
        std::process::id(),
        chrono::Utc::now().timestamp_millis()
    ));
    std::fs::write(&beside, text).map_err(|e| failed("cannot write", &beside, e))?;
    std::fs::rename(&beside, path).map_err(|e| {
        let _ = std::fs::remove_file(&beside);
        failed("cannot write", path, e)
    })
}

/// A document as the record writes one: JSON indented by two spaces.
pub(crate) fn indented(document: &Object) -> String {
    serde_json::to_string_pretty(document).expect("a JSON value serializes")
}

/// The JSON object at `path`, or none when there is no file.
pub(crate) fn read_object(path: &Path) -> Result<Option<Object>, RecordError> {
    let text = match std::fs::read_to_string(path) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(failed("cannot read", path, error)),
    };
    match serde_json::from_str::<Value>(&text) {
        Ok(Value::Object(object)) => Ok(Some(object)),
        Ok(_) => Err(failed("cannot read", path, "it is not a JSON object")),
        Err(error) => Err(failed("cannot read", path, error)),
    }
}
