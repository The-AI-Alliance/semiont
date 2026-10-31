//! A client's state units: its long-running flows, held as state a consumer
//! reads and watches. None presumes a screen: a terminal, a daemon and an
//! agent watching what a person does read them alike.
//!
//! Each is built over a client it is given and never closes. It listens to
//! the client's own bus from the moment it exists, so nothing said after it
//! was built is missed, and it hears what is said in the order it was said.
//! Its state is read through methods that return `tokio::sync::watch`
//! receivers: the value now, and each value after it. A state a method sets
//! is set when the method returns; a state that follows a signal follows it
//! within a turn of the runtime.
//!
//! `dispose` ends a unit: its receivers end, what it had running stops, and
//! nothing it is told afterwards does anything. Dropping a unit disposes it.
//! A unit is built inside a Tokio runtime.

mod beckon;
mod gather;
mod hover;
mod mark;
mod match_;
mod search;
mod yield_;

pub use beckon::BeckonStateUnit;
pub use gather::GatherStateUnit;
pub use hover::HoverDwell;
pub use mark::{MarkStateUnit, PendingAnnotation};
pub use match_::MatchStateUnit;
pub use search::{SearchPipeline, SearchPipelineOptions, SearchState};
pub use yield_::YieldStateUnit;

use crate::bus::decoded;
use crate::channels::Channel;
use crate::client::SemiontClient;
use crate::errors::{JobErrorCode, SemiontError};
use crate::locked;
use crate::transport::{Envelope, Frame};
use std::collections::HashMap;
use std::future::Future;
use std::sync::Mutex;
use tokio::sync::watch;
use tokio::task::{self, AbortHandle, JoinSet};

/// One state a unit holds. Anyone reads it and only the unit writes it. Once
/// it has ended every reader has ended, and a write does nothing.
pub(crate) struct Held<T> {
    /// `None` once ended.
    sender: Mutex<Option<watch::Sender<T>>>,
    /// A reader of the same state, for the value now and for the readers
    /// taken after it ended.
    reader: watch::Receiver<T>,
}

impl<T> Held<T> {
    pub fn new(initial: T) -> Held<T> {
        Held::of(watch::channel(initial).0)
    }

    /// A state somebody else reads too: they hold a receiver of `sender`.
    pub fn of(sender: watch::Sender<T>) -> Held<T> {
        let reader = sender.subscribe();
        Held {
            sender: Mutex::new(Some(sender)),
            reader,
        }
    }

    /// A reader: the value now, and each one after it.
    pub fn read(&self) -> watch::Receiver<T> {
        match locked(&self.sender).as_ref() {
            Some(sender) => sender.subscribe(),
            None => self.reader.clone(),
        }
    }

    /// The value is `value`, and every reader is told: an occurrence, which
    /// is one even when it equals the last.
    pub fn raise(&self, value: T) {
        if let Some(sender) = locked(&self.sender).as_ref() {
            sender.send_replace(value);
        }
    }

    pub fn end(&self) {
        *locked(&self.sender) = None;
    }
}

impl<T: Clone> Held<T> {
    pub fn now(&self) -> T {
        self.reader.borrow().clone()
    }
}

impl<T: PartialEq> Held<T> {
    /// The value is `value`. A reader is told only when that changed it.
    pub fn set(&self, value: T) {
        if let Some(sender) = locked(&self.sender).as_ref() {
            sender.send_if_modified(|held| {
                let changed = *held != value;
                if changed {
                    *held = value;
                }
                changed
            });
        }
    }
}

impl<T: PartialEq> Held<Option<T>> {
    /// The value is none, when it is `value`. Decided and written as one
    /// step, so a value set meanwhile is not the one let go.
    pub fn forget(&self, value: &T) {
        if let Some(sender) = locked(&self.sender).as_ref() {
            sender.send_if_modified(|held| {
                let is_it = held.as_ref() == Some(value);
                if is_it {
                    *held = None;
                }
                is_it
            });
        }
    }
}

/// What a unit has running: its listener, and each operation it started.
/// Stopped when the unit is disposed, after which nothing more is started.
pub(crate) struct Tasks {
    /// `None` once stopped.
    running: Mutex<Option<Running>>,
}

struct Running {
    tasks: JoinSet<()>,
    /// Each task's handle, by its id, until it is let go.
    handles: HashMap<task::Id, AbortHandle>,
}

impl Tasks {
    pub fn new() -> Tasks {
        Tasks {
            running: Mutex::new(Some(Running {
                tasks: JoinSet::new(),
                handles: HashMap::new(),
            })),
        }
    }

    pub fn spawn(&self, work: impl Future<Output = ()> + Send + 'static) {
        if let Some(running) = locked(&self.running).as_mut() {
            // What finished is let go here, where the next is started.
            while let Some(finished) = running.tasks.try_join_next_with_id() {
                let id = finished.map_or_else(|ended| ended.id(), |(id, ())| id);
                running.handles.remove(&id);
            }
            let handle = running.tasks.spawn(work);
            running.handles.insert(handle.id(), handle);
        }
    }

    pub fn stopped(&self) -> bool {
        locked(&self.running).is_none()
    }

    /// Stop everything running. A `JoinSet` that is dropped aborts its tasks.
    pub fn stop(&self) {
        *locked(&self.running) = None;
    }

    /// Stop everything running, and wait for it to have stopped. Asked from
    /// inside one of its own tasks, it does not wait for that one: its
    /// handle is given back, for the caller to stop it after its own last
    /// wait.
    pub async fn stop_and_wait(&self) -> Option<AbortHandle> {
        let mut running = locked(&self.running).take()?;
        let own = task::try_id().and_then(|id| running.handles.remove(&id));
        for handle in running.handles.values() {
            handle.abort();
        }
        while running.tasks.len() > usize::from(own.is_some()) {
            running.tasks.join_next().await;
        }
        // Only its own is left, if any: it is the caller's to stop.
        running.tasks.detach_all();
        own
    }
}

/// What a frame of the client's own bus says, when it is one of the channel
/// `C`. A frame whose payload is not that channel's says nothing: it came
/// over the wire from a participant this client does not answer for.
pub(crate) fn said<C: Channel>(frame: &Frame) -> Option<C::Payload> {
    if frame.channel != C::NAME {
        return None;
    }
    decoded::<C>(frame.payload.clone()).ok()
}

/// Say something to the client's own parts, as a namespace's signal does.
pub(crate) fn signal<C: Channel>(client: &SemiontClient, payload: &C::Payload, envelope: Envelope) {
    // A payload of the registry's types is always an object.
    let _ = client.bus().publish::<C>(payload, envelope);
}

/// Whether a delegated run ended because it was cancelled. Its commits
/// stand, so a unit keeps such a run's progress, to show how it ended.
pub(crate) fn cancelled(error: &SemiontError) -> bool {
    matches!(error, SemiontError::Job(job) if job.code == JobErrorCode::Cancelled)
}
