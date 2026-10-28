//! Where the words a model quoted are in a text is one table,
//! specs/src/annotations/reconcile-cases.json, which every SDK runs: this
//! crate's `semiont::annotations::reconcile` answers, for each case's text
//! and quote, what TypeScript's and Python's answer.

use semiont::annotations::{AnchorMethod, QuotedText, ReconciledSpan, reconcile};
use serde_json::{Value, json};

fn table() -> Value {
    serde_json::from_str(include_str!("../specs/annotations/reconcile-cases.json"))
        .expect("the table is JSON")
}

/// What a case says the model quoted.
fn quoted(case: &Value) -> QuotedText {
    let said = |member: &str| case["quoted"][member].as_str().map(str::to_owned);
    QuotedText {
        exact: said("exact").expect("what a model quoted has its words"),
        prefix: said("prefix"),
        suffix: said("suffix"),
    }
}

/// An answer as the table writes one: nothing found is `null`, a prefix or a
/// suffix the text does not have is left out, and which looser search found
/// the span is said only where one did.
fn written(found: Option<&ReconciledSpan>) -> Value {
    let Some(found) = found else {
        return Value::Null;
    };
    let mut answer = json!({
        "start": found.span.start,
        "end": found.span.end,
        "exact": found.span.exact,
        "anchorMethod": found.anchor_method.as_str(),
    });
    let members = answer.as_object_mut().expect("an object");
    if let Some(prefix) = &found.span.prefix {
        members.insert("prefix".to_owned(), json!(prefix));
    }
    if let Some(suffix) = &found.span.suffix {
        members.insert("suffix".to_owned(), json!(suffix));
    }
    if let AnchorMethod::FuzzyMatch(quality) = found.anchor_method {
        members.insert("matchQuality".to_owned(), json!(quality.as_str()));
    }
    answer
}

#[test]
fn every_quote_of_the_table_is_found_where_the_table_says_or_not_at_all() {
    let table = table();
    let cases = table["cases"].as_array().expect("cases");
    assert!(!cases.is_empty());
    for case in cases {
        let why = case["why"].as_str().expect("why");
        let text = case["text"].as_str().expect("text");
        let found = reconcile(text, &quoted(case));
        assert_eq!(written(found.as_ref()), case["reconciled"], "{why}");
    }
}
