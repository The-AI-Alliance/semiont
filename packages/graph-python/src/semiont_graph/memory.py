"""The in-memory store: a graph held in the process, for tests.

It is the reference the contract tests run against, and the second store
every test of a service can use. It cannot be shared between processes, so
no deployment is configured with it.

Nothing here needs serializing, and everything goes through the codec all
the same. A dictionary that kept a resource or an annotation as it was given
would answer with what no database holds, and hide from every test that runs
here what the real stores do.
"""

from collections import deque
from collections.abc import Mapping
from typing import Final, final, override

from pydantic import JsonValue
from semiont.annotations import body_source, entity_types, target_source
from semiont.identifiers import AnnotationId, ResourceId
from semiont.model import written
from semiont.types import Annotation, Motivation, ResourceDescriptor

from semiont_graph._query import query_resources
from semiont_graph.codec import (
    LINKING,
    decode_resource,
    encode_resource,
    intended_graph_annotation,
    primary_representation,
    resolved_body,
    updated_annotation,
)
from semiont_graph.interface import (
    EntityTypeCount,
    GraphConnection,
    GraphDatabase,
    GraphPath,
    GraphStats,
    ResourceChange,
    ResourceListing,
    ResourceQuery,
)

__all__ = ["MemoryGraphDatabase"]


def _newest_first(annotations: list[Annotation]) -> list[Annotation]:
    """Annotations in the one order a store answers them: newest first, and by id where two were made at one moment."""
    by_id = sorted(annotations, key=lambda annotation: annotation.id)
    return sorted(by_id, key=lambda annotation: annotation.created, reverse=True)


