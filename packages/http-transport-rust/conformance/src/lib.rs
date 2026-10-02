//! What the Rust drivers of the SDK conformance suite share
//! (tests/conformance/sdk; its README.md is the protocol): a driver is a
//! process that reads one operation per line on stdin and writes what it did,
//! and what it saw, one line at a time on stdout.
//!
//! The two drivers are this crate's binaries: `semiont-wire-driver` holds a
//! transport, and `semiont-live-driver` the SDK's client over one.

use semiont::errors::{SemiontError, TransportError};
use semiont::types::InvalidIdentifier;
use semiont_observability::telemetry;
use serde_json::{Map, Value, json};
use std::collections::HashMap;
use std::future::Future;
use std::io::Write;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;
use tokio::io::AsyncBufReadExt;
use tokio::task::{AbortHandle, JoinSet};

pub type Arguments = Map<String, Value>;

/// How an operation ends, apart from succeeding.
pub enum Ended {
    /// The suite sent something this driver cannot act on: the suite's
    /// mistake, never the SDK's.
    Misuse(String),
    /// The SDK failed it.
    Failed(SemiontError),
}

impl From<SemiontError> for Ended {
    fn from(error: SemiontError) -> Ended {
        Ended::Failed(error)
    }
}

impl From<TransportError> for Ended {
    fn from(error: TransportError) -> Ended {
        Ended::Failed(error.into())
    }
}

pub fn locked<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Write one line of the protocol.
pub fn say(line: Value) {
    let mut out = std::io::stdout().lock();
    let _ = writeln!(out, "{line}");
}

/// A failure as the protocol carries it: the SDK's code, and the status when
/// a server stated one.
pub fn failure(code: &str, status: Option<u16>, detail: String) -> Value {
    let mut failure = json!({ "code": code, "detail": detail });
    if let Some(status) = status {
        failure["status"] = json!(status);
    }
    failure
}

/// The same, of a failure the SDK reported.
pub fn failed(error: &SemiontError) -> Value {
    failure(error.code(), error.status(), error.to_string())
}

pub fn text<'a>(args: &'a Arguments, name: &str) -> Result<&'a str, Ended> {
    args.get(name)
        .and_then(Value::as_str)
        .ok_or_else(|| Ended::Misuse(format!("{name} must be a string")))
}

pub fn optional_text(args: &Arguments, name: &str) -> Result<Option<String>, Ended> {
    match args.get(name) {
        None => Ok(None),
        Some(_) => text(args, name).map(|text| Some(text.to_owned())),
    }
}

/// An id the suite names, as the SDK's type for it. One the type refuses is
/// the suite's mistake: an application could not have made it.
pub fn identifier<T>(args: &Arguments, name: &str) -> Result<T, Ended>
where
    T: std::str::FromStr<Err = InvalidIdentifier>,
{
    text(args, name)?
        .parse()
        .map_err(|not_one: InvalidIdentifier| Ended::Misuse(format!("{name}: {not_one}")))
}

pub fn optional_identifier<T>(args: &Arguments, name: &str) -> Result<Option<T>, Ended>
where
    T: std::str::FromStr<Err = InvalidIdentifier>,
{
    match args.get(name) {
        None => Ok(None),
        Some(_) => identifier(args, name).map(Some),
    }
}

pub fn count(args: &Arguments, name: &str) -> Result<u64, Ended> {
    args.get(name)
        .and_then(Value::as_u64)
        .ok_or_else(|| Ended::Misuse(format!("{name} must be a whole number")))
}

pub fn object<'a>(args: &'a Arguments, name: &str) -> Result<&'a Arguments, Ended> {
    args.get(name)
        .and_then(Value::as_object)
        .ok_or_else(|| Ended::Misuse(format!("{name} must be an object")))
}

