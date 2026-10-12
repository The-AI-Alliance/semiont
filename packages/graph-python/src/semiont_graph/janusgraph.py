"""The janusgraph store has never run against a server: it is the TypeScript store of that name, carried over file for file.

It is kept to remind us of another kind of graph database. It asks
JanusGraph's Gremlin server through Apache TinkerPop's client
(`gremlinpython`, the extra `janusgraph`). What it leans on in that client
is `semiont_graph._gremlin`'s to say. The client is synchronous and runs an
event loop of its own, so the store never asks it on its loop: each call is
run on a thread (`asyncio.to_thread`), on the client's one connection, one
at a time and in the order asked. That is at one place, `_in_turn`.

A traversal is Gremlin script text. A value is never part of the text: it is
bound, under a name the script has.

What it stores:

- a resource is a vertex `Resource` whose properties are the codec's
  (`semiont_graph.codec.ResourceProperties`), its entity types as a JSON
  string, which is how this store keeps a list;
- an annotation is a vertex `Annotation` whose properties are exactly the
  codec's; an edge `BELONGS_TO` to the resource it is on; an edge
  `REFERENCES` to the resource it links to; and an edge `TAGGED_AS` to an
  `EntityType` vertex, by its `name`, for each entity tag.

The store reads no clock.

It does what its source does, and that is not everywhere what
`semiont_graph.interface` says of a store:

- a resource stored again is a second vertex, and so is an annotation;
- deleting a resource leaves the annotations on it;
- the resource an annotation is on, and the one it links to, are not looked
  for before the annotation is written: its vertex is added, and the server
  is then asked for an edge to a vertex it may not hold;
- no entity tag is read back: `has('EntityType')` asks for a property of that
  name, and no vertex has one. An update writes what is left of the
  annotation as it was read, so an update takes an annotation's tags away
  unless it states them;
- annotations are answered in the order the server gives them, and those
  that link to a resource whatever motivation is asked for; a connection
  holds every annotation that is not a highlight and is never bidirectional;
  no path is found; and entity types are counted in no order.
"""

import asyncio
import json
from collections.abc import Callable, Iterable, Mapping, Sequence
from typing import Final, final, override

from pydantic import JsonValue, TypeAdapter
from semiont.annotations import body_source, entity_types
from semiont.identifiers import AnnotationId, ResourceId
from semiont.model import written
from semiont.resources import primary_representation
from semiont.types import Annotation, Motivation, ResourceDescriptor

