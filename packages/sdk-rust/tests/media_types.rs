//! The media-type registry (specs/src/media-types/registry.json) as this SDK
//! holds it, and the rules read from it, run as specs/src/media-types/cases.json
//! states them: the cases every SDK runs.

use semiont::media_types::{
    MEDIA_TYPES, PLAIN_TEXT, base_media_type, capabilities_of, clone_format, derive_storage_uri,
    derives_text_of, storage_file_name, text_source_of, yields_geometry_of,
};
use semiont::types::SupportedMediaType;
use serde_json::{Value, json};

fn cases(of: &str) -> Vec<Value> {
    let table: Value = serde_json::from_str(include_str!("../specs/media-types/cases.json"))
        .expect("the cases are JSON");
    let cases = table[of].as_array().expect("cases").clone();
    assert!(!cases.is_empty(), "{of} has no case");
    cases
}

fn text<'a>(case: &'a Value, key: &str) -> &'a str {
    case[key]
        .as_str()
        .unwrap_or_else(|| panic!("a case states no {key}: {case}"))
}

fn flag(case: &Value, key: &str) -> bool {
    case[key]
        .as_bool()
        .unwrap_or_else(|| panic!("a case does not say whether {key}: {case}"))
}

#[test]
fn a_clone_takes_the_format_each_case_states() {
    for case in cases("cloneFormat") {
        assert_eq!(
            clone_format(case["source"].as_str()).media_type,
            text(&case, "format"),
            "{}",
            text(&case, "why")
        );
    }
}

#[test]
fn content_is_stored_under_the_name_each_case_states() {
    for case in cases("storageFileName") {
        let format = capabilities_of(text(&case, "format")).expect("a case's format has a row");
        let file_name = storage_file_name(text(&case, "name"), format);
        assert_eq!(file_name, text(&case, "fileName"), "{}", text(&case, "why"));
        assert_eq!(
            derive_storage_uri(text(&case, "name"), format),
            format!("file://{file_name}")
        );
    }
}

#[test]
fn a_formats_text_comes_from_where_each_case_states() {
    for case in cases("textSource") {
        let (why, format) = (text(&case, "why"), text(&case, "format"));
        let held = (
            text_source_of(format).as_str(),
            yields_geometry_of(format),
            derives_text_of(format),
        );
        let stated = (
            text(&case, "textSource"),
            flag(&case, "yieldsGeometry"),
            flag(&case, "derivesText"),
        );
        assert_eq!(held, stated, "{why}: {format}");
    }
}

#[test]
fn the_rows_are_the_registrys_in_its_order() {
    let registry: Value = serde_json::from_str(include_str!("../specs/media-types/registry.json"))
        .expect("the registry is JSON");
    let stated = registry["mediaTypes"].as_array().expect("rows");
    let held: Vec<Value> = MEDIA_TYPES
        .iter()
        .map(|row| {
            json!({
                "mediaType": row.media_type, "extension": row.extension, "label": row.label,
                "render": row.render.as_str(), "anchoring": row.anchoring.as_str(),
                "textSource": row.text_source.as_str(), "authorable": row.authorable,
                "uploadable": row.uploadable, "generatable": row.generatable,
            })
        })
        .collect();
    assert_eq!(&held, stated);
}

#[test]
fn every_row_is_a_type_the_api_admits_and_every_such_type_has_a_row() {
    for row in MEDIA_TYPES {
        serde_json::from_value::<SupportedMediaType>(json!(row.media_type)).unwrap_or_else(|_| {
            panic!("{} has a row and the API does not admit it", row.media_type)
        });
    }
    let admitted: Value = serde_json::from_str(include_str!(
        "../specs/components/schemas/SupportedMediaType.json"
    ))
    .expect("the schema is JSON");
    for media_type in admitted["enum"].as_array().expect("an enum") {
        let media_type = media_type.as_str().expect("a media type");
        assert!(
            capabilities_of(media_type).is_some(),
            "the API admits {media_type} and it has no row"
        );
    }
}

#[test]
fn a_format_is_read_without_its_parameters_and_in_lower_case() {
    assert_eq!(base_media_type("Text/HTML; charset=utf-8"), "text/html");
    assert_eq!(
        capabilities_of(" text/markdown ;charset=utf-8").map(|row| row.extension),
        Some(".md")
    );
    assert_eq!(capabilities_of("application/x-unheard-of"), None);
    assert_eq!(capabilities_of("text/plain"), Some(&PLAIN_TEXT));
}
