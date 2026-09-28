//! The specs the gateway is built against, embedded when it is compiled
//! (build.rs): its own OpenAPI document, the Archivist's, their component
//! schemas as validators, the limits the spec states, and the bus registry
//! with the channel classification scripts/bus/generate-ts.mjs derives from it.

use jsonschema::{Draft, Validator, ValidatorMap};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::sync::OnceLock;

/// The release this build is: version.json's `version`.
pub const VERSION: &str = env!("SEMIONT_VERSION");

const OPENAPI: &str = include_str!(concat!(env!("OUT_DIR"), "/openapi.json"));
const ARCHIVIST_OPENAPI: &str = include_str!(concat!(env!("OUT_DIR"), "/archivist.openapi.json"));
const SCHEMAS: &str = include_str!(concat!(env!("OUT_DIR"), "/schemas.json"));
const REGISTRY: &str = include_str!("../../../specs/src/bus/registry.json");
const CLASSIFICATION: &str = include_str!("bus-classification.json");

pub const HTTP_METHODS: [&str; 8] = [
    "get", "put", "post", "delete", "options", "head", "patch", "trace",
];

/// A registry operation: the request, and the channels its reply and failure come on.
#[derive(Debug, Clone)]
pub struct Operation {
    pub result: String,
    pub failure: String,
}

pub struct Spec {
    pub document: Value,
    pub archivist: Value,
    validators: ValidatorMap,
    /// channel → the schema its payload is validated against (`None`: not validated).
    channel_schemas: HashMap<String, Option<String>>,
    operations: HashMap<String, Operation>,
    correlated: HashSet<String>,
    writes: HashSet<String>,
    limits: Limits,
    /// "METHOD path" → what that operation's JSON body must be.
    json_bodies: HashMap<String, JsonBody>,
}

/// What an operation that takes JSON accepts: the component schema its body
/// must match, and its `x-semiont-limits.maxBodyBytes`.
#[derive(Debug)]
pub struct JsonBody {
    pub schema: String,
    pub max_bytes: usize,
}

/// The limits the spec states: each operation's `x-semiont-limits`, and `maxItems`.
#[derive(Debug, Clone, Copy)]
pub struct Limits {
    pub heartbeat_seconds: u64,
    pub reply_retention_seconds: u64,
    pub pending_write_bytes: usize,
    pub replay_buffer_events: usize,
    pub claim_seconds: u64,
    pub pending_replies_max: usize,
    pub scoped_max: usize,
}

static SPEC: OnceLock<Spec> = OnceLock::new();

/// The spec, parsed once. Everything in it was checked when the gateway was
/// built, so a failure here is a build that should not exist.
pub fn spec() -> &'static Spec {
    SPEC.get_or_init(|| Spec::parse().unwrap_or_else(|e| panic!("the embedded spec: {e}")))
}

impl Spec {
    fn parse() -> Result<Spec, String> {
        let document: Value = serde_json::from_str(OPENAPI).map_err(|e| e.to_string())?;
        let archivist: Value =
            serde_json::from_str(ARCHIVIST_OPENAPI).map_err(|e| e.to_string())?;
        let schemas: Value = serde_json::from_str(SCHEMAS).map_err(|e| e.to_string())?;
        let validators = jsonschema::options()
            .with_draft(Draft::Draft7)
            .should_validate_formats(true)
            .build_map(&schemas)
            .map_err(|e| e.to_string())?;

        let registry: Value = serde_json::from_str(REGISTRY).map_err(|e| e.to_string())?;
        let mut channel_schemas = HashMap::new();
        for entry in registry["channels"]
            .as_array()
            .ok_or("the registry lists no channels")?
        {
            let channel = entry["channel"]
                .as_str()
                .ok_or("a registry channel has no name")?;
            channel_schemas.insert(
                channel.to_owned(),
                entry["validate"].as_str().map(str::to_owned),
            );
        }
        let mut operations = HashMap::new();
        for op in registry["operations"]
            .as_array()
            .ok_or("the registry lists no operations")?
        {
            let (Some(request), Some(result), Some(failure)) = (
                op["request"].as_str(),
                op["result"].as_str(),
                op["failure"].as_str(),
            ) else {
                return Err(format!("a registry operation is malformed: {op}"));
            };
            operations.insert(
                request.to_owned(),
                Operation {
                    result: result.to_owned(),
                    failure: failure.to_owned(),
                },
            );
        }

        let classification: Value =
            serde_json::from_str(CLASSIFICATION).map_err(|e| e.to_string())?;
        let mut correlated = HashSet::new();
        let mut writes = HashSet::new();
        for (channel, attrs) in classification["channels"]
            .as_object()
            .ok_or("the classification lists no channels")?
        {
            if attrs["delivery"] == "correlated" {
                correlated.insert(channel.clone());
            }
            if attrs["writes"] == true {
                writes.insert(channel.clone());
            }
        }

        let limits = Limits::of(&document)?;
        let json_bodies = JsonBody::of_each(&document)?;
        Ok(Spec {
            document,
            archivist,
            validators,
            channel_schemas,
            operations,
            correlated,
            writes,
            limits,
            json_bodies,
        })
    }

