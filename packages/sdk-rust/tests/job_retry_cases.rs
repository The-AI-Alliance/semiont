//! Whether a failed job is retried is one table,
//! specs/src/jobs/retry-cases.json, which every implementation runs: the
//! dispatcher's queue acts on the answer, and a worker reports it on
//! `job:fail` as `willRetry`, so the two must never disagree. In Rust both
//! answer through this crate's `will_retry_after`.

use semiont::claims::will_retry_after;
use semiont::testing::as_id;
use semiont::types::{FailureClass, JobMetadata, JobType};
use serde_json::Value;

#[test]
fn retry_cases() {
    let table: Value = serde_json::from_str(include_str!("../specs/jobs/retry-cases.json"))
        .expect("the table is JSON");
    let cases = table["cases"].as_array().expect("the table has cases");
    assert!(!cases.is_empty(), "the table has no cases");
    for case in cases {
        let metadata = JobMetadata {
            id: as_id("job-0"),
            r#type: JobType::Mark,
            user_id: as_id("did:web:example.org:users:alice"),
            created: "2026-09-30T00:00:00.000Z".to_owned(),
            retry_count: case["retryCount"].as_u64().expect("retryCount"),
            max_retries: case["maxRetries"].as_u64().expect("maxRetries"),
            completed_units: None,
            unit_cursors: None,
        };
        let failure_class: Option<FailureClass> =
            serde_json::from_value(case["failureClass"].clone()).expect("a failure class or none");
        assert_eq!(
            will_retry_after(&metadata, failure_class),
            case["retries"].as_bool().expect("retries"),
            "{}",
            case["why"]
        );
    }
}
