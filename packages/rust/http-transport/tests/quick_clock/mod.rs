//! The clock of a test that waits out long times over real sockets, in a
//! test whose runtime starts paused: the one every such test of the HTTP
//! crates runs on. This crate's sign-in tests and its renewal's own tests
//! take it as a module, and so do the HTTP service's accept-loop tests.
//!
//! A paused clock alone will not do. It runs ahead to the next timer
//! whenever nothing is runnable, and bytes on their way over a socket are
//! not runnable: a wait for them would end before they could arrive. So the
//! clock is held still, which the runtime does while a blocking task runs,
//! and moved by hand, `STEP` for each real millisecond. What is on its way
//! arrives long before any wait for it ends, and thirty seconds take an
//! eighth of one.

use std::time::Duration;

/// How far the clock moves for each real millisecond.
pub const STEP: Duration = Duration::from_millis(250);

/// See the module's documentation. It moves the clock for as long as it is
/// held.
pub struct QuickClock(tokio::task::JoinHandle<()>);

impl QuickClock {
    pub fn start() -> QuickClock {
        QuickClock(tokio::spawn(async {
            loop {
                let _ = tokio::task::spawn_blocking(|| {
                    std::thread::sleep(Duration::from_millis(1));
                })
                .await;
                tokio::time::advance(STEP).await;
            }
        }))
    }
}

impl Drop for QuickClock {
    fn drop(&mut self) {
        self.0.abort();
    }
}
