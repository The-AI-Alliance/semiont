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
use crate::cache::{
    Cache, CacheKey, CachePersister, CacheState, CacheValue, MAX_STORED_BYTES, SAVE_DEBOUNCE,
    StoragePersister,
};
use crate::cached::{Cached, Keyed, Observed, Source};
use crate::channels::{
    BrowseAgentsRequested, BrowseAnchoredTextRequested, BrowseAnnotationHistoryRequested,
    BrowseAnnotationRequested, BrowseAnnotationsRequested, BrowseClick, BrowseDirectoryRequested,
    BrowseEntityTypesRequested, BrowseEventsRequested, BrowseKbRequested, BrowseResourceOpen,
    BrowseResourceRequested, BrowseResourceViewed, BrowseResourcesRequested,
    BrowseTagSchemasRequested,
};
use crate::client::{CachePersistence, Links};
use crate::errors::{
    BusRequestError, BusRequestErrorCode, SemiontError, TransportError, TransportErrorCode,
};
use crate::locked;
use crate::refresh::CacheQuery;
use crate::state_unit::StateUnit;
use crate::transport::{BoxFuture, Content, ContentStream, ContentTransport, Envelope};
use crate::types::{
    Agent, AnchoredTextAnswer, Annotation, AttributedEvent, BrowseAgentsRequest,
    BrowseAnchoredTextRequest, BrowseAnnotationHistoryRequest, BrowseAnnotationRequest,
    BrowseAnnotationsRequest, BrowseClickEvent, BrowseDirectoryRequest, BrowseDirectoryRequestSort,
    BrowseDirectoryResultResponse, BrowseEntityTypesRequest, BrowseEventsRequest, BrowseKbRequest,
    BrowseResourceOpenEvent, BrowseResourceRequest, BrowseResourceViewedEvent,
    BrowseResourcesRequest, BrowseTagSchemasRequest, CollaboratorEntry,
    GetAnnotationHistoryResponse, GetAnnotationsResponse, GetResourceResponse, InferenceLimits,
    InferenceLimitsResultResponse, InferencePairLimits, KbDescription, ListResourcesResponse,
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
const LIST_LIMIT: i64 = 100;

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
    pub limit: Option<i64>,
    pub archived: Option<bool>,
    pub entity_type: Option<String>,
}