from semiont_graph._gremlin import GremlinClient, answered, gremlin_client
from semiont_graph._query import query_resources
from semiont_graph.codec import (
    LINKING,
    decode_annotation,
    decode_resource,
    encode_annotation,
    encode_resource,
    intended_graph_annotation,
    resolved_body,
    stored_annotation_type,
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

__all__ = ["JanusGraphDatabase"]

_open_client: Final = gremlin_client("janusgraph")

type _Vertex = dict[str, list[JsonValue]]
"""A vertex's properties as `valueMap()` answers them: each a list of its values."""

_VERTICES: Final = TypeAdapter[list[_Vertex]](list[_Vertex])
_NAMES: Final = TypeAdapter[list[str]](list[str])

# A resource and an annotation, each by its id, however a traversal goes on from it.
_RESOURCE: Final = "g.V().has('Resource', 'id', rid)"
_ANNOTATION: Final = "g.V().has('Annotation', 'id', aid)"


def _setting(row: Mapping[str, object]) -> tuple[str, dict[str, object]]:
    """The steps that set each property of a row, and what they bind. A list is kept as a JSON string.

    A property's name is the codec's, and is part of the script. Its value is
    bound under that name with `p_` before it: a value bound as `id` would be
    read as Gremlin's own token of that name.
    """
    steps = "".join(f".property('{name}', p_{name})" for name in row)
    bound: dict[str, object] = {
        f"p_{name}": json.dumps(value, ensure_ascii=False, separators=(",", ":")) if isinstance(value, list) else value
        for name, value in row.items()
    }
    return steps, bound


def _first(vertex: _Vertex) -> dict[str, JsonValue]:
    """A vertex's properties, each as its one value. A property that holds nothing is left out."""
    return {name: values[0] for name, values in vertex.items() if values and values[0] is not None}


def _resource(vertex: _Vertex) -> ResourceDescriptor:
    """The resource a vertex is.

    The store keeps a list as a JSON string, and a server hands a boolean
    back as itself or as text. What the properties mean, and which a
    resource must have, is the codec's.
    """
    properties: dict[str, object] = {**_first(vertex)}
    held = properties.get("entityTypes")
    if isinstance(held, str):
        properties["entityTypes"] = json.loads(held)
    if "archived" in properties:
        archived = properties["archived"]
        properties["archived"] = archived is True or archived == "true"
    return decode_resource(properties)


def _annotation(vertex: _Vertex, tags: Iterable[str]) -> Annotation:
    """The annotation a vertex and the names of its tag edges are. The codec reads text: a property that is not text is put into it here."""
    properties = {name: value if isinstance(value, str) else str(value) for name, value in _first(vertex).items()}
    return decode_annotation(properties, tags)


def _by_entity_type(resources: Iterable[ResourceDescriptor]) -> dict[str, int]:
    """How many of those resources have each entity type, in the order each type is first met."""
    counts: dict[str, int] = {}
    for resource in resources:
        for entity_type in resource.entity_types or ():
            counts[entity_type] = counts.get(entity_type, 0) + 1
    return counts


@final
class JanusGraphDatabase(GraphDatabase):
    """A graph in a JanusGraph database. See the module's documentation.

    `host` and `port` are where JanusGraph's Gremlin server is reached, over
    a WebSocket. Both are stated.
    """

    def __init__(self, *, host: str, port: int) -> None:
        self._host: Final = host
        self._port: Final = port
        self._client: GremlinClient | None = None
        self._turn: Final = asyncio.Lock()

    async def _in_turn[**P, T](self, call: Callable[P, T], *arguments: P.args, **named: P.kwargs) -> T:
        """Run one call of the client off the loop: on a thread, after every call asked before it."""
        async with self._turn:
            return await asyncio.to_thread(call, *arguments, **named)

    @override
    async def connect(self) -> None:
        client = _open_client(f"ws://{self._host}:{self._port}/gremlin")
        try:
            # The client connects when it is first asked, so this is what reaches the server.
            await self._in_turn(answered, client, "g.V().limit(1)", {})
        except BaseException:
            await self._in_turn(client.close)
            raise
        self._client = client

    @override
    async def disconnect(self) -> None:
        client, self._client = self._client, None
        if client is not None:
            await self._in_turn(client.close)

    @override
    def is_connected(self) -> bool:
        return self._client is not None

    def _reached(self) -> GremlinClient:
        if self._client is None:
            raise RuntimeError("the janusgraph store is not connected: `connect` it")
        return self._client

    async def _ask(self, script: str, **bindings: object) -> list[object]:
        """One traversal, and every result it answers."""
        return await self._in_turn(answered, self._reached(), script, bindings)

    async def _vertices(self, script: str, **bindings: object) -> list[_Vertex]:
        """A traversal that ends in `valueMap()`: the properties of each vertex it reaches."""
        return _VERTICES.validate_python(await self._ask(script, **bindings))

    # ── Resources ──────────────────────────────────────────────────────

    @override
    async def create_resource(self, resource: ResourceDescriptor) -> ResourceDescriptor:
        properties = encode_resource(resource)
        steps, bound = _setting(properties)
        await self._ask("g.addV('Resource')" + steps, **bound)
        return decode_resource(properties)

    @override
    async def get_resource(self, resource_id: ResourceId) -> ResourceDescriptor | None:
        vertices = await self._vertices(_RESOURCE + ".valueMap()", rid=resource_id)
        return _resource(vertices[0]) if vertices else None

    @override
    async def update_resource(self, resource_id: ResourceId, change: ResourceChange) -> ResourceDescriptor:
        changed: dict[str, object] = {}
        if change.archived is not None:
            changed["archived"] = change.archived
        if change.entity_types is not None:
            changed["entityTypes"] = list(change.entity_types)
        steps, bound = _setting(changed)
        await self._ask(_RESOURCE + steps, rid=resource_id, **bound)
        updated = await self.get_resource(resource_id)
        if updated is None:
            raise LookupError("Resource not found")
        return updated

    @override
    async def delete_resource(self, resource_id: ResourceId) -> None:
        await self._ask(_RESOURCE + ".drop()", rid=resource_id)

    async def _resources(self) -> list[ResourceDescriptor]:
        """Every resource the graph holds."""
        return [_resource(vertex) for vertex in await self._vertices("g.V().hasLabel('Resource').valueMap()")]

    @override
    async def list_resources(self, query: ResourceQuery) -> ResourceListing:
        # Filtered, ranked and paged here and not by the server, with what the in-memory store answers a listing from.
        return query_resources(await self._resources(), query)

    # ── Annotations ────────────────────────────────────────────────────

    async def _link(self, annotation_id: str, linked: str) -> None:
        """An edge from an annotation to the resource it links to."""
        await self._ask(_ANNOTATION + ".addE('REFERENCES').to(__.V().has('Resource', 'id', rid))", aid=annotation_id, rid=linked)

    async def _tag(self, annotation_id: str, tag: str) -> None:
        """An edge from an annotation to the entity type of that name, whose vertex is made where the graph has none."""
        if not await self._ask("g.V().has('EntityType', 'name', named)", named=tag):
            await self._ask("g.addV('EntityType').property('name', named)", named=tag)
        await self._ask(_ANNOTATION + ".addE('TAGGED_AS').to(__.V().has('EntityType', 'name', named))", aid=annotation_id, named=tag)

    @override
    async def create_annotation(self, annotation: Annotation) -> Annotation:
        stored = intended_graph_annotation(annotation)
        properties = encode_annotation(stored)
        steps, bound = _setting(properties)
        await self._ask("g.addV('Annotation')" + steps, **bound)
        await self._ask(
            _ANNOTATION + ".addE('BELONGS_TO').to(__.V().has('Resource', 'id', rid))", aid=stored.id, rid=properties["resourceId"]
        )
        linked = body_source(stored.body)
        if linked is not None:
            await self._link(stored.id, linked)
        for tag in entity_types(stored):
            await self._tag(stored.id, tag)
        return stored

    async def _tags(self, annotation_id: object) -> list[str]:
        """The names an annotation's tag edges lead to."""
        names = _NAMES.validate_python(
            await self._ask(_ANNOTATION + ".out('TAGGED_AS').has('EntityType').values('name')", aid=annotation_id)
        )
        return [name for name in names if name]

    async def _with_tags(self, vertices: Sequence[_Vertex]) -> list[Annotation]:
        """The annotation each of those vertices is, with its tags: one traversal more for each."""
        return [_annotation(vertex, await self._tags(_first(vertex).get("id"))) for vertex in vertices]

    @override
    async def get_annotation(self, annotation_id: AnnotationId) -> Annotation | None:
        vertices = await self._vertices(_ANNOTATION + ".valueMap()", aid=annotation_id)
        return _annotation(vertices[0], await self._tags(annotation_id)) if vertices else None

    @override
    async def update_annotation(self, annotation_id: AnnotationId, updates: Mapping[str, JsonValue]) -> Annotation:
        current = await self.get_annotation(annotation_id)
        if current is None:
            raise LookupError("Annotation not found")
        updated = updated_annotation(current, updates)
        # The row becomes exactly the codec's properties. What it had goes first, so a property the update took away
        # goes with it.
        steps, bound = _setting(encode_annotation(updated))
        await self._ask(_ANNOTATION + ".sideEffect(__.properties().drop())" + steps, aid=annotation_id, **bound)
        # Its tag edges and its link become exactly what the annotation has.
        await self._ask(_ANNOTATION + ".outE('TAGGED_AS').drop()", aid=annotation_id)
        for tag in entity_types(updated):
            await self._tag(annotation_id, tag)
        await self._ask(_ANNOTATION + ".outE('REFERENCES').drop()", aid=annotation_id)
        linked = body_source(updated.body)
        if linked is not None:
            await self._link(annotation_id, linked)
        return updated

    @override
    async def delete_annotation(self, annotation_id: AnnotationId) -> None:
        await self._ask(_ANNOTATION + ".drop()", aid=annotation_id)

    @override
    async def resolve_reference(self, annotation_id: AnnotationId, source: ResourceId) -> Annotation:
        current = await self.get_annotation(annotation_id)
        if current is None:
            raise LookupError("Annotation not found")
        body: list[JsonValue] = [written(item) for item in resolved_body(current, source)]
        return await self.update_annotation(annotation_id, {"body": body})

    # ── What is linked to what ─────────────────────────────────────────

    async def _list_annotations(self, resource_id: ResourceId, stored_type: str | None) -> list[Annotation]:
        """The annotations on a resource: all of them, or those stored with one `type`."""
        on = "g.V().hasLabel('Annotation').has('resourceId', rid)"
        if stored_type is None:
            return await self._with_tags(await self._vertices(on + ".valueMap()", rid=resource_id))
        return await self._with_tags(await self._vertices(on + ".has('type', stored).valueMap()", rid=resource_id, stored=stored_type))

    @override
    async def get_resource_annotations(self, resource_id: ResourceId) -> list[Annotation]:
        return await self._list_annotations(resource_id, None)

    @override
    async def get_resource_referenced_by(self, resource_id: ResourceId, motivation: Motivation | None) -> list[Annotation]:
        del motivation
        return await self._with_tags(await self._vertices("g.V().hasLabel('Annotation').has('source', rid).valueMap()", rid=resource_id))

    @override
    async def get_resource_connections(self, resource_id: ResourceId) -> list[GraphConnection]:
        targets: dict[str, ResourceDescriptor] = {}
        links: dict[str, list[Annotation]] = {}
        # Asked for by the `type` a reference is stored with, which is the one the codec derives from its motivation.
        for reference in await self._list_annotations(resource_id, stored_annotation_type(LINKING)):
            linked = body_source(reference.body)
            if linked is None:
                continue
            target = await self.get_resource(linked)
            if target is not None:
                targets[target.id] = target
                links.setdefault(target.id, []).append(reference)
        return [
            GraphConnection(target_resource=targets[linked], annotations=annotations, bidirectional=False)
            for linked, annotations in links.items()
        ]

    @override
    async def find_path(self, from_resource_id: ResourceId, to_resource_id: ResourceId, max_depth: int) -> list[GraphPath]:
        del from_resource_id, to_resource_id, max_depth
        return []

    # ── What the graph holds, counted ──────────────────────────────────

    @override
    async def get_entity_type_stats(self) -> list[EntityTypeCount]:
        return [EntityTypeCount(type=entity_type, count=count) for entity_type, count in _by_entity_type(await self._resources()).items()]

    @override
    async def get_stats(self) -> GraphStats:
        resources = await self._resources()
        content_types: dict[str, int] = {}
        for resource in resources:
            representation = primary_representation(resource)
            if representation is not None:
                content_types[representation.media_type] = content_types.get(representation.media_type, 0) + 1
        annotations = await self._with_tags(await self._vertices("g.V().hasLabel('Annotation').valueMap()"))
        references = [annotation for annotation in annotations if annotation.motivation == LINKING]
        return GraphStats(
            resource_count=len(resources),
            annotation_count=len(annotations),
            highlight_count=len([annotation for annotation in annotations if annotation.motivation == "highlighting"]),
            reference_count=len(references),
            entity_reference_count=len([annotation for annotation in references if entity_types(annotation)]),
            entity_types=_by_entity_type(resources),
            content_types=content_types,
        )

    # ── Everything ─────────────────────────────────────────────────────

    @override
    async def clear_database(self) -> None:
        await self._ask("g.V().drop()")
