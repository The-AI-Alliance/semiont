//! A search as it is typed: a query, and the results of the query it last
//! settled on.
//!
//! The query is whatever was last set. Once it has stayed the same for the
//! debounce, it is searched for, unless it is the query already searched
//! for. A query of nothing but spaces searches for nothing and has no
//! results. A new query abandons the search before it.
//!
//! What it searches with is a function from a query to a stream of answers:
//! `None` while the answer is on its way, the results once it is known, and
//! again each time they change. A watched query of the client is such a
//! stream, once each of its states is read as one or the other.

use super::{Held, Tasks};
use crate::state_unit::StateUnit;
use crate::timing::SEARCH_DEBOUNCE;
use futures_core::Stream;
use std::future::{pending, poll_fn};
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::watch;
use tokio::time::Instant;

/// What a search shows: its results, and whether more are on their way.
#[derive(Debug, Clone, PartialEq)]
pub struct SearchState<T> {
    pub results: Vec<T>,
    pub is_searching: bool,
}

impl<T> SearchState<T> {
    fn of(results: Vec<T>, is_searching: bool) -> SearchState<T> {
        SearchState {
            results,
            is_searching,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SearchPipelineOptions {
    /// How long the query must stay the same before it is searched for.
    pub debounce: Duration,
    /// The query it begins with.
    pub initial_query: String,
}

impl Default for SearchPipelineOptions {
    fn default() -> SearchPipelineOptions {
        SearchPipelineOptions {
            debounce: SEARCH_DEBOUNCE,
            initial_query: String::new(),
        }
    }
}

type Answers<T> = Pin<Box<dyn Stream<Item = Option<Vec<T>>> + Send>>;

struct Shared<T> {
    query: Held<String>,
    state: Held<SearchState<T>>,
    tasks: Tasks,
}

/// See the module's documentation.
pub struct SearchPipeline<T> {
    shared: Arc<Shared<T>>,
}

impl<T: Clone + PartialEq + Send + Sync + 'static> SearchPipeline<T> {
    pub fn new<F, S>(search: F, options: SearchPipelineOptions) -> SearchPipeline<T>
    where
        F: Fn(&str) -> S + Send + 'static,
        S: Stream<Item = Option<Vec<T>>> + Send + 'static,
    {
        let shared = Arc::new(Shared {
            query: Held::new(options.initial_query),
            state: Held::new(SearchState::of(Vec::new(), false)),
            tasks: Tasks::new(),
        });
        shared.tasks.spawn(run(
            shared.clone(),
            move |query: &str| -> Answers<T> { Box::pin(search(query)) },
            options.debounce,
        ));
        SearchPipeline { shared }
    }

    /// The query as it was last set.
    pub fn query(&self) -> watch::Receiver<String> {
        self.shared.query.read()
    }

    pub fn state(&self) -> watch::Receiver<SearchState<T>> {
        self.shared.state.read()
    }

    pub fn set_query(&self, value: &str) {
        self.shared.query.set(value.to_owned());
    }
}

async fn run<T: Clone + PartialEq + Send + Sync + 'static>(
    shared: Arc<Shared<T>>,
    search: impl Fn(&str) -> Answers<T> + Send,
    debounce: Duration,
) {
    let mut query = shared.query.read();
    // The query it begins with settles like any other.
    let mut settles = Some(Instant::now() + debounce);
    let mut searched: Option<String> = None;
    let mut answers: Option<Answers<T>> = None;
    loop {
        tokio::select! {
            // In this order, so a query that changes as it settles is not
            // searched for: it has not stayed the same.
            biased;
            changed = query.changed() => {
                if changed.is_err() {
                    return;
                }
                settles = Some(Instant::now() + debounce);
            }
            () = async {
                match settles {
                    Some(at) => tokio::time::sleep_until(at).await,
                    None => pending().await,
                }
            } => {
                settles = None;
                let settled = query.borrow_and_update().clone();
                if searched.as_ref() == Some(&settled) {
                    continue;
                }
                let wanted = settled.trim().to_owned();
                searched = Some(settled);
                if wanted.is_empty() {
                    answers = None;
                    shared.state.set(SearchState::of(Vec::new(), false));
                } else {
                    shared.state.set(SearchState::of(Vec::new(), true));
                    answers = Some(search(&wanted));
                }
            }
            answer = async {
                match answers.as_mut() {
                    Some(answers) => poll_fn(|cx| answers.as_mut().poll_next(cx)).await,
                    None => pending().await,
                }
            } => match answer {
                Some(results) => {
                    let is_searching = results.is_none();
                    shared
                        .state
                        .set(SearchState::of(results.unwrap_or_default(), is_searching));
                }
                None => answers = None,
            },
        }
    }
}

impl<T> StateUnit for SearchPipeline<T> {
    fn dispose(&self) {
        self.shared.tasks.stop();
        self.shared.query.end();
        self.shared.state.end();
    }
}

impl<T> Drop for SearchPipeline<T> {
    fn drop(&mut self) {
        self.dispose();
    }
}
