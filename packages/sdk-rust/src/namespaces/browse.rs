//! Browse: reads. The queries (`Cached`) answer from the client's cache and
//! stay true as the knowledge base changes; the one-shot reads are asked
//! once and never kept; and the signals are this viewer's own, with the one
//! report among them going over the wire.
//!
//! What keeps a query true is specs/src/client/refresh.json
//! (`crate::refresh`): each event on the bus, and the reopening of a dropped
//! stream, asks again for the queries its row names, writes the ones whose
//! new value the event carries, and ends the ones whose entity is gone. This
//! module states only what each event names: its resource, its annotation,
//! the value it carries. An event acts only on a key the cache holds, and
//! the refetches one key is asked for inside a window are one refetch
//! (docs/protocol/CACHE-SEMANTICS.md B12–B13b, B19, B20).

use crate::bus::{LIMITS_OPERATIONS, Operation, StreamError, operation};
use crate::cache::{
    Cache, CacheKey, CachePersister, CacheState, CacheValue, MAX_STORED_BYTES, SAVE_DEBOUNCE,
    StoragePersister,
};
use crate::cached::{Cached, Observed, Source};
use crate::channels::{
    self, BrowseAgentsRequested, BrowseAnchoredTextRequested, BrowseAnnotationHistoryRequested,
    BrowseAnnotationRequested, BrowseAnnotationsRequested, BrowseClick, BrowseDirectoryRequested,
    BrowseEntityTypesRequested, BrowseEventsRequested, BrowseKbRequested,
    BrowseReferencedByRequested, BrowseResourceOpen, BrowseResourceRequested, BrowseResourceViewed,
    BrowseResourcesRequested, BrowseTagSchemasRequested, Channel,
};
use crate::client::{CachePersistence, Links};
use crate::errors::{
    BusRequestError, BusRequestErrorCode, SemiontError, TransportError, TransportErrorCode,
};
use crate::locked;
use crate::refresh::{CacheQuery, Reach, RefreshTrigger, RefreshWhen};
use crate::state_unit::StateUnit;
use crate::transport::{
    BoxFuture, ConnectionState, Content, ContentStream, ContentTransport, Envelope, Transport,
};
use crate::types::{
    Agent, AnchoredTextAnswer, Annotation, BrowseAgentsRequest, BrowseAnchoredTextRequest,
    BrowseAnnotationHistoryRequest, BrowseAnnotationRequest, BrowseAnnotationsRequest,
    BrowseClickEvent, BrowseDirectoryRequest, BrowseDirectoryRequestSort,
    BrowseDirectoryResultResponse, BrowseEntityTypesRequest, BrowseEventsRequest, BrowseKbRequest,
    BrowseReferencedByRequest, BrowseResourceOpenEvent, BrowseResourceRequest,
    BrowseResourceViewedEvent, BrowseResourcesRequest, BrowseTagSchemasRequest, CollaboratorEntry,
    GetAnnotationHistoryResponse, GetAnnotationsResponse, GetReferencedByResponseReferencedByItem,
    GetResourceResponse, InferenceLimits, InferenceLimitsResultResponse, InferencePairLimits,
    KbDescription, ListResourcesResponse, ResourceDescriptor, StoredEventResponse, TagSchema,
};
use crate::types::{AnnotationId, ResourceId};
use futures_core::Stream;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::Map;
use std::collections::HashMap;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};
use std::time::Duration;
use tokio::sync::watch;
use tokio::task::{AbortHandle, JoinSet};
use tokio_stream::wrappers::WatchStream;

/// How many resources a list asks for when its caller states no limit.
/// Every SDK asks for as many: the cases of specs/src/client/surface.json
/// hold each to it.
const LIST_LIMIT: i64 = 100;

/// The key of a query the knowledge base has one of.
const WHOLE: &str = "_";

/// The version of what the persisted caches hold. A document of another
/// version reads as nothing kept, so this changes when a kept value's shape
/// does.
const PERSISTED_VERSION: u64 = 1;

/// Which resources a list is of. Each field that is stated narrows it.
#[derive(Debug, Clone, Default, PartialEq, Eq, Hash)]
pub struct ResourceFilters {
    pub limit: Option<i64>,
    pub archived: Option<bool>,
    /// Text to find. An empty search is no search.
    pub search: Option<String>,
    pub entity_type: Option<String>,
}

/// One of the knowledge base's collaborators: its entry in the directory,
/// and its model's limits when the service holding that model's credentials
/// reported them. As JSON the limits sit beside the entry's own fields.
#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
pub struct Collaborator {
    #[serde(flatten)]
    pub entry: CollaboratorEntry,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limits: Option<InferenceLimits>,
}

/// The directory with each reported model's limits on its entries.
fn joined(
    directory: Vec<CollaboratorEntry>,
    reported: &[InferencePairLimits],
) -> Vec<Collaborator> {
    directory
        .into_iter()
        .map(|entry| {
            let limits = match &entry.agent {
                Agent::Software(agent) => reported
                    .iter()
                    .find(|pair| {
                        Some(&pair.provider) == agent.provider.as_ref()
                            && Some(&pair.model) == agent.model.as_ref()
                    })
                    .map(|pair| pair.limits.clone()),
                Agent::Person(_) | Agent::Organization(_) => None,
            };
            Collaborator { entry, limits }
        })
        .collect()
}

/// Every future's output, in their order, each run as far as it will go
/// before the next is looked at.
async fn all<'a, T>(futures: Vec<BoxFuture<'a, T>>) -> Vec<T> {
    let mut pending: Vec<Option<BoxFuture<'a, T>>> = futures.into_iter().map(Some).collect();
    let mut done: Vec<Option<T>> = pending.iter().map(|_| None).collect();
    std::future::poll_fn(|cx| {
        for (slot, output) in pending.iter_mut().zip(done.iter_mut()) {
            if let Some(future) = slot
                && let Poll::Ready(value) = future.as_mut().poll(cx)
            {
                *output = Some(value);
                *slot = None;
            }
        }
        if pending.iter().all(Option::is_none) {
            Poll::Ready(())
        } else {
            Poll::Pending
        }
    })
    .await;
    done.into_iter().flatten().collect()
}

