//! The knowledge bases a launcher manages: what its document says, and what
//! changed between two readings of it.

use semiont::discovery::{
    DISCOVERY_INTERVAL, DiscoveryAbsentReason, DiscoveryDiff, DiscoveryRead, DiscoveryState,
    DiscoveryTransport, parse_discovery_document, subscribe_discovery, text_discovery,
};
use semiont::transport::BoxFuture;
use semiont::types::DiscoveredKB;
use serde_json::{Value, json};
use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
use std::time::Duration;

fn entry(host: &str, port: u16, did: &str) -> Value {
    json!({
        "host": host, "port": port, "placement": "local",
        "managedBy": "semiont-launcher", "did": did,
    })
}

fn document(kbs: &[Value]) -> String {
    json!({ "version": 1, "kbs": kbs }).to_string()
}

fn kb(value: Value) -> DiscoveredKB {
    serde_json::from_value(value).expect("a discovered knowledge base")
}

fn reason(state: &DiscoveryState) -> Option<DiscoveryAbsentReason> {
    match state {
        DiscoveryState::Absent { reason, .. } => Some(*reason),
        DiscoveryState::Managed { .. } => None,
    }
}

fn diagnostic(state: &DiscoveryState) -> String {
    match state {
        DiscoveryState::Absent { diagnostic, .. } => diagnostic.clone().unwrap_or_default(),
        DiscoveryState::Managed { .. } => String::new(),
    }
}

const A: &str = "did:web:example.org:kb-a";
const B: &str = "did:web:example.org:kb-b";

// ── What the document says ──────────────────────────────────────────────

#[test]
fn a_document_of_knowledge_bases_is_managed_and_one_of_none_is_managed_too() {
    let codespace = json!({
        "host": "localhost", "port": 4100, "placement": "codespace", "managedBy": "semiont-launcher",
        "did": B, "repo": "owner/name", "siteName": "A site",
    });
    assert_eq!(
        parse_discovery_document(&document(&[entry("localhost", 4000, A), codespace.clone()])),
        DiscoveryState::Managed {
            kbs: vec![kb(entry("localhost", 4000, A)), kb(codespace)]
        }
    );
    // A launcher that manages nothing is there. It is not absent.
    assert_eq!(
        parse_discovery_document(&document(&[])),
        DiscoveryState::Managed { kbs: vec![] }
    );
}

#[test]
fn what_is_not_a_document_is_absent_and_says_why() {
    use DiscoveryAbsentReason::{Invalid, NotJson, UnsupportedVersion};
    let cases = [
        ("<!doctype html><html></html>".to_owned(), NotJson),
        ("[]".to_owned(), Invalid),
        (json!({ "kbs": [] }).to_string(), Invalid),
        (json!({ "version": "1", "kbs": [] }).to_string(), Invalid),
        (
            json!({ "version": 2, "kbs": [] }).to_string(),
            UnsupportedVersion,
        ),
        (json!({ "version": 1 }).to_string(), Invalid),
        (
            json!({ "version": 1, "kbs": ["localhost"] }).to_string(),
            Invalid,
        ),
        (
            document(&[
                json!({ "host": "localhost", "port": 4000, "placement": "elsewhere", "managedBy": "x", "did": A }),
            ]),
            Invalid,
        ),
        (document(&[entry("localhost", 0, A)]), Invalid),
        (
            document(&[
                json!({ "host": "localhost", "port": 70000, "placement": "local", "managedBy": "x", "did": A }),
            ]),
            Invalid,
        ),
    ];
    for (text, expected) in cases {
        let state = parse_discovery_document(&text);
        assert_eq!(reason(&state), Some(expected), "{text}");
        assert!(!diagnostic(&state).is_empty(), "{text}");
    }
}

#[test]
fn a_document_of_another_version_is_not_read_in_part() {
    let state = parse_discovery_document(
        &json!({ "version": 2, "kbs": [entry("localhost", 4000, A)] }).to_string(),
    );
    assert_eq!(
        reason(&state),
        Some(DiscoveryAbsentReason::UnsupportedVersion)
    );
    assert!(diagnostic(&state).contains("version 2"), "{state:?}");
}

