"""What a graph database is asked and answers: the reader and the store every database's module is.

The graph is a projection of a knowledge base's record, kept for the queries
only a graph answers. One service writes it, and others read it: the one
that writes is handed a `GraphDatabase`, and one that reads a `GraphReader`,
which has the reads such a service makes and nothing that writes. What the
graph holds of a resource and of an annotation is `semiont_graph.codec`'s to
say, and is the same in every store: a store keeps its own dialect and
decides nothing about the shape.

A store is given what the record says and reads no clock of its own. A
resource's date and an annotation's `created` and `modified` are the ones it
is handed: a store that stamped its own would date everything again on every
rebuild.

No type of a database's client appears here. A service names this interface
and is handed a store or a reader by `semiont_graph.factory`.
"""

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Protocol, final

from pydantic import JsonValue
from semiont.identifiers import AnnotationId, ResourceId
from semiont.types import Annotation, Motivation, ResourceDescriptor

__all__ = [
    "EntityTypeCount",
    "GraphConnection",
    "GraphDatabase",
    "GraphPath",
    "GraphReader",
    "GraphStats",
    "ResourceChange",
    "ResourceListing",
    "ResourceQuery",
]


@final
@dataclass(frozen=True, slots=True, kw_only=True)
class ResourceChange:
    """What may change of a resource the graph holds: whether it is archived, and its entity types. A field left out is unchanged.

    A resource is otherwise as it was made. A change that names neither is
    refused, with `ValueError`.
    """

    archived: bool | None = None
    entity_types: Sequence[str] | None = None

    def __post_init__(self) -> None:
        if self.archived is None and self.entity_types is None:
            raise ValueError("Resources are immutable apart from archival state and entity tags.")


@final
@dataclass(frozen=True, slots=True, kw_only=True)
class ResourceQuery:
    """Which resources a listing answers, and which page of them.

    `entity_types` keeps a resource that has any of them. `search` keeps one
    in which every word of it appears: in its name, its storage location or
    one of its entity types. `archived` keeps the archived, or the rest. A
    filter left out filters nothing, and so does a search of only white
    space.

    A listing is in one order, so that paging neither repeats nor drops a
    resource: newest first, and by id where two were created at one moment.
    A search puts ahead of that how directly a resource answers it: one named
    exactly that, then one whose name begins with it, then one whose name has
    every word, then one whose location or entity types had to supply a word.
    """

    entity_types: Sequence[str] = ()
    search: str | None = None
    archived: bool | None = None
    offset: int = 0
    limit: int = 20


@final
@dataclass(frozen=True, slots=True, kw_only=True)
class ResourceListing:
    """A page of resources, and how many the query matched in all."""

    resources: list[ResourceDescriptor]
    total: int


@final
@dataclass(frozen=True, slots=True, kw_only=True)
class GraphConnection:
    """A resource another links to: the annotations on the one that link to it, and whether it links back."""

    target_resource: ResourceDescriptor
    annotations: list[Annotation]
    bidirectional: bool


@final
@dataclass(frozen=True, slots=True, kw_only=True)
class GraphPath:
    """A way from one resource to another along links: each resource on it, and the annotation that links each to the next."""

    resources: list[ResourceDescriptor]
    annotations: list[Annotation]


@final
@dataclass(frozen=True, slots=True, kw_only=True)
class EntityTypeCount:
    """How many resources have an entity type."""

    type: str
    count: int


@final
@dataclass(frozen=True, slots=True, kw_only=True)
class GraphStats:
    """What the graph holds, counted."""

    resource_count: int
    annotation_count: int
    highlight_count: int
    reference_count: int
    entity_reference_count: int
    """The references that state an entity type."""
    entity_types: dict[str, int]
    """How many resources have each entity type."""
    content_types: dict[str, int]
    """How many resources have each media type."""


