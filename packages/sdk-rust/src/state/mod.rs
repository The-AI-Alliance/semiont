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
pub use yield_::{YieldOutcome, YieldStateUnit};

use crate::bus::decoded;
use crate::channels::Channel;
use crate::client::SemiontClient;
use crate::locked;
use crate::transport::{Envelope, Frame};
use std::future::Future;
use std::sync::Mutex;
use tokio::sync::watch;
use tokio::task::JoinSet;

/// One state a unit holds. Anyone reads it and only the unit writes it. Once
/// it has ended every reader has ended, and a write does nothing.
pub(crate) struct Held<T> {
    /// `None` once ended.
    sender: Mutex<Option<watch::Sender<T>>>,
    /// A reader of the same state, for the value now and for the readers
    /// taken after it ended.
    reader: watch::Receiver<T>,
}

impl<T: Clone + PartialEq> Held<T> {
    pub fn new(initial: T) -> Held<T> {
        let (sender, reader) = watch::channel(initial);
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

    pub fn now(&self) -> T {
        self.reader.borrow().clone()
    }

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

impl<T> Held<T> {
    pub fn end(&self) {
        *locked(&self.sender) = None;
    }
}

/// What a unit has running: its listener, and each operation it started.
/// Stopped when the unit is disposed, after which nothing more is started.
pub(crate) struct Tasks {
    /// `None` once stopped.
    running: Mutex<Option<JoinSet<()>>>,
}

impl Tasks {
    pub fn new() -> Tasks {
        Tasks {
            running: Mutex::new(Some(JoinSet::new())),
        }
    }

    pub fn spawn(&self, work: impl Future<Output = ()> + Send + 'static) {
        if let Some(running) = locked(&self.running).as_mut() {
            // What finished is let go here, where the next is started.
            while running.try_join_next().is_some() {}
            running.spawn(work);
        }
    }

    pub fn stopped(&self) -> bool {
        locked(&self.running).is_none()
    }

    /// Stop everything running. A `JoinSet` that is dropped aborts its tasks.
    pub fn stop(&self) {
        *locked(&self.running) = None;
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
