//! What each reader of a resource's description answers is one table,
//! specs/src/resources/reader-cases.json, which every SDK runs: this crate's
//! `semiont::resources` gives, for each case's resource, what TypeScript's
//! and Python's readers give.

use semiont::resources::{primary_media_type, primary_representation, resource_entity_types};
use semiont::types::{Representation, ResourceDescriptor, ResourceDescriptorRepresentations};
use serde::de::DeserializeOwned;
use serde_json::Value;

/// The members of a case this runner reads. A case with any other fails: a
/// member nothing reads holds nothing.
const MEMBERS: [&str; 6] = [
    "why",
    "resource",
    "primaryRepresentation",
    "primaryMediaType",
    "entityTypes",
    "refused",
];

fn table() -> Value {
    serde_json::from_str(include_str!("../specs/resources/reader-cases.json"))
        .expect("the table is JSON")
}

/// What a case states for `member`, as the type its reader gives. `None` for
/// a member the case does not state.
fn stated<T: DeserializeOwned>(case: &Value, member: &str) -> Option<T> {
    case.get(member).map(|value| {
        serde_json::from_value(value.clone())
            .unwrap_or_else(|refused| panic!("a case's {member} does not decode: {refused}"))
    })
}

#[test]
fn every_reader_gives_what_the_table_says_for_every_resource() {
    let table = table();
    let (mut one, mut listed, mut none) = (0, 0, 0);
    let (mut typed, mut untyped, mut refused) = (0, 0, 0);
    for case in table["cases"].as_array().expect("cases") {
        let why = case["why"].as_str().expect("why");
        for member in case.as_object().expect("a case is an object").keys() {
            assert!(
                MEMBERS.contains(&member.as_str()),
                "{why}: this runner reads no {member} of a case"
            );
        }
        // A resource the schema does not allow is no ResourceDescriptor:
        // decoding it refuses it, before any reader could read it.
        if case.get("refused") == Some(&Value::Bool(true)) {
            refused += 1;
            assert!(
                serde_json::from_value::<ResourceDescriptor>(case["resource"].clone()).is_err(),
                "{why}: its resource decodes, and the table says it is refused"
            );
            continue;
        }
        let resource: ResourceDescriptor = serde_json::from_value(case["resource"].clone())
            .unwrap_or_else(|refused| panic!("{why}: its resource does not decode: {refused}"));
        match &resource.representations {
            ResourceDescriptorRepresentations::Representation(_) => one += 1,
            ResourceDescriptorRepresentations::List(list) if list.is_empty() => none += 1,
            ResourceDescriptorRepresentations::List(_) => listed += 1,
        }

        // The representation and its media type are stated only of a
        // resource that has one, and the entity types always.
        let representation: Option<Representation> = stated(case, "primaryRepresentation");
        assert_eq!(
            primary_representation(&resource),
            representation.as_ref(),
            "{why}: primary_representation"
        );
        let media_type: Option<String> = stated(case, "primaryMediaType");
        assert_eq!(
            primary_media_type(&resource),
            media_type.as_deref(),
            "{why}: primary_media_type"
        );
        let entity_types: Vec<String> = stated(case, "entityTypes")
            .unwrap_or_else(|| panic!("{why}: the case does not state its entityTypes"));
        assert_eq!(
            resource_entity_types(&resource),
            entity_types.as_slice(),
            "{why}: resource_entity_types"
        );
        if entity_types.is_empty() {
            untyped += 1;
        } else {
            typed += 1;
        }
    }
    assert!(
        one > 0 && listed > 0 && none > 0,
        "the table lacks a case of one representation, of a list of them, or of none"
    );
    assert!(
        typed > 0 && untyped > 0,
        "the table lacks a case of a resource with entity types, or of one with none"
    );
    assert!(refused > 0, "the table lacks a case of a refused resource");
}
