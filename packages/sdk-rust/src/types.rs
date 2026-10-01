//! The protocol's types, generated from the spec when this crate is built
//! (build.rs): every schema of the job protocol's channels, the reads a job's
//! admission makes, and the bodies of the bus transport, with every schema
//! they reach. What a schema states that a type cannot — a pattern, a length,
//! a bound — the receiving side's validators hold.

#![allow(clippy::enum_variant_names, clippy::large_enum_variant)]

include!(concat!(env!("OUT_DIR"), "/types.rs"));
