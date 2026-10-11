"""The neo4j store: a graph in a Neo4j database, asked in Cypher through Neo4j's own client.

What it leans on in the client (`neo4j`, the extra of the same name): the
asynchronous driver, `execute_query` for a statement that stands alone, and a
session's `execute_write` where several statements are one transaction.

What it stores:

- a resource is a node `(:Resource)` whose properties are exactly the codec's
  (`semiont_graph.codec.ResourceProperties`), its entity types as a list;
- an annotation is a node `(:Annotation)` with a second label for its
  motivation (`:Linking`, `:Highlighting`), whose properties are exactly the
  codec's; an edge `-[:BELONGS_TO]->` to the resource it is on; an edge
  `-[:REFERENCES]->` to the resource it links to; and an edge
  `-[:TAGGED_AS]->` to an `(:EntityType {name})` for each entity tag;
- a link's target the graph has not been given yet is a **stub**: a
  `(:Resource)` with its id and `stub: true` and nothing else. It is not a
  resource the graph has: it is never read, listed, counted or followed.
  Storing the resource fills it in, and the mark goes.

The database's schema is this store's to make, and it makes it each time it
connects: an id is unique among resources and among annotations, and what a
reader looks a row up by is indexed. No reader of the graph makes any
(`@semiont/graph` makes none when it connects).

Every date is stored as the text the codec gives, never as one of Neo4j's own
temporal values: the client hands one of those back in another spelling. And
the store reads no clock.
"""

from collections.abc import Mapping, Sequence
from typing import TYPE_CHECKING, Final, LiteralString, final, override

from pydantic import JsonValue, TypeAdapter
from semiont.annotations import body_source, entity_types
from semiont.identifiers import AnnotationId, ResourceId
from semiont.model import written
from semiont.types import Annotation, Motivation, ResourceDescriptor

