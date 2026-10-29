"""The neo4j store and the neo4j reader, held against a real neo4j: the store to the contract every store is.

Not collected with the package's tests, which need no database: run as
`uv run pytest tests/neo4j_live.py`, told where a neo4j is by `NEO4J_HOST`
and with which password by `NEO4J_PASSWORD`. A run without them fails and
says why. It is not skipped: a store nothing ran against a database is a
store nothing is known of.

The database is cleared before each case and after it. Point it at no
database that holds anything to keep.

The neo4j reader is held here too: that connecting it makes no constraint
and no index, by the ones the database then says it has; that it reads what
a store wrote; and that a read of a database that holds nothing, and has no
schema, answers nothing and makes none.
"""

import os
from typing import Final, LiteralString, final, override

from aio import run
from contract import AUTHORED, GraphContract, highlight, link, reference, resource, rid
from neo4j import AsyncGraphDatabase
from pydantic import JsonValue, TypeAdapter
from spec import strings, text

from semiont_graph.interface import GraphDatabase, ResourceQuery
from semiont_graph.neo4j import Neo4jGraphDatabase, Neo4jGraphReader


def told() -> tuple[str, str]:
    """Where the neo4j is, and its password. A run that was not told fails here, and says why."""
    host, password = os.environ.get("NEO4J_HOST"), os.environ.get("NEO4J_PASSWORD")
    assert host, "NEO4J_HOST is not set: these cases run against a real neo4j, and are told where it is"
    assert password, "NEO4J_PASSWORD is not set: these cases run against a real neo4j, and are told its password"
    return host, password


def store() -> Neo4jGraphDatabase:
    host, password = told()
    return Neo4jGraphDatabase(uri=f"bolt://{host}:7687", username="neo4j", password=password, database="neo4j")


def reader() -> Neo4jGraphReader:
    """A reader of the neo4j, not yet connected."""
    host, password = told()
    return Neo4jGraphReader(uri=f"bolt://{host}:7687", username="neo4j", password=password, database="neo4j")


@final
class TestNeo4jGraph(GraphContract):
    @override
    def make(self) -> GraphDatabase:
        return store()


_ROWS: Final = TypeAdapter[list[dict[str, JsonValue]]](list[dict[str, JsonValue]])


async def rows(statement: LiteralString, **parameters: str) -> list[dict[str, JsonValue]]:
    """What the database itself answers a statement with: the store's own reads are not what holds its writes."""
    host, password = told()
    async with AsyncGraphDatabase.driver(f"bolt://{host}:7687", auth=("neo4j", password)) as driver:
        answered = await driver.execute_query(statement, parameters_=parameters, database_="neo4j")
        return _ROWS.validate_python([record.data() for record in answered.records])


def test_a_row_holds_exactly_what_the_codec_writes_and_no_clock_of_the_stores() -> None:
    async def whole() -> None:
        db = store()
        await db.connect()
        try:
            await db.clear_database()
            on = resource(rid("on"), representations=[{"mediaType": "text/plain", "checksum": "sha256:c", "storageUri": "file:///a.md"}])
            to = rid("to")
            await db.create_resource(on)
            made = await db.create_annotation(reference(on.id, None, "Person"))
            await db.update_annotation(made.id, {"body": [link(to)], "modified": "2021-01-02T03:04:05.000Z"})

            (node,) = await rows("MATCH (d:Resource {id: $id}) RETURN keys(d) AS keys, d.created AS created", id=on.id)
            assert sorted(strings(node["keys"], "keys")) == [
                "archived",
                "contentChecksum",
                "created",
                "creator",
                "entityTypes",
                "format",
                "id",
                "name",
                "storageUri",
            ]
            assert node["created"] == AUTHORED

            (row,) = await rows(
                "MATCH (a:Annotation {id: $id}) RETURN keys(a) AS keys, labels(a) AS labels, a.created AS created", id=made.id
            )
            assert sorted(strings(row["keys"], "keys")) == [
                "created",
                "creator",
                "exact",
                "id",
                "modified",
                "motivation",
                "resourceId",
                "selector",
                "source",
                "type",
            ]
            assert sorted(strings(row["labels"], "labels")) == ["Annotation", "Linking"]
            assert row["created"] == AUTHORED

            # The tag the update took away left no edge, and the link it gave made a stub that is marked as one.
            assert await rows("MATCH (:Annotation {id: $id})-[:TAGGED_AS]->(t) RETURN t.name AS name", id=made.id) == []
            assert await rows("MATCH (:Annotation {id: $id})-[:REFERENCES]->(d) RETURN d.id AS id, d.stub AS stub", id=made.id) == [
                {"id": to, "stub": True}
            ]
            await db.create_resource(resource(to))
            assert await rows("MATCH (d:Resource {id: $id}) RETURN d.stub AS stub", id=to) == [{"stub": None}]

            # Deleted, a resource nothing links to leaves nothing at all, and one something links to leaves its stub.
            await db.delete_resource(on.id)
            assert await rows("MATCH (d:Resource {id: $id}) RETURN d.id AS id", id=on.id) == []
            assert await rows("MATCH (a:Annotation) RETURN a.id AS id") == []
        finally:
            await db.clear_database()
            await db.disconnect()

    run(whole())


