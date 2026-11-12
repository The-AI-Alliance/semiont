//! A stream whose first reader is given what was said before it came: a
//! session's errors, a registry's, a transport's failures, and a worker's
//! stalls.

use crate::locked;
use crate::timing::ERRORS_KEPT_FOR_FIRST_READER_COUNT;
use crate::transport::{Events, STREAM_BACKLOG};
use std::sync::Mutex;
use tokio::sync::broadcast;

/// What is said on a stream, and what of it is kept for its first reader.
pub(crate) struct KeptForFirstReader<T> {
    /// The one sender, let go of as the stream ends, so it ends then.
    sender: Mutex<Option<broadcast::Sender<T>>>,
    /// The latest `ERRORS_KEPT_FOR_FIRST_READER_COUNT` said since the stream
    /// was made, for its first reader, until that reader comes or the stream
    /// ends.
    first: Mutex<Option<broadcast::Receiver<T>>>,
}

impl<T: Clone + Send + 'static> KeptForFirstReader<T> {
    pub(crate) fn new() -> KeptForFirstReader<T> {
        let (sender, first) = broadcast::channel(STREAM_BACKLOG);
        KeptForFirstReader {
            sender: Mutex::new(Some(sender)),
            first: Mutex::new(Some(first)),
        }
    }

    /// Say `said`, until the stream ends. While nobody has read, the oldest
    /// kept beyond `ERRORS_KEPT_FOR_FIRST_READER_COUNT` is dropped, under the
    /// lock the first reader takes what is kept under, so it is given no more.
    pub(crate) fn say(&self, said: T) {
        let mut first = locked(&self.first);
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

    /// For a first reader that is told rather than reads: what is kept, at
    /// once, in the order it was said. Each later one is given nothing.
    pub(crate) fn take_kept(&self) -> Vec<T> {
        let mut kept = Vec::new();
        // `say` keeps the first receiver within its backlog, so it never lags.
        if let Some(mut first) = locked(&self.first).take() {
            while let Ok(said) = first.try_recv() {
                kept.push(said);
            }
        }
        kept
    }

    /// End the stream: each reader is given what was said before, then its
    /// end. What was kept for a first reader who has not come is let go of.
    pub(crate) fn end(&self) {
        locked(&self.first).take();
        locked(&self.sender).take();
    }
}
