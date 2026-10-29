//! Who is behind a recorded resource or annotation: a DID as an agent, and
//! the attribution of something asked for by one and sent by another.

use crate::Object;
use percent_encoding::percent_decode_str;
use serde_json::{Value, json};

fn decoded(part: &str) -> String {
    percent_decode_str(part).decode_utf8_lossy().into_owned()
}

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

/// The agent a DID names: software for `…:agents:<provider>:<model>`, a
/// person otherwise.
pub fn did_to_agent(did: &str) -> Object {
    let mut agent = Object::new();
    if did.is_empty() {
        agent.insert("@type".into(), json!("Person"));
        agent.insert("name".into(), json!("unknown"));
        return agent;
    }
    let parts: Vec<&str> = did.split(':').collect();
    let last = |name: &str| parts.iter().rposition(|part| *part == name);
    let software = last("agents").filter(|at| *at + 3 == parts.len());
    let person = last("users").filter(|at| *at + 2 == parts.len());
    agent.insert(
        "@type".into(),
        json!(if software.is_some() {
            "Software"
        } else {
            "Person"
        }),
    );
    if uri_shaped(did) {
        agent.insert("@id".into(), json!(did));
    }
    if let Some(at) = software {
        let (provider, model) = (decoded(parts[at + 1]), decoded(parts[at + 2]));
        agent.insert("name".into(), json!(format!("{provider} {model}")));
        agent.insert("provider".into(), json!(provider));
        agent.insert("model".into(), json!(model));
    } else if person.is_none() {
        agent.insert("name".into(), json!(decoded(parts[parts.len() - 1])));
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
