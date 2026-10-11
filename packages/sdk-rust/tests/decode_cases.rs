//! What text a resource's bytes are is one table,
//! specs/src/text/decode-cases.json, which every reader of a resource's text
//! runs. A worker reads a resource's text with `browse.resource_content` and
//! counts its offsets in what that gives, so each case is read through a
//! client, from bytes its content transport serves with the case's content
//! type. This crate's tests have the `charsets` feature, without which every
//! charset but UTF-8 is refused.

use semiont::errors::{SemiontError, TransportErrorCode};
use semiont::testing::{InMemoryContent, TestClientOptions, as_id, create_test_client};
use semiont::transport::Content;
use serde_json::Value;

fn cases() -> Vec<Value> {
    let table: Value = serde_json::from_str(include_str!("../specs/text/decode-cases.json"))
        .expect("the table is JSON");
    table["cases"].as_array().expect("cases").clone()
}

fn stated<'a>(case: &'a Value, key: &str) -> &'a str {
    case[key]
        .as_str()
        .unwrap_or_else(|| panic!("a case states no {key}: {case}"))
}

/// The bytes a case writes in hexadecimal, two digits to a byte.
fn bytes_of(case: &Value) -> Vec<u8> {
    stated(case, "bytes")
        .split_whitespace()
        .map(|byte| {
            assert_eq!(byte.len(), 2, "{byte} is not two digits: {case}");
            u8::from_str_radix(byte, 16).unwrap_or_else(|_| panic!("{byte} is not a byte: {case}"))
        })
        .collect()
}

/// What a client reads of a case's bytes, served with its content type.
async fn read(case: &Value) -> Result<String, SemiontError> {
    let resource_id = as_id("res-1");
    let content = InMemoryContent::new();
    content.seed(
        &resource_id,
        Content {
            bytes: bytes_of(case).into(),
            content_type: stated(case, "contentType").to_owned(),
        },
    );
    let test = create_test_client(TestClientOptions {
        content: Some(content),
        ..TestClientOptions::default()
    });
    test.client.browse.resource_content(&resource_id).await
}

#[tokio::test(start_paused = true)]
async fn a_resources_bytes_are_the_text_each_case_states() {
    let cases = cases();
    assert!(cases.len() >= 19, "the table has {} cases", cases.len());
    let (mut read_as_text, mut refused) = (0, 0);
    for case in &cases {
        let why = stated(case, "why");
        let answer = read(case).await;
        match (case.get("text"), case.get("refused")) {
            (Some(Value::String(text)), None) => {
                read_as_text += 1;
                match answer {
                    Ok(read) => assert_eq!(&read, text, "{why}"),
                    Err(refusal) => panic!("{why}: refused: {refusal}"),
                }
            }
            (None, Some(Value::Bool(true))) => {
                refused += 1;
                match answer {
                    Err(SemiontError::Transport(refusal)) => {
                        assert_eq!(refusal.code, TransportErrorCode::Error, "{why}");
                    }
                    Err(other) => panic!("{why}: failed as something else: {other}"),
                    Ok(read) => panic!("{why}: read as {read:?}"),
                }
            }
            _ => panic!("a case states neither its text nor that it is refused, or both: {case}"),
        }
    }
    assert!(
        read_as_text > 0 && refused > 0,
        "the table has no case of a text, or none of a refusal"
    );
}
