//! Marking, as one resource's state: the annotation being composed, and the
//! delegated job that is running.
//!
//! **The pending annotation.** A selection (`client.mark.request`) becomes
//! the annotation pending. Submitting it (`client.mark.submit`) creates it,
//! and it stops being pending when the knowledge base says it is recorded; a
//! creation that fails leaves it pending and says `mark:create-error` on the
//! client's own bus. `cancel_pending` drops it.
//!
//! A request and a submission are signals on the client's own bus that name
//! the resource they are for, and a unit acts only on its own. A delegation,
//! a cancel and a dismissal are asked of the unit itself. So several units
//! over one client, one per open resource, do not answer for each other.
//!
//! **The delegated job.** `request_delegate` starts one: the `mark` job of
//! the parameters it is given, delegated for this unit's resource. The
//! motivation those parameters state is held while it runs, and its progress
//! as it comes, with the motivation that progress is of. A finished job's
//! progress stays until it is dismissed (`dismiss_progress`) or the next one
//! begins, and so does a cancelled one's: its commits stand. One that fails
//! clears it. Why a job ended without completing is held until the progress
//! is dismissed or the next job begins. The job's id is held from the
//! queue's answer to its creation to the job's end: it is what
//! `client.job.cancel` names.
//!
//! A delegated job that says nothing for `DELEGATE_SILENCE` has gone quiet,
//! which is not over: the unit says so once (`mark:delegate-timeout`) and
//! keeps following, so a completion that arrives later still ends it.

use super::{Held, Tasks, cancelled, said, signal};
use crate::channels::{Channel, MarkCreateError, MarkDelegateTimeout, MarkRequested, MarkSubmit};
use crate::client::SemiontClient;
use crate::errors::SemiontError;
use crate::event_bus::BusFrames;
use crate::namespaces::JobEvent;
use crate::state_unit::StateUnit;
use crate::timing::DELEGATE_SILENCE;
use crate::transport::Envelope;
use crate::types::{
    AnnotationSelector, AnnotationTarget, CreateAnnotationRequest, JobProgress,
    MarkDelegateTimeoutEvent, MarkJobParams, MarkSubmitEvent, Motivation, ResourceErrorEvent,
};
use crate::types::{JobId, ResourceId};
use serde::Serialize;
use std::sync::Arc;
use tokio::sync::watch;

/// An annotation being composed: where it is, and why it is made. Its
/// selector is what `client.mark.submit` takes.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingAnnotation {
    pub selector: AnnotationSelector,
    pub motivation: Motivation,
}

/// The motivation a `mark` job's parameters state, read from them as the
/// wire writes them: every member of `MarkJobParams` states one, and which
/// members there are is the spec's to say.
fn motivation_of(params: &MarkJobParams) -> Option<Motivation> {
    let stated = serde_json::to_value(params).ok()?;
    serde_json::from_value(stated.get("motivation")?.clone()).ok()
}

struct Shared {
    client: Arc<SemiontClient>,
    resource_id: ResourceId,
    pending: Held<Option<PendingAnnotation>>,
    delegating: Held<Option<Motivation>>,
    progress: Held<Option<JobProgress>>,
    progress_motivation: Held<Option<Motivation>>,
    failure: Held<Option<SemiontError>>,
    job_id: Held<Option<JobId>>,
    tasks: Tasks,
}

impl Shared {
    fn failed<C: Channel<Payload = ResourceErrorEvent>>(&self, error: &SemiontError) {
        signal::<C>(
            &self.client,
            &ResourceErrorEvent {
                resource_id: self.resource_id.clone(),
                message: error.to_string(),
            },
            Envelope::default(),
        );
    }
}

/// See the module's documentation.
pub struct MarkStateUnit {
    shared: Arc<Shared>,
}

impl MarkStateUnit {
    /// The marking of `resource_id`.
    pub fn new(client: Arc<SemiontClient>, resource_id: &ResourceId) -> MarkStateUnit {
        let heard = client
            .bus()
            .frames_among(&[MarkRequested::NAME, MarkSubmit::NAME]);
        let shared = Arc::new(Shared {
            client,
            resource_id: resource_id.clone(),
            pending: Held::new(None),
            delegating: Held::new(None),
            progress: Held::new(None),
            progress_motivation: Held::new(None),
            failure: Held::new(None),
            job_id: Held::new(None),
            tasks: Tasks::new(),
        });
        shared.tasks.spawn(listen(shared.clone(), heard));
        MarkStateUnit { shared }
    }

    /// The annotation being composed, or none.
    pub fn pending_annotation(&self) -> watch::Receiver<Option<PendingAnnotation>> {
        self.shared.pending.read()
    }

    /// The motivation of the delegated job that is running, or none.
    pub fn delegating_motivation(&self) -> watch::Receiver<Option<Motivation>> {
        self.shared.delegating.read()
    }

    /// The progress of the delegated job that is running, or of the last one until
    /// it is dismissed.
    pub fn progress(&self) -> watch::Receiver<Option<JobProgress>> {
        self.shared.progress.read()
    }

    /// The motivation of the run whose progress `progress` holds: set when a
    /// job is delegated, kept through its end so its display stays its
    /// motivation's, and none once the progress is dismissed or cleared by a
    /// failure. `delegating_motivation` says what is running; this says whose
    /// display the progress is.
    pub fn progress_motivation(&self) -> watch::Receiver<Option<Motivation>> {
        self.shared.progress_motivation.read()
    }

    /// Why the last delegated job ended without completing: it failed or was
    /// cancelled. None while one runs, after one that completed, and once
    /// dismissed.
    pub fn failure(&self) -> watch::Receiver<Option<SemiontError>> {
        self.shared.failure.read()
    }