class GraphReader(Protocol):
    """A graph database, as a service that only reads it asks it. Every reader has these members and no others.

    A reader writes nothing to its database, and makes nothing in it.
    """

    async def connect(self) -> None:
        """Reach the database. Raises where it cannot be reached.

        A reader makes nothing there. A store makes ready what it needs of
        the database, which is its own module's to say.
        """
        ...

    async def disconnect(self) -> None:
        """Let go of whatever `connect` took. One that was never connected has nothing to let go of."""
        ...

    # ── Resources ──────────────────────────────────────────────────────

    async def get_resource(self, resource_id: ResourceId) -> ResourceDescriptor | None: ...

    async def list_resources(self, query: ResourceQuery) -> ResourceListing: ...

    # ── What is linked to what ─────────────────────────────────────────

    async def get_resource_annotations(self, resource_id: ResourceId) -> list[Annotation]:
        """The annotations on a resource, newest first."""
        ...

    async def get_resource_referenced_by(self, resource_id: ResourceId, motivation: Motivation | None) -> list[Annotation]:
        """The annotations, on any resource, that link to this one, newest first: all of them, or those of one `motivation`."""
        ...

    async def get_resource_connections(self, resource_id: ResourceId) -> list[GraphConnection]:
        """The resources this one links to, one connection for each, with the annotations that link to it."""
        ...

    # ── What the graph holds, counted ──────────────────────────────────

    async def get_entity_type_stats(self) -> list[EntityTypeCount]:
        """How many resources have each entity type: the most first, and by name where two have as many."""
        ...


class GraphDatabase(GraphReader, Protocol):
    """A graph database, as the service that writes it asks it: a reader's members, the writes, and the rest of what a graph answers.

    Every store has these members and no others.
    """

    def is_connected(self) -> bool: ...

    # ── Resources ──────────────────────────────────────────────────────

    async def create_resource(self, resource: ResourceDescriptor) -> ResourceDescriptor:
        """Store a resource, and answer it as the graph holds it. Stored again, it is replaced: the write is the same twice."""
        ...

    async def update_resource(self, resource_id: ResourceId, change: ResourceChange) -> ResourceDescriptor:
        """Change what may change of a resource. Raises for one the graph does not hold."""
        ...

    async def delete_resource(self, resource_id: ResourceId) -> None:
        """Remove a resource and the annotations on it.

        Another resource's annotation that links here is that resource's, and
        stays, and so does its link: a resource deleted and stored again is
        followed by the same links.
        """
        ...

    # ── Annotations ────────────────────────────────────────────────────

    async def create_annotation(self, annotation: Annotation) -> Annotation:
        """Store an annotation under its own id, and answer it as the graph holds it.

        The id is the record's, and is never the store's to make: an
        annotation is deleted and looked up under it. Raises for an
        annotation with no creator, and for one on a resource the graph does
        not hold.
        """
        ...

    async def get_annotation(self, annotation_id: AnnotationId) -> Annotation | None: ...

    async def update_annotation(self, annotation_id: AnnotationId, updates: Mapping[str, JsonValue]) -> Annotation:
        """Replace the fields `updates` names, by the names the wire gives them, and answer what the update leaves.

        What it leaves is `semiont_graph.codec.updated_annotation`'s to say,
        and the store writes that whole: the row, its tag edges and its link.
        Raises for an annotation the graph does not hold, and for an update
        that names another resource.
        """
        ...

    async def delete_annotation(self, annotation_id: AnnotationId) -> None: ...

    async def resolve_reference(self, annotation_id: AnnotationId, source: ResourceId) -> Annotation:
        """Link a reference to `source`: its link replaced, and its entity tags kept. Raises for an annotation the graph does not hold."""
        ...

    # ── What is linked to what ─────────────────────────────────────────

    async def find_path(self, from_resource_id: ResourceId, to_resource_id: ResourceId, max_depth: int) -> list[GraphPath]:
        """The shortest way from one resource to another along links, or nothing.

        A link is followed forwards only. `max_depth` counts the resources on
        the path, both ends included.
        """
        ...

    # ── What the graph holds, counted ──────────────────────────────────

    async def get_stats(self) -> GraphStats: ...

    # ── Everything ─────────────────────────────────────────────────────

    async def clear_database(self) -> None:
        """Remove everything the graph holds."""
        ...
