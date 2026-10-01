//! Gather: assembling the context a model is given.

use crate::channels::{GatherRequested, GatherResourceRequested};
use crate::client::Links;
use crate::errors::SemiontError;
use crate::running::Running;
use crate::types::{
    GatherAnnotationComplete, GatherAnnotationOptions, GatherAnnotationRequest,
    GatherResourceRequest, GatherResourceRequestOptions, GatheredContext,
};

/// How much of the source an annotation's context takes, in characters,
/// when its caller states no window. Every SDK sends the same: the cases of
/// specs/src/client/surface.json hold each to it.
const CONTEXT_WINDOW: i64 = 2000;

/// What a resource's context takes when its caller states nothing: two hops
/// of the graph, ten resources, their content, and no summary. Held by the
/// same cases.
impl Default for GatherResourceRequestOptions {
    fn default() -> GatherResourceRequestOptions {
        GatherResourceRequestOptions {
            depth: 2,
            max_resources: 10,
            include_content: true,
            include_summary: false,
            exclude_entity_types: None,
        }
    }
}

pub struct GatherNamespace {
    links: Links,
}

impl GatherNamespace {
    pub(crate) fn new(links: Links) -> GatherNamespace {
        GatherNamespace { links }
    }

    /// The context around one annotation, taking `context_window` characters
    /// of its source.
    pub fn annotation(
        &self,
        resource_id: &str,
        annotation_id: &str,
        context_window: Option<i64>,
    ) -> Running<GatherAnnotationComplete> {
        let links = self.links.clone();
        let request = GatherAnnotationRequest {
            annotation_id: annotation_id.to_owned(),
            resource_id: resource_id.to_owned(),
            options: Some(GatherAnnotationOptions {
                include_source_context: None,
                include_target_context: None,
                context_window: Some(context_window.unwrap_or(CONTEXT_WINDOW)),
            }),
        };
        Running::new(|_| async move { links.request::<GatherRequested>(&request).await })
    }

    /// The context around a whole resource. An empty exclusion excludes
    /// nothing, and is not sent.
    pub async fn resource(
        &self,
        resource_id: &str,
        mut options: GatherResourceRequestOptions,
    ) -> Result<GatheredContext, SemiontError> {
        if options
            .exclude_entity_types
            .as_ref()
            .is_some_and(Vec::is_empty)
        {
            options.exclude_entity_types = None;
        }
        let gathered = self
            .links
            .request::<GatherResourceRequested>(&GatherResourceRequest {
                resource_id: resource_id.to_owned(),
                options,
            })
            .await?;
        Ok(gathered.response)
    }
}
