//! Embeds the spec every Rust service is built against, refuses to build
//! against a malformed one, and generates the types of the schemas only the
//! services read.
//!
//! The bundles in specs/ are gitignored build output, absent from a clean
//! checkout, so this bundles specs/src itself (semiont-codegen): one document
//! per API — the protocol's, and the Archivist's. From the protocol's document
//! it writes the component schemas as JSON Schema draft 7 and compiles every
//! one of them, so a schema that cannot be compiled fails here rather than at
//! boot or on a request. The bus registry must name only schemas the spec has,
//! and the version is version.json's.
//!
//! `SERVICE_SCHEMAS` are the schemas no client reads — the configuration
//! documents, and what a service keeps or answers of its own — generated into
//! `service_types.rs`. A schema they reach that is the protocol's is named
//! from the SDK (`semiont::types`), which generates it: one home for each.

use semiont_codegen::bundle::{Bundle, draft7_definitions, read_json, write_json};
use semiont_codegen::types::{Generation, generate};
use serde_json::{Value, json};
use std::fs;
use std::path::PathBuf;

/// The schemas only the services read.
const SERVICE_SCHEMAS: [&str; 6] = [
    "GatewayConfig",
    "DispatcherConfig",
    "LogLevel",
    "LogFormat",
    "JobRecord",
    "DispatcherHealth",
];

fn main() {
    let crate_dir =
        PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").expect("cargo sets CARGO_MANIFEST_DIR"));
    let repo = crate_dir.join("../..");
    let out = PathBuf::from(std::env::var("OUT_DIR").expect("cargo sets OUT_DIR"));
    let specs = repo.join("specs/src");
    for watched in [
        specs.clone(),
        repo.join("version.json"),
        crate_dir.join("src/bus-classification.json"),
    ] {
        println!("cargo:rerun-if-changed={}", watched.display());
    }

    let gateway = Bundle::of(&specs.join("openapi.json"));
    let archivist = Bundle::of(&specs.join("archivist/openapi.json"));
    let definitions = draft7_definitions(&gateway);
    compile_every_schema(&definitions);
    check_registry(&read_json(&specs.join("bus/registry.json")), &definitions);
    check_classification(&read_json(&crate_dir.join("src/bus-classification.json")));

    write_json(&out.join("openapi.json"), &gateway);
    write_json(&out.join("archivist.openapi.json"), &archivist);
    write_json(&out.join("schemas.json"), &definitions);
    fs::write(
        out.join("service_types.rs"),
        generate(
            &definitions["definitions"],
            &Generation {
                roots: &SERVICE_SCHEMAS,
                elsewhere: Some("semiont::types"),
            },
        ),
    )
    .expect("cannot write service_types.rs");

    let version = read_json(&repo.join("version.json"));
    let version = version["version"]
        .as_str()
        .expect("version.json has a string `version`");
    println!("cargo:rustc-env=SEMIONT_VERSION={version}");
}

fn compile_every_schema(definitions: &Value) {
    let names: Vec<String> = definitions["definitions"]
        .as_object()
        .expect("definitions is an object")
        .keys()
        .cloned()
        .collect();
    if names.is_empty() {
        panic!("the spec declares no component schemas");
    }
    for name in names {
        let mut schema = definitions.clone();
        schema["$ref"] = json!(format!("#/definitions/{name}"));
        if let Err(error) = jsonschema::options()
            .with_draft(jsonschema::Draft::Draft7)
            .should_validate_formats(true)
            .build(&schema)
        {
            panic!(
                "the spec's schema {name} does not compile (a $ref it follows may be at fault): {error}"
            );
        }
    }
}

fn check_registry(registry: &Value, definitions: &Value) {
    let channels = registry["channels"]
        .as_array()
        .expect("the bus registry lists channels");
    for channel in channels {
        if let Some(schema) = channel["validate"].as_str()
            && definitions["definitions"].get(schema).is_none()
        {
            panic!(
                "the bus registry validates {} against {schema}, which the spec does not declare",
                channel["channel"]
            );
        }
    }
    let operations = registry["operations"]
        .as_array()
        .expect("the bus registry lists operations");
    if operations.is_empty() {
        panic!("the bus registry declares no operations");
    }
}

fn check_classification(classification: &Value) {
    let channels = classification["channels"]
        .as_object()
        .expect("bus-classification.json has channels");
    for (channel, attrs) in channels {
        if attrs["direction"].as_str().is_none() {
            panic!(
                "bus-classification.json: {channel} has no direction; regenerate it with scripts/bus/generate-ts.mjs"
            );
        }
    }
}
