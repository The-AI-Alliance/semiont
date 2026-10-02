//! A `ContentTransport` with no wire, for tests: it keeps what `put_binary`
//! receives and gives it back to a read, and records every call made of it.
//! A read of a resource nobody stored fails as `not-found`, as a gateway's
//! would, so a test that forgot to seed its content fails where it forgot
//! rather than on bytes the double made up.

use crate::errors::TransportError;
use crate::locked;
use crate::transport::{
    BoxFuture, Content, ContentStream, ContentTransport, PutBinaryRequest, Upload, UploadProgress,
};
use crate::types::{CreateResourceResponse, GetResourceResponse, ResourceId};
use std::collections::HashMap;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};
use tokio::sync::mpsc;

/// One call made of the content transport.
#[derive(Debug, Clone, PartialEq)]
pub enum ContentCall {
    PutBinary(Box<PutBinaryRequest>),
    GetBinary(ResourceId),
    GetBinaryStream(ResourceId),
    GetResourceGraph(ResourceId),
}

#[derive(Default)]
struct Inner {
    stored: Mutex<HashMap<ResourceId, Content>>,
    graphs: Mutex<HashMap<ResourceId, GetResourceResponse>>,
    calls: Mutex<Vec<ContentCall>>,
}

fn not_found(what: &str, resource_id: &ResourceId) -> TransportError {
    TransportError::of_status(
        format!("InMemoryContent: no {what} stored for {resource_id}"),
        404,
        None,
    )
}

/// See the module's documentation.
#[derive(Clone, Default)]
pub struct InMemoryContent {
    inner: Arc<Inner>,
}

impl InMemoryContent {
    pub fn new() -> InMemoryContent {
        InMemoryContent::default()
    }

    /// Store `content` as the bytes of `resource_id`.
    pub fn seed(&self, resource_id: &ResourceId, content: Content) {
        locked(&self.inner.stored).insert(resource_id.clone(), content);
    }

    /// Store `graph` as the description of `resource_id`.
    pub fn seed_graph(&self, resource_id: &ResourceId, graph: GetResourceResponse) {
        locked(&self.inner.graphs).insert(resource_id.clone(), graph);
    }

    /// Every call made, in order.
    pub fn calls(&self) -> Vec<ContentCall> {
        locked(&self.inner.calls).clone()
    }

    fn read(&self, resource_id: &ResourceId) -> Result<Content, TransportError> {
        locked(&self.inner.stored)
            .get(resource_id)
            .cloned()
            .ok_or_else(|| not_found("content", resource_id))
    }
}

/// A stream of the one chunk it was made with.
struct Once(Option<bytes::Bytes>);

impl futures_core::Stream for Once {
    type Item = Result<bytes::Bytes, TransportError>;

    fn poll_next(mut self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        Poll::Ready(self.0.take().map(Ok))
    }
}

impl ContentTransport for InMemoryContent {
    /// Stored under an id of this double's making, `test-content-<n>`.
    fn put_binary(&self, request: PutBinaryRequest) -> Upload {
        let (progress, reported) = mpsc::unbounded_channel();
        let inner = self.inner.clone();
        Upload::new(
            reported,
            Box::pin(async move {
                let resource_id = {
                    let mut stored = locked(&inner.stored);
                    let resource_id: ResourceId =
                        super::as_id(&format!("test-content-{}", stored.len() + 1));
                    stored.insert(
                        resource_id.clone(),
                        Content {
                            bytes: request.bytes.clone(),
                            content_type: request.format.clone(),
                        },
                    );
                    resource_id
                };
                let total_bytes = request.bytes.len() as u64;
                locked(&inner.calls).push(ContentCall::PutBinary(Box::new(request)));
                let _ = progress.send(UploadProgress {
                    bytes_uploaded: total_bytes,
                    total_bytes,
                });
                Ok(CreateResourceResponse { resource_id })
            }),
        )
    }

    fn get_binary<'a>(
        &'a self,
        resource_id: &'a ResourceId,
    ) -> BoxFuture<'a, Result<Content, TransportError>> {
        Box::pin(async move {
            locked(&self.inner.calls).push(ContentCall::GetBinary(resource_id.clone()));
            self.read(resource_id)
        })
    }

    fn get_binary_stream<'a>(
        &'a self,
        resource_id: &'a ResourceId,
    ) -> BoxFuture<'a, Result<ContentStream, TransportError>> {
        Box::pin(async move {
            locked(&self.inner.calls).push(ContentCall::GetBinaryStream(resource_id.clone()));
            let content = self.read(resource_id)?;
            Ok(ContentStream {
                bytes: Box::pin(Once(Some(content.bytes))),
                content_type: content.content_type,
            })
        })
    }

    fn get_resource_graph<'a>(
        &'a self,
        resource_id: &'a ResourceId,
    ) -> BoxFuture<'a, Result<GetResourceResponse, TransportError>> {
        Box::pin(async move {
            locked(&self.inner.calls).push(ContentCall::GetResourceGraph(resource_id.clone()));
            locked(&self.inner.graphs)
                .get(resource_id)
                .cloned()
                .ok_or_else(|| not_found("description", resource_id))
        })
    }
}
