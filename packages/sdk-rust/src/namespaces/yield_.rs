//! Yield: creating resources, by upload, by generation, and by cloning.

use super::follow::{Following, JobEvent, Stall, follow};
use crate::bus::payload_of;
use crate::channels::{Empty, YieldClone, YieldCloneResourceRequested, YieldCloneTokenRequested};
use crate::client::Links;
use crate::errors::SemiontError;
use crate::running::Running;
use crate::timing::{
    GENERATION_STALL_ASSUMED_TOKENS_COUNT, GENERATION_STALL_FLOOR, GENERATION_STALL_PER_TOKEN,
};
use crate::transport::{ContentTransport, Envelope, PutBinaryRequest, Upload};
use crate::types::{
    CloneResourceWithTokenResponse, GatheredContextFocus, GenerationJobParams,
    JobCancelRequestJobType, JobCreateCommand, JobType, ResourceDescriptor,
    YieldCloneResourceRequest, YieldCloneTokenRequest,
};
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

    /// Generate a resource from a gathered context: the job's progress and
    /// its completion. The context's focus says what the job is about, so
    /// the job names no resource. A follower that hears nothing for
    /// `stall_deadline`, or for `stall_deadline(params.max_tokens)` when
    /// none is stated, asks for the cancellation and ends as stalled.
    pub fn from_context(
        &self,
        params: GenerationJobParams,
        stall_deadline: Option<Duration>,
    ) -> Running<JobEvent> {
        let within = stall_deadline.unwrap_or_else(|| self::stall_deadline(params.max_tokens));
        let resource_id = match &params.context.focus {
            GatheredContextFocus::Resource(focus) => focus.resource.id.clone(),
            GatheredContextFocus::Annotation(focus) => focus.source_resource.id.clone(),
        };
        match payload_of(&params) {
            Ok(params) => follow(
                self.links.clone(),
                Following {
                    create: JobCreateCommand {
                        _user_id: None,
                        job_type: JobType::Generation,
                        resource_id: None,
                        params,
                    },
                    resource_id,
                    stall: Some(Stall {
                        within,
                        cancels: JobCancelRequestJobType::Generation,
                    }),
                },
            ),
            Err(unsendable) => Running::new(|_| async move { Err(unsendable.into()) }),
        }
    }

    /// A token another resource can be created from: a clone of this one.
    pub async fn clone_token(
        &self,
        resource_id: &str,
    ) -> Result<CloneResourceWithTokenResponse, SemiontError> {
        let answer = self
            .links
            .request::<YieldCloneTokenRequested>(&YieldCloneTokenRequest {
                resource_id: resource_id.to_owned(),
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

    /// Signal: a clone of the open resource is wanted.
    pub fn clone(&self) {
        self.links
            .signal::<YieldClone>(&Empty {}, Envelope::default());
    }
}
