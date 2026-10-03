//! Marking, as one resource's state: the annotation being composed, and the
//! assist that is running.
//!
//! **The pending annotation.** A selection (`client.mark.request`, or one of
//! the quick `mark:select-*` signals) becomes the annotation pending.
//! Submitting it (`client.mark.submit`) creates it, and it stops being
//! pending when the knowledge base says it is recorded; a creation that
//! fails leaves it pending and says `mark:create-error` on the client's own
//! bus. `client.mark.cancel_pending` drops it.
//!
//! A request and a submission name the resource they are for, and a unit
//! acts only on its own: several units over one client, one per open
//! resource, do not answer for each other.
//!
//! **The assist.** `client.mark.request_assist` starts one. Its motivation
//! is held while it runs, and its progress as it comes. A finished assist's
//! progress stays until it is dismissed (`client.mark.dismiss_progress`) or
//! the next one begins. One that fails clears both.
//!
//! An assist that says nothing for `ASSIST_SILENCE` has gone quiet, which is
//! not over: the unit says so once (`mark:assist-timeout`) and keeps
//! following, so a completion that arrives later still ends it.

use super::{Held, Tasks, said, signal};
use crate::channels::{
    Channel, MarkAssistRequest, MarkAssistTimeout, MarkCancelPending, MarkCreateError,
    MarkProgressDismiss, MarkRequested, MarkSelectAssessment, MarkSelectComment,
    MarkSelectReference, MarkSelectTag, MarkSubmit,
};
use crate::client::SemiontClient;
use crate::errors::SemiontError;
use crate::event_bus::BusFrames;
use crate::namespaces::{JobEvent, MarkAssistOptions};
use crate::state_unit::StateUnit;
use crate::timing::ASSIST_SILENCE;
use crate::transport::Envelope;
use crate::types::ResourceId;
use crate::types::{
    AnnotationSelector, AnnotationTarget, CreateAnnotationRequest, FragmentSelector,
    FragmentSelectorType, JobProgress, MarkAssistRequestEvent, MarkAssistRequestEventOptions,
    MarkAssistTimeoutEvent, MarkSubmitEvent, Motivation, ResourceErrorEvent, SelectionData,
    Selector, SvgSelector, SvgSelectorType, TextQuoteSelector, TextQuoteSelectorType,
};
use std::sync::Arc;
use tokio::sync::watch;

/// An annotation being composed: where it is, and why it is made. Its
/// selector is what `client.mark.submit` takes.
#[derive(Debug, Clone, PartialEq)]
pub struct PendingAnnotation {
    pub selector: AnnotationSelector,
    pub motivation: Motivation,
}

fn stated(text: Option<String>) -> Option<String> {
    text.filter(|text| !text.is_empty())
}

/// The selector a quick selection states: its region, its fragment with the
/// text it quotes, or the text alone.
fn selected(selection: SelectionData) -> AnnotationSelector {
    let quote = TextQuoteSelector {
        r#type: TextQuoteSelectorType::TextQuoteSelector,
        exact: selection.exact,
        prefix: stated(selection.prefix),
        suffix: stated(selection.suffix),
    };
    if let Some(region) = stated(selection.svg_selector) {
        return AnnotationSelector::Selector(Selector::SvgSelector(SvgSelector {
            r#type: SvgSelectorType::SvgSelector,
            value: region,
        }));
    }
    if let Some(fragment) = stated(selection.fragment_selector) {
        let mut selectors = vec![Selector::FragmentSelector(FragmentSelector {
            r#type: FragmentSelectorType::FragmentSelector,
            value: fragment,
            conforms_to: stated(selection.conforms_to),
        })];
        if !quote.exact.is_empty() {
            selectors.push(Selector::TextQuoteSelector(quote));
        }
        return AnnotationSelector::List(selectors);
    }
    AnnotationSelector::Selector(Selector::TextQuoteSelector(quote))
}

/// What a signal asks of an assist, as the job is asked it.
fn assist_options(asked: MarkAssistRequestEventOptions) -> MarkAssistOptions {
    MarkAssistOptions {
        entity_types: asked.entity_types,
        include_descriptive_references: asked.include_descriptive_references,
        instructions: asked.instructions,
        density: asked.density,
        tone: asked.tone.map(|tone| tone.as_str().to_owned()),
        language: asked.language,
        source_language: None,
        schema_id: asked.schema_id,
        categories: asked.categories,
    }
}

