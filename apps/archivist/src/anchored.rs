//! Anchored text: which media types have any, the store the Smelter writes,
//! read under the stamp its writer states, and the wait for the Smelter to
//! settle content not yet in it.

use crate::archivist::{Archivist, Refusal, locked, primary_representation};
use semiont::media_types::{TextSource, capabilities_of};
use semiont_archivist_record::Object;
use semiont_archivist_record::shard::shard_path;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::path::Path;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};
use tokio::sync::oneshot;

/// How long a read waits for the Smelter to settle content the store lacks.
const SETTLE: Duration = Duration::from_secs(15);
/// How long the last settlement of a resource is remembered.
const REMEMBERED: Duration = Duration::from_secs(5 * 60);

struct Settled {
    checksum: String,
    at: Instant,
}

struct Waiter {
    resource_id: String,
    checksum: String,
    tell: oneshot::Sender<()>,
}

/// The latest `smelt:settled` of each resource, and who is waiting for one.
#[derive(Default)]
pub struct SmeltProgress {
    settled: Mutex<HashMap<String, Settled>>,
    waiting: Mutex<Vec<Waiter>>,
    stopping: AtomicBool,
}

impl SmeltProgress {
    /// The process is stopping. Every read waiting for the Smelter is
    /// answered now, as one whose wait ran out, and none waits after: a read
    /// is an HTTP request, and a held one would hold the stop for as long.
    pub fn stop_waiting(&self) {
        self.stopping.store(true, Ordering::SeqCst);
        locked(&self.waiting).clear();
    }

    /// The Smelter settled this content of this resource.
    pub fn settle(&self, resource_id: &str, checksum: &str) {
        {
            let mut settled = locked(&self.settled);
            settled.retain(|_, held| held.at.elapsed() < REMEMBERED);
            settled.insert(
                resource_id.to_owned(),
                Settled {
                    checksum: checksum.to_owned(),
                    at: Instant::now(),
                },
            );
        }
        let mut waiting = locked(&self.waiting);
        let (told, kept): (Vec<Waiter>, Vec<Waiter>) = waiting
            .drain(..)
            .partition(|w| w.resource_id == resource_id && w.checksum == checksum);
        *waiting = kept.into_iter().filter(|w| !w.tell.is_closed()).collect();
        for waiter in told {
            let _ = waiter.tell.send(());
        }
    }

    /// Whether the Smelter has settled this content, waiting for it to if it
    /// has not. False when the wait runs out.
    async fn when_settled(&self, resource_id: &str, checksum: &str) -> bool {
        let wait = {
            let settled = locked(&self.settled);
            let held = settled.get(resource_id);
            if held.is_some_and(|h| h.checksum == checksum) {
                return true;
            }
            let (tell, wait) = oneshot::channel();
            let mut waiting = locked(&self.waiting);
            if self.stopping.load(Ordering::SeqCst) {
                return false;
            }
            waiting.push(Waiter {
                resource_id: resource_id.to_owned(),
                checksum: checksum.to_owned(),
                tell,
            });
            wait
        };
        matches!(tokio::time::timeout(SETTLE, wait).await, Ok(Ok(())))
    }
}

fn valid_key(key: &str) -> bool {
    !key.is_empty()
        && key
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// The store's entry for content of this checksum, as an answer: a hit only
/// for an entry of version 3 under the stamp the writer states. Every miss is
/// none. A word's offsets are the entry's, carried as they are stored.
async fn read_entry(dir: &Path, checksum: &str) -> Option<Object> {
    if !valid_key(checksum) {
        return None;
    }
    let stated = tokio::fs::read_to_string(dir.join("STAMP")).await.ok()?;
    let stated = stated.trim();
    if stated.is_empty() {
        return None;
    }
    let (ab, cd) = shard_path(checksum);
    let text = tokio::fs::read_to_string(dir.join(ab).join(cd).join(format!("{checksum}.json")))
        .await
        .ok()?;
    let Value::Object(mut entry) = serde_json::from_str(&text).ok()? else {
        return None;
    };
    if entry.get("v") != Some(&json!(3))
        || entry.get("stamp").and_then(Value::as_str) != Some(stated)
    {
        return None;
    }
    let mut answer = Object::new();
    if let Some(declined) = entry.get("declined").filter(|d| d.is_string()) {
        answer.insert("kind".into(), json!("declined"));
        answer.insert("declined".into(), declined.clone());
        return Some(answer);
    }
    let text = entry.remove("text").filter(Value::is_string)?;
    let lines = entry.remove("lines")?;
    if !entry.get("method").is_some_and(Value::is_string) {
        return None;
    }
    let mut items = Vec::new();
    for line in lines.as_array()? {
        let (page, y, height) = (line.get("p")?, line.get("y")?, line.get("h")?);
        for word in line.get("words")?.as_array()? {
            let word = word
                .as_array()
                .filter(|w| w.len() == 4 && w.iter().all(Value::is_number))?;
            items.push(json!({
                "start": word[2], "end": word[3], "page": page,
                "x": word[0], "y": y, "width": word[1], "height": height,
            }));
        }
    }
    answer.insert("kind".into(), json!("extracted"));
    answer.insert("text".into(), text);
    answer.insert("items".into(), Value::Array(items));
    for (key, value) in entry {
        if key != "v" && key != "stamp" {
            answer.insert(key, value);
        }
    }
    Some(answer)
}

fn absent(kind: &str) -> Object {
    let mut answer = Object::new();
    answer.insert("kind".into(), json!(kind));
    answer
}

/// A resource's anchored text: the stored entry for its content, or why
/// there is none to give. Only a media type whose text is derived by reading
/// its content has any; one the registry does not have derives none.
///
/// Content the Smelter has settled and the store has no entry of is
/// `not-yet`, however it was settled. Every outcome of deriving a text is
/// stored, a decline too, so the entry was lost, and the Smelter derives it
/// again when it next starts.
pub async fn anchored_text(archivist: &Archivist, resource_id: &str) -> Result<Object, Refusal> {
    let view = archivist.held_view(resource_id)?;
    let representation = view.as_ref().and_then(primary_representation);
    let checksum = representation
        .and_then(|r| r.get("checksum"))
        .and_then(Value::as_str);
    let Some(checksum) = checksum else {
        return Ok(absent("unknown"));
    };
    let text_source = representation
        .and_then(|r| r.get("mediaType"))
        .and_then(Value::as_str)
        .and_then(capabilities_of)
        .map(|row| row.text_source);
    match text_source {
        Some(TextSource::PdfTextLayer) => {}
        Some(TextSource::Decode | TextSource::None) | None => {
            return Ok(absent("no-map"));
        }
    }
    let dir = Path::new(&archivist.config.anchored_text_dir);
    if let Some(entry) = read_entry(dir, checksum).await {
        return Ok(entry);
    }
    if archivist.smelt.when_settled(resource_id, checksum).await
        && let Some(entry) = read_entry(dir, checksum).await
    {
        return Ok(entry);
    }
    Ok(absent("not-yet"))
}
