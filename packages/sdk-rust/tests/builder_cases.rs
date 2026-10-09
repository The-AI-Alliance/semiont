//! The annotation a worker commits is one table,
//! specs/src/annotations/builder-cases.json, which every SDK runs: this
//! crate's `semiont::annotations` builds, from each case, the annotation
//! TypeScript's and Python's builders build, or refuses the span as they do.

use semiont::annotations::{Spanned, TextSpan, annotation_of_resource, annotation_of_span};
use semiont::errors::SpanRefusal;
use semiont::types::{Agent, AnchoredText, Annotation, ResourceId};
use serde::de::DeserializeOwned;
use serde_json::Value;
use std::ops::RangeInclusive;
use std::time::{SystemTime, UNIX_EPOCH};

fn table() -> Value {
    serde_json::from_str(include_str!("../specs/annotations/builder-cases.json"))
        .expect("the table is JSON")
}

fn why(case: &Value) -> &str {
    case["why"].as_str().expect("why")
}

/// A member of a case, as the type a builder takes it as. One a case does
/// not state is that type's nothing.
fn given<T: DeserializeOwned>(case: &Value, member: &str) -> T {
    serde_json::from_value(case[member].clone())
        .unwrap_or_else(|refused| panic!("{}: its {member} does not decode: {refused}", why(case)))
}

/// A case's span. `None` where one of its offsets is no offset at all: a
/// span here holds whole numbers that are not below zero, so a fraction and a
/// number below zero are refused where the span would be made.
fn span(case: &Value) -> Option<TextSpan> {
    let stated = &case["span"];
    let words = |member: &str| stated[member].as_str().map(str::to_owned);
    Some(TextSpan {
        start: stated["start"].as_u64()?,
        end: stated["end"].as_u64()?,
        exact: words("exact").expect("a span has its words"),
        prefix: words("prefix"),
        suffix: words("suffix"),
    })
}

fn milliseconds(at: SystemTime) -> u64 {
    let since = at.duration_since(UNIX_EPOCH).expect("after 1970");
    u64::try_from(since.as_millis()).expect("a time of this age")
}

