//! A stream whose first reader is given what was said before it came: a
//! session's errors, a registry's, a transport's failures, and a worker's
//! stalls.

use crate::locked;
use crate::timing::ERRORS_KEPT_FOR_FIRST_READER_COUNT;
use crate::transport::{Events, STREAM_BACKLOG};
use std::sync::Mutex;
use tokio::sync::broadcast;

/// Told each thing said on a stream, within its saying.
pub(crate) type Listener<T> = Box<dyn Fn(&T) + Send + Sync>;

/// What is said on a stream, and what of it is kept for its first reader.
pub(crate) struct KeptForFirstReader<T> {
    /// The one sender, let go of as the stream ends, so it ends then.
    sender: Mutex<Option<broadcast::Sender<T>>>,
    /// The latest `ERRORS_KEPT_FOR_FIRST_READER_COUNT` said since the stream
    /// was made, for its first reader, until that reader comes or the stream
    /// ends.
    first: Mutex<Option<broadcast::Receiver<T>>>,
    /// Each told what is said, until the stream ends.
    listeners: Mutex<Vec<Listener<T>>>,
}

impl<T: Clone + Send + 'static> KeptForFirstReader<T> {
    pub(crate) fn new() -> KeptForFirstReader<T> {
        let (sender, first) = broadcast::channel(STREAM_BACKLOG);
        KeptForFirstReader {
            sender: Mutex::new(Some(sender)),
            first: Mutex::new(Some(first)),
            listeners: Mutex::new(Vec::new()),
        }
    }

    /// Say `said`, until the stream ends: each listener is told it, and then
    /// each reader is sent it. While nobody has read, the oldest kept beyond
    /// `ERRORS_KEPT_FOR_FIRST_READER_COUNT` is dropped, under the lock the
    /// first reader takes what is kept under, so it is given no more. A
    /// listener is told under that lock too, so it must not say anything on
    /// the stream it is told of.
    pub(crate) fn say(&self, said: T) {
        let mut first = locked(&self.first);
        for listener in locked(&self.listeners).iter() {
            listener(&said);
        }
        if let Some(sender) = locked(&self.sender).as_ref() {
            let _ = sender.send(said);
        }
        if let Some(first) = first.as_mut() {
            while first.len() > ERRORS_KEPT_FOR_FIRST_READER_COUNT {
                let _ = first.try_recv();
            }
        }
    }

    /// The first reader: what is kept, then what is said after. Each later
    /// one: what is said from now on. One after the end: only the end.
    pub(crate) fn read(&self) -> Events<T> {
        if let Some(first) = locked(&self.first).take() {
            return Events::new(first);
        }
        match locked(&self.sender).as_ref() {
            Some(sender) => Events::new(sender.subscribe()),
            None => Events::new(broadcast::channel(1).1),
        }
    }

    /// Tell `listener` each thing said from now on, within its saying, so it
    /// misses none however much is said at once. Taken first, it is told at
    /// once what is kept, in the order it was said, as one step with its
    /// being taken. One taken after the end is told nothing.
    pub(crate) fn tell_to(&self, listener: Listener<T>) {
        let mut first = locked(&self.first);
        // `say` keeps the first receiver within its backlog, so it never lags.
        if let Some(mut kept) = first.take() {
            while let Ok(said) = kept.try_recv() {
                listener(&said);
            }
        }
        if locked(&self.sender).is_some() {
            locked(&self.listeners).push(listener);
        }
    }

    /// End the stream: each reader is given what was said before, then its
    /// end, and each listener is let go of. What was kept for a first reader
    /// who has not come is let go of. All of it under the lock `say` holds, so
    /// nothing said as the stream ends reaches a listener once its readers
    /// have been let go of.
    pub(crate) fn end(&self) {
        let mut first = locked(&self.first);
        first.take();
        locked(&self.sender).take();
        locked(&self.listeners).clear();
    }
}