/// The models one key holder reports the limits of. A holder that is down,
/// silent or mistaken reports none: its models show no limits, and the
/// directory is not held up by it for longer than a request waits.
async fn limits_reported(links: &Links, operation: &Operation) -> Vec<InferencePairLimits> {
    let Ok(Some(response)) = links
        .wire
        .request_of(operation, Map::new(), links.timing.bus_request)
        .await
    else {
        return Vec::new();
    };
    serde_json::from_value::<InferenceLimitsResultResponse>(response)
        .map(|reported| reported.limits)
        .unwrap_or_default()
}

// ── Windows ─────────────────────────────────────────────────────────────

/// What a window still owes: the refetch asked for while it was open.
type Owed = Box<dyn FnOnce() + Send>;

struct Window {
    owed: Option<Owed>,
    closing: AbortHandle,
}

/// B19: per key, the first refetch an event asks for runs at once and opens
/// a window; any more inside it are owed, and run as one when it closes,
/// which opens the next. So a storm of events costs a refetch per key per
/// window, and the last event is always reflected.
struct Windows {
    lasting: Duration,
    /// `None` once disposed.
    open: Mutex<Option<HashMap<String, Window>>>,
}

impl Windows {
    fn run(self: &Arc<Self>, key: String, refetch: Owed) {
        let mut open = locked(&self.open);
        let Some(windows) = open.as_mut() else {
            return;
        };
        if let Some(window) = windows.get_mut(&key) {
            window.owed = Some(refetch);
            return;
        }
        let these = Arc::downgrade(self);
        let lasting = self.lasting;
        let of = key.clone();
        let closing = tokio::spawn(async move {
            tokio::time::sleep(lasting).await;
            let Some(these) = these.upgrade() else {
                return;
            };
            let owed = locked(&these.open)
                .as_mut()
                .and_then(|windows| windows.remove(&of))
                .and_then(|window| window.owed);
            if let Some(owed) = owed {
                these.run(of, owed);
            }
        })
        .abort_handle();
        windows.insert(
            key,
            Window {
                owed: None,
                closing,
            },
        );
        drop(open);
        refetch();
    }

    /// Every window closes, and what each owed is dropped.
    fn dispose(&self) {
        if let Some(windows) = locked(&self.open).take() {
            for window in windows.into_values() {
                window.closing.abort();
            }
        }
    }
}

// ── The caches, and what refreshes them ─────────────────────────────────

/// What an event names: which of a split channel's rows it is, the keys a
/// row that reaches its `Subject` acts on, and the value an enriched event
/// carries.
#[derive(Default)]
struct Subject {
    when: Option<RefreshWhen>,
    resource: Option<ResourceId>,
    annotation: Option<AnnotationId>,
    written: Option<Annotation>,
}

impl Subject {
    fn of(resource: Option<ResourceId>) -> Subject {
        Subject {
            resource,
            ..Subject::default()
        }
    }
}

struct Live {
    resource: Cache<ResourceId, ResourceDescriptor>,
    lists: Cache<ResourceFilters, ListResourcesResponse>,
    annotations: Cache<ResourceId, GetAnnotationsResponse>,
    annotation: Cache<AnnotationId, Annotation>,
    /// The resource each annotation that was asked for is of: an annotation
    /// is kept by its own id, and a request for it names its resource too.
    annotation_of: Arc<Mutex<HashMap<AnnotationId, ResourceId>>>,
    entity_types: Cache<String, Vec<String>>,
    tag_schemas: Cache<String, Vec<TagSchema>>,
    agents: Cache<String, Vec<CollaboratorEntry>>,
    /// Each key holder's report of its models' limits, by the operation
    /// that asks it.
    limits: Cache<&'static str, Vec<InferencePairLimits>>,
    referenced_by: Cache<ResourceId, Vec<GetReferencedByResponseReferencedByItem>>,
    events: Cache<ResourceId, Vec<StoredEventResponse>>,
    windows: Arc<Windows>,
    /// What listens for each trigger, until the namespace is disposed.
    listening: Mutex<JoinSet<()>>,
}

/// A cache that keeps nothing beyond its client.
fn kept_in_memory<K, V, F, Fut>(fetch: F) -> Cache<K, V>
where
    K: CacheKey,
    V: CacheValue,
    F: Fn(K) -> Fut + Send + Sync + 'static,
    Fut: Future<Output = Result<V, SemiontError>> + Send + 'static,
{
    Cache::new(fetch)
}

/// A cache the client's storage keeps under `name`, when it has one: the
/// small ones a returning client shows at once.
fn kept<K, V, F, Fut>(persistence: Option<&CachePersistence>, name: &str, fetch: F) -> Cache<K, V>
where
    K: CacheKey + Serialize + DeserializeOwned,
    V: CacheValue + Serialize + DeserializeOwned,
    F: Fn(K) -> Fut + Send + Sync + 'static,
    Fut: Future<Output = Result<V, SemiontError>> + Send + 'static,
{
    match persistence {
        None => Cache::new(fetch),
        Some(persistence) => {
            let persister: Arc<dyn CachePersister<K, V>> = Arc::new(StoragePersister::new(
                persistence.storage.clone(),
                format!("semiont.cache.{}.{name}", persistence.key_prefix),
                PERSISTED_VERSION,
                MAX_STORED_BYTES,
            ));
            Cache::persisted(fetch, persister, SAVE_DEBOUNCE)
        }
    }
}

fn events_of(resource_id: &ResourceId) -> BrowseEventsRequest {
    BrowseEventsRequest {
        resource_id: resource_id.clone(),
        r#type: None,
        user_id: None,
        limit: None,
    }
}

