//! The Rust wire driver for the SDK conformance suite (tests/conformance/sdk).
//! The suite starts it, sends it one operation per line on stdin and reads
//! what it did, and what it saw, one line at a time from stdout;
//! tests/conformance/sdk/README.md is the protocol.
//!
//! It reaches the transport only as an application does, through what
//! `semiont` and `semiont-http-transport` export, so what the suite observes
//! is what a caller of the SDK gets.

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use bytes::Bytes;
use futures::StreamExt;
use semiont::bus::{Bus, operation};
use semiont::errors::{SemiontError, TransportError};
use semiont::retry::RetryPolicy;
use semiont::transport::{
    ConnectionState, ContentTransport, Envelope, GatewayOperations, PutBinaryRequest, ResourceHold,
    Transport,
};
use semiont_http_transport::content::HttpContentTransport;
use semiont_http_transport::transport::{HttpTransport, HttpTransportConfig, Timing};
use semiont_observability::telemetry;
use serde_json::{Map, Value, json};
use std::collections::HashMap;
use std::io::Write;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;
use tokio::io::AsyncBufReadExt;
use tokio::sync::watch;
use tokio::task::{AbortHandle, JoinSet};

type Arguments = Map<String, Value>;

/// How an operation ends, apart from succeeding.
enum Ended {
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

fn locked<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn say(line: Value) {
    let mut out = std::io::stdout().lock();
    let _ = writeln!(out, "{line}");
}

/// A failure as the protocol carries it: the SDK's code, and the status when
/// a server stated one.
fn failure(code: &str, status: Option<u16>, detail: String) -> Value {
    let mut failure = json!({ "code": code, "detail": detail });
    if let Some(status) = status {
        failure["status"] = json!(status);
    }
    failure
}

fn text<'a>(args: &'a Arguments, name: &str) -> Result<&'a str, Ended> {
    args.get(name)
        .and_then(Value::as_str)
        .ok_or_else(|| Ended::Misuse(format!("{name} must be a string")))
}

fn optional_text(args: &Arguments, name: &str) -> Result<Option<String>, Ended> {
    match args.get(name) {
        None => Ok(None),
        Some(_) => text(args, name).map(|text| Some(text.to_owned())),
    }
}

fn count(args: &Arguments, name: &str) -> Result<u64, Ended> {
    args.get(name)
        .and_then(Value::as_u64)
        .ok_or_else(|| Ended::Misuse(format!("{name} must be a whole number")))
}

fn object<'a>(args: &'a Arguments, name: &str) -> Result<&'a Arguments, Ended> {
    args.get(name)
        .and_then(Value::as_object)
        .ok_or_else(|| Ended::Misuse(format!("{name} must be an object")))
}

