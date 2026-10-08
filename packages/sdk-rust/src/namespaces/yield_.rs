//! Yield: creating resources, by upload, by a generation delegated as a
//! job, and by cloning.

use super::follow::{Delegation, Following, follow};
use crate::channels::{Empty, YieldClone, YieldCloneResourceRequested, YieldCloneTokenRequested};
use crate::client::Links;
use crate::errors::SemiontError;
use crate::media_types::{clone_format, derive_storage_uri, primary_media_type};
use crate::timing::{
    GENERATION_STALL_ASSUMED_TOKENS_COUNT, GENERATION_STALL_FLOOR, GENERATION_STALL_PER_TOKEN,
};
use crate::transport::{ContentTransport, Envelope, PutBinaryRequest, Upload};
use crate::types::ResourceId;
use crate::types::{
    CloneResourceWithTokenResponse, CreateResourceResponse, GatheredContextFocus,
    GenerationJobParams, ResourceDescriptor, YieldCloneResourceRequest, YieldCloneTokenRequest,
    YieldJobCompleteCommand, YieldJobCreateCommand,
};
use bytes::Bytes;
use std::sync::Arc;
use std::time::Duration;

/// How long a followed generation may say nothing before its follower gives
/// up on it: a floor, and a wait that grows with the length asked for. A
/// generation says nothing while its model writes, so the silence it is
/// allowed depends on how much it was asked to write.
pub fn stall_deadline(max_tokens: Option<f64>) -> Duration {
    let tokens = max_tokens.unwrap_or(GENERATION_STALL_ASSUMED_TOKENS_COUNT as f64);
    GENERATION_STALL_FLOOR.max(GENERATION_STALL_PER_TOKEN.mul_f64(tokens.max(0.0)))
}

/// What a clone is created with: the token of its source, and its own name
/// and content.
#[derive(Debug, Clone)]
pub struct CreateFromTokenOptions {
    pub token: String,
    pub name: String,
    pub content: String,
    /// Archive the source once the clone exists.
    pub archive_original: Option<bool>,
}

pub struct YieldNamespace {
    links: Links,
    content: Arc<dyn ContentTransport>,
}

impl YieldNamespace {
    pub(crate) fn new(links: Links, content: Arc<dyn ContentTransport>) -> YieldNamespace {
        YieldNamespace { links, content }
    }

    /// Upload bytes as a new resource: the upload's progress, and the id of
    /// the resource created.
    pub fn resource(&self, data: PutBinaryRequest) -> Upload {
        self.content.put_binary(data)
    }

    /// Delegate the making of a resource from a gathered context as a `yield`
    /// job: its progress and its completion, whose result is a `yield` job's:
    /// the resource it made, or a decline. The context's focus says what
    /// the job is about, so the job names no resource. A follower that hears
    /// nothing for `stall_deadline`, or for
    /// `stall_deadline(params.max_tokens)` when none is stated, asks for that
    /// job to be cancelled and ends as stalled.
    pub fn delegate(
        &self,
        params: GenerationJobParams,
        stall_deadline: Option<Duration>,
    ) -> Delegation<YieldJobCompleteCommand> {
        let within = stall_deadline.unwrap_or_else(|| self::stall_deadline(params.max_tokens));
        let resource_id = match &params.context.focus {
            GatheredContextFocus::Resource(focus) => focus.resource.id.clone(),
            GatheredContextFocus::Annotation(focus) => focus.source_resource.id.clone(),
        };
        follow(
            self.links.clone(),
            Following {
                create: YieldJobCreateCommand::new(params).into(),
                resource_id,
                stall: Some(within),
            },
        )
    }

    /// A token another resource can be created from: a clone of this one.
    pub async fn clone_token(
        &self,
        resource_id: &ResourceId,
    ) -> Result<CloneResourceWithTokenResponse, SemiontError> {
        let answer = self
            .links
            .request::<YieldCloneTokenRequested>(&YieldCloneTokenRequest {
                resource_id: resource_id.clone(),
            })
            .await?;
        Ok(answer.response)
    }

    /// The resource a clone token was made from.
    pub async fn from_token(&self, token: &str) -> Result<ResourceDescriptor, SemiontError> {
        let answer = self
            .links
            .request::<YieldCloneResourceRequested>(&YieldCloneResourceRequest {
                token: token.to_owned(),
            })
            .await?;
        Ok(answer.response.source_resource)
    }

    /// Create a resource as a clone of the one `options.token` was made
    /// from. The source is read first; the clone's content then goes by the
    /// upload path, in the format its source's allows
    /// (`media_types::clone_format`) and under a name made from its own.
    pub async fn create_from_token(
        &self,
        options: CreateFromTokenOptions,
    ) -> Result<CreateResourceResponse, SemiontError> {
        let source = self.from_token(&options.token).await?;
        let format = clone_format(primary_media_type(&source));
        let storage_uri = derive_storage_uri(&options.name, format);
        let created = self
            .content
            .put_binary(PutBinaryRequest {
                clone_token: Some(options.token),
                archive_original: options.archive_original,
                ..PutBinaryRequest::new(
                    options.name,
                    Bytes::from(options.content),
                    format.media_type,
                    storage_uri,
                )
            })
            .await?;
        Ok(created)
    }

    /// Signal: a clone of the open resource is wanted.
    pub fn clone(&self) {
        self.links
            .signal::<YieldClone>(&Empty {}, Envelope::default());
    }
}
