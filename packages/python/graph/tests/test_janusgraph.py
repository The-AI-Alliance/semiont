"""The janusgraph store on a client that keeps no graph: what it asks a server, and what it makes of an answer.

The store has never run against a server, and it does not here. What is
under test is the store's own code: that a write hands the server exactly
the properties the codec gave, that an update writes the whole of what the
codec says is left, and that a read goes through the codec. Whether
JanusGraph takes these scripts, and answers them in these shapes, no case
here can say.
"""

from collections.abc import Awaitable, Callable, Mapping

import pytest
from aio import run
from contract import AUTHORED, annotation, link, resource, tag
from gremlin_stores import (
    HIGHLIGHT,
    ON,
    RESOURCE,
    RESOURCE_WITHOUT_STORAGE,
    SOURCE_ONLY,
    STORAGE_URI,
    TO,
    FakeGremlin,
    alone,
    replacing_the_client,
    set_by,
    setting,
    table,
    vertex,
    without_the_library,
)
from pydantic import JsonValue
from semiont.identifiers import AnnotationId, ResourceId
from semiont.model import written
from semiont.types import Annotation

from semiont_graph.codec import decode_annotation, encode_annotation, encode_resource, intended_graph_annotation
from semiont_graph.janusgraph import JanusGraphDatabase

READ_RESOURCE = "g.V().has('Resource', 'id', rid).valueMap()"
READ_ANNOTATION = "g.V().has('Annotation', 'id', aid).valueMap()"
READ_TAGS = "g.V().has('Annotation', 'id', aid).out('TAGGED_AS').has('EntityType').values('name')"
REFERENCES_ON = "g.V().hasLabel('Annotation').has('resourceId', rid).has('type', stored).valueMap()"


def held[T](scenario: Callable[[JanusGraphDatabase], Awaitable[T]]) -> T:
    """What `scenario` answers, run against a connected store."""

    async def whole() -> T:
        db = JanusGraphDatabase(host="graph.example", port=8182)
        await db.connect()
        try:
            return await scenario(db)
        finally:
            await db.disconnect()

    return run(whole())


def reading_back(fake: FakeGremlin) -> None:
    """From here on, a read of the one annotation is answered with what the store asked to be written of it."""
    (row,) = fake.added("Annotation")
    fake.answers = table({READ_ANNOTATION: [vertex(row)]})


# ── Connecting ─────────────────────────────────────────────────────────


def test_it_asks_through_one_connection_at_the_address_it_was_given_and_closes_it(monkeypatch: pytest.MonkeyPatch) -> None:
    fake = replacing_the_client(monkeypatch)

    async def scenario(db: JanusGraphDatabase) -> bool:
        return db.is_connected()

    assert held(scenario)
    assert fake.opened == [("ws://graph.example:8182/gremlin", "g", 1)]
    assert fake.asked == [("g.V().limit(1)", {})]
    assert fake.closed == 1


def test_without_the_clients_library_the_store_fails_naming_its_extra_and_the_in_memory_store_is_made() -> None:
    said = (
        "The janusgraph store needs Apache TinkerPop's `gremlinpython` client, which is not installed. "
        "It comes with the extra: install `semiont-graph[janusgraph]`."
    )
    assert alone(without_the_library("janusgraph")).splitlines() == [
        f"ModuleNotFoundError | gremlin_python | ModuleNotFoundError | {said}",
        "False",
    ]


# ── A write ────────────────────────────────────────────────────────────


def test_an_annotation_is_written_as_exactly_the_codecs_properties_with_the_date_it_was_given(monkeypatch: pytest.MonkeyPatch) -> None:
    fake = replacing_the_client(monkeypatch)
    properties = encode_annotation(intended_graph_annotation(HIGHLIGHT))

    stored = held(lambda db: db.create_annotation(HIGHLIGHT))

    # Every property is the codec's and none is the store's own: no clock, and `created` as it was given.
    assert fake.asked[1] == ("g.addV('Annotation')" + setting(properties), {f"p_{name}": value for name, value in properties.items()})
    assert fake.added("Annotation") == [properties]
    assert properties["created"] == AUTHORED
    assert properties["selector"] == '{"type":"TextQuoteSelector","exact":"Black Hawk","prefix":"","suffix":""}'
    assert properties["exact"] == "Black Hawk"
    assert (properties["type"], properties["motivation"]) == ("TextualBody", "highlighting")
    assert (properties["id"], properties["resourceId"]) == ("ann-highlight", "res-1")
    assert stored == intended_graph_annotation(HIGHLIGHT)


