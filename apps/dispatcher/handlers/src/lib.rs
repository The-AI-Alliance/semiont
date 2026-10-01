//! The dispatcher's handlers (docs/protocol/JOBS.md) and the job queue they
//! drive, held as a contract (`queue::JobQueue`). No broker is anywhere in
//! this crate's dependencies — CI holds that — so a handler can reach the
//! queue only through the trait, and the queue's broker only through its
//! driver, which the dispatcher's binary composes with these.

#![forbid(unsafe_code)]

pub mod admission;
pub mod checkpoint;
pub mod handlers;
pub mod queue;
pub mod retry;
