//! A long-running operation: what it reports as it goes, then its final
//! value.
//!
//! A `Running` is consumed one of three ways, and each takes it by value, so
//! one operation is never started twice:
//!
//! - awaited, it gives the final value;
//! - as a stream, it gives every report, then the final value, then ends; a
//!   failure is its last item;
//! - `run` gives each of those to a function and then returns the final value.
//!
//! Nothing is sent until it is first polled, and dropping it abandons the
//! operation: what was sent stays sent, and nothing more is.
//!
//! An operation may end in something it never reports (`Running<T, F>`):
//! awaited it gives that, and as a stream its last item is that value as a
//! report.

use crate::errors::{BusRequestError, BusRequestErrorCode, SemiontError};
use crate::transport::BoxFuture;
use futures_core::Stream;
use std::future::{Future, IntoFuture};
use std::pin::Pin;
use std::task::{Context, Poll};
use tokio::sync::mpsc;

/// Where an operation's work reports what happens before its final value.
pub struct Reporter<T> {
    reports: mpsc::UnboundedSender<T>,
}

impl<T> Reporter<T> {
    /// Report one value. Nobody may be listening: an awaited operation's
    /// reports are discarded.
    pub fn report(&self, value: T) {
        let _ = self.reports.send(value);
    }
}

/// See the module's documentation. `T` is what it reports, and `F` its final
/// value: the same, unless the operation ends in something it never reports.
pub struct Running<T, F = T> {
    reports: mpsc::UnboundedReceiver<T>,
    work: Option<BoxFuture<'static, Result<F, SemiontError>>>,
    outcome: Option<Result<F, SemiontError>>,
}

// Nothing in it is pinned in place: the work is boxed, and a value is only
// ever moved out.
impl<T, F> Unpin for Running<T, F> {}

impl<T: Send + 'static, F: Send + 'static> Running<T, F> {
    /// An operation `work` performs: it reports through the `Reporter` it is
    /// given and resolves with the final value.
    pub fn new<W, Fut>(work: W) -> Running<T, F>
    where
        W: FnOnce(Reporter<T>) -> Fut,
        Fut: Future<Output = Result<F, SemiontError>> + Send + 'static,
    {
        let (reports, receiver) = mpsc::unbounded_channel();
        Running {
            reports: receiver,
            work: Some(Box::pin(work(Reporter { reports }))),
            outcome: None,
        }
    }

    fn drive(&mut self, cx: &mut Context<'_>) {
        if let Some(work) = self.work.as_mut()
            && let Poll::Ready(outcome) = work.as_mut().poll(cx)
        {
            self.outcome = Some(outcome);
            self.work = None;
        }
    }
}

impl<T: Send + 'static, F: Into<T> + Send + 'static> Running<T, F> {
    /// The next report, the final value after the last of them, or the
    /// failure; `None` once one of the last two has been given.
    pub async fn next(&mut self) -> Option<Result<T, SemiontError>> {
        std::future::poll_fn(|cx| Pin::new(&mut *self).poll_next(cx)).await
    }
}

impl<T: Send + 'static> Running<T> {
    /// Give every report and the final value to `on_each`, in order, then
    /// return the final value.
    pub async fn run(mut self, mut on_each: impl FnMut(&T)) -> Result<T, SemiontError> {
        let mut last = None;
        while let Some(item) = self.next().await {
            let value = item?;
            on_each(&value);
            last = Some(value);
        }
        // The stream's last item is the work's outcome, so one that ended
        // without a failure gave a final value.
        last.ok_or_else(ended_without_a_value)
    }
}

fn ended_without_a_value() -> SemiontError {
    BusRequestError::new(
        BusRequestErrorCode::Closed,
        "The operation ended before it gave a value",
    )
    .into()
}

