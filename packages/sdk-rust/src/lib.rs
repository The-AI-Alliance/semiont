//! Semiont's Rust SDK: the protocol facts a client of a knowledge base holds,
//! as specs/ states them. How a knowledge base names its principals, the
//! realm's roles, and signing in as a service account.

#![forbid(unsafe_code)]

pub mod identity;
pub mod roles;
pub mod service_account;