impl Live {
    fn new(links: &Links, persistence: Option<&CachePersistence>) -> Arc<Live> {
        let annotation_of: Arc<Mutex<HashMap<AnnotationId, ResourceId>>> = Arc::default();
        let asking = |links: &Links| links.clone();

        let resource = kept(persistence, "resource", {
            let links = asking(links);
            move |resource_id: ResourceId| {
                let links = links.clone();
                async move {
                    let answer = links
                        .request::<BrowseResourceRequested>(&BrowseResourceRequest { resource_id })
                        .await?;
                    Ok(answer.response.resource)
                }
            }
        });
        let lists = kept_in_memory({
            let links = asking(links);
            move |filters: ResourceFilters| {
                let links = links.clone();
                async move {
                    let request = BrowseResourcesRequest {
                        search: filters.search.filter(|text| !text.is_empty()),
                        archived: filters.archived,
                        entity_type: filters.entity_type,
                        offset: Some(0),
                        limit: Some(filters.limit.unwrap_or(LIST_LIMIT)),
                    };
                    let answer = links.request::<BrowseResourcesRequested>(&request).await?;
                    Ok(answer.response)
                }
            }
        });
        let annotations = kept(persistence, "annotations", {
            let links = asking(links);
            move |resource_id: ResourceId| {
                let links = links.clone();
                async move {
                    let answer = links
                        .request::<BrowseAnnotationsRequested>(&BrowseAnnotationsRequest {
                            resource_id,
                        })
                        .await?;
                    Ok(answer.response)
                }
            }
        });
        let annotation = kept(persistence, "annotation-detail", {
            let links = asking(links);
            let annotation_of = annotation_of.clone();
            move |annotation_id: AnnotationId| {
                let links = links.clone();
                let resource_id = locked(&annotation_of).get(&annotation_id).cloned();
                async move {
                    let Some(resource_id) = resource_id else {
                        return Err(BusRequestError::new(
                            BusRequestErrorCode::Rejected,
                            format!(
                                "Cannot ask for annotation {annotation_id}: the resource it is of is not known"
                            ),
                        )
                        .into());
                    };
                    let answer = links
                        .request::<BrowseAnnotationRequested>(&BrowseAnnotationRequest {
                            resource_id,
                            annotation_id,
                        })
                        .await?;
                    Ok(answer.response.annotation)
                }
            }
        });
        let entity_types = kept(persistence, "entity-types", {
            let links = asking(links);
            move |_: String| {
                let links = links.clone();
                async move {
                    let answer = links
                        .request::<BrowseEntityTypesRequested>(&BrowseEntityTypesRequest {})
                        .await?;
                    Ok(answer.response.entity_types)
                }
            }
        });
        let tag_schemas = kept(persistence, "tag-schemas", {
            let links = asking(links);
            move |_: String| {
                let links = links.clone();
                async move {
                    let answer = links
                        .request::<BrowseTagSchemasRequested>(&BrowseTagSchemasRequest {})
                        .await?;
                    Ok(answer.response.tag_schemas)
                }
            }
        });
        let agents = kept_in_memory({
            let links = asking(links);
            move |_: String| {
                let links = links.clone();
                async move {
                    let answer = links
                        .request::<BrowseAgentsRequested>(&BrowseAgentsRequest {})
                        .await?;
                    Ok(answer.response.agents)
                }
            }
        });
        let limits = kept_in_memory({
            let links = asking(links);
            move |holder: &'static str| {
                let links = links.clone();
                async move {
                    Ok(match operation(holder) {
                        Some(operation) => limits_reported(&links, operation).await,
                        None => Vec::new(),
                    })
                }
            }
        });
        let referenced_by = kept_in_memory({
            let links = asking(links);
            move |resource_id: ResourceId| {
                let links = links.clone();
                async move {
                    let answer = links
                        .request::<BrowseReferencedByRequested>(&BrowseReferencedByRequest {
                            resource_id,
                            motivation: None,
                        })
                        .await?;
                    Ok(answer.response.referenced_by)
                }
            }
        });
        let events = kept_in_memory({
            let links = asking(links);
            move |resource_id: ResourceId| {
                let links = links.clone();
                async move {
                    let answer = links
                        .request::<BrowseEventsRequested>(&events_of(&resource_id))
                        .await?;
                    Ok(answer.response.events)
                }
            }
        });

