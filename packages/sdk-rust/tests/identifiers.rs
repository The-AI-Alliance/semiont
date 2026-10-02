//! The kinds of id, held to the cases every SDK runs
//! (specs/src/identifiers/kinds.json): each string a kind accepts makes a
//! value of its type and each it refuses does not, whether a caller makes it
//! or a peer sent it.

use semiont::types::{AnnotationId, InvalidIdentifier, JobId, ResourceId, UserId};
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::{Value, json};
use std::fmt::Debug;
use std::str::FromStr;

/// What `made` does with `text`, as its own constructor and as decoding do.
fn held<T>(kind: &str, pattern: &str, cases: &Value)
where
    T: FromStr<Err = InvalidIdentifier> + DeserializeOwned + Serialize + Debug + AsRef<str>,
{
    for case in cases["accepts"].as_array().expect("accepts") {
        let (text, why) = (case["id"].as_str().expect("id"), &case["why"]);
        let made: T = text
            .parse()
            .unwrap_or_else(|refused| panic!("{kind} accepts {text:?} ({why}): {refused}"));
        assert_eq!(made.as_ref(), text);
        let decoded: T = serde_json::from_value(json!(text))
            .unwrap_or_else(|refused| panic!("{kind} decodes {text:?} ({why}): {refused}"));
        assert_eq!(decoded.as_ref(), text);
        assert_eq!(
            serde_json::to_value(&decoded).expect("it encodes"),
            json!(text)
        );
    }
    for case in cases["refuses"].as_array().expect("refuses") {
        let (text, why) = (case["id"].as_str().expect("id"), &case["why"]);
        let refused = text
            .parse::<T>()
            .expect_err(&format!("{kind} refuses {text:?} ({why})"));
        assert_eq!(
            refused,
            InvalidIdentifier {
                kind: Box::leak(kind.to_owned().into_boxed_str()),
                pattern: Box::leak(pattern.to_owned().into_boxed_str()),
                value: text.to_owned(),
            }
        );
        serde_json::from_value::<T>(json!(text))
            .expect_err(&format!("{kind} does not decode {text:?} ({why})"));
    }
}

#[test]
fn each_kind_of_id_is_held_to_the_cases_every_sdk_runs() {
    let table: Value =
        serde_json::from_str(include_str!("../../../specs/src/identifiers/kinds.json"))
            .expect("kinds.json is JSON");
    let pattern = |kind: &str| -> String {
        let schema = std::fs::read_to_string(format!(
            "{}/../../specs/src/components/schemas/{kind}.json",
            env!("CARGO_MANIFEST_DIR")
        ))
        .expect("the kind's schema");
        serde_json::from_str::<Value>(&schema).expect("JSON")["pattern"]
            .as_str()
            .expect("a pattern")
            .to_owned()
    };
    for kind in table["kinds"].as_array().expect("kinds") {
        let name = kind["schema"].as_str().expect("schema");
        // A kind this does not name is one no test holds: it fails here.
        match name {
            "ResourceId" => {
                assert_eq!(ResourceId::PATTERN, pattern(name));
                held::<ResourceId>(name, ResourceId::PATTERN, kind);
            }
            "AnnotationId" => {
                assert_eq!(AnnotationId::PATTERN, pattern(name));
                held::<AnnotationId>(name, AnnotationId::PATTERN, kind);
            }
            "JobId" => {
                assert_eq!(JobId::PATTERN, pattern(name));
                held::<JobId>(name, JobId::PATTERN, kind);
            }
            "UserId" => {
                assert_eq!(UserId::PATTERN, pattern(name));
                held::<UserId>(name, UserId::PATTERN, kind);
            }
            other => panic!(
                "specs/src/identifiers/kinds.json names {other}, which this test does not hold"
            ),
        }
    }
}

#[test]
fn a_reply_carrying_an_id_its_kind_refuses_does_not_decode() {
    use semiont::types::BeckonFocusEvent;
    let good: BeckonFocusEvent =
        serde_json::from_value(json!({ "annotationId": "a-1", "resourceId": "res-one" }))
            .expect("ids their kinds accept");
    assert_eq!(good.annotation_id.as_deref(), Some("a-1"));
    for bad in ["..", "", "a/b", "https://kb.example/resources/res-one"] {
        serde_json::from_value::<BeckonFocusEvent>(json!({ "resourceId": bad }))
            .expect_err("an id the kind refuses");
    }
}
