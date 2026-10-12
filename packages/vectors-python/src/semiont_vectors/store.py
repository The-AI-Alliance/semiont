"""What a vector index is asked and answers: the reader and the store every database's module is.

The index is a projection of a knowledge base's record, kept for the searches
only vectors answer. One service writes it, and others search it: the one
that writes is handed a `VectorStore`, and one that searches a
`VectorReader`, which has the searches and nothing that writes. It holds
points of two kinds: one for each chunk of a resource's text, and one for
each annotation that quotes text. What a point is, and how a stamp and a
search result are read from one, is `semiont_vectors.payload`'s to say, and
is the same in every store.

A store is handed vectors and makes none: the text was embedded before it
came here. It works out no checksum and reads no clock.

No type of a database's client appears here.
"""

from collections.abc import Sequence
from dataclasses import dataclass
from typing import Protocol, final

from semiont.identifiers import AnnotationId, ResourceId

__all__ = [
    "AnnotationPayload",
    "EmbeddingChunk",
    "ResourceStamp",
    "SearchFilter",
    "SearchOptions",
    "VectorReader",
    "VectorSearchResult",
    "VectorStore",
]


@final
@dataclass(frozen=True, slots=True, kw_only=True)
class EmbeddingChunk:
    """One chunk of a resource's text, and the vector made of it."""

    chunk_index: int
    """Which chunk of the resource it is, counted from 0."""
    text: str
    embedding: Sequence[float]


@final
@dataclass(frozen=True, slots=True, kw_only=True)
class AnnotationPayload:
    """What an annotation's point says of it. The point is kept under `annotation_id`."""

    annotation_id: AnnotationId
    resource_id: ResourceId
    """The resource the annotation is on."""
    motivation: str
    entity_types: Sequence[str]
    exact_text: str
    """The text the annotation quotes: what its vector was made of."""
    machine_read: bool = False
    """Whether the quoted text was read from pixels. See `VectorSearchResult.machine_read`."""


@final
@dataclass(frozen=True, slots=True, kw_only=True)
class ResourceStamp:
    """What a resource's points say of it as a whole."""

    content_checksum: str | None
    """The checksum of the bytes the points' text came from. `None` for points that state none."""
    entity_types: tuple[str, ...]
    """The entity types the points were given, in the order given. Empty for points that state none."""
    machine_read: bool = False
    """Whether the text was read from pixels."""


@final
@dataclass(frozen=True, slots=True, kw_only=True)
class VectorSearchResult:
    """One point a search found, and how well it matched."""

    score: float
    """The cosine of the angle between the vector searched by and the point's."""
    resource_id: ResourceId
    """The resource the point is a chunk of, or the resource its annotation is on."""
    text: str
    """The chunk's text, or the text the annotation quotes."""
    annotation_id: AnnotationId | None = None
    """The annotation, for a point of the annotations. `None` for a resource's chunk."""
    entity_types: tuple[str, ...] | None = None
    """The entity types the point states. `None` for a point that states none."""
    machine_read: bool = False
    """Whether the text was read from pixels and not from the document itself.

    A chunk reaches whoever reads it with no document beside it, and nothing
    downstream can work this out again.
    """


@final
@dataclass(frozen=True, slots=True, kw_only=True)
class SearchFilter:
    """Which points a search may answer. A point is answered only if every member stated holds of it.

    A member left out filters nothing, and neither does an empty list.
    """

    entity_types: Sequence[str] = ()
    """Keeps a point that has any one of these."""
    exclude_entity_types: Sequence[str] = ()
    """Drops a point that has any one of these."""
    resource_id: ResourceId | None = None
    """Keeps the points of this resource alone."""
    exclude_resource_id: ResourceId | None = None
    """Drops the points of this resource."""
    motivation: str | None = None
    """Keeps the annotations of this motivation alone. A resource's chunk has no motivation, and is dropped."""


