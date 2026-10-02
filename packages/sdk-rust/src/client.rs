//! A client of one knowledge base: its eleven namespaces over a transport,
//! the bytes that never ride the bus, and the gateway's own answers.
//!
//! A client owns a bus of its own. Its transport publishes into that bus
//! every frame it delivers, and what the client's own parts say to each other
//! (a viewer's signals) goes through it and never reaches the wire. The
//! namespaces are fields: `client.browse`, `client.mark`, and so on, with
//! `yield_` and `match_` for the two whose names Rust keeps for itself.
//!
//! `auth` and `system` are there when the client was given a gateway: a
//! transport with no gateway behind it has neither.
//!
//! `close` is the graceful end: the queries end and save what they owed, the
//! transport stops, every stream ends and every request still pending fails
//! as closed. A client that is only dropped ends its queries and its own
//! bus; its transport stops when the last holder of it lets go.
//!
//! A client is built inside a Tokio runtime: it listens, from the moment it
//! exists, for the events that keep its queries true.

use crate::bus::{Bus, payload_of};
use crate::channels::{Channel, Request};
use crate::errors::SemiontError;
use crate::event_bus::EventBus;
use crate::namespaces::{
    AuthNamespace, BeckonNamespace, BindNamespace, BrowseNamespace, FrameNamespace,
    GatherNamespace, JobNamespace, MarkNamespace, MatchNamespace, SystemNamespace, YieldNamespace,
};
use crate::storage::SessionStorage;
use crate::timing::{BUS_REQUEST_TIMEOUT, INVALIDATION_WINDOW, JOB_SILENCE, JOB_STATUS_POLL};
use crate::transport::{ConnectionState, ContentTransport, Envelope, GatewayOperations, Transport};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::watch;

/// The waits a client keeps, each the value of specs/src/client/timing.json
/// unless a caller that must not wait it out states another.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ClientTiming {
    /// How long a bus request waits for its reply.
    pub bus_request: Duration,
    /// How long a followed job may say nothing before its status is asked for.
    pub job_silence: Duration,
    /// How often a silent job's status is asked for after that.
    pub job_status_poll: Duration,
    /// How long the refetches events ask of one cached key fold into one.
    pub invalidation_window: Duration,
}

impl Default for ClientTiming {
    fn default() -> ClientTiming {
        ClientTiming {
            bus_request: BUS_REQUEST_TIMEOUT,
            job_silence: JOB_SILENCE,
            job_status_poll: JOB_STATUS_POLL,
            invalidation_window: INVALIDATION_WINDOW,
        }
    }
}

/// Where a client keeps its small caches so the next client for the same
/// knowledge base shows them at once: a storage, and a prefix for its keys,
/// which is what tells one knowledge base's from another's.
#[derive(Clone)]
pub struct CachePersistence {
    pub storage: Arc<dyn SessionStorage>,
    pub key_prefix: String,
}

/// What a client is built with, beyond what it speaks through.
#[derive(Clone, Default)]
pub struct ClientOptions {
    pub timing: ClientTiming,
    /// Absent, the client's caches live as long as it does.
    pub cache_persistence: Option<CachePersistence>,
}

/// What every namespace reaches the knowledge base through.
#[derive(Clone)]
pub(crate) struct Links {
    /// The bus over the transport.
    pub wire: Bus,
    /// The client's own bus.
    pub own: EventBus,
    pub timing: ClientTiming,
}

impl Links {
    /// A request of the operation `R`, within the client's deadline.
    pub async fn request<R: Request>(
        &self,
        payload: &R::Payload,
    ) -> Result<<R::Result as Channel>::Payload, SemiontError> {
        self.wire
            .request::<R>(payload, self.timing.bus_request)
            .await
    }

    /// A drive at the other participants: one frame over the wire, and how
    /// many of them the gateway reached.
    pub async fn drive<C: Channel>(
        &self,
        payload: &C::Payload,
    ) -> Result<Option<u64>, SemiontError> {
        Ok(self.wire.emit::<C>(payload, Envelope::default()).await?)
    }

    /// A signal to this client's own parts. A payload of the registry's types
    /// is always an object; one that were not would be published to nobody.
    pub fn signal<C: Channel>(&self, payload: &C::Payload, envelope: Envelope) {
        let _ = self.own.publish::<C>(payload, envelope);
    }

