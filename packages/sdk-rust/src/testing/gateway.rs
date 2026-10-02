//! A `GatewayOperations` for tests that answers only what it was told to.
//! An operation nobody scripted is refused, naming it: a double that
//! answered it with a value of its own making would hand its caller a
//! success nobody decided on. Every call is recorded, answered or not.

use crate::errors::{TransportError, TransportErrorCode};
use crate::transport::{BoxFuture, GatewayOperations};
use crate::types::ResourceId;
use crate::types::{
    HealthResponse, MediaTokenResponse, ProtectedResourceMetadata, StatusResponse, UserResponse,
};
use std::sync::{Arc, Mutex, MutexGuard};

#[derive(Default)]
struct Scripted {
    current_user: Option<UserResponse>,
    media_token: Option<MediaTokenResponse>,
    protected_resource_metadata: Option<ProtectedResourceMetadata>,
    health: Option<HealthResponse>,
    status: Option<StatusResponse>,
    calls: Vec<String>,
}

/// See the module's documentation.
#[derive(Clone, Default)]
pub struct StubGateway {
    scripted: Arc<Mutex<Scripted>>,
}

impl StubGateway {
    pub fn new() -> StubGateway {
        StubGateway::default()
    }

    fn scripted(&self) -> MutexGuard<'_, Scripted> {
        self.scripted
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub fn current_user(&self, answer: UserResponse) {
        self.scripted().current_user = Some(answer);
    }

    pub fn media_token(&self, answer: MediaTokenResponse) {
        self.scripted().media_token = Some(answer);
    }

    pub fn protected_resource_metadata(&self, answer: ProtectedResourceMetadata) {
        self.scripted().protected_resource_metadata = Some(answer);
    }

    pub fn health(&self, answer: HealthResponse) {
        self.scripted().health = Some(answer);
    }

    pub fn status(&self, answer: StatusResponse) {
        self.scripted().status = Some(answer);
    }

    /// Every operation called, in order, each as its name and, when it has
    /// one, the resource it was called for: `get_media_token res-1`.
    pub fn calls(&self) -> Vec<String> {
        self.scripted().calls.clone()
    }

    /// Record a call of `operation` and give what was scripted for it.
    fn answer<T: Clone>(
        &self,
        operation: &str,
        of: Option<&str>,
        scripted: impl FnOnce(&Scripted) -> &Option<T>,
    ) -> Result<T, TransportError> {
        let mut state = self.scripted();
        state.calls.push(match of {
            Some(resource_id) => format!("{operation} {resource_id}"),
            None => operation.to_owned(),
        });
        scripted(&state).clone().ok_or_else(|| {
            TransportError::without_response(
                format!("StubGateway: not scripted: {operation}"),
                TransportErrorCode::Error,
            )
        })
    }
}

impl GatewayOperations for StubGateway {
    fn get_current_user(&self) -> BoxFuture<'_, Result<UserResponse, TransportError>> {
        Box::pin(async move { self.answer("get_current_user", None, |s| &s.current_user) })
    }

    fn get_media_token<'a>(
        &'a self,
        resource_id: &'a ResourceId,
    ) -> BoxFuture<'a, Result<MediaTokenResponse, TransportError>> {
        Box::pin(async move {
            self.answer("get_media_token", Some(resource_id.as_str()), |s| {
                &s.media_token
            })
        })
    }

    fn get_protected_resource_metadata(
        &self,
    ) -> BoxFuture<'_, Result<ProtectedResourceMetadata, TransportError>> {
        Box::pin(async move {
            self.answer("get_protected_resource_metadata", None, |s| {
                &s.protected_resource_metadata
            })
        })
    }

    fn health_check(&self) -> BoxFuture<'_, Result<HealthResponse, TransportError>> {
        Box::pin(async move { self.answer("health_check", None, |s| &s.health) })
    }

    fn get_status(&self) -> BoxFuture<'_, Result<StatusResponse, TransportError>> {
        Box::pin(async move { self.answer("get_status", None, |s| &s.status) })
    }
}
