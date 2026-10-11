//! `SEMIONT_BUS_LOG`: with any non-empty value, one line per frame a process
//! sends or receives, and per read or upload of content, grep-able alike across
//! processes:
//! `[bus <op>] <channel> scope=<resource> cid=<first 8> trace=<first 8> <payload>`,
//! with `scope=`, `cid=` and `trace=` each written where there is one.
//! On stderr, so the log lines on stdout stay one format.
//!
//! The trace is the active span's, when a telemetry layer has said how to read
//! it (`set_trace_id_provider`); this crate depends on none.
//!
//! No line holds a credential. The value of a member whose whole name is one
//! a credential goes by (`token`, which is what a payload names the token a
//! resource is cloned by, and the rest of `CREDENTIALS` below) is written as
//! `[withheld]`, as every bus log writes it (specs/src/bus/log-cases.json).

use serde_json::Value;
use std::io::Write;
use std::sync::OnceLock;

static ENABLED: OnceLock<bool> = OnceLock::new();
static TRACE_ID: OnceLock<fn() -> Option<String>> = OnceLock::new();

/// What a line says in place of a credential.
const WITHHELD: &str = "[withheld]";

/// The names of the members whose value is one: the list
/// specs/src/bus/log-cases.json states for every bus log, which this file's
/// tests hold this one to.
const CREDENTIALS: [&str; 16] = [
    "token",
    "cloneToken",
    "accessToken",
    "access_token",
    "refreshToken",
    "refresh_token",
    "apiKey",
    "api_key",
    "clientSecret",
    "client_secret",
    "secret",
    "password",
    "authorization",
    "Authorization",
    "x-api-key",
    "x-goog-api-key",
];

/// The lines a test asked to be given in place of stderr.
#[cfg(feature = "testing")]
static CAPTURED: std::sync::Mutex<Option<Vec<String>>> = std::sync::Mutex::new(None);

/// From now on the bus log is on, and its lines are kept for `captured`
/// rather than written: for a test that reads what was logged.
#[cfg(feature = "testing")]
pub fn capture() {
    *CAPTURED.lock().unwrap_or_else(|p| p.into_inner()) = Some(Vec::new());
}

/// The lines logged since `capture`.
#[cfg(feature = "testing")]
pub fn captured() -> Vec<String> {
    CAPTURED
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .clone()
        .unwrap_or_default()
}

/// Read once, on first use.
fn enabled() -> bool {
    #[cfg(feature = "testing")]
    if CAPTURED.lock().unwrap_or_else(|p| p.into_inner()).is_some() {
        return true;
    }
    *ENABLED
        .get_or_init(|| std::env::var_os("SEMIONT_BUS_LOG").is_some_and(|value| !value.is_empty()))
}

fn write(line: String) {
    #[cfg(feature = "testing")]
    if let Some(lines) = CAPTURED.lock().unwrap_or_else(|p| p.into_inner()).as_mut() {
        lines.push(line);
        return;
    }
    let mut stderr = std::io::stderr().lock();
    let _ = writeln!(stderr, "{line}");
}

/// How to read the active span's trace id, for the `trace=` field.
pub fn set_trace_id_provider(provider: fn() -> Option<String>) {
    let _ = TRACE_ID.set(provider);
}

/// A line about a channel that is not a frame: `[bus <op>] <channel> <note>`.
pub fn bus_note(op: &str, channel: &str, note: &str) {
    if enabled() {
        write(format!("[bus {op}] {channel} {note}"));
    }
}

/// A payload as a line shows it: as it is, less the value of each credential.
fn shown(value: &Value) -> Value {
    match value {
        Value::Object(members) => Value::Object(
            members
                .iter()
                .map(|(name, member)| {
                    let member = if CREDENTIALS.contains(&name.as_str()) {
                        Value::from(WITHHELD)
                    } else {
                        shown(member)
                    };
                    (name.clone(), member)
                })
                .collect(),
        ),
        Value::Array(items) => Value::Array(items.iter().map(shown).collect()),
        other => other.clone(),
    }
}