        let live = Arc::new(Live {
            resource,
            lists,
            annotations,
            annotation,
            annotation_of,
            entity_types,
            tag_schemas,
            agents,
            limits,
            referenced_by,
            events,
            windows: Arc::new(Windows {
                lasting: links.timing.invalidation_window,
                open: Mutex::new(Some(HashMap::new())),
            }),
            listening: Mutex::new(JoinSet::new()),
        });
        live.listen(links);
        live
    }

    /// Listen for every trigger of the refresh table. Each arm states what
    /// its event names, and a trigger with no arm does not compile.
    fn listen(self: &Arc<Self>, links: &Links) {
        let stored = |event: StoredEventResponse| Subject::of(event.resource_id);
        for trigger in RefreshTrigger::ALL {
            match trigger {
                RefreshTrigger::Reopened => self.on_reopening(links.wire.transport().state()),
                RefreshTrigger::BusResumeGap => {
                    self.on::<channels::BusResumeGap>(links, *trigger, |gap| {
                        Subject::of(ResourceId::new(gap.scope).ok())
                    });
                }
                RefreshTrigger::MarkAdded => {
                    self.on::<channels::MarkAdded>(links, *trigger, |event| {
                        Subject::of(event.resource_id)
                    });
                }
                RefreshTrigger::MarkRemoved => {
                    self.on::<channels::MarkRemoved>(links, *trigger, |event| Subject {
                        annotation: event
                            .payload
                            .get("annotationId")
                            .and_then(|id| id.as_str())
                            .and_then(|id| AnnotationId::new(id).ok()),
                        ..Subject::of(event.resource_id)
                    });
                }
                RefreshTrigger::MarkDeleteOk => {
                    self.on::<channels::MarkDeleteOk>(links, *trigger, |reply| Subject {
                        annotation: Some(reply.response.annotation_id),
                        ..Subject::default()
                    });
                }
                RefreshTrigger::MarkBodyUpdated => {
                    self.on::<channels::MarkBodyUpdated>(links, *trigger, |event| {
                        match event.annotation {
                            Some(annotation) => Subject {
                                when: Some(RefreshWhen::Enriched),
                                resource: event.resource_id,
                                annotation: Some(annotation.id.clone()),
                                written: Some(annotation),
                            },
                            None => Subject {
                                when: Some(RefreshWhen::Unenriched),
                                resource: event.resource_id,
                                annotation: event
                                    .payload
                                    .get("annotationId")
                                    .and_then(|id| id.as_str())
                                    .and_then(|id| AnnotationId::new(id).ok()),
                                written: None,
                            },
                        }
                    });
                }
                RefreshTrigger::MarkEntityTagAdded => {
                    self.on::<channels::MarkEntityTagAdded>(links, *trigger, stored);
                }
                RefreshTrigger::MarkEntityTagRemoved => {
                    self.on::<channels::MarkEntityTagRemoved>(links, *trigger, stored);
                }
                RefreshTrigger::MarkArchived => {
                    self.on::<channels::MarkArchived>(links, *trigger, stored);
                }
                RefreshTrigger::MarkUnarchived => {
                    self.on::<channels::MarkUnarchived>(links, *trigger, stored);
                }
                // What is heard by every client: its resource is the one it
                // records, not a scope the client holds.
                RefreshTrigger::YieldCreated => {
                    self.on::<channels::YieldCreated>(links, *trigger, stored);
                }
                RefreshTrigger::YieldUpdated => {
                    self.on::<channels::YieldUpdated>(links, *trigger, stored);
                }
                RefreshTrigger::YieldCloned => {
                    self.on::<channels::YieldCloned>(links, *trigger, stored);
                }
                RefreshTrigger::YieldMoved => {
                    self.on::<channels::YieldMoved>(links, *trigger, stored);
                }
                RefreshTrigger::FrameEntityTypeAdded => {
                    self.on::<channels::FrameEntityTypeAdded>(links, *trigger, |_| {
                        Subject::default()
                    });
                }
                RefreshTrigger::FrameTagSchemaAdded => {
                    self.on::<channels::FrameTagSchemaAdded>(links, *trigger, |_| {
                        Subject::default()
                    });
                }
            }
        }
    }

    /// Apply `trigger`'s row to what each event on the channel `C` names.
    fn on<C: Channel>(
        self: &Arc<Self>,
        links: &Links,
        trigger: RefreshTrigger,
        names: impl Fn(C::Payload) -> Subject + Send + 'static,
    ) {
        debug_assert_eq!(trigger.channel(), Some(C::NAME));
        let mut events = links.own.stream::<C>();
        let live = Arc::downgrade(self);
        locked(&self.listening).spawn(async move {
            while let Some(event) = events.next().await {
                let Some(live) = live.upgrade() else {
                    return;
                };
                match event {
                    Ok(event) => live.refresh(trigger, &names(event.payload)),
                    // An event that was missed, or one that cannot be read:
                    // something changed and nothing says what. Everything
                    // held is asked for again, as after a gap.
                    Err(StreamError::Lagged(_) | StreamError::Undecodable(_)) => {
                        live.everything_held();
                    }
                }
            }
        });
    }

    /// B13: the stream is open again having left `Open`, which only a drop
    /// does. A changed subscription is handed over with the state still
    /// `Open`, and misses nothing.
    fn on_reopening(self: &Arc<Self>, mut state: watch::Receiver<ConnectionState>) {
        let live = Arc::downgrade(self);
        locked(&self.listening).spawn(async move {
            let (mut opened, mut left) = (false, false);
            loop {
                // A reopening is seen as one because a transport waits on its
                // connection between leaving `Open` and reaching it again,
                // and this task runs in that wait.
                if *state.borrow_and_update() == ConnectionState::Open {
                    if left && let Some(live) = live.upgrade() {
                        live.refresh(RefreshTrigger::Reopened, &Subject::default());
                    }
                    opened = true;
                    left = false;
                } else {
                    left = opened;
                }
                if state.changed().await.is_err() {
                    return;
                }
            }
        });
    }

    fn refresh(self: &Arc<Self>, trigger: RefreshTrigger, subject: &Subject) {
        let Some(row) = trigger.rows().iter().find(|row| row.when == subject.when) else {
            return;
        };
        for query in row.writes {
            self.write(*query, subject);
        }
        for query in row.removes {
            self.remove(*query, subject);
        }
        for query in row.refetches {
            self.refetch(*query, subject, row.reach);
        }
    }

    fn everything_held(self: &Arc<Self>) {
        for query in CacheQuery::ALL {
            self.refetch(*query, &Subject::default(), Reach::Held);
        }
    }

    /// B13b: the event carries the value. The table's own build refuses a
    /// row that writes a query no event carries a value for.
    fn write(&self, query: CacheQuery, subject: &Subject) {
        let (Some(resource), Some(written)) = (&subject.resource, &subject.written) else {
            return;
        };
        match query {
            // Into the resource's list, when the client holds it: where the
            // annotation was, or at its end.
            CacheQuery::Annotations => {
                if let Some(mut list) = self.annotations.get(resource) {
                    match list.annotations.iter_mut().find(|a| a.id == written.id) {
                        Some(was) => *was = written.clone(),
                        None => list.annotations.push(written.clone()),
                    }
                    self.annotations.set(resource, list);
                }
            }
            CacheQuery::Annotation => {
                locked(&self.annotation_of).insert(written.id.clone(), resource.clone());
                self.annotation.set(&written.id, written.clone());
            }
            _ => {}
        }
    }

    /// B13a: the event says the entity is gone. Only an annotation is ever
    /// said to be.
    fn remove(&self, query: CacheQuery, subject: &Subject) {
        if let (CacheQuery::Annotation, Some(annotation)) = (query, &subject.annotation) {
            self.annotation_gone(annotation);
        }
    }

    /// An annotation the cache holds is ended as not found. What says which
    /// resource it was of is kept: an observer arriving at the ended key asks
    /// the service, and that request names the resource.
    fn annotation_gone(&self, annotation_id: &AnnotationId) {
        let id = annotation_id.clone();
        if self.annotation.known(&id) {
            self.annotation.remove(
                &id,
                BusRequestError::new(
                    BusRequestErrorCode::NotFound,
                    format!("Annotation {annotation_id} was removed"),
                )
                .into(),
            );
        }
    }

    /// Ask again for one key, when the cache holds it (B20), through the
    /// key's window (B19).
    fn again<K, V>(self: &Arc<Self>, cache: &Cache<K, V>, key: K, window: String)
    where
        K: CacheKey,
        V: CacheValue,
    {
        if cache.known(&key) {
            let cache = cache.clone();
            self.windows
                .run(window, Box::new(move || cache.invalidate(&key)));
        }
    }

    /// B7: ask again, for the keys the row reaches, showing what there is
    /// meanwhile.
    fn refetch(self: &Arc<Self>, query: CacheQuery, subject: &Subject, reach: Reach) {
        let reached = |held: Vec<ResourceId>| match reach {
            Reach::Held => held,
            Reach::Subject => subject.resource.iter().cloned().collect(),
        };
        match query {
            CacheQuery::Resource => {
                for id in reached(self.resource.keys()) {
                    let window = format!("resource/{id}");
                    self.again(&self.resource, id, window);
                }
            }
            CacheQuery::Annotations => {
                for id in reached(self.annotations.keys()) {
                    let window = format!("annotations/{id}");
                    self.again(&self.annotations, id, window);
                }
            }
            CacheQuery::Events => {
                for id in reached(self.events.keys()) {
                    let window = format!("events/{id}");
                    self.again(&self.events, id, window);
                }
            }
            CacheQuery::ReferencedBy => {
                for id in reached(self.referenced_by.keys()) {
                    let window = format!("referenced-by/{id}");
                    self.again(&self.referenced_by, id, window);
                }
            }
            CacheQuery::Annotation => {
                // The annotation the event names; when it names none, each
                // one held of the resource it names.
                let annotations = match (reach, &subject.annotation) {
                    (Reach::Held, _) => self.annotation.keys(),
                    (Reach::Subject, Some(annotation)) => vec![annotation.clone()],
                    (Reach::Subject, None) => locked(&self.annotation_of)
                        .iter()
                        .filter(|(_, of)| Some(*of) == subject.resource.as_ref())
                        .map(|(annotation, _)| annotation.clone())
                        .collect(),
                };
                for id in annotations {
                    let window = format!("annotation/{id}");
                    self.again(&self.annotation, id, window);
                }
            }
            // An event does not say which lists it changes, so every list
            // the cache holds is asked for again, as one.
            CacheQuery::Resources => {
                let lists = self.lists.clone();
                self.windows.run(
                    "resource-lists".to_owned(),
                    Box::new(move || lists.invalidate_all()),
                );
            }
            CacheQuery::EntityTypes => {
                self.again(
                    &self.entity_types,
                    WHOLE.to_owned(),
                    "entity-types".to_owned(),
                );
            }
            CacheQuery::TagSchemas => {
                self.again(
                    &self.tag_schemas,
                    WHOLE.to_owned(),
                    "tag-schemas".to_owned(),
                );
            }
            CacheQuery::Agents => {
                if self.agents.known(&WHOLE.to_owned()) {
                    let (agents, limits) = (self.agents.clone(), self.limits.clone());
                    self.windows.run(
                        "agents".to_owned(),
                        Box::new(move || invalidate_agents(&agents, &limits)),
                    );
                }
            }
        }
    }

    fn dispose(&self) {
        locked(&self.listening).abort_all();
        self.windows.dispose();
        self.resource.dispose();
        self.lists.dispose();
        self.annotations.dispose();
        self.annotation.dispose();
        self.entity_types.dispose();
        self.tag_schemas.dispose();
        self.agents.dispose();
        self.limits.dispose();
        self.referenced_by.dispose();
        self.events.dispose();
        locked(&self.annotation_of).clear();
    }
}

