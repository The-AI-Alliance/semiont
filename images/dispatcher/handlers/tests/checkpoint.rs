//! A checkpoint merged into a job's record (docs/protocol/JOBS.md
//! § Checkpoints): finished units by union, and one cursor for each unit,
//! finished or not, replaced whole and only by one that got further.

use semiont::types::{JobMetadata, UnitCursor};
use semiont_dispatcher_handlers::checkpoint::{checkpointed, failed_with};
use serde_json::{Value, json};
use std::collections::BTreeMap;

/// A cursor at `next` whose other members say which cursor it is.
fn cursor(next: u64, mark: u64) -> Value {
    json!({ "next": next, "size": mark, "found": mark + 1, "emitted": mark + 2, "errors": mark + 3 })
}

fn cursors(stated: Value) -> BTreeMap<String, UnitCursor> {
    serde_json::from_value(stated).expect("cursors")
}

fn units(named: &[&str]) -> Vec<String> {
    named.iter().map(|unit| (*unit).to_owned()).collect()
}

/// A record's metadata, holding `checkpoint`: its `completedUnits` and
/// `unitCursors`, those it has.
fn record(checkpoint: Value) -> JobMetadata {
    let mut metadata = json!({
        "id": "job-1",
        "type": "mark",
        "userId": "did:web:example.org:users:alice",
        "created": "2026-10-07T00:00:00.000Z",
        "retryCount": 0,
        "maxRetries": 1,
    });
    for (key, value) in checkpoint.as_object().expect("an object") {
        metadata[key] = value.clone();
    }
    serde_json::from_value(metadata).expect("metadata")
}

/// The checkpoint a record holds, as its claim states it: a member the record
/// does not have is absent.
fn held(metadata: &JobMetadata) -> Value {
    let whole = serde_json::to_value(metadata).expect("metadata");
    let mut checkpoint = json!({});
    for key in ["completedUnits", "unitCursors"] {
        if let Some(value) = whole.get(key) {
            checkpoint[key] = value.clone();
        }
    }
    checkpoint
}

/// What the record holds after a `job:checkpoint` and after a `job:fail` that
/// state the same checkpoint. The two merge alike wherever a unit is named.
fn merged(before: Value, named: &[&str], stated: Option<Value>) -> [Value; 2] {
    let record = record(before);
    let stated = stated.map(cursors);
    [
        held(&checkpointed(&record, &units(named), stated.as_ref())),
        held(&failed_with(&record, &units(named), stated.as_ref())),
    ]
}

#[test]
fn a_unit_named_finished_keeps_the_cursor_the_record_holds_for_it() {
    for after in merged(
        json!({ "unitCursors": { "Person": cursor(9, 1), "Place": cursor(4, 2) } }),
        &["Person"],
        None,
    ) {
        assert_eq!(
            after,
            json!({
                "completedUnits": ["Person"],
                "unitCursors": { "Person": cursor(9, 1), "Place": cursor(4, 2) },
            })
        );
    }
}

#[test]
fn a_checkpoint_that_names_a_unit_finished_and_states_its_cursor_records_both() {
    for after in merged(
        json!({ "unitCursors": { "Person": cursor(4, 1) } }),
        &["Person"],
        Some(json!({ "Person": cursor(9, 2) })),
    ) {
        assert_eq!(
            after,
            json!({ "completedUnits": ["Person"], "unitCursors": { "Person": cursor(9, 2) } })
        );
    }
}

#[test]
fn a_finished_units_cursor_is_kept_across_a_later_checkpoint_that_says_nothing_of_it() {
    for after in merged(
        json!({ "completedUnits": ["Person"], "unitCursors": { "Person": cursor(9, 1) } }),
        &[],
        Some(json!({ "Place": cursor(3, 2) })),
    ) {
        assert_eq!(
            after,
            json!({
                "completedUnits": ["Person"],
                "unitCursors": { "Person": cursor(9, 1), "Place": cursor(3, 2) },
            })
        );
    }
}