from semiont_graph._query import search_terms
from semiont_graph.codec import (
    LINKING,
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

try:
    from neo4j import AsyncDriver, AsyncGraphDatabase, AsyncManagedTransaction, Record
except ModuleNotFoundError as missing:
    if missing.name != "neo4j":
        raise
    raise ModuleNotFoundError(
        "The neo4j store needs Neo4j's `neo4j` client, which is not installed. It comes with the extra: install `semiont-graph[neo4j]`.",
        name=missing.name,
    ) from missing

if TYPE_CHECKING:
    from neo4j.graph import Node

__all__ = ["Neo4jGraphDatabase"]

_NAMES: Final = TypeAdapter[list[str]](list[str])
_COUNT: Final = TypeAdapter[int](int)
_TEXT: Final = TypeAdapter[str](str)

_SCHEMA: Final[tuple[LiteralString, ...]] = (
    "CREATE CONSTRAINT doc_id IF NOT EXISTS FOR (d:Resource) REQUIRE d.id IS UNIQUE",
    "CREATE CONSTRAINT sel_id IF NOT EXISTS FOR (s:Annotation) REQUIRE s.id IS UNIQUE",
    "CREATE INDEX doc_name IF NOT EXISTS FOR (d:Resource) ON (d.name)",
    "CREATE INDEX doc_entity_types IF NOT EXISTS FOR (d:Resource) ON (d.entityTypes)",
    "CREATE INDEX sel_doc_id IF NOT EXISTS FOR (s:Annotation) ON (s.resourceId)",
)

# An annotation with its entity tags, however it was matched as `a`.
_WITH_TAGS: Final[LiteralString] = "OPTIONAL MATCH (a)-[:TAGGED_AS]->(et:EntityType) RETURN a, collect(et.name) AS tags"

# A stub is a link's target the graph has not been given yet. It is not a resource the graph has.
_HELD: Final[LiteralString] = "coalesce(d.stub, false) = false"

_LABELS: Final[Mapping[Motivation, LiteralString]] = {
    "assessing": "Assessing",
    "commenting": "Commenting",
    "highlighting": "Highlighting",
    "linking": "Linking",
    "tagging": "Tagging",
}
"""The label that restates each motivation. A label is part of a statement's text, where Cypher takes no parameter."""

# Written after the row: its tag edges, and its link. A link's target is merged, as a stub where the graph has not
# been given the resource yet.
_EDGES: Final[LiteralString] = """
    FOREACH (tag IN $tags |
      MERGE (et:EntityType {name: tag})
      CREATE (a)-[:TAGGED_AS]->(et)
    )
    FOREACH (target IN $linked |
      MERGE (to:Resource {id: target})
      ON CREATE SET to.stub = true
      CREATE (a)-[:REFERENCES]->(to)
    )
"""


def _resource(node: "Node") -> ResourceDescriptor:
    """The resource a node is. Which properties a resource has, and which it must have, is the codec's."""
    return decode_resource(dict(node))


def _annotation(node: "Node", tags: object) -> Annotation:
    """The annotation a node and the names of its tag edges are.

    The codec reads text. A row written by something else can hold one of
    Neo4j's own temporal values, which the client hands back as an object:
    it is put into text here, before the codec sees it.
    """
    properties = {name: value if isinstance(value, str) else str(value) for name, value in dict(node).items() if value is not None}
    return decode_annotation(properties, _NAMES.validate_python(tags))


def _annotations(records: Sequence[Record]) -> list[Annotation]:
    return [_annotation(record["a"], record["tags"]) for record in records]


def _links_of(annotation: Annotation) -> list[str]:
    """Where an annotation's reference edge goes: to the resource it links to, or nowhere."""
    linked = body_source(annotation.body)
    return [] if linked is None else [linked]


@final
class Neo4jGraphDatabase(GraphDatabase):
    """A graph in a Neo4j database. See the module's documentation.

    `uri` is where the database is reached (`bolt://host:7687`), `username`
    and `password` who asks, and `database` which of the server's databases
    holds the graph. Every one is stated.
    """

    def __init__(self, *, uri: str, username: str, password: str, database: str) -> None:
        self._uri: Final = uri
        self._username: Final = username
        self._password: Final = password
        self._database: Final = database
        self._driver: AsyncDriver | None = None

    @override
    async def connect(self) -> None:
        driver = AsyncGraphDatabase.driver(
            self._uri, auth=(self._username, self._password), max_connection_pool_size=50, connection_acquisition_timeout=60.0
        )
        try:
            await driver.execute_query("RETURN 1", database_=self._database)
            for statement in _SCHEMA:
                await driver.execute_query(statement, database_=self._database)
        except BaseException:
            await driver.close()
            raise
        self._driver = driver

    @override
    async def disconnect(self) -> None:
        driver, self._driver = self._driver, None
        if driver is not None:
            await driver.close()

    @override
    def is_connected(self) -> bool:
        return self._driver is not None

    def _reached(self) -> AsyncDriver:
        if self._driver is None:
            raise RuntimeError("the neo4j store is not connected: `connect` it")
        return self._driver

    async def _ask(self, statement: LiteralString, **parameters: object) -> list[Record]:
        """One statement, in a transaction of its own, and every record it answers."""
        answered = await self._reached().execute_query(statement, parameters_=parameters, database_=self._database)
        return answered.records

    # ── Resources ──────────────────────────────────────────────────────

    @override
    async def create_resource(self, resource: ResourceDescriptor) -> ResourceDescriptor:
        properties = encode_resource(resource)
        # MERGE, so that the write is the same twice, and fills in a stub a link made before the resource arrived.
        # The node becomes exactly the codec's properties, so a stub's mark goes with the rest.
        (record,) = await self._ask("MERGE (d:Resource {id: $id}) SET d = $properties RETURN d", id=properties["id"], properties=properties)
        return _resource(record["d"])

    @override
    async def get_resource(self, resource_id: ResourceId) -> ResourceDescriptor | None:
        records = await self._ask("MATCH (d:Resource {id: $id}) WHERE " + _HELD + " RETURN d", id=resource_id)
        return _resource(records[0]["d"]) if records else None

    @override
    async def update_resource(self, resource_id: ResourceId, change: ResourceChange) -> ResourceDescriptor:
        records = await self._ask(
            "MATCH (d:Resource {id: $id}) WHERE " + _HELD + " "
            "SET d.archived = coalesce($archived, d.archived), d.entityTypes = coalesce($entityTypes, d.entityTypes) "
            "RETURN d",
            id=resource_id,
            archived=change.archived,
            entityTypes=None if change.entity_types is None else list(change.entity_types),
        )
        if not records:
            raise LookupError("Resource not found")
        return _resource(records[0]["d"])

    @override
    async def delete_resource(self, resource_id: ResourceId) -> None:
        async def delete(tx: AsyncManagedTransaction) -> None:
            await tx.run("MATCH (own:Annotation)-[:BELONGS_TO]->(:Resource {id: $id}) DETACH DELETE own", id=resource_id)
            await tx.run(
                "MATCH (d:Resource {id: $id}) WHERE NOT EXISTS { (:Annotation)-[:REFERENCES]->(d) } DETACH DELETE d", id=resource_id
            )
            # Where another resource's annotation links here the node is left as a stub, an id with the edge still
            # on it, exactly as when a link arrives before its target.
            await tx.run("MATCH (d:Resource {id: $id}) SET d = {id: $id, stub: true}", id=resource_id)

        async with self._reached().session(database=self._database) as session:
            await session.execute_write(delete)

    @override
    async def list_resources(self, query: ResourceQuery) -> ResourceListing:
        terms = search_terms(query.search) if query.search else []
        parameters: dict[str, object] = {
            "archived": query.archived,
            "entityTypes": list(query.entity_types),
            "terms": terms,
            "search": (query.search or "").strip().lower(),
            "skip": query.offset,
            "limit": query.limit,
        }
        # Every word must appear, each in the name, the storage location or an entity type.
        matched: LiteralString = (
            "MATCH (d:Resource) WHERE " + _HELD + " "
            "AND ($archived IS NULL OR d.archived = $archived) "
            "AND (size($entityTypes) = 0 OR ANY(wanted IN $entityTypes WHERE wanted IN d.entityTypes)) "
            "AND ALL(term IN $terms WHERE toLower(d.name) CONTAINS term "
            "OR toLower(coalesce(d.storageUri, '')) CONTAINS term "
            "OR ANY(held IN coalesce(d.entityTypes, []) WHERE toLower(held) CONTAINS term)) "
        )
        (counted,) = await self._ask(matched + "RETURN count(d) AS total", **parameters)
        # Ranked here and not over the page returned, which would order one page and not the matches. With no
        # search every resource has the one rank.
        records = await self._ask(
            matched + "WITH d, CASE "
            "WHEN size($terms) = 0 THEN 0 "
            "WHEN toLower(d.name) = $search THEN 0 "
            "WHEN toLower(d.name) STARTS WITH $search THEN 1 "
            "WHEN ALL(term IN $terms WHERE toLower(d.name) CONTAINS term) THEN 2 "
            "ELSE 3 END AS rank "
            "RETURN d ORDER BY rank, d.created DESC, d.id SKIP $skip LIMIT $limit",
            **parameters,
        )
        return ResourceListing(resources=[_resource(record["d"]) for record in records], total=_COUNT.validate_python(counted["total"]))

    # ── Annotations ────────────────────────────────────────────────────

    @override
    async def create_annotation(self, annotation: Annotation) -> Annotation:
        stored = intended_graph_annotation(annotation)
        properties = encode_annotation(stored)
        # MERGE, so that an annotation stored again under its id is the one annotation: its row becomes exactly
        # the codec's properties, and its edges exactly what it has.
        records = await self._ask(
            "MATCH (on:Resource {id: $on}) WHERE coalesce(on.stub, false) = false "
            "MERGE (a:Annotation {id: $id}) "
            "SET a = $properties, a:" + _LABELS[stored.motivation] + " "
            "WITH a, on OPTIONAL MATCH (a)-[stale]->() DELETE stale "
            "WITH DISTINCT a, on CREATE (a)-[:BELONGS_TO]->(on) " + _EDGES + "RETURN a",
            on=properties["resourceId"],
            id=stored.id,
            properties=properties,
            tags=entity_types(stored),
            linked=_links_of(stored),
        )
        if not records:
            raise LookupError(f"Failed to create annotation: Resource {properties['resourceId']} not found in graph database")
        return stored

    @override
    async def get_annotation(self, annotation_id: AnnotationId) -> Annotation | None:
        records = await self._ask("MATCH (a:Annotation {id: $id}) " + _WITH_TAGS, id=annotation_id)
        return _annotation(records[0]["a"], records[0]["tags"]) if records else None

    @override
    async def update_annotation(self, annotation_id: AnnotationId, updates: Mapping[str, JsonValue]) -> Annotation:
        async def update(tx: AsyncManagedTransaction) -> Annotation:
            # One transaction: the row is replaced by what the codec says the update leaves, so the read that is
            # computed from must be the row the write replaces.
            found = await tx.run("MATCH (a:Annotation {id: $id}) " + _WITH_TAGS, id=annotation_id)
            record = await found.single()
            if record is None:
                raise LookupError("Annotation not found")
            current = _annotation(record["a"], record["tags"])
            updated = updated_annotation(current, updates)
            # The label restates the motivation, so it follows it. The row becomes exactly the codec's properties,
            # and its tag and reference edges exactly what the annotation has: one the update took away goes.
            written_row = await tx.run(
                "MATCH (a:Annotation {id: $id}) "
                "REMOVE a:" + _LABELS[current.motivation] + " "
                "SET a = $properties, a:" + _LABELS[updated.motivation] + " "
                "WITH a OPTIONAL MATCH (a)-[stale:TAGGED_AS|REFERENCES]->() DELETE stale "
                "WITH DISTINCT a " + _EDGES + "RETURN a",
                id=annotation_id,
                properties=encode_annotation(updated),
                tags=entity_types(updated),
                linked=_links_of(updated),
            )
            await written_row.consume()
            return updated

        async with self._reached().session(database=self._database) as session:
            return await session.execute_write(update)

    @override
    async def delete_annotation(self, annotation_id: AnnotationId) -> None:
        await self._ask("MATCH (a:Annotation {id: $id}) DETACH DELETE a", id=annotation_id)

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
        return _annotations(
            await self._ask("MATCH (a:Annotation {resourceId: $id}) " + _WITH_TAGS + " ORDER BY a.created DESC, a.id", id=resource_id)
        )

    @override
    async def get_resource_referenced_by(self, resource_id: ResourceId, motivation: Motivation | None) -> list[Annotation]:
        return _annotations(
            await self._ask(
                "MATCH (a:Annotation)-[:REFERENCES]->(:Resource {id: $id}) WHERE $motivation IS NULL OR a.motivation = $motivation "
                + _WITH_TAGS
                + " ORDER BY a.created DESC, a.id",
                id=resource_id,
                motivation=motivation,
            )
        )

    async def _by_id(self, annotation_ids: Sequence[str]) -> dict[str, Annotation]:
        """The annotations of those ids that the graph holds, each by its id."""
        records = await self._ask("MATCH (a:Annotation) WHERE a.id IN $ids " + _WITH_TAGS, ids=list(annotation_ids))
        return {str(annotation.id): annotation for annotation in _annotations(records)}

    @override
    async def get_resource_connections(self, resource_id: ResourceId) -> list[GraphConnection]:
        records = await self._ask(
            "MATCH (:Resource {id: $id})<-[:BELONGS_TO]-(a:Annotation {motivation: $linking})-[:REFERENCES]->(d:Resource) "
            "WHERE " + _HELD + " "
            "WITH d, a ORDER BY a.created DESC, a.id "
            "WITH d, collect(a.id) AS links "
            "RETURN d, links, "
            "EXISTS { (d)<-[:BELONGS_TO]-(:Annotation {motivation: $linking})-[:REFERENCES]->(:Resource {id: $id}) } AS back "
            "ORDER BY d.id",
            id=resource_id,
            linking=LINKING,
        )
        linking = [(record, _NAMES.validate_python(record["links"])) for record in records]
        held = await self._by_id([link for _, links in linking for link in links])
        return [
            GraphConnection(
                target_resource=_resource(record["d"]), annotations=[held[link] for link in links], bidirectional=bool(record["back"])
            )
            for record, links in linking
        ]

    @override
    async def find_path(self, from_resource_id: ResourceId, to_resource_id: ResourceId, max_depth: int) -> list[GraphPath]:
        start = await self.get_resource(from_resource_id)
        if start is None or max_depth < 1:
            return []
        if from_resource_id == to_resource_id:
            return [GraphPath(resources=[start], annotations=[])]
        # A path of n resources has n - 1 links.
        links = max_depth - 1
        if links < 1:
            return []
        # The bound is part of the pattern, where Cypher takes no parameter. So the pattern has none, the shortest
        # way is found whatever its length, and one longer than the bound is no answer.
        records = await self._ask(
            "MATCH SHORTEST 1 (from:Resource {id: $from}) "
            "((:Resource)<-[:BELONGS_TO]-(link:Annotation {motivation: $linking})-[:REFERENCES]->(next:Resource) "
            "WHERE coalesce(next.stub, false) = false)+ "
            "(to:Resource {id: $to}) "
            "RETURN next, [l IN link | l.id] AS links",
            **{"from": from_resource_id, "to": to_resource_id, "linking": LINKING},
        )
        paths: list[GraphPath] = []
        for record in records:
            on_the_way = _NAMES.validate_python(record["links"])
            if len(on_the_way) > links:
                continue
            held = await self._by_id(on_the_way)
            paths.append(
                GraphPath(resources=[start, *(_resource(node) for node in record["next"])], annotations=[held[link] for link in on_the_way])
            )
        return paths

    # ── What the graph holds, counted ──────────────────────────────────

    async def _counted(self, statement: LiteralString) -> dict[str, int]:
        """A statement that answers `name` and `count`, as how many of each name."""
        return {_TEXT.validate_python(record["name"]): _COUNT.validate_python(record["count"]) for record in await self._ask(statement)}

    async def _resources_by_entity_type(self) -> dict[str, int]:
        return await self._counted("MATCH (d:Resource) WHERE " + _HELD + " UNWIND d.entityTypes AS name RETURN name, count(*) AS count")

    @override
    async def get_entity_type_stats(self) -> list[EntityTypeCount]:
        counts = sorted((await self._resources_by_entity_type()).items(), key=lambda counted: (-counted[1], counted[0]))
        return [EntityTypeCount(type=entity_type, count=count) for entity_type, count in counts]

    @override
    async def get_stats(self) -> GraphStats:
        (resources,) = await self._ask("MATCH (d:Resource) WHERE " + _HELD + " RETURN count(d) AS resources")
        # A highlight and a reference are told apart by motivation, the one property that says which an annotation is.
        (annotations,) = await self._ask(
            "MATCH (a:Annotation) RETURN count(a) AS annotations, "
            "sum(CASE WHEN a.motivation = 'highlighting' THEN 1 ELSE 0 END) AS highlights, "
            "sum(CASE WHEN a.motivation = $linking THEN 1 ELSE 0 END) AS references, "
            "sum(CASE WHEN a.motivation = $linking AND EXISTS { (a)-[:TAGGED_AS]->(:EntityType) } THEN 1 ELSE 0 END) AS tagged",
            linking=LINKING,
        )
        return GraphStats(
            resource_count=_COUNT.validate_python(resources["resources"]),
            annotation_count=_COUNT.validate_python(annotations["annotations"]),
            highlight_count=_COUNT.validate_python(annotations["highlights"]),
            reference_count=_COUNT.validate_python(annotations["references"]),
            entity_reference_count=_COUNT.validate_python(annotations["tagged"]),
            entity_types=await self._resources_by_entity_type(),
            content_types=await self._counted("MATCH (d:Resource) WHERE " + _HELD + " RETURN d.format AS name, count(*) AS count"),
        )

    # ── Everything ─────────────────────────────────────────────────────

    @override
    async def clear_database(self) -> None:
        await self._ask("MATCH (n) DETACH DELETE n")
