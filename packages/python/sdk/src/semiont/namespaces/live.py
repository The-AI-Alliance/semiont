"""The caches a client's queries answer from, and what an event does to them.

One of these is a client's: `browse`, `gather` and `match` build their
queries over it, and the client's refresher (`semiont.namespaces.refresher`)
keeps it true.

What each query's cache holds is the type `protocol/specs/src/client/refresh.json`'s
`value` names for it (`CACHE_VALUES`), and what a kept query's document keeps.
"""

import asyncio
from collections.abc import Coroutine, Hashable, Mapping
from dataclasses import dataclass
from types import MappingProxyType
from typing import Final, NamedTuple, TypeAliasType, final, override

from pydantic import TypeAdapter

from semiont.cache import Cache, Runs
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
from semiont.stored import KEPT_QUERIES, WHOLE_KEY, KeptQuery, WholeKey, cache_key
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

__all__ = [
    "CACHE_VALUES",
    "LIMITS_HOLDERS",
    "AnnotationValue",
    "AnnotationsValue",
    "CachePersistence",
    "EnginesValue",
    "EntityTypesValue",
    "EventsValue",
    "KeptPersisters",
    "Live",
    "MatchedResourcesValue",
    "ReferencedByValue",
    "ResourceFilters",
    "ResourceSearch",
    "ResourceValue",
    "ResourcesValue",
    "Subject",
    "TagSchemasValue",
]

type ResourceValue = ResourceDescriptor
type AnnotationsValue = GetAnnotationsResponse
type AnnotationValue = Annotation
type EventsValue = list[AttributedEvent]
type ReferencedByValue = list[GetReferencedByResponseReferencedByItem]
type ResourcesValue = ListResourcesResponse
type MatchedResourcesValue = MatchResourcesResponse
type EntityTypesValue = list[str]
type TagSchemasValue = list[TagSchema]
type EnginesValue = list[EngineEntry]

CACHE_VALUES: Final[Mapping[CacheQuery, TypeAliasType]] = MappingProxyType(
    {
        "resource": ResourceValue,
        "annotations": AnnotationsValue,
        "annotation": AnnotationValue,
        "events": EventsValue,
        "referencedBy": ReferencedByValue,
        "resources": ResourcesValue,
        "matchedResources": MatchedResourcesValue,
        "entityTypes": EntityTypesValue,
        "tagSchemas": TagSchemasValue,
        "engines": EnginesValue,
    }
)
"""What each query's cache holds, in the refresh table's order: a hand-written mirror of each row's `value`, which the
census in tests/test_tables.py holds to the table."""

_HOLDERS: Final = {operation.request.name: operation for operation in LIMITS_OPERATIONS}
LIMITS_HOLDERS: Final = tuple(_HOLDERS)
"""The key of each key holder's report of its engines' limits: the name of the operation that asks it."""

_RESOURCE_ID: Final = TypeAdapter(ResourceId)
_ANNOTATION_ID: Final = TypeAdapter(AnnotationId)
_WHOLE_KEY: Final = TypeAdapter[WholeKey](WholeKey)


@final
@dataclass(frozen=True, slots=True, kw_only=True)
class CachePersistence:
    """Where a client keeps what its queries hold for one person, so their next client of the same knowledge base shows it at once.

    The queries `semiont.stored.KEPT_QUERIES` names are kept: a resource's
    description, its annotations, one annotation, the entity types, the tag
    schemas. Each is a document in `storage`, under
    `semiont.stored.cache_key(kb_id, person_key, query)`.
    """

    storage: SessionStorage
    kb_id: str
    person_key: str
    """The person's key (`semiont.stored.person_key`), never their did."""


def _persister[K: Hashable, V](
    persistence: CachePersistence, query: KeptQuery, key: TypeAdapter[K], value: TypeAdapter[V]
) -> StoragePersister[K, V]:
    """What keeps the cache of `query` where `persistence` says."""
    kept_under = cache_key(persistence.kb_id, persistence.person_key, query)
    return StoragePersister(persistence.storage, kept_under, key=key, value=value, max_bytes=MAX_STORED_BYTES_COUNT)


@final
class KeptPersisters:
    """What keeps each query a client keeps in `persistence`: what its entries are keyed by, and what each keeps."""

    def __init__(self, persistence: CachePersistence) -> None:
        self.resource: Final = _persister(persistence, "resource", _RESOURCE_ID, TypeAdapter[ResourceValue](ResourceValue))
        self.annotations: Final = _persister(persistence, "annotations", _RESOURCE_ID, TypeAdapter[AnnotationsValue](AnnotationsValue))
        self.annotation: Final = _persister(persistence, "annotation", _ANNOTATION_ID, TypeAdapter[AnnotationValue](AnnotationValue))
        self.entity_types: Final = _persister(persistence, "entityTypes", _WHOLE_KEY, TypeAdapter[EntityTypesValue](EntityTypesValue))
        self.tag_schemas: Final = _persister(persistence, "tagSchemas", _WHOLE_KEY, TypeAdapter[TagSchemasValue](TagSchemasValue))