#[test]
fn one_entry_that_is_not_one_makes_the_whole_document_absent() {
    // A reading of the good entry alone would hide a running knowledge base.
    let without_a_did =
        json!({ "host": "localhost", "port": 4100, "placement": "local", "managedBy": "x" });
    let state = parse_discovery_document(&document(&[entry("localhost", 4000, A), without_a_did]));
    assert_eq!(reason(&state), Some(DiscoveryAbsentReason::Invalid));
    assert!(diagnostic(&state).contains("did"), "{state:?}");
}

// ── Reading it as text ──────────────────────────────────────────────────

async fn read_of(text: Result<Option<String>, String>) -> DiscoveryRead {
    text_discovery(move || {
        let text = text.clone();
        async move { text }
    })
    .read()
    .await
}

#[tokio::test]
async fn text_is_read_through_the_one_validator() {
    assert_eq!(
        read_of(Ok(Some(document(&[entry("localhost", 4000, A)])))).await,
        DiscoveryRead::State(DiscoveryState::Managed {
            kbs: vec![kb(entry("localhost", 4000, A))]
        })
    );
    assert_eq!(
        read_of(Ok(None)).await,
        DiscoveryRead::State(DiscoveryState::Absent {
            reason: DiscoveryAbsentReason::NotFound,
            diagnostic: None,
        })
    );
    assert_eq!(
        read_of(Err("permission denied".to_owned())).await,
        DiscoveryRead::State(DiscoveryState::Absent {
            reason: DiscoveryAbsentReason::Unreadable,
            diagnostic: Some("permission denied".to_owned()),
        })
    );
}

// ── What changed ────────────────────────────────────────────────────────

/// A transport that gives what it was scripted to, in order, and then says
/// nothing has changed.
#[derive(Default)]
struct Script {
    reads: Mutex<VecDeque<DiscoveryRead>>,
    asked: Mutex<usize>,
}

impl Script {
    fn of(texts: &[Option<String>]) -> Arc<Script> {
        let script = Script::default();
        script
            .reads
            .lock()
            .expect("reads")
            .extend(texts.iter().map(|text| match text {
                Some(text) => DiscoveryRead::State(parse_discovery_document(text)),
                None => DiscoveryRead::Unchanged,
            }));
        Arc::new(script)
    }

    fn asked(&self) -> usize {
        *self.asked.lock().expect("asked")
    }
}

impl DiscoveryTransport for Script {
    fn read(&self) -> BoxFuture<'_, DiscoveryRead> {
        *self.asked.lock().expect("asked") += 1;
        let next = self
            .reads
            .lock()
            .expect("reads")
            .pop_front()
            .unwrap_or(DiscoveryRead::Unchanged);
        Box::pin(async move { next })
    }
}

/// Every change told of in `polls` readings.
async fn changes(script: &Arc<Script>, polls: u32) -> Vec<DiscoveryDiff> {
    let mut diffs = subscribe_discovery(script.clone(), DISCOVERY_INTERVAL);
    tokio::time::sleep(DISCOVERY_INTERVAL * polls - Duration::from_millis(1)).await;
    let mut told = Vec::new();
    while let Ok(Some(diff)) = tokio::time::timeout(Duration::from_millis(1), diffs.next()).await {
        told.push(diff);
    }
    told
}

fn addresses(kbs: &[DiscoveredKB]) -> Vec<String> {
    kbs.iter()
        .map(|kb| format!("{}:{}", kb.host, kb.port))
        .collect()
}

/// A diff as what it added, changed and removed, by address.
fn summary(diff: &DiscoveryDiff) -> (Vec<String>, Vec<String>, Vec<String>) {
    (
        addresses(&diff.added),
        addresses(&diff.updated),
        addresses(&diff.removed),
    )
}

fn at(addresses: &[&str]) -> Vec<String> {
    addresses.iter().map(|a| (*a).to_owned()).collect()
}

#[tokio::test(start_paused = true)]
async fn the_first_reading_is_told_whole_and_each_one_after_by_what_changed() {
    let renamed = json!({
        "host": "localhost", "port": 4000, "placement": "local",
        "managedBy": "semiont-launcher", "did": A, "siteName": "Renamed",
    });
    let script = Script::of(&[
        Some(document(&[entry("localhost", 4000, A)])),
        Some(document(&[renamed, entry("localhost", 4100, B)])),
        Some(document(&[entry("localhost", 4100, B)])),
    ]);
    let told = changes(&script, 4).await;

    assert_eq!(
        told.iter().map(summary).collect::<Vec<_>>(),
        [
            (at(&["localhost:4000"]), at(&[]), at(&[])),
            (at(&["localhost:4100"]), at(&["localhost:4000"]), at(&[])),
            (at(&[]), at(&[]), at(&["localhost:4000"])),
        ]
    );
    assert_eq!(told[1].updated[0].site_name.as_deref(), Some("Renamed"));
    assert_eq!(script.asked(), 4);
}

