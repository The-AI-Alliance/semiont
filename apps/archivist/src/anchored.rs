//! Anchored text: the store the Smelter writes, read under the stamp its
//! writer states, and the wait for the Smelter to settle content not yet in
//! it.

use crate::archivist::{Archivist, Refusal, locked, primary_representation};
use semiont_archivist_record::Object;
use semiont_archivist_record::shard::shard_path;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::path::Path;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tokio::sync::oneshot;

/// How long a read waits for the Smelter to settle content the store lacks.
const SETTLE: Duration = Duration::from_secs(15);
/// How long the last settlement of a resource is remembered.
const REMEMBERED: Duration = Duration::from_secs(5 * 60);

struct Settled {
    checksum: String,
    outcome: String,
    at: Instant,
}

struct Waiter {
    resource_id: String,
    checksum: String,
    tell: oneshot::Sender<String>,
}

/// The latest `smelt:settled` of each resource, and who is waiting for one.
#[derive(Default)]
pub struct SmeltProgress {
    settled: Mutex<HashMap<String, Settled>>,
    waiting: Mutex<Vec<Waiter>>,
}

impl SmeltProgress {
    /// The Smelter settled this content of this resource.
    pub fn settle(&self, resource_id: &str, checksum: &str, outcome: &str) {
        {
            let mut settled = locked(&self.settled);
            settled.retain(|_, held| held.at.elapsed() < REMEMBERED);
            settled.insert(
                resource_id.to_owned(),
                Settled {
                    checksum: checksum.to_owned(),
                    outcome: outcome.to_owned(),
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
            let _ = waiter.tell.send(outcome.to_owned());
        }
    }

    /// How the Smelter settled this content, waiting for it to if it has
    /// not. None when the wait runs out.
    async fn when_settled(&self, resource_id: &str, checksum: &str) -> Option<String> {
        let wait = {
            let settled = locked(&self.settled);
            if let Some(held) = settled.get(resource_id).filter(|h| h.checksum == checksum) {
                return Some(held.outcome.clone());
            }
            let (tell, wait) = oneshot::channel();
            locked(&self.waiting).push(Waiter {
                resource_id: resource_id.to_owned(),
                checksum: checksum.to_owned(),
                tell,
            });
            wait
        };
        tokio::time::timeout(SETTLE, wait).await.ok()?.ok()
    }
}

fn valid_key(key: &str) -> bool {
    !key.is_empty()
        && key
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// The store's entry for content of this checksum, as an answer: a hit only
/// under the stamp the writer states. Every miss is none.
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
    if entry.get("v") != Some(&json!(2))
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
/// there is none to give.
pub async fn anchored_text(archivist: &Archivist, resource_id: &str) -> Result<Object, Refusal> {
    let view = archivist.held_view(resource_id)?;
    let checksum = view
        .as_ref()
        .and_then(primary_representation)
        .and_then(|r| r.get("checksum"))
        .and_then(Value::as_str);
    let Some(checksum) = checksum else {
        return Ok(absent("unknown"));
    };
    let dir = Path::new(&archivist.config.anchored_text_dir);
    if let Some(entry) = read_entry(dir, checksum).await {
        return Ok(entry);
    }
    Ok(
        match archivist
            .smelt
            .when_settled(resource_id, checksum)
            .await
            .as_deref()
        {
            Some("skipped") => absent("no-map"),
            Some("indexed") => read_entry(dir, checksum)
                .await
                .unwrap_or_else(|| absent("not-yet")),
            _ => absent("not-yet"),
        },
    )
}