pub fn texts(args: &Arguments, name: &str) -> Result<Vec<String>, Ended> {
    args.get(name)
        .and_then(Value::as_array)
        .and_then(|items| {
            items
                .iter()
                .map(|item| item.as_str().map(str::to_owned))
                .collect()
        })
        .ok_or_else(|| Ended::Misuse(format!("{name} must be a list of strings")))
}

/// The operations still running, each by the id the suite gave it: what a
/// driver whose caller can abandon an operation abandons it through.
#[derive(Default)]
pub struct Running {
    callers: Mutex<HashMap<u64, AbortHandle>>,
}

impl Running {
    /// Abandon the operation `id`, as its caller would. Whether one by that
    /// id was still unsettled.
    pub fn abandon(&self, id: u64) -> bool {
        match locked(&self.callers).get(&id) {
            Some(caller) => {
                caller.abort();
                true
            }
            None => false,
        }
    }
}

/// A driver: what it can be asked, and how it does each.
pub trait Driver: Send + Sync + 'static {
    /// The operations this driver has. Any other is answered `unsupported`.
    const OPERATIONS: &'static [&'static str];

    /// Run the operation `op`, which the suite numbered `id`.
    fn run(
        self: Arc<Self>,
        running: Arc<Running>,
        id: u64,
        op: String,
        args: Arguments,
    ) -> impl Future<Output = Result<Value, Ended>> + Send;

    /// The driver's input ended: dispose of what it holds, and wait for
    /// whatever is left to say to have been said.
    fn finish(self: Arc<Self>) -> impl Future<Output = ()> + Send;
}

/// Run one operation and answer it, once.
async fn operate<D: Driver>(
    driver: Arc<D>,
    running: Arc<Running>,
    id: u64,
    op: String,
    args: Arguments,
) {
    let operation = tokio::spawn(driver.run(running.clone(), id, op, args));
    locked(&running.callers).insert(id, operation.abort_handle());
    let outcome = operation.await;
    locked(&running.callers).remove(&id);
    say(match outcome {
        // The suite abandoned it, and the SDK reported nothing else.
        Err(_) => json!({ "id": id, "abandoned": true }),
        Ok(Ok(value)) => json!({ "id": id, "ok": value }),
        Ok(Err(Ended::Misuse(why))) => json!({ "id": id, "misuse": why }),
        Ok(Err(Ended::Failed(error))) => json!({ "id": id, "error": failed(&error) }),
    });
}

/// Be `driver` until stdin ends: say it is ready, run each operation as it
/// arrives, and at the end have exported whatever telemetry the suite asked
/// for.
pub async fn serve<D: Driver>(driver: D) {
    let _ = rustls::crypto::ring::default_provider().install_default();
    // Exports only when the suite names an OTLP endpoint in the environment.
    if let Err(error) =
        telemetry::initialize("semiont-conformance-driver", env!("CARGO_PKG_VERSION"))
    {
        eprintln!("telemetry: {error}");
    }
    let driver = Arc::new(driver);
    let running = Arc::new(Running::default());
    say(json!({ "ready": true }));

    let mut operations = JoinSet::new();
    let mut lines = tokio::io::BufReader::new(tokio::io::stdin()).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        let Ok(Value::Object(mut args)) = serde_json::from_str::<Value>(&line) else {
            eprintln!("a line that is not an operation: {line}");
            continue;
        };
        let (Some(id), Some(Value::String(op))) = (
            args.remove("id").and_then(|id| id.as_u64()),
            args.remove("op"),
        ) else {
            eprintln!("an operation with no id or no op: {line}");
            continue;
        };
        if D::OPERATIONS.contains(&op.as_str()) {
            operations.spawn(operate(driver.clone(), running.clone(), id, op, args));
        } else {
            // Said at once, before the next operation is read.
            say(json!({ "id": id, "unsupported": true }));
        }
    }

    driver.finish().await;
    while operations.join_next().await.is_some() {}
    telemetry::shutdown(Duration::from_secs(5));
    std::process::exit(0);
}
