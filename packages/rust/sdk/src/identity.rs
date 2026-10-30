//! How a knowledge base is named, and the principals who act in it.
//!
//! Every function here is held to a shared case table (tests/tables.rs):
//! `kb_did` and `kb_resource` to specs/src/kb-identity/cases.json, `kind_of`
//! to specs/src/principals/kind-cases.json, the rest to
//! specs/src/principals/cases.json, which Python and Go run too.

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

/// The knowledge base's did: `did:web:` and its domain, verbatim. The domain
/// is already in did:web's colon-path form, so nothing in it is encoded.
pub fn kb_did(domain: &str) -> String {
    format!("did:web:{domain}")
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

/// An agent, named by the subject its issuer asserted for its account, as a
/// person is.
pub fn agent_did(domain: &str, subject: &str) -> String {
    format!("did:web:{domain}:agents:{}", encode_uri_component(subject))
}

/// An engine's name — a provider and a model, which is no principal — as a
/// worker states it of itself unless it says otherwise.
pub fn agent_name(provider: &str, model: &str) -> String {
    format!("{provider} {model}")
}

/// What kind of principal a DID names.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Person,
    Software,
}

/// What kind of principal a DID names, from the DID alone: the last segment
/// that is exactly `users` or `agents`, with a segment after it, says which.
/// A DID with no such segment names a person. What follows the kind segment is
/// the principal's subject, and nothing here reads it.
pub fn kind_of(did: &str) -> Kind {
    let parts: Vec<&str> = did.split(':').collect();
    let before_last = &parts[..parts.len().saturating_sub(1)];
    match before_last
        .iter()
        .rev()
        .find(|part| matches!(**part, "users" | "agents"))
    {
        Some(&"agents") => Kind::Software,
        _ => Kind::Person,
    }
}
