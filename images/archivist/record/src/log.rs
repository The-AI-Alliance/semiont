//! The event log: a stream of files per resource, and one for the knowledge
//! base itself, each line a stored event.

use crate::shard::shard_path;
use crate::{Object, RecordError, SYSTEM, failed, ids};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};

/// How many events a file of a stream holds.
const EVENTS_PER_FILE: u64 = 10_000;

/// Where a stream stands: its last sequence number, and the file being
/// appended to with how many lines it holds.
struct Position {
    sequence: u64,
    file: u32,
    lines: u64,
}

pub struct Log {
    events_dir: PathBuf,
    positions: HashMap<String, Position>,
}

/// What an append wrote.
pub struct Appended {
    /// The stored event: the event as given, then its id, timestamp and
    /// sequence number.
    pub event: Object,
    /// What is to be staged: the stream's directory when it is new, and the
    /// file appended to.
    pub changed: Vec<PathBuf>,
}

/// A stream as read: its events, oldest first, and a note for each line that
/// was not an event. An event is a JSON object that states its `type`.
pub struct Stream {
    pub events: Vec<Object>,
    pub unread: Vec<String>,
}

fn file_name(number: u32) -> String {
    format!("events-{number:06}.jsonl")
}

fn file_number(name: &str) -> Option<u32> {
    name.strip_prefix("events-")?
        .strip_suffix(".jsonl")?
        .parse()
        .ok()
}

/// The time an event is appended: UTC, to the millisecond.
pub fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn sequence_of(event: &Object) -> Option<u64> {
    event.get("metadata")?.get("sequenceNumber")?.as_u64()
}

impl Log {
    pub fn new(root: &Path) -> Log {
        Log {
            events_dir: root.join(".semiont").join("events"),
            positions: HashMap::new(),
        }
    }

    /// A stream's directory: filed by the shard of its id, except the
    /// knowledge base's own.
    pub fn stream_dir(&self, stream: &str) -> Result<PathBuf, RecordError> {
        let stream = ids::safe(stream)?;
        if stream == SYSTEM {
            return Ok(self.events_dir.join(SYSTEM));
        }
        let (ab, cd) = shard_path(stream);
        Ok(self.events_dir.join(ab).join(cd).join(stream))
    }

    /// The files of a stream, by number.
    fn files(&self, dir: &Path) -> Result<Vec<u32>, RecordError> {
        let entries = match std::fs::read_dir(dir) {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(error) => return Err(failed("cannot list", dir, error)),
        };
        let mut numbers: Vec<u32> = entries
            .filter_map(|entry| file_number(&entry.ok()?.file_name().to_string_lossy()))
            .collect();
        numbers.sort_unstable();
        Ok(numbers)
    }

    /// The events of one file, and a note for each line that is not one.
    fn read_file(path: &Path, into: &mut Stream) -> Result<(), RecordError> {
        let text = match std::fs::read_to_string(path) {
            Ok(text) => text,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(error) => {
                return Err(failed("failed to read event log entry", path, error));
            }
        };
        for (index, line) in text.split('\n').enumerate() {
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            match serde_json::from_str::<Value>(line) {
                Ok(Value::Object(event)) if event.get("type").is_some_and(Value::is_string) => {
                    into.events.push(event);
                }
                _ => into.unread.push(format!(
                    "{} line {} is not an event",
                    path.display(),
                    index + 1
                )),
            }
        }
        Ok(())
    }

    /// Every event of a stream, file by file in file order.
    pub fn read(&self, stream: &str) -> Result<Stream, RecordError> {
        let dir = self.stream_dir(stream)?;
        let mut read = Stream {
            events: Vec::new(),
            unread: Vec::new(),
        };
        for number in self.files(&dir)? {
            Log::read_file(&dir.join(file_name(number)), &mut read)?;
        }
        Ok(read)
    }

