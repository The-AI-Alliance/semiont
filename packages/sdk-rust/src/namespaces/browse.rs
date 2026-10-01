//! Browse: reads. The queries (`Cached`) are sent when their `fresh` is
//! called; the one-shot reads are asked once and never kept; and the signals
//! are this viewer's own, with the one report among them going over the wire.

use crate::bus::{LIMITS_OPERATIONS, Operation, operation};
use crate::cached::Cached;
use crate::channels::{
    BrowseAgentsRequested, BrowseAnchoredTextRequested, BrowseAnnotationHistoryRequested,
    BrowseAnnotationRequested, BrowseAnnotationsRequested, BrowseClick, BrowseDirectoryRequested,
    BrowseEntityTypesRequested, BrowseEventsRequested, BrowseKbRequested,
    BrowseReferencedByRequested, BrowseResourceOpen, BrowseResourceRequested, BrowseResourceViewed,
    BrowseResourcesRequested, BrowseTagSchemasRequested,
};
use crate::client::Links;
use crate::errors::{SemiontError, TransportError, TransportErrorCode};
use crate::transport::{BoxFuture, Content, ContentStream, ContentTransport, Envelope};
use crate::types::{
    Agent, AnchoredTextAnswer, Annotation, BrowseAgentsRequest, BrowseAnchoredTextRequest,
    BrowseAnnotationHistoryRequest, BrowseAnnotationRequest, BrowseAnnotationsRequest,
    BrowseClickEvent, BrowseDirectoryRequest, BrowseDirectoryRequestSort,
    BrowseDirectoryResultResponse, BrowseEntityTypesRequest, BrowseEventsRequest, BrowseKbRequest,
    BrowseReferencedByRequest, BrowseResourceOpenEvent, BrowseResourceRequest,
    BrowseResourceViewedEvent, BrowseResourcesRequest, BrowseTagSchemasRequest, CollaboratorEntry,
    GetAnnotationHistoryResponse, GetReferencedByResponseReferencedByItem, GetResourceResponse,
    InferenceLimits, InferenceLimitsResultResponse, InferencePairLimits, KbDescription,
    ListResourcesResponse, ResourceDescriptor, StoredEventResponse, TagSchema,
};
use serde_json::Map;
use std::sync::Arc;
use std::task::Poll;

/// How many resources a list asks for when its caller states no limit.
/// Every SDK asks for as many: the cases of specs/src/client/surface.json
/// hold each to it.
const LIST_LIMIT: i64 = 100;

/// Which resources a list is of. Each field that is stated narrows it.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ResourceFilters {
    pub limit: Option<i64>,
    pub archived: Option<bool>,
    /// Text to find. An empty search is no search.
    pub search: Option<String>,
    pub entity_type: Option<String>,
}

/// One of the knowledge base's collaborators: its entry in the directory,
/// and its model's limits when the service holding that model's credentials
/// reported them.
#[derive(Debug, Clone, PartialEq)]
pub struct Collaborator {
    pub entry: CollaboratorEntry,
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

/// The charset a media type states, lowercased.
fn charset(media_type: &str) -> Option<String> {
    let lower = media_type.to_ascii_lowercase();
    let stated = &lower[lower.find("charset=")? + "charset=".len()..];
    let end = stated
        .find(|c: char| c.is_whitespace() || c == ';')
        .unwrap_or(stated.len());
    Some(stated[..end].to_owned())
}

/// Bytes as the text their media type says they are. UTF-8 is read as a
/// browser reads it: a leading byte-order mark is not part of the text, and
/// a sequence that is not UTF-8 becomes U+FFFD. Any other charset is refused
/// rather than read as something it is not: the bytes are there to decode
/// (`resource_representation`).
fn text(content: Content) -> Result<String, TransportError> {
    match charset(&content.content_type).as_deref() {
        None | Some("utf-8" | "utf8") => {
            let text = String::from_utf8_lossy(&content.bytes);
            Ok(text.strip_prefix('\u{feff}').unwrap_or(&text).to_owned())
        }
        Some(other) => Err(TransportError::without_response(
            format!(
                "The resource's text is {other}, and only UTF-8 is decoded: read its bytes instead"
            ),
            TransportErrorCode::Error,
        )),
    }
}

pub struct BrowseNamespace {
    links: Links,
    content: Arc<dyn ContentTransport>,
}

impl BrowseNamespace {
    pub(crate) fn new(links: Links, content: Arc<dyn ContentTransport>) -> BrowseNamespace {
        BrowseNamespace { links, content }
    }

