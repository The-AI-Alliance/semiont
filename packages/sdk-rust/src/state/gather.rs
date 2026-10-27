//! Gathering, as state: the context around an annotation of one resource,
//! and the context around a whole resource, each with whether it is being
//! gathered and the failure it met.
//!
//! The two are held apart because both can be in flight at once. Each is
//! asked of the unit itself, so a gather asked of one resource's unit
//! reaches no other.
//!
//! A new request clears what the last one left. Requests are not cancelled
//! by the next: each lands when it is answered.

use super::{Held, Tasks};
use crate::client::SemiontClient;
use crate::errors::SemiontError;
use crate::state_unit::StateUnit;
use crate::types::AnnotationId;
use crate::types::{
    GatherAnnotationOptions, GatherResourceRequestOptions, GatheredContext, ResourceId,
};
use std::sync::Arc;
use tokio::sync::watch;

/// One gather's state.
struct Slot {
    context: Held<Option<GatheredContext>>,
    loading: Held<bool>,
    error: Held<Option<SemiontError>>,
}

impl Slot {
    fn new() -> Slot {
        Slot {
            context: Held::new(None),
            loading: Held::new(false),
            error: Held::new(None),
        }
    }

    fn begin(&self) {
        self.loading.set(true);
        self.error.set(None);
        self.context.set(None);
    }

    /// The context is there before the gather is said to be over, so a
    /// reader told it is over finds what it gathered.
    fn land(&self, gathered: Result<GatheredContext, SemiontError>) {
        match gathered {
            Ok(context) => self.context.set(Some(context)),
            Err(error) => self.error.set(Some(error)),
        }
        self.loading.set(false);
    }

    fn end(&self) {
        self.context.end();
        self.loading.end();
        self.error.end();
    }
}

struct Shared {
    client: Arc<SemiontClient>,
    resource_id: ResourceId,
    annotation: Slot,
    annotation_id: Held<Option<AnnotationId>>,
    resource: Slot,
    tasks: Tasks,
}

/// See the module's documentation.
pub struct GatherStateUnit {
    shared: Arc<Shared>,
}

impl GatherStateUnit {
    /// The gathers of `resource_id`'s annotations, and of any resource.
    pub fn new(client: Arc<SemiontClient>, resource_id: &ResourceId) -> GatherStateUnit {
        GatherStateUnit {
            shared: Arc::new(Shared {
                client,
                resource_id: resource_id.clone(),
                annotation: Slot::new(),
                annotation_id: Held::new(None),
                resource: Slot::new(),
                tasks: Tasks::new(),
            }),
        }
    }

    /// The context around the annotation last asked about.
    pub fn context(&self) -> watch::Receiver<Option<GatheredContext>> {
        self.shared.annotation.context.read()
    }

    pub fn loading(&self) -> watch::Receiver<bool> {
        self.shared.annotation.loading.read()
    }

    pub fn error(&self) -> watch::Receiver<Option<SemiontError>> {
        self.shared.annotation.error.read()
    }

    /// The annotation last asked about.
    pub fn annotation_id(&self) -> watch::Receiver<Option<AnnotationId>> {
        self.shared.annotation_id.read()
    }

    /// The context around the resource last asked about.
    pub fn resource_context(&self) -> watch::Receiver<Option<GatheredContext>> {
        self.shared.resource.context.read()
    }

    pub fn resource_loading(&self) -> watch::Receiver<bool> {
        self.shared.resource.loading.read()
    }

    pub fn resource_error(&self) -> watch::Receiver<Option<SemiontError>> {
        self.shared.resource.error.read()
    }

    /// Gather the context around one of this unit's resource's annotations,
    /// as `options` say, as `client.gather.annotation` does.
    pub fn gather_annotation(
        &self,
        annotation_id: &AnnotationId,
        options: GatherAnnotationOptions,
    ) {
        self.shared.annotation.begin();
        self.shared.annotation_id.set(Some(annotation_id.clone()));
        let (shared, annotation_id) = (self.shared.clone(), annotation_id.clone());
        self.shared.tasks.spawn(async move {
            let gathered = shared
                .client
                .gather
                .annotation(&shared.resource_id, &annotation_id, options)
                .await;
            shared
                .annotation
                .land(gathered.map(|complete| complete.response));
        });
    }

    /// Gather the context around a whole resource.
    pub fn gather_resource(&self, resource_id: &ResourceId, options: GatherResourceRequestOptions) {
        self.shared.resource.begin();
        let (shared, resource_id) = (self.shared.clone(), resource_id.clone());
        self.shared.tasks.spawn(async move {
            let gathered = shared.client.gather.resource(&resource_id, options).await;
            shared.resource.land(gathered);
        });
    }
}

impl StateUnit for GatherStateUnit {
    fn dispose(&self) {
        self.shared.tasks.stop();
        self.shared.annotation.end();
        self.shared.annotation_id.end();
        self.shared.resource.end();
    }
}

impl Drop for GatherStateUnit {
    fn drop(&mut self) {
        self.dispose();
    }
}
