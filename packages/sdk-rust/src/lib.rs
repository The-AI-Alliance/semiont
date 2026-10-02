//! Semiont's Rust SDK: a client of a knowledge base (`client`), with a
//! namespace per flow of the protocol (`namespaces`), over any transport.
//! Under it: the protocol's types, channels, error codes and timing, as
//! specs/ states them; the transport contract and the bus client over it; a
//! client's own bus; the shapes a namespace's methods return (`running`,
//! `cached`), the cache its queries answer from and what refreshes it
//! (`cache`, `refresh`), where a client keeps what must outlive it
//! (`storage`), and the stream's place kept with the caches (`resume`); the flows held as state a consumer reads and watches
//! (`state`); a session with a knowledge base and the registry of the ones
//! an application has signed in to (`session`); the sign-ins `semiont login`
//! keeps, as a storage (`sign_in_store`); the media types a knowledge base
//! admits (`media_types`); the knowledge bases a launcher
//! manages (`discovery`); when a failure is worth another attempt;
//! how a knowledge base names its principals and the realm's roles; and the
//! bus log. It does no HTTP and links no telemetry:
//! `semiont-http-transport` carries it over a gateway.

#![forbid(unsafe_code)]
// What arrives off the wire is never assumed to be what was expected, and
// neither is anything else: the library has no `unwrap` and no `expect`.
#![cfg_attr(not(test), deny(clippy::unwrap_used, clippy::expect_used))]

pub mod bus;
pub mod bus_log;
pub mod cache;
pub mod cached;
pub mod channels;
pub mod client;
pub mod discovery;
pub mod errors;
pub mod event_bus;
pub mod identity;
pub mod media_types;
pub mod namespaces;
pub mod refresh;
pub mod resume;
pub mod retry;
pub mod roles;
pub mod running;
pub mod session;
pub mod sign_in_store;
pub mod state;
pub mod state_unit;
pub mod storage;
#[cfg(feature = "testing")]
pub mod testing;
pub mod timing;
pub mod transport;
pub mod types;

use std::sync::{Mutex, MutexGuard};

/// What `mutex` guards. A holder that panicked left it as it was, and it is
/// read as it is: nothing here is left half-written across a panic.
pub(crate) fn locked<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}
