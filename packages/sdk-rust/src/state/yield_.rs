//! Generation, as state: whether a resource is being generated, the job's
//! id and progress, and what the finished run produced.
//!
//! The display it feeds stays once the run is over: the progress and the
//! outcome are there until they are dismissed, or until the next run begins.
//! A run that fails, or stalls, clears its progress and is no longer
//! generating, and why it ended is held with the rest. A stall is said
//! nowhere else.

use super::{Held, Tasks};
use crate::client::SemiontClient;
use crate::errors::SemiontError;
use crate::namespaces::JobEvent;
use crate::state_unit::StateUnit;
use crate::types::{GenerationJobParams, JobProgress, YieldJobResult};
use crate::types::{JobId, ResourceId};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::watch;

/// What a finished generation produced.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct YieldOutcome {
    pub resource_id: ResourceId,
    pub resource_name: String,
    /// The run stopped at its token ceiling: the resource is cut off, not
    /// complete.
    pub truncated: bool,
}

struct Shared {
    client: Arc<SemiontClient>,
    locale: String,
    generating: Held<bool>,
    progress: Held<Option<JobProgress>>,
    outcome: Held<Option<YieldOutcome>>,
    failure: Held<Option<SemiontError>>,
    job_id: Held<Option<JobId>>,
    tasks: Tasks,
}

/// See the module's documentation.
pub struct YieldStateUnit {
    shared: Arc<Shared>,
}

impl YieldStateUnit {
    /// `locale` is the language a generation is written in when its request
    /// states none. BCP 47.
    pub fn new(client: Arc<SemiontClient>, locale: &str) -> YieldStateUnit {
        YieldStateUnit {
            shared: Arc::new(Shared {
                client,
                locale: locale.to_owned(),
                generating: Held::new(false),
                progress: Held::new(None),
                outcome: Held::new(None),
                failure: Held::new(None),
                job_id: Held::new(None),
                tasks: Tasks::new(),
            }),
        }
    }

    /// Whether a run is under way: from its first progress to its end.
    pub fn is_generating(&self) -> watch::Receiver<bool> {
        self.shared.generating.read()
    }

    pub fn progress(&self) -> watch::Receiver<Option<JobProgress>> {
        self.shared.progress.read()
    }

    /// What the last finished run produced; none while one runs, and none
    /// once dismissed.
    pub fn outcome(&self) -> watch::Receiver<Option<YieldOutcome>> {
        self.shared.outcome.read()
    }

    /// Why the last run ended without a result: it failed, stalled or was
    /// cancelled. None while one runs, after one that completed, and once
    /// dismissed.
    pub fn failure(&self) -> watch::Receiver<Option<SemiontError>> {
        self.shared.failure.read()
    }

    /// The id of the generation job, from the queue's answer to its creation
    /// to the job's end: what `client.job.cancel` names. None before the
    /// answer, when there is no id, and after the end, when there is nothing
    /// to cancel.
    pub fn job_id(&self) -> watch::Receiver<Option<JobId>> {
        self.shared.job_id.read()
    }

    /// Generate a resource from a gathered context, as
    /// `client.yield_.delegate` does, in this unit's locale when the
    /// request states no language.
    pub fn generate(&self, mut params: GenerationJobParams, stall_deadline: Option<Duration>) {
        self.shared.outcome.set(None);
        self.shared.failure.set(None);
        self.shared.job_id.set(None);
        if params.language.as_deref().is_none_or(str::is_empty) {
            params.language = Some(self.shared.locale.clone());
        }
        let shared = self.shared.clone();
        self.shared.tasks.spawn(async move {
            let mut run = shared.client.yield_.delegate(params, stall_deadline);
            // This job's id. At the job's end it is let go only while it is
            // still the one held: a job generated later replaces it.
            let mut created: Option<JobId> = None;
            while let Some(event) = run.next().await {
                match event {
                    Ok(JobEvent::Created(job)) => {
                        shared.job_id.set(Some(job.job_id.clone()));
                        created = Some(job.job_id);
                    }
                    Ok(JobEvent::Progress(progress)) => {
                        shared.progress.set(Some(progress));
                        shared.generating.set(true);
                    }
                    Ok(JobEvent::Complete(complete)) => {
                        if let Some(YieldJobResult::GenerationResult(result)) = complete.result {
                            shared.outcome.set(Some(YieldOutcome {
                                resource_id: result.resource_id,
                                resource_name: result.resource_name,
                                truncated: result.truncated,
                            }));
                        }
                    }
                    // An attempt that failed and will be tried again: the
                    // run is not over.
                    Ok(JobEvent::Failed(_)) => {}
                    Err(failure) => {
                        shared.progress.set(None);
                        shared.failure.set(Some(failure));
                        break;
                    }
                }
            }
            shared.generating.set(false);
            if let Some(job_id) = &created {
                shared.job_id.forget(job_id);
            }
        });
    }

    /// Clear the display of a run: its progress, its outcome and why it
    /// failed.
    pub fn dismiss_progress(&self) {
        self.shared.progress.set(None);
        self.shared.outcome.set(None);
        self.shared.failure.set(None);
    }
}

impl StateUnit for YieldStateUnit {
    fn dispose(&self) {
        self.shared.tasks.stop();
        self.shared.generating.end();
        self.shared.progress.end();
        self.shared.outcome.end();
        self.shared.failure.end();
        self.shared.job_id.end();
    }
}

impl Drop for YieldStateUnit {
    fn drop(&mut self) {
        self.dispose();
    }
}