def test_a_target_with_no_selector_writes_no_selector_property(monkeypatch: pytest.MonkeyPatch) -> None:
    fake = replacing_the_client(monkeypatch)

    stored = held(lambda db: db.create_annotation(SOURCE_ONLY))

    (script, bindings) = fake.asked[1]
    row = set_by(bindings)
    assert row["id"] == "ann-source-only"
    assert not {"selector", "exact", "text"} & set(row)
    assert "{}" not in row.values()
    assert "selector" not in script
    assert row["created"] == AUTHORED
    assert written(stored)["target"] == {"source": "res-1"}
    assert written(stored)["body"] == [link(TO)]


def test_a_resources_storage_location_goes_through_the_write_and_back_out_of_a_read(monkeypatch: pytest.MonkeyPatch) -> None:
    fake = replacing_the_client(monkeypatch)

    async def scenario(db: JanusGraphDatabase) -> None:
        assert await db.create_resource(RESOURCE) == RESOURCE
        (row,) = fake.added("Resource")
        # Exactly the codec's properties, the list among them kept as a JSON string.
        assert row == {**encode_resource(RESOURCE), "entityTypes": '["Place"]'}
        assert row["storageUri"] == STORAGE_URI

        fake.answers = table({READ_RESOURCE: [vertex(row)]})
        assert await db.get_resource(ON) == RESOURCE
        assert fake.bound(READ_RESOURCE) == [{"rid": "res-1"}]

    held(scenario)


def test_a_resource_with_no_storage_location_writes_no_such_property_and_reads_back_with_none(monkeypatch: pytest.MonkeyPatch) -> None:
    fake = replacing_the_client(monkeypatch)

    async def scenario(db: JanusGraphDatabase) -> None:
        await db.create_resource(RESOURCE_WITHOUT_STORAGE)
        (row,) = fake.added("Resource")
        assert "storageUri" not in row

        fake.answers = table({READ_RESOURCE: [vertex(row)]})
        read = await db.get_resource(ON)
        assert read == RESOURCE_WITHOUT_STORAGE
        assert read is not None
        assert written(read)["representations"] == [{"mediaType": "text/markdown", "checksum": "sha256:abc", "rel": "original"}]

    held(scenario)


# ── An update ──────────────────────────────────────────────────────────


def test_an_update_rewrites_the_row_and_says_which_tags_and_link_it_has(monkeypatch: pytest.MonkeyPatch) -> None:
    fake = replacing_the_client(monkeypatch)
    body: list[JsonValue] = [tag("Person"), link(TO)]

    async def scenario(db: JanusGraphDatabase) -> Annotation:
        await db.create_annotation(HIGHLIGHT)
        reading_back(fake)
        return await db.update_annotation(HIGHLIGHT.id, {"body": body})

    updated = held(scenario)

    properties = encode_annotation(updated)
    one = "g.V().has('Annotation', 'id', aid)"
    # After the two reads of the annotation as it was: the row, then its tag edges, then its link.
    assert fake.asked[-7:] == [
        (
            one + ".sideEffect(__.properties().drop())" + setting(properties),
            {"aid": "ann-highlight", **{f"p_{name}": value for name, value in properties.items()}},
        ),
        (one + ".outE('TAGGED_AS').drop()", {"aid": "ann-highlight"}),
        ("g.V().has('EntityType', 'name', named)", {"named": "Person"}),
        ("g.addV('EntityType').property('name', named)", {"named": "Person"}),
        (one + ".addE('TAGGED_AS').to(__.V().has('EntityType', 'name', named))", {"aid": "ann-highlight", "named": "Person"}),
        (one + ".outE('REFERENCES').drop()", {"aid": "ann-highlight"}),
        (one + ".addE('REFERENCES').to(__.V().has('Resource', 'id', rid))", {"aid": "ann-highlight", "rid": "res-2"}),
    ]
    # Nothing of the store's own: no property for a body, and no clock.
    assert sorted(properties) == ["created", "creator", "exact", "id", "motivation", "resourceId", "selector", "source", "type"]
    assert properties["source"] == "res-2"
    assert updated.created == AUTHORED
    assert written(updated)["body"] == body


def test_an_updated_selector_is_written_with_its_quoted_text(monkeypatch: pytest.MonkeyPatch) -> None:
    fake = replacing_the_client(monkeypatch)
    moved: dict[str, JsonValue] = {"type": "TextQuoteSelector", "exact": "Cedar County", "prefix": "", "suffix": ""}

    async def scenario(db: JanusGraphDatabase) -> None:
        await db.create_annotation(SOURCE_ONLY)
        reading_back(fake)
        await db.update_annotation(SOURCE_ONLY.id, {"target": {"source": ON, "selector": moved}})

    held(scenario)

    (row,) = [set_by(bindings) for script, bindings in fake.asked if "properties().drop()" in script]
    assert row["selector"] == '{"type":"TextQuoteSelector","exact":"Cedar County","prefix":"","suffix":""}'
    assert row["exact"] == "Cedar County"


