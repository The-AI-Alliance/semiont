//! Connections a service can close from its side: a stream whose client
//! stopped reading is torn down from the service's end, with what the
//! connection held.

use axum::body::Body;
use futures::task::AtomicWaker;
use hyper_util::rt::{TokioIo, TokioTimer};
use std::io;
use std::pin::Pin;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::task::{Context, Poll};
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
        Pin::new(&mut self.stream).poll_read(cx, buf)
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

/// Serve `router` on `listener` until `stop` resolves; then accept nothing more.
/// A connection past `connections` open at once is closed unanswered
/// (capacity), and `refused` is told.
pub async fn serve(
    listener: TcpListener,
    router: axum::Router,
    connections: usize,
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
                    connection(stream, router).await;
                    open.fetch_sub(1, Ordering::SeqCst);
                });
            }
            () = &mut stop => break,
        }
    }
}

async fn connection(stream: TcpStream, router: axum::Router) {
    let abort = ConnectionAbort::new();
    let io = TokioIo::new(Abortable {
        stream,
        state: abort.0.clone(),
    });
    let service = hyper::service::service_fn(
        move |mut request: axum::http::Request<hyper::body::Incoming>| {
            request.extensions_mut().insert(abort.clone());
            router.clone().oneshot(request.map(Body::new))
        },
    );
    let _ = hyper::server::conn::http1::Builder::new()
        .timer(TokioTimer::new())
        .serve_connection(io, service)
        .await;
}
