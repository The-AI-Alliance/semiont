//! Attention, as this viewer's state: which annotation is hovered.
//!
//! It hears the viewer's hover (`client.beckon.hover`) and holds it, and
//! sparkles an annotation the moment it is hovered. It hears an annotation
//! opened, by this viewer or by another participant driving it, and turns
//! the viewer's focus to it.

use super::{Held, Tasks, said, signal};
use crate::channels::{BeckonFocus, BeckonHover, BrowseClick, Channel};
use crate::client::SemiontClient;
use crate::event_bus::BusFrames;
use crate::state_unit::StateUnit;
use crate::transport::Envelope;
use crate::types::BeckonFocusEvent;
use std::sync::Arc;
use tokio::sync::watch;

struct Shared {
    client: Arc<SemiontClient>,
    hovered: Held<Option<String>>,
    tasks: Tasks,
}

impl Shared {
    fn focus(&self, annotation_id: String) {
        signal::<BeckonFocus>(
            &self.client,
            &BeckonFocusEvent {
                annotation_id: Some(annotation_id),
                resource_id: None,
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
    pub fn new(client: Arc<SemiontClient>) -> BeckonStateUnit {
        let heard = client
            .bus()
            .frames_among(&[BeckonHover::NAME, BrowseClick::NAME]);
        let shared = Arc::new(Shared {
            client,
            hovered: Held::new(None),
            tasks: Tasks::new(),
        });
        shared.tasks.spawn(listen(shared.clone(), heard));
        BeckonStateUnit { shared }
    }

    /// The annotation this viewer hovers, or none.
    pub fn hovered(&self) -> watch::Receiver<Option<String>> {
        self.shared.hovered.read()
    }

    /// Signal: turn this viewer's focus to an annotation.
    pub fn focus(&self, annotation_id: &str) {
        if !self.shared.tasks.stopped() {
            self.shared.focus(annotation_id.to_owned());
        }
    }
}

async fn listen(shared: Arc<Shared>, mut heard: BusFrames) {
    while let Some(frame) = heard.next().await {
        // A hover that was missed is replaced by the next one.
        let Ok(frame) = frame else { continue };
        if let Some(hover) = said::<BeckonHover>(&frame) {
            shared.hovered.set(hover.annotation_id.clone());
            if let Some(annotation_id) = hover.annotation_id.filter(|id| !id.is_empty()) {
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
