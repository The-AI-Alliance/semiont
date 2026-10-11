"""The neo4j store, held to the contract every store is, against a real neo4j.

Not collected with the package's tests, which need no database: run as
`uv run pytest tests/neo4j_live.py`, told where a neo4j is by `NEO4J_HOST`
and with which password by `NEO4J_PASSWORD`. A run without them fails and
says why. It is not skipped: a store nothing ran against a database is a
store nothing is known of.

The database is cleared before each case and after it. Point it at no
database that holds anything to keep.
"""

import os
from typing import Final, LiteralString, final, override

from aio import run
from contract import AUTHORED, GraphContract, link, reference, resource, rid
from neo4j import AsyncGraphDatabase
from pydantic import JsonValue, TypeAdapter
from spec import strings

from semiont_graph.interface import GraphDatabase
from semiont_graph.neo4j import Neo4jGraphDatabase


def store() -> Neo4jGraphDatabase:
    host, password = os.environ.get("NEO4J_HOST"), os.environ.get("NEO4J_PASSWORD")
    assert host, "NEO4J_HOST is not set: these cases run against a real neo4j, and are told where it is"
    assert password, "NEO4J_PASSWORD is not set: these cases run against a real neo4j, and are told its password"
    return Neo4jGraphDatabase(uri=f"bolt://{host}:7687", username="neo4j", password=password, database="neo4j")


@final
class TestNeo4jGraph(GraphContract):
    @override
    def make(self) -> GraphDatabase:
        return store()


_ROWS: Final = TypeAdapter[list[dict[str, JsonValue]]](list[dict[str, JsonValue]])


async def rows(statement: LiteralString, **parameters: str) -> list[dict[str, JsonValue]]:
    """What the database itself answers a statement with: the store's own reads are not what holds its writes."""
    host, password = os.environ["NEO4J_HOST"], os.environ["NEO4J_PASSWORD"]
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