struct Shared {
    client: Arc<SemiontClient>,
    resource_id: ResourceId,
    pending: Held<Option<PendingAnnotation>>,
    assisting: Held<Option<Motivation>>,
    progress: Held<Option<JobProgress>>,
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
        let heard = client.bus().frames_among(&[
            MarkRequested::NAME,
            MarkSelectComment::NAME,
            MarkSelectTag::NAME,
            MarkSelectAssessment::NAME,
            MarkSelectReference::NAME,
            MarkCancelPending::NAME,
            MarkSubmit::NAME,
            MarkAssistRequest::NAME,
            MarkProgressDismiss::NAME,
        ]);
        let shared = Arc::new(Shared {
            client,
            resource_id: resource_id.clone(),
            pending: Held::new(None),
            assisting: Held::new(None),
            progress: Held::new(None),
            tasks: Tasks::new(),
        });
        shared.tasks.spawn(listen(shared.clone(), heard));
        MarkStateUnit { shared }
    }

    /// The annotation being composed, or none.
    pub fn pending(&self) -> watch::Receiver<Option<PendingAnnotation>> {
        self.shared.pending.read()
    }

    /// The motivation of the assist that is running, or none.
    pub fn assisting(&self) -> watch::Receiver<Option<Motivation>> {
        self.shared.assisting.read()
    }

    /// The progress of the assist that is running, or of the last one until
    /// it is dismissed.
    pub fn progress(&self) -> watch::Receiver<Option<JobProgress>> {
        self.shared.progress.read()
    }
}

async fn listen(shared: Arc<Shared>, mut heard: BusFrames) {
    while let Some(frame) = heard.next().await {
        // A signal that was missed is not known, and is not acted on.
        let Ok(frame) = frame else { continue };
        let pend = |selector, motivation| {
            shared.pending.set(Some(PendingAnnotation {
                selector,
                motivation,
            }));
        };
        if let Some(request) = said::<MarkRequested>(&frame) {
            if request.source == shared.resource_id {
                pend(request.selector, request.motivation);
            }
        } else if let Some(selection) = said::<MarkSelectComment>(&frame) {
            pend(selected(selection), Motivation::Commenting);
        } else if let Some(selection) = said::<MarkSelectTag>(&frame) {
            pend(selected(selection), Motivation::Tagging);
        } else if let Some(selection) = said::<MarkSelectAssessment>(&frame) {
            pend(selected(selection), Motivation::Assessing);
        } else if let Some(selection) = said::<MarkSelectReference>(&frame) {
            pend(selected(selection), Motivation::Linking);
        } else if said::<MarkCancelPending>(&frame).is_some() {
            shared.pending.set(None);
        } else if let Some(submission) = said::<MarkSubmit>(&frame) {
            if submission.source == shared.resource_id {
                shared.tasks.spawn(create(shared.clone(), submission));
            }
        } else if let Some(request) = said::<MarkAssistRequest>(&frame) {
            shared.assisting.set(Some(request.motivation));
            shared.progress.set(None);
            shared.tasks.spawn(assist(shared.clone(), request));
        } else if said::<MarkProgressDismiss>(&frame).is_some() {
            shared.progress.set(None);
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
                source: shared.resource_id.clone(),
                selector: Some(submission.selector),
            },
            body: submission.body,
        })
        .await;
    match created {
        Ok(_) => shared.pending.set(None),
        Err(error) => shared.failed::<MarkCreateError>(&error),
    }
}

async fn assist(shared: Arc<Shared>, request: MarkAssistRequestEvent) {
    let mut run = shared.client.mark.assist(
        &shared.resource_id,
        request.motivation,
        assist_options(request.options),
    );
    // Whether the next silence is still to be said. It is said once, and
    // again only after the job has said something.
    let mut listening_for_silence = true;
    loop {
        let event = if listening_for_silence {
            match tokio::time::timeout(ASSIST_SILENCE, run.next()).await {
                Ok(event) => event,
                Err(_) => {
                    listening_for_silence = false;
                    gone_quiet(&shared, request.motivation);
                    continue;
                }
            }
        } else {
            run.next().await
        };
        listening_for_silence = true;
        match event {
            Some(Ok(JobEvent::Progress(progress))) => shared.progress.set(Some(progress)),
            // An attempt that will be tried again, or the completion, which
            // the stream's end follows.
            Some(Ok(JobEvent::Failed(_) | JobEvent::Complete(_))) => {}
            Some(Err(_)) => {
                shared.assisting.set(None);
                shared.progress.set(None);
                return;
            }
            None => {
                shared.assisting.set(None);
                return;
            }
        }
    }
}

/// The assist is still running as far as anyone here knows, so its
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
    signal::<MarkAssistTimeout>(
        &shared.client,
        &MarkAssistTimeoutEvent {
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
        self.shared.assisting.end();
        self.shared.progress.end();
    }
}

impl Drop for MarkStateUnit {
    fn drop(&mut self) {
        self.dispose();
    }
}