    /// The id of the delegated job, from the queue's answer to its creation
    /// to the job's end: what `client.job.cancel` names. None before the
    /// answer, when there is no id, and after the end, when there is nothing
    /// to cancel.
    pub fn job_id(&self) -> watch::Receiver<Option<JobId>> {
        self.shared.job_id.read()
    }

    /// Delegate the annotating of this unit's resource as a `mark` job of
    /// these parameters, the ones `client.mark.delegate` takes.
    pub fn request_delegate(&self, params: impl Into<MarkJobParams>) {
        let params = params.into();
        // Parameters that state no motivation are no request.
        let Some(motivation) = motivation_of(&params) else {
            return;
        };
        let shared = &self.shared;
        shared.delegating.set(Some(motivation));
        shared.progress.set(None);
        shared.progress_motivation.set(Some(motivation));
        shared.failure.set(None);
        shared.job_id.set(None);
        shared
            .tasks
            .spawn(delegate(shared.clone(), params, motivation));
    }

    /// Drop the annotation that is pending.
    pub fn cancel_pending(&self) {
        self.shared.pending.set(None);
    }

    /// Dismiss the display of a delegated job: its progress, the motivation
    /// that progress is of, and why it ended without completing.
    pub fn dismiss_progress(&self) {
        self.shared.progress.set(None);
        self.shared.progress_motivation.set(None);
        self.shared.failure.set(None);
    }
}

async fn listen(shared: Arc<Shared>, mut heard: BusFrames) {
    while let Some(frame) = heard.next().await {
        // A signal that was missed is not known, and is not acted on.
        let Ok(frame) = frame else { continue };
        if let Some(request) = said::<MarkRequested>(&frame) {
            if request.source == shared.resource_id {
                shared.pending.set(Some(PendingAnnotation {
                    selector: request.selector,
                    motivation: request.motivation,
                }));
            }
        } else if let Some(submission) = said::<MarkSubmit>(&frame)
            && submission.source == shared.resource_id
        {
            shared.tasks.spawn(create(shared.clone(), submission));
        }
    }
}

/// The annotation stops being pending here, when its own creation is
/// recorded, and not on any creation's reply: a reply does not say which
/// resource it was for, so another viewer's would drop this one's selection.
async fn create(shared: Arc<Shared>, submission: MarkSubmitEvent) {
    let created = shared
        .client
        .mark
        .annotation(CreateAnnotationRequest {
            motivation: submission.motivation,
            target: AnnotationTarget {
                selector: Some(submission.selector),
                ..AnnotationTarget::new(shared.resource_id.clone())
            },
            body: submission.body,
        })
        .await;
    match created {
        Ok(_) => shared.pending.set(None),
        Err(error) => shared.failed::<MarkCreateError>(&error),
    }
}

async fn delegate(shared: Arc<Shared>, params: MarkJobParams, motivation: Motivation) {
    let mut run = shared.client.mark.delegate(&shared.resource_id, params);
    // This job's id. At the job's end it is let go only while it is still
    // the one held: a job delegated later replaces it.
    let mut created: Option<JobId> = None;
    let forget = |created: &Option<JobId>| {
        if let Some(job_id) = created {
            shared.job_id.forget(job_id);
        }
    };
    // Whether the next silence is still to be said. It is said once, and
    // again only after the job has said something.
    let mut listening_for_silence = true;
    loop {
        let event = if listening_for_silence {
            match tokio::time::timeout(DELEGATE_SILENCE, run.next()).await {
                Ok(event) => event,
                Err(_) => {
                    listening_for_silence = false;
                    gone_quiet(&shared, motivation);
                    continue;
                }
            }
        } else {
            run.next().await
        };
        listening_for_silence = true;
        match event {
            Some(Ok(JobEvent::Created(job))) => {
                shared.job_id.set(Some(job.job_id.clone()));
                created = Some(job.job_id);
            }
            Some(Ok(JobEvent::Progress(progress))) => shared.progress.set(Some(progress)),
            // An attempt that will be tried again, or the completion, which
            // the stream's end follows.
            Some(Ok(JobEvent::Failed(_) | JobEvent::Complete(_))) => {}
            Some(Err(error)) => {
                // Why it ended is said before the end itself. A cancelled
                // job's commits stand, and its display stays to say so.
                let kept = cancelled(&error);
                shared.failure.set(Some(error));
                if !kept {
                    shared.progress.set(None);
                    shared.progress_motivation.set(None);
                }
                shared.delegating.set(None);
                forget(&created);
                return;
            }
            None => {
                shared.delegating.set(None);
                forget(&created);
                return;
            }
        }
    }
}

/// The delegated job is still running as far as anyone here knows, so its
/// motivation stays. A display that had no progress to show is given one,
/// and the silence is said once.
fn gone_quiet(shared: &Shared, motivation: Motivation) {
    if shared.progress.now().is_none() {
        shared.progress.set(Some(JobProgress {
            percentage: 0.0,
            message: None,
            annotation_id: None,
            current: None,
            processed: None,
            total: None,
            entities_found: None,
            entities_expected: None,
            entities_emitted: None,
            completed_items: None,
            request_params: None,
        }));
    }
    signal::<MarkDelegateTimeout>(
        &shared.client,
        &MarkDelegateTimeoutEvent {
            resource_id: shared.resource_id.clone(),
            motivation,
        },
        Envelope::default(),
    );
}

impl StateUnit for MarkStateUnit {
    fn dispose(&self) {
        self.shared.tasks.stop();
        self.shared.pending.end();
        self.shared.delegating.end();
        self.shared.progress.end();
        self.shared.progress_motivation.end();
        self.shared.failure.end();
        self.shared.job_id.end();
    }
}

impl Drop for MarkStateUnit {
    fn drop(&mut self) {
        self.dispose();
    }
}