pub fn bus_log(
    op: &str,
    channel: &str,
    payload: &Value,
    scope: Option<&str>,
    correlation_id: Option<&str>,
) {
    if !enabled() {
        return;
    }
    let mut tag = format!("[bus {op}] {channel}");
    if let Some(scope) = scope.filter(|s| !s.is_empty()) {
        tag.push_str(&format!(" scope={scope}"));
    }
    if let Some(cid) = correlation_id.filter(|c| !c.is_empty()) {
        tag.push_str(&format!(" cid={}", cid.chars().take(8).collect::<String>()));
    }
    if let Some(trace) = TRACE_ID.get().and_then(|provider| provider()) {
        tag.push_str(&format!(
            " trace={}",
            trace.chars().take(8).collect::<String>()
        ));
    }
    write(format!("{tag} {}", shown(payload)));
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::Once;

    /// The lines of this file's tests are kept, from the first of them on.
    fn capturing() {
        static ONCE: Once = Once::new();
        ONCE.call_once(capture);
    }

    /// The one line written under `tag`.
    fn line_under(tag: &str) -> String {
        let lines: Vec<String> = captured()
            .into_iter()
            .filter(|line| line.starts_with(tag))
            .collect();
        assert_eq!(lines.len(), 1, "the lines under {tag}: {lines:?}");
        lines.concat()
    }

    /// What the line `bus_log` writes on `channel` shows of `payload`.
    fn shown_of(channel: &str, payload: &Value) -> Value {
        capturing();
        bus_log("EMIT", channel, payload, None, None);
        let tag = format!("[bus EMIT] {channel} ");
        let line = line_under(&tag);
        serde_json::from_str(&line[tag.len()..])
            .unwrap_or_else(|error| panic!("{line}: its payload is not JSON: {error}"))
    }

    /// What a bus log shows of a payload is one table,
    /// specs/src/bus/log-cases.json, which every bus log runs.
    fn table() -> Value {
        serde_json::from_str(include_str!("../specs/bus/log-cases.json"))
            .expect("the table is JSON")
    }

    /// The names the table lists.
    fn names(table: &Value) -> Vec<&str> {
        table["names"]
            .as_array()
            .expect("names")
            .iter()
            .map(|name| name.as_str().expect("a name"))
            .collect()
    }

    #[test]
    fn the_names_this_log_withholds_under_are_the_tables_and_no_others() {
        assert_eq!(names(&table()), CREDENTIALS);
    }

    #[test]
    fn the_value_of_a_member_under_each_name_of_the_table_is_withheld() {
        let table = table();
        let mut shown = Vec::new();
        for (at, name) in names(&table).into_iter().enumerate() {
            let payload = json!({ (name): "a-credential", "beside": "shown" });
            let written = shown_of(&format!("name:{at}"), &payload);
            if written != json!({ (name): WITHHELD, "beside": "shown" }) {
                shown.push(format!("{name}: shown as {written}"));
            }
        }
        assert!(shown.is_empty(), "{shown:#?}");
    }

    #[test]
    fn every_payload_of_the_table_is_shown_as_the_table_says() {
        let table = table();
        let cases = table["cases"].as_array().expect("cases");
        assert!(!cases.is_empty());
        let mut carrying = 0;
        let mut wrong = Vec::new();
        for (at, case) in cases.iter().enumerate() {
            let why = case["why"].as_str().expect("why");
            let stated = |member: &str| {
                case.get(member)
                    .unwrap_or_else(|| panic!("{why}: no {member}"))
            };
            let (payload, shown) = (stated("payload"), stated("shown"));
            // The rule reads a name and no channel: a case's is its place in the table.
            let written = shown_of(&format!("case:{at}"), payload);
            if &written != shown {
                wrong.push(format!("{why}: shown as {written}"));
            }
            carrying += usize::from(payload != shown);
        }
        assert!(wrong.is_empty(), "{wrong:#?}");
        assert!(
            (1..cases.len()).contains(&carrying),
            "the table has no case that carries a credential, or none that carries none"
        );
    }

    // A frame's payload is an object, and so is every case's. This function
    // can be given any JSON.
    #[test]
    fn a_payload_that_is_an_array_is_read_by_the_same_rule_and_any_other_is_shown_as_it_is() {
        assert_eq!(
            shown_of(
                "no-frame:array",
                &json!([{ "token": "clone-token", "name": "first" }, "token", ["token"]])
            ),
            json!([{ "token": "[withheld]", "name": "first" }, "token", ["token"]])
        );
        assert_eq!(shown_of("no-frame:text", &json!("token")), json!("token"));
        assert_eq!(shown_of("no-frame:number", &json!(7)), json!(7));
        assert_eq!(shown_of("no-frame:null", &Value::Null), Value::Null);
    }

    #[test]
    fn a_line_is_its_tag_and_the_payload_as_the_rule_shows_it() {
        capturing();
        bus_log(
            "RECV",
            "yield:clone-token-generated",
            &json!({ "response": { "expiresAt": "2026-10-11T00:00:00.000Z", "token": "clone-token" } }),
            Some("res-1"),
            Some("a89a670a-1b2c-4d3e-8f90-123456789abc"),
        );
        // The members are given in the order of their names, so the line is
        // the same whether or not a build keeps a payload's own order.
        assert_eq!(
            line_under("[bus RECV] yield:clone-token-generated "),
            r#"[bus RECV] yield:clone-token-generated scope=res-1 cid=a89a670a {"response":{"expiresAt":"2026-10-11T00:00:00.000Z","token":"[withheld]"}}"#
        );
    }
}