impl Drop for Live {
    fn drop(&mut self) {
        self.dispose();
    }
}

/// The directory is out of date, and so is what each key holder reported.
fn invalidate_agents(
    agents: &Cache<String, Vec<CollaboratorEntry>>,
    limits: &Cache<&'static str, Vec<InferencePairLimits>>,
) {
    agents.invalidate(&WHOLE.to_owned());
    for holder in LIMITS_OPERATIONS {
        limits.invalidate(holder);
    }
}

// ── What a query answers from ───────────────────────────────────────────

/// A query answered by one key of one cache, as `view` shows its value.
struct Keyed<K: CacheKey, V: CacheValue, T> {
    cache: Cache<K, V>,
    key: K,
    view: fn(V) -> T,
    /// The resource the query is of, and what holds its scope while the
    /// query is watched.
    scope: Option<(Arc<dyn Transport>, ResourceId)>,
}

struct Viewed<V, T> {
    states: WatchStream<CacheState<V>>,
    view: fn(V) -> T,
}

impl<V: CacheValue, T> Stream for Viewed<V, T> {
    type Item = CacheState<T>;

    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        let view = self.view;
        Pin::new(&mut self.states)
            .poll_next(cx)
            .map(|state| state.map(|state| state.map(view)))
    }
}

impl<K, V, T> Source<T> for Keyed<K, V, T>
where
    K: CacheKey,
    V: CacheValue,
    T: 'static,
{
    fn fresh(&self) -> BoxFuture<'static, Result<T, SemiontError>> {
        let fetching = self.cache.fetch(&self.key);
        let view = self.view;
        Box::pin(async move { fetching.await.map(view) })
    }

    fn watch(&self) -> Observed<T> {
        // The scope first, so the events that refresh the key are already
        // coming when its value arrives.
        let scope = self
            .scope
            .as_ref()
            .map(|(transport, resource_id)| transport.subscribe_to_resource(resource_id));
        Observed::new(
            Viewed {
                states: self.cache.observe(&self.key),
                view: self.view,
            },
            scope,
        )
    }

    fn invalidate(&self) {
        self.cache.invalidate(&self.key);
    }
}

