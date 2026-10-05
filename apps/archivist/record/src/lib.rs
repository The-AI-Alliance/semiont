//! The Archivist's record, as docs/protocol/ARCHIVIST.md states it: the event
//! log, the views and the projections, and where each is filed.
//!
//! This crate reaches no network and runs no other program: it links no HTTP
//! client or server and no git. The HTTP surface, the bus and the staging
//! drivers are the crates around it, and the Archivist's binary composes
//! them.

#![forbid(unsafe_code)]

pub mod shard;
