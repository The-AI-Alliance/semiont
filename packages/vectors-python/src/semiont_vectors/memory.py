"""The in-memory store: an index held in the process, for tests.

It is the store both tables' cases run against with no server, and the one
every test of a service can use. It cannot be shared between processes, so
no deployment is configured with it.

A point is kept under its key, as its vector and its payload, and the
payload is the one `semiont_vectors.payload` builds. A stamp, a search
result and what a filter reads all come from that payload, as they do from a
Qdrant's. A store that kept what it was handed and answered from that would
answer what no index holds.

A search compares its vector with every point: nothing is approximate, and a
search by a resource's own vectors misses no resource. No collection is
made, so the store is told no width: it holds vectors as wide as it is
handed, and refuses to compare two that are not as wide as each other.
"""

import math
from collections.abc import Iterable, Sequence
from dataclasses import dataclass, replace
from typing import Final, final, override

from pydantic import JsonValue
from semiont.identifiers import AnnotationId, ResourceId

from semiont_vectors.merge import merge_by_resource
from semiont_vectors.payload import (
    Payload,
    annotation_key,
    annotation_of,
    annotation_payload,
    chunk_key,
    chunk_payload,
    resource_of,
    result_of,
    stamp_of,
)
from semiont_vectors.store import (
    AnnotationPayload,
    EmbeddingChunk,
    ResourceStamp,
    SearchFilter,
    SearchOptions,
    VectorSearchResult,
    VectorStore,
)

__all__ = ["MemoryVectorStore"]


@final
@dataclass(frozen=True, slots=True)
class _Point:
    """One point of the index: its vector, and what it says of itself. The store keeps it under its key."""

    vector: tuple[float, ...]
    payload: Payload


def _cosine(one: Sequence[float], other: Sequence[float]) -> float:
    """The cosine of the angle between two vectors, however long either is. 0 where one is all zeros, and so points no way.

    Raises `ValueError` for two vectors that are not as wide as each other.
    """
    if len(one) != len(other):
        raise ValueError(f"a vector of {len(one)} numbers cannot be compared with one of {len(other)}")
    lengths = math.hypot(*one) * math.hypot(*other)
    return 0.0 if lengths == 0 else math.sumprod(one, other) / lengths


def _passes(payload: Payload, wanted: SearchFilter | None) -> bool:
    """Whether a search may answer a point: every member the filter states holds of the point's payload."""
    if wanted is None:
        return True
    resource = resource_of(payload)
    # `stamp_of` is how the entity types a payload states are read: none, for a payload that states none.
    entity_types = stamp_of(payload).entity_types
    return (
        (wanted.resource_id is None or resource == wanted.resource_id)
        and (wanted.exclude_resource_id is None or resource != wanted.exclude_resource_id)
        and (wanted.motivation is None or payload.get("motivation") == wanted.motivation)
        and (not wanted.entity_types or any(entity_type in entity_types for entity_type in wanted.entity_types))
        and not any(entity_type in entity_types for entity_type in wanted.exclude_entity_types)
    )


def _nearest(points: Iterable[_Point], embedding: Sequence[float], options: SearchOptions) -> list[VectorSearchResult]:
    """The points nearest `embedding` that the filter and the threshold leave, best first, up to the limit.

    Points that score the same are answered in the order they were written.
    A point that scores exactly the threshold is answered.
    """
    scored = [(_cosine(embedding, point.vector), point) for point in points if _passes(point.payload, options.filter)]
    threshold = options.score_threshold
    kept = [found for found in scored if threshold is None or found[0] >= threshold]
    kept.sort(key=lambda found: found[0], reverse=True)
    return [result_of(point.payload, score) for score, point in kept[: options.limit]]


def _take(points: dict[str, _Point], resource_id: ResourceId) -> None:
    """Take from `points` every point whose payload names one resource."""
    for key in [key for key, point in points.items() if resource_of(point.payload) == resource_id]:
        del points[key]