/// The collaborator directory with each key holder's limits joined on.
struct Collaborators {
    agents: Cache<String, Vec<CollaboratorEntry>>,
    limits: Cache<&'static str, Vec<InferencePairLimits>>,
}

/// The directory's state, with what the key holders have reported so far:
/// a holder that has not answered delays only its own models' limits.
struct Joined {
    directory: WatchStream<CacheState<Vec<CollaboratorEntry>>>,
    reports: Vec<WatchStream<CacheState<Vec<InferencePairLimits>>>>,
    entries: Option<CacheState<Vec<CollaboratorEntry>>>,
    reported: Vec<Vec<InferencePairLimits>>,
}

impl Stream for Joined {
    type Item = CacheState<Vec<Collaborator>>;

    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        let this = &mut *self;
        let mut changed = false;
        loop {
            match Pin::new(&mut this.directory).poll_next(cx) {
                Poll::Ready(Some(state)) => {
                    this.entries = Some(state);
                    changed = true;
                }
                Poll::Ready(None) => return Poll::Ready(None),
                Poll::Pending => break,
            }
        }
        for (report, reported) in this.reports.iter_mut().zip(this.reported.iter_mut()) {
            while let Poll::Ready(Some(state)) = Pin::new(&mut *report).poll_next(cx) {
                *reported = state.ready().cloned().unwrap_or_default();
                changed = true;
            }
        }
        match (&this.entries, changed) {
            (Some(entries), true) => Poll::Ready(Some(
                entries
                    .clone()
                    .map(|entries| joined(entries, &this.reported.concat())),
            )),
            _ => Poll::Pending,
        }
    }
}

impl Source<Vec<Collaborator>> for Collaborators {
    fn fresh(&self) -> BoxFuture<'static, Result<Vec<Collaborator>, SemiontError>> {
        enum Answer {
            Directory(Result<Vec<CollaboratorEntry>, SemiontError>),
            Limits(Vec<InferencePairLimits>),
        }
        // The directory is asked for first; each key holder's limits after it.
        let mut asked: Vec<BoxFuture<'static, Answer>> = vec![Box::pin({
            let directory = self.agents.fetch(&WHOLE.to_owned());
            async move { Answer::Directory(directory.await) }
        })];
        for holder in LIMITS_OPERATIONS {
            let limits = self.limits.fetch(holder);
            asked.push(Box::pin(async move {
                Answer::Limits(limits.await.unwrap_or_default())
            }));
        }
        Box::pin(async move {
            let mut directory = Vec::new();
            let mut reported = Vec::new();
            for answer in all(asked).await {
                match answer {
                    Answer::Directory(entries) => directory = entries?,
                    Answer::Limits(limits) => reported.extend(limits),
                }
            }
            Ok(joined(directory, &reported))
        })
    }

    fn watch(&self) -> Observed<Vec<Collaborator>> {
        Observed::new(
            Joined {
                directory: self.agents.observe(&WHOLE.to_owned()),
                reports: LIMITS_OPERATIONS
                    .iter()
                    .map(|holder| self.limits.observe(holder))
                    .collect(),
                entries: None,
                reported: LIMITS_OPERATIONS.iter().map(|_| Vec::new()).collect(),
            },
            None,
        )
    }

    fn invalidate(&self) {
        invalidate_agents(&self.agents, &self.limits);
    }
}

/// The charset a media type states, lowercased.
fn charset(media_type: &str) -> Option<String> {
    let lower = media_type.to_ascii_lowercase();
    let stated = &lower[lower.find("charset=")? + "charset=".len()..];
    let end = stated
        .find(|c: char| c.is_whitespace() || c == ';')
        .unwrap_or(stated.len());
    Some(stated[..end].to_owned())
}

/// Bytes as the text their media type says they are, read as a browser
/// reads it: in the encoding the charset is a label of, UTF-8 when none is
/// stated; a leading byte-order mark is not part of the text; and a sequence
/// the encoding does not have becomes U+FFFD. A charset that is not decoded
/// is refused by name rather than read as something it is not: the bytes
/// are there to decode (`resource_representation`).
fn text(content: Content) -> Result<String, TransportError> {
    let stated = charset(&content.content_type);
    let label = stated.as_deref().unwrap_or("utf-8");
    decoded(label, &content.bytes).ok_or_else(|| {
        TransportError::without_response(
            format!("The resource's text is {label}, {NOT_DECODED}: read its bytes instead"),
            TransportErrorCode::Error,
        )
    })
}

/// Every encoding of the Encoding Standard, by any of its labels.
#[cfg(feature = "charsets")]
fn decoded(label: &str, bytes: &[u8]) -> Option<String> {
    let encoding = encoding_rs::Encoding::for_label(label.as_bytes())?;
    Some(encoding.decode_with_bom_removal(bytes).0.into_owned())
}

#[cfg(feature = "charsets")]
const NOT_DECODED: &str = "which is no charset the Encoding Standard names";

