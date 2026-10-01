//! What a consumer's tests use: a transport that misbehaves on a schedule,
//! and the harnesses that hold a state unit, and a composition over the bus,
//! to their axioms. Behind the `testing` feature.

pub mod axioms;
pub mod faulty_transport;
pub mod liveness;

pub use faulty_transport::{FaultAction, FaultyTransport, RequestLogEntry, retry_key_of};
