//! The runners for the shared case tables: the same cases TypeScript and Go
//! run, against the Rust functions that name the knowledge base and its
//! principals.

use semiont::identity;
use serde_json::Value;

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
    let cases = table(include_str!("../../../specs/src/kb-identity/cases.json"));
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
    let cases = table(include_str!("../../../specs/src/principals/cases.json"));
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