/// The milliseconds since 1970 that `written` says, where it is an RFC 3339
/// date-time in UTC to the millisecond, and `None` where it is not.
fn instant(written: &str) -> Option<u64> {
    let shaped = "dddd-dd-ddTdd:dd:dd.dddZ";
    let fits = written.len() == shaped.len()
        && shaped.bytes().zip(written.bytes()).all(|(shape, byte)| {
            if shape == b'd' {
                byte.is_ascii_digit()
            } else {
                shape == byte
            }
        });
    if !fits {
        return None;
    }
    let number = |from: usize, to: usize| written[from..to].parse::<u64>().ok();
    let (year, month, day) = (number(0, 4)?, number(5, 7)?, number(8, 10)?);
    let (hour, minute, second) = (number(11, 13)?, number(14, 16)?, number(17, 19)?);
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    if hour > 23 || minute > 59 || second > 59 {
        return None;
    }
    // The days from 1970-01-01 to a date of the proleptic Gregorian
    // calendar, by years that begin on a March 1st.
    let year = year.checked_sub(u64::from(month <= 2))?;
    let (era, year_of_era) = (year / 400, year % 400);
    let day_of_year = (153 * ((month + 9) % 12) + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    let days = (era * 146_097 + day_of_era).checked_sub(719_468)?;
    Some((days * 86_400 + hour * 3_600 + minute * 60 + second) * 1_000 + number(20, 23)?)
}

/// What `build` gives, and when it ran: not before the first of two
/// milliseconds, and not after the second.
fn timed<T>(build: impl FnOnce() -> T) -> (T, RangeInclusive<u64>) {
    let before = milliseconds(SystemTime::now());
    let built = build();
    (built, before..=milliseconds(SystemTime::now()))
}

/// An annotation as the wire writes it, less what the table says no case
/// can state: `created`, which is checked here to be the moment the
/// annotation was built, as an RFC 3339 date-time in UTC to the millisecond.
fn written(
    unstated: &Value,
    case: &Value,
    annotation: &Annotation,
    built: &RangeInclusive<u64>,
) -> Value {
    let mut written = serde_json::to_value(annotation).expect("an annotation serializes");
    let members = written.as_object_mut().expect("an annotation is an object");
    for name in unstated.as_array().expect("what no case states") {
        let name = name.as_str().expect("a member's name");
        assert_eq!(name, "created", "the one member no case states");
        let created = members
            .remove(name)
            .unwrap_or_else(|| panic!("{}: no {name}", why(case)));
        let at = created
            .as_str()
            .and_then(instant)
            .unwrap_or_else(|| panic!("{}: {created} is no instant", why(case)));
        assert!(
            built.contains(&at),
            "{}: created at {created}, which is not when it was built",
            why(case)
        );
    }
    written
}

/// A case of `cases`, built: the annotation as the wire writes it, or the
/// name of the refusal.
fn span_built(unstated: &Value, case: &Value) -> Result<Value, String> {
    let anchored: Option<AnchoredText> = given(case, "anchored");
    let text: Option<String> = given(case, "text");
    let spanned = match (&text, &anchored) {
        (Some(text), None) => Spanned::Text(text),
        (None, Some(anchored)) => Spanned::Pdf(anchored),
        _ => panic!("{}: a case gives a text or an anchored text", why(case)),
    };
    let resource: ResourceId = given(case, "resourceId");
    let generator: Agent = given(case, "generator");
    let Some(span) = span(case) else {
        // The refusal is the span type's, given before any builder is
        // called: it is the table's refusal of a span that is out of range.
        return Err(SpanRefusal::SpanOutOfRange.to_string());
    };
    let (annotation, built) = timed(|| {
        annotation_of_span(
            spanned,
            &span,
            &resource,
            given(case, "motivation"),
            &generator,
            given(case, "body"),
        )
    });
    match annotation {
        Ok(annotation) => Ok(written(unstated, case, &annotation, &built)),
        Err(refusal) => Err(refusal.to_string()),
    }
}

#[test]
fn every_span_of_the_table_is_built_as_the_table_says_or_refused_as_it_says() {
    let table = table();
    let cases = table["cases"].as_array().expect("cases");
    assert!(!cases.is_empty());
    for case in cases {
        match span_built(&table["unstated"]["cases"], case) {
            Err(refusal) => assert_eq!(refusal, case["refused"], "{}", why(case)),
            Ok(annotation) => assert_eq!(annotation, case["annotation"], "{}", why(case)),
        }
    }
}

#[test]
fn every_resource_of_the_table_is_annotated_as_the_table_says() {
    let table = table();
    let cases = table["resources"].as_array().expect("resources");
    assert!(!cases.is_empty());
    for case in cases {
        let resource: ResourceId = given(case, "resourceId");
        let generator: Option<Agent> = given(case, "generator");
        let (annotation, built) = timed(|| {
            annotation_of_resource(
                &resource,
                given(case, "motivation"),
                generator.as_ref(),
                given(case, "body"),
            )
        });
        assert_eq!(
            written(&table["unstated"]["resources"], case, &annotation, &built),
            case["annotation"],
            "{}",
            why(case)
        );
    }
}

#[test]
fn the_refusals_the_table_has_a_case_of_are_the_codes_of_the_specs_vocabulary_and_all_of_them() {
    let codes: Value = serde_json::from_str(include_str!("../specs/errors/codes.json"))
        .expect("the codes are JSON");
    let mut vocabulary: Vec<&str> = codes["spanRefusal"]["codes"]
        .as_array()
        .expect("the vocabulary's codes")
        .iter()
        .map(|entry| entry["code"].as_str().expect("a code"))
        .collect();
    vocabulary.sort_unstable();
    let table = table();
    let mut refusals: Vec<&str> = table["cases"]
        .as_array()
        .expect("cases")
        .iter()
        .filter_map(|case| case["refused"].as_str())
        .collect();
    refusals.sort_unstable();
    refusals.dedup();
    // Each case's refusal is what `annotation_of_span` gave for it, in the
    // test above, so the builder gives every code and no other.
    assert_eq!(refusals, vocabulary);
}

/// A name of the tables as Rust spells it: `annotationOfSpan` is
/// `annotation_of_span`.
fn spelled(name: &Value) -> String {
    let mut spelled = String::new();
    for letter in name.as_str().expect("a name").chars() {
        if letter.is_ascii_uppercase() {
            spelled.push('_');
        }
        spelled.push(letter.to_ascii_lowercase());
    }
    spelled
}

fn names(list: &Value) -> Vec<String> {
    let mut names: Vec<String> = list
        .as_array()
        .expect("names")
        .iter()
        .map(spelled)
        .collect();
    names.sort_unstable();
    names
}

#[test]
fn the_module_builds_with_what_the_table_names_and_with_nothing_else() {
    let source = include_str!("../src/annotations.rs");
    // Everything public of the module is declared in its own file, so its
    // public functions are the file's.
    assert!(
        !source
            .lines()
            .any(|line| line.starts_with("pub use ") || line.starts_with("pub mod "))
    );
    let readers: Value =
        serde_json::from_str(include_str!("../specs/annotations/reader-cases.json"))
            .expect("the table is JSON");
    let readers = names(&readers["readers"]);
    // A public function of the module that is no reader is a builder.
    let mut builders: Vec<&str> = source
        .lines()
        .filter_map(|line| line.strip_prefix("pub fn "))
        .map(|rest| rest.split(['(', '<']).next().expect("a name"))
        .filter(|name| !readers.iter().any(|reader| reader == name))
        .collect();
    builders.sort_unstable();
    assert_eq!(builders, names(&table()["builders"]));
}