fn texts(args: &Arguments, name: &str) -> Result<Vec<String>, Ended> {
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

struct Client {
    token: watch::Sender<Option<String>>,
    transport: HttpTransport,
    bus: Bus,
    content: HttpContentTransport,
}

#[derive(Default)]
struct Driver {
    client: Mutex<Option<Arc<Client>>>,
    /// The holds `subscribe-resource` took, per resource, newest last.
    held: Mutex<HashMap<String, Vec<ResourceHold>>>,
    /// What abandons each request still unsettled, by the id of its operation.
    callers: Mutex<HashMap<u64, AbortHandle>>,
    /// The state last reported, and the tasks that report what the client
    /// observes.
    reported: Mutex<Option<ConnectionState>>,
    reporters: Mutex<JoinSet<()>>,
}

impl Driver {
    fn client(&self) -> Result<Arc<Client>, Ended> {
        locked(&self.client)
            .clone()
            .ok_or_else(|| Ended::Misuse("no transport is open".to_owned()))
    }

    /// Report the state the transport is in, unless it is the one last reported.
    fn report(&self, state: ConnectionState) {
        let mut reported = locked(&self.reported);
        if *reported != Some(state) {
            *reported = Some(state);
            say(json!({ "state": state.as_str() }));
        }
    }

    fn open(self: &Arc<Self>, args: &Arguments) -> Result<Value, Ended> {
        if locked(&self.client).is_some() {
            return Err(Ended::Misuse("a transport is already open".to_owned()));
        }
        let mut timing = Timing::default();
        let stated = match args.get("timing") {
            None => &Arguments::new(),
            Some(_) => object(args, "timing")?,
        };
        let ms = |name: &str| count(stated, name).map(Duration::from_millis);
        for name in stated.keys() {
            match name.as_str() {
                "reconnectMs" => timing.reconnect = ms(name)?,
                "lazyRemoveMs" => timing.lazy_remove = ms(name)?,
                "lingerMs" => timing.linger = ms(name)?,
                "seenEventIdsCount" => {
                    timing.seen_event_ids = usize::try_from(count(stated, name)?)
                        .map_err(|_| Ended::Misuse(format!("{name} is too large")))?;
                }
                "emitRetry" => {
                    let budget = object(stated, name)?;
                    timing.emit_retry = RetryPolicy {
                        attempts: u32::try_from(count(budget, "attempts")?)
                            .map_err(|_| Ended::Misuse("attempts is too large".to_owned()))?,
                        initial_delay: Duration::from_millis(count(budget, "initialDelayMs")?),
                        max_delay: Duration::from_millis(count(budget, "maxDelayMs")?),
                    };
                }
                other => {
                    return Err(Ended::Misuse(format!(
                        "this driver cannot override {other}"
                    )));
                }
            }
        }
        let (token, tokens) = watch::channel(Some(text(args, "token")?.to_owned()));
        let transport = HttpTransport::new(HttpTransportConfig {
            base_url: text(args, "baseUrl")?.to_owned(),
            token: tokens,
            refresher: None,
            channels: Some(texts(args, "channels")?),
            http: reqwest::Client::new(),
            timing,
        });

        let mut reporters = locked(&self.reporters);
        let mut state = transport.state();
        let driver = self.clone();
        reporters.spawn(async move {
            loop {
                let current = *state.borrow_and_update();
                driver.report(current);
                if state.changed().await.is_err() {
                    driver.report(*state.borrow());
                    return;
                }
            }
        });
        let mut failures = transport.failures();
        reporters.spawn(async move {
            while let Some(reported) = failures.next().await {
                match reported {
                    Ok(error) => say(json!({
                        "error": failure(error.code.as_str(), error.status, error.message)
                    })),
                    Err(lagged) => eprintln!("the error stream: {lagged}"),
                }
            }
        });
        drop(reporters);

        *locked(&self.client) = Some(Arc::new(Client {
            token,
            bus: Bus::new(Arc::new(transport.clone())),
            content: HttpContentTransport::new(&transport),
            transport,
        }));
        Ok(Value::Null)
    }

    fn listen(&self, args: &Arguments) -> Result<Value, Ended> {
        let channel = text(args, "channel")?.to_owned();
        let mut frames = self
            .client()?
            .transport
            .frames(&channel)
            .map_err(SemiontError::from)?;
        locked(&self.reporters).spawn(async move {
            while let Some(delivered) = frames.next().await {
                match delivered {
                    Ok(frame) => {
                        let mut line = json!({ "channel": channel, "payload": frame.payload });
                        if let Some(correlation_id) = frame.correlation_id {
                            line["correlationId"] = json!(correlation_id);
                        }
                        if let Some(scope) = frame.scope {
                            line["scope"] = json!(scope);
                        }
                        say(json!({ "frame": line }));
                    }
                    Err(lagged) => eprintln!("listening to {channel}: {lagged}"),
                }
            }
        });
        Ok(Value::Null)
    }

    async fn run(self: &Arc<Self>, id: u64, op: &str, args: Arguments) -> Result<Value, Ended> {
        match op {
            "open" => self.open(&args),
            "close" => match self.client() {
                Ok(client) => {
                    client.transport.close().await;
                    Ok(Value::Null)
                }
                Err(misuse) => Err(misuse),
            },
            "set-token" => self.client().and_then(|client| {
                client
                    .token
                    .send_replace(Some(text(&args, "token")?.to_owned()));
                Ok(Value::Null)
            }),
            "listen" => self.listen(&args),
            "subscribe-resource" => self.client().and_then(|client| {
                let resource = text(&args, "resource")?;
                locked(&self.held)
                    .entry(resource.to_owned())
                    .or_default()
                    .push(client.transport.subscribe_to_resource(resource));
                Ok(Value::Null)
            }),
            "release-resource" => text(&args, "resource").and_then(|resource| {
                locked(&self.held)
                    .get_mut(resource)
                    .and_then(Vec::pop)
                    .map(|_| Value::Null)
                    .ok_or_else(|| Ended::Misuse(format!("nothing holds {resource}")))
            }),
            "emit" => self.emit(&args).await,
            "request" => self.request(&args).await,
            "abandon" => count(&args, "request").and_then(|request| {
                match locked(&self.callers).get(&request) {
                    Some(caller) => {
                        caller.abort();
                        Ok(Value::Null)
                    }
                    None => Err(Ended::Misuse("no such request is unsettled".to_owned())),
                }
            }),
            "put" => self.put(&args, None).await,
            "upload" => self.put(&args, Some(id)).await,
            "get" => self.get(&args, false).await,
            "get-stream" => self.get(&args, true).await,
            "graph" => self.graph(&args).await,
            "health"
            | "status"
            | "current-user"
            | "media-token"
            | "protected-resource-metadata" => self.gateway(op, &args).await,
            // Answers after everything the transport reported before it: the
            // suite's way to know it has read every state the connection was in.
            "sync" => {
                if let Ok(client) = self.client() {
                    self.report(*client.transport.state().borrow());
                }
                Ok(Value::Null)
            }
            other => Err(Ended::Misuse(format!(
                "{other} is not an operation of this driver"
            ))),
        }
    }

    async fn emit(&self, args: &Arguments) -> Result<Value, Ended> {
        let client = self.client()?;
        let envelope = Envelope {
            correlation_id: optional_text(args, "correlationId")?,
            scope: optional_text(args, "scope")?,
        };
        let subscribers = client
            .bus
            .emit_on(
                text(args, "channel")?,
                object(args, "payload")?.clone(),
                envelope,
            )
            .await?;
        Ok(match subscribers {
            Some(subscribers) => json!({ "subscribers": subscribers }),
            None => json!({}),
        })
    }

    async fn request(&self, args: &Arguments) -> Result<Value, Ended> {
        let client = self.client()?;
        let name = text(args, "operation")?;
        let operation = operation(name)
            .ok_or_else(|| Ended::Misuse(format!("{name} is not an operation of the registry")))?;
        let response = client
            .bus
            .request_of(
                operation,
                object(args, "payload")?.clone(),
                Duration::from_millis(count(args, "timeoutMs")?),
            )
            .await?;
        Ok(match response {
            Some(response) => json!({ "response": response }),
            None => json!({}),
        })
    }

    /// An upload. With `reporting`, the id of its operation, its progress is
    /// reported as it is sent.
    async fn put(&self, args: &Arguments, reporting: Option<u64>) -> Result<Value, Ended> {
        let client = self.client()?;
        let bytes = STANDARD
            .decode(text(args, "bytes")?)
            .map_err(|e| Ended::Misuse(format!("bytes is not base64: {e}")))?;
        let request = PutBinaryRequest {
            name: text(args, "name")?.to_owned(),
            bytes: Bytes::from(bytes),
            format: text(args, "format")?.to_owned(),
            storage_uri: text(args, "storageUri")?.to_owned(),
            entity_types: match args.get("entityTypes") {
                None => Vec::new(),
                Some(_) => texts(args, "entityTypes")?,
            },
            language: optional_text(args, "language")?,
            source_annotation_id: optional_text(args, "sourceAnnotationId")?,
            source_resource_id: optional_text(args, "sourceResourceId")?,
            generation_prompt: optional_text(args, "generationPrompt")?,
            generator: None,
            job_id: optional_text(args, "jobId")?,
            is_draft: args.get("isDraft").map(|value| value == &Value::Bool(true)),
            clone_token: None,
            archive_original: None,
        };
        let mut upload = client.content.put_binary(request);
        if let Some(id) = reporting {
            while let Some(progress) = upload.next().await {
                say(json!({ "progress": {
                    "upload": id,
                    "bytesUploaded": progress.bytes_uploaded,
                    "totalBytes": progress.total_bytes,
                } }));
            }
        }
        let created = upload.await?;
        Ok(json!({ "resourceId": created.resource_id }))
    }

    async fn get(&self, args: &Arguments, as_stream: bool) -> Result<Value, Ended> {
        let client = self.client()?;
        let resource = text(args, "resource")?;
        let (content_type, bytes) = if as_stream {
            let mut stream = client.content.get_binary_stream(resource).await?;
            let mut bytes = Vec::new();
            while let Some(read) = stream.bytes.next().await {
                bytes.extend_from_slice(&read?);
            }
            (stream.content_type, bytes)
        } else {
            let content = client.content.get_binary(resource).await?;
            (content.content_type, content.bytes.to_vec())
        };
        Ok(json!({ "contentType": content_type, "bytes": STANDARD.encode(bytes) }))
    }

    async fn graph(&self, args: &Arguments) -> Result<Value, Ended> {
        let client = self.client()?;
        let graph = client
            .content
            .get_resource_graph(text(args, "resource")?)
            .await?;
        serde_json::to_value(graph)
            .map_err(|e| Ended::Misuse(format!("the description does not serialize: {e}")))
    }

    async fn gateway(&self, op: &str, args: &Arguments) -> Result<Value, Ended> {
        let client = self.client()?;
        let gateway = &client.transport;
        let answered = match op {
            "health" => serde_json::to_value(gateway.health_check().await?),
            "status" => serde_json::to_value(gateway.get_status().await?),
            "current-user" => serde_json::to_value(gateway.get_current_user().await?),
            "media-token" => {
                serde_json::to_value(gateway.get_media_token(text(args, "resource")?).await?)
            }
            _ => serde_json::to_value(gateway.get_protected_resource_metadata().await?),
        };
        answered.map_err(|e| Ended::Misuse(format!("{op} answered what does not serialize: {e}")))
    }
}

/// The operations this driver has.
const OPERATIONS: [&str; 20] = [
    "open",
    "close",
    "set-token",
    "listen",
    "subscribe-resource",
    "release-resource",
    "emit",
    "request",
    "abandon",
    "put",
    "upload",
    "get",
    "get-stream",
    "graph",
    "health",
    "status",
    "current-user",
    "media-token",
    "protected-resource-metadata",
    "sync",
];

/// Run one operation and answer it, once.
async fn operate(driver: Arc<Driver>, id: u64, op: String, args: Arguments) {
    let running = tokio::spawn({
        let driver = driver.clone();
        async move { driver.run(id, &op, args).await }
    });
    locked(&driver.callers).insert(id, running.abort_handle());
    let outcome = running.await;
    locked(&driver.callers).remove(&id);
    say(match outcome {
        // The suite abandoned it, and the SDK reported nothing else.
        Err(_) => json!({ "id": id, "abandoned": true }),
        Ok(Ok(value)) => json!({ "id": id, "ok": value }),
        Ok(Err(Ended::Misuse(why))) => json!({ "id": id, "misuse": why }),
        Ok(Err(Ended::Failed(error))) => {
            json!({ "id": id, "error": failure(error.code(), error.status(), error.to_string()) })
        }
    });
}

#[tokio::main]
async fn main() {
    let _ = rustls::crypto::ring::default_provider().install_default();
    // Exports only when the suite names an OTLP endpoint in the environment.
    if let Err(error) =
        telemetry::initialize("semiont-conformance-driver", env!("CARGO_PKG_VERSION"))
    {
        eprintln!("telemetry: {error}");
    }
    let driver = Arc::new(Driver::default());
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
        if OPERATIONS.contains(&op.as_str()) {
            operations.spawn(operate(driver.clone(), id, op, args));
        } else {
            // Said at once, before the next operation is read.
            say(json!({ "id": id, "unsupported": true }));
        }
    }

    // Its input ended: dispose of the client, say what is left to say, and
    // export whatever has not been exported yet.
    let client = locked(&driver.client).clone();
    if let Some(client) = client {
        client.transport.close().await;
    }
    while operations.join_next().await.is_some() {}
    let mut reporters = std::mem::take(&mut *locked(&driver.reporters));
    while reporters.join_next().await.is_some() {}
    telemetry::shutdown(Duration::from_secs(5));
    std::process::exit(0);
}