# ── A read ─────────────────────────────────────────────────────────────


def test_a_read_takes_the_first_of_each_propertys_values_and_decodes_through_the_codec(monkeypatch: pytest.MonkeyPatch) -> None:
    fake = replacing_the_client(monkeypatch)
    given = annotation(AnnotationId("ann-read"), ON, "linking", body=[tag("Place"), tag("Person"), link(TO)])
    properties = encode_annotation(given)
    # A resource as a server may hand one back: its list as the JSON string it was kept as, and its boolean as text.
    kept: dict[str, object] = {**encode_resource(RESOURCE), "entityTypes": '["Place"]', "archived": "true"}
    fake.answers = table(
        {
            READ_ANNOTATION: [{**vertex(properties), "modified": [], "generator": [None]}],
            READ_TAGS: ["Place", "", "Person"],
            READ_RESOURCE: [vertex(kept)],
        }
    )

    async def scenario(db: JanusGraphDatabase) -> None:
        read = await db.get_annotation(given.id)
        assert read == decode_annotation(properties, ["Place", "Person"])
        assert read == intended_graph_annotation(given)
        assert fake.bound(READ_TAGS) == [{"aid": "ann-read"}]

        archived = await db.get_resource(ON)
        assert archived == RESOURCE.model_copy(update={"archived": True})

    held(scenario)


# ── Connections ────────────────────────────────────────────────────────


def reference(name: str, to: str) -> Annotation:
    return annotation(AnnotationId(name), ON, "linking", target={"source": ON}, body=[link(ResourceId(to))])


def holding(fake: FakeGremlin) -> None:
    """From here on, the references and the resources the store asked to be written are what it is answered.

    Every reference written is answered as one on the resource asked about,
    and a resource is answered by the id it is asked for under. No edge is
    kept, and a connection is read along none.
    """

    def answers(script: str, bindings: Mapping[str, object]) -> list[object]:
        if script == REFERENCES_ON:
            return [vertex(row) for row in fake.added("Annotation")]
        if script == READ_RESOURCE:
            return [vertex(row) for row in fake.added("Resource") if row["id"] == bindings["rid"]]
        return []

    fake.answers = answers


def connections_of(fake: FakeGremlin, *references: Annotation) -> tuple[list[str], list[list[str]]]:
    """The resources `res-1` is connected to, and the ids of the annotations of each connection."""

    async def scenario(db: JanusGraphDatabase) -> tuple[list[str], list[list[str]]]:
        for name in ("res-1", "res-2", "res-3"):
            await db.create_resource(resource(ResourceId(name), name=name, entityTypes=[]))
        for each in references:
            await db.create_annotation(each)
        holding(fake)
        connections = await db.get_resource_connections(ON)
        assert not [connection for connection in connections if connection.bidirectional]
        return (
            [str(connection.target_resource.id) for connection in connections],
            [[str(linking.id) for linking in connection.annotations] for connection in connections],
        )

    return held(scenario)


def test_a_resources_references_are_asked_for_by_the_type_a_reference_is_stored_with(monkeypatch: pytest.MonkeyPatch) -> None:
    fake = replacing_the_client(monkeypatch)

    async def scenario(db: JanusGraphDatabase) -> None:
        await db.create_annotation(SOURCE_ONLY)
        await db.get_resource_connections(ON)

    held(scenario)

    # A filter that asked for one value while a write stored another would match no reference.
    (row,) = fake.added("Annotation")
    assert fake.bound(REFERENCES_ON) == [{"rid": "res-1", "stored": row["type"]}]


def test_a_connection_is_one_for_each_resource_linked_to(monkeypatch: pytest.MonkeyPatch) -> None:
    fake = replacing_the_client(monkeypatch)

    assert connections_of(fake, reference("ann-a", "res-2"), reference("ann-b", "res-3")) == (
        ["res-2", "res-3"],
        [["ann-a"], ["ann-b"]],
    )


def test_every_reference_to_one_resource_is_in_that_resources_connection(monkeypatch: pytest.MonkeyPatch) -> None:
    fake = replacing_the_client(monkeypatch)

    assert connections_of(fake, reference("ann-a", "res-2"), reference("ann-b", "res-3"), reference("ann-c", "res-2")) == (
        ["res-2", "res-3"],
        [["ann-a", "ann-c"], ["ann-b"]],
    )