    // ── Queries ─────────────────────────────────────────────────────────

    pub fn resource(&self, resource_id: &str) -> Cached<ResourceDescriptor> {
        let links = self.links.clone();
        let request = BrowseResourceRequest {
            resource_id: resource_id.to_owned(),
        };
        Cached::new(move || async move {
            let answer = links.request::<BrowseResourceRequested>(&request).await?;
            Ok(answer.response.resource)
        })
    }

    /// A page of the resources `filters` admits, with how the answer was
    /// produced. A list is a query's answer: it is what the knowledge base
    /// held when it was asked.
    pub fn resources(&self, filters: ResourceFilters) -> Cached<ListResourcesResponse> {
        let links = self.links.clone();
        let request = BrowseResourcesRequest {
            search: filters.search.filter(|text| !text.is_empty()),
            archived: filters.archived,
            entity_type: filters.entity_type,
            offset: Some(0),
            limit: Some(filters.limit.unwrap_or(LIST_LIMIT)),
        };
        Cached::new(move || async move {
            let answer = links.request::<BrowseResourcesRequested>(&request).await?;
            Ok(answer.response)
        })
    }

    pub fn annotations(&self, resource_id: &str) -> Cached<Vec<Annotation>> {
        let links = self.links.clone();
        let request = BrowseAnnotationsRequest {
            resource_id: resource_id.to_owned(),
        };
        Cached::new(move || async move {
            let answer = links
                .request::<BrowseAnnotationsRequested>(&request)
                .await?;
            Ok(answer.response.annotations)
        })
    }

    pub fn annotation(&self, resource_id: &str, annotation_id: &str) -> Cached<Annotation> {
        let links = self.links.clone();
        let request = BrowseAnnotationRequest {
            resource_id: resource_id.to_owned(),
            annotation_id: annotation_id.to_owned(),
        };
        Cached::new(move || async move {
            let answer = links.request::<BrowseAnnotationRequested>(&request).await?;
            Ok(answer.response.annotation)
        })
    }

    pub fn entity_types(&self) -> Cached<Vec<String>> {
        let links = self.links.clone();
        Cached::new(move || async move {
            let answer = links
                .request::<BrowseEntityTypesRequested>(&BrowseEntityTypesRequest {})
                .await?;
            Ok(answer.response.entity_types)
        })
    }

    pub fn tag_schemas(&self) -> Cached<Vec<TagSchema>> {
        let links = self.links.clone();
        Cached::new(move || async move {
            let answer = links
                .request::<BrowseTagSchemasRequested>(&BrowseTagSchemasRequest {})
                .await?;
            Ok(answer.response.tag_schemas)
        })
    }

    /// The knowledge base's collaborators: the directory, asked for first,
    /// with each model's limits as the services holding its credentials
    /// report them.
    pub fn agents(&self) -> Cached<Vec<Collaborator>> {
        enum Answer {
            Directory(Result<Vec<CollaboratorEntry>, SemiontError>),
            Limits(Vec<InferencePairLimits>),
        }
        let links = self.links.clone();
        Cached::new(move || async move {
            let mut asked: Vec<BoxFuture<'_, Answer>> = vec![Box::pin(async {
                Answer::Directory(
                    links
                        .request::<BrowseAgentsRequested>(&BrowseAgentsRequest {})
                        .await
                        .map(|answer| answer.response.agents),
                )
            })];
            for holder in LIMITS_OPERATIONS.iter().filter_map(|name| operation(name)) {
                let links = &links;
                asked.push(Box::pin(async move {
                    Answer::Limits(limits_reported(links, holder).await)
                }));
            }
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

