//! Semiont's Rust SDK: the protocol facts a client of a knowledge base holds,
//! as specs/ states them, and a client of its bus over any transport. The
//! protocol's types, how a knowledge base names its principals, the realm's
//! roles, the transport contract, the bus client, and the bus log.

#![forbid(unsafe_code)]

pub mod bus;
pub mod bus_log;
pub mod identity;
pub mod roles;
pub mod transport;
pub mod types;
