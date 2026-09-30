//! `SEMIONT_BUS_LOG`: with any non-empty value, one line per frame the service
//! accepts or delivers, and per content read, grep-able alike across
//! processes: `[bus <op>] <channel> [scope=X] [cid=<first 8>] [trace=<first 8>] <payload>`.
//! On stderr, so the log lines on stdout stay one format.

use opentelemetry::trace::TraceContextExt;
use serde_json::Value;
use std::io::Write;
use std::sync::OnceLock;

static ENABLED: OnceLock<bool> = OnceLock::new();

/// Read once, at boot.
pub fn configure() {
    let enabled = std::env::var_os("SEMIONT_BUS_LOG").is_some_and(|value| !value.is_empty());
    let _ = ENABLED.set(enabled);
}

pub fn bus_log(
    op: &str,
    channel: &str,
    payload: &Value,
    scope: Option<&str>,
    correlation_id: Option<&str>,
) {
    if !ENABLED.get().copied().unwrap_or(false) {
        return;
    }
    let mut tag = format!("[bus {op}] {channel}");
    if let Some(scope) = scope.filter(|s| !s.is_empty()) {
        tag.push_str(&format!(" scope={scope}"));
    }
    if let Some(cid) = correlation_id.filter(|c| !c.is_empty()) {
        tag.push_str(&format!(" cid={}", cid.chars().take(8).collect::<String>()));
    }
    let context = opentelemetry::Context::current();
    let span = context.span();
    if span.span_context().is_valid() {
        let trace = span.span_context().trace_id().to_string();
        tag.push_str(&format!(" trace={}", &trace[..8]));
    }
    let mut stderr = std::io::stderr().lock();
    let _ = writeln!(stderr, "{tag} {payload}");
}
