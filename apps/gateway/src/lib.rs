//! The Semiont gateway: it authenticates, validates frames against the spec,
//! stamps who sent them, relays them over the signal plane, keeps the reply
//! records, replays missed events from the Archivist, and pipes bytes to and
//! from it. Everything it serves is what specs/ declares.

#![forbid(unsafe_code)]

pub mod alloc;
pub mod app;
pub mod archivist;
pub mod bus_log;
pub mod composition;
pub mod config;
pub mod http;
pub mod identity;
pub mod issuer;
pub mod ledger;
pub mod logging;
pub mod principal;
pub mod rates;
pub mod roles;
pub mod routes;
pub mod signal;
pub mod spec;
pub mod stream_counts;
pub mod telemetry;
pub mod tokens;
