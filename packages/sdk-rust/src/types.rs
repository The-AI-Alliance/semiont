//! The protocol's types, generated from the spec when this crate is built
//! (build.rs): every schema of the job protocol's channels, the reads a job's
//! admission makes, and the bodies of the bus transport, with every schema
//! they reach. What a schema states that a type cannot — a pattern, a length,
//! a bound — the receiving side's validators hold.
//!
//! The kinds of id are the exception (specs/src/identifiers/kinds.json):
//! `ResourceId`, `AnnotationId`, `JobId` and `UserId` are each a type of its
//! own, made only by a constructor that holds a value to its kind's rule,
//! and decoded through that constructor.
//!
//! ```
//! use semiont::types::{AnnotationId, ResourceId};
//!
//! fn of(_resource: &ResourceId, _annotation: &AnnotationId) {}
//!
//! let resource: ResourceId = "res-one".parse()?;
//! let annotation: AnnotationId = "a-1".parse()?;
//! of(&resource, &annotation);
//! assert!("https://kb.example/resources/res-one".parse::<ResourceId>().is_err());
//! # Ok::<(), semiont::types::InvalidIdentifier>(())
//! ```
//!
//! One kind is not taken for another: the same call with its two ids
//! exchanged does not compile.
//!
//! ```compile_fail,E0308
//! use semiont::types::{AnnotationId, ResourceId};
//!
//! fn of(_resource: &ResourceId, _annotation: &AnnotationId) {}
//!
//! let resource: ResourceId = "res-one".parse()?;
//! let annotation: AnnotationId = "a-1".parse()?;
//! of(&annotation, &resource);
//! # Ok::<(), semiont::types::InvalidIdentifier>(())
//! ```

#![allow(clippy::enum_variant_names, clippy::large_enum_variant)]

include!(concat!(env!("OUT_DIR"), "/types.rs"));