impl<T: Send + 'static, F: Into<T> + Send + 'static> Stream for Running<T, F> {
    type Item = Result<T, SemiontError>;

    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        self.drive(cx);
        match self.reports.poll_recv(cx) {
            Poll::Ready(Some(report)) => Poll::Ready(Some(Ok(report))),
            // Every report has been given and the work is done: its outcome
            // is the last item, and after it the stream has ended.
            Poll::Ready(None) | Poll::Pending if self.work.is_none() => {
                Poll::Ready(self.outcome.take().map(|outcome| outcome.map(Into::into)))
            }
            // The work goes on, whether or not it still holds its `Reporter`.
            Poll::Ready(None) | Poll::Pending => Poll::Pending,
        }
    }
}

impl<T: Send + 'static, F: Send + 'static> IntoFuture for Running<T, F> {
    type Output = Result<F, SemiontError>;
    type IntoFuture = BoxFuture<'static, Self::Output>;

    fn into_future(mut self) -> Self::IntoFuture {
        Box::pin(async move {
            std::future::poll_fn(|cx| {
                self.drive(cx);
                match self.outcome.take() {
                    Some(outcome) => Poll::Ready(outcome),
                    None => Poll::Pending,
                }
            })
            .await
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn refused() -> SemiontError {
        BusRequestError::new(BusRequestErrorCode::Rejected, "refused").into()
    }

    fn counting_to(last: u32) -> Running<u32> {
        Running::new(move |reporter| async move {
            for n in 1..last {
                reporter.report(n);
                tokio::task::yield_now().await;
            }
            Ok(last)
        })
    }

    #[tokio::test]
    async fn awaited_it_gives_the_final_value() {
        assert_eq!(counting_to(3).await, Ok(3));
    }

    #[tokio::test]
    async fn as_a_stream_it_gives_every_report_then_the_final_value_then_ends() {
        let mut running = counting_to(3);
        let mut seen = Vec::new();
        while let Some(item) = running.next().await {
            seen.push(item);
        }
        assert_eq!(seen, [Ok(1), Ok(2), Ok(3)]);
        assert_eq!(running.next().await, None);
    }

    #[tokio::test]
    async fn run_gives_each_value_in_order_and_returns_the_last() {
        let mut seen = Vec::new();
        let last = counting_to(3).run(|n| seen.push(*n)).await;
        assert_eq!(last, Ok(3));
        assert_eq!(seen, [1, 2, 3]);
    }

    #[tokio::test]
    async fn one_that_ends_in_another_type_gives_it_awaited_and_as_its_last_report() {
        let ending = || -> Running<u64, u32> {
            Running::new(|reporter| async move {
                reporter.report(1_u64);
                Ok(2_u32)
            })
        };
        assert_eq!(ending().await, Ok(2_u32));
        let mut running = ending();
        assert_eq!(running.next().await, Some(Ok(1_u64)));
        assert_eq!(running.next().await, Some(Ok(2_u64)));
        assert_eq!(running.next().await, None);
    }

    #[tokio::test]
    async fn a_failure_is_the_streams_last_item_after_what_was_reported() {
        let mut running: Running<u32> = Running::new(|reporter| async move {
            reporter.report(1);
            Err(refused())
        });
        assert_eq!(running.next().await, Some(Ok(1)));
        assert_eq!(running.next().await, Some(Err(refused())));
        assert_eq!(running.next().await, None);
    }

    #[tokio::test]
    async fn a_failure_is_what_awaiting_and_running_return() {
        let failing = || -> Running<u32> { Running::new(|_| async { Err(refused()) }) };
        assert_eq!(failing().await, Err(refused()));
        assert_eq!(failing().run(|_| {}).await, Err(refused()));
    }

    #[tokio::test]
    async fn nothing_runs_until_it_is_polled_and_dropping_it_stops_the_work() {
        let (started, mut was_started) = mpsc::unbounded_channel();
        let (finished, mut was_finished) = mpsc::unbounded_channel::<()>();
        let mut running: Running<u32> = Running::new(move |reporter| async move {
            let _ = started.send(());
            reporter.report(1);
            std::future::pending::<()>().await;
            let _ = finished.send(());
            Ok(2)
        });
        tokio::task::yield_now().await;
        assert!(was_started.try_recv().is_err());

        assert_eq!(running.next().await, Some(Ok(1)));
        assert!(was_started.try_recv().is_ok());
        drop(running);
        assert!(was_finished.recv().await.is_none());
    }
}