    /// A report over the wire that nobody awaits. The transport tells its
    /// failure stream of an emit it could not send, which is where a failure
    /// of this one is heard.
    pub fn report<C: Channel>(&self, payload: &C::Payload) {
        let Ok(payload) = payload_of(payload) else {
            return;
        };
        let wire = self.wire.clone();
        tokio::spawn(async move {
            let _ = wire.emit_on(C::NAME, payload, Envelope::default()).await;
        });
    }
}

/// See the module's documentation.
pub struct SemiontClient {
    transport: Arc<dyn Transport>,
    own: EventBus,
    /// The vocabulary: what kinds of things exist.
    pub frame: FrameNamespace,
    /// Reads, and this viewer's own signals.
    pub browse: BrowseNamespace,
    /// Annotations, a resource's own metadata, and AI assistance.
    pub mark: MarkNamespace,
    /// Linking a reference to what it refers to.
    pub bind: BindNamespace,
    /// Assembling the context a model is given.
    pub gather: GatherNamespace,
    /// Searching for what a reference could refer to.
    pub match_: MatchNamespace,
    /// Creating resources.
    pub yield_: YieldNamespace,
    /// Attention: driving the other participants' viewers.
    pub beckon: BeckonNamespace,
    /// Jobs: their lifecycle, their status and their cancellation.
    pub job: JobNamespace,
    /// The gateway's view of who is signed in.
    pub auth: Option<AuthNamespace>,
    /// What the knowledge base says about itself.
    pub system: Option<SystemNamespace>,
}

impl SemiontClient {
    /// A client over `transport` and `content`, with `auth` and `system`
    /// when there is a `gateway`.
    pub fn new(
        transport: Arc<dyn Transport>,
        content: Arc<dyn ContentTransport>,
        gateway: Option<Arc<dyn GatewayOperations>>,
        options: ClientOptions,
    ) -> SemiontClient {
        let own = EventBus::new();
        transport.bridge_into(Arc::new(own.clone()));
        let links = Links {
            wire: Bus::new(transport.clone()),
            own: own.clone(),
            timing: options.timing,
        };
        SemiontClient {
            transport,
            own,
            frame: FrameNamespace::new(links.clone()),
            browse: BrowseNamespace::new(
                links.clone(),
                content.clone(),
                options.cache_persistence.as_ref(),
            ),
            mark: MarkNamespace::new(links.clone()),
            bind: BindNamespace::new(links.clone()),
            gather: GatherNamespace::new(links.clone()),
            match_: MatchNamespace::new(links.clone()),
            yield_: YieldNamespace::new(links.clone(), content),
            beckon: BeckonNamespace::new(links.clone()),
            job: JobNamespace::new(links),
            auth: gateway.clone().map(AuthNamespace::new),
            system: gateway.map(SystemNamespace::new),
        }
    }

    /// The transport, for what the namespaces do not cover: a frame on a
    /// channel by name, a hold on a resource's scope.
    pub fn transport(&self) -> &Arc<dyn Transport> {
        &self.transport
    }

    /// The client's own bus: every frame the transport delivered, and every
    /// signal the client's parts gave each other.
    pub fn bus(&self) -> &EventBus {
        &self.own
    }

    /// What the transport speaks to.
    pub fn base_url(&self) -> &str {
        self.transport.base_url()
    }

    /// The connection's state: the current value, and each change after it.
    pub fn state(&self) -> watch::Receiver<ConnectionState> {
        self.transport.state()
    }

    /// Whether every cache the client's storage keeps is at rest: none is
    /// fetching, and none owes a save. What is kept of the stream's place is
    /// kept only then (`crate::resume`).
    pub fn persistence_settled(&self) -> bool {
        self.browse.persistence_settled()
    }

    /// Stop. The queries end first, so nothing they had in flight asks
    /// again of a transport that is going; then the transport closes, so
    /// every stream ends and every request still pending fails as closed;
    /// then the client's own bus ends. Closing twice is closing once.
    pub async fn close(&self) {
        self.browse.dispose();
        self.transport.close().await;
        self.own.destroy();
    }
}

impl Drop for SemiontClient {
    fn drop(&mut self) {
        self.own.destroy();
    }
}
