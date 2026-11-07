//! The runner of protocol/specs/src/session/cache-cases.json: what a client
//! keeps of its queries and of its stream in a `SessionStorage`, held to
//! protocol/specs/src/session/stored.json's `keptQueries`, `wholeKey`,
//! `cacheDocument` and `lastEventIds`. A load goes through the persister a
//! kept query's cache is built with, under the key the table gives it; a
//! write through a client, whose cache comes to hold the values by asking
//! for them, and which saves what it holds as it closes. A query the table
//! keeps that this SDK does not fails here.

use semiont::cache::{CachePersister, StoragePersister};
use semiont::client::{CachePersistence, ClientOptions};
use semiont::namespaces::WholeKey;
use semiont::refresh::CacheQuery;
use semiont::resume::CoupledBookmarks;
use semiont::storage::{InMemorySessionStorage, SessionStorage};
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

const STORED: &str = include_str!("../specs/session/stored.json");
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
/// by the key and value the client's cache of it holds.
fn kept_of(name: &str, storage: &Arc<InMemorySessionStorage>) -> BTreeMap<String, Value> {
    let key = cache_key(name);
    match query(name) {
        CacheQuery::Resource => loaded::<ResourceId, ResourceDescriptor>(storage, &key),
        CacheQuery::Annotations => loaded::<ResourceId, GetAnnotationsResponse>(storage, &key),
        CacheQuery::Annotation => loaded::<AnnotationId, Annotation>(storage, &key),
        CacheQuery::EntityTypes => loaded::<WholeKey, Vec<String>>(storage, &key),
        CacheQuery::TagSchemas => loaded::<WholeKey, Vec<TagSchema>>(storage, &key),
        other => panic!("{} is no query this SDK keeps", other.name()),
    }
}

/// A value of the table's, as the type the client holds it as.
fn decoded<T: DeserializeOwned>(of: &Value) -> T {
    serde_json::from_value(of.clone()).unwrap_or_else(|refused| panic!("{of}: {refused}"))
}

/// Make a client's cache of the query `name` hold `held`, as a cache comes
/// to hold anything: it asks, and the knowledge base answers. Then close the
/// client, which saves what its caches hold.
async fn hold(name: &str, held: &[Value], storage: &Arc<InMemorySessionStorage>) {
    let whole_key = text(&table(STORED)["wholeKey"], "key");
    let transport = FaultyTransport::new(vec![]);
    let content = InMemoryContent::new();
    let client = create_test_client(TestClientOptions {
        transport: Some(transport.clone()),
        content: Some(content.clone()),
        client: ClientOptions {
            cache_persistence: Some(CachePersistence {
                places: CoupledBookmarks::new(storage.clone(), &places_key()),
                kb_id: KB_ID.to_owned(),
                person_key: PERSON_KEY.to_owned(),
            }),
            ..ClientOptions::default()
        },
        ..TestClientOptions::default()
    })
    .client;
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
    client.close().await;
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
    let stored = table(STORED);
    let document = &stored["cacheDocument"]["properties"];
    let members: Vec<&String> = document
        .as_object()
        .expect("cacheDocument has properties")
        .keys()
        .collect();
    let cases = table(CASES);
    let cases = listed(&cases, "writes");
    assert!(!cases.is_empty(), "cache-cases.json has no write");
    for case in cases {
        let (name, query) = (text(case, "name"), text(case, "query"));
        let storage = Arc::new(InMemorySessionStorage::new());
        hold(&query, listed(case, "held"), &storage).await;

        let written: Value = serde_json::from_str(
            &storage
                .get(&cache_key(&query))
                .unwrap_or_else(|| panic!("{name}: nothing was written")),
        )
        .expect("the document is JSON");
        let mut written_members: Vec<&String> = written
            .as_object()
            .unwrap_or_else(|| panic!("{name}: the document is no object: {written}"))
            .keys()
            .collect();
        written_members.sort();
        assert_eq!(written_members, members, "{name}: the document's members");
        let expected = &case["written"];
        assert_eq!(written["version"], document["version"]["const"], "{name}");
        assert_eq!(written["version"], expected["version"], "{name}");

        let entries: BTreeMap<String, Value> = listed(&written, "entries")
            .iter()
            .map(|entry| match entry.as_array().map(Vec::as_slice) {
                Some([key, value, stamp]) => {
                    assert!(
                        stamp.as_u64().is_some(),
                        "{name}: a stamp is a whole number of at least 0: {stamp}"
                    );
                    (key.to_string(), value.clone())
                }
                _ => panic!("{name}: an entry is not a key, a value and a stamp: {entry}"),
            })
            .collect();
        assert_entries(&name, &entries, &pairs(&expected["entries"]));
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

/// A query `keptQueries` gains fails here until Rust keeps it, and until
/// the table writes it.
#[test]
fn every_kept_query_is_one_rust_keeps_and_one_the_table_writes() {
    let kept: BTreeSet<String> = listed(&table(STORED), "keptQueries")
        .iter()
        .map(|row| text(row, "query"))
        .collect();
    assert!(!kept.is_empty(), "stored.json keeps no query");
    let written: BTreeSet<String> = listed(&table(CASES), "writes")
        .iter()
        .map(|case| text(case, "query"))
        .collect();
    assert_eq!(written, kept, "the queries the table writes");
    let storage = Arc::new(InMemorySessionStorage::new());
    for name in &kept {
        assert!(kept_of(name, &storage).is_empty(), "{name}: nothing stored");
    }
}
