//! The types of the schemas only the services read — their configuration
//! documents, and what a service keeps or answers of its own — generated from
//! the spec when this crate is built (build.rs). A protocol schema they reach
//! is the SDK's type (`semiont::types`).

include!(concat!(env!("OUT_DIR"), "/service_types.rs"));
