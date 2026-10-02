//! What a consumer's tests use: a real client and a real session over
//! doubles (`create_test_client`, `create_test_session`), a factory of
//! scripted sessions for a registry, a transport that misbehaves on a
//! schedule, a content transport that keeps what it is given, a gateway
//! that answers only what it was told to, a storage several contexts share,
//! and the harnesses that hold a state unit, and a composition over the bus,
//! to their axioms. Behind the `testing` feature.
//!
//! A double answers what a test told it to and refuses the rest by name. It
//! never answers with a value of its own making.
//!
//! `examples` holds a README's code to source that compiles and runs.

pub mod axioms;
pub mod client;
pub mod content;
pub mod examples;
pub mod faulty_transport;
pub mod gateway;
pub mod liveness;
pub mod sessions;
pub mod storage;

pub use client::{
    TestClient, TestClientOptions, TestSession, TestSessionOptions, create_test_client,
    create_test_session,
};
pub use content::{ContentCall, InMemoryContent};
pub use faulty_transport::{FaultAction, FaultyTransport, RequestLogEntry, retry_key_of};
pub use gateway::StubGateway;
pub use sessions::ScriptedSessions;
pub use storage::SharedStorage;
