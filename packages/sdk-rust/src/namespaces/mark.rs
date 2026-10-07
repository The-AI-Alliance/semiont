//! Mark: annotations, a resource's own metadata, and the annotating of a
//! resource delegated as a job. Each write is confirmed: it resolves when the
//! knowledge base says it is recorded, and fails with the failure it
//! answered. What changed then arrives on the `browse` queries.

use super::follow::{Delegation, Following, follow};
use crate::channels::Empty;
use crate::channels::{
    MarkArchive, MarkAssistRequest, MarkCancelPending, MarkCreateRequest as CreateRequest,
    MarkDelete, MarkDeleteError, MarkProgressDismiss, MarkRequested, MarkSubmit, MarkUnarchive,
    MarkUpdateEntityTypes,
};
use crate::client::Links;
use crate::errors::SemiontError;
use crate::transport::Envelope;
use crate::types::{AnnotationId, ResourceId};
use crate::types::{
    AnnotationSelector, CreateAnnotationRequest, MarkArchiveCommand, MarkAssistRequestEvent,
    MarkCreateOkResponse, MarkCreateRequest, MarkDeleteCommand, MarkJobCompleteCommand,
    MarkJobCreateCommand, MarkJobParams, MarkRequestedEvent, MarkSubmitEvent, MarkUnarchiveCommand,
    MarkUpdateEntityTypesCommand, Motivation, ResourceErrorEvent,
};

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

    /// Delegate the annotating of a resource as a `mark` job: its progress,
    /// any attempt that failed and will be tried again, and its completion,
    /// whose result is a `mark` job's: its counts, or a decline.
    /// `params` is the job's parameters, one of five by its motivation
    /// (`HighlightingJobParams`, `CommentingJobParams`, `AssessingJobParams`,
    /// `LinkingJobParams`, `TaggingJobParams`), and each takes its own and no
    /// others.
    ///
    /// ```
    /// use semiont::types::{LinkingJobParams, MarkJobParams};
    ///
    /// let params: MarkJobParams = LinkingJobParams {
    ///     include_descriptive_references: Some(true),
    ///     ..LinkingJobParams::new(vec!["Person".to_owned()])
    /// }
    /// .into();
    /// # let _ = params;
    /// ```
    ///
    /// A parameter a job does not take is not one its type has: a linking
    /// job given instructions does not compile.
    ///
    /// ```compile_fail,E0560
    /// use semiont::types::LinkingJobParams;
    ///
    /// let params = LinkingJobParams {
    ///     instructions: Some("who is related to whom".to_owned()),
    ///     ..LinkingJobParams::new(vec!["Person".to_owned()])
    /// };
    /// ```
    ///
    /// Nor does a job made without what it needs: a tagging job is made from
    /// its schema and its categories.
    ///
    /// ```compile_fail,E0061
    /// use semiont::types::TaggingJobParams;
    ///
    /// let params = TaggingJobParams::new();
    /// ```
    pub fn delegate(
        &self,
        resource_id: &ResourceId,
        params: impl Into<MarkJobParams>,
    ) -> Delegation<MarkJobCompleteCommand> {
        follow(
            self.links.clone(),
            Following {
                create: MarkJobCreateCommand::new(resource_id.clone(), params.into()).into(),
                resource_id: resource_id.clone(),
                stall: None,
            },
        )
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

    /// Signal: the annotating of the open resource is to be delegated, as a
    /// `mark` job of these parameters, the ones `delegate` takes. The
    /// client's own state runs it.
    pub fn request_assist(&self, params: impl Into<MarkJobParams>) {
        self.links.signal::<MarkAssistRequest>(
            &MarkAssistRequestEvent {
                params: params.into(),
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