    pub fn referenced_by(
        &self,
        resource_id: &str,
    ) -> Cached<Vec<GetReferencedByResponseReferencedByItem>> {
        let links = self.links.clone();
        let request = BrowseReferencedByRequest {
            resource_id: resource_id.to_owned(),
            motivation: None,
        };
        Cached::new(move || async move {
            let answer = links
                .request::<BrowseReferencedByRequested>(&request)
                .await?;
            Ok(answer.response.referenced_by)
        })
    }

    pub fn events(&self, resource_id: &str) -> Cached<Vec<StoredEventResponse>> {
        let links = self.links.clone();
        let request = events_of(resource_id);
        Cached::new(move || async move {
            let answer = links.request::<BrowseEventsRequested>(&request).await?;
            Ok(answer.response.events)
        })
    }

    // ── One-shot reads ──────────────────────────────────────────────────

    /// A resource's bytes as text, in the charset their media type states.
    pub async fn resource_content(&self, resource_id: &str) -> Result<String, SemiontError> {
        Ok(text(self.content.get_binary(resource_id).await?)?)
    }

    /// A resource's description as linked data: itself, its annotations and
    /// the references to it.
    pub async fn resource_graph(
        &self,
        resource_id: &str,
    ) -> Result<GetResourceResponse, SemiontError> {
        Ok(self.content.get_resource_graph(resource_id).await?)
    }

    /// A resource's recovered text and the runs that index it, or the named
    /// reason there is none.
    pub async fn resource_anchored_text(
        &self,
        resource_id: &str,
    ) -> Result<AnchoredTextAnswer, SemiontError> {
        let answer = self
            .links
            .request::<BrowseAnchoredTextRequested>(&BrowseAnchoredTextRequest {
                resource_id: resource_id.to_owned(),
            })
            .await?;
        Ok(answer.response)
    }

    /// A resource's bytes, unchanged, with their media type.
    pub async fn resource_representation(
        &self,
        resource_id: &str,
    ) -> Result<Content, SemiontError> {
        Ok(self.content.get_binary(resource_id).await?)
    }

    /// The same, as a stream.
    pub async fn resource_representation_stream(
        &self,
        resource_id: &str,
    ) -> Result<ContentStream, SemiontError> {
        Ok(self.content.get_binary_stream(resource_id).await?)
    }

    pub async fn resource_events(
        &self,
        resource_id: &str,
    ) -> Result<Vec<StoredEventResponse>, SemiontError> {
        let answer = self
            .links
            .request::<BrowseEventsRequested>(&events_of(resource_id))
            .await?;
        Ok(answer.response.events)
    }

    pub async fn annotation_history(
        &self,
        resource_id: &str,
        annotation_id: &str,
    ) -> Result<GetAnnotationHistoryResponse, SemiontError> {
        let answer = self
            .links
            .request::<BrowseAnnotationHistoryRequested>(&BrowseAnnotationHistoryRequest {
                resource_id: resource_id.to_owned(),
                annotation_id: annotation_id.to_owned(),
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
    pub fn click(&self, annotation_id: &str) {
        self.links.signal::<BrowseClick>(
            &BrowseClickEvent {
                annotation_id: annotation_id.to_owned(),
            },
            Envelope::default(),
        );
    }

    /// Signal: open a resource for this viewer.
    pub fn open_resource(&self, resource_id: &str) {
        self.links.signal::<BrowseResourceOpen>(
            &BrowseResourceOpenEvent {
                resource_id: resource_id.to_owned(),
            },
            Envelope::default(),
        );
    }

    /// Report, over the wire, that this viewer arrived at a resource.
    pub fn resource_viewed(&self, resource_id: &str) {
        self.links
            .report::<BrowseResourceViewed>(&BrowseResourceViewedEvent {
                resource_id: resource_id.to_owned(),
            });
    }
}

fn events_of(resource_id: &str) -> BrowseEventsRequest {
    BrowseEventsRequest {
        resource_id: resource_id.to_owned(),
        r#type: None,
        user_id: None,
        limit: None,
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

    #[test]
    fn another_charset_is_refused_by_name() {
        let refusal = text(content(b"caf\xe9", "text/plain; charset=ISO-8859-1"))
            .expect_err("latin-1 is not decoded");
        assert_eq!(refusal.code, TransportErrorCode::Error);
        assert!(refusal.message.contains("iso-8859-1"));
    }
}
