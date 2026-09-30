//! Semiont's Rust SDK: the protocol facts a client of a knowledge base holds,
//! as specs/ states them, and a client of its bus. The protocol's types, how a
//! knowledge base names its principals, the realm's roles, signing in as a
//! service account and as the agent it acts for, and the bus itself.

#![forbid(unsafe_code)]

pub mod bus;
pub mod identity;
pub mod roles;
pub mod service_account;
pub mod session;
pub mod types;
