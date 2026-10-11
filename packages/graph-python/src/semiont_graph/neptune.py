"""The neptune store has never run against a server, nor on AWS: it is the TypeScript store of that name, carried over file for file.

It is kept to remind us of another kind of graph database. It asks Amazon
Neptune's Gremlin endpoint through Apache TinkerPop's client
(`gremlinpython`, the extra `neptune`). What it leans on in that client is
`semiont_graph._gremlin`'s to say. The client is synchronous and runs an
event loop of its own, so the store never asks it on its loop: each call is
run on a thread (`asyncio.to_thread`), on the client's one connection, one
at a time and in the order asked. That is at one place, `_in_turn`.

A traversal is Gremlin script text. A value is never part of the text: it is
bound, under a name the script has. Amazon's documentation says Neptune
takes no bindings with a script, so as it stands this store would be refused
there: its source sent its traversals as bytecode, which Neptune takes.

What it stores:

- a resource is a vertex `Resource` whose properties are the codec's
  (`semiont_graph.codec.ResourceProperties`), its entity types as a JSON
  string, which is how this store keeps a list;
- an annotation is a vertex `Annotation` whose properties are exactly the
  codec's; an edge `BELONGS_TO` to the resource it is on; an edge
  `REFERENCES` to the resource it links to; and an edge `TAGGED_AS` to an
  `EntityType` vertex, by its `name`, for each entity tag;
- the vocabulary is a vertex `TagCollection` whose `type` is `entity-types`,
  with each tag a value of its `tags`.

The store reads no clock, and sends no credentials.

It does what its source does, and that is not everywhere what
`semiont_graph.interface` says of a store:

- a resource stored again is a second vertex, and so is an annotation;
- deleting a resource leaves the annotations on it;
- the resource an annotation is on, and the one it links to, are not looked
  for before the annotation is written: its vertex is added, and the server
  is then asked for an edge to a vertex it may not hold;
- a change to a resource sets a property without saying that it replaces
  the value held: by Amazon's documentation Neptune then holds both, and a
  read takes the first;
- the annotations that link to a resource are asked for by a property,
  `resolvedResourceId`, that nothing writes: none is found, and every
  annotation is counted a highlight and none a reference;
- annotations are answered in the order the server gives them, and a
  connection holds every annotation that has a link, whatever its
  motivation;
- a path is looked for along `REFERENCES` edges alone, in both directions,
  to a number of steps and not of resources: up to ten are answered, and no
  annotation with them;
- entity types are counted in no order;
- the vocabulary is read once and kept by the store from then on, and a tag
  added is looked for under a label, `tagCollection`, that no vertex has.
"""

import asyncio
import json
from collections.abc import Callable, Iterable, Mapping, Sequence
from typing import Final, TypedDict, final, override

from pydantic import BaseModel, JsonValue, TypeAdapter
from semiont.annotations import body_source, entity_types, target_source
from semiont.identifiers import AnnotationId, ResourceId
from semiont.model import written
from semiont.types import Annotation, Motivation, ResourceDescriptor

