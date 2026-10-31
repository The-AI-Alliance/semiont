//! How the principals a reply mentions are named, as
//! specs/src/principals/naming-cases.json states it. No stored thing carries
//! a principal's name: a person and an agent are each identified by a DID,
//! and what each last said it is called is its profile.

use semiont_archivist_record::Object;
use serde_json::Value;

/// The types a principal states of itself: a person, or an agent, which the
/// record's W3C vocabulary calls software.
const PRINCIPALS: [&str; 2] = ["Person", "Software"];

/// Give every principal in `value`, wherever it is, the name `profiles`
/// states for its `@id`, in place of any name it carried. A principal with no
/// profile, and every object of another type, is left as it is.
pub(crate) fn name(value: &mut Value, profiles: &Object) {
    match value {
        Value::Array(items) => items.iter_mut().for_each(|item| name(item, profiles)),
        Value::Object(object) => {
            let principal = object
                .get("@type")
                .and_then(Value::as_str)
                .is_some_and(|kind| PRINCIPALS.contains(&kind));
            if principal
                && let Some(called) = object
                    .get("@id")
                    .and_then(Value::as_str)
                    .and_then(|did| profiles.get(did))
                    .and_then(|profile| profile.get("name"))
                    .cloned()
            {
                object.insert("name".into(), called);
            }
            object.values_mut().for_each(|inner| name(inner, profiles));
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::name;
    use serde_json::Value;

    /// A reply is named as specs/src/principals/naming-cases.json states it.
    #[test]
    fn naming_cases() {
        let table: Value = serde_json::from_str(include_str!(
            "../../../specs/src/principals/naming-cases.json"
        ))
        .expect("principals/naming-cases.json is JSON");
        let cases = table["cases"]
            .as_array()
            .expect("principals/naming-cases.json has cases");
        assert!(
            !cases.is_empty(),
            "principals/naming-cases.json has no case"
        );
        for case in cases {
            let why = case["why"].as_str().expect("a case says why");
            let profiles = case["profiles"].as_object().expect("a case has profiles");
            let mut reply = case["reply"].clone();
            name(&mut reply, profiles);
            assert_eq!(reply, case["named"], "{why}");
        }
    }
}
