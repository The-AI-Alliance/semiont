//! The gateway's configuration: one document, `GatewayConfig` in the spec,
//! read once at boot from `~/.semiontconfig` and validated against the spec's
//! own schema before anything in it is used. Nothing in it is resolved or
//! defaulted here; a document that does not validate stops the process before
//! it serves, naming each failing field by its JSON pointer.

use crate::spec::spec;
use jsonschema::error::ValidationErrorKind;
use serde::Deserialize;
use serde_json::Value;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone)]
pub struct GatewayConfig {
    pub kb: Kb,
    pub port: u16,
    pub public_url: String,
    pub identity: Identity,
    pub archivist: ArchivistAddress,
    pub signal: SignalConfig,
    pub log_level: LogLevel,
    pub log_format: LogFormat,
    pub capacity: Capacity,
}

/// What this process can hold (`capacity`): the bytes queued for all its
/// streams, and the connections it holds open.
#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Capacity {
    pub queued_bytes: usize,
    pub connections: usize,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Kb {
    pub name: String,
    pub domain: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Identity {
    pub issuer: String,
    pub subject_claim: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ArchivistAddress {
    pub host: String,
    pub port: u16,
}

/// The signal plane, with the one rule the schema cannot state made a type: a NATS plane has servers.
#[derive(Debug, Clone)]
pub enum SignalConfig {
    InProcess,
    Nats {
        servers: String,
        user_env: Option<String>,
        password_env: Option<String>,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LogLevel {
    Error,
    Warn,
    Info,
    Http,
    Debug,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LogFormat {
    Json,
    Simple,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Document {
    kb: Kb,
    port: u16,
    public_url: String,
    identity: Identity,
    archivist: ArchivistAddress,
    signal: SignalDocument,
    log_level: LogLevel,
    log_format: LogFormat,
    capacity: Capacity,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SignalDocument {
    #[serde(rename = "type")]
    kind: String,
    servers: Option<String>,
    user_env: Option<String>,
    password_env: Option<String>,
}

/// `~/.semiontconfig`, home being the runtime's.
pub fn config_path() -> Result<PathBuf, String> {
    std::env::home_dir()
        .map(|home| home.join(".semiontconfig"))
        .ok_or_else(|| "The gateway has no home directory, so it has no configuration document at ~/.semiontconfig.".to_owned())
}

pub fn read_gateway_config(path: &Path) -> Result<GatewayConfig, String> {
    let where_ = path.display();
    let text = std::fs::read_to_string(path).map_err(|e| {
        format!(
            "Cannot read the gateway's configuration document at {where_} ({e}). The launcher writes it; a gateway started another way is given one (GatewayConfig in specs/)."
        )
    })?;
    let document: Value =
        serde_json::from_str(&text).map_err(|e| format!("{where_} is not JSON: {e}"))?;
    let refusals: Vec<String> = spec()
        .validator("GatewayConfig")
        .iter_errors(&document)
        .map(|e| describe(&e))
        .collect();
    if !refusals.is_empty() {
        return Err(refused(path, &refusals));
    }
    let document: Document =
        serde_json::from_value(document).map_err(|e| refused(path, &[e.to_string()]))?;
    let signal = match (document.signal.kind.as_str(), document.signal.servers) {
        ("in-process", _) => SignalConfig::InProcess,
        ("nats", Some(servers)) => SignalConfig::Nats {
            servers,
            user_env: document.signal.user_env,
            password_env: document.signal.password_env,
        },
        ("nats", None) => {
            return Err(refused(
                path,
                &[
                    "/signal is missing servers: a nats plane needs its broker's address"
                        .to_owned(),
                ],
            ));
        }
        (other, _) => {
            return Err(refused(
                path,
                &[format!("/signal/type {other} is not a plane")],
            ));
        }
    };
    Ok(GatewayConfig {
        kb: document.kb,
        port: document.port,
        public_url: document.public_url,
        identity: document.identity,
        archivist: document.archivist,
        signal,
        log_level: document.log_level,
        log_format: document.log_format,
        capacity: document.capacity,
    })
}

fn refused(path: &Path, refusals: &[String]) -> String {
    let lines: Vec<String> = refusals.iter().map(|r| format!("  {r}")).collect();
    format!(
        "{} is not a gateway configuration document (GatewayConfig):\n{}",
        path.display(),
        lines.join("\n")
    )
}

fn describe(error: &jsonschema::ValidationError<'_>) -> String {
    let path = error.instance_path().to_string();
    let where_ = if path.is_empty() {
        "/".to_owned()
    } else {
        path
    };
    match error.kind() {
        ValidationErrorKind::Required { property } => {
            format!(
                "{where_} is missing {}",
                property
                    .as_str()
                    .map(str::to_owned)
                    .unwrap_or_else(|| property.to_string())
            )
        }
        ValidationErrorKind::AdditionalProperties { unexpected } => {
            format!("{where_} does not declare {}", unexpected.join(", "))
        }
        _ => format!("{where_} {}", error.masked()),
    }
}

/// The value of the environment variable a document field names; absence refuses.
pub fn from_environment(field: &str, name: &str) -> Result<String, String> {
    match std::env::var(name) {
        Ok(value) if !value.is_empty() => Ok(value),
        _ => Err(format!(
            "{field} names the environment variable {name}, which is not set"
        )),
    }
}
