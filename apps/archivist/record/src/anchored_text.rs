//! The anchored-text store: what the Smelter derived from some bytes, filed
//! under their checksum, and the stamp its entries are taken under.
//!
//! An entry is the file `<ab>/<cd>/<checksum>.json` under the store's
//! directory, an `AnchoredTextEntry` as compact JSON with `v` and `stamp`
//! first. The stamp last stated is the file `STAMP` at the directory's root,
//! the stamp and a line feed. An entry is taken only when its `v` is
//! `VERSION` and its `stamp` is the one stated; nothing here deletes one.

use crate::shard::shard_path;
use crate::{Object, RecordError, failed, write_whole};
use serde_json::{Value, json};
use std::io::Read;
use std::path::{Path, PathBuf};

/// The entry format the store keeps and takes.
pub const VERSION: u64 = 3;

const STAMP: &str = "STAMP";

fn entry_path(dir: &Path, checksum: &str) -> PathBuf {
    let (ab, cd) = shard_path(checksum);
    dir.join(ab).join(cd).join(format!("{checksum}.json"))
}

/// The bytes every entry of `stamp` begins with: its version, then its stamp.
fn head(stamp: &str) -> String {
    format!("{{\"v\":{VERSION},\"stamp\":{},", json!(stamp))
}

/// The stamp last stated, or none when none has been.
pub fn stated_stamp(dir: &Path) -> Result<Option<String>, RecordError> {
    let path = dir.join(STAMP);
    match std::fs::read_to_string(&path) {
        Ok(text) => Ok(Some(text.trim().to_owned()).filter(|stamp| !stamp.is_empty())),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(failed("cannot read", &path, error)),
    }
}

/// State the stamp the store's entries are taken under.
pub fn state_stamp(dir: &Path, stamp: &str) -> Result<(), RecordError> {
    write_whole(&dir.join(STAMP), &format!("{stamp}\n"))
}

/// Store `entry` for bytes of `checksum`, replacing what was there: written
/// whole, with `v` and `stamp` first.
pub fn store(dir: &Path, checksum: &str, entry: &Object) -> Result<(), RecordError> {
    let mut ordered = Object::new();
    for key in ["v", "stamp"] {
        if let Some(value) = entry.get(key) {
            ordered.insert(key.to_owned(), value.clone());
        }
    }
    for (key, value) in entry {
        if key != "v" && key != "stamp" {
            ordered.insert(key.clone(), value.clone());
        }
    }
    let text = serde_json::to_string(&Value::Object(ordered)).expect("a JSON value serializes");
    write_whole(&entry_path(dir, checksum), &text)
}

/// The entry stored for bytes of `checksum`, as it is stored, when it is of
/// this version and under the stamp last stated.
pub fn entry(dir: &Path, checksum: &str) -> Result<Option<Object>, RecordError> {
    let Some(stamp) = stated_stamp(dir)? else {
        return Ok(None);
    };
    let path = entry_path(dir, checksum);
    let text = match std::fs::read_to_string(&path) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(failed("cannot read", &path, error)),
    };
    let Ok(Value::Object(entry)) = serde_json::from_str::<Value>(&text) else {
        return Ok(None);
    };
    let taken = entry.get("v") == Some(&json!(VERSION))
        && entry.get("stamp").and_then(Value::as_str) == Some(stamp.as_str());
    Ok(taken.then_some(entry))
}

/// The checksums of the entries stored under the stamp last stated: each
/// file filed where its name says, that begins as an entry of that stamp
/// begins. No entry is read whole.
pub fn keys(dir: &Path) -> Result<Vec<String>, RecordError> {
    let Some(stamp) = stated_stamp(dir)? else {
        return Ok(Vec::new());
    };
    let head = head(&stamp).into_bytes();
    let mut keys = Vec::new();
    for ab in subdirectories(dir)? {
        for cd in subdirectories(&ab)? {
            for file in std::fs::read_dir(&cd).map_err(|e| failed("cannot read", &cd, e))? {
                let path = file.map_err(|e| failed("cannot read", &cd, e))?.path();
                let Some(checksum) = path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .and_then(|name| name.strip_suffix(".json"))
                else {
                    continue;
                };
                if path != entry_path(dir, checksum) || !begins(&path, &head)? {
                    continue;
                }
                keys.push(checksum.to_owned());
            }
        }
    }
    keys.sort();
    Ok(keys)
}

fn subdirectories(dir: &Path) -> Result<Vec<PathBuf>, RecordError> {
    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(failed("cannot read", dir, error)),
    };
    let mut out = Vec::new();
    for entry in entries {
        let path = entry.map_err(|e| failed("cannot read", dir, e))?.path();
        if path.is_dir() {
            out.push(path);
        }
    }
    Ok(out)
}

fn begins(path: &Path, head: &[u8]) -> Result<bool, RecordError> {
    let mut file = std::fs::File::open(path).map_err(|e| failed("cannot read", path, e))?;
    let mut start = vec![0; head.len()];
    match file.read_exact(&mut start) {
        Ok(()) => Ok(start == head),
        Err(error) if error.kind() == std::io::ErrorKind::UnexpectedEof => Ok(false),
        Err(error) => Err(failed("cannot read", path, error)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "anchored-text-{}-{}",
            std::process::id(),
            chrono::Utc::now()
                .timestamp_nanos_opt()
                .expect("now is in range")
        ));
        std::fs::create_dir_all(&dir).expect("a temporary directory");
        dir
    }

    fn entry_of(stamp: &str, declined: &str) -> Object {
        let Value::Object(entry) = json!({ "declined": declined, "stamp": stamp, "v": 3 }) else {
            unreachable!()
        };
        entry
    }

    #[test]
    fn an_entry_is_written_with_its_version_and_stamp_first_and_listed_under_its_stamp() {
        let dir = dir();
        state_stamp(&dir, "reader-1+engine-1").expect("stated");
        store(&dir, "ab12", &entry_of("reader-1+engine-1", "encrypted")).expect("stored");
        let text = std::fs::read_to_string(entry_path(&dir, "ab12")).expect("written");
        assert!(text.starts_with(&head("reader-1+engine-1")), "{text}");
        assert_eq!(keys(&dir).expect("listed"), vec!["ab12".to_owned()]);
        assert!(entry(&dir, "ab12").expect("read").is_some());

        state_stamp(&dir, "reader-2+engine-1").expect("stated");
        assert!(keys(&dir).expect("listed").is_empty());
        assert!(entry(&dir, "ab12").expect("read").is_none());
    }
}
