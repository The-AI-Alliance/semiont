//! Log lines on stdout, at the level and in the format the configuration
//! document names (`logLevel`, `logFormat`): `json`, one object per line
//! carrying the active trace's `trace_id` and `span_id`; `simple`,
//! `<timestamp> [<LEVEL>] <message>` followed by any fields as JSON.

use crate::types::{LogFormat, LogLevel};
use opentelemetry::trace::TraceContextExt;
use serde_json::{Map, Value, json};
use std::io::Write;
use std::sync::OnceLock;

struct Logger {
    level: LogLevel,
    format: LogFormat,
}

static LOGGER: OnceLock<Logger> = OnceLock::new();

tokio::task_local! {
    /// The request a line is logged for, when it is logged while serving one.
    pub static REQUEST_ID: String;
}

pub fn initialize(level: LogLevel, format: LogFormat) {
    if LOGGER.set(Logger { level, format }).is_err() {
        panic!("the logger is initialized once");
    }
}

pub fn error(message: &str, fields: Value) {
    log(LogLevel::Error, message, fields);
}
pub fn warn(message: &str, fields: Value) {
    log(LogLevel::Warn, message, fields);
}
pub fn info(message: &str, fields: Value) {
    log(LogLevel::Info, message, fields);
}
pub fn debug(message: &str, fields: Value) {
    log(LogLevel::Debug, message, fields);
}

fn level_name(level: LogLevel) -> &'static str {
    match level {
        LogLevel::Error => "error",
        LogLevel::Warn => "warn",
        LogLevel::Info => "info",
        LogLevel::Http => "http",
        LogLevel::Debug => "debug",
    }
}

fn log(level: LogLevel, message: &str, fields: Value) {
    let Some(logger) = LOGGER.get() else { return };
    if level > logger.level {
        return;
    }
    let mut meta: Map<String, Value> = match fields {
        Value::Object(map) => map,
        Value::Null => Map::new(),
        other => Map::from_iter([("detail".to_owned(), other)]),
    };
    if let Ok(request_id) = REQUEST_ID.try_with(Clone::clone) {
        meta.insert("requestId".to_owned(), json!(request_id));
    }
    let context = opentelemetry::Context::current();
    let span = context.span();
    let span_context = span.span_context();
    if span_context.is_valid() {
        meta.insert(
            "trace_id".to_owned(),
            json!(span_context.trace_id().to_string()),
        );
        meta.insert(
            "span_id".to_owned(),
            json!(span_context.span_id().to_string()),
        );
    }
    let now = chrono::Utc::now();
    let line = match logger.format {
        LogFormat::Json => {
            let mut object = Map::new();
            object.insert("level".to_owned(), json!(level_name(level)));
            object.insert("message".to_owned(), json!(message));
            object.extend(meta);
            object.insert(
                "timestamp".to_owned(),
                json!(now.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()),
            );
            Value::Object(object).to_string()
        }
        LogFormat::Simple => {
            let fields = if meta.is_empty() {
                String::new()
            } else {
                format!(" {}", Value::Object(meta))
            };
            format!(
                "{} [{}] {message}{fields}",
                now.format("%Y-%m-%d %H:%M:%S"),
                level_name(level).to_uppercase()
            )
        }
    };
    let mut stdout = std::io::stdout().lock();
    let _ = writeln!(stdout, "{line}");
}

/// An error and the errors that caused it, as one line.
pub fn chain(error: &dyn std::error::Error) -> String {
    let mut text = error.to_string();
    let mut source = error.source();
    while let Some(cause) = source {
        text.push_str(": ");
        text.push_str(&cause.to_string());
        source = cause.source();
    }
    text
}
