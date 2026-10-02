//! The media-type registry (specs/src/media-types/registry.json) as this SDK
//! holds it, and the rules read from it, run as specs/src/media-types/cases.json
//! states them: the cases every SDK runs.

use semiont::media_types::{
    MEDIA_TYPES, PLAIN_TEXT, base_media_type, capabilities_of, clone_format, derive_storage_uri,
    primary_media_type, storage_file_name,
};
use semiont::types::{ResourceDescriptor, SupportedMediaType};
use serde_json::{Value, json};

fn cases(of: &str) -> Vec<Value> {
    let table: Value =
        serde_json::from_str(include_str!("../../../specs/src/media-types/cases.json"))
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
fn the_rows_are_the_registrys_in_its_order() {
    let registry: Value =
        serde_json::from_str(include_str!("../../../specs/src/media-types/registry.json"))
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
        "../../../specs/src/components/schemas/SupportedMediaType.json"
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

#[test]
fn a_resources_media_type_is_its_first_representations() {
    let resource = |representations: Value| -> ResourceDescriptor {
        serde_json::from_value(json!({
            "@context": "https://schema.org", "@id": "res-1", "name": "A resource",
            "representations": representations,
        }))
        .expect("a resource")
    };
    assert_eq!(
        primary_media_type(&resource(json!({ "mediaType": "image/png" }))),
        Some("image/png")
    );
    assert_eq!(
        primary_media_type(&resource(json!([
            { "mediaType": "text/markdown" }, { "mediaType": "application/pdf" },
        ]))),
        Some("text/markdown")
    );
    assert_eq!(primary_media_type(&resource(json!([]))), None);
}
