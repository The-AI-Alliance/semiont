//! A live query: one of a client's reads that answers from its cache
//! (`crate::cache`) and stays true as the knowledge base changes.
//!
//! Building one touches nothing, so a query is made wherever it is
//! convenient to name it. It is then read one of two ways:
//!
//! - `watch` is the live view: the query's state now, and each state after
//!   it. Watching is what asks: the first watcher of a query nobody has
//!   asked starts its fetch. While a query of one resource is watched, the
//!   client holds that resource's scope, so the events that keep the query
//!   true reach it.
//! - `fresh` is the one-shot read: it asks the service now, and gives what
//!   it answers or the failure it met. Every watcher of the query is given
//!   the answer too.
//!
//! `invalidate` says the value is out of date: it is asked for again, and
//! shown meanwhile.

use crate::cache::{Cache, CacheKey, CacheState, CacheValue};
use crate::errors::SemiontError;
use crate::transport::{BoxFuture, ResourceHold, Transport};
use crate::types::ResourceId;
use futures_core::Stream;
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};
use tokio_stream::wrappers::WatchStream;

/// What a query answers from: the namespace that made the query supplies it.
pub(crate) trait Source<T>: Send + Sync {
    fn fresh(&self) -> BoxFuture<'static, Result<T, SemiontError>>;
    fn watch(&self) -> Observed<T>;
    fn invalidate(&self);
}

/// See the module's documentation.
pub struct Cached<T> {
    source: Box<dyn Source<T>>,
}

impl<T> Cached<T> {
    pub(crate) fn of(source: impl Source<T> + 'static) -> Cached<T> {
        Cached {
            source: Box::new(source),
        }
    }

    /// The value now, from the service.
    pub async fn fresh(&self) -> Result<T, SemiontError> {
        self.source.fresh().await
    }

    /// The query's state, now and as it changes.
    pub fn watch(&self) -> Observed<T> {
        self.source.watch()
    }

    /// The value is out of date: ask again, showing it meanwhile.
    pub fn invalidate(&self) {
        self.source.invalidate();
    }
}

/// A watched query: its state now, then each state after it, until the
/// client is closed. A watcher that falls behind is given the latest state,
/// not each one it missed: a state is what is true now.
pub struct Observed<T> {
    states: Pin<Box<dyn Stream<Item = CacheState<T>> + Send>>,
    /// The hold on the query's resource, let go when the watcher is.
    _scope: Option<ResourceHold>,
}

impl<T> Observed<T> {
    pub(crate) fn new(
        states: impl Stream<Item = CacheState<T>> + Send + 'static,
        scope: Option<ResourceHold>,
    ) -> Observed<T> {
        Observed {
            states: Box::pin(states),
            _scope: scope,
        }
    }

    /// The next state; `None` once the client is closed.
    pub async fn next(&mut self) -> Option<CacheState<T>> {
        std::future::poll_fn(|cx| self.states.as_mut().poll_next(cx)).await
    }
}

impl<T> Stream for Observed<T> {
    type Item = CacheState<T>;

    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        self.states.as_mut().poll_next(cx)
    }
}

/// A query answered by one key of one cache, as `view` shows its value.
pub(crate) struct Keyed<K: CacheKey, V: CacheValue, T> {
    pub cache: Cache<K, V>,
    pub key: K,
    pub view: fn(V) -> T,
    /// The resource the query is of, and what holds its scope while the
    /// query is watched.
    pub scope: Option<(Arc<dyn Transport>, ResourceId)>,
}

struct Viewed<V, T> {
    states: WatchStream<CacheState<V>>,
    view: fn(V) -> T,
}

impl<V: CacheValue, T> Stream for Viewed<V, T> {
    type Item = CacheState<T>;

    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        let view = self.view;
        Pin::new(&mut self.states)
            .poll_next(cx)
            .map(|state| state.map(|state| state.map(view)))
    }
}

impl<K, V, T> Source<T> for Keyed<K, V, T>
where
    K: CacheKey,
    V: CacheValue,
    T: 'static,
{
    fn fresh(&self) -> BoxFuture<'static, Result<T, SemiontError>> {
        let fetching = self.cache.fetch(&self.key);
        let view = self.view;
        Box::pin(async move { fetching.await.map(view) })
    }

    fn watch(&self) -> Observed<T> {
        // The scope first, so the events that refresh the key are already
        // coming when its value arrives.
        let scope = self
            .scope
            .as_ref()
            .map(|(transport, resource_id)| transport.subscribe_to_resource(resource_id));
        Observed::new(
            Viewed {
                states: self.cache.observe(&self.key),
                view: self.view,
            },
            scope,
        )
    }

    fn invalidate(&self) {
        self.cache.invalidate(&self.key);
    }
}
