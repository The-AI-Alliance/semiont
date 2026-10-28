//! The gateway's configuration document: `GatewayConfig` in the spec, its type
//! generated in `semiont_core::config`, read at boot from the path `--config`
//! names (the image passes `/etc/semiont/gateway.json`, where the launcher
//! mounts it) and validated against its schema before anything in it is used.

use semiont_core::config::{self, ConfigError, Document};
use semiont_core::types::{GatewayConfig, GatewayConfigSignalType};

pub const DOCUMENT: Document = Document {
    service: "gateway",
    schema: "GatewayConfig",
};

/// The signal plane, with the one rule the schema cannot state made a type: a NATS plane has servers.
#[derive(Debug, Clone)]
pub enum SignalConfig {
    InProcess,
    Nats {
        servers: String,
        user_env: Option<String>,
        password_env: Option<String>,
    },
}

/// The document the gateway was started on, and its signal plane.
pub fn read_gateway_config(
    args: impl IntoIterator<Item = String>,
) -> Result<(GatewayConfig, SignalConfig), ConfigError> {
    let path = config::path_from_args(args, &DOCUMENT)?;
    let document: GatewayConfig = config::read(&path, &DOCUMENT)?;
    let signal = match (document.signal.r#type, &document.signal.servers) {
        (GatewayConfigSignalType::InProcess, _) => SignalConfig::InProcess,
        (GatewayConfigSignalType::Nats, Some(servers)) => SignalConfig::Nats {
            servers: servers.clone(),
            user_env: document.signal.user_env.clone(),
            password_env: document.signal.password_env.clone(),
        },
        (GatewayConfigSignalType::Nats, None) => {
            return Err(config::refused(
                &path,
                &DOCUMENT,
                &[
                    "/signal is missing servers: a nats plane needs its broker's address"
                        .to_owned(),
                ],
            ));
        }
    };
    Ok((document, signal))
}