@final
class _Counted(Runs):
    """What runs the fetches of the caches a client keeps, and how many of its tasks have not ended.

    A task is counted from when a cache starts it, before its first turn: a
    fetch just asked for is running, though it has not yet begun.
    """

    def __init__(self, links: Links) -> None:
        self._links: Final = links
        self.running = 0

    @override
    def run[T](self, work: Coroutine[object, object, T]) -> asyncio.Task[T]:
        task = self._links.run(work)
        self.running += 1
        task.add_done_callback(self._ended)
        return task

    def _ended(self, _: asyncio.Task[object]) -> None:
        self.running -= 1


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
        self._keeping = False
        """Whether the kept queries' caches were given their persisters (`attach`)."""
        self._kept_tasks: Final = _Counted(links)
        """What runs the kept queries' caches' fetches."""
        self.annotation_of: Final[dict[AnnotationId, ResourceId]] = {}
        """The resource each annotation that was asked for is of: an annotation
        is kept by its own id, and a request for it names its resource too."""

        self.resource: Final = Cache[ResourceId, ResourceValue](self._resource, tasks=self._runs("resource"))
        self.lists: Final = Cache[ResourceFilters, ResourcesValue](self._list, tasks=self._runs("resources"))
        self.annotations: Final = Cache[ResourceId, AnnotationsValue](self._annotations, tasks=self._runs("annotations"))
        self.annotation: Final = Cache[AnnotationId, AnnotationValue](self._annotation, tasks=self._runs("annotation"))
        self.entity_types: Final = Cache[WholeKey, EntityTypesValue](self._entity_types, tasks=self._runs("entityTypes"))
        self.tag_schemas: Final = Cache[WholeKey, TagSchemasValue](self._tag_schemas, tasks=self._runs("tagSchemas"))
        self.engines: Final = Cache[WholeKey, EnginesValue](self._engines, tasks=self._runs("engines"))
        self.limits: Final = Cache[str, list[EngineLimits]](self._limits, tasks=links)
        """Each key holder's report of its engines' limits, by the operation that asks it."""
        self.events: Final = Cache[ResourceId, EventsValue](self.events_of, tasks=self._runs("events"))
        self.referenced_by: Final = Cache[ResourceId, ReferencedByValue](self._referenced_by, tasks=self._runs("referencedBy"))
        self.searches: Final = Cache[ResourceSearch, MatchedResourcesValue](self._search, tasks=self._runs("matchedResources"))
        self._caches: Final = (
            self.resource,
            self.lists,
            self.annotations,
            self.annotation,
            self.entity_types,
            self.tag_schemas,
            self.engines,
            self.limits,
            self.events,
            self.referenced_by,
            self.searches,
        )
        """Every cache: what is kept is whichever was given a persister (`attach`)."""
        if persistence is not None:
            self.attach(persistence)

    def attach(self, persistence: CachePersistence) -> None:
        """Keep each kept query's cache where `persistence` says, from now on, beginning with what was kept there."""
        kept = KeptPersisters(persistence)
        self.resource.attach(kept.resource)
        self.annotations.attach(kept.annotations)
        self.annotation.attach(kept.annotation)
        self.entity_types.attach(kept.entity_types)
        self.tag_schemas.attach(kept.tag_schemas)
        self._keeping = True

    def _runs(self, query: CacheQuery) -> Runs:
        """What runs the fetches of `query`'s cache: the counted tasks (`_kept_tasks`) for a query a client keeps."""
        return self._kept_tasks if query in KEPT_QUERIES else self._links

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

    async def _resource(self, resource_id: ResourceId) -> ResourceValue:
        return (await self._links.request(BROWSE_RESOURCE_REQUESTED, BrowseResourceRequest(resource_id=resource_id))).response.resource

    async def _list(self, filters: ResourceFilters) -> ResourcesValue:
        request = BrowseResourcesRequest(
            limit=filters.limit, offset=filters.offset, archived=filters.archived, entity_type=filters.entity_type
        )
        return (await self._links.request(BROWSE_RESOURCES_REQUESTED, request)).response

    async def _annotations(self, resource_id: ResourceId) -> AnnotationsValue:
        return await self._content.get_annotations(resource_id)

    async def _annotation(self, annotation_id: AnnotationId) -> AnnotationValue:
        resource_id = self.annotation_of.get(annotation_id)
        if resource_id is None:
            raise BusRequestError("bus.rejected", f"Cannot ask for annotation {annotation_id}: the resource it is of is not known")
        request = BrowseAnnotationRequest(resource_id=resource_id, annotation_id=annotation_id)
        return (await self._links.request(BROWSE_ANNOTATION_REQUESTED, request)).response.annotation

    async def _entity_types(self, _: WholeKey) -> EntityTypesValue:
        return (await self._links.request(BROWSE_ENTITY_TYPES_REQUESTED, BrowseEntityTypesRequest())).response.entity_types

    async def _tag_schemas(self, _: WholeKey) -> TagSchemasValue:
        return (await self._links.request(BROWSE_TAG_SCHEMAS_REQUESTED, BrowseTagSchemasRequest())).response.tag_schemas

    async def _engines(self, _: WholeKey) -> EnginesValue:
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

    async def events_of(self, resource_id: ResourceId) -> EventsValue:
        """A resource's events, each with who it is attributed to, asked for now."""
        return (await self._links.request(BROWSE_EVENTS_REQUESTED, BrowseEventsRequest(resource_id=resource_id))).response.events

    async def _referenced_by(self, resource_id: ResourceId) -> ReferencedByValue:
        answer = await self._links.request(GATHER_REFERENCED_BY_REQUESTED, GatherReferencedByRequest(resource_id=resource_id))
        return answer.response.referenced_by

    async def _search(self, search: ResourceSearch) -> MatchedResourcesValue:
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
        return not any(cache.persistence_pending for cache in self._caches)

    @property
    def fetching_what_it_keeps(self) -> bool:
        """Whether a cache the client keeps is fetching: what it would keep of that fetch, a disposal drops.

        Read by the tasks those caches run, each counted from when it is
        started until it has ended: a fetch let go of by an `invalidate`
        still writes its answer, and is fetching too.
        """
        return self._keeping and self._kept_tasks.running > 0

    def dispose(self) -> None:
        """End the queries: every watcher's states end, and what was owed to storage is saved."""
        self._disposed = True
        for cache in self._caches:
            cache.dispose()
        self.annotation_of.clear()
