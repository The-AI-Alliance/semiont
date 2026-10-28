//! Attention, as the state of a viewer of one resource: which annotation is
//! hovered.
//!
//! It hears the viewer's hover (`client.beckon.hover`) and holds it, and
//! sparkles an annotation the moment it is hovered. It hears an annotation
//! opened, by this viewer or by another participant driving it, and turns
//! the viewer's focus to it. Every focus it says names its resource.

use super::{Held, Tasks, said, signal};
use crate::channels::{BeckonFocus, BeckonHover, BrowseClick, Channel};
use crate::client::SemiontClient;
use crate::event_bus::BusFrames;
use crate::state_unit::StateUnit;
use crate::transport::Envelope;
use crate::types::BeckonFocusEvent;
use crate::types::{AnnotationId, ResourceId};
use std::sync::Arc;
use tokio::sync::watch;

struct Shared {
    client: Arc<SemiontClient>,
    resource_id: ResourceId,
    hovered: Held<Option<AnnotationId>>,
    tasks: Tasks,
}

impl Shared {
    fn focus(&self, annotation_id: AnnotationId) {
        signal::<BeckonFocus>(
            &self.client,
            &BeckonFocusEvent {
                annotation_id: Some(annotation_id),
                resource_id: self.resource_id.clone(),
            },
            Envelope::default(),
        );
    }
}

/// See the module's documentation.
pub struct BeckonStateUnit {
    shared: Arc<Shared>,
}

impl BeckonStateUnit {
    /// The attention of a viewer of `resource_id`.
    pub fn new(client: Arc<SemiontClient>, resource_id: &ResourceId) -> BeckonStateUnit {
        let heard = client
            .bus()
            .frames_among(&[BeckonHover::NAME, BrowseClick::NAME]);
        let shared = Arc::new(Shared {
            client,
            resource_id: resource_id.clone(),
            hovered: Held::new(None),
            tasks: Tasks::new(),
        });
        shared.tasks.spawn(listen(shared.clone(), heard));
        BeckonStateUnit { shared }
    }

    /// The annotation this viewer hovers, or none.
    pub fn hovered_annotation_id(&self) -> watch::Receiver<Option<AnnotationId>> {
        self.shared.hovered.read()
    }

    /// Signal: turn this viewer's focus to an annotation of its resource.
    pub fn focus(&self, annotation_id: &AnnotationId) {
        if !self.shared.tasks.stopped() {
            self.shared.focus(annotation_id.clone());
        }
    }
}

async fn listen(shared: Arc<Shared>, mut heard: BusFrames) {
    while let Some(frame) = heard.next().await {
        // A hover that was missed is replaced by the next one.
        let Ok(frame) = frame else { continue };
        if let Some(hover) = said::<BeckonHover>(&frame) {
            shared.hovered.set(hover.annotation_id.clone());
            if let Some(annotation_id) = hover.annotation_id {
                shared.client.beckon.sparkle(&annotation_id);
            }
        } else if let Some(click) = said::<BrowseClick>(&frame) {
            shared.focus(click.annotation_id);
        }
    }
}

impl StateUnit for BeckonStateUnit {
    fn dispose(&self) {
        self.shared.tasks.stop();
        self.shared.hovered.end();
    }
}

impl Drop for BeckonStateUnit {
    fn drop(&mut self) {
        self.dispose();
    }
}
