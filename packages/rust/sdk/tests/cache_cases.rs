//! The runner of protocol/specs/src/session/cache-cases.json: what a client
//! keeps of its queries and of its stream in a `SessionStorage`, held to the
//! queries protocol/specs/src/client/refresh.json marks `persisted`, and to
//! protocol/specs/src/session/stored.json's `wholeKey`, `cacheDocument` and
//! `lastEventIds`. A load goes through the persister a kept query's cache is
//! built with, under the key the table gives it, each entry's key read as
//! the query's `per` says; a write through a client, whose cache comes to
//! hold the values by asking for them, and which saves what it holds as it
//! closes; a refused write through such a client over a storage that
//! refuses the first write of the query's document. A query the table keeps
//! that this SDK does not fails here.

use semiont::cache::{CachePersister, StoragePersister};
use semiont::client::{CachePersistence, ClientOptions, SemiontClient};
use semiont::namespaces::WholeKey;
use semiont::refresh::CacheQuery;
use semiont::resume::CoupledBookmarks;
use semiont::storage::{
    InMemorySessionStorage, SessionStorage, StorageChange, StorageSubscription,
};
use semiont::testing::{FaultyTransport, InMemoryContent, TestClientOptions, create_test_client};
use semiont::timing::MAX_STORED_BYTES_COUNT;
use semiont::types::{
    Annotation, AnnotationId, GetAnnotationsResponse, ResourceDescriptor, ResourceId, TagSchema,
};
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};
use std::hash::Hash;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

const STORED: &str = include_str!("../specs/session/stored.json");
const REFRESH: &str = include_str!("../specs/client/refresh.json");
const CASES: &str = include_str!("../specs/session/cache-cases.json");

/// The knowledge base the runner's persistence keeps for, and the key of the
/// person it keeps for there.
const KB_ID: &str = "kb-cases";
const PERSON_KEY: &str = "a-person-key";

fn table(text: &str) -> Value {
    serde_json::from_str(text).expect("the table is JSON")
}

fn text(of: &Value, member: &str) -> String {
    of[member]
        .as_str()
        .unwrap_or_else(|| panic!("no string {member}: {of}"))
        .to_owned()
}

fn listed<'a>(of: &'a Value, member: &str) -> &'a Vec<Value> {
    of[member]
        .as_array()
        .unwrap_or_else(|| panic!("no list {member}: {of}"))
}

/// Where the runner's persistence keeps the query `name`: `cacheKeyPrefix`,
/// the knowledge base's id, a dot, the person's key, a dot and the name.
fn cache_key(name: &str) -> String {
    format!(
        "{}{KB_ID}.{PERSON_KEY}.{name}",
        text(&table(STORED)["cacheKeyPrefix"], "prefix")
    )
}

/// Where the runner's persistence keeps the stream's places:
/// `lastEventIdKeyPrefix`, the knowledge base's id, a dot and the person's
/// key.
fn places_key() -> String {
    format!(
        "{}{KB_ID}.{PERSON_KEY}",
        text(&table(STORED)["lastEventIdKeyPrefix"], "prefix")
    )
}

/// The query of protocol/specs/src/client/refresh.json named `name`.
fn query(name: &str) -> CacheQuery {
    *CacheQuery::ALL
        .iter()
        .find(|query| query.name() == name)
        .unwrap_or_else(|| panic!("{name} is no query of client/refresh.json"))
}

/// The queries client/refresh.json marks `persisted`, in its order, each
/// with what it is kept `per`: none for a query of the knowledge base as a
/// whole.
fn persisted() -> Vec<(String, Option<String>)> {
    listed(&table(REFRESH), "queries")
        .iter()
        .filter(|row| row["persisted"] == json!(true))
        .map(|row| (text(row, "name"), row["per"].as_str().map(str::to_owned)))
        .collect()
}

/// What the kept query `name` is kept per, as client/refresh.json says.
fn per(name: &str) -> Option<String> {
    persisted()
        .into_iter()
        .find(|(query, _)| query == name)
        .unwrap_or_else(|| panic!("{name} is no query client/refresh.json marks persisted"))
        .1
}

