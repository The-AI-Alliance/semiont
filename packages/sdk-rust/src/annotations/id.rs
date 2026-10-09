//! The id of an annotation a worker makes.
//!
//! The id is not minted: it is worked out from what the annotation is, so a
//! worker that makes the same annotation again (a job retried, a unit
//! resumed, another worker taking the job over) gives it the same id, and
//! writing it a second time changes nothing. Nothing else goes into it: not
//! when the annotation was made, not what made it, not the job it was made
//! for. specs/src/annotations/id-cases.json holds the rule, for this and for
//! every other implementation.

use crate::types::{AnnotationBodies, AnnotationId, Motivation, ResourceId};
use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use ring::digest::{SHA256, digest};
use serde_json::{Value, json};

/// How many base64url digits of the digest an id is.
const DIGITS: usize = 21;

/// A string as canonical JSON writes it: between double quotes, a double
/// quote and a backslash each after a backslash, the five characters with a
/// short escape as it, every other character below U+0020 as `\u` and four
/// hexadecimal digits in lower case, and every other character as itself.
fn write_string(string: &str, into: &mut String) {
    into.push('"');
    for character in string.chars() {
        match character {
            '"' => into.push_str("\\\""),
            '\\' => into.push_str("\\\\"),
            '\u{8}' => into.push_str("\\b"),
            '\t' => into.push_str("\\t"),
            '\n' => into.push_str("\\n"),
            '\u{c}' => into.push_str("\\f"),
            '\r' => into.push_str("\\r"),
            below if below < '\u{20}' => into.push_str(&format!("\\u{:04x}", u32::from(below))),
            itself => into.push(itself),
        }
    }
    into.push('"');
}

/// A value as canonical JSON writes it: no white space between tokens, an
/// object's members in the order of their names by code point at every
/// depth, an array's items in the order they have.
fn write(value: &Value, into: &mut String) {
    match value {
        Value::Null => into.push_str("null"),
        Value::Bool(true) => into.push_str("true"),
        Value::Bool(false) => into.push_str("false"),
        // A whole number is its decimal digits, and the rule states no other.
        Value::Number(number) => into.push_str(&number.to_string()),
        Value::String(string) => write_string(string, into),
        Value::Array(items) => {
            into.push('[');
            for (nth, item) in items.iter().enumerate() {
                if nth > 0 {
                    into.push(',');
                }
                write(item, into);
            }
            into.push(']');
        }
        Value::Object(members) => {
            // A `str` is ordered by its UTF-8 bytes, which is the order of
            // its code points.
            let mut members: Vec<(&String, &Value)> = members.iter().collect();
            members.sort_unstable_by_key(|(name, _)| *name);
            into.push('{');
            for (nth, (name, member)) in members.into_iter().enumerate() {
                if nth > 0 {
                    into.push(',');
                }
                write_string(name, into);
                into.push(':');
                write(member, into);
            }
            into.push('}');
        }
    }
}

/// The id of what an annotation is, each part as the wire writes it: the
/// first 21 base64url digits of the SHA-256 of its canonical JSON, the
/// `body` left out when the annotation has none.
fn derived_id(resource_id: &str, motivation: &str, anchor: &str, body: Option<&Value>) -> String {
    let mut what = json!({ "resourceId": resource_id, "motivation": motivation, "anchor": anchor });
    if let Some(body) = body {
        what["body"] = body.clone();
    }
    let mut canonical = String::new();
    write(&what, &mut canonical);
    let mut digits = URL_SAFE_NO_PAD.encode(digest(&SHA256, canonical.as_bytes()));
    digits.truncate(DIGITS);
    digits
}

/// The id of the annotation of `motivation` at `anchor` on a resource,
/// saying `body`. The anchor is a string that says where on the resource the
/// annotation is, and is empty for an annotation of the resource as a whole.
pub(crate) fn annotation_id(
    resource_id: &ResourceId,
    motivation: Motivation,
    anchor: &str,
    body: Option<&AnnotationBodies>,
) -> AnnotationId {
    let body = body.map(|body| match serde_json::to_value(body) {
        Ok(written) => written,
        Err(refused) => unreachable!("a body is written as JSON: {refused}"),
    });
    let digits = derived_id(resource_id, motivation.as_str(), anchor, body.as_ref());
    match AnnotationId::new(digits) {
        Ok(id) => id,
        Err(refused) => unreachable!("21 base64url digits are an annotation's id: {refused}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_annotation_of_the_table_has_the_id_the_table_says() {
        let table: Value =
            serde_json::from_str(include_str!("../../specs/annotations/id-cases.json"))
                .expect("the table is JSON");
        let cases = table["cases"].as_array().expect("cases");
        assert!(!cases.is_empty());
        // How many cases were also given as this crate's types: with a body,
        // and with none.
        let (mut with_a_body, mut with_none) = (0, 0);
        for case in cases {
            let why = case["why"].as_str().expect("why");
            let stated = |member: &str| {
                case[member]
                    .as_str()
                    .unwrap_or_else(|| panic!("{why}: no {member}"))
            };
            let body = case.get("body");
            assert_eq!(
                derived_id(
                    stated("resourceId"),
                    stated("motivation"),
                    stated("anchor"),
                    body
                ),
                stated("id"),
                "{why}"
            );

            // A body is any JSON, and a builder is given one as this crate's
            // types. Where those state a case's body whole, the id made
            // from them is the case's too.
            let typed: Option<AnnotationBodies> = match body {
                None => None,
                Some(body) => match serde_json::from_value(body.clone()) {
                    Ok(typed) if serde_json::to_value(&typed).ok().as_ref() == Some(body) => {
                        Some(typed)
                    }
                    _ => continue,
                },
            };
            let resource: ResourceId = stated("resourceId").parse().expect("a resource's id");
            let motivation: Motivation =
                serde_json::from_value(case["motivation"].clone()).expect("a motivation");
            assert_eq!(
                annotation_id(&resource, motivation, stated("anchor"), typed.as_ref()),
                stated("id"),
                "{why}: given as this crate's types"
            );
            match typed {
                Some(_) => with_a_body += 1,
                None => with_none += 1,
            }
        }
        assert!(with_a_body > 0 && with_none > 0);
    }
}