from semiont_graph._gremlin import GremlinClient, answered, gremlin_client
from semiont_graph._query import query_resources
from semiont_graph._vocabulary import DEFAULT_ENTITY_TYPES
from semiont_graph.codec import (
    decode_annotation,
    decode_resource,
    encode_annotation,
    encode_resource,
    intended_graph_annotation,
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

__all__ = ["NeptuneGraphDatabase"]

_open_client: Final = gremlin_client("neptune")

type _Vertex = dict[str, list[JsonValue]]
"""A vertex's properties as `valueMap()` answers them: each a list of its values."""


class _TagCollection(TypedDict):
    """A vocabulary vertex, as the traversal that reads the vocabulary projects one."""

    type: str
    tags: list[str]


class _Path(BaseModel, frozen=True, from_attributes=True):
    """A path as the client hands one back: an object whose `objects` are what the traversal met on its way, in order."""

    objects: list[_Vertex]


_VERTICES: Final = TypeAdapter[list[_Vertex]](list[_Vertex])
_NAMES: Final = TypeAdapter[list[str]](list[str])
_COUNTS: Final = TypeAdapter[list[int]](list[int])
_GROUPS: Final = TypeAdapter[list[dict[str, int]]](list[dict[str, int]])
_COLLECTIONS: Final = TypeAdapter[list[_TagCollection]](list[_TagCollection])
_PATHS: Final = TypeAdapter[list[_Path]](list[_Path])

# A resource and an annotation, each by its id, however a traversal goes on from it.
_RESOURCE: Final = "g.V().hasLabel('Resource').has('id', rid)"
_ANNOTATION: Final = "g.V().hasLabel('Annotation').has('id', aid)"

# The vocabulary's vertex, made where the traversal finds none.
_VOCABULARY: Final = (
    "g.V().has('tagCollection', 'type', 'entity-types').fold()"
    ".coalesce(__.unfold(), __.addV('TagCollection').property('type', 'entity-types'))"
)


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
    """A vertex's properties, each as the first of its values. A property that holds nothing is left out."""
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


@final
class NeptuneGraphDatabase(GraphDatabase):
    """A graph in an Amazon Neptune cluster. See the module's documentation.

    `endpoint` and `port` are where the cluster's Gremlin endpoint is
    reached, over a secure WebSocket. Both are stated.
    """

    def __init__(self, *, endpoint: str, port: int) -> None:
        self._endpoint: Final = endpoint
        self._port: Final = port
        self._client: GremlinClient | None = None
        self._turn: Final = asyncio.Lock()
        self._entity_types: set[str] | None = None

    async def _in_turn[**P, T](self, call: Callable[P, T], *arguments: P.args, **named: P.kwargs) -> T:
        """Run one call of the client off the loop: on a thread, after every call asked before it."""
        async with self._turn:
            return await asyncio.to_thread(call, *arguments, **named)

    @override
    async def connect(self) -> None:
        client = _open_client(f"wss://{self._endpoint}:{self._port}/gremlin")
        try:
            # The client connects when it is first asked, so this is what reaches the server.
            await self._in_turn(answered, client, "g.V().limit(1).count()", {})
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
            raise RuntimeError("the neptune store is not connected: `connect` it")
        return self._client

    async def _ask(self, script: str, **bindings: object) -> list[object]:
        """One traversal, and every result it answers."""
        return await self._in_turn(answered, self._reached(), script, bindings)

    async def _vertices(self, script: str, **bindings: object) -> list[_Vertex]:
        """A traversal that ends in `valueMap()`: the properties of each vertex it reaches."""
        return _VERTICES.validate_python(await self._ask(script, **bindings))

    async def _count(self, script: str) -> int:
        """A traversal that ends in `count()`: the one number it answers."""
        (counted,) = _COUNTS.validate_python(await self._ask(script))
        return counted

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
        vertices = await self._vertices(_RESOURCE + steps + ".valueMap()", rid=resource_id, **bound)
        if not vertices:
            raise LookupError("Resource not found")
        return _resource(vertices[0])

    @override
    async def delete_resource(self, resource_id: ResourceId) -> None:
        await self._ask(_RESOURCE + ".drop()", rid=resource_id)

    @override
    async def list_resources(self, query: ResourceQuery) -> ResourceListing:
        # Filtered, ranked and paged here and not by the server, with what the in-memory store answers a listing
        # from: the ranking has no natural expression in Gremlin, and one applied after a range would order a page
        # and not the matches. So every resource is read for each listing.
        vertices = await self._vertices("g.V().hasLabel('Resource').valueMap()")
        return query_resources([_resource(vertex) for vertex in vertices], query)

    # ── Annotations ────────────────────────────────────────────────────

    async def _link(self, annotation_id: str, linked: str) -> None:
        """An edge from an annotation to the resource it links to."""
        await self._ask(_ANNOTATION + ".addE('REFERENCES').to(__.V().hasLabel('Resource').has('id', rid))", aid=annotation_id, rid=linked)

    async def _tag(self, annotation_id: str, tag: str) -> None:
        """An edge from an annotation to the entity type of that name, whose vertex is made where the graph has none."""
        await self._ask(
            "g.V().hasLabel('EntityType').has('name', named).fold().coalesce(__.unfold(), __.addV('EntityType').property('name', named))",
            named=tag,
        )
        await self._ask(
            _ANNOTATION + ".addE('TAGGED_AS').to(__.V().hasLabel('EntityType').has('name', named))", aid=annotation_id, named=tag
        )

    @override
    async def create_annotation(self, annotation: Annotation) -> Annotation:
        stored = intended_graph_annotation(annotation)
        properties = encode_annotation(stored)
        steps, bound = _setting(properties)
        await self._ask("g.addV('Annotation')" + steps, **bound)
        await self._ask(
            _ANNOTATION + ".addE('BELONGS_TO').to(__.V().hasLabel('Resource').has('id', rid))",
            aid=stored.id,
            rid=properties["resourceId"],
        )
        linked = body_source(stored.body)
        if linked is not None:
            await self._link(stored.id, linked)
        for tag in entity_types(stored):
            await self._tag(stored.id, tag)
        return stored

    async def _tags(self, annotation_id: object) -> list[str]:
        """The names an annotation's tag edges lead to."""
        return _NAMES.validate_python(
            await self._ask(_ANNOTATION + ".out('TAGGED_AS').hasLabel('EntityType').values('name')", aid=annotation_id)
        )

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

    @override
    async def get_resource_annotations(self, resource_id: ResourceId) -> list[Annotation]:
        return await self._with_tags(
            await self._vertices("g.V().hasLabel('Annotation').has('resourceId', rid).valueMap()", rid=resource_id)
        )

    @override
    async def get_resource_referenced_by(self, resource_id: ResourceId, motivation: Motivation | None) -> list[Annotation]:
        del motivation
        return await self._with_tags(
            await self._vertices("g.V().hasLabel('Annotation').has('resolvedResourceId', rid).valueMap()", rid=resource_id)
        )

    @override
    async def get_resource_connections(self, resource_id: ResourceId) -> list[GraphConnection]:
        outgoing = await self._with_tags(
            await self._vertices("g.V().hasLabel('Annotation').has('resourceId', rid).has('source').valueMap()", rid=resource_id)
        )
        incoming = await self._with_tags(
            await self._vertices("g.V().hasLabel('Annotation').has('source', rid).valueMap()", rid=resource_id)
        )
        targets: dict[str, ResourceDescriptor] = {}
        links: dict[str, list[Annotation]] = {}
        for annotation in outgoing:
            linked = body_source(annotation.body)
            if linked is None:
                continue
            target = await self.get_resource(linked)
            if target is not None:
                targets[target.id] = target
                links.setdefault(target.id, []).append(annotation)
        # A resource links back where one of the annotations that link here is on it.
        back: set[str] = {target_source(annotation.target) for annotation in incoming}
        return [
            GraphConnection(target_resource=targets[linked], annotations=annotations, bidirectional=linked in back)
            for linked, annotations in links.items()
        ]

    @override
    async def find_path(self, from_resource_id: ResourceId, to_resource_id: ResourceId, max_depth: int) -> list[GraphPath]:
        paths = _PATHS.validate_python(
            await self._ask(
                _RESOURCE + ".repeat(__.both('REFERENCES').simplePath()).times(depth).emit().has('id', goal)"
                ".path().by(__.valueMap()).limit(10)",
                rid=from_resource_id,
                goal=to_resource_id,
                depth=max_depth,
            )
        )
        # Every second vertex on the way is taken for a resource. The annotations between them are not answered.
        return [GraphPath(resources=[_resource(vertex) for vertex in path.objects[::2]], annotations=[]) for path in paths]

    # ── What the graph holds, counted ──────────────────────────────────

    @override
    async def get_entity_type_stats(self) -> list[EntityTypeCount]:
        # Counted here and not by the server: the entity types of a resource are one JSON string to it.
        counts: dict[str, int] = {}
        for held in _NAMES.validate_python(await self._ask("g.V().hasLabel('Resource').values('entityTypes')")):
            for entity_type in _NAMES.validate_json(held):
                counts[entity_type] = counts.get(entity_type, 0) + 1
        return [EntityTypeCount(type=entity_type, count=count) for entity_type, count in counts.items()]

    @override
    async def get_stats(self) -> GraphStats:
        annotations = "g.V().hasLabel('Annotation')"
        (content_types,) = _GROUPS.validate_python(await self._ask("g.V().hasLabel('Resource').groupCount().by('format')"))
        return GraphStats(
            resource_count=await self._count("g.V().hasLabel('Resource').count()"),
            annotation_count=await self._count(annotations + ".count()"),
            highlight_count=await self._count(annotations + ".hasNot('resolvedResourceId').count()"),
            reference_count=await self._count(annotations + ".has('resolvedResourceId').count()"),
            entity_reference_count=await self._count(annotations + ".has('resolvedResourceId').has('entityTypes').count()"),
            entity_types={counted.type: counted.count for counted in await self.get_entity_type_stats()},
            content_types=content_types,
        )

    # ── The vocabulary ─────────────────────────────────────────────────

    async def _vocabulary(self) -> set[str]:
        """The vocabulary: read from the graph the first time it is asked for, and the store's own from then on.

        Where the graph holds none, it is what every knowledge base starts
        with, and that is written.
        """
        if self._entity_types is None:
            held: set[str] | None = None
            for collection in _COLLECTIONS.validate_python(
                await self._ask("g.V().hasLabel('TagCollection').project('type', 'tags').by('type').by(__.values('tags').fold())")
            ):
                if collection["type"] == "entity-types":
                    held = set(collection["tags"])
            if held is None:
                held = set(DEFAULT_ENTITY_TYPES)
                steps = "".join(f".property(set, 'tags', t{index})" for index in range(len(DEFAULT_ENTITY_TYPES)))
                starting = {f"t{index}": tag for index, tag in enumerate(DEFAULT_ENTITY_TYPES)}
                await self._ask("g.addV('TagCollection').property('type', 'entity-types')" + steps, **starting)
            self._entity_types = held
        return self._entity_types

    @override
    async def get_entity_types(self) -> list[str]:
        return sorted(await self._vocabulary())

    @override
    async def add_entity_type(self, tag: str) -> None:
        await self.add_entity_types([tag])

    @override
    async def add_entity_types(self, tags: Sequence[str]) -> None:
        vocabulary = await self._vocabulary()
        vocabulary.update(tags)
        for tag in tags:
            await self._ask(_VOCABULARY + ".property(set, 'tags', tag)", tag=tag)

    # ── Everything ─────────────────────────────────────────────────────

    @override
    async def clear_database(self) -> None:
        await self._ask("g.V().drop()")
        self._entity_types = None
