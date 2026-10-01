//! What a consumer's tests use: a transport that misbehaves on a schedule,
//! a content transport that keeps what it is given, a gateway that answers
//! only what it was told to, and the harnesses that hold a state unit, and a
//! composition over the bus, to their axioms. Behind the `testing` feature.

pub mod axioms;
pub mod content;
pub mod faulty_transport;
pub mod gateway;
pub mod liveness;

pub use content::{ContentCall, InMemoryContent};
pub use faulty_transport::{FaultAction, FaultyTransport, RequestLogEntry, retry_key_of};
pub use gateway::StubGateway;
