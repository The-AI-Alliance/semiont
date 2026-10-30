//! Who is behind a recorded resource or annotation: a DID as an agent, and
//! the attribution of something asked for by one and sent by another.

use crate::Object;
use semiont::identity::{Kind, kind_of};
use serde_json::{Value, json};

/// Whether `value` reads as a URI: a scheme, a colon, and something after it.
fn uri_shaped(value: &str) -> bool {
    let Some((scheme, rest)) = value.split_once(':') else {
        return false;
    };
    let mut letters = scheme.chars();
    letters.next().is_some_and(|c| c.is_ascii_alphabetic())
        && letters.all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '.' | '-'))
        && rest.chars().next().is_some_and(|c| !c.is_whitespace())
}

/// The agent a DID names: its kind by `kind_of` (held to
/// specs/src/principals/kind-cases.json), and the DID itself when it is a URI.
/// Nothing else is read from a DID: a person's name is filled in when a record
/// is read, and what an agent calls itself, and what it runs, are its own to
/// say.
pub fn did_to_agent(did: &str) -> Object {
    let mut agent = Object::new();
    if did.is_empty() {
        agent.insert("@type".into(), json!("Person"));
        agent.insert("name".into(), json!("unknown"));
        return agent;
    }
    agent.insert(
        "@type".into(),
        json!(match kind_of(did) {
            Kind::Software => "Software",
            Kind::Person => "Person",
        }),
    );
    if uri_shaped(did) {
        agent.insert("@id".into(), json!(did));
    }
    agent
}

/// Who a recorded thing is attributed to.
pub struct Attribution {
    pub creator: Object,
    pub generator: Option<Object>,
    pub was_attributed_to: Vec<Value>,
}

/// The attribution of something `requester` asked for and `executor` sent.
/// A supplied generator says more about the executor, and must be it.
pub fn attribution(
    requester: &str,
    executor: &str,
    supplied: Option<&Object>,
) -> Result<Attribution, String> {
    let creator = did_to_agent(requester);
    let executing = did_to_agent(executor);
    let is_software = executing["@type"] == "Software";
    let generator = match supplied {
        Some(_) if !is_software => {
            return Err(format!(
                "attribution: a generator was supplied, but the executor {executor} is not software"
            ));
        }
        Some(generator) if generator.get("@id") != executing.get("@id") => {
            let named = match generator.get("@id") {
                Some(Value::String(id)) => id.clone(),
                Some(other) => other.to_string(),
                None => "undefined".to_owned(),
            };
            return Err(format!(
                "attribution: generator {named} is not the executor {executor}"
            ));
        }
        Some(generator) => Some(generator.clone()),
        None if is_software => Some(executing.clone()),
        None => None,
    };
    let executor_agent = generator.clone().unwrap_or(executing);
    let was_attributed_to = if creator.get("@id") == executor_agent.get("@id") {
        vec![Value::Object(executor_agent)]
    } else {
        vec![
            Value::Object(creator.clone()),
            Value::Object(executor_agent),
        ]
    };
    Ok(Attribution {
        creator,
        generator,
        was_attributed_to,
    })
}

#[cfg(test)]
mod tests {
    use super::did_to_agent;
    use serde_json::{Value, json};

    /// A DID says who someone is and nothing else: no name, provider or model
    /// is read from it, whatever its segments are.
    #[test]
    fn a_did_names_who_and_nothing_else() {
        for (did, kind) in [
            ("did:web:kb.example:agents:semiont-worker", "Software"),
            ("did:web:kb.example:agents:ollama:gemma2", "Software"),
            ("did:web:kb.example:users:alice%40kb.example", "Person"),
            ("did:web:kb.example:alice", "Person"),
        ] {
            assert_eq!(
                Value::Object(did_to_agent(did)),
                json!({ "@type": kind, "@id": did }),
                "{did}"
            );
        }
        assert_eq!(
            Value::Object(did_to_agent("alice")),
            json!({ "@type": "Person" }),
            "a sender that is no URI has no @id, and is not named by itself"
        );
    }

    /// The record reads a DID's kind as specs/src/principals/kind-cases.json
    /// states it.
    #[test]
    fn kind_cases() {
        let table: Value = serde_json::from_str(include_str!(
            "../../../../specs/src/principals/kind-cases.json"
        ))
        .expect("principals/kind-cases.json is JSON");
        let cases = table["cases"]
            .as_array()
            .expect("principals/kind-cases.json has cases");
        assert!(!cases.is_empty(), "principals/kind-cases.json has no case");
        for case in cases {
            let (did, why) = (
                case["did"].as_str().expect("a case has a did"),
                case["why"].as_str().expect("a case says why"),
            );
            let want = match case["kind"].as_str() {
                Some("person") => "Person",
                Some("software") => "Software",
                other => panic!("{why}: a case names no kind the rule has: {other:?}"),
            };
            assert_eq!(did_to_agent(did)["@type"], want, "{why}");
        }
    }
}