    /// The validator of a component schema; a name the spec does not declare
    /// is a programming error.
    pub fn validator(&self, schema: &str) -> &Validator {
        self.validators
            .get(&format!("#/definitions/{schema}"))
            .unwrap_or_else(|| panic!("the spec declares no schema {schema}"))
    }

    /// Whether the registry declares `channel`, and if so the schema its payload is held to.
    pub fn channel_schema(&self, channel: &str) -> Option<Option<&str>> {
        self.channel_schemas.get(channel).map(Option::as_deref)
    }

    /// The registry operation `channel` is the request of.
    pub fn operation(&self, channel: &str) -> Option<&Operation> {
        self.operations.get(channel)
    }

    /// A reply channel: delivered only to the client whose request it answers.
    pub fn is_correlated(&self, channel: &str) -> bool {
        self.correlated.contains(channel)
    }

    pub fn correlated_channels(&self) -> Vec<String> {
        let mut channels: Vec<String> = self.correlated.iter().cloned().collect();
        channels.sort();
        channels
    }

    /// Emitting `channel` changes the knowledge base.
    pub fn writes(&self, channel: &str) -> bool {
        self.writes.contains(channel)
    }

    pub fn limits(&self) -> Limits {
        self.limits
    }

    /// What `operation` ("POST /bus/emit") accepts as its JSON body, if it takes one.
    pub fn json_body(&self, operation: &str) -> Option<&JsonBody> {
        self.json_bodies.get(operation)
    }

    /// Every operation `document` declares, as (method, path).
    pub fn operations_of(document: &Value) -> Vec<(String, String)> {
        let mut out = Vec::new();
        if let Some(paths) = document["paths"].as_object() {
            for (path, item) in paths {
                let Some(item) = item.as_object() else {
                    continue;
                };
                for method in item.keys().filter(|m| HTTP_METHODS.contains(&m.as_str())) {
                    out.push((method.to_uppercase(), path.clone()));
                }
            }
        }
        out
    }
}

impl JsonBody {
    /// Every operation in `document` that takes a JSON body.
    fn of_each(document: &Value) -> Result<HashMap<String, JsonBody>, String> {
        let mut out = HashMap::new();
        for (method, path) in Spec::operations_of(document) {
            let op = &document["paths"][&path][method.to_lowercase()];
            let json = &op["requestBody"]["content"]["application/json"];
            if json.is_null() {
                continue;
            }
            let operation = format!("{method} {path}");
            let schema = json["schema"]["$ref"]
                .as_str()
                .and_then(|r| r.strip_prefix("#/components/schemas/"))
                .ok_or_else(|| format!("{operation}'s JSON body is not a component schema"))?;
            let max_bytes = op["x-semiont-limits"]["maxBodyBytes"]
                .as_u64()
                .ok_or_else(|| format!("{operation} states no x-semiont-limits.maxBodyBytes"))?;
            out.insert(
                operation,
                JsonBody {
                    schema: schema.to_owned(),
                    max_bytes: max_bytes as usize,
                },
            );
        }
        Ok(out)
    }
}

impl Limits {
    fn of(document: &Value) -> Result<Limits, String> {
        let limit = |path: &str, method: &str, key: &str| -> Result<u64, String> {
            document["paths"][path][method]["x-semiont-limits"][key]
                .as_u64()
                .ok_or_else(|| {
                    format!(
                        "{} {path} states no x-semiont-limits.{key}",
                        method.to_uppercase()
                    )
                })
        };
        let max_items = |property: &str| -> Result<usize, String> {
            document["components"]["schemas"]["BusSubscribeRequest"]["properties"][property]["maxItems"]
                .as_u64()
                .map(|n| n as usize)
                .ok_or_else(|| format!("BusSubscribeRequest.{property} states no maxItems"))
        };
        Ok(Limits {
            heartbeat_seconds: limit("/bus/subscribe", "post", "heartbeatSeconds")?,
            reply_retention_seconds: limit("/bus/subscribe", "post", "replyRetentionSeconds")?,
            pending_write_bytes: limit("/bus/subscribe", "post", "pendingWriteBytes")? as usize,
            replay_buffer_events: limit("/bus/subscribe", "post", "replayBufferEvents")? as usize,
            claim_seconds: limit("/bus/emit", "post", "claimSeconds")?,
            pending_replies_max: max_items("pendingReplies")?,
            scoped_max: max_items("scoped")?,
        })
    }
}

/// Every problem `instance` has against `schema`, as one line: what the 400 says.
pub fn problems(schema: &str, instance: &Value) -> Option<String> {
    let validator = spec().validator(schema);
    let lines: Vec<String> = validator
        .iter_errors(instance)
        .map(|error| {
            let path = error.instance_path().to_string();
            let at = if path.is_empty() {
                "root".to_owned()
            } else {
                path
            };
            format!("{at}: {}", error.masked())
        })
        .collect();
    if lines.is_empty() {
        None
    } else {
        Some(lines.join("; "))
    }
}