/// What a case keeps under its key: `storedText` as it is, or `stored` as
/// its JSON text.
fn stored_text(case: &Value) -> String {
    match (case.get("storedText"), case.get("stored")) {
        (Some(Value::String(text)), None) => text.clone(),
        (None, Some(stored)) => stored.to_string(),
        _ => panic!("a case states `stored` or `storedText`: {case}"),
    }
}

/// Whether two JSON values are one: a number is one equal to it in value,
/// as JSON has one kind of number.
fn same(one: &Value, other: &Value) -> bool {
    match (one, other) {
        (Value::Number(one), Value::Number(other)) => one.as_f64() == other.as_f64(),
        (Value::Array(one), Value::Array(other)) => {
            one.len() == other.len() && one.iter().zip(other).all(|(one, other)| same(one, other))
        }
        (Value::Object(one), Value::Object(other)) => {
            one.len() == other.len()
                && one
                    .iter()
                    .all(|(name, member)| other.get(name).is_some_and(|held| same(member, held)))
        }
        _ => one == other,
    }
}

/// A list of `[key, value]`, by each key's JSON text.
fn pairs(list: &Value) -> BTreeMap<String, Value> {
    list.as_array()
        .unwrap_or_else(|| panic!("no list of entries: {list}"))
        .iter()
        .map(|pair| match pair.as_array().map(Vec::as_slice) {
            Some([key, value]) => (key.to_string(), value.clone()),
            _ => panic!("an entry of the table is not a key and a value: {pair}"),
        })
        .collect()
}

/// The entries are the ones expected, compared as maps.
fn assert_entries(case: &str, got: &BTreeMap<String, Value>, expected: &BTreeMap<String, Value>) {
    assert_eq!(
        got.keys().collect::<Vec<_>>(),
        expected.keys().collect::<Vec<_>>(),
        "{case}: the keys"
    );
    for (key, value) in expected {
        assert!(
            same(&got[key], value),
            "{case}: {key} is {} and not {value}",
            got[key]
        );
    }
}

/// What a persister of a cache of `V` by `K` keeps of what is stored under
/// `key`, each key and value as JSON.
fn loaded<K, V>(storage: &Arc<InMemorySessionStorage>, key: &str) -> BTreeMap<String, Value>
where
    K: Serialize + DeserializeOwned + Eq + Hash + 'static,
    V: Serialize + DeserializeOwned + 'static,
{
    let persister: StoragePersister<K, V> =
        StoragePersister::new(storage.clone(), key, MAX_STORED_BYTES_COUNT);
    persister
        .load()
        .into_iter()
        .flatten()
        .map(|(key, value)| {
            (
                serde_json::to_value(key).expect("a key").to_string(),
                serde_json::to_value(value).expect("a value"),
            )
        })
        .collect()
}

/// What the cache of the query `name` keeps of what is stored under its key:
/// by the value the client's cache of it holds.
fn kept_of(name: &str, storage: &Arc<InMemorySessionStorage>) -> BTreeMap<String, Value> {
    match query(name) {
        CacheQuery::Resource => keyed::<ResourceDescriptor>(name, storage),
        CacheQuery::Annotations => keyed::<GetAnnotationsResponse>(name, storage),
        CacheQuery::Annotation => keyed::<Annotation>(name, storage),
        CacheQuery::EntityTypes => keyed::<Vec<String>>(name, storage),
        CacheQuery::TagSchemas => keyed::<Vec<TagSchema>>(name, storage),
        other => panic!("{} is no query this SDK keeps", other.name()),
    }
}

/// What a persister of the kept query `name`'s values of `V` keeps of what
/// is stored under its key, each entry's key read as client/refresh.json's
/// `per` says: a resource's id, an annotation's id, or `wholeKey` for a
/// query of the knowledge base as a whole.
fn keyed<V>(name: &str, storage: &Arc<InMemorySessionStorage>) -> BTreeMap<String, Value>
where
    V: Serialize + DeserializeOwned + 'static,
{
    let key = cache_key(name);
    match per(name).as_deref() {
        Some("resource") => loaded::<ResourceId, V>(storage, &key),
        Some("annotation") => loaded::<AnnotationId, V>(storage, &key),
        None => loaded::<WholeKey, V>(storage, &key),
        Some(other) => panic!("{name} is kept per {other}, which no kept query is"),
    }
}

