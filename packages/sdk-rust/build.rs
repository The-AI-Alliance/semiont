//! Generates the protocol types this SDK's clients hold, from specs/src: the
//! body of every request and response the API declares but the ones a
//! service only passes through (`PASSED_THROUGH`), the schemas of the job
//! protocol's channels, and the reads a job's admission makes, with every
//! schema they reach (semiont-codegen), into `types.rs`; and the bus
//! registry's operations — which reply and which failure answer each request —
//! into `operations.rs`.

use semiont_codegen::bundle::{Bundle, draft7_definitions, read_json};
use semiont_codegen::types::{Generation, generate};
use serde_json::Value;
use std::fmt::Write as _;
use std::fs;
use std::path::PathBuf;

/// The schemas generated beside the API's bodies and the job channels': a
/// failure reply, the job the queue holds, and the vocabulary reads admission
/// makes.
const BESIDE: [&str; 6] = [
    "CommandError",
    "Job",
    "BrowseEntityTypesRequest",
    "BrowseEntityTypesResult",
    "BrowseTagSchemasRequest",
    "BrowseTagSchemasResult",
];

/// Bodies the gateway carries without reading: an upload it streams to the
/// Archivist, and a resource's description it streams back. Typing them would
/// generate the whole annotation model for no consumer.
const PASSED_THROUGH: [&str; 2] = ["ResourceUpload", "GetResourceResponse"];

/// Every component schema a request or response body of `document`'s paths names.
fn api_bodies(document: &Value) -> Vec<String> {
    fn refs(node: &Value, into: &mut Vec<String>) {
        match node {
            Value::Object(object) => {
                if let Some(name) = object
                    .get("$ref")
                    .and_then(Value::as_str)
                    .and_then(|r| r.strip_prefix("#/components/schemas/"))
                {
                    into.push(name.to_owned());
                }
                object.values().for_each(|v| refs(v, into));
            }
            Value::Array(items) => items.iter().for_each(|v| refs(v, into)),
            _ => {}
        }
    }
    let mut bodies = Vec::new();
    for item in document["paths"]
        .as_object()
        .into_iter()
        .flat_map(|p| p.values())
    {
        for operation in item.as_object().into_iter().flat_map(|o| o.values()) {
            refs(&operation["requestBody"], &mut bodies);
            for response in operation["responses"]
                .as_object()
                .into_iter()
                .flat_map(|r| r.values())
            {
                let response = match response["$ref"]
                    .as_str()
                    .and_then(|r| r.strip_prefix("#/components/responses/"))
                {
                    Some(name) => &document["components"]["responses"][name],
                    None => response,
                };
                refs(&response["content"], &mut bodies);
            }
        }
    }
    bodies
}

fn main() {
    let crate_dir =
        PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").expect("cargo sets CARGO_MANIFEST_DIR"));
    let specs = crate_dir.join("../../specs/src");
    let out = PathBuf::from(std::env::var("OUT_DIR").expect("cargo sets OUT_DIR"));
    println!("cargo:rerun-if-changed={}", specs.display());

    let registry = read_json(&specs.join("bus/registry.json"));
    let channels = registry["channels"]
        .as_array()
        .expect("the bus registry lists channels");
    let mut roots: Vec<String> = channels
        .iter()
        .filter(|c| {
            c["channel"]
                .as_str()
                .is_some_and(|name| name.starts_with("job:"))
        })
        .filter(|c| c["shape"] == "schema")
        .filter_map(|c| c["schema"].as_str().map(str::to_owned))
        .collect();
    let document = Bundle::of(&specs.join("openapi.json"));
    roots.extend(
        api_bodies(&document)
            .into_iter()
            .filter(|body| !PASSED_THROUGH.contains(&body.as_str())),
    );
    roots.extend(BESIDE.iter().map(|s| (*s).to_owned()));
    roots.sort();
    roots.dedup();
    let roots: Vec<&str> = roots.iter().map(String::as_str).collect();

    let definitions = draft7_definitions(&document);
    fs::write(
        out.join("types.rs"),
        generate(
            &definitions["definitions"],
            &Generation {
                roots: &roots,
                elsewhere: None,
            },
        ),
    )
    .expect("cannot write types.rs");

    let mut operations = String::from(
        "// Generated from specs/src/bus/registry.json; do not edit.\npub const OPERATIONS: &[Operation] = &[\n",
    );
    for op in registry["operations"]
        .as_array()
        .expect("the bus registry lists operations")
    {
        let field = |key: &str| {
            op[key]
                .as_str()
                .unwrap_or_else(|| panic!("a registry operation has no {key}: {op}"))
                .to_owned()
        };
        let _ = writeln!(
            operations,
            "    Operation {{ request: {:?}, result: {:?}, failure: {:?} }},",
            field("request"),
            field("result"),
            field("failure")
        );
    }
    operations.push_str("];\n");
    fs::write(out.join("operations.rs"), operations).expect("cannot write operations.rs");
}
