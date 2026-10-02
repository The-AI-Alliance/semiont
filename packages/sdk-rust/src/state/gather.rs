//! Gathering, as state: the context around an annotation of one resource,
//! and the context around a whole resource, each with whether it is being
//! gathered and the failure it met.
//!
//! The two are held apart because both can be in flight at once. An
//! annotation's is asked for by a signal (`gather:requested` on the client's
//! own bus), since what asks is far from what shows it; a resource's is
//! asked for by a method, since what asks holds the unit.
//!
//! A new request clears what the last one left. Requests are not cancelled
//! by the next: each lands when it is answered.

use super::{Held, Tasks, said};
use crate::channels::{Channel, GatherRequested};
use crate::client::SemiontClient;
use crate::errors::SemiontError;
use crate::event_bus::BusFrames;
use crate::state_unit::StateUnit;
use crate::types::{GatherAnnotationRequest, GatherResourceRequestOptions, GatheredContext};
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
    resource_id: String,
    annotation: Slot,
    annotation_id: Held<Option<String>>,
    resource: Slot,
    tasks: Tasks,
}

/// See the module's documentation.
pub struct GatherStateUnit {
    shared: Arc<Shared>,
}

impl GatherStateUnit {
    /// The gathers of `resource_id`'s annotations, and of any resource.
    pub fn new(client: Arc<SemiontClient>, resource_id: &str) -> GatherStateUnit {
        let heard = client.bus().frames(GatherRequested::NAME);
        let shared = Arc::new(Shared {
            client,
            resource_id: resource_id.to_owned(),
            annotation: Slot::new(),
            annotation_id: Held::new(None),
            resource: Slot::new(),
            tasks: Tasks::new(),
        });
        shared.tasks.spawn(listen(shared.clone(), heard));
        GatherStateUnit { shared }
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
    pub fn annotation_id(&self) -> watch::Receiver<Option<String>> {
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

    /// Gather the context around a whole resource.
    pub fn gather_resource(&self, resource_id: &str, options: GatherResourceRequestOptions) {
        self.shared.resource.begin();
        let (shared, resource_id) = (self.shared.clone(), resource_id.to_owned());
        self.shared.tasks.spawn(async move {
            let gathered = shared.client.gather.resource(&resource_id, options).await;
            shared.resource.land(gathered);
        });
    }
}

async fn listen(shared: Arc<Shared>, mut heard: BusFrames) {
    while let Some(frame) = heard.next().await {
        let Some(request) = frame.ok().and_then(|f| said::<GatherRequested>(&f)) else {
            continue;
        };
        gather_annotation(&shared, request);
    }
}

fn gather_annotation(shared: &Arc<Shared>, request: GatherAnnotationRequest) {
    shared.annotation.begin();
    shared
        .annotation_id
        .set(Some(request.annotation_id.clone()));
    let gathering = shared.clone();
    shared.tasks.spawn(async move {
        let gathered = gathering
            .client
            .gather
            .annotation(
                &gathering.resource_id,
                &request.annotation_id,
                request.options.and_then(|options| options.context_window),
            )
            .await;
        gathering
            .annotation
            .land(gathered.map(|complete| complete.response));
    });
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
