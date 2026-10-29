//! The runners for the shared case tables: the same cases TypeScript and Go
//! run, against the Rust functions that name the knowledge base and its
//! principals. And what a registry keeps in its storage, held to
//! specs/src/session/stored.json.

use semiont::identity;
use semiont::session::{
    ACTIVE_KEY, KNOWLEDGE_BASES_KEY, LAST_VIEWED_RESOURCE_BY_KB_KEY, OPEN_RESOURCES_BY_KB_KEY,
    StoredSession, session_key,
};
use serde_json::{Map, Value};
use std::collections::BTreeMap;

fn table(text: &str) -> Value {
    serde_json::from_str(text).expect("the table is JSON")
}

fn text(case: &Value, key: &str) -> String {
    case[key]
        .as_str()
        .unwrap_or_else(|| panic!("a case has no string {key}: {case}"))
        .to_owned()
}

#[test]
fn kb_identity_cases() {
    let cases = table(include_str!("../specs/kb-identity/cases.json"));
    let mut checked = 0;
    for case in cases["cases"]
        .as_array()
        .expect("kb-identity/cases.json has cases")
    {
        let Some(domain) = case["domain"].as_str() else {
            continue;
        };
        assert_eq!(
            identity::kb_resource(domain),
            text(case, "resource"),
            "{}",
            case["why"]
        );
        assert_eq!(
            identity::kb_did(domain),
            text(case, "did"),
            "{}",
            case["why"]
        );
        checked += 1;
    }
    assert!(
        checked > 0,
        "kb-identity/cases.json has no case with a domain"
    );
}

#[test]
fn principal_cases() {
    let cases = table(include_str!("../specs/principals/cases.json"));
    let people = cases["people"]
        .as_array()
        .expect("principals/cases.json has people");
    let agents = cases["agents"]
        .as_array()
        .expect("principals/cases.json has agents");
    assert!(
        !people.is_empty() && !agents.is_empty(),
        "principals/cases.json needs people and agents"
    );
    for case in people {
        let (why, did) = (text(case, "why"), text(case, "did"));
        assert_eq!(
            identity::person_did(&text(case, "domain"), &text(case, "subject")),
            did,
            "{why}"
        );
        assert!(
            !identity::names_software(&did),
            "{why}: a person's DID read as software"
        );
    }
    for case in agents {
        let (why, did) = (text(case, "why"), text(case, "did"));
        let (domain, provider, model) = (
            text(case, "domain"),
            text(case, "provider"),
            text(case, "model"),
        );
        assert_eq!(
            identity::agent_did(&domain, &provider, &model),
            did,
            "{why}"
        );
        assert_eq!(
            identity::agent_address(&domain, &provider, &model),
            text(case, "email"),
            "{why}"
        );
        assert_eq!(
            identity::agent_name(&provider, &model),
            text(case, "name"),
            "{why}"
        );
        assert!(
            identity::names_software(&did),
            "{why}: an agent's DID read as a person"
        );
    }
}

/// The keys this crate states by hand, by the name the table gives each.
/// `pendingAuthorizationKey` is the transport crate's, and its tests hold its
/// value.
const KEYS: [(&str, &str); 4] = [
    ("knowledgeBasesKey", KNOWLEDGE_BASES_KEY),
    ("activeKey", ACTIVE_KEY),
    ("openResourcesByKbKey", OPEN_RESOURCES_BY_KB_KEY),
    ("lastViewedResourceByKbKey", LAST_VIEWED_RESOURCE_BY_KB_KEY),
];

/// A key or a member the table gains fails here until Rust has it.
#[test]
fn what_a_registry_keeps_is_the_tables() {
    let stored = table(include_str!("../specs/session/stored.json"));
    let keys: BTreeMap<String, String> = stored["keys"]
        .as_array()
        .expect("stored.json has keys")
        .iter()
        .map(|entry| (text(entry, "member"), text(entry, "key")))
        .collect();
    let mut known: Vec<&str> = KEYS
        .iter()
        .map(|(member, _)| *member)
        .chain(["pendingAuthorizationKey"])
        .collect();
    known.sort_unstable();
    assert_eq!(
        keys.keys().map(String::as_str).collect::<Vec<_>>(),
        known,
        "the table's keys are the ones Rust states"
    );
    for (member, key) in KEYS {
        assert_eq!(keys[member], key, "{member}");
    }

    assert_eq!(
        session_key("kb-a"),
        format!("{}kb-a", text(&stored["sessionKeyPrefix"], "prefix")),
        "a knowledge base's session key"
    );

    let schema = &stored["storedSession"];
    let members: Vec<String> = schema["properties"]
        .as_object()
        .expect("the stored session has properties")
        .keys()
        .cloned()
        .collect();
    let required: Vec<&str> = schema["required"]
        .as_array()
        .expect("the stored session requires members")
        .iter()
        .map(|member| member.as_str().expect("a required member is named"))
        .collect();

    let whole = StoredSession {
        access: "a".to_owned(),
        refresh: "r".to_owned(),
        client_id: "semiont-browser".to_owned(),
        token_endpoint: "https://issuer.test/token".to_owned(),
        revocation_endpoint: Some("https://issuer.test/revoke".to_owned()),
    };
    let written: Map<String, Value> =
        serde_json::from_str(&whole.written()).expect("a session writes an object");
    let mut written_members: Vec<&String> = written.keys().collect();
    let mut table_members: Vec<&String> = members.iter().collect();
    written_members.sort();
    table_members.sort();
    assert_eq!(written_members, table_members, "a stored session's members");

    for left in &members {
        let without: Map<String, Value> = members
            .iter()
            .filter(|member| *member != left)
            .map(|member| (member.clone(), Value::String(format!("the {member}"))))
            .collect();
        let read = StoredSession::read(&Value::Object(without).to_string());
        assert_eq!(
            read.is_none(),
            required.contains(&left.as_str()),
            "a stored value without {left}"
        );
    }
}
