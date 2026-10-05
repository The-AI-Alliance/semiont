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

use crate::types::KbDescription;
use serde::{Deserialize, Serialize};
use std::time::SystemTime;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Protocol {
    Http,
    Https,
}

impl Protocol {
    pub const fn as_str(self) -> &'static str {
        match self {
            Protocol::Http => "http",
            Protocol::Https => "https",
        }
    }

    /// What a host is reached over when nobody said: `http` on this machine,
    /// `https` anywhere else.
    pub fn of_host(host: &str) -> Protocol {
        if host == "localhost" || host == "127.0.0.1" {
            Protocol::Http
        } else {
            Protocol::Https
        }
    }
}

/// A gateway reached over HTTP.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct HttpEndpoint {
    pub host: String,
    pub port: u16,
    pub protocol: Protocol,
}

impl HttpEndpoint {
    /// The gateway's origin. Refused when the host is not a host's name: a
    /// name a person typed is never put into a URL unread.
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

/// How a knowledge base is reached. Only what builds a transport reads it.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum KbEndpoint {
    /// A remote gateway.
    Http(HttpEndpoint),
}

impl KbEndpoint {
    pub fn http(&self) -> &HttpEndpoint {
        match self {
            KbEndpoint::Http(endpoint) => endpoint,
        }
    }
}

/// Where to connect: a session's whole input.
///
/// `id` is the key a session's credentials are stored under. Two sessions
/// sharing one storage must use two ids, or each overwrites the other's
/// tokens. None is made up here: whoever builds the target chooses it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KbTarget {
    pub id: String,
    pub label: String,
    pub endpoint: KbEndpoint,
}

impl KbTarget {
    /// A target at a gateway.
    pub fn http(id: &str, label: &str, host: &str, port: u16, protocol: Protocol) -> KbTarget {
        KbTarget {
            id: id.to_owned(),
            label: label.to_owned(),
            endpoint: KbEndpoint::Http(HttpEndpoint {
                host: host.to_owned(),
                port,
                protocol,
            }),
        }
    }
}

/// When a knowledge base last described itself, and what it said beyond its
/// name. A host shows it as current only while a session to the knowledge
/// base is live, and as of `at` otherwise.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KbRead {
    /// When the answer arrived.
    pub at: SystemTime,
    /// The working tree's branch then; none when it was not a git checkout.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub git_branch: Option<String>,
}

impl KbRead {
    pub fn of(description: &KbDescription, at: SystemTime) -> KbRead {
        KbRead {
            at,
            git_branch: description.git_branch.clone(),
        }
    }
}

/// A registered knowledge base: a target, and the identity the knowledge
/// base reported. Its `did` is never changed, and its `label` and
/// `last_read` are written only from an answer that carried that did.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeBase {
    pub id: String,
    pub label: String,
    pub did: String,
    pub endpoint: KbEndpoint,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_read: Option<KbRead>,
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

/// A knowledge base to register: everything but the id, which the registry
/// makes. It has a did, because registration follows a sign-in: the
/// knowledge base has already said what it is.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewKnowledgeBase {
    pub label: String,
    pub did: String,
    pub endpoint: KbEndpoint,
    pub last_read: Option<KbRead>,
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
    use std::time::{Duration, UNIX_EPOCH};

    #[test]
    fn a_hosts_name_is_labels_of_letters_digits_and_hyphens() {
        for host in ["localhost", "127.0.0.1", "kb.example.org", "a-b.c", "x"] {
            assert!(is_valid_hostname(host), "{host}");
        }
        for host in [
            "",
            "kb.example.org/path",
            "kb:4000",
            "kb?x=1",
            "-kb.org",
            "kb-.org",
            "kb..org",
            "a b",
            &"x".repeat(64),
        ] {
            assert!(!is_valid_hostname(host), "{host}");
        }
    }

    #[test]
    fn a_gateways_url_is_its_protocol_its_host_in_lowercase_and_its_port() {
        let at = |host: &str| HttpEndpoint {
            host: host.to_owned(),
            port: 4000,
            protocol: Protocol::of_host(host),
        };
        assert_eq!(
            at("localhost").gateway_url(),
            Ok("http://localhost:4000".to_owned())
        );
        assert_eq!(
            at("KB.Example.org").gateway_url(),
            Ok("https://kb.example.org:4000".to_owned())
        );
        assert_eq!(
            at("evil.example/x").gateway_url(),
            Err("Invalid KB hostname: \"evil.example/x\"".to_owned())
        );
    }

    #[test]
    fn a_registered_knowledge_base_is_stored_and_read_back_as_it_was() {
        let kb = KnowledgeBase {
            id: "kb-1".to_owned(),
            label: "A knowledge base".to_owned(),
            did: "did:web:example.org:kb".to_owned(),
            endpoint: KbEndpoint::Http(HttpEndpoint {
                host: "localhost".to_owned(),
                port: 4000,
                protocol: Protocol::Http,
            }),
            last_read: Some(KbRead {
                at: UNIX_EPOCH + Duration::new(1_800_000_000, 123_456_789),
                git_branch: Some("main".to_owned()),
            }),
        };
        let stored = serde_json::to_value(&kb).expect("it serializes");
        assert_eq!(
            stored,
            serde_json::json!({
                "id": "kb-1", "label": "A knowledge base", "did": "did:web:example.org:kb",
                "endpoint": { "kind": "http", "host": "localhost", "port": 4000, "protocol": "http" },
                "lastRead": {
                    "at": { "secs_since_epoch": 1_800_000_000u64, "nanos_since_epoch": 123_456_789 },
                    "gitBranch": "main",
                },
            })
        );
        assert_eq!(
            serde_json::from_value::<KnowledgeBase>(stored).ok(),
            Some(kb)
        );
    }
}
