//! Gather: assembling the context a model is given, and what refers to a
//! resource. The second is a query (`Cached`): it answers from the client's
//! cache, and the client's refresher (`super::refresher`) keeps it true.

use crate::cache::Cache;
use crate::cached::{Cached, Keyed};
use crate::channels::{GatherReferencedByRequested, GatherRequested, GatherResourceRequested};
use crate::client::Links;
use crate::errors::SemiontError;
use crate::running::Running;
use crate::state_unit::StateUnit;
use crate::types::{AnnotationId, ResourceId};
use crate::types::{
    GatherAnnotationComplete, GatherAnnotationOptions, GatherAnnotationRequest,
    GatherReferencedByRequest, GatherResourceRequest, GatherResourceRequestOptions,
    GatheredContext, GetReferencedByResponseReferencedByItem,
};

/// An annotation elsewhere that refers to a resource.
pub(super) type ReferencedBy = GetReferencedByResponseReferencedByItem;

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
    /// What refers to each resource asked about. Kept as long as the client
    /// is: an answer of the graph, asked for again by the next client.
    pub(super) referenced_by: Cache<ResourceId, Vec<ReferencedBy>>,
}

impl GatherNamespace {
    pub(crate) fn new(links: Links) -> GatherNamespace {
        let referenced_by = Cache::new({
            let links = links.clone();
            move |resource_id: ResourceId| {
                let links = links.clone();
                async move {
                    let answer = links
                        .request::<GatherReferencedByRequested>(&GatherReferencedByRequest {
                            resource_id,
                            motivation: None,
                        })
                        .await?;
                    Ok(answer.response.referenced_by)
                }
            }
        });
        GatherNamespace {
            links,
            referenced_by,
        }
    }

    /// End the query: every watcher's stream ends.
    pub(crate) fn dispose(&self) {
        self.referenced_by.dispose();
    }

    /// The annotations elsewhere that refer to a resource, kept per
    /// resource. Watching it holds the resource's scope.
    pub fn referenced_by(
        &self,
        resource_id: &ResourceId,
    ) -> Cached<Vec<GetReferencedByResponseReferencedByItem>> {
        Cached::of(Keyed {
            cache: self.referenced_by.clone(),
            key: resource_id.clone(),
            view: |value| value,
            scope: Some((self.links.wire.transport().clone(), resource_id.clone())),
        })
    }

    /// The context around one annotation, taking `context_window` characters
    /// of its source.
    pub fn annotation(
        &self,
        resource_id: &ResourceId,
        annotation_id: &AnnotationId,
        context_window: Option<i64>,
    ) -> Running<GatherAnnotationComplete> {
        let links = self.links.clone();
        let request = GatherAnnotationRequest {
            annotation_id: annotation_id.clone(),
            resource_id: resource_id.clone(),
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
        resource_id: &ResourceId,
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
                resource_id: resource_id.clone(),
                options,
            })
            .await?;
        Ok(gathered.response)
    }
}

impl Drop for GatherNamespace {
    fn drop(&mut self) {
        self.dispose();
    }
}