#[test]
fn a_cursor_sent_for_a_finished_unit_is_merged_as_any_other() {
    let finished =
        json!({ "completedUnits": ["Person"], "unitCursors": { "Person": cursor(5, 1) } });
    // Further: it replaces the held one, whole.
    for after in merged(
        finished.clone(),
        &[],
        Some(json!({ "Person": cursor(6, 2) })),
    ) {
        assert_eq!(after["unitCursors"], json!({ "Person": cursor(6, 2) }));
    }
    // No further, and behind: the held one stays, whole.
    for next in [5, 4] {
        for after in merged(
            finished.clone(),
            &[],
            Some(json!({ "Person": cursor(next, 2) })),
        ) {
            assert_eq!(after["unitCursors"], json!({ "Person": cursor(5, 1) }));
        }
    }
    // The record held none for it: the one sent is recorded.
    for after in merged(
        json!({ "completedUnits": ["Person"] }),
        &[],
        Some(json!({ "Person": cursor(2, 2) })),
    ) {
        assert_eq!(
            after,
            json!({ "completedUnits": ["Person"], "unitCursors": { "Person": cursor(2, 2) } })
        );
    }
}

#[test]
fn a_cursor_never_finishes_a_unit() {
    for after in merged(json!({}), &[], Some(json!({ "Person": cursor(9, 1) }))) {
        assert_eq!(after["unitCursors"], json!({ "Person": cursor(9, 1) }));
        assert!(
            after
                .get("completedUnits")
                .is_none_or(|units| units == &json!([])),
            "{after}"
        );
    }
}

#[test]
fn a_record_no_checkpoint_stated_a_cursor_for_has_no_cursors() {
    for after in merged(json!({}), &["Person"], None) {
        assert_eq!(after, json!({ "completedUnits": ["Person"] }));
    }
    for after in merged(
        json!({ "completedUnits": ["Person"] }),
        &["Place"],
        Some(json!({})),
    ) {
        assert_eq!(after, json!({ "completedUnits": ["Person", "Place"] }));
    }
}

const UNITS: [&str; 2] = ["Person", "Place"];

/// Every subset of the two units.
fn subsets() -> Vec<Vec<&'static str>> {
    vec![vec![], vec![UNITS[0]], vec![UNITS[1]], UNITS.to_vec()]
}

/// Every way of stating no cursor, or one at each of `nexts`, for each of
/// the two units.
fn every_cursors(nexts: &[u64], mark: u64) -> Vec<Value> {
    let mut choices = vec![None];
    choices.extend(nexts.iter().map(|next| Some(cursor(*next, mark))));
    let mut stated = Vec::new();
    for person in &choices {
        for place in &choices {
            let mut map = serde_json::Map::new();
            for (unit, choice) in UNITS.iter().zip([person, place]) {
                if let Some(cursor) = choice {
                    map.insert((*unit).to_owned(), cursor.clone());
                }
            }
            stated.push(Value::Object(map));
        }
    }
    stated
}

/// The rule, over every record and checkpoint of two units: each unit's
/// cursor is the one sent when that got further than the one held, and the
/// one held otherwise, whichever units either names as finished.
#[test]
fn every_units_cursor_is_the_furthest_stated_whatever_is_named_finished() {
    let mut checked = 0;
    for held_units in subsets() {
        for held_cursors in every_cursors(&[1, 2], 100) {
            for sent_units in subsets() {
                for sent_cursors in every_cursors(&[1, 2, 3], 200) {
                    let mut furthest = serde_json::Map::new();
                    for unit in UNITS {
                        let cursor = match (held_cursors.get(unit), sent_cursors.get(unit)) {
                            (Some(held), Some(sent)) => {
                                let further = sent["next"].as_u64() > held["next"].as_u64();
                                Some(if further { sent } else { held })
                            }
                            (held, sent) => held.or(sent),
                        };
                        if let Some(cursor) = cursor {
                            furthest.insert(unit.to_owned(), cursor.clone());
                        }
                    }
                    let expected = (!furthest.is_empty()).then_some(Value::Object(furthest));
                    let before =
                        json!({ "completedUnits": held_units, "unitCursors": held_cursors });
                    for after in merged(before.clone(), &sent_units, Some(sent_cursors.clone())) {
                        assert_eq!(
                            after.get("unitCursors"),
                            expected.as_ref(),
                            "the record {before}, sent {sent_units:?} and {sent_cursors}"
                        );
                        checked += 1;
                    }
                }
            }
        }
    }
    assert_eq!(checked, 4 * 9 * 4 * 16 * 2);
}
