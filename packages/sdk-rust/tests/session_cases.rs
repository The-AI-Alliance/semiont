//! How a client holds a session is one table, specs/src/session/cases.json,
//! which every SDK that holds a session runs: here through this crate's
//! refresh schedule and its reading of a token's expiry.

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use semiont::session::{refresh_delay, token_expiry};
use serde_json::Value;
use std::time::{Duration, UNIX_EPOCH};

fn table() -> Value {
    serde_json::from_str(include_str!("../../../specs/src/session/cases.json"))
        .expect("the table is JSON")
}

/// A JWT carrying `claims`. Unsigned: nothing here verifies one.
fn token_of(claims: &Value) -> String {
    format!(
        "{}.{}.signature",
        URL_SAFE_NO_PAD.encode(r#"{"alg":"none"}"#),
        URL_SAFE_NO_PAD.encode(claims.to_string())
    )
}

#[test]
fn refresh_schedule() {
    let table = table();
    let rows = table["refreshSchedule"]
        .as_array()
        .expect("the table has refreshSchedule");
    assert!(!rows.is_empty(), "the table has no schedule rows");
    for row in rows {
        let token = match row["token"].as_str() {
            Some(token) => token.to_owned(),
            None => token_of(&row["claims"]),
        };
        let now = UNIX_EPOCH + Duration::from_secs(row["now"].as_u64().expect("now"));
        assert_eq!(
            refresh_delay(&token, now).map(|delay| delay.as_millis() as u64),
            row["delay"].as_u64().map(|seconds| seconds * 1000),
            "{}",
            row["why"]
        );
    }
}

#[test]
fn expiry() {
    let table = table();
    let rows = table["tokenExpiry"]
        .as_array()
        .expect("the table has tokenExpiry");
    assert!(!rows.is_empty(), "the table has no expiry rows");
    for row in rows {
        let read = token_expiry(row["token"].as_str().expect("token")).map(|at| {
            at.duration_since(UNIX_EPOCH)
                .expect("after the epoch")
                .as_secs()
        });
        assert_eq!(read, row["exp"].as_u64(), "{}", row["why"]);
    }
}