/// A value of the table's, as the type the client holds it as.
fn decoded<T: DeserializeOwned>(of: &Value) -> T {
    serde_json::from_value(of.clone()).unwrap_or_else(|refused| panic!("{of}: {refused}"))
}

/// A client that keeps its caches in `storage` for `KB_ID` and
/// `PERSON_KEY`, with the stream's places coupled to it as a session's are,
/// and what it reads over.
struct Keeping {
    client: Arc<SemiontClient>,
    transport: FaultyTransport,
    content: InMemoryContent,
}

fn keeping(storage: Arc<dyn SessionStorage>) -> Keeping {
    let places = CoupledBookmarks::new(storage, &places_key());
    let transport = FaultyTransport::new(vec![]);
    let content = InMemoryContent::new();
    let client = create_test_client(TestClientOptions {
        transport: Some(transport.clone()),
        content: Some(content.clone()),
        client: ClientOptions {
            cache_persistence: Some(CachePersistence {
                storage: places.storage(),
                kb_id: KB_ID.to_owned(),
                person_key: PERSON_KEY.to_owned(),
            }),
            ..ClientOptions::default()
        },
        ..TestClientOptions::default()
    })
    .client;
    places.couple_to(&client);
    Keeping {
        client,
        transport,
        content,
    }
}

impl Keeping {
    /// Make the client's cache of the query `name` hold `held`, as a cache
    /// comes to hold anything: it asks, and the knowledge base answers.
    async fn hold(&self, name: &str, held: &[Value]) {
        let whole_key = text(&table(STORED)["wholeKey"], "key");
        let Keeping {
            client,
            transport,
            content,
        } = self;
        for pair in held {
            let Some([key, value]) = pair.as_array().map(Vec::as_slice) else {
                panic!("a held entry is not a key and a value: {pair}");
            };
            let per_nothing = || {
                assert_eq!(
                    key.as_str(),
                    Some(whole_key.as_str()),
                    "{name} is per nothing"
                );
            };
            match query(name) {
                CacheQuery::Resource => {
                    transport.queue_reply(
                        "browse:resource-requested",
                        [Some(json!({ "resource": value, "lastSequence": 1 }))],
                    );
                    client
                        .browse
                        .resource(&decoded(key))
                        .fresh()
                        .await
                        .expect("answered");
                }
                CacheQuery::Annotations => {
                    let resource: ResourceId = decoded(key);
                    content.seed_annotations(&resource, decoded(value));
                    client
                        .browse
                        .annotations(&resource)
                        .fresh()
                        .await
                        .expect("answered");
                }
                CacheQuery::Annotation => {
                    let resource: ResourceId = match &value["target"] {
                        Value::String(_) => decoded(&value["target"]),
                        target => decoded(&target["source"]),
                    };
                    transport.queue_reply(
                        "browse:annotation-requested",
                        [Some(json!({
                            "annotation": value,
                            "resource": null,
                            "resolvedResource": null,
                        }))],
                    );
                    client
                        .browse
                        .annotation(&resource, &decoded(key))
                        .fresh()
                        .await
                        .expect("answered");
                }
                CacheQuery::EntityTypes => {
                    per_nothing();
                    transport.queue_reply(
                        "browse:entity-types-requested",
                        [Some(json!({ "entityTypes": value }))],
                    );
                    client
                        .browse
                        .entity_types()
                        .fresh()
                        .await
                        .expect("answered");
                }
                CacheQuery::TagSchemas => {
                    per_nothing();
                    transport.queue_reply(
                        "browse:tag-schemas-requested",
                        [Some(json!({ "tagSchemas": value }))],
                    );
                    client.browse.tag_schemas().fresh().await.expect("answered");
                }
                other => panic!("{} is no query this SDK keeps", other.name()),
            }
        }
    }
}