    /// Every resource that has a stream. A directory where a stream would be
    /// whose name is not an id is noted, not listed.
    pub fn streams(&self) -> Result<(Vec<String>, Vec<String>), RecordError> {
        let mut streams = Vec::new();
        let mut notes = Vec::new();
        let dirs = |dir: &Path| -> Result<Vec<(String, PathBuf)>, RecordError> {
            let entries = match std::fs::read_dir(dir) {
                Ok(entries) => entries,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    return Ok(Vec::new());
                }
                Err(error) => return Err(failed("cannot list", dir, error)),
            };
            let mut found: Vec<(String, PathBuf)> = entries
                .filter_map(Result::ok)
                .filter(|entry| entry.path().is_dir())
                .map(|entry| {
                    (
                        entry.file_name().to_string_lossy().into_owned(),
                        entry.path(),
                    )
                })
                .collect();
            found.sort();
            Ok(found)
        };
        let is_shard = |name: &str| name.len() == 2 && name.bytes().all(|b| b.is_ascii_hexdigit());
        for (ab, ab_dir) in dirs(&self.events_dir)? {
            if ab == SYSTEM {
                continue;
            }
            if !is_shard(&ab) {
                notes.push(format!(
                    "{} is not a shard of the event log",
                    ab_dir.display()
                ));
                continue;
            }
            for (cd, cd_dir) in dirs(&ab_dir)? {
                if !is_shard(&cd) {
                    notes.push(format!(
                        "{} is not a shard of the event log",
                        cd_dir.display()
                    ));
                    continue;
                }
                for (id, id_dir) in dirs(&cd_dir)? {
                    if ids::is_safe(&id) && shard_path(&id) == (ab.clone(), cd.clone()) {
                        streams.push(id);
                    } else {
                        notes.push(format!(
                            "{} is not a stream of the event log",
                            id_dir.display()
                        ));
                    }
                }
            }
        }
        Ok((streams, notes))
    }

    /// A stream's events from sequence `from` on, in log order, and at most
    /// `at_most` of them. The files before the one that holds `from` are not
    /// read: of each, only the first event is.
    pub fn read_from(
        &self,
        stream: &str,
        from: u64,
        at_most: usize,
    ) -> Result<Stream, RecordError> {
        let dir = self.stream_dir(stream)?;
        let files = self.files(&dir)?;
        let mut start = 0;
        for (index, &number) in files.iter().enumerate() {
            match Log::first_sequence(&dir.join(file_name(number)))? {
                Some(first) if first <= from => start = index,
                Some(_) => break,
                None => {}
            }
        }
        let mut read = Stream {
            events: Vec::new(),
            unread: Vec::new(),
        };
        for &number in &files[start..] {
            Log::read_file(&dir.join(file_name(number)), &mut read)?;
            read.events
                .retain(|event| sequence_of(event).is_some_and(|sequence| sequence >= from));
            if read.events.len() >= at_most {
                break;
            }
        }
        read.events.truncate(at_most);
        Ok(read)
    }

    /// The sequence number of a file's first event, read no further than
    /// that event. None for a file that holds none.
    fn first_sequence(path: &Path) -> Result<Option<u64>, RecordError> {
        let file = match std::fs::File::open(path) {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(failed("failed to read event log entry", path, error)),
        };
        for line in std::io::BufReader::new(file).lines() {
            let line =
                line.map_err(|error| failed("failed to read event log entry", path, error))?;
            if let Ok(Value::Object(event)) = serde_json::from_str::<Value>(line.trim())
                && event.get("type").is_some_and(Value::is_string)
            {
                return Ok(sequence_of(&event));
            }
        }
        Ok(None)
    }

    /// The sequence number of a stream's last event: 0 for a stream with none.
    pub fn last_sequence(&self, stream: &str) -> Result<u64, RecordError> {
        if let Some(position) = self.positions.get(stream) {
            return Ok(position.sequence);
        }
        self.last_on_disk(&self.stream_dir(stream)?)
    }

    /// The last sequence number a stream's files hold: read from its last
    /// file back to the first that holds an event. 0 for none.
    fn last_on_disk(&self, dir: &Path) -> Result<u64, RecordError> {
        for number in self.files(dir)?.into_iter().rev() {
            let mut read = Stream {
                events: Vec::new(),
                unread: Vec::new(),
            };
            Log::read_file(&dir.join(file_name(number)), &mut read)?;
            if let Some(found) = read.events.iter().filter_map(sequence_of).max() {
                return Ok(found);
            }
        }
        Ok(0)
    }

    /// Where a stream stands on disk: its last event's sequence number, its
    /// last file, and that file's lines. A last file that does not end with
    /// a newline is ended with one, so the next event is a line of its own.
    fn position(&self, dir: &Path) -> Result<Option<Position>, RecordError> {
        let files = self.files(dir)?;
        let Some(&last) = files.last() else {
            return Ok(None);
        };
        let sequence = self.last_on_disk(dir)?;
        let path = dir.join(file_name(last));
        let text = std::fs::read_to_string(&path)
            .map_err(|e| failed("failed to read event log entry", &path, e))?;
        if !text.is_empty() && !text.ends_with('\n') {
            std::fs::OpenOptions::new()
                .append(true)
                .open(&path)
                .and_then(|mut file| file.write_all(b"\n"))
                .map_err(|e| failed("cannot write", &path, e))?;
        }
        let lines = text
            .split('\n')
            .filter(|line| !line.trim().is_empty())
            .count() as u64;
        Ok(Some(Position {
            sequence,
            file: last,
            lines,
        }))
    }

    /// Append `event` to `stream`: give it an id, the time and the stream's
    /// next sequence number, and write it as one line.
    pub fn append(&mut self, stream: &str, event: Object) -> Result<Appended, RecordError> {
        let dir = self.stream_dir(stream)?;
        let mut changed = Vec::new();
        if !self.positions.contains_key(stream) {
            let found = match self.position(&dir)? {
                Some(found) => found,
                None => {
                    let fresh = !dir.exists();
                    std::fs::create_dir_all(&dir).map_err(|e| failed("cannot create", &dir, e))?;
                    let first = dir.join(file_name(1));
                    std::fs::write(&first, "").map_err(|e| failed("cannot write", &first, e))?;
                    if fresh {
                        changed.push(dir.clone());
                    }
                    Position {
                        sequence: 0,
                        file: 1,
                        lines: 0,
                    }
                }
            };
            self.positions.insert(stream.to_owned(), found);
        }
        let position = self
            .positions
            .get_mut(stream)
            .expect("the stream's position was just placed");
        if position.lines >= EVENTS_PER_FILE {
            let next = dir.join(file_name(position.file + 1));
            std::fs::write(&next, "").map_err(|e| failed("cannot write", &next, e))?;
            position.file += 1;
            position.lines = 0;
        }

        let mut stored = event;
        stored.insert("id".into(), json!(uuid::Uuid::new_v4().to_string()));
        stored.insert("timestamp".into(), json!(now()));
        stored.insert(
            "metadata".into(),
            json!({ "sequenceNumber": position.sequence + 1 }),
        );
        let mut line = serde_json::to_string(&stored).expect("a JSON object serializes");
        line.push('\n');
        let path = dir.join(file_name(position.file));
        std::fs::OpenOptions::new()
            .append(true)
            .create(true)
            .open(&path)
            .and_then(|mut file| file.write_all(line.as_bytes()))
            .map_err(|e| failed("cannot append to", &path, e))?;
        position.sequence += 1;
        position.lines += 1;
        changed.push(path);
        Ok(Appended {
            event: stored,
            changed,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::{Log, file_name};
    use semiont::channels::{Channel, MarkArchived, MarkUnarchived};
    use serde_json::{Map, json};

    #[test]
    fn a_line_is_an_event_only_when_it_states_its_type() {
        let root = std::env::temp_dir().join(format!("semiont-log-{}", uuid::Uuid::new_v4()));
        let mut log = Log::new(&root);
        let stream = "a-stream";
        let dir = log.stream_dir(stream).expect("a stream is filed by its id");
        std::fs::create_dir_all(&dir).expect("the stream's directory is made");
        let path = dir.join(file_name(1));
        let lines = [
            json!({ "type": MarkArchived::NAME, "metadata": { "sequenceNumber": 1 } }).to_string(),
            String::new(),
            "this line is not JSON".to_owned(),
            json!({ "event": { "type": MarkUnarchived::NAME }, "metadata": { "sequenceNumber": 7 } })
                .to_string(),
            "[1]".to_owned(),
        ];
        std::fs::write(&path, lines.join("\n") + "\n").expect("the stream's file is written");

        let read = log.read(stream).expect("the stream is read");
        let mut next = Map::new();
        next.insert("type".into(), json!(MarkUnarchived::NAME));
        let appended = log.append(stream, next);
        std::fs::remove_dir_all(&root).expect("the test's directory is removed");

        let types: Vec<_> = read
            .events
            .iter()
            .map(|event| event["type"].clone())
            .collect();
        assert_eq!(types, [json!(MarkArchived::NAME)]);
        let note = |line: u32| format!("{} line {line} is not an event", path.display());
        assert_eq!(read.unread, [note(3), note(4), note(5)]);
        // A line that is not an event gives the stream no sequence number:
        // the next event follows the last one read.
        assert_eq!(
            appended.expect("the event is appended").event["metadata"],
            json!({ "sequenceNumber": 2 })
        );
    }

    #[test]
    fn a_stream_is_read_from_a_sequence_across_its_files_and_stands_at_its_last_event() {
        let root = std::env::temp_dir().join(format!("semiont-log-{}", uuid::Uuid::new_v4()));
        let log = Log::new(&root);
        let stream = "a-long-stream";
        let dir = log.stream_dir(stream).expect("a stream is filed by its id");
        std::fs::create_dir_all(&dir).expect("the stream's directory is made");
        let lines = |sequences: std::ops::RangeInclusive<u64>| -> String {
            sequences
                .map(|n| {
                    json!({ "type": MarkArchived::NAME, "metadata": { "sequenceNumber": n } })
                        .to_string()
                        + "\n"
                })
                .collect()
        };
        // A first file that begins with a line that is no event, and two more.
        std::fs::write(
            dir.join(file_name(1)),
            format!("not an event\n{}", lines(1..=3)),
        )
        .expect("the first file is written");
        std::fs::write(dir.join(file_name(2)), lines(4..=6)).expect("the second file is written");
        std::fs::write(dir.join(file_name(3)), lines(7..=7)).expect("the third file is written");

        let read = |from: u64, at_most: usize| -> Vec<u64> {
            log.read_from(stream, from, at_most)
                .expect("the stream is read")
                .events
                .iter()
                .filter_map(super::sequence_of)
                .collect()
        };
        let last = log.last_sequence(stream);
        let nowhere = log.last_sequence("no-such-stream");
        let (from_the_first, across, to_the_end, past_the_end) =
            (read(1, 2), read(3, 3), read(5, 10), read(8, 10));
        std::fs::remove_dir_all(&root).expect("the test's directory is removed");

        assert_eq!(from_the_first, [1, 2]);
        assert_eq!(across, [3, 4, 5]);
        assert_eq!(to_the_end, [5, 6, 7]);
        assert_eq!(past_the_end, Vec::<u64>::new());
        assert_eq!(last.expect("the stream stands somewhere"), 7);
        assert_eq!(
            nowhere.expect("a stream that is not there stands at none"),
            0
        );
    }
}
