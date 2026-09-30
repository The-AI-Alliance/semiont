//! What Semiont's Rust services share and no client needs: the spec each is
//! built against, the configuration document each reads at boot, and the
//! logging and telemetry each writes. A client's share — how principals are
//! named, the roles, signing in — is the SDK's (`semiont`).

#![forbid(unsafe_code)]

pub mod alloc;
pub mod bus_log;
pub mod config;
pub mod logging;
#[cfg(feature = "nats")]
pub mod nats;
pub mod spec;
pub mod telemetry;
