//! Semiont's HTTP transport: a knowledge base's bus over its gateway's HTTP
//! surface, as `semiont::transport::Transport`, and the sign-in that reaches
//! it — a service account's token at the issuer, exchanged at the gateway for
//! the token of the software agent it acts as.

#![forbid(unsafe_code)]

pub mod service_account;
pub mod session;
pub mod transport;
