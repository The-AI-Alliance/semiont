//! What the gateway reads from the spec for itself: the limits its routes
//! enforce (each operation's `x-semiont-limits`, and `maxItems`), and what each
//! operation that takes JSON accepts.

use semiont_core::spec::{Spec, spec};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::OnceLock;

/// What an operation that takes JSON accepts: the component schema its body
/// must match, and its `x-semiont-limits.maxBodyBytes`.
#[derive(Debug)]
pub struct JsonBody {
    pub schema: String,
    pub max_bytes: usize,
}

/// The limits the spec states: each operation's `x-semiont-limits`, and `maxItems`.
#[derive(Debug)]
pub struct Limits {
    pub heartbeat_seconds: u64,
    pub reply_retention_seconds: u64,
    pub pending_write_bytes: usize,
    pub replay_buffer_events: usize,
    pub claim_seconds: u64,
    pub pending_replies_max: usize,
    pub scoped_max: usize,
    pub streams_per_principal: PrincipalLimit<u64>,
    pub emits_per_principal: PrincipalLimit<EmitRate>,
}

/// A limit on a principal: a baseline, and a coefficient per role (`None`:
/// unlimited). Human or agent makes no difference; only a role does.
#[derive(Debug)]
pub struct PrincipalLimit<C> {
    baseline: C,
    roles: HashMap<String, Option<C>>,
}

/// An emit bucket's coefficient: its refill rate and its depth.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct EmitRate {
    pub per_second: u64,
    pub burst: u64,
}

/// A coefficient that can be compared for generosity.
pub trait Coefficient: Copy {
    fn most_generous(self, other: Self) -> Self;
}

impl Coefficient for u64 {
    fn most_generous(self, other: Self) -> Self {
        self.max(other)
    }
}

impl Coefficient for EmitRate {
    fn most_generous(self, other: Self) -> Self {
        EmitRate {
            per_second: self.per_second.max(other.per_second),
            burst: self.burst.max(other.burst),
        }
    }
}

impl<C: Coefficient> PrincipalLimit<C> {
    /// The coefficient for a principal holding `roles`, `None` when unlimited:
    /// the baseline when it holds none the limit names, else the most
    /// generous of the ones it holds.
    pub fn for_roles(&self, roles: &[String]) -> Option<C> {
        let mut held = roles.iter().filter_map(|role| self.roles.get(role));
        let Some(first) = held.next() else {
            return Some(self.baseline);
        };
        held.fold(*first, |best, next| match (best, *next) {
            (Some(best), Some(next)) => Some(best.most_generous(next)),
            _ => None,
        })
    }
}

struct Gateway {
    limits: Limits,
    /// "METHOD path" → what that operation's JSON body must be.
    json_bodies: HashMap<String, JsonBody>,
}

static GATEWAY: OnceLock<Gateway> = OnceLock::new();

/// Read once from the embedded spec, which was checked when the gateway was built.
fn gateway() -> &'static Gateway {
    GATEWAY.get_or_init(|| {
        let document = &spec().document;
        let read = || -> Result<Gateway, String> {
            Ok(Gateway {
                limits: Limits::of(document)?,
                json_bodies: JsonBody::of_each(document)?,
            })
        };
        read().unwrap_or_else(|e| panic!("the embedded spec: {e}"))
    })
}

pub fn limits() -> &'static Limits {
    &gateway().limits
}

/// What `operation` ("POST /bus/emit") accepts as its JSON body, if it takes one.
pub fn json_body(operation: &str) -> Option<&'static JsonBody> {
    gateway().json_bodies.get(operation)
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

impl<C> PrincipalLimit<C> {
    fn parse(limit: &Value, coefficient: impl Fn(&Value) -> Option<C>) -> Result<Self, String> {
        let baseline = coefficient(&limit["baseline"])
            .ok_or_else(|| format!("a principal limit's baseline is malformed: {limit}"))?;
        let mut roles = HashMap::new();
        if let Some(named) = limit["roles"].as_object() {
            for (role, value) in named {
                let parsed = if value == "unlimited" {
                    None
                } else {
                    Some(coefficient(value).ok_or_else(|| {
                        format!("a principal limit's coefficient for {role} is malformed: {value}")
                    })?)
                };
                roles.insert(role.clone(), parsed);
            }
        }
        Ok(PrincipalLimit { baseline, roles })
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
        let principal = |path: &str, method: &str, key: &str| -> Result<&Value, String> {
            let limit = &document["paths"][path][method]["x-semiont-limits"][key];
            if limit["baseline"].is_null() {
                return Err(format!(
                    "{} {path} states no x-semiont-limits.{key} baseline",
                    method.to_uppercase()
                ));
            }
            Ok(limit)
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
            streams_per_principal: PrincipalLimit::parse(
                principal("/bus/subscribe", "post", "streamsPerPrincipal")?,
                |v| v.as_u64(),
            )?,
            emits_per_principal: PrincipalLimit::parse(
                principal("/bus/emit", "post", "emitsPerPrincipal")?,
                |v| {
                    Some(EmitRate {
                        per_second: v["perSecond"].as_u64()?,
                        burst: v["burst"].as_u64()?,
                    })
                },
            )?,
        })
    }
}
