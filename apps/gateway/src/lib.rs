//! The Semiont gateway: it authenticates, validates frames against the spec,
//! stamps who sent them, relays them over the signal plane, keeps the reply
//! records, replays missed events from the Archivist, and pipes bytes to and
//! from it. Everything it serves is what specs/ declares.

#![forbid(unsafe_code)]

pub mod app;
pub mod archivist;
pub mod composition;
pub mod config;
pub mod http;
pub mod ledger;
pub mod limits;
pub mod metrics;
pub mod principal;
pub mod rates;
pub mod routes;
pub mod signal;
pub mod stream_counts;
pub mod tokens;
