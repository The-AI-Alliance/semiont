//! System: what the knowledge base says about itself.

use crate::errors::SemiontError;
use crate::transport::GatewayOperations;
use crate::types::{HealthResponse, StatusResponse};
use std::sync::Arc;

pub struct SystemNamespace {
    gateway: Arc<dyn GatewayOperations>,
}

impl SystemNamespace {
    pub(crate) fn new(gateway: Arc<dyn GatewayOperations>) -> SystemNamespace {
        SystemNamespace { gateway }
    }

    /// Whether the gateway is up.
    pub async fn health_check(&self) -> Result<HealthResponse, SemiontError> {
        Ok(self.gateway.health_check().await?)
    }

    /// The knowledge base's version and features, and who the caller is to it.
    pub async fn status(&self) -> Result<StatusResponse, SemiontError> {
        Ok(self.gateway.get_status().await?)
    }
}