/// What was written under a query's key is the document `expected` states:
/// the members `cacheDocument` names, its version, and its entries,
/// compared as a map, each stamp a whole number of at least 0.
fn assert_written(case: &str, written: Option<String>, expected: &Value) {
    let stored = table(STORED);
    let document = &stored["cacheDocument"]["properties"];
    let members: Vec<&String> = document
        .as_object()
        .expect("cacheDocument has properties")
        .keys()
        .collect();
    let written: Value =
        serde_json::from_str(&written.unwrap_or_else(|| panic!("{case}: nothing was written")))
            .expect("the document is JSON");
    let mut written_members: Vec<&String> = written
        .as_object()
        .unwrap_or_else(|| panic!("{case}: the document is no object: {written}"))
        .keys()
        .collect();
    written_members.sort();
    assert_eq!(written_members, members, "{case}: the document's members");
    assert_eq!(written["version"], document["version"]["const"], "{case}");
    assert_eq!(written["version"], expected["version"], "{case}");

    let entries: BTreeMap<String, Value> = listed(&written, "entries")
        .iter()
        .map(|entry| match entry.as_array().map(Vec::as_slice) {
            Some([key, value, stamp]) => {
                assert!(
                    stamp.as_u64().is_some(),
                    "{case}: a stamp is a whole number of at least 0: {stamp}"
                );
                (key.to_string(), value.clone())
            }
            _ => panic!("{case}: an entry is not a key, a value and a stamp: {entry}"),
        })
        .collect();
    assert_entries(case, &entries, &pairs(&expected["entries"]));
}

#[test]
fn each_load_keeps_what_the_table_says() {
    let cases = table(CASES);
    let cases = listed(&cases, "cases");
    assert!(!cases.is_empty(), "cache-cases.json has no load");
    for case in cases {
        let (name, query) = (text(case, "name"), text(case, "query"));
        let storage = Arc::new(InMemorySessionStorage::new());
        storage
            .set(&cache_key(&query), &stored_text(case))
            .expect("stored");
        assert_entries(&name, &kept_of(&query, &storage), &pairs(&case["kept"]));
    }
}

#[tokio::test(start_paused = true)]
async fn each_write_is_the_document_the_table_says() {
    let cases = table(CASES);
    let cases = listed(&cases, "writes");
    assert!(!cases.is_empty(), "cache-cases.json has no write");
    for case in cases {
        let (name, query) = (text(case, "name"), text(case, "query"));
        let storage = Arc::new(InMemorySessionStorage::new());
        let keeping = keeping(storage.clone());
        keeping.hold(&query, listed(case, "held")).await;
        keeping.client.close().await;
        assert_written(&name, storage.get(&cache_key(&query)), &case["written"]);
    }
}

/// A storage that refuses the first write under `refused`, and takes every
/// other.
struct RefusingFirst {
    beneath: InMemorySessionStorage,
    refused: String,
    refusing: AtomicBool,
}

impl RefusingFirst {
    fn new(refused: String) -> RefusingFirst {
        RefusingFirst {
            beneath: InMemorySessionStorage::new(),
            refused,
            refusing: AtomicBool::new(true),
        }
    }

    /// Whether a write under `key` is the one refused.
    fn refuses(&self, key: &str) -> bool {
        key == self.refused && self.refusing.swap(false, Ordering::SeqCst)
    }

    /// Whether the write it refuses has been asked of it.
    fn has_refused(&self) -> bool {
        !self.refusing.load(Ordering::SeqCst)
    }
}

impl SessionStorage for RefusingFirst {
    fn get(&self, key: &str) -> Option<String> {
        self.beneath.get(key)
    }

    fn set(&self, key: &str, value: &str) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        if self.refuses(key) {
            return Err(format!("{key}: the storage refuses this write").into());
        }
        self.beneath.set(key, value)
    }

    fn delete(&self, key: &str) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        self.beneath.delete(key)
    }

    fn update(
        &self,
        key: &str,
        change: &mut dyn FnMut(Option<&str>) -> Option<String>,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        if self.refuses(key) {
            return Err(format!("{key}: the storage refuses this write").into());
        }
        self.beneath.update(key, change)
    }

    fn subscribe(&self, on_change: StorageChange) -> Option<StorageSubscription> {
        self.beneath.subscribe(on_change)
    }
}