# ── The reader ─────────────────────────────────────────────────────────

CONSTRAINTS: Final = ["doc_id", "sel_id"]
INDEXES: Final = ["doc_entity_types", "doc_name", "sel_doc_id"]
"""The schema a store makes, by the names it gives each part: what a database a store has connected to has, and no more."""


async def schema() -> tuple[list[str], list[str]]:
    """The name of every constraint the database itself says it has, and of every index somebody asked for.

    Two kinds of index nobody asked for are left out: the ones neo4j keeps
    of its labels and its relationship types from the start, and the one it
    keeps for each constraint, which comes and goes with that constraint.
    """
    constraints = await rows("SHOW CONSTRAINTS YIELD name RETURN name")
    indexes = await rows("SHOW INDEXES YIELD name, type, owningConstraint WHERE type <> 'LOOKUP' AND owningConstraint IS NULL RETURN name")
    return sorted(text(row["name"], "name") for row in constraints), sorted(text(row["name"], "name") for row in indexes)


async def emptied() -> None:
    """Leave the database holding nothing and with no schema: as it is before any store has connected to it."""
    await rows("MATCH (n) DETACH DELETE n")
    await rows("DROP CONSTRAINT doc_id IF EXISTS")
    await rows("DROP CONSTRAINT sel_id IF EXISTS")
    await rows("DROP INDEX doc_name IF EXISTS")
    await rows("DROP INDEX doc_entity_types IF EXISTS")
    await rows("DROP INDEX sel_doc_id IF EXISTS")
    assert await schema() == ([], [])


def test_a_reader_that_connects_makes_no_constraint_and_no_index_and_a_store_makes_its_schema() -> None:
    async def whole() -> None:
        await emptied()
        reading = reader()
        await reading.connect()
        try:
            assert await schema() == ([], [])
        finally:
            await reading.disconnect()
        # The other half: the same question finds what a store makes, and it is exactly the schema named above.
        writing = store()
        await writing.connect()
        try:
            assert await schema() == (CONSTRAINTS, INDEXES)
        finally:
            await writing.disconnect()

    run(whole())


def test_a_read_of_a_database_that_holds_nothing_answers_nothing_and_makes_nothing() -> None:
    async def whole() -> None:
        await emptied()
        nowhere = rid("nowhere")
        reading = reader()
        await reading.connect()
        try:
            assert await reading.get_resource(nowhere) is None
            listing = await reading.list_resources(ResourceQuery(search="some words", entity_types=["Person"], archived=False))
            assert (listing.resources, listing.total) == ([], 0)
            assert await reading.get_resource_annotations(nowhere) == []
            assert await reading.get_resource_referenced_by(nowhere, None) == []
            assert await reading.get_resource_referenced_by(nowhere, "linking") == []
            assert await reading.get_resource_connections(nowhere) == []
            assert await reading.get_entity_type_stats() == []
            assert await schema() == ([], [])
            assert await rows("MATCH (n) RETURN count(n) AS held") == [{"held": 0}]
        finally:
            await reading.disconnect()

    run(whole())


def test_a_reader_reads_what_a_store_wrote() -> None:
    async def whole() -> None:
        writing = store()
        reading = reader()
        await writing.connect()
        try:
            await writing.clear_database()
            on = resource(rid("on"), name="Ada Lovelace", entityTypes=["Person"])
            to = resource(rid("to"), name="Analytical Engine", entityTypes=["Machine"])
            await writing.create_resource(on)
            await writing.create_resource(to)
            marked = await writing.create_annotation(highlight(on.id))
            linked = await writing.create_annotation(reference(on.id, to.id, "Machine"))
            await reading.connect()

            held = await reading.get_resource(on.id)
            assert held is not None
            assert held.name == "Ada Lovelace"
            assert held == await writing.get_resource(on.id)

            everything = ResourceQuery()
            listing = await reading.list_resources(everything)
            assert sorted(each.name for each in listing.resources) == ["Ada Lovelace", "Analytical Engine"]
            assert listing == await writing.list_resources(everything)
            found = await reading.list_resources(ResourceQuery(search="engine"))
            assert ([each.name for each in found.resources], found.total) == (["Analytical Engine"], 1)

            annotations = await reading.get_resource_annotations(on.id)
            assert sorted(str(each.id) for each in annotations) == sorted([str(marked.id), str(linked.id)])
            assert annotations == await writing.get_resource_annotations(on.id)

            referring = await reading.get_resource_referenced_by(to.id, None)
            assert [str(each.id) for each in referring] == [str(linked.id)]
            assert referring == await writing.get_resource_referenced_by(to.id, None)
            assert await reading.get_resource_referenced_by(to.id, "highlighting") == []

            (connection,) = await reading.get_resource_connections(on.id)
            assert connection.target_resource.name == "Analytical Engine"
            assert [str(by.id) for by in connection.annotations] == [str(linked.id)]
            assert not connection.bidirectional
            assert [connection] == await writing.get_resource_connections(on.id)

            counted = await reading.get_entity_type_stats()
            assert [(each.type, each.count) for each in counted] == [("Machine", 1), ("Person", 1)]
            assert counted == await writing.get_entity_type_stats()
        finally:
            await writing.clear_database()
            await reading.disconnect()
            await writing.disconnect()

    run(whole())
