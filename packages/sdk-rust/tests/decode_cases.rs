//! What text a resource's bytes are is two tables, which every reader of a
//! resource's text runs. specs/src/text/decode-cases.json is written by hand:
//! what is said of a content type, of a label, of a byte-order mark and of
//! malformed UTF-8 and UTF-16. specs/src/text/encoding-cases.json is
//! generated: every label of the Encoding Standard, and every byte of each
//! of its single-byte encodings.
//!
//! A worker reads a resource's text with `browse.resource_content` and
//! counts its offsets in what that gives, so each case is read through a
//! client, from bytes its content transport serves with the case's content
//! type. This crate's tests have the `charsets` feature, with which the
//! reader is `encoding_rs`: the Encoding Standard as Firefox has it. So this
//! run is also the check of the generated table, which is made from another
//! implementation, against that one.

use semiont::errors::{SemiontError, TransportErrorCode};
use semiont::testing::{InMemoryContent, TestClientOptions, as_id, create_test_client};
use semiont::transport::Content;
use serde_json::Value;

fn table(text: &str) -> Value {
    serde_json::from_str(text).expect("the table is JSON")
}

fn stated<'a>(case: &'a Value, key: &str) -> &'a str {
    case[key]
        .as_str()
        .unwrap_or_else(|| panic!("a case states no {key}: {case}"))
}

/// Bytes written in hexadecimal, two digits to a byte.
fn bytes_of(hexadecimal: &str) -> Vec<u8> {
    hexadecimal
        .split_whitespace()
        .map(|byte| {
            assert_eq!(byte.len(), 2, "{byte} is not two digits");
            u8::from_str_radix(byte, 16).unwrap_or_else(|_| panic!("{byte} is not a byte"))
        })
        .collect()
}

/// What a client reads of some bytes, served with a content type.
async fn read(content_type: &str, bytes: Vec<u8>) -> Result<String, SemiontError> {
    let resource_id = as_id("res-1");
    let content = InMemoryContent::new();
    content.seed(
        &resource_id,
        Content {
            bytes: bytes.into(),
            content_type: content_type.to_owned(),
        },
    );
    let test = create_test_client(TestClientOptions {
        content: Some(content),
        ..TestClientOptions::default()
    });
    test.client.browse.resource_content(&resource_id).await
}

/// What is wrong with an answer that should be this text, if anything is.
fn is_text(answer: Result<String, SemiontError>, text: &str) -> Option<String> {
    match answer {
        Ok(read) if read == text => None,
        Ok(read) => Some(format!("read as {read:?}, which should be {text:?}")),
        Err(refusal) => Some(format!("refused, which should be {text:?}: {refusal}")),
    }
}

/// What is wrong with an answer that should be a refusal, if anything is: a
/// transport's failure, which names the label.
fn is_refused(answer: Result<String, SemiontError>, label: &str) -> Option<String> {
    match answer {
        Err(SemiontError::Transport(refusal)) if refusal.code != TransportErrorCode::Error => {
            Some(format!("refused as {:?}", refusal.code))
        }
        Err(SemiontError::Transport(refusal)) if !refusal.message.contains(label) => Some(format!(
            "the refusal does not name {label}: {}",
            refusal.message
        )),
        Err(SemiontError::Transport(_)) => None,
        Err(other) => Some(format!("failed as something else: {other}")),
        Ok(read) => Some(format!("read as {read:?}, which should be refused")),
    }
}

/// Every fault a run found, said together: a table is run whole.
fn none(faults: &[String]) {
    assert!(
        faults.is_empty(),
        "{} of the table's cases are not kept:\n{}",
        faults.len(),
        faults.join("\n")
    );
}

#[tokio::test(start_paused = true)]
async fn a_resources_bytes_are_the_text_each_case_states() {
    let table = table(include_str!("../specs/text/decode-cases.json"));
    let cases = table["cases"].as_array().expect("cases");
    assert!(cases.len() >= 90, "the table has {} cases", cases.len());
    let (mut texts, mut refusals) = (0, 0);
    let mut faults = Vec::new();
    for case in cases {
        let why = stated(case, "why");
        let answer = read(stated(case, "contentType"), bytes_of(stated(case, "bytes"))).await;
        let fault = match (case.get("text"), case.get("refused")) {
            (Some(Value::String(text)), None) => {
                texts += 1;
                is_text(answer, text)
            }
            (None, Some(Value::String(label))) => {
                refusals += 1;
                is_refused(answer, label)
            }
            _ => panic!("a case states neither its text nor that it is refused, or both: {case}"),
        };
        faults.extend(fault.map(|fault| format!("{why}: {fault}")));
    }
    assert!(
        texts > 0 && refusals > 0,
        "the table has no case of a text, or none of a refusal"
    );
    none(&faults);
}

#[tokio::test(start_paused = true)]
async fn every_label_of_the_standard_names_its_encoding_and_every_byte_is_its_character() {
    let table = table(include_str!("../specs/text/encoding-cases.json"));
    let cases = table["cases"].as_array().expect("cases");
    let every_byte: Vec<u8> = (0..=255).collect();
    let (mut single_byte, mut probed, mut refusals) = (0, 0, 0);
    let mut faults = Vec::new();
    for case in cases {
        let encoding = stated(case, "encoding");
        let labels = case["labels"].as_array().expect("labels");
        assert!(
            labels.iter().any(|label| label == encoding),
            "{encoding} is not among its own labels"
        );
        for label in labels {
            let label = label.as_str().expect("a label is text");
            let content_type = format!("text/plain; charset={label}");
            let fault = match (
                case.get("everyByte"),
                case.get("bytes"),
                case.get("text"),
                case.get("refused"),
            ) {
                (Some(Value::String(text)), None, None, None) => {
                    single_byte += 1;
                    is_text(read(&content_type, every_byte.clone()).await, text)
                }
                (None, Some(Value::String(bytes)), Some(Value::String(text)), None) => {
                    probed += 1;
                    is_text(read(&content_type, bytes_of(bytes)).await, text)
                }
                (None, None, None, Some(Value::Bool(true))) => {
                    refusals += 1;
                    is_refused(read(&content_type, every_byte.clone()).await, label)
                }
                _ => panic!("a case is of no kind this runner knows: {case}"),
            };
            faults.extend(fault.map(|fault| format!("{encoding}, as {label}: {fault}")));
        }
    }
    assert!(
        single_byte > 0 && probed > 0 && refusals > 0,
        "the table lacks a kind of case"
    );

    // The labels the table does not hold the reading of are labels all the
    // same: this reader takes each, and of one byte of ASCII makes that
    // character.
    let rest = table["legacyMultiByte"]
        .as_object()
        .expect("the legacy multi-byte encodings");
    assert!(!rest.is_empty(), "no legacy multi-byte encoding is listed");
    for (encoding, labels) in rest {
        for label in labels.as_array().expect("labels") {
            let label = label.as_str().expect("a label is text");
            let answer = read(&format!("text/plain; charset={label}"), vec![b'A']).await;
            faults.extend(
                is_text(answer, "A").map(|fault| format!("{encoding}, as {label}: {fault}")),
            );
        }
    }
    none(&faults);
}