/// UTF-8 alone: the rest are behind the `charsets` feature.
#[cfg(not(feature = "charsets"))]
fn decoded(label: &str, bytes: &[u8]) -> Option<String> {
    matches!(label, "utf-8" | "utf8").then(|| {
        let text = String::from_utf8_lossy(bytes);
        text.strip_prefix('\u{feff}').unwrap_or(&text).to_owned()
    })
}

#[cfg(not(feature = "charsets"))]
const NOT_DECODED: &str = "and only UTF-8 is decoded without the `charsets` feature";

pub struct BrowseNamespace {
    links: Links,
    content: Arc<dyn ContentTransport>,
    live: Arc<Live>,
}

impl BrowseNamespace {
    pub(crate) fn new(
        links: Links,
        content: Arc<dyn ContentTransport>,
        persistence: Option<&CachePersistence>,
    ) -> BrowseNamespace {
        BrowseNamespace {
            live: Live::new(&links, persistence),
            links,
            content,
        }
    }

    /// Whether every cache the client's storage keeps is at rest.
    pub(crate) fn persistence_settled(&self) -> bool {
        let live = &self.live;
        !(live.resource.persistence_pending()
            || live.annotations.persistence_pending()
            || live.annotation.persistence_pending()
            || live.entity_types.persistence_pending()
            || live.tag_schemas.persistence_pending())
    }

    /// End the queries: every watcher's stream ends, what was owed to
    /// storage is saved, and no event refreshes anything after.
    pub(crate) fn dispose(&self) {
        self.live.dispose();
    }

    /// A query of one resource: watching it holds the resource's scope.
    fn of_resource<K, V, T>(
        &self,
        cache: &Cache<K, V>,
        key: &K,
        resource_id: &ResourceId,
        view: fn(V) -> T,
    ) -> Cached<T>
    where
        K: CacheKey,
        V: CacheValue,
        T: 'static,
    {
        Cached::of(Keyed {
            cache: cache.clone(),
            key: key.clone(),
            view,
            scope: Some((self.links.wire.transport().clone(), resource_id.clone())),
        })
    }

    /// A query of the knowledge base as a whole.
    fn of_the_whole<V>(&self, cache: &Cache<String, V>) -> Cached<V>
    where
        V: CacheValue,
    {
        Cached::of(Keyed {
            cache: cache.clone(),
            key: WHOLE.to_owned(),
            view: |value| value,
            scope: None,
        })
    }

    // ── Queries ─────────────────────────────────────────────────────────

    pub fn resource(&self, resource_id: &ResourceId) -> Cached<ResourceDescriptor> {
        self.of_resource(&self.live.resource, resource_id, resource_id, |value| value)
    }

    /// A page of the resources `filters` admits, with how the answer was
    /// produced. A list is a query's answer: it is asked for again when a
    /// resource is created, updated, cloned or moved, and when a dropped
    /// stream reopens, and not by a change to a resource whose scope the
    /// client does not hold.
    pub fn resources(&self, filters: ResourceFilters) -> Cached<ListResourcesResponse> {
        Cached::of(Keyed {
            cache: self.live.lists.clone(),
            key: filters,
            view: |value| value,
            scope: None,
        })
    }

    pub fn annotations(&self, resource_id: &ResourceId) -> Cached<Vec<Annotation>> {
        self.of_resource(&self.live.annotations, resource_id, resource_id, |list| {
            list.annotations
        })
    }

    pub fn annotation(
        &self,
        resource_id: &ResourceId,
        annotation_id: &AnnotationId,
    ) -> Cached<Annotation> {
        locked(&self.live.annotation_of).insert(annotation_id.clone(), resource_id.clone());
        self.of_resource(&self.live.annotation, annotation_id, resource_id, |value| {
            value
        })
    }

    pub fn entity_types(&self) -> Cached<Vec<String>> {
        self.of_the_whole(&self.live.entity_types)
    }

    pub fn tag_schemas(&self) -> Cached<Vec<TagSchema>> {
        self.of_the_whole(&self.live.tag_schemas)
    }

    /// The knowledge base's collaborators: the directory, asked for first,
    /// with each model's limits as the services holding its credentials
    /// report them.
    pub fn agents(&self) -> Cached<Vec<Collaborator>> {
        Cached::of(Collaborators {
            agents: self.live.agents.clone(),
            limits: self.live.limits.clone(),
        })
    }

    pub fn referenced_by(
        &self,
        resource_id: &ResourceId,
    ) -> Cached<Vec<GetReferencedByResponseReferencedByItem>> {
        self.of_resource(
            &self.live.referenced_by,
            resource_id,
            resource_id,
            |value| value,
        )
    }

    pub fn events(&self, resource_id: &ResourceId) -> Cached<Vec<StoredEventResponse>> {
        self.of_resource(&self.live.events, resource_id, resource_id, |value| value)
    }

    // ── One-shot reads ──────────────────────────────────────────────────

    /// A resource's bytes as text, in the charset their media type states.
    /// Without the `charsets` feature, only when that is UTF-8.
    pub async fn resource_content(&self, resource_id: &ResourceId) -> Result<String, SemiontError> {
        Ok(text(self.content.get_binary(resource_id).await?)?)
    }

    /// A resource's description as linked data: itself, its annotations and
    /// the references to it.
    pub async fn resource_graph(
        &self,
        resource_id: &ResourceId,
    ) -> Result<GetResourceResponse, SemiontError> {
        Ok(self.content.get_resource_graph(resource_id).await?)
    }

    /// A resource's recovered text and the runs that index it, or the named
    /// reason there is none.
    pub async fn resource_anchored_text(
        &self,
        resource_id: &ResourceId,
    ) -> Result<AnchoredTextAnswer, SemiontError> {
        let answer = self
            .links
            .request::<BrowseAnchoredTextRequested>(&BrowseAnchoredTextRequest {
                resource_id: resource_id.clone(),
            })
            .await?;
        Ok(answer.response)
    }