@final
class MemoryGraphDatabase(GraphDatabase):
    """A graph in two dictionaries. See the module's documentation."""

    def __init__(self) -> None:
        self._connected = False
        self._resources: Final[dict[str, ResourceDescriptor]] = {}
        self._annotations: Final[dict[str, Annotation]] = {}

    @override
    async def connect(self) -> None:
        self._connected = True

    @override
    async def disconnect(self) -> None:
        self._connected = False

    @override
    def is_connected(self) -> bool:
        return self._connected

    # ── Resources ──────────────────────────────────────────────────────

    @override
    async def create_resource(self, resource: ResourceDescriptor) -> ResourceDescriptor:
        stored = decode_resource(encode_resource(resource))
        self._resources[stored.id] = stored
        return stored

    @override
    async def get_resource(self, resource_id: ResourceId) -> ResourceDescriptor | None:
        return self._resources.get(resource_id)

    @override
    async def update_resource(self, resource_id: ResourceId, change: ResourceChange) -> ResourceDescriptor:
        current = self._resources.get(resource_id)
        if current is None:
            raise LookupError("Resource not found")
        properties = encode_resource(current)
        if change.archived is not None:
            properties["archived"] = change.archived
        if change.entity_types is not None:
            properties["entityTypes"] = list(change.entity_types)
        updated = decode_resource(properties)
        self._resources[resource_id] = updated
        return updated

    @override
    async def delete_resource(self, resource_id: ResourceId) -> None:
        self._resources.pop(resource_id, None)
        # The annotations on this resource go with it. Another resource's annotation that links here is that
        # resource's, and stays.
        for annotation_id in [held for held, annotation in self._annotations.items() if target_source(annotation.target) == resource_id]:
            del self._annotations[annotation_id]

    @override
    async def list_resources(self, query: ResourceQuery) -> ResourceListing:
        return query_resources(self._resources.values(), query)

    # ── Annotations ────────────────────────────────────────────────────

    @override
    async def create_annotation(self, annotation: Annotation) -> Annotation:
        stored = intended_graph_annotation(annotation)
        on = target_source(stored.target)
        if on not in self._resources:
            raise LookupError(f"Failed to create annotation: Resource {on} not found in graph database")
        self._annotations[stored.id] = stored
        return stored

    @override
    async def get_annotation(self, annotation_id: AnnotationId) -> Annotation | None:
        return self._annotations.get(annotation_id)

    @override
    async def update_annotation(self, annotation_id: AnnotationId, updates: Mapping[str, JsonValue]) -> Annotation:
        current = self._annotations.get(annotation_id)
        if current is None:
            raise LookupError("Annotation not found")
        updated = updated_annotation(current, updates)
        self._annotations[annotation_id] = updated
        return updated

    @override
    async def delete_annotation(self, annotation_id: AnnotationId) -> None:
        self._annotations.pop(annotation_id, None)

    @override
    async def resolve_reference(self, annotation_id: AnnotationId, source: ResourceId) -> Annotation:
        current = self._annotations.get(annotation_id)
        if current is None:
            raise LookupError("Annotation not found")
        body: list[JsonValue] = [written(item) for item in resolved_body(current, source)]
        return await self.update_annotation(annotation_id, {"body": body})

    # ── What is linked to what ─────────────────────────────────────────

    @override
    async def get_resource_annotations(self, resource_id: ResourceId) -> list[Annotation]:
        return _newest_first([annotation for annotation in self._annotations.values() if target_source(annotation.target) == resource_id])

    @override
    async def get_resource_referenced_by(self, resource_id: ResourceId, motivation: Motivation | None) -> list[Annotation]:
        return _newest_first(
            [
                annotation
                for annotation in self._annotations.values()
                if body_source(annotation.body) == resource_id and (motivation is None or annotation.motivation == motivation)
            ]
        )

    def _links_from(self, resource_id: str) -> dict[str, list[Annotation]]:
        """The references on a resource that link to a resource the graph holds, by the resource each links to."""
        links: dict[str, list[Annotation]] = {}
        for annotation in self._annotations.values():
            if annotation.motivation != LINKING or target_source(annotation.target) != resource_id:
                continue
            linked = body_source(annotation.body)
            if linked is not None and linked in self._resources:
                links.setdefault(linked, []).append(annotation)
        return links

    @override
    async def get_resource_connections(self, resource_id: ResourceId) -> list[GraphConnection]:
        return [
            GraphConnection(
                target_resource=self._resources[linked],
                annotations=_newest_first(annotations),
                bidirectional=resource_id in self._links_from(linked),
            )
            for linked, annotations in self._links_from(resource_id).items()
        ]

    @override
    async def find_path(self, from_resource_id: ResourceId, to_resource_id: ResourceId, max_depth: int) -> list[GraphPath]:
        start = self._resources.get(from_resource_id)
        if start is None or max_depth < 1:
            return []
        # Breadth first, so the first way found is a shortest one.
        seen = {str(from_resource_id)}
        ways: deque[tuple[str, list[ResourceDescriptor], list[Annotation]]] = deque([(from_resource_id, [start], [])])
        while ways:
            at, resources, annotations = ways.popleft()
            if at == to_resource_id:
                return [GraphPath(resources=resources, annotations=annotations)]
            if len(resources) >= max_depth:
                continue
            for linked, links in self._links_from(at).items():
                if linked not in seen:
                    seen.add(linked)
                    ways.append((linked, [*resources, self._resources[linked]], [*annotations, _newest_first(links)[0]]))
        return []

    # ── What the graph holds, counted ──────────────────────────────────

    def _resources_by_entity_type(self) -> dict[str, int]:
        counts: dict[str, int] = {}
        for resource in self._resources.values():
            for entity_type in resource.entity_types or ():
                counts[entity_type] = counts.get(entity_type, 0) + 1
        return counts

    @override
    async def get_entity_type_stats(self) -> list[EntityTypeCount]:
        counts = sorted(self._resources_by_entity_type().items(), key=lambda counted: (-counted[1], counted[0]))
        return [EntityTypeCount(type=entity_type, count=count) for entity_type, count in counts]

    @override
    async def get_stats(self) -> GraphStats:
        content_types: dict[str, int] = {}
        for resource in self._resources.values():
            representation = primary_representation(resource)
            if representation is not None:
                content_types[representation.media_type] = content_types.get(representation.media_type, 0) + 1
        annotations = list(self._annotations.values())
        references = [annotation for annotation in annotations if annotation.motivation == LINKING]
        return GraphStats(
            resource_count=len(self._resources),
            annotation_count=len(annotations),
            highlight_count=len([annotation for annotation in annotations if annotation.motivation == "highlighting"]),
            reference_count=len(references),
            entity_reference_count=len([annotation for annotation in references if entity_types(annotation)]),
            entity_types=self._resources_by_entity_type(),
            content_types=content_types,
        )

    # ── Everything ─────────────────────────────────────────────────────

    @override
    async def clear_database(self) -> None:
        self._resources.clear()
        self._annotations.clear()
