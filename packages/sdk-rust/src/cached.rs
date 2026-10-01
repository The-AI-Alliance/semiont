//! A query of the knowledge base. Building one touches nothing, so a query is
//! made wherever it is convenient to name it; `fresh` asks the service now,
//! and gives what it answers or the failure it met.

use crate::errors::SemiontError;
use crate::transport::BoxFuture;
use std::future::Future;

/// See the module's documentation.
pub struct Cached<T> {
    ask: Box<dyn FnOnce() -> BoxFuture<'static, Result<T, SemiontError>> + Send>,
}

impl<T> Cached<T> {
    /// A query `ask` performs, each time it is asked.
    pub(crate) fn new<A, Fut>(ask: A) -> Cached<T>
    where
        A: FnOnce() -> Fut + Send + 'static,
        Fut: Future<Output = Result<T, SemiontError>> + Send + 'static,
    {
        Cached {
            ask: Box::new(move || Box::pin(ask())),
        }
    }

    /// The value now, from the service.
    pub async fn fresh(self) -> Result<T, SemiontError> {
        (self.ask)().await
    }
}