#[tokio::test(start_paused = true)]
async fn a_knowledge_base_that_moves_port_is_removed_and_added() {
    let script = Script::of(&[
        Some(document(&[entry("localhost", 4000, A)])),
        Some(document(&[entry("localhost", 4001, A)])),
    ]);
    let told = changes(&script, 2).await;

    assert_eq!(
        summary(&told[1]),
        (at(&["localhost:4001"]), at(&[]), at(&["localhost:4000"]))
    );
}

#[tokio::test(start_paused = true)]
async fn a_reading_that_changed_nothing_is_not_told() {
    let same = document(&[entry("localhost", 4000, A)]);
    let script = Script::of(&[Some(same.clone()), None, Some(same.clone()), Some(same)]);
    let told = changes(&script, 5).await;

    assert_eq!(told.len(), 1);
    assert_eq!(script.asked(), 5);
}

#[tokio::test(start_paused = true)]
async fn a_launcher_that_goes_and_comes_back_is_told_with_what_it_took_and_brought() {
    let managing = document(&[entry("localhost", 4000, A)]);
    let script = Script::of(&[
        Some("not json".to_owned()),
        Some(managing.clone()),
        Some("not json".to_owned()),
        // Absent for another reason is a change too; for the same one it is not.
        Some("[]".to_owned()),
        Some("{}".to_owned()),
    ]);
    let told = changes(&script, 6).await;

    assert_eq!(
        told.iter()
            .map(|diff| (reason(&diff.state), summary(diff)))
            .collect::<Vec<_>>(),
        [
            (
                Some(DiscoveryAbsentReason::NotJson),
                (at(&[]), at(&[]), at(&[]))
            ),
            (None, (at(&["localhost:4000"]), at(&[]), at(&[]))),
            (
                Some(DiscoveryAbsentReason::NotJson),
                (at(&[]), at(&[]), at(&["localhost:4000"]))
            ),
            (
                Some(DiscoveryAbsentReason::Invalid),
                (at(&[]), at(&[]), at(&[]))
            ),
        ]
    );
}

#[tokio::test(start_paused = true)]
async fn one_knowledge_base_in_two_places_is_two_entries_and_each_is_its_own() {
    let both = document(&[entry("localhost", 4000, A), entry("localhost", 4100, A)]);
    let script = Script::of(&[
        Some(both.clone()),
        Some(both),
        Some(document(&[entry("localhost", 4100, A)])),
    ]);
    let told = changes(&script, 4).await;

    // No change while both are there, and the one that stops is not hidden
    // by the one that goes on.
    assert_eq!(
        told.iter().map(summary).collect::<Vec<_>>(),
        [
            (at(&["localhost:4000", "localhost:4100"]), at(&[]), at(&[])),
            (at(&[]), at(&[]), at(&["localhost:4000"])),
        ]
    );
    assert!(told.iter().all(|diff| diff.duplicated.is_empty()));
}

#[tokio::test(start_paused = true)]
async fn two_entries_at_one_address_are_named_and_neither_is_dropped_from_the_state() {
    let script = Script::of(&[Some(document(&[
        entry("localhost", 4000, A),
        entry("localhost", 4000, B),
        entry("localhost", 4100, B),
    ]))]);
    let told = changes(&script, 1).await;

    assert_eq!(told[0].duplicated, at(&["localhost:4000"]));
    match &told[0].state {
        DiscoveryState::Managed { kbs } => assert_eq!(kbs.len(), 3),
        other => panic!("a managed state was expected, not {other:?}"),
    }
}

#[tokio::test(start_paused = true)]
async fn reading_stops_when_nobody_listens() {
    let script = Script::of(&[Some(document(&[]))]);
    let diffs = subscribe_discovery(script.clone(), DISCOVERY_INTERVAL);
    tokio::time::sleep(DISCOVERY_INTERVAL * 2).await;
    let asked = script.asked();
    assert!(asked >= 2);

    drop(diffs);
    tokio::time::sleep(DISCOVERY_INTERVAL * 5).await;
    assert_eq!(script.asked(), asked);
}