@final
class MemoryVectorStore(VectorStore):
    """An index in two dictionaries, one of resources' chunks and one of annotations. See the module's documentation."""

    def __init__(self) -> None:
        self._resources: Final[dict[str, _Point]] = {}
        self._annotations: Final[dict[str, _Point]] = {}

    @override
    async def connect(self) -> None:
        """There is nothing to reach: the index is the store's own, from when the store is made."""

    @override
    async def disconnect(self) -> None:
        """Nothing was taken, so nothing is let go of: what the store holds, it holds still."""

    # ── Writes ─────────────────────────────────────────────────────────

    @override
    async def upsert_resource_vectors(
        self,
        resource_id: ResourceId,
        chunks: Sequence[EmbeddingChunk],
        content_checksum: str,
        entity_types: Sequence[str],
        *,
        machine_read: bool,
    ) -> None:
        _take(self._resources, resource_id)
        for chunk in chunks:
            self._resources[chunk_key(resource_id, chunk.chunk_index)] = _Point(
                vector=tuple(chunk.embedding),
                payload=chunk_payload(resource_id, chunk, content_checksum, entity_types, machine_read=machine_read),
            )

    @override
    async def update_resource_entity_types(self, resource_id: ResourceId, entity_types: Sequence[str]) -> None:
        for point in self._resources.values():
            if resource_of(point.payload) == resource_id:
                # A list of its own for each point, as each was given one when it was written.
                types: list[JsonValue] = [*entity_types]
                point.payload["entityTypes"] = types

    @override
    async def upsert_annotation_vector(self, embedding: Sequence[float], payload: AnnotationPayload) -> None:
        key = annotation_key(payload.annotation_id)
        # Taken first: a point written again is the last one written, as a resource's are when it is put again.
        self._annotations.pop(key, None)
        self._annotations[key] = _Point(vector=tuple(embedding), payload=annotation_payload(payload))

    @override
    async def delete_resource_vectors(self, resource_id: ResourceId) -> None:
        _take(self._resources, resource_id)

    @override
    async def delete_annotation_vector(self, annotation_id: AnnotationId) -> None:
        self._annotations.pop(annotation_key(annotation_id), None)

    @override
    async def delete_annotation_vectors_for_resource(self, resource_id: ResourceId) -> None:
        _take(self._annotations, resource_id)

    # ── Searches ───────────────────────────────────────────────────────

    @override
    async def search_resources(self, embedding: Sequence[float], options: SearchOptions) -> list[VectorSearchResult]:
        return _nearest(self._resources.values(), embedding, options)

    @override
    async def search_annotations(self, embedding: Sequence[float], options: SearchOptions) -> list[VectorSearchResult]:
        return _nearest(self._annotations.values(), embedding, options)

    @override
    async def search_by_resource(self, resource_id: ResourceId, options: SearchOptions) -> list[VectorSearchResult]:
        own = [point.vector for point in self._resources.values() if resource_of(point.payload) == resource_id]
        if not own:
            return []
        # The caller's filter, leaving this resource out. A filter names one resource to leave out, so one the
        # caller named there is left out no longer.
        others = replace(SearchFilter() if options.filter is None else options.filter, exclude_resource_id=resource_id)
        hits: list[VectorSearchResult] = []
        for point in self._resources.values():
            if not _passes(point.payload, others):
                continue
            # Every other point is scored against every chunk of this resource, and scores as its best match.
            best = max(_cosine(vector, point.vector) for vector in own)
            if options.score_threshold is None or best >= options.score_threshold:
                hits.append(result_of(point.payload, best))
        return merge_by_resource(hits)[: options.limit]

    # ── What is indexed ────────────────────────────────────────────────

    @override
    async def count(self) -> int:
        return len(self._resources) + len(self._annotations)

    @override
    async def list_resource_stamps(self) -> dict[ResourceId, ResourceStamp]:
        stamps: dict[ResourceId, ResourceStamp] = {}
        for point in self._resources.values():
            resource = resource_of(point.payload)
            if resource is not None and resource not in stamps:
                stamps[resource] = stamp_of(point.payload)
        return stamps

    @override
    async def get_resource_stamp(self, resource_id: ResourceId) -> ResourceStamp | None:
        for point in self._resources.values():
            if resource_of(point.payload) == resource_id:
                return stamp_of(point.payload)
        return None

    @override
    async def list_annotation_ids(self) -> set[AnnotationId]:
        named = (annotation_of(point.payload) for point in self._annotations.values())
        return {annotation_id for annotation_id in named if annotation_id is not None}
