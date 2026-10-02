//! Beckon: attention. The drives go over the wire, to every other
//! participant, and resolve with how many the gateway reached, or with no
//! count when it kept none; the signals are this viewer's own and never
//! leave the client.

use crate::channels::{BeckonFocus, BeckonHover, BeckonSparkle, BrowseClick, BrowseResourceOpen};
use crate::client::Links;
use crate::errors::SemiontError;
use crate::transport::Envelope;
use crate::types::{AnnotationId, ResourceId};
use crate::types::{
    BeckonFocusEvent, BeckonHoverEvent, BeckonSparkleEvent, BrowseClickEvent,
    BrowseResourceOpenEvent,
};

pub struct BeckonNamespace {
    links: Links,
}

impl BeckonNamespace {
    pub(crate) fn new(links: Links) -> BeckonNamespace {
        BeckonNamespace { links }
    }

    /// Point the other participants at an annotation.
    pub async fn attention(
        &self,
        resource_id: &ResourceId,
        annotation_id: &AnnotationId,
    ) -> Result<Option<u64>, SemiontError> {
        self.links
            .drive::<BeckonFocus>(&BeckonFocusEvent {
                annotation_id: Some(annotation_id.clone()),
                resource_id: Some(resource_id.clone()),
            })
            .await
    }

    /// Open an annotation on the other participants' screens.
    pub async fn click(&self, annotation_id: &AnnotationId) -> Result<Option<u64>, SemiontError> {
        self.links
            .drive::<BrowseClick>(&BrowseClickEvent {
                annotation_id: annotation_id.clone(),
            })
            .await
    }

    /// Open a resource on the other participants' screens.
    pub async fn open_resource(
        &self,
        resource_id: &ResourceId,
    ) -> Result<Option<u64>, SemiontError> {
        self.links
            .drive::<BrowseResourceOpen>(&BrowseResourceOpenEvent {
                resource_id: resource_id.clone(),
            })
            .await
    }

    /// Sparkle an annotation on every participant's viewer.
    pub async fn sparkle_all(
        &self,
        annotation_id: &AnnotationId,
    ) -> Result<Option<u64>, SemiontError> {
        self.links
            .drive::<BeckonSparkle>(&BeckonSparkleEvent {
                annotation_id: annotation_id.clone(),
            })
            .await
    }

    /// Signal: this viewer hovers an annotation, or none.
    pub fn hover(&self, annotation_id: Option<&AnnotationId>) {
        self.links.signal::<BeckonHover>(
            &BeckonHoverEvent {
                annotation_id: annotation_id.cloned(),
            },
            Envelope::default(),
        );
    }

    /// Signal: sparkle an annotation on this viewer alone.
    pub fn sparkle(&self, annotation_id: &AnnotationId) {
        self.links.signal::<BeckonSparkle>(
            &BeckonSparkleEvent {
                annotation_id: annotation_id.clone(),
            },
            Envelope::default(),
        );
    }
}
