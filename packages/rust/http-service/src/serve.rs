//! Connections a service can close from its side: a stream whose client
//! stopped reading is torn down from the service's end, with what the
//! connection held. And how long a connection waits for a request: for its
//! first, from its opening; for each after, from its answer to the next one's
//! first byte, and from there for the rest of its head.

use axum::body::Body;
use futures::task::AtomicWaker;
use hyper::rt::{Sleep, Timer};
use hyper_util::rt::TokioIo;
use std::io;
use std::pin::Pin;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::task::{Context, Poll};
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use tokio::net::{TcpListener, TcpStream};
use tower::ServiceExt;

/// Closes the connection a request arrived on: a stream whose client stopped
/// reading is torn down from this side, with what the connection held.
#[derive(Clone)]
pub struct ConnectionAbort(Arc<AbortState>);

struct AbortState {
    aborted: AtomicBool,
    waker: AtomicWaker,
}

impl ConnectionAbort {
    fn new() -> ConnectionAbort {
        ConnectionAbort(Arc::new(AbortState {
            aborted: AtomicBool::new(false),
            waker: AtomicWaker::new(),
        }))
    }

    pub fn abort(&self) {
        self.0.aborted.store(true, Ordering::SeqCst);
        self.0.waker.wake();
    }
}

struct Abortable {
    stream: TcpStream,
    state: Arc<AbortState>,
    /// The bytes read from the connection so far: a wait for a head sees its
    /// head begin when this moves.
    read: Arc<AtomicU64>,
}

impl Abortable {
    fn aborted(&self, cx: &Context<'_>) -> bool {
        self.state.waker.register(cx.waker());
        self.state.aborted.load(Ordering::SeqCst)
    }
}

fn closed() -> io::Error {
    io::Error::new(io::ErrorKind::ConnectionAborted, "closed by the service")
}

impl AsyncRead for Abortable {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        if self.aborted(cx) {
            return Poll::Ready(Err(closed()));
        }
        let before = buf.filled().len();
        let polled = Pin::new(&mut self.stream).poll_read(cx, buf);
        let read = buf.filled().len() - before;
        self.read.fetch_add(read as u64, Ordering::Relaxed);
        polled
    }
}

impl AsyncWrite for Abortable {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        if self.aborted(cx) {
            return Poll::Ready(Err(closed()));
        }
        Pin::new(&mut self.stream).poll_write(cx, buf)
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        if self.aborted(cx) {
            return Poll::Ready(Err(closed()));
        }
        Pin::new(&mut self.stream).poll_flush(cx)
    }

    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.stream).poll_shutdown(cx)
    }
}

/// hyper's clock for a request's head (its `header_read_timeout`), which it
/// starts each time it begins to wait for a head: as the connection opens, and
/// as each answer ends. A connection's first head keeps that clock. A later
/// head's clock starts at its first byte instead, and that byte is waited for
/// `idle`.
struct HeadClock {
    idle: Duration,
    /// The connection's [`Abortable::read`].
    read: Arc<AtomicU64>,
    /// Whether the connection has begun to wait for a head before.
    waited: AtomicBool,
}

impl Timer for HeadClock {
    fn sleep(&self, duration: Duration) -> Pin<Box<dyn Sleep>> {
        Box::pin(HeadWait {
            sleep: Box::pin(tokio::time::sleep(duration)),
            unbegun: None,
        })
    }

    fn sleep_until(&self, deadline: std::time::Instant) -> Pin<Box<dyn Sleep>> {
        let deadline = tokio::time::Instant::from_std(deadline);
        if !self.waited.swap(true, Ordering::Relaxed) {
            return Box::pin(HeadWait {
                sleep: Box::pin(tokio::time::sleep_until(deadline)),
                unbegun: None,
            });
        }
        let began = tokio::time::Instant::now();
        Box::pin(HeadWait {
            sleep: Box::pin(tokio::time::sleep_until(began + self.idle)),
            unbegun: Some(Unbegun {
                began,
                deadline,
                read: self.read.clone(),
                read_when_began: self.read.load(Ordering::Relaxed),
            }),
        })
    }

    fn now(&self) -> std::time::Instant {
        tokio::time::Instant::now().into_std()
    }
}

/// A wait for a request's head. While its head has not begun, it ends `idle`
/// after it began; once the head's first byte is read, it ends hyper's
/// deadline later than it would have, by however long that byte took.
struct HeadWait {
    sleep: Pin<Box<tokio::time::Sleep>>,
    unbegun: Option<Unbegun>,
}

/// A later head, before its first byte.
struct Unbegun {
    began: tokio::time::Instant,
    /// hyper's deadline for the head, counted from `began`.
    deadline: tokio::time::Instant,
    read: Arc<AtomicU64>,
    read_when_began: u64,
}

impl Future for HeadWait {
    type Output = ();

    fn poll(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<()> {
        let wait = &mut *self;
        // hyper polls this wait as soon as a read leaves its head unfinished,
        // so the head's first byte was read in this same poll.
        if let Some(unbegun) = &wait.unbegun
            && unbegun.read.load(Ordering::Relaxed) != unbegun.read_when_began
        {
            let deadline = unbegun.deadline + unbegun.began.elapsed();
            wait.sleep.as_mut().reset(deadline);
            wait.unbegun = None;
        }
        wait.sleep.as_mut().poll(cx)
    }
}

impl Sleep for HeadWait {}

/// Serve `router` on `listener` until `stop` resolves; then accept nothing more.
/// A connection past `connections` open at once is closed unanswered
/// (capacity), and `refused` is told. A connection is closed with nothing
/// written to it when its first request's head has not come whole
/// `request_head` after it opened; when, after an answer, its next request has
/// not begun `idle` later; or when a head it began after an answer has not come
/// whole `request_head` after its first byte. A slow head is held to
/// `request_head`, and an idle connection is kept the longer `idle`: a client
/// that pools it for less is never writing a request to it as this side
/// closes it.
pub async fn serve(
    listener: TcpListener,
    router: axum::Router,
    connections: usize,
    request_head: Duration,
    idle: Duration,
    refused: fn(),
    stop: impl std::future::Future<Output = ()>,
) {
    tokio::pin!(stop);
    let open = Arc::new(AtomicUsize::new(0));
    loop {
        tokio::select! {
            accepted = listener.accept() => {
                let Ok((stream, _)) = accepted else { continue };
                if open.load(Ordering::SeqCst) >= connections {
                    drop(stream);
                    refused();
                    continue;
                }
                open.fetch_add(1, Ordering::SeqCst);
                let _ = stream.set_nodelay(true);
                let (open, router) = (open.clone(), router.clone());
                tokio::spawn(async move {
                    connection(stream, router, request_head, idle).await;
                    open.fetch_sub(1, Ordering::SeqCst);
                });
            }
            () = &mut stop => break,
        }
    }
}

async fn connection(
    stream: TcpStream,
    router: axum::Router,
    request_head: Duration,
    idle: Duration,
) {
    let abort = ConnectionAbort::new();
    let read = Arc::new(AtomicU64::new(0));
    let io = TokioIo::new(Abortable {
        stream,
        state: abort.0.clone(),
        read: read.clone(),
    });
    let service = hyper::service::service_fn(
        move |mut request: axum::http::Request<hyper::body::Incoming>| {
            request.extensions_mut().insert(abort.clone());
            router.clone().oneshot(request.map(Body::new))
        },
    );
    let _ = hyper::server::conn::http1::Builder::new()
        .timer(HeadClock {
            idle,
            read,
            waited: AtomicBool::new(false),
        })
        .header_read_timeout(request_head)
        .serve_connection(io, service)
        .await;
}
