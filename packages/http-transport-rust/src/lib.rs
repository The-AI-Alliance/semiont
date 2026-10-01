//! Semiont's HTTP transport: a knowledge base's bus over its gateway's HTTP
//! surface, as `semiont::transport::Transport` (`transport`, with its stream
//! in `actor` and the stream's framing in `sse`); its bytes, as
//! `ContentTransport` (`content`); the gateway's own operations, as
//! `GatewayOperations`; the SDK's client over the three (`client`); and the
//! sign-in that reaches it — a service account's token at the issuer
//! (`service_account`), exchanged at the gateway for the token of the
//! software agent it acts as (`session`).

#![forbid(unsafe_code)]

mod actor;
pub mod client;
pub mod content;
pub mod service_account;
pub mod session;
mod sse;
pub mod transport;
