"""The caches a client's queries answer from, and what an event does to them.

One of these is a client's: `browse`, `gather` and `match` build their
queries over it, and the client's refresher (`semiont.namespaces.refresher`)
keeps it true.
"""

from collections.abc import Hashable
from dataclasses import dataclass
from typing import Final, NamedTuple, final

from pydantic import TypeAdapter

from semiont.cache import Cache
from semiont.cached import Cached, Source
from semiont.errors import BusRequestError, SemiontError
from semiont.identifiers import AnnotationId, ResourceId
from semiont.namespaces.links import Links
from semiont.operations import (
    BROWSE_ANNOTATION_REQUESTED,
    BROWSE_ENGINES_REQUESTED,
    BROWSE_ENTITY_TYPES_REQUESTED,
    BROWSE_EVENTS_REQUESTED,
    BROWSE_RESOURCE_REQUESTED,
    BROWSE_RESOURCES_REQUESTED,
    BROWSE_TAG_SCHEMAS_REQUESTED,
    GATHER_REFERENCED_BY_REQUESTED,
    LIMITS_OPERATIONS,
    MATCH_RESOURCES_REQUESTED,
)
from semiont.refresh import CacheQuery, CacheRefreshWhen
from semiont.storage import SessionStorage, StoragePersister
from semiont.stored import WHOLE_KEY, KeptQuery, WholeKey, cache_key
from semiont.timing import MAX_STORED_BYTES_COUNT
from semiont.transport import ContentTransport
from semiont.types import (
    Annotation,
    AttributedEvent,
    BrowseAnnotationRequest,
    BrowseEnginesRequest,
    BrowseEntityTypesRequest,
    BrowseEventsRequest,
    BrowseResourceRequest,
    BrowseResourcesRequest,
    BrowseTagSchemasRequest,
    EngineEntry,
    EngineLimits,
    GatherReferencedByRequest,
    GetAnnotationsResponse,
    GetReferencedByResponseReferencedByItem,
    InferenceLimitsRequest,
    ListResourcesResponse,
    MatchResourcesRequest,
    MatchResourcesResponse,
    ResourceDescriptor,
    TagSchema,
)

__all__ = ["LIMITS_HOLDERS", "CachePersistence", "KeptPersisters", "Live", "ResourceFilters", "ResourceSearch", "Subject"]

_HOLDERS: Final = {operation.request.name: operation for operation in LIMITS_OPERATIONS}
LIMITS_HOLDERS: Final = tuple(_HOLDERS)
"""The key of each key holder's report of its engines' limits: the name of the operation that asks it."""

_RESOURCE_ID: Final = TypeAdapter(ResourceId)
_ANNOTATION_ID: Final = TypeAdapter(AnnotationId)
_WHOLE_KEY: Final = TypeAdapter[WholeKey](WholeKey)


@final
@dataclass(frozen=True, slots=True, kw_only=True)
class CachePersistence:
    """Where a client keeps what its queries hold, so the next client of the same knowledge base shows it at once.

    The small queries are kept (`semiont.stored.KEPT_QUERIES`): a resource's
    description, its annotations, one annotation, the entity types, the tag
    schemas. Each is a document in `storage`, under
    `semiont.cache.<key_prefix>.<query>`.
    """

    storage: SessionStorage
    key_prefix: str


def _persister[K: Hashable, V](
    persistence: CachePersistence, query: KeptQuery, key: TypeAdapter[K], value: TypeAdapter[V]
) -> StoragePersister[K, V]:
    return StoragePersister(
        persistence.storage, cache_key(persistence.key_prefix, query), key=key, value=value, max_bytes=MAX_STORED_BYTES_COUNT
    )


@final
class KeptPersisters:
    """What keeps each query a client keeps in `persistence`: what its entries are keyed by, and what each keeps."""

    def __init__(self, persistence: CachePersistence) -> None:
        self.resource: Final = _persister(persistence, "resource", _RESOURCE_ID, TypeAdapter(ResourceDescriptor))
        self.annotations: Final = _persister(persistence, "annotations", _RESOURCE_ID, TypeAdapter(GetAnnotationsResponse))
        self.annotation: Final = _persister(persistence, "annotation", _ANNOTATION_ID, TypeAdapter(Annotation))
        self.entity_types: Final = _persister(persistence, "entityTypes", _WHOLE_KEY, TypeAdapter[list[str]](list[str]))
        self.tag_schemas: Final = _persister(persistence, "tagSchemas", _WHOLE_KEY, TypeAdapter[list[TagSchema]](list[TagSchema]))


