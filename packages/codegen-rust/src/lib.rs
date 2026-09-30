//! Build-time generation from specs/src, for the build scripts of the crates
//! that embed or type the spec: the documents bundled whole, and Rust types
//! from their component schemas. One generator, so the SDK's protocol types and
//! a service's own types cannot be generated two ways.

#![forbid(unsafe_code)]

pub mod bundle;
pub mod types;
