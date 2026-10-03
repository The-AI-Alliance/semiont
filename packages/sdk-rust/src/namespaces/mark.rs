//! Mark: annotations, a resource's own metadata, and AI assistance. Each
//! write is confirmed: it resolves when the knowledge base says it is
//! recorded, and fails with the failure it answered. What changed then
//! arrives on the `browse` queries.

use super::follow::{Following, JobEvent, follow};
use crate::bus::payload_of;
use crate::channels::Empty;
use crate::channels::{
    MarkArchive, MarkAssistRequest, MarkCancelPending, MarkCreateRequest as CreateRequest,
    MarkDelete, MarkDeleteError, MarkProgressDismiss, MarkRequested, MarkSubmit, MarkUnarchive,
    MarkUpdateEntityTypes,
};
use crate::client::Links;
use crate::errors::{BusRequestError, BusRequestErrorCode, SemiontError};
use crate::running::Running;
use crate::transport::Envelope;
use crate::types::{AnnotationId, ResourceId};
use crate::types::{
    AnnotationSelector, CreateAnnotationRequest, JobCreateCommand, JobType, MarkArchiveCommand,
    MarkAssistRequestEvent, MarkAssistRequestEventOptions, MarkCreateOkResponse, MarkCreateRequest,
    MarkDeleteCommand, MarkRequestedEvent, MarkSubmitEvent, MarkUnarchiveCommand,
    MarkUpdateEntityTypesCommand, Motivation, ResourceErrorEvent,
};
use serde::{Deserialize, Serialize};

/// What an assist is asked to do, beyond its motivation. Each field that is
/// stated becomes a parameter of the job under its own name.
#[derive(Debug, Clone, Default, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarkAssistOptions {
    /// The entity types to look for. Linking requires at least one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub entity_types: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub include_descriptive_references: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub instructions: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub density: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tone: Option<String>,
    /// The language the annotations' own text is written in. BCP 47.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
    /// The language of the resource being read. BCP 47.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_language: Option<String>,
    /// The tag schema to tag with. Tagging requires it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub schema_id: Option<String>,
    /// The schema's categories to tag with. Tagging requires at least one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub categories: Option<Vec<String>>,
}

fn refused(message: &str) -> SemiontError {
    BusRequestError::new(BusRequestErrorCode::Rejected, message).into()
}

/// The job an assist of `motivation` creates, once its options are what that
/// job needs: refused here with what the dispatcher would answer later.
fn assist_job(
    resource_id: ResourceId,
    motivation: Motivation,
    options: &MarkAssistOptions,
) -> Result<JobCreateCommand, SemiontError> {
    let stated = |list: &Option<Vec<String>>| list.as_ref().is_some_and(|l| !l.is_empty());
    let job_type = match motivation {
        Motivation::Tagging => {
            if options.schema_id.as_deref().is_none_or(str::is_empty) {
                return Err(refused(
                    "mark.assist with motivation \"tagging\" requires options.schemaId",
                ));
            }
            if !stated(&options.categories) {
                return Err(refused(
                    "mark.assist with motivation \"tagging\" requires a non-empty options.categories array",
                ));
            }
            JobType::TagAnnotation
        }
        Motivation::Linking => {
            if !stated(&options.entity_types) {
                return Err(refused(
                    "mark.assist with motivation \"linking\" requires a non-empty entityTypes array",
                ));
            }
            JobType::ReferenceAnnotation
        }
        Motivation::Highlighting => JobType::HighlightAnnotation,
        Motivation::Assessing => JobType::AssessmentAnnotation,
        Motivation::Commenting => JobType::CommentAnnotation,
    };
    Ok(JobCreateCommand {
        _user_id: None,
        job_type,
        resource_id: Some(resource_id),
        params: payload_of(options)?,
    })
}

pub struct MarkNamespace {
    links: Links,
}

impl MarkNamespace {
    pub(crate) fn new(links: Links) -> MarkNamespace {
        MarkNamespace { links }
    }