@final
@dataclass(frozen=True, slots=True, kw_only=True)
class SearchOptions:
    """How much a search answers, and of what."""

    limit: int
    """The most results answered, counted after the filter and the threshold."""
    score_threshold: float | None = None
    """A point that scores below this is not answered."""
    filter: SearchFilter | None = None


class VectorReader(Protocol):
    """A vector index, as a service that only searches it asks it. Every reader has these members and no others.

    A reader writes nothing to its index, and makes nothing in it.
    """

    async def connect(self) -> None:
        """Reach the index. Raises where it cannot be reached.

        A reader makes nothing there. A store makes ready what it needs of
        the index, which is its own module's to say.
        """
        ...

    async def disconnect(self) -> None:
        """Let go of whatever `connect` took. One that was never connected has nothing to let go of."""
        ...

    async def search_resources(self, embedding: Sequence[float], options: SearchOptions) -> list[VectorSearchResult]:
        """The chunks nearest `embedding`, best first: one result for each chunk, so a resource may be answered more than once."""
        ...

    async def search_annotations(self, embedding: Sequence[float], options: SearchOptions) -> list[VectorSearchResult]:
        """The annotations whose quoted text is nearest `embedding`, best first."""
        ...

    async def search_by_resource(self, resource_id: ResourceId, options: SearchOptions) -> list[VectorSearchResult]:
        """The resources most like this one, best first, by the vectors its own chunks have: nothing is embedded.

        One result for each resource, with the score and the text of the
        chunk of it that scored best against any chunk of this one
        (`semiont_vectors.merge`). This resource itself is never answered.
        Nothing is answered for a resource with no points.
        """
        ...


class VectorStore(VectorReader, Protocol):
    """A vector index, as the service that writes it asks it: a reader's members, the writes, and what is indexed.

    Every store has these members and no others.
    """

    # ── Writes ─────────────────────────────────────────────────────────

    async def upsert_resource_vectors(
        self,
        resource_id: ResourceId,
        chunks: Sequence[EmbeddingChunk],
        content_checksum: str,
        entity_types: Sequence[str],
        *,
        machine_read: bool,
    ) -> None:
        """Make a resource's points these chunks: every point it had before is gone, and with no chunks it has none.

        `content_checksum` is the checksum of the bytes the chunks' text came
        from, and `entity_types` the resource's: both are kept on every
        point, so that what is indexed can be compared with what the record
        says should be. `machine_read` says the text was read from pixels.
        """
        ...

    async def update_resource_entity_types(self, resource_id: ResourceId, entity_types: Sequence[str]) -> None:
        """Set the entity types on every point of a resource's chunks, and change nothing else.

        No vector is touched and nothing is embedded. A resource with no
        points is left with none.
        """
        ...

    async def upsert_annotation_vector(self, embedding: Sequence[float], payload: AnnotationPayload) -> None:
        """Make an annotation's one point this: the vector of the text it quotes, and what the point says of it."""
        ...

    async def delete_resource_vectors(self, resource_id: ResourceId) -> None:
        """Take every point of a resource's chunks. The points of annotations on it stay."""
        ...

    async def delete_annotation_vector(self, annotation_id: AnnotationId) -> None: ...

    async def delete_annotation_vectors_for_resource(self, resource_id: ResourceId) -> None:
        """Take the point of every annotation on a resource. The resource's own points stay."""
        ...

    # ── What is indexed ────────────────────────────────────────────────

    async def count(self) -> int:
        """How many points there are, of resources and of annotations together."""
        ...

    async def list_resource_stamps(self) -> dict[ResourceId, ResourceStamp]:
        """The stamp of every resource that has points. A point that names no resource is left out."""
        ...

    async def get_resource_stamp(self, resource_id: ResourceId) -> ResourceStamp | None:
        """One resource's stamp, read without listing the index. `None` for a resource with no points."""
        ...

    async def list_annotation_ids(self) -> set[AnnotationId]:
        """The id of every annotation that has a point."""
        ...
