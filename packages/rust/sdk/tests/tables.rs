//! The runners for the shared case tables: the same cases TypeScript and Go
//! run, against the Rust functions that name the knowledge base and its
//! principals. And what a registry keeps in its storage, held to
//! protocol/specs/src/session/stored.json.

use semiont::identity;
use semiont::refresh::CacheQuery;
use semiont::session::{
    ACTIVE_KEY, KNOWLEDGE_BASES_KEY, LAST_VIEWED_RESOURCE_BY_KB_KEY, OPEN_RESOURCES_BY_KB_KEY,
    OpenResource, StoredSession, cache_key, last_event_id_key, person_key, session_key,
};
use semiont::testing::as_id;
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
        assert_eq!(
            identity::kind_of(&did),
            identity::Kind::Person,
            "{why}: a person's DID read as software"
        );
    }
    for case in agents {
        let (why, did) = (text(case, "why"), text(case, "did"));
        assert_eq!(
            identity::agent_did(&text(case, "domain"), &text(case, "subject")),
            did,
            "{why}"
        );
        assert_eq!(
            identity::kind_of(&did),
            identity::Kind::Software,
            "{why}: an agent's DID read as a person"
        );
    }
}

/// A case's kind, as the table names it.
fn kind(case: &Value) -> identity::Kind {
    match text(case, "kind").as_str() {
        "person" => identity::Kind::Person,
        "software" => identity::Kind::Software,
        other => panic!("a case names no kind the rule has: {other}"),
    }
}

#[test]
fn kind_cases() {
    let cases = table(include_str!("../specs/principals/kind-cases.json"));
    let cases = cases["cases"]
        .as_array()
        .expect("principals/kind-cases.json has cases");
    assert!(!cases.is_empty(), "principals/kind-cases.json has no case");
    for case in cases {
        assert_eq!(
            identity::kind_of(&text(case, "did")),
            kind(case),
            "{}",
            text(case, "why")
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
        person_key: Some("a-person-key".to_owned()),
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

/// The query the table names, as this SDK names it.
fn query_named(name: &str) -> CacheQuery {
    *CacheQuery::ALL
        .iter()
        .find(|query| query.name() == name)
        .unwrap_or_else(|| panic!("no query of client/refresh.json is named {name}"))
}

/// An object's members, sorted.
fn members_of(object: &Value) -> Vec<String> {
    let mut members: Vec<String> = object
        .as_object()
        .unwrap_or_else(|| panic!("not an object: {object}"))
        .keys()
        .cloned()
        .collect();
    members.sort();
    members
}

/// What a session keeps of one person: each prefix the table states, and
/// the key its example works out, are the ones Rust makes, and each query
/// client/refresh.json marks `persisted` is kept under its prefix, the
/// knowledge base's id, the person's key and the query's name.
#[test]
fn what_is_kept_of_a_person_is_kept_under_the_tables_keys() {
    let stored = table(include_str!("../specs/session/stored.json"));
    let refresh = table(include_str!("../specs/client/refresh.json"));

    let places = &stored["lastEventIdKeyPrefix"];
    assert_eq!(
        last_event_id_key("kb-a", "a-person-key"),
        format!("{}kb-a.a-person-key", text(places, "prefix")),
        "a stream's places' key"
    );
    let example = &places["example"];
    assert_eq!(members_of(example), ["did", "kbId", "key"]);
    assert_eq!(
        last_event_id_key(&text(example, "kbId"), &person_key(&text(example, "did"))),
        text(example, "key"),
        "lastEventIdKeyPrefix's example"
    );

    let caches = &stored["cacheKeyPrefix"];
    let kept: Vec<&Value> = refresh["queries"]
        .as_array()
        .expect("client/refresh.json states its queries")
        .iter()
        .filter(|row| row["persisted"] == Value::Bool(true))
        .collect();
    assert!(!kept.is_empty(), "client/refresh.json persists no query");
    for row in kept {
        let name = text(row, "name");
        assert_eq!(
            cache_key("kb-a", "a-person-key", query_named(&name)),
            format!("{}kb-a.a-person-key.{name}", text(caches, "prefix")),
            "a kept query's key"
        );
    }
    let example = &caches["example"];
    assert_eq!(members_of(example), ["did", "kbId", "key", "query"]);
    assert_eq!(
        cache_key(
            &text(example, "kbId"),
            &person_key(&text(example, "did")),
            query_named(&text(example, "query")),
        ),
        text(example, "key"),
        "cacheKeyPrefix's example"
    );
}

/// The members of what `resource` is written as, in order.
fn written_members(resource: &OpenResource) -> Vec<String> {
    let written = serde_json::to_value(resource).expect("an open resource writes");
    let mut members: Vec<String> = written
        .as_object()
        .expect("an open resource writes an object")
        .keys()
        .cloned()
        .collect();
    members.sort();
    members
}

/// An open resource is written, as a registry writes the list it keeps
/// under `openResourcesByKbKey`, with every member the table names when all
/// of them are known, and with only the ones it requires when no more are;
/// and one stored without a member the table requires is none. A member the
/// table gains, or a change to what it requires, fails here until Rust has
/// it.
#[test]
fn an_open_resource_is_kept_as_the_table_states() {
    let stored = table(include_str!("../specs/session/stored.json"));
    let schema = &stored["openResource"];
    let mut members: Vec<String> = schema["properties"]
        .as_object()
        .expect("an open resource has properties")
        .keys()
        .cloned()
        .collect();
    members.sort();
    let mut required: Vec<String> = schema["required"]
        .as_array()
        .expect("an open resource requires members")
        .iter()
        .map(|member| {
            member
                .as_str()
                .expect("a required member is named")
                .to_owned()
        })
        .collect();
    required.sort();

    let whole = OpenResource {
        id: as_id("r1"),
        name: "One".to_owned(),
        opened_at: 1,
        order: 0,
        media_type: Some("text/markdown".to_owned()),
        storage_uri: Some("file://docs/one.md".to_owned()),
    };
    let bare = OpenResource {
        media_type: None,
        storage_uri: None,
        ..whole.clone()
    };
    assert_eq!(
        written_members(&whole),
        members,
        "an open resource's members"
    );
    assert_eq!(
        written_members(&bare),
        required,
        "the members of an open resource of which no more is known"
    );

    let written = serde_json::to_value(&whole).expect("an open resource writes");
    for left in &members {
        let mut without = written.clone();
        without
            .as_object_mut()
            .expect("an open resource writes an object")
            .remove(left);
        let read = serde_json::from_value::<OpenResource>(without);
        assert_eq!(
            read.is_err(),
            required.contains(left),
            "an open resource stored without {left}"
        );
    }
}
