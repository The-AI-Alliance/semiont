//! Semiont's Rust SDK: a client of a knowledge base (`client`), with a
//! namespace per flow of the protocol (`namespaces`), over any transport.
//! Under it: the protocol's types, channels, error codes and timing, as
//! specs/ states them; the transport contract and the bus client over it; a
//! client's own bus; the shapes a namespace's methods return (`running`,
//! `cached`); how a session's token is held and when a failure is worth
//! another attempt; how a knowledge base names its principals and the
//! realm's roles; and the bus log. It does no HTTP and links no telemetry:
//! `semiont-http-transport` carries it over a gateway.

#![forbid(unsafe_code)]

pub mod bus;
pub mod bus_log;
pub mod cached;
pub mod channels;
pub mod client;
pub mod errors;
pub mod event_bus;
pub mod identity;
pub mod namespaces;
pub mod retry;
pub mod roles;
pub mod running;
pub mod session;
pub mod state_unit;
#[cfg(feature = "testing")]
pub mod testing;
pub mod timing;
pub mod transport;
pub mod types;
