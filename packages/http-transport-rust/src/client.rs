//! A client of a knowledge base over its gateway: the SDK's `SemiontClient`
//! with this crate's transport under all three of its contracts, so `auth`
//! and `system` are there.

use crate::content::HttpContentTransport;
use crate::transport::{HttpTransport, HttpTransportConfig};
use semiont::client::{ClientOptions, SemiontClient};
use std::sync::Arc;

/// A client over the gateway `config` names. The transport opens its stream
/// when it is first needed.
pub fn client(config: HttpTransportConfig, options: ClientOptions) -> SemiontClient {
    let transport = Arc::new(HttpTransport::new(config));
    let content = Arc::new(HttpContentTransport::new(&transport));
    SemiontClient::new(transport.clone(), content, Some(transport), options)
}
