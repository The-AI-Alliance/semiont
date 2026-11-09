//! How long the accept loop's connections wait for a request, on tokio's
//! paused clock moved by hand, so a wait of any length is measured at once: a
//! connection's first head is given `request_head` from its opening; after an
//! answer, its next request is waited for `idle`, and a head it has begun is
//! given `request_head` from its first byte.

#[path = "../../http-transport/tests/quick_clock/mod.rs"]
mod quick_clock;

use axum::Router;
use axum::routing::get;
use quick_clock::QuickClock;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::time::{Instant, sleep};

const REQUEST_HEAD: Duration = Duration::from_secs(20);
const IDLE: Duration = Duration::from_secs(60);
/// How long before a wait would end a test writes what it writes.
const EARLY: Duration = Duration::from_secs(5);
/// A request's head, all but the blank line that ends it.
const HEAD: &[u8] = b"GET / HTTP/1.1\r\nHost: test\r\n";

/// `work`, which must end within twice the longest wait: a wait that never
/// ends fails the test instead of hanging it.
async fn guarded<T>(work: impl Future<Output = T>) -> T {
    tokio::time::timeout(IDLE * 2, work)
        .await
        .expect("it ended")
}

/// A connection to an accept loop of its own, which answers every request
/// `ok`, on a quick clock that lasts as long as the connection's test.
async fn connect() -> (TcpStream, QuickClock) {
    let clock = QuickClock::start();
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
    (TcpStream::connect(address).await.unwrap(), clock)
}

/// Read one whole answer, which must be `ok`.
async fn answered(connection: &mut TcpStream) {
    guarded(async {
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
    })
    .await;
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
    guarded(async {
        let mut chunk = [0u8; 1024];
        // A reset is a close too.
        if let Ok(read) = connection.read(&mut chunk).await {
            let written = String::from_utf8_lossy(&chunk[..read]);
            assert_eq!(read, 0, "written before the close: {written:?}");
        }
    })
    .await;
    since.elapsed()
}

/// That the connection waited `wait`: within the few steps the quick clock
/// may take while bytes cross the loopback, on either side, which is less
/// than `EARLY`.
fn assert_waited(waited: Duration, wait: Duration) {
    let slack = Duration::from_secs(2);
    assert!(
        waited > wait - slack && waited < wait + slack,
        "closed after {waited:?}, not {wait:?}"
    );
}

#[tokio::test(start_paused = true)]
async fn a_connection_that_sends_nothing_is_closed_request_head_after_it_opened() {
    let (mut connection, _clock) = connect().await;
    let opened = Instant::now();
    assert_waited(closed(&mut connection, opened).await, REQUEST_HEAD);
}

#[tokio::test(start_paused = true)]
async fn a_first_head_begun_late_must_still_be_whole_request_head_after_the_opening() {
    let (mut connection, _clock) = connect().await;
    let opened = Instant::now();
    sleep(REQUEST_HEAD - EARLY).await;
    connection.write_all(HEAD).await.unwrap();
    assert_waited(closed(&mut connection, opened).await, REQUEST_HEAD);
}

#[tokio::test(start_paused = true)]
async fn after_an_answer_a_connection_is_kept_idle_for_its_next_request_and_closed_after() {
    let (mut connection, _clock) = connect().await;
    ask(&mut connection).await;
    sleep(IDLE - EARLY).await;
    ask(&mut connection).await;
    let answered = Instant::now();
    assert_waited(closed(&mut connection, answered).await, IDLE);
}

#[tokio::test(start_paused = true)]
async fn after_an_answer_a_head_whole_within_request_head_of_its_first_byte_is_answered_past_idle()
{
    let (mut connection, _clock) = connect().await;
    ask(&mut connection).await;
    sleep(IDLE - EARLY).await;
    connection.write_all(HEAD).await.unwrap();
    sleep(REQUEST_HEAD - EARLY).await;
    connection.write_all(b"\r\n").await.unwrap();
    answered(&mut connection).await;
}

#[tokio::test(start_paused = true)]
async fn after_an_answer_a_head_left_unfinished_is_closed_request_head_after_its_first_byte() {
    let (mut connection, _clock) = connect().await;
    ask(&mut connection).await;
    sleep(IDLE - EARLY).await;
    connection.write_all(HEAD).await.unwrap();
    let begun = Instant::now();
    assert_waited(closed(&mut connection, begun).await, REQUEST_HEAD);
}
