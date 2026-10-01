//! Auth: the gateway's view of who is signed in. Signing in happens at the
//! issuer; this only asks the gateway what it sees.

use crate::errors::SemiontError;
use crate::transport::GatewayOperations;
use crate::types::{MediaTokenResponse, ProtectedResourceMetadata, UserResponse};
use std::sync::Arc;

pub struct AuthNamespace {
    gateway: Arc<dyn GatewayOperations>,
}

impl AuthNamespace {
    pub(crate) fn new(gateway: Arc<dyn GatewayOperations>) -> AuthNamespace {
        AuthNamespace { gateway }
    }

    /// The signed-in principal.
    pub async fn me(&self) -> Result<UserResponse, SemiontError> {
        Ok(self.gateway.get_current_user().await?)
    }

    /// A token that lets a browser fetch one resource's bytes.
    pub async fn media_token(&self, resource_id: &str) -> Result<MediaTokenResponse, SemiontError> {
        Ok(self.gateway.get_media_token(resource_id).await?)
    }

    /// Which issuer the knowledge base trusts: where to send someone to sign in.
    pub async fn protected_resource_metadata(
        &self,
    ) -> Result<ProtectedResourceMetadata, SemiontError> {
        Ok(self.gateway.get_protected_resource_metadata().await?)
    }
}
