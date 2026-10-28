//! A knowledge base as a client names it.
//!
//! **An address is not an identity.** A `KbTarget` is where to connect: an
//! endpoint, and the labels a host keeps of it. It carries no identity,
//! because which knowledge base answers at an address is known only once it
//! has been reached with a token and asked. A `KnowledgeBase` is a target
//! that has answered: it has the did the knowledge base reported of itself.
//!
//! A did says which knowledge base, not which running copy: a clone and a
//! codespace of one repository are the same knowledge base at two addresses
//! and report one did. So an entry is looked up by its endpoint, and its did
//! is what the answer is verified against. Nothing selects by did.
//!
//! The shapes are the spec's, generated in `crate::types`: `KbTarget`,
//! `NewKnowledgeBase`, `KnowledgeBase`, `KbRead`, and `KbEndpoint` with its
//! two kinds, `HttpEndpoint` and `LocalEndpoint`. What is here is made from
//! them: the gateway's origin, which every SDK makes alike
//! (specs/src/session/gateway-url-cases.json), and what a client asks of an
//! entry.

use crate::rfc3339;
use crate::types::{
    HttpEndpoint, HttpEndpointProtocol, KbDescription, KbEndpoint, KbRead, KbTarget, KnowledgeBase,
};
use std::time::SystemTime;

impl HttpEndpointProtocol {
    /// What a host is reached over when nobody said: `http` on this machine,
    /// `https` anywhere else.
    pub fn of_host(host: &str) -> HttpEndpointProtocol {
        if host == "localhost" || host == "127.0.0.1" {
            HttpEndpointProtocol::Http
        } else {
            HttpEndpointProtocol::Https
        }
    }
}

impl HttpEndpoint {
    /// The gateway's origin: the protocol, the host in lowercase and the
    /// port. Refused when the host is not a host's name: a name a person
    /// typed is never put into a URL unread.
    pub fn gateway_url(&self) -> Result<String, String> {
        if !is_valid_hostname(&self.host) {
            return Err(format!("Invalid KB hostname: \"{}\"", self.host));
        }
        Ok(format!(
            "{}://{}:{}",
            self.protocol.as_str(),
            self.host.to_ascii_lowercase(),
            self.port
        ))
    }

    /// Whether this is the same address: the host and the port. Two
    /// endpoints that differ only in protocol are one place.
    pub fn same_address(&self, other: &HttpEndpoint) -> bool {
        self.host == other.host && self.port == other.port
    }
}

/// Whether `host` is a host's name: labels of letters, digits and hyphens,
/// none beginning or ending with a hyphen, none longer than 63, with dots
/// between them. A dotted address and `localhost` are such names; anything
/// with a slash, a colon or a query in it is not.
pub fn is_valid_hostname(host: &str) -> bool {
    !host.is_empty()
        && host.split('.').all(|label| {
            (1..=63).contains(&label.len())
                && label
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'-')
                && !label.starts_with('-')
                && !label.ends_with('-')
        })
}

impl KbEndpoint {
    pub fn http(&self) -> Option<&HttpEndpoint> {
        match self {
            KbEndpoint::HttpEndpoint(endpoint) => Some(endpoint),
            KbEndpoint::LocalEndpoint(_) => None,
        }
    }

    /// The word that names this kind of endpoint.
    pub const fn kind(&self) -> &'static str {
        match self {
            KbEndpoint::HttpEndpoint(endpoint) => endpoint.kind.as_str(),
            KbEndpoint::LocalEndpoint(endpoint) => endpoint.kind.as_str(),
        }
    }
}

impl KbTarget {
    /// A target at a gateway.
    pub fn http(
        id: &str,
        label: &str,
        host: &str,
        port: u16,
        protocol: HttpEndpointProtocol,
    ) -> KbTarget {
        KbTarget {
            id: id.to_owned(),
            label: label.to_owned(),
            endpoint: KbEndpoint::HttpEndpoint(HttpEndpoint::new(host, port, protocol)),
        }
    }
}

impl KbRead {
    /// What a knowledge base said of itself at `at`, beyond its name. The
    /// time is written as RFC 3339, in UTC, to the millisecond.
    pub fn of(description: &KbDescription, at: SystemTime) -> KbRead {
        KbRead {
            at: rfc3339::to_the_millisecond(at),
            git_branch: description.git_branch.clone(),
        }
    }
}

impl KnowledgeBase {
    /// Where this knowledge base is reached.
    pub fn target(&self) -> KbTarget {
        KbTarget {
            id: self.id.clone(),
            label: self.label.clone(),
            endpoint: self.endpoint.clone(),
        }
    }
}

/// What the credential stored for a knowledge base says, read without
/// asking anyone.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KbSessionStatus {
    /// A token is stored and has not expired.
    Authenticated,
    /// A token is stored and has expired.
    Expired,
    /// Nothing is stored.
    SignedOut,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;
    use std::time::{Duration, UNIX_EPOCH};

    /// specs/src/session/gateway-url-cases.json: the origin every SDK makes
    /// of a gateway's endpoint.
    const GATEWAY_URL_CASES: &str = include_str!("../../specs/session/gateway-url-cases.json");

    #[test]
    fn a_gateways_origin_is_as_the_shared_table_states() {
        let table: Value = serde_json::from_str(GATEWAY_URL_CASES).expect("the table is JSON");
        let cases = table["cases"].as_array().expect("the table has cases");
        assert!(!cases.is_empty());
        for case in cases {
            let why = case["why"].as_str().expect("a case says why");
            let endpoint: HttpEndpoint =
                serde_json::from_value(case["endpoint"].clone()).expect("an HTTP endpoint");
            let expected = match case["origin"].as_str() {
                Some(origin) => Ok(origin.to_owned()),
                None => Err(format!("Invalid KB hostname: \"{}\"", endpoint.host)),
            };
            assert_eq!(endpoint.gateway_url(), expected, "{why}");
        }
    }

    #[test]
    fn a_read_is_written_with_its_time_as_typescript_writes_one() {
        let description: KbDescription = serde_json::from_value(serde_json::json!({
            "name": "A knowledge base",
            "domain": "example.org",
            "gitBranch": "main",
        }))
        .expect("a description");
        let read = KbRead::of(
            &description,
            UNIX_EPOCH + Duration::new(1_800_000_000, 123_456_789),
        );
        assert_eq!(read.at, "2027-01-15T08:00:00.123Z");
        assert_eq!(read.git_branch.as_deref(), Some("main"));
    }
}
