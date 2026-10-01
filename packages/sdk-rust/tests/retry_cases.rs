//! Whether a failed request is worth another attempt is one table,
//! specs/src/retry/cases.json, which every implementation runs: here through
//! this crate's rules and its reading of `Retry-After`.

use semiont::retry::{RETRY_RULES, RetryFacts, retry_after};
use serde_json::Value;

fn table() -> Value {
    serde_json::from_str(include_str!("../../../specs/src/retry/cases.json"))
        .expect("the table is JSON")
}

#[test]
fn every_rule_is_asked_both_ways() {
    let table = table();
    let rows = table["rules"].as_array().expect("the table has rules");
    for rule in RETRY_RULES {
        let mut answers: Vec<bool> = rows
            .iter()
            .filter(|row| row["rule"] == rule.name)
            .map(|row| row["retries"].as_bool().expect("retries"))
            .collect();
        answers.sort();
        answers.dedup();
        assert_eq!(
            answers,
            [false, true],
            "rule {} has no row, or rows of one answer",
            rule.name
        );
    }
}

#[test]
fn rules() {
    let table = table();
    for row in table["rules"].as_array().expect("the table has rules") {
        let name = row["rule"].as_str().expect("rule");
        let rule = RETRY_RULES
            .iter()
            .find(|rule| rule.name == name)
            .unwrap_or_else(|| panic!("the table names a rule this crate does not have: {name}"));
        let facts = RetryFacts {
            status: row["status"]
                .as_u64()
                .map(|status| u16::try_from(status).expect("a status")),
            method: row["method"].as_str(),
        };
        assert_eq!(
            rule.retryable(&facts),
            row["retries"].as_bool().expect("retries"),
            "{name}: {}",
            row["why"]
        );
    }
}

#[test]
fn retry_after_header() {
    let table = table();
    let rows = table["retryAfter"]
        .as_array()
        .expect("the table has retryAfter");
    assert!(!rows.is_empty(), "the table has no Retry-After rows");
    for row in rows {
        let stated = retry_after(row["header"].as_str()).map(|wait| wait.as_millis() as u64);
        assert_eq!(stated, row["ms"].as_u64(), "{}", row["why"]);
    }
}