impl ResourceFilters {
    /// How many resources a request with these filters asks for.
    pub(crate) fn limit(&self) -> i64 {
        self.limit.unwrap_or(LIST_LIMIT)
    }
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
    pub(super) agents: Cache<String, Vec<CollaboratorEntry>>,
    /// Each key holder's report of its models' limits, by the operation
    /// that asks it.
    pub(super) limits: Cache<&'static str, Vec<InferencePairLimits>>,
    pub(super) events: Cache<ResourceId, Vec<AttributedEvent>>,
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
        let lists = Cache::new({
            let links = asking(links);
            move |filters: ResourceFilters| {
                let links = links.clone();
                async move {
                    let request = BrowseResourcesRequest {
                        limit: Some(filters.limit()),
                        archived: filters.archived,
                        entity_type: filters.entity_type,
                        offset: Some(0),
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
        let agents = Cache::new({
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
            agents,
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
                BusRequestError::new(
                    BusRequestErrorCode::NotFound,
                    format!("Annotation {annotation_id} was removed"),
                )
                .into(),
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
        self.agents.dispose();
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

/// The directory is out of date, and so is what each key holder reported.
pub(super) fn invalidate_agents(
    agents: &Cache<String, Vec<CollaboratorEntry>>,
    limits: &Cache<&'static str, Vec<InferencePairLimits>>,
) {
    agents.invalidate(&WHOLE.to_owned());
    for holder in LIMITS_OPERATIONS {
        limits.invalidate(holder);
    }
}

// ── What a query answers from ───────────────────────────────────────────

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

/// HTTP white space: line feed, carriage return, tab and space.
const HTTP_WHITE_SPACE: [char; 4] = ['\n', '\r', '\t', ' '];

/// An HTTP token: what a type, a subtype and a parameter's name are made of.
fn is_http_token(text: &str) -> bool {
    !text.is_empty()
        && text
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "!#$%&'*+-.^_`|~".contains(c))
}

/// What a parameter's value may hold: a tab, U+0020 to U+007E, and U+0080 to
/// U+00FF.
fn is_of_a_parameter_value(c: char) -> bool {
    c == '\t' || (' '..='~').contains(&c) || ('\u{80}'..='\u{ff}').contains(&c)
}

/// The quoted string that opens at `start`, without its quotation marks, and
/// where it ends.
fn quoted_string(input: &[char], start: usize) -> (String, usize) {
    let mut position = start + 1;
    let mut value = String::new();
    loop {
        while position < input.len() && input[position] != '"' && input[position] != '\\' {
            value.push(input[position]);
            position += 1;
        }
        if position >= input.len() {
            break;
        }
        let mark = input[position];
        position += 1;
        if mark == '"' {
            break;
        }
        // A backslash gives the character after it, and at the very end is
        // itself.
        if position >= input.len() {
            value.push('\\');
            break;
        }
        value.push(input[position]);
        position += 1;
    }
    (value, position)
}

/// The value of a content type's `charset` parameter, as the MIME Sniffing
/// Standard parses a MIME type: the first parameter of that name that is
/// one. None where there is none, and where the content type is no MIME
/// type.
fn charset(content_type: &str) -> Option<String> {
    let input: Vec<char> = content_type
        .trim_matches(HTTP_WHITE_SPACE)
        .chars()
        .collect();
    let slash = input.iter().position(|&c| c == '/')?;
    if !is_http_token(&input[..slash].iter().collect::<String>()) {
        return None;
    }
    let mut position = input[slash..]
        .iter()
        .position(|&c| c == ';')
        .map_or(input.len(), |at| slash + at);
    let subtype: String = input[slash + 1..position].iter().collect();
    if !is_http_token(subtype.trim_end_matches(HTTP_WHITE_SPACE)) {
        return None;
    }
    while position < input.len() {
        position += 1; // past the semicolon
        while position < input.len() && HTTP_WHITE_SPACE.contains(&input[position]) {
            position += 1;
        }
        let name_start = position;
        while position < input.len() && input[position] != ';' && input[position] != '=' {
            position += 1;
        }
        let name = input[name_start..position]
            .iter()
            .collect::<String>()
            .to_ascii_lowercase();
        if position < input.len() {
            if input[position] == ';' {
                continue;
            }
            position += 1; // past the equals sign
        }
        if position >= input.len() {
            break;
        }
        let value = if input[position] == '"' {
            let (value, end) = quoted_string(&input, position);
            position = end;
            while position < input.len() && input[position] != ';' {
                position += 1;
            }
            value
        } else {
            let value_start = position;
            while position < input.len() && input[position] != ';' {
                position += 1;
            }
            let value: String = input[value_start..position].iter().collect();
            let value = value.trim_end_matches(HTTP_WHITE_SPACE);
            if value.is_empty() {
                continue;
            }
            value.to_owned()
        };
        if name == "charset" && value.chars().all(is_of_a_parameter_value) {
            return Some(value);
        }
    }
    None
}

/// Bytes as the text they are, by the rule every reader of a resource's text
/// keeps (docs/protocol/W3C-SELECTORS.md, "The text of a resource"): the
/// MIME Sniffing Standard's reading of the content type and the Encoding
/// Standard's reading of the bytes, as a browser follows the two.
///
/// The charset is the one the content type states, UTF-8 when it states
/// none or an empty one, and is a label of the Encoding Standard: any other
/// is refused, whatever the bytes are. Bytes that begin with the byte-order
/// mark of UTF-8, UTF-16BE or UTF-16LE are in that encoding, whatever was
/// stated, and the mark is not part of the text. What the encoding does not
/// have is U+FFFD. A refusal names the charset: nothing is read as something
/// it is not, and the bytes are there to read (`resource_representation`).
fn text(content: Content) -> Result<String, TransportError> {
    let stated = charset(&content.content_type).filter(|label| !label.is_empty());
    #[cfg(feature = "charsets")]
    let read = every_charset(stated.as_deref(), &content.bytes);
    #[cfg(not(feature = "charsets"))]
    let read = utf8_alone(stated.as_deref(), &content.bytes);
    read.map_err(|not_decoded| {
        TransportError::without_response(
            format!("The resource's text is {not_decoded}: read its bytes instead"),
            TransportErrorCode::Error,
        )
    })
}

/// Every encoding of the Encoding Standard, by `encoding_rs`. What is not
/// decoded is the error, said as the refusal says it.
#[cfg(feature = "charsets")]
fn every_charset(label: Option<&str>, bytes: &[u8]) -> Result<String, String> {
    let encoding = match label {
        None => encoding_rs::UTF_8,
        // The label is held to the standard before the bytes are looked at.
        Some(label) => encoding_rs::Encoding::for_label_no_replacement(label.as_bytes())
            .ok_or_else(|| format!("{label}, which is no charset the Encoding Standard decodes"))?,
    };
    // The standard's `decode`: a leading mark decides the encoding, and is
    // left out.
    Ok(encoding.decode(bytes).0.into_owned())
}

#[cfg(any(test, not(feature = "charsets")))]
include!(concat!(env!("OUT_DIR"), "/utf8_labels.rs"));

/// UTF-8 alone, which is what a build without the `charsets` feature
/// decodes. It reads a text as the rule says or refuses it, and reads
/// nothing otherwise: a charset that is no label of UTF-8 is refused, and
/// so are bytes that begin with UTF-16's mark.
#[cfg(any(test, not(feature = "charsets")))]
fn utf8_alone(label: Option<&str>, bytes: &[u8]) -> Result<String, String> {
    const ALONE: &str = "and only UTF-8 is decoded without the `charsets` feature";
    // What the Encoding Standard drops from around a label.
    const ASCII_WHITE_SPACE: [char; 5] = ['\t', '\n', '\u{c}', '\r', ' '];
    if let Some(label) = label {
        let name = label.trim_matches(ASCII_WHITE_SPACE).to_ascii_lowercase();
        if !UTF_8_LABELS.contains(&name.as_str()) {
            return Err(format!("{label}, {ALONE}"));
        }
    }
    if bytes.starts_with(&[0xfe, 0xff]) || bytes.starts_with(&[0xff, 0xfe]) {
        return Err(format!("UTF-16 by its byte-order mark, {ALONE}"));
    }
    let bytes = bytes.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(bytes);
    Ok(String::from_utf8_lossy(bytes).into_owned())
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

    pub fn events(&self, resource_id: &ResourceId) -> Cached<Vec<AttributedEvent>> {
        self.of_resource(&self.live.events, resource_id, resource_id, |value| value)
    }

    // ── One-shot reads ──────────────────────────────────────────────────

    /// A resource's bytes as the text they are: in the charset their content
    /// type states, UTF-8 when it states none, and in the encoding of a
    /// byte-order mark where they begin with one. Without the `charsets`
    /// feature, only when that is UTF-8.
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

#[cfg(test)]
mod tests {
    //! What text a resource's bytes are is two tables every reader runs,
    //! specs/src/text/decode-cases.json and
    //! specs/src/text/encoding-cases.json, and tests/decode_cases.rs runs
    //! them through a client, whose reader in this crate's tests is
    //! `encoding_rs`. Here is the reader a build without the `charsets`
    //! feature has, which no client of these tests reaches: it decodes UTF-8
    //! alone, and is held to the same two tables. What it reads is what the
    //! table says, and what it does not decode it refuses.

    use super::*;
    use serde_json::Value;

    fn table(text: &str) -> Value {
        serde_json::from_str(text).expect("the table is JSON")
    }

    fn stated<'a>(case: &'a Value, key: &str) -> &'a str {
        case[key]
            .as_str()
            .unwrap_or_else(|| panic!("a case states no {key}: {case}"))
    }

    fn bytes_of(hexadecimal: &str) -> Vec<u8> {
        hexadecimal
            .split_whitespace()
            .map(|byte| u8::from_str_radix(byte, 16).expect("a byte"))
            .collect()
    }

    /// What the reader of UTF-8 alone makes of some bytes served with a
    /// content type.
    fn read(content_type: &str, bytes: &[u8]) -> Result<String, String> {
        let label = charset(content_type).filter(|label| !label.is_empty());
        utf8_alone(label.as_deref(), bytes)
    }

    #[cfg(feature = "charsets")]
    #[test]
    fn the_reader_of_utf8_alone_reads_a_case_as_the_table_has_it_or_refuses_it() {
        let table = table(include_str!("../../specs/text/decode-cases.json"));
        let (mut read_as_stated, mut refused) = (0, 0);
        for case in table["cases"].as_array().expect("cases") {
            let why = stated(case, "why");
            let content_type = stated(case, "contentType");
            let bytes = bytes_of(stated(case, "bytes"));
            // What the rule makes of the case, by the standard's own
            // implementation: the encoding stated, and the one a mark says.
            let label = charset(content_type).filter(|label| !label.is_empty());
            let utf8_is_stated = label.as_deref().is_none_or(|label| {
                encoding_rs::Encoding::for_label_no_replacement(label.as_bytes())
                    == Some(encoding_rs::UTF_8)
            });
            let utf16_is_marked = encoding_rs::Encoding::for_bom(&bytes)
                .is_some_and(|(encoding, _)| encoding != encoding_rs::UTF_8);
            let answer = read(content_type, &bytes);
            match case.get("text").and_then(Value::as_str) {
                Some(text) if utf8_is_stated && !utf16_is_marked => {
                    read_as_stated += 1;
                    assert_eq!(answer.as_deref(), Ok(text), "{why}");
                }
                _ => {
                    refused += 1;
                    let refusal = answer.expect_err(why);
                    if let Some(label) = case.get("refused").and_then(Value::as_str) {
                        assert!(refusal.contains(label), "{why}: {refusal}");
                    }
                }
            }
        }
        assert!(
            read_as_stated >= 25 && refused >= 40,
            "{read_as_stated} read and {refused} refused"
        );
    }

    #[test]
    fn the_reader_of_utf8_alone_takes_every_label_of_utf8_and_refuses_every_other() {
        let table = table(include_str!("../../specs/text/encoding-cases.json"));
        let (mut taken, mut refused) = (0, 0);
        let listed = table["cases"]
            .as_array()
            .expect("cases")
            .iter()
            .map(|case| (stated(case, "encoding"), &case["labels"]));
        let rest = table["legacyMultiByte"]
            .as_object()
            .expect("the legacy multi-byte encodings")
            .iter()
            .map(|(encoding, labels)| (encoding.as_str(), labels));
        for (encoding, labels) in listed.chain(rest) {
            for label in labels.as_array().expect("labels") {
                let label = label.as_str().expect("a label is text");
                let answer = read(&format!("text/plain; charset={label}"), b"\xc3\xa9");
                if encoding == "utf-8" {
                    taken += 1;
                    assert_eq!(answer.as_deref(), Ok("é"), "{label}");
                } else {
                    refused += 1;
                    let refusal = answer.expect_err(label);
                    assert!(refusal.contains(label), "{label}: {refusal}");
                }
            }
        }
        assert!(
            taken >= 6 && refused >= 200,
            "{taken} taken and {refused} refused"
        );
    }

    #[cfg(feature = "charsets")]
    #[test]
    fn the_reader_of_utf8_alone_reads_malformed_utf8_as_the_standards_decoder_does() {
        // Every sequence of up to three of the bytes at which UTF-8's rules
        // turn: the ends of each range of leading and of continuation bytes.
        const TURNS: [u8; 31] = [
            0x00, 0x41, 0x7f, 0x80, 0x8f, 0x90, 0x9f, 0xa0, 0xbf, 0xc0, 0xc1, 0xc2, 0xdf, 0xe0,
            0xe1, 0xec, 0xed, 0xee, 0xef, 0xf0, 0xf1, 0xf3, 0xf4, 0xf5, 0xf7, 0xf8, 0xfb, 0xfc,
            0xfd, 0xfe, 0xff,
        ];
        let mut sequences: Vec<Vec<u8>> = vec![vec![]];
        for _ in 0..3 {
            let longer: Vec<Vec<u8>> = sequences
                .iter()
                .flat_map(|sequence| {
                    TURNS.iter().map(move |&byte| {
                        let mut longer = sequence.clone();
                        longer.push(byte);
                        longer
                    })
                })
                .collect();
            sequences.extend(longer);
            sequences.sort();
            sequences.dedup();
        }
        assert!(sequences.len() > 30_000);
        for sequence in sequences {
            let answer = utf8_alone(None, &sequence);
            // What begins as UTF-16's mark does is UTF-16, which this reader
            // refuses.
            if sequence.starts_with(&[0xfe, 0xff]) || sequence.starts_with(&[0xff, 0xfe]) {
                assert!(answer.is_err(), "{sequence:02x?}");
                continue;
            }
            let standard = encoding_rs::UTF_8.decode_without_bom_handling(&sequence).0;
            assert_eq!(answer.as_deref(), Ok(&*standard), "{sequence:02x?}");
        }
    }

    #[test]
    fn the_reader_of_utf8_alone_refuses_utf16_by_its_mark_and_says_so() {
        for mark in [&b"\xff\xfeh\x00"[..], &b"\xfe\xff\x00h"[..]] {
            let refusal = read("text/plain", mark).expect_err("UTF-16 is not decoded");
            assert!(refusal.contains("UTF-16"), "{refusal}");
        }
    }
}