/// A write the storage refuses leaves the cache's save owed, so the client
/// is not at rest and nothing is written meanwhile; disposal's flush, which
/// the storage takes, writes the document the table says
/// (protocol/contract/CACHE-SEMANTICS.md B17).
#[tokio::test(start_paused = true)]
async fn each_refused_write_stays_owed_and_disposal_writes_the_document_the_table_says() {
    let cases = table(CASES);
    let cases = listed(&cases, "refusedWrites");
    assert!(!cases.is_empty(), "cache-cases.json has no refused write");
    for case in cases {
        let (name, query) = (text(case, "name"), text(case, "query"));
        let storage = Arc::new(RefusingFirst::new(cache_key(&query)));
        let keeping = keeping(storage.clone());
        keeping.hold(&query, listed(case, "held")).await;
        tokio::time::timeout(Duration::from_secs(3600), async {
            while !storage.has_refused() {
                tokio::time::sleep(Duration::from_millis(1)).await;
            }
        })
        .await
        .unwrap_or_else(|_| panic!("{name}: the cache never wrote its document"));
        assert!(
            !keeping.client.persistence_settled(),
            "{name}: the save is still owed after the storage refused its write"
        );
        assert_eq!(
            storage.get(&cache_key(&query)),
            None,
            "{name}: nothing is written before disposal"
        );

        keeping.client.close().await;
        assert_written(&name, storage.get(&cache_key(&query)), &case["written"]);
    }
}

#[test]
fn each_load_of_the_places_keeps_what_the_table_says() {
    let key = places_key();
    let cases = table(CASES);
    let cases = listed(&cases, "places");
    assert!(!cases.is_empty(), "cache-cases.json has no places");
    for case in cases {
        let name = text(case, "name");
        let storage = Arc::new(InMemorySessionStorage::new());
        storage.set(&key, &stored_text(case)).expect("stored");
        let kept: BTreeMap<String, Value> = CoupledBookmarks::new(storage, &key)
            .load()
            .into_iter()
            .map(|(scope, id)| (scope.as_str().to_owned(), Value::String(id)))
            .collect();
        let expected: BTreeMap<String, Value> = case["kept"]
            .as_object()
            .unwrap_or_else(|| panic!("{name}: kept is no object"))
            .iter()
            .map(|(scope, id)| (scope.clone(), id.clone()))
            .collect();
        assert_eq!(kept, expected, "{name}");
    }
}

/// The queries client/refresh.json marks persisted, read here, are the ones
/// Rust keeps (`CacheQuery::PERSISTED`), each one `kept_of` reads, and the
/// ones the table writes: a query the refresh table comes to persist fails
/// here until Rust keeps it, and until the table writes it.
#[test]
fn every_kept_query_is_one_rust_keeps_and_one_the_table_writes() {
    let kept: Vec<String> = persisted().into_iter().map(|(name, _)| name).collect();
    assert!(!kept.is_empty(), "client/refresh.json persists no query");
    let rust: Vec<&str> = CacheQuery::PERSISTED
        .iter()
        .map(|query| query.name())
        .collect();
    assert_eq!(rust, kept, "the queries Rust keeps");

    let kept: BTreeSet<String> = kept.into_iter().collect();
    let written: BTreeSet<String> = listed(&table(CASES), "writes")
        .iter()
        .map(|case| text(case, "query"))
        .collect();
    assert_eq!(written, kept, "the queries the table writes");
    for case in listed(&table(CASES), "refusedWrites") {
        let query = text(case, "query");
        assert!(
            kept.contains(&query),
            "a refused write of {query}, which is not kept"
        );
    }
    let storage = Arc::new(InMemorySessionStorage::new());
    for name in &kept {
        assert!(kept_of(name, &storage).is_empty(), "{name}: nothing stored");
    }
}