    /// Create an annotation on the resource its target names.
    pub async fn annotation(
        &self,
        input: CreateAnnotationRequest,
    ) -> Result<MarkCreateOkResponse, SemiontError> {
        let created = self
            .links
            .request::<CreateRequest>(&MarkCreateRequest {
                resource_id: input.target.source.clone(),
                request: input,
            })
            .await?;
        Ok(created.response)
    }

    pub async fn delete(
        &self,
        resource_id: &ResourceId,
        annotation_id: &AnnotationId,
    ) -> Result<(), SemiontError> {
        self.links
            .request::<MarkDelete>(&MarkDeleteCommand {
                _user_id: None,
                annotation_id: annotation_id.clone(),
                resource_id: Some(resource_id.clone()),
            })
            .await?;
        Ok(())
    }

    pub async fn archive(&self, resource_id: &ResourceId) -> Result<(), SemiontError> {
        self.links
            .request::<MarkArchive>(&MarkArchiveCommand {
                _user_id: None,
                resource_id: resource_id.clone(),
                storage_uri: None,
                keep_file: None,
                no_git: None,
            })
            .await?;
        Ok(())
    }

    pub async fn unarchive(&self, resource_id: &ResourceId) -> Result<(), SemiontError> {
        self.links
            .request::<MarkUnarchive>(&MarkUnarchiveCommand {
                _user_id: None,
                resource_id: resource_id.clone(),
                storage_uri: None,
            })
            .await?;
        Ok(())
    }

    /// Replace a resource's own entity types: `current` is what it has now,
    /// `updated` the whole set it is to have.
    pub async fn update_entity_types(
        &self,
        resource_id: &ResourceId,
        current: Vec<String>,
        updated: Vec<String>,
    ) -> Result<(), SemiontError> {
        self.links
            .request::<MarkUpdateEntityTypes>(&MarkUpdateEntityTypesCommand {
                resource_id: resource_id.clone(),
                _user_id: None,
                current_entity_types: current,
                updated_entity_types: updated,
            })
            .await?;
        Ok(())
    }

    /// Have a model annotate a resource: the job's progress, any attempt
    /// that failed and will be tried again, and its completion.
    pub fn assist(
        &self,
        resource_id: &ResourceId,
        motivation: Motivation,
        options: MarkAssistOptions,
    ) -> Running<JobEvent> {
        let links = self.links.clone();
        let resource_id = resource_id.clone();
        match assist_job(resource_id.clone(), motivation, &options) {
            Ok(create) => follow(
                links,
                Following {
                    create,
                    resource_id,
                    stall: None,
                },
            ),
            Err(refusal) => Running::new(|_| async move { Err(refusal) }),
        }
    }

    /// Signal: a new annotation is wanted on `source`.
    pub fn request(
        &self,
        source: &ResourceId,
        selector: AnnotationSelector,
        motivation: Motivation,
    ) {
        self.links.signal::<MarkRequested>(
            &MarkRequestedEvent {
                source: source.clone(),
                selector,
                motivation,
            },
            Envelope::default(),
        );
    }

    /// Signal: an assist is wanted. The client's own state runs it.
    pub fn request_assist(&self, motivation: Motivation, options: MarkAssistRequestEventOptions) {
        self.links.signal::<MarkAssistRequest>(
            &MarkAssistRequestEvent {
                motivation,
                options,
            },
            Envelope::default(),
        );
    }

    /// Signal: submit the annotation that is pending.
    pub fn submit(&self, input: MarkSubmitEvent) {
        self.links.signal::<MarkSubmit>(&input, Envelope::default());
    }

    /// Signal: drop the annotation that is pending.
    pub fn cancel_pending(&self) {
        self.links
            .signal::<MarkCancelPending>(&Empty {}, Envelope::default());
    }

    /// Signal: dismiss the display of an assist's progress.
    pub fn dismiss_progress(&self) {
        self.links
            .signal::<MarkProgressDismiss>(&Empty {}, Envelope::default());
    }

    /// Signal: a delete failed where nothing could show it. Said by whoever
    /// awaited [`delete`](Self::delete), which knows the resource.
    pub fn report_delete_error(&self, input: ResourceErrorEvent) {
        self.links
            .signal::<MarkDeleteError>(&input, Envelope::default());
    }
}
