//! The bus's channels as a client meets them, generated from the registry
//! (specs/src/bus/registry.json).
//!
//! - Which channels a client hears globally, and which a resource's scope
//!   carries. The two are disjoint: a channel in both would reach a client
//!   twice, under two ids.
//! - A type per channel (`job:create` is `JobCreate`) that names its
//!   payload's type, so the bus's typed methods take and give a channel's own
//!   payload and nothing else: a wrong payload for a channel does not
//!   compile. An operation's request is tied to its result and its failure
//!   (`Request`), and a channel that carries an event of the record names the
//!   type of the event's own payload (`Recorded`), and gives it out of a
//!   stored event of its own type and of no other.
//! - How each channel is delivered, as a trait of its type: `Scoped` for one a
//!   resource's scope carries, `Unscoped` for every other. A read of a scoped
//!   channel names its resource, and one that names none does not compile.

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};

/// A channel of the bus.
pub trait Channel: 'static {
    /// The channel's name on the wire.
    const NAME: &'static str;
    /// The stamps a gateway puts on a payload (`_userId`, `_roles`) that this
    /// channel's payload type declares, and so reads. Any other is the bus's,
    /// not the payload's, and is left out of what is decoded.
    const STAMPS: &'static [&'static str];
    /// The type of its payload.
    type Payload: Serialize + DeserializeOwned + Send + 'static;
}

/// A channel a resource's scope carries: an event of the record, delivered to
/// the clients that hold its resource's scope. A read of one names its
/// resource, whose scope the read holds (`crate::bus::Bus::stream_of`).
pub trait Scoped: Channel {}

/// A channel of no resource's scope: delivered to every client whose stream
/// names it, or never sent at all. Read with `crate::bus::Bus::stream`.
pub trait Unscoped: Channel {}

/// The request channel of an operation, with the channels that answer it.
pub trait Request: Channel {
    type Result: Channel;
    type Failure: Channel;
}

/// A channel that carries events of the record: its payload is the stored
/// event, and `Event` is the type of the event's own payload.
pub trait Recorded: Channel {
    type Event: DeserializeOwned;

    /// The event's own payload, out of the stored event that carries it.
    /// Refused for a stored event of another type: two events can carry
    /// payloads of one shape (a tag added, a tag removed), and read by its
    /// payload alone one would be taken for the other.
    fn event(stored: &Self::Payload) -> Result<Self::Event, serde_json::Error>;
}

/// The own payload of a stored event, where the event is of the type
/// `recorded`, which is its channel's name. `kind`, `id` and `payload` are
/// the stored event's.
fn own<E: DeserializeOwned>(
    recorded: &str,
    kind: &str,
    id: &str,
    payload: &serde_json::Map<String, serde_json::Value>,
) -> Result<E, serde_json::Error> {
    if kind != recorded {
        let refused = format!("{kind} {id} is not a {recorded} event");
        return Err(<serde_json::Error as serde::de::Error>::custom(refused));
    }
    serde_json::from_value(serde_json::Value::Object(payload.clone()))
}

/// The payload of a reply that carries a response.
#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
pub struct Response<T> {
    pub response: T,
}

/// The payload of a channel that carries nothing: the empty object.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Deserialize, Serialize)]
pub struct Empty {}

include!(concat!(env!("OUT_DIR"), "/channels.rs"));
