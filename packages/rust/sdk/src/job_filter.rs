//! Whether a job matches a filter.
//!
//! A filter (`JobFilter`) is a partial job description: it names fields of
//! the description at the description's own paths. A job matches when every
//! field the filter states equals the job's; what the filter leaves out is
//! not compared. So the comparison knows no field by name, and does not
//! change when a filter may state another.
//!
//! It is asked in two places: by the dispatcher, choosing the next job a
//! claim takes, and by a party checking an announcement (`job:queued`)
//! against its own claim before it asks. specs/src/jobs/filter-cases.json
//! holds every implementation to one answer, and this crate's tests run it.

use crate::types::JobFilter;
use serde::Serialize;
use serde_json::Value;

/// Whether `actual` states everything `stated` does, at the same paths.
fn states(stated: &Value, actual: &Value) -> bool {
    match stated {
        Value::Object(fields) => fields
            .iter()
            .all(|(name, value)| actual.get(name).is_some_and(|held| states(value, held))),
        other => other == actual,
    }
}

/// Whether `job` matches `filter`. `job` is a job description as it is
/// announced or held: whatever writes its `jobType` and its `params` as JSON.
pub fn job_matches_filter(filter: &JobFilter, job: &impl Serialize) -> bool {
    match (serde_json::to_value(filter), serde_json::to_value(job)) {
        (Ok(stated), Ok(job)) => states(&stated, &job),
        // What cannot be written as JSON states no field to compare.
        _ => false,
    }
}
