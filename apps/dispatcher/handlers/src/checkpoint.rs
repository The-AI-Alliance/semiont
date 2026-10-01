//! A checkpoint merged into a job's record (JOBS.md § Checkpoints): finished
//! units by union, a cursor per unfinished unit replaced only by one that got
//! further, and no cursor for a unit that finished.

use semiont::types::{JobMetadata, UnitCursor};
use std::collections::BTreeMap;

/// The units recorded, then the incoming ones not already among them.
pub fn merged_units(existing: Option<&[String]>, incoming: &[String]) -> Vec<String> {
    let mut units: Vec<String> = existing.unwrap_or_default().to_vec();
    for unit in incoming {
        if !units.contains(unit) {
            units.push(unit.clone());
        }
    }
    units
}

/// Each unfinished unit's furthest cursor: a held one replaced only by one
/// whose `next` is further, whole.
pub fn merged_cursors(
    existing: Option<&BTreeMap<String, UnitCursor>>,
    incoming: Option<&BTreeMap<String, UnitCursor>>,
    completed: &[String],
) -> BTreeMap<String, UnitCursor> {
    let mut merged: BTreeMap<String, UnitCursor> = existing
        .into_iter()
        .flatten()
        .filter(|(unit, _)| !completed.contains(unit))
        .map(|(unit, cursor)| (unit.clone(), cursor.clone()))
        .collect();
    for (unit, cursor) in incoming.into_iter().flatten() {
        if completed.contains(unit) {
            continue;
        }
        if merged.get(unit).is_none_or(|held| cursor.next > held.next) {
            merged.insert(unit.clone(), cursor.clone());
        }
    }
    merged
}

/// A checkpoint recorded on a running job (`job:checkpoint`): the units are
/// always written, the cursors only while any remain.
pub fn checkpointed(
    metadata: &JobMetadata,
    completed_units: &[String],
    unit_cursors: Option<&BTreeMap<String, UnitCursor>>,
) -> JobMetadata {
    let units = merged_units(metadata.completed_units.as_deref(), completed_units);
    let cursors = merged_cursors(metadata.unit_cursors.as_ref(), unit_cursors, &units);
    JobMetadata {
        completed_units: Some(units),
        unit_cursors: (!cursors.is_empty()).then_some(cursors),
        ..metadata.clone()
    }
}

/// A checkpoint carried on a failure (`job:fail`): the units written when
/// there are any, the record's own kept otherwise; the cursors only while any
/// remain.
pub fn failed_with(
    metadata: &JobMetadata,
    completed_units: &[String],
    unit_cursors: Option<&BTreeMap<String, UnitCursor>>,
) -> JobMetadata {
    let units = merged_units(metadata.completed_units.as_deref(), completed_units);
    let cursors = merged_cursors(metadata.unit_cursors.as_ref(), unit_cursors, &units);
    JobMetadata {
        completed_units: if units.is_empty() {
            metadata.completed_units.clone()
        } else {
            Some(units)
        },
        unit_cursors: (!cursors.is_empty()).then_some(cursors),
        ..metadata.clone()
    }
}
