//! A service's configuration document: one JSON file, a schema in the spec,
//! read once at boot and validated against that schema before anything in it
//! is used. Nothing in it is resolved or defaulted here; a document that does
//! not validate stops the service before it serves, naming each failing field
//! by its JSON pointer. A secret is never a value in it: a field names the
//! environment variable that holds one.
//!
//! The documents' types are generated from their schemas (`crate::types`).

use crate::spec::spec;
use jsonschema::error::ValidationErrorKind;
use serde::de::DeserializeOwned;
use serde_json::Value;
use std::fmt;
use std::path::{Path, PathBuf};

/// Which service reads a document, and the schema it answers to: what a
/// refusal names.
pub struct Document {
    pub service: &'static str,
    pub schema: &'static str,
}

/// Why a service would not start on its document.
#[derive(Debug)]
pub enum ConfigError {
    /// No document was named.
    Unnamed(String),
    /// The file could not be read.
    Unreadable(String),
    /// The file is not JSON.
    NotJson(String),
    /// The document does not validate against its schema.
    Invalid(String),
    /// A variable the document names is not set.
    Unset(String),
}

impl fmt::Display for ConfigError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ConfigError::Unnamed(message)
            | ConfigError::Unreadable(message)
            | ConfigError::NotJson(message)
            | ConfigError::Invalid(message)
            | ConfigError::Unset(message) => f.write_str(message),
        }
    }
}

impl std::error::Error for ConfigError {}

/// The path the service's `--config` flag names, as `--config <path>` or
/// `--config=<path>`, among the arguments after the command. There is no
/// default: a path the service guessed would hide the drift between where a
/// deployment put the document and where the service looks.
pub fn path_from_args(
    args: impl IntoIterator<Item = String>,
    document: &Document,
) -> Result<PathBuf, ConfigError> {
    let mut args = args.into_iter();
    while let Some(arg) = args.next() {
        if let Some(path) = arg.strip_prefix("--config=") {
            if !path.is_empty() {
                return Ok(PathBuf::from(path));
            }
        } else if arg == "--config"
            && let Some(path) = args
                .next()
                .filter(|p| !p.is_empty() && !p.starts_with("--"))
        {
            return Ok(PathBuf::from(path));
        }
    }
    Err(ConfigError::Unnamed(format!(
        "The {}'s configuration document is not named: start it with --config <path>",
        document.service
    )))
}

/// The first line that is TOML and cannot be JSON: a table header (`[user]`,
/// `[environments.local.gateway]`) or a `key = value` pair. A parse failure
/// that names it says what the file is, where serde alone says only where it
/// stopped.
fn toml_line(text: &str) -> Option<(usize, &str)> {
    let bare_key = |key: &str| {
        !key.is_empty()
            && key
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.' | '"'))
    };
    text.lines().enumerate().find_map(|(index, line)| {
        let trimmed = line.trim();
        let header = trimmed
            .strip_prefix('[')
            .and_then(|rest| rest.strip_suffix(']'))
            .is_some_and(|name| bare_key(name.trim_matches(|c| c == '[' || c == ']').trim()));
        let pair = trimmed
            .split_once('=')
            .is_some_and(|(key, _)| bare_key(key.trim()));
        (header || pair).then_some((index + 1, trimmed))
    })
}

/// The document at `path`: read, validated against its schema, and only then
/// deserialized into its generated type.
pub fn read<T: DeserializeOwned>(path: &Path, document: &Document) -> Result<T, ConfigError> {
    let Document { service, schema } = document;
    let where_ = path.display();
    let text = std::fs::read_to_string(path).map_err(|e| {
        ConfigError::Unreadable(format!(
            "Cannot read the {service}'s configuration document at {where_} ({e}). The launcher writes it; a {service} started another way is given one ({schema} in specs/)."
        ))
    })?;
    let value: Value = serde_json::from_str(&text).map_err(|e| {
        ConfigError::NotJson(match toml_line(&text) {
            Some((number, line)) => format!(
                "{where_} is not JSON: it looks like TOML (line {number}: `{line}`), a knowledge base's config rather than the {service}'s resolved document ({schema} in specs/, which the launcher writes as JSON): {e}"
            ),
            None => format!("{where_} is not JSON: {e}"),
        })
    })?;
    let refusals: Vec<String> = spec()
        .validator(schema)
        .iter_errors(&value)
        .map(|e| describe(&e))
        .collect();
    if !refusals.is_empty() {
        return Err(refused(path, document, &refusals));
    }
    serde_json::from_value(value).map_err(|e| refused(path, document, &[e.to_string()]))
}

/// A document the service will not start on, each reason on a line of its own.
pub fn refused(path: &Path, document: &Document, refusals: &[String]) -> ConfigError {
    let lines: Vec<String> = refusals.iter().map(|r| format!("  {r}")).collect();
    ConfigError::Invalid(format!(
        "{} is not a {} configuration document ({}):\n{}",
        path.display(),
        document.service,
        document.schema,
        lines.join("\n")
    ))
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
pub fn from_environment(field: &str, name: &str) -> Result<String, ConfigError> {
    match std::env::var(name) {
        Ok(value) if !value.is_empty() => Ok(value),
        _ => Err(ConfigError::Unset(format!(
            "{field} names the environment variable {name}, which is not set"
        ))),
    }
}

/// The service's own account at the issuer, `SEMIONT_OIDC_CLIENT_ID` and
/// `SEMIONT_OIDC_CLIENT_SECRET`: the credential it signs in with, before it
/// asks the gateway for its agent token. Both are required; the refusal names
/// each one missing, and never a value.
pub fn service_account(document: &Document) -> Result<(String, String), ConfigError> {
    let id = std::env::var("SEMIONT_OIDC_CLIENT_ID")
        .ok()
        .filter(|v| !v.is_empty());
    let secret = std::env::var("SEMIONT_OIDC_CLIENT_SECRET")
        .ok()
        .filter(|v| !v.is_empty());
    if let (Some(id), Some(secret)) = (&id, &secret) {
        return Ok((id.clone(), secret.clone()));
    }
    let missing: Vec<&str> = [
        ("SEMIONT_OIDC_CLIENT_ID", id.is_none()),
        ("SEMIONT_OIDC_CLIENT_SECRET", secret.is_none()),
    ]
    .into_iter()
    .filter_map(|(name, absent)| absent.then_some(name))
    .collect();
    let service = document.service;
    Err(ConfigError::Unset(format!(
        "{} not set — this {service} has no service account to sign in with.\n\
         The launcher passes both for each service it starts; a {service} started another way needs the client its realm registers for it (SEMIONT_OIDC_CLIENT_ID=semiont-{service}).",
        missing.join(" and ")
    )))
}
