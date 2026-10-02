//! Semiont's HTTP transport: a knowledge base's bus over its gateway's HTTP
//! surface, as `semiont::transport::Transport` (`transport`, with its stream
//! in `actor` and the stream's framing in `sse`); its bytes, as
//! `ContentTransport` (`content`); the gateway's own operations, as
//! `GatewayOperations`; and the SDK's client over the three (`client`).
//!
//! And the sign-in that reaches it. For a service: its account's token at
//! the issuer (`service_account`), exchanged at the gateway for the token of
//! the software agent it acts as (`agent`). For a person, behind the
//! `sign-in` feature: the issuer's grants (`oauth`), sessions over a gateway
//! and a registry's sign-in (`session`), the address an application with no
//! web page is sent back to (`loopback`), and a launcher's discovery
//! document over HTTP (`discovery`). A service links none of those.

#![forbid(unsafe_code)]
// What arrives off the wire is never assumed to be what was expected, and
// neither is anything else: the library has no `unwrap` and no `expect`.
#![cfg_attr(not(test), deny(clippy::unwrap_used, clippy::expect_used))]

mod actor;
pub mod agent;
pub mod client;
pub mod content;
#[cfg(feature = "sign-in")]
pub mod discovery;
#[cfg(feature = "sign-in")]
pub mod loopback;
#[cfg(feature = "sign-in")]
pub mod oauth;
pub mod service_account;
#[cfg(feature = "sign-in")]
pub mod session;
mod sse;
pub mod transport;
