//! Semiont's Rust SDK: what a client of a knowledge base holds of the
//! protocol, as specs/ states it, and a client of its bus over any transport.
//! The protocol's types, channels, error codes and timing; the transport
//! contract and the bus client over it; a client's own bus; how a session's
//! token is held and when a failure is worth another attempt; how a knowledge
//! base names its principals and the realm's roles; and the bus log. It does
//! no HTTP and links no telemetry: `semiont-http-transport` carries it over a
//! gateway.

#![forbid(unsafe_code)]

pub mod bus;
pub mod bus_log;
pub mod channels;
pub mod errors;
pub mod event_bus;
pub mod identity;
pub mod retry;
pub mod roles;
pub mod session;
pub mod state_unit;
#[cfg(feature = "testing")]
pub mod testing;
pub mod timing;
pub mod transport;
pub mod types;
