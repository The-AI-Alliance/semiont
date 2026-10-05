//! What Semiont's Rust services that serve HTTP share.
//!
//! - [`serve`]: connections a service can close from its side.
//! - [`bearer_token`]: the token an `Authorization` header carries.
//! - [`IssuerVerifier`]: tokens of the knowledge base's trusted issuer,
//!   verified against the keys it publishes.

mod bearer;
mod issuer;
mod serve;

pub use bearer::bearer_token;
pub use issuer::{IssuerVerifier, KeyTimings};
pub use serve::{ConnectionAbort, serve};
