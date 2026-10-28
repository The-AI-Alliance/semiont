//! What Semiont's Rust services share and no client needs: the spec each is
//! built against, the configuration document each reads at boot, and their
//! reach to the messaging broker. A client's share is public: the protocol's
//! types and the bus client (`semiont`), its transport over HTTP
//! (`semiont-http-transport`), and its telemetry and logging
//! (`semiont-observability`).

#![forbid(unsafe_code)]

pub mod config;
#[cfg(feature = "nats")]
pub mod nats;
pub mod spec;
pub mod types;
