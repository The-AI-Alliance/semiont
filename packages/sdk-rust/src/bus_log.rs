//! `SEMIONT_BUS_LOG`: with any non-empty value, one line per frame a process
//! sends or receives, and per content read, grep-able alike across processes:
//! `[bus <op>] <channel> [scope=X] [cid=<first 8>] [trace=<first 8>] <payload>`.
//! On stderr, so the log lines on stdout stay one format.
//!
//! The trace is the active span's, when a telemetry layer has said how to read
//! it (`set_trace_id_provider`); this crate depends on none.

use serde_json::Value;
use std::io::Write;
use std::sync::OnceLock;

static ENABLED: OnceLock<bool> = OnceLock::new();
static TRACE_ID: OnceLock<fn() -> Option<String>> = OnceLock::new();

/// Read once, on first use.
fn enabled() -> bool {
    *ENABLED
        .get_or_init(|| std::env::var_os("SEMIONT_BUS_LOG").is_some_and(|value| !value.is_empty()))
}

/// How to read the active span's trace id, for the `trace=` field.
pub fn set_trace_id_provider(provider: fn() -> Option<String>) {
    let _ = TRACE_ID.set(provider);
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
    let mut stderr = std::io::stderr().lock();
    let _ = writeln!(stderr, "{tag} {payload}");
}
