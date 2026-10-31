//! Browse: reads. The queries (`Cached`) answer from the client's cache and
//! stay true as the knowledge base changes; the one-shot reads are asked
//! once and never kept; and the signals are this viewer's own, with the one
//! report among them going over the wire.
//!
//! What keeps a query true is specs/src/client/refresh.json
//! (`crate::refresh`), which the client's refresher applies to the caches
//! here (`super::refresher`): each event on the bus, and the reopening of a
//! dropped stream, asks again for the queries its row names, writes the ones
//! whose new value the event carries, and ends the ones whose entity is gone
//! (docs/protocol/CACHE-SEMANTICS.md B12–B13b, B19, B20).

use super::refresher::Subject;
use crate::bus::{LIMITS_OPERATIONS, Operation, operation};
use crate::cache::{Cache, CacheKey, CachePersister, CacheState, CacheValue, StoragePersister};
use crate::cached::{Cached, Keyed, Observed, Source};
use crate::channels::{
    BrowseAnnotationHistoryRequested, BrowseAnnotationRequested, BrowseClick,
    BrowseDirectoryRequested, BrowseEnginesRequested, BrowseEntityTypesRequested,
    BrowseEventsRequested, BrowseKbRequested, BrowseResourceOpen, BrowseResourceRequested,
    BrowseResourceViewed, BrowseResourcesRequested, BrowseTagSchemasRequested,
};
use crate::client::{CachePersistence, Links};
use crate::errors::{BusRequestError, BusRequestErrorCode, SemiontError};
use crate::locked;
use crate::refresh::CacheQuery;
use crate::resources::decode_representation;
use crate::state_unit::StateUnit;
use crate::timing::{MAX_STORED_BYTES_COUNT, SAVE_DEBOUNCE};
use crate::transport::{BoxFuture, Content, ContentStream, ContentTransport, Envelope};
use crate::types::{
    AnchoredTextAnswer, Annotation, AttributedEvent, BrowseAnnotationHistoryRequest,
    BrowseAnnotationRequest, BrowseClickEvent, BrowseDirectoryRequest, BrowseDirectoryRequestSort,
    BrowseDirectoryResultResponse, BrowseEnginesRequest, BrowseEntityTypesRequest,
    BrowseEventsRequest, BrowseKbRequest, BrowseResourceOpenEvent, BrowseResourceRequest,
    BrowseResourceViewedEvent, BrowseResourcesRequest, BrowseTagSchemasRequest, EngineEntry,
    EngineLimits, GetAnnotationHistoryResponse, GetAnnotationsResponse, GetResourceResponse,
    InferenceLimits, InferenceLimitsResultResponse, KbDescription, ListResourcesResponse,
    ResourceDescriptor, TagSchema,
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
use tokio_stream::wrappers::WatchStream;

/// How many resources a list or a search asks for when its caller states no
/// limit. Every SDK asks for as many: the cases of
/// specs/src/client/surface.json hold each to it.
const LIST_LIMIT: u64 = 100;

/// The key of a query the knowledge base has one of.
pub(super) const WHOLE: &str = "_";

/// The version of what the persisted caches hold. A document of another
/// version reads as nothing kept, so this changes when a kept value's shape
/// does.
const PERSISTED_VERSION: u64 = 1;

/// Which resources a list, or a search, is of. Each field that is stated
/// narrows it.
#[derive(Debug, Clone, Default, PartialEq, Eq, Hash)]
pub struct ResourceFilters {
    /// How many resources at most: a hundred when not stated.
    pub limit: Option<u64>,
    /// How many of the resources admitted are passed over before the page
    /// begins: none when not stated.
    pub offset: Option<u64>,
    pub archived: Option<bool>,
    pub entity_type: Option<String>,
}

impl ResourceFilters {
    /// How many resources a request with these filters asks for.
    pub(crate) fn limit(&self) -> u64 {
        self.limit.unwrap_or(LIST_LIMIT)
    }

    /// How many resources a request with these filters passes over.
    pub(crate) fn offset(&self) -> u64 {
        self.offset.unwrap_or(0)
    }
}

/// One of the knowledge base's engines: its entry, and its limits when the
/// service holding its credentials reported them. As JSON the limits sit
/// beside the entry's own fields.
#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
pub struct EngineWithLimits {
    #[serde(flatten)]
    pub entry: EngineEntry,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limits: Option<InferenceLimits>,
}

/// The engines, each with the limits reported of it.
fn joined(engines: Vec<EngineEntry>, reported: &[EngineLimits]) -> Vec<EngineWithLimits> {
    engines
        .into_iter()
        .map(|entry| {
            let limits = reported
                .iter()
                .find(|report| report.engine == entry.engine)
                .map(|report| report.limits.clone());
            EngineWithLimits { entry, limits }
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

/// The engines one key holder reports the limits of. A holder that is down,
/// silent or mistaken reports none: its engines show no limits, and the
/// engines are not held up by it for longer than a request waits.
async fn limits_reported(links: &Links, operation: &Operation) -> Vec<EngineLimits> {
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

// ── The caches ──────────────────────────────────────────────────────────

/// The caches the namespace's queries answer from.
pub(super) struct Live {
    pub(super) resource: Cache<ResourceId, ResourceDescriptor>,
    pub(super) lists: Cache<ResourceFilters, ListResourcesResponse>,
    pub(super) annotations: Cache<ResourceId, GetAnnotationsResponse>,
    pub(super) annotation: Cache<AnnotationId, Annotation>,
    /// The resource each annotation that was asked for is of: an annotation
    /// is kept by its own id, and a request for it names its resource too.
    pub(super) annotation_of: Arc<Mutex<HashMap<AnnotationId, ResourceId>>>,
    pub(super) entity_types: Cache<String, Vec<String>>,
    pub(super) tag_schemas: Cache<String, Vec<TagSchema>>,
    pub(super) engines: Cache<String, Vec<EngineEntry>>,
    /// Each key holder's report of its engines' limits, by the operation
    /// that asks it.
    pub(super) limits: Cache<&'static str, Vec<EngineLimits>>,
    pub(super) events: Cache<ResourceId, Vec<AttributedEvent>>,
}

/// A cache the client's storage keeps under `name`, when it has one: the
/// small ones a returning client shows at once.
fn kept<K, V, F, Fut>(persistence: Option<&CachePersistence>, name: &str, fetch: F) -> Cache<K, V>
where
    K: CacheKey + Serialize + DeserializeOwned,
    V: CacheValue + Serialize + DeserializeOwned,
    F: Fn(K) -> Fut + Send + Sync + 'static,
    Fut: Future<Output = Result<V, Box<dyn std::error::Error + Send + Sync>>> + Send + 'static,
{
    match persistence {
        None => Cache::new(fetch),
        Some(persistence) => {
            let persister: Arc<dyn CachePersister<K, V>> = Arc::new(StoragePersister::new(
                persistence.storage.clone(),
                format!("semiont.cache.{}.{name}", persistence.key_prefix),
                PERSISTED_VERSION,
                MAX_STORED_BYTES_COUNT,
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
    fn new(
        links: &Links,
        content: &Arc<dyn ContentTransport>,
        persistence: Option<&CachePersistence>,
    ) -> Arc<Live> {
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
        let lists = Cache::new({
            let links = asking(links);
            move |filters: ResourceFilters| {
                let links = links.clone();
                async move {
                    let request = BrowseResourcesRequest {
                        limit: Some(filters.limit()),
                        archived: filters.archived,
                        offset: Some(filters.offset()),
                        entity_type: filters.entity_type,
                    };
                    let answer = links.request::<BrowseResourcesRequested>(&request).await?;
                    Ok(answer.response)
                }
            }
        });
        let annotations = kept(persistence, "annotations", {
            let content = content.clone();
            move |resource_id: ResourceId| {
                let content = content.clone();
                async move { Ok(content.get_annotations(&resource_id).await?) }
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
        let engines = Cache::new({
            let links = asking(links);
            move |_: String| {
                let links = links.clone();
                async move {
                    let answer = links
                        .request::<BrowseEnginesRequested>(&BrowseEnginesRequest {})
                        .await?;
                    Ok(answer.response.engines)
                }
            }
        });
        let limits = Cache::new({
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
        let events = Cache::new({
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

        Arc::new(Live {
            resource,
            lists,
            annotations,
            annotation,
            annotation_of,
            entity_types,
            tag_schemas,
            engines,
            limits,
            events,
        })
    }

    /// B13b: the event carries the value. The table's own build refuses a
    /// row that writes a query no event carries a value for.
    pub(super) fn write(&self, query: CacheQuery, subject: &Subject) {
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
    pub(super) fn remove(&self, query: CacheQuery, subject: &Subject) {
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
                Box::new(SemiontError::from(BusRequestError::new(
                    BusRequestErrorCode::NotFound,
                    format!("Annotation {annotation_id} was removed"),
                ))),
            );
        }
    }

    fn dispose(&self) {
        self.resource.dispose();
        self.lists.dispose();
        self.annotations.dispose();
        self.annotation.dispose();
        self.entity_types.dispose();
        self.tag_schemas.dispose();
        self.engines.dispose();
        self.limits.dispose();
        self.events.dispose();
        locked(&self.annotation_of).clear();
    }
}

impl Drop for Live {
    fn drop(&mut self) {
        self.dispose();
    }
}

/// The engines are out of date, and so is what each key holder reported.
pub(super) fn invalidate_engines(
    engines: &Cache<String, Vec<EngineEntry>>,
    limits: &Cache<&'static str, Vec<EngineLimits>>,
) {
    engines.invalidate(&WHOLE.to_owned());
    for holder in LIMITS_OPERATIONS {
        limits.invalidate(holder);
    }
}

// ── What a query answers from ───────────────────────────────────────────

/// The engines with each key holder's limits joined on.
struct Engines {
    engines: Cache<String, Vec<EngineEntry>>,
    limits: Cache<&'static str, Vec<EngineLimits>>,
}

/// The engines' state, with what the key holders have reported so far: a
/// holder that has not answered delays only its own engines' limits.
struct Joined {
    engines: WatchStream<CacheState<Vec<EngineEntry>>>,
    reports: Vec<WatchStream<CacheState<Vec<EngineLimits>>>>,
    entries: Option<CacheState<Vec<EngineEntry>>>,
    reported: Vec<Vec<EngineLimits>>,
}

impl Stream for Joined {
    type Item = CacheState<Vec<EngineWithLimits>>;

    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        let this = &mut *self;
        let mut changed = false;
        loop {
            match Pin::new(&mut this.engines).poll_next(cx) {
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

impl Source<Vec<EngineWithLimits>> for Engines {
    fn fresh(
        &self,
    ) -> BoxFuture<'static, Result<Vec<EngineWithLimits>, Arc<dyn std::error::Error + Send + Sync>>>
    {
        enum Answer {
            Engines(Result<Vec<EngineEntry>, Arc<dyn std::error::Error + Send + Sync>>),
            Limits(Vec<EngineLimits>),
        }
        // The engines are asked for first; each key holder's limits after them.
        let mut asked: Vec<BoxFuture<'static, Answer>> = vec![Box::pin({
            let engines = self.engines.fetch(&WHOLE.to_owned());
            async move { Answer::Engines(engines.await) }
        })];
        for holder in LIMITS_OPERATIONS {
            let limits = self.limits.fetch(holder);
            asked.push(Box::pin(async move {
                Answer::Limits(limits.await.unwrap_or_default())
            }));
        }
        Box::pin(async move {
            let mut engines = Vec::new();
            let mut reported = Vec::new();
            for answer in all(asked).await {
                match answer {
                    Answer::Engines(entries) => engines = entries?,
                    Answer::Limits(limits) => reported.extend(limits),
                }
            }
            Ok(joined(engines, &reported))
        })
    }

    fn watch(&self) -> Observed<Vec<EngineWithLimits>> {
        Observed::new(
            Joined {
                engines: self.engines.observe(&WHOLE.to_owned()),
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
        invalidate_engines(&self.engines, &self.limits);
    }
}

pub struct BrowseNamespace {
    links: Links,
    content: Arc<dyn ContentTransport>,
    pub(super) live: Arc<Live>,
}

impl BrowseNamespace {
    pub(crate) fn new(
        links: Links,
        content: Arc<dyn ContentTransport>,
        persistence: Option<&CachePersistence>,
    ) -> BrowseNamespace {
        BrowseNamespace {
            live: Live::new(&links, &content, persistence),
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

    /// End the queries: every watcher's stream ends, and what was owed to
    /// storage is saved.
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
            scope: Some((self.links.transport.clone(), resource_id.clone())),
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

    /// A page of the resources `filters` admits. A list is a query's answer:
    /// it is asked for again when a resource is created, updated, cloned or
    /// moved, and when a dropped stream reopens, and not by a change to a
    /// resource whose scope the client does not hold. Finding resources by
    /// text is `match_.resources`.
    pub fn resources(&self, filters: ResourceFilters) -> Cached<ListResourcesResponse> {
        Cached::of(Keyed {
            cache: self.live.lists.clone(),
            key: filters,
            view: |value| value,
            scope: None,
        })
    }

    /// A resource's annotations. Read as content is, and not over the bus.
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

    /// The knowledge base's engines, asked for first, each with its limits
    /// as the service holding its credentials reports them.
    pub fn engines(&self) -> Cached<Vec<EngineWithLimits>> {
        Cached::of(Engines {
            engines: self.live.engines.clone(),
            limits: self.live.limits.clone(),
        })
    }

    pub fn events(&self, resource_id: &ResourceId) -> Cached<Vec<AttributedEvent>> {
        self.of_resource(&self.live.events, resource_id, resource_id, |value| value)
    }

    // ── One-shot reads ──────────────────────────────────────────────────

    /// A resource's bytes as the text they are
    /// (`resources::decode_representation`): in the charset their content
    /// type states, UTF-8 when it states none, and in the encoding of a
    /// byte-order mark where they begin with one. Without the `charsets`
    /// feature, only when that is UTF-8. A resource whose text is not its
    /// bytes is refused: a PDF, whose text is `resource_anchored_text`'s, and
    /// an image, which has none.
    pub async fn resource_content(&self, resource_id: &ResourceId) -> Result<String, SemiontError> {
        let content = self.content.get_binary(resource_id).await?;
        Ok(decode_representation(
            &content.bytes,
            &content.content_type,
        )?)
    }

    /// A resource's description as linked data: itself and its annotations.
    pub async fn resource_graph(
        &self,
        resource_id: &ResourceId,
    ) -> Result<GetResourceResponse, SemiontError> {
        Ok(self.content.get_resource_graph(resource_id).await?)
    }

    /// A resource's recovered text and the runs that index it, or the named
    /// reason there is none. Read as content is, and not over the bus: it is
    /// as large as the resource.
    pub async fn resource_anchored_text(
        &self,
        resource_id: &ResourceId,
    ) -> Result<AnchoredTextAnswer, SemiontError> {
        Ok(self.content.get_anchored_text(resource_id).await?)
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
    ) -> Result<Vec<AttributedEvent>, SemiontError> {
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