class ResourceFilters(NamedTuple):
    """Which resources a list, or a search, is of, and which page of them."""

    limit: int
    offset: int
    archived: bool | None
    entity_type: str | None


class ResourceSearch(NamedTuple):
    """A search for resources by text, among those its filters admit."""

    search: str
    filters: ResourceFilters


@final
@dataclass(frozen=True, slots=True, kw_only=True)
class Subject:
    """What an event names.

    Which of a split channel's rows it is, the keys a row that reaches its
    subject acts on, and the value an enriched event carries.
    """

    when: CacheRefreshWhen | None = None
    resource: ResourceId | None = None
    annotation: AnnotationId | None = None
    written: Annotation | None = None


@final
class Live:
    """See the module's documentation."""

    def __init__(self, links: Links, content: ContentTransport, persistence: CachePersistence | None) -> None:
        self._links: Final = links
        self._content: Final = content
        self._kept_true = False
        self._disposed = False
        self.annotation_of: Final[dict[AnnotationId, ResourceId]] = {}
        """The resource each annotation that was asked for is of: an annotation
        is kept by its own id, and a request for it names its resource too."""

        # With no storage, nothing is kept.
        kept = None if persistence is None else KeptPersisters(persistence)
        self.resource: Final = Cache(self._resource, tasks=links, persister=None if kept is None else kept.resource)
        self.lists: Final = Cache(self._list, tasks=links)
        self.annotations: Final = Cache(self._annotations, tasks=links, persister=None if kept is None else kept.annotations)
        self.annotation: Final = Cache(self._annotation, tasks=links, persister=None if kept is None else kept.annotation)
        self.entity_types: Final = Cache(self._entity_types, tasks=links, persister=None if kept is None else kept.entity_types)
        self.tag_schemas: Final = Cache(self._tag_schemas, tasks=links, persister=None if kept is None else kept.tag_schemas)
        self.engines: Final = Cache(self._engines, tasks=links)
        self.limits: Final = Cache(self._limits, tasks=links)
        """Each key holder's report of its engines' limits, by the operation that asks it."""
        self.events: Final = Cache(self.events_of, tasks=links)
        self.referenced_by: Final = Cache(self._referenced_by, tasks=links)
        self.searches: Final = Cache(self._search, tasks=links)

    def query[T](self, source: Source[T]) -> Cached[T]:
        """A live query of this client, answered from `source`."""
        return Cached(source, watchable=self._watchable)

    def kept_true(self) -> None:
        """The client is held: its refresher is listening, so what a watcher is shown stays true."""
        self._kept_true = True

    def _watchable(self) -> None:
        """Refuse a watcher that nothing would keep true: one of a client that is not held.

        Of a closed client there is nothing to watch, which is no fault.
        """
        if not self._kept_true and not self._disposed:
            raise RuntimeError("a live query is watched inside its client's `async with`: before it, nothing keeps the query true")

    # ── What each cache asks ────────────────────────────────────────────

    async def _resource(self, resource_id: ResourceId) -> ResourceDescriptor:
        return (await self._links.request(BROWSE_RESOURCE_REQUESTED, BrowseResourceRequest(resource_id=resource_id))).response.resource

    async def _list(self, filters: ResourceFilters) -> ListResourcesResponse:
        request = BrowseResourcesRequest(
            limit=filters.limit, offset=filters.offset, archived=filters.archived, entity_type=filters.entity_type
        )
        return (await self._links.request(BROWSE_RESOURCES_REQUESTED, request)).response

    async def _annotations(self, resource_id: ResourceId) -> GetAnnotationsResponse:
        return await self._content.get_annotations(resource_id)

    async def _annotation(self, annotation_id: AnnotationId) -> Annotation:
        resource_id = self.annotation_of.get(annotation_id)
        if resource_id is None:
            raise BusRequestError("bus.rejected", f"Cannot ask for annotation {annotation_id}: the resource it is of is not known")
        request = BrowseAnnotationRequest(resource_id=resource_id, annotation_id=annotation_id)
        return (await self._links.request(BROWSE_ANNOTATION_REQUESTED, request)).response.annotation

    async def _entity_types(self, _: WholeKey) -> list[str]:
        return (await self._links.request(BROWSE_ENTITY_TYPES_REQUESTED, BrowseEntityTypesRequest())).response.entity_types

    async def _tag_schemas(self, _: WholeKey) -> list[TagSchema]:
        return (await self._links.request(BROWSE_TAG_SCHEMAS_REQUESTED, BrowseTagSchemasRequest())).response.tag_schemas

    async def _engines(self, _: str) -> list[EngineEntry]:
        return (await self._links.request(BROWSE_ENGINES_REQUESTED, BrowseEnginesRequest())).response.engines

    async def _limits(self, holder: str) -> list[EngineLimits]:
        """The engines one key holder reports the limits of.

        A holder that is down, silent or mistaken reports none: its engines
        show no limits, and the engines are not held up by it for longer
        than a request waits.
        """
        try:
            return (await self._links.request(_HOLDERS[holder], InferenceLimitsRequest())).response.limits
        except SemiontError:
            return []

    async def events_of(self, resource_id: ResourceId) -> list[AttributedEvent]:
        """A resource's events, each with who it is attributed to, asked for now."""
        return (await self._links.request(BROWSE_EVENTS_REQUESTED, BrowseEventsRequest(resource_id=resource_id))).response.events

    async def _referenced_by(self, resource_id: ResourceId) -> list[GetReferencedByResponseReferencedByItem]:
        answer = await self._links.request(GATHER_REFERENCED_BY_REQUESTED, GatherReferencedByRequest(resource_id=resource_id))
        return answer.response.referenced_by

    async def _search(self, search: ResourceSearch) -> MatchResourcesResponse:
        filters = search.filters
        request = MatchResourcesRequest(
            search=search.search, limit=filters.limit, offset=filters.offset, archived=filters.archived, entity_type=filters.entity_type
        )
        return (await self._links.request(MATCH_RESOURCES_REQUESTED, request)).response

    # ── What an event does ──────────────────────────────────────────────

    def write(self, query: CacheQuery, subject: Subject) -> None:
        """The event carries the value: it is written, and nothing is asked for.

        Only an annotation is ever carried: the refresh table's own build
        refuses a row that writes a query no event carries a value for.
        """
        resource, written = subject.resource, subject.written
        if resource is None or written is None:
            return
        if query == "annotations":
            # Into the resource's list, when the client holds it: where the annotation was, or at its end.
            held = self.annotations.get(resource)
            if held is not None:
                listed = [written if annotation.id == written.id else annotation for annotation in held.annotations]
                if all(annotation.id != written.id for annotation in held.annotations):
                    listed.append(written)
                self.annotations.set(resource, held.model_copy(update={"annotations": listed}))
        elif query == "annotation":
            self.annotation_of[written.id] = resource
            self.annotation.set(written.id, written)

    def remove(self, query: CacheQuery, subject: Subject) -> None:
        """The event says the entity is gone. Only an annotation is ever said to be.

        One the cache holds is ended as not found. What says which resource
        it was of is kept: an observer arriving at the ended key asks the
        service, and that request names the resource.
        """
        annotation = subject.annotation
        if query == "annotation" and annotation is not None and self.annotation.known(annotation):
            self.annotation.remove(annotation, BusRequestError("bus.not-found", f"Annotation {annotation} was removed"))

    def invalidate_engines(self) -> None:
        """The engines are out of date, and so is what each key holder reported."""
        self.engines.invalidate(WHOLE_KEY)
        for holder in LIMITS_HOLDERS:
            self.limits.invalidate(holder)

    @property
    def persistence_settled(self) -> bool:
        """Whether every cache the client keeps is at rest: none is fetching, and none owes a save."""
        return not (
            self.resource.persistence_pending
            or self.annotations.persistence_pending
            or self.annotation.persistence_pending
            or self.entity_types.persistence_pending
            or self.tag_schemas.persistence_pending
        )

    def dispose(self) -> None:
        """End the queries: every watcher's states end, and what was owed to storage is saved."""
        self._disposed = True
        self.resource.dispose()
        self.lists.dispose()
        self.annotations.dispose()
        self.annotation.dispose()
        self.entity_types.dispose()
        self.tag_schemas.dispose()
        self.engines.dispose()
        self.limits.dispose()
        self.events.dispose()
        self.referenced_by.dispose()
        self.searches.dispose()
        self.annotation_of.clear()
