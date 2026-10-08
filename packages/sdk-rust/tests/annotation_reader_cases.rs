//! What each annotation reader answers is one table,
//! specs/src/annotations/reader-cases.json, which every SDK runs: this
//! crate's `semiont::annotations` gives, for each case's annotation, what
//! TypeScript's and Python's readers give.

use semiont::annotations::{
    annotation_exact_text, body_source, comment_text, entity_types, exact_text, is_assessment,
    is_body_resolved, is_comment, is_highlight, is_reference, is_resolved_reference,
    is_stub_reference, is_tag, tag_category, tag_schema_id, target_selector, target_source,
    text_quote_selector,
};
use semiont::types::Annotation;
use serde_json::{Value, json};

fn table() -> Value {
    serde_json::from_str(include_str!("../specs/annotations/reader-cases.json"))
        .expect("the table is JSON")
}

/// What the reader the table calls `reader` gives for `annotation`, as the
/// table writes an answer: nothing is `null`. `None` for a name that is no
/// reader here.
fn read(reader: &str, annotation: &Annotation) -> Option<Value> {
    let body = annotation.body.as_ref();
    let selector = target_selector(&annotation.target);
    Some(match reader {
        "bodySource" => json!(body_source(body)),
        "isBodyResolved" => json!(is_body_resolved(body)),
        "targetSource" => json!(target_source(&annotation.target)),
        "targetSelector" => json!(selector),
        "isHighlight" => json!(is_highlight(annotation)),
        "isReference" => json!(is_reference(annotation)),
        "isAssessment" => json!(is_assessment(annotation)),
        "isComment" => json!(is_comment(annotation)),
        "isTag" => json!(is_tag(annotation)),
        "commentText" => json!(comment_text(annotation)),
        "isStubReference" => json!(is_stub_reference(annotation)),
        "isResolvedReference" => json!(is_resolved_reference(annotation)),
        "exactText" => json!(exact_text(selector)),
        "annotationExactText" => json!(annotation_exact_text(annotation)),
        "textQuoteSelector" => json!(text_quote_selector(
            selector.expect("the table gives textQuoteSelector a selector to read")
        )),
        "entityTypes" => json!(entity_types(annotation)),
        "tagCategory" => json!(tag_category(annotation)),
        "tagSchemaId" => json!(tag_schema_id(annotation)),
        _ => return None,
    })
}

/// Whether two JSON values say the same thing. A number is the number it is,
/// however it was written: an offset this crate holds as `4.0` is the
/// table's `4`.
fn same(ours: &Value, theirs: &Value) -> bool {
    match (ours, theirs) {
        (Value::Number(a), Value::Number(b)) => a.as_f64() == b.as_f64(),
        (Value::Array(a), Value::Array(b)) => {
            a.len() == b.len() && a.iter().zip(b).all(|(a, b)| same(a, b))
        }
        (Value::Object(a), Value::Object(b)) => {
            a.len() == b.len()
                && a.iter()
                    .all(|(name, value)| b.get(name).is_some_and(|other| same(value, other)))
        }
        _ => ours == theirs,
    }
}

#[test]
fn there_is_a_reader_here_for_each_the_table_names() {
    let table = table();
    let annotation: Annotation =
        serde_json::from_value(table["cases"][0]["annotation"].clone()).expect("an annotation");
    for reader in table["readers"].as_array().expect("readers") {
        let reader = reader.as_str().expect("a name");
        assert!(
            read(reader, &annotation).is_some(),
            "the table names {reader}, which is no reader here"
        );
    }
    assert_eq!(table["readers"].as_array().map(Vec::len), Some(18));
}

#[test]
fn every_reader_gives_what_the_table_says_for_every_annotation() {
    let table = table();
    let readers: Vec<&str> = table["readers"]
        .as_array()
        .expect("readers")
        .iter()
        .map(|reader| reader.as_str().expect("a name"))
        .collect();
    for case in table["cases"].as_array().expect("cases") {
        let why = case["why"].as_str().expect("why");
        let annotation: Annotation = serde_json::from_value(case["annotation"].clone())
            .unwrap_or_else(|refused| panic!("{why}: its annotation does not decode: {refused}"));
        let reads = case["reads"].as_object().expect("reads");
        // Every case states every reader, but the quote selector where the
        // target has no selector to give it.
        let applies: Vec<&str> = readers
            .iter()
            .copied()
            .filter(|reader| {
                *reader != "textQuoteSelector" || target_selector(&annotation.target).is_some()
            })
            .collect();
        let mut stated: Vec<&str> = reads.keys().map(String::as_str).collect();
        stated.sort_unstable();
        let mut expected = applies.clone();
        expected.sort_unstable();
        assert_eq!(stated, expected, "{why}");
        for (reader, answer) in reads {
            let given = read(reader, &annotation).expect("a reader the table names");
            assert!(
                same(&given, answer),
                "{why}: {reader} gave {given}, and the table says {answer}"
            );
        }
    }
}