    /// A resource's bytes, unchanged, with their media type.
    pub async fn resource_representation(
        &self,
        resource_id: &ResourceId,
    ) -> Result<Content, SemiontError> {
        Ok(self.content.get_binary(resource_id).await?)
    }

    /// The same, as a stream.
    pub async fn resource_representation_stream(
        &self,
        resource_id: &ResourceId,
    ) -> Result<ContentStream, SemiontError> {
        Ok(self.content.get_binary_stream(resource_id).await?)
    }

    pub async fn resource_events(
        &self,
        resource_id: &ResourceId,
    ) -> Result<Vec<StoredEventResponse>, SemiontError> {
        let answer = self
            .links
            .request::<BrowseEventsRequested>(&events_of(resource_id))
            .await?;
        Ok(answer.response.events)
    }

    pub async fn annotation_history(
        &self,
        resource_id: &ResourceId,
        annotation_id: &AnnotationId,
    ) -> Result<GetAnnotationHistoryResponse, SemiontError> {
        let answer = self
            .links
            .request::<BrowseAnnotationHistoryRequested>(&BrowseAnnotationHistoryRequest {
                resource_id: resource_id.clone(),
                annotation_id: annotation_id.clone(),
            })
            .await?;
        Ok(answer.response)
    }

    /// The entries of a directory of the knowledge base's tree: its root
    /// when no path is stated, by name when no order is.
    pub async fn files(
        &self,
        path: Option<&str>,
        sort: Option<BrowseDirectoryRequestSort>,
    ) -> Result<BrowseDirectoryResultResponse, SemiontError> {
        let answer = self
            .links
            .request::<BrowseDirectoryRequested>(&BrowseDirectoryRequest {
                path: path.unwrap_or(".").to_owned(),
                sort: Some(sort.unwrap_or(BrowseDirectoryRequestSort::Name)),
            })
            .await?;
        Ok(answer.response)
    }

    /// What the knowledge base says of itself: its name and domain, and its
    /// working tree's branch. Asked every time: a branch changes with no
    /// event to say so.
    pub async fn kb(&self) -> Result<KbDescription, SemiontError> {
        let answer = self
            .links
            .request::<BrowseKbRequested>(&BrowseKbRequest {})
            .await?;
        Ok(answer.response)
    }

    // ── Signals ─────────────────────────────────────────────────────────

    /// Signal: open an annotation for this viewer.
    pub fn click(&self, annotation_id: &AnnotationId) {
        self.links.signal::<BrowseClick>(
            &BrowseClickEvent {
                annotation_id: annotation_id.clone(),
            },
            Envelope::default(),
        );
    }

    /// Signal: open a resource for this viewer.
    pub fn open_resource(&self, resource_id: &ResourceId) {
        self.links.signal::<BrowseResourceOpen>(
            &BrowseResourceOpenEvent {
                resource_id: resource_id.clone(),
            },
            Envelope::default(),
        );
    }

    /// Report, over the wire, that this viewer arrived at a resource.
    pub fn resource_viewed(&self, resource_id: &ResourceId) {
        self.links
            .report::<BrowseResourceViewed>(&BrowseResourceViewedEvent {
                resource_id: resource_id.clone(),
            });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use bytes::Bytes;

    fn content(bytes: &'static [u8], content_type: &str) -> Content {
        Content {
            bytes: Bytes::from_static(bytes),
            content_type: content_type.to_owned(),
        }
    }

    #[test]
    fn utf8_is_read_as_a_browser_reads_it() {
        assert_eq!(
            text(content(b"caf\xc3\xa9", "text/plain")),
            Ok("café".to_owned())
        );
        assert_eq!(
            text(content(b"\xef\xbb\xbfhello", "text/plain; charset=UTF-8")),
            Ok("hello".to_owned())
        );
        assert_eq!(
            text(content(b"a\xffb", "text/plain;charset=utf8")),
            Ok("a\u{fffd}b".to_owned())
        );
    }

    #[cfg(feature = "charsets")]
    #[test]
    fn another_charset_is_read_as_a_browser_reads_it() {
        // A label is the encoding the Encoding Standard gives it: Latin-1
        // is windows-1252, as it is to every browser.
        for (bytes, media_type, read) in [
            (&b"caf\xe9"[..], "text/plain; charset=ISO-8859-1", "café"),
            (&b"\x80 5"[..], "text/plain;charset=latin1", "€ 5"),
            (
                &b"\x93quoted\x94"[..],
                "text/plain; charset=windows-1252",
                "“quoted”",
            ),
            (
                &b"\x82\xb1\x82\xf1"[..],
                "text/plain; charset=Shift_JIS",
                "こん",
            ),
            (
                &b"\xff\xfeh\x00i\x00"[..],
                "text/plain; charset=utf-16le",
                "hi",
            ),
            (
                &b"\xcf\xf0\xe8"[..],
                "text/markdown; charset=windows-1251",
                "При",
            ),
        ] {
            let content = Content {
                bytes: Bytes::copy_from_slice(bytes),
                content_type: media_type.to_owned(),
            };
            assert_eq!(text(content), Ok(read.to_owned()), "{media_type}");
        }
    }

    #[test]
    fn a_charset_that_is_not_decoded_is_refused_by_name() {
        let refusal = text(content(b"caf\xe9", "text/plain; charset=x-no-such-charset"))
            .expect_err("no encoding has that label");
        assert_eq!(refusal.code, TransportErrorCode::Error);
        assert!(
            refusal.message.contains("x-no-such-charset"),
            "{}",
            refusal.message
        );
    }

    #[cfg(not(feature = "charsets"))]
    #[test]
    fn without_the_charsets_feature_only_utf8_is_decoded() {
        let refusal = text(content(b"caf\xe9", "text/plain; charset=ISO-8859-1"))
            .expect_err("latin-1 is not decoded");
        assert_eq!(refusal.code, TransportErrorCode::Error);
        assert!(refusal.message.contains("iso-8859-1"));
    }
}
