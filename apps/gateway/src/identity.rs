//! How the gateway names the knowledge base and the principals it acts for.
//!
//! Every function here is held to a shared case table that TypeScript and Go
//! run too: `kb_resource` to specs/src/kb-identity/cases.json, the rest to
//! specs/src/principals/cases.json (tests/tables.rs).

use percent_encoding::{AsciiSet, NON_ALPHANUMERIC, utf8_percent_encode};

/// What ECMAScript's `encodeURIComponent` leaves alone: A–Z a–z 0–9 and `-_.!~*'()`.
const URI_COMPONENT: &AsciiSet = &NON_ALPHANUMERIC
    .remove(b'-')
    .remove(b'_')
    .remove(b'.')
    .remove(b'!')
    .remove(b'~')
    .remove(b'*')
    .remove(b'\'')
    .remove(b'(')
    .remove(b')');

/// Each UTF-8 byte of every other character as `%XX`, uppercase hex.
pub fn encode_uri_component(value: &str) -> String {
    utf8_percent_encode(value, URI_COMPONENT).to_string()
}

/// The knowledge base's resource identifier, the audience its tokens carry:
/// its did:web resolved to an https URL, the colon path a slash path.
pub fn kb_resource(domain: &str) -> String {
    format!("https://{}", domain.replace(':', "/"))
}

/// A person, named by the subject the issuer asserted.
pub fn person_did(domain: &str, subject: &str) -> String {
    format!("did:web:{domain}:users:{}", encode_uri_component(subject))
}

/// A software agent: one per (provider, model) under the knowledge base's domain.
pub fn agent_did(domain: &str, provider: &str, model: &str) -> String {
    format!(
        "did:web:{domain}:agents:{}:{}",
        encode_uri_component(provider),
        encode_uri_component(model)
    )
}

/// An agent's address: `<provider>:<model>` with every run of characters
/// outside `[A-Za-z0-9-]` one hyphen and none at either end, at
/// `agents.<the domain up to its first colon>`.
pub fn agent_address(domain: &str, provider: &str, model: &str) -> String {
    let host = domain.split(':').next().unwrap_or(domain);
    let mut slug = String::new();
    for c in format!("{provider}:{model}").chars() {
        let c = if c.is_ascii_alphanumeric() { c } else { '-' };
        if !(c == '-' && slug.ends_with('-')) {
            slug.push(c);
        }
    }
    format!("{}@agents.{host}", slug.trim_matches('-'))
}

/// An agent's name.
pub fn agent_name(provider: &str, model: &str) -> String {
    format!("{provider} {model}")
}

/// Whether a DID names a software agent: its kind segment, read from the
/// right past any `host:port` colons, is `agents` with a provider and model
/// after it. Anything else names a person.
pub fn names_software(did: &str) -> bool {
    let parts: Vec<&str> = did.split(':').collect();
    matches!(
        (parts.iter().rposition(|p| *p == "agents"), parts.len().checked_sub(3)),
        (Some(at), Some(expected)) if at == expected
    )
}
