//! How long the accept loop's connections wait for a request, on tokio's
//! paused clock, so a wait of any length is measured at once: a connection's
//! first head is given `request_head` from its opening; after an answer, its
//! next request is waited for `idle`, and a head it has begun is given
//! `request_head` from its first byte.

use axum::Router;
use axum::routing::get;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::time::{Instant, sleep};

const REQUEST_HEAD: Duration = Duration::from_secs(3);
const IDLE: Duration = Duration::from_secs(12);
/// A request's head, all but the blank line that ends it.
const HEAD: &[u8] = b"GET / HTTP/1.1\r\nHost: test\r\n";
/// What the timer may add to a wait: tokio counts its deadlines in whole milliseconds.
const TICK: Duration = Duration::from_millis(1);

/// A connection to an accept loop of its own, which answers every request `ok`.
async fn connect() -> TcpStream {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let router = Router::new().route("/", get(|| async { "ok" }));
    tokio::spawn(semiont_http_service::serve(
        listener,
        router,
        8,
        REQUEST_HEAD,
        IDLE,
        || {},
        std::future::pending::<()>(),
    ));
    TcpStream::connect(address).await.unwrap()
}

/// Read one whole answer, which must be `ok`.
async fn answered(connection: &mut TcpStream) {
    let mut answer = Vec::new();
    let mut chunk = [0u8; 1024];
    while !answer.ends_with(b"\r\n\r\nok") {
        let read = connection.read(&mut chunk).await.unwrap();
        let so_far = String::from_utf8_lossy(&answer);
        assert_ne!(read, 0, "closed before its answer came whole: {so_far:?}");
        answer.extend_from_slice(&chunk[..read]);
    }
    let answer = String::from_utf8_lossy(&answer);
    assert!(answer.starts_with("HTTP/1.1 200"), "{answer:?}");
}

/// Write a whole request at once, and read its answer.
async fn ask(connection: &mut TcpStream) {
    connection
        .write_all(&[HEAD, b"\r\n"].concat())
        .await
        .unwrap();
    answered(connection).await;
}

/// How long after `since` the connection is closed, with nothing more written to it.
async fn closed(connection: &mut TcpStream, since: Instant) -> Duration {
    let mut chunk = [0u8; 1024];
    // A reset is a close too.
    if let Ok(read) = connection.read(&mut chunk).await {
        let written = String::from_utf8_lossy(&chunk[..read]);
        assert_eq!(read, 0, "written before the close: {written:?}");
    }
    since.elapsed()
}

fn assert_waited(waited: Duration, wait: Duration) {
    assert!(
        waited >= wait && waited <= wait + TICK,
        "closed after {waited:?}, not {wait:?}"
    );
}

#[tokio::test(start_paused = true)]
async fn a_connection_that_sends_nothing_is_closed_request_head_after_it_opened() {
    let mut connection = connect().await;
    let opened = Instant::now();
    assert_waited(closed(&mut connection, opened).await, REQUEST_HEAD);
}

#[tokio::test(start_paused = true)]
async fn a_first_head_begun_late_must_still_be_whole_request_head_after_the_opening() {
    let mut connection = connect().await;
    let opened = Instant::now();
    sleep(REQUEST_HEAD - Duration::from_secs(1)).await;
    connection.write_all(HEAD).await.unwrap();
    assert_waited(closed(&mut connection, opened).await, REQUEST_HEAD);
}

#[tokio::test(start_paused = true)]
async fn after_an_answer_a_connection_is_kept_idle_for_its_next_request_and_closed_after() {
    let mut connection = connect().await;
    ask(&mut connection).await;
    sleep(IDLE - Duration::from_secs(1)).await;
    ask(&mut connection).await;
    let answered = Instant::now();
    assert_waited(closed(&mut connection, answered).await, IDLE);
}

#[tokio::test(start_paused = true)]
async fn after_an_answer_a_head_whole_within_request_head_of_its_first_byte_is_answered_past_idle()
{
    let mut connection = connect().await;
    ask(&mut connection).await;
    sleep(IDLE - Duration::from_secs(1)).await;
    connection.write_all(HEAD).await.unwrap();
    sleep(REQUEST_HEAD - Duration::from_secs(1)).await;
    connection.write_all(b"\r\n").await.unwrap();
    answered(&mut connection).await;
}

#[tokio::test(start_paused = true)]
async fn after_an_answer_a_head_left_unfinished_is_closed_request_head_after_its_first_byte() {
    let mut connection = connect().await;
    ask(&mut connection).await;
    sleep(IDLE - Duration::from_secs(1)).await;
    connection.write_all(HEAD).await.unwrap();
    let begun = Instant::now();
    assert_waited(closed(&mut connection, begun).await, REQUEST_HEAD);
}
