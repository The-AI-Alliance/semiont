"""The Qdrant store and the Qdrant reader, held against a real Qdrant: the store to the contract every store is and to what a point is.

Not collected with the package's tests, which need no database: run as
`uv run pytest tests/qdrant_live.py`, told where a Qdrant is by `QDRANT_HOST`,
whose HTTP API is asked on port 6333. A run without it fails and says why. It
is not skipped: a store nothing ran against a database is a store nothing is
known of.

Both collections are deleted before each case. Point it at no Qdrant that
holds anything to keep.

The store asks a Qdrant by requests of its own making, and nothing but a
Qdrant says whether they are requests Qdrant takes, and whether it answers
them as the store reads its answers. So every history of
`specs/src/vectors/store-cases.json` is run here, through the contract. What
only a Qdrant shows is here too, read back by this module's own requests and
never through the store: that each point
`specs/src/vectors/payload-cases.json` states is kept under its `qdrantId`
with exactly its `payload`, and that the collections are as that table's
`collections` states them.

The Qdrant reader is held here too: that connecting it makes no collection,
by the collections the Qdrant then says it has; that a search of a
collection that is not there fails, says so, and makes none; that it finds
what a store wrote; and that a search which fails for another reason is
raised as Qdrant answered it.
"""

import os
from collections.abc import Awaitable, Callable
from typing import Final, final, override

import httpx
import pytest
from aio import run
from pydantic import JsonValue, TypeAdapter
from semiont.identifiers import AnnotationId, ResourceId
from spec import SPEC, JsonObject, objects, read, text, thing
from store_contract import StoreContract, part, put_annotation, put_resource, width_of

from semiont_vectors.qdrant import QdrantVectorReader, QdrantVectorStore
from semiont_vectors.store import AnnotationPayload, CollectionAbsent, EmbeddingChunk, SearchOptions, VectorStore

PORT: Final = 6333

FIVE: Final = SearchOptions(limit=5)

TABLE: Final = read(SPEC / "vectors/payload-cases.json")
COLLECTIONS: Final = {role: thing(stated, role) for role, stated in thing(TABLE["collections"], "collections").items()}
"""What the table states of each collection: of the one of resources' chunks, and of the one of annotations."""

RESOURCES: Final = text(COLLECTIONS["resources"]["name"], "name")
ANNOTATIONS: Final = text(COLLECTIONS["annotations"]["name"], "name")

_OBJECT: Final = TypeAdapter[JsonObject](JsonObject)


def host() -> str:
    """Where the Qdrant is. A run that was not told fails here, and says why."""
    stated = os.environ.get("QDRANT_HOST")
    assert stated, "QDRANT_HOST is not set: these cases run against a real Qdrant, and are told where it is"
    return stated


def qdrant() -> httpx.AsyncClient:
    """This module's own way to the Qdrant: what it reads there is not read through the store."""
    return httpx.AsyncClient(base_url=f"http://{host()}:{PORT}", timeout=30.0, trust_env=False)


def answered(response: httpx.Response) -> JsonObject:
    """The `result` of an answer of the Qdrant's, which is a success and an object."""
    assert response.is_success, f"{response.request.url.path} answered {response.status_code}: {response.text}"
    return thing(_OBJECT.validate_json(response.content)["result"], "result")


async def cleared() -> None:
    """Delete both collections, by this module's own requests: the store has no member that empties it."""
    async with qdrant() as http:
        for name in (RESOURCES, ANNOTATIONS):
            response = await http.delete(f"/collections/{name}")
            # A collection that was not there is as gone as one that was deleted.
            assert response.status_code in (200, 404), f"deleting {name} answered {response.status_code}: {response.text}"


def answering(width: int) -> Callable[[], Awaitable[int]]:
    """What a store is given to ask how wide a vector is, of a provider whose vectors are `width` numbers."""

    async def dimensions() -> int:
        return width

    return dimensions


async def never_asked() -> int:
    raise AssertionError("the collections are there: nobody is asked how wide a vector is")


async def emptied(width: int) -> QdrantVectorStore:
    """A connected store of a Qdrant that holds nothing, its collections made for vectors of `width` numbers."""
    await cleared()
    store = QdrantVectorStore(host=host(), port=PORT, dimensions=answering(width))
    await store.connect()
    return store


async def points(collection: str) -> dict[str, JsonValue]:
    """Every point of a collection as the Qdrant itself answers it: its payload, by its id."""
    asked = {"limit": 100, "with_payload": True, "with_vector": False}
    async with qdrant() as http:
        page = answered(await http.post(f"/collections/{collection}/points/scroll", json=asked))
    assert page.get("next_page_offset") is None, f"{collection} holds more points than one case writes"
    return {text(point["id"], "id"): point["payload"] for point in objects(page["points"], "points")}


async def made(collection: str) -> JsonObject:
    """What the Qdrant itself says a collection is, in the table's words: how wide, compared by what, and what it indexes."""
    async with qdrant() as http:
        info = answered(await http.get(f"/collections/{collection}"))
    vectors = thing(thing(thing(info["config"], "config")["params"], "params")["vectors"], "vectors")
    schema = thing(info["payload_schema"], "payload_schema")
    indexes: JsonObject = {member: thing(index, member)["data_type"] for member, index in schema.items()}
    return {"name": collection, "size": vectors["size"], "distance": vectors["distance"], "indexes": indexes}


@final
class TestQdrantVectorStore(StoreContract):
    @override
    async def empty(self, width: int) -> VectorStore:
        return await emptied(width)


@pytest.mark.parametrize("given", part("resourceStored"))
def test_each_chunk_of_a_resource_is_kept_under_its_id_with_exactly_its_payload(given: JsonObject) -> None:
    stated = {text(point["qdrantId"], "qdrantId"): point["payload"] for point in objects(given["points"], "points")}

    async def whole() -> None:
        store = await emptied(width_of(given, "resourceStored"))
        try:
            await put_resource(store, given)
            assert await points(RESOURCES) == stated
            assert await points(ANNOTATIONS) == {}
        finally:
            await store.disconnect()

    run(whole())


@pytest.mark.parametrize("given", part("annotationStored"))
def test_an_annotation_is_kept_under_its_id_with_exactly_its_payload(given: JsonObject) -> None:
    point = thing(given["point"], "point")

    async def whole() -> None:
        store = await emptied(width_of(given, "annotationStored"))
        try:
            await put_annotation(store, given)
            assert await points(ANNOTATIONS) == {text(point["qdrantId"], "qdrantId"): point["payload"]}
            assert await points(RESOURCES) == {}
        finally:
            await store.disconnect()

    run(whole())


def test_the_collections_are_as_the_table_states_and_as_wide_as_the_provider_says() -> None:
    async def whole() -> None:
        # No case of either table has vectors of five numbers: the width made is the width answered, and no other.
        store = await emptied(5)
        try:
            # A collection the table grows is one the store must make: this names the two it makes.
            assert sorted(COLLECTIONS) == ["annotations", "resources"]
            for stated in COLLECTIONS.values():
                assert await made(text(stated["name"], "name")) == {**stated, "size": 5}
        finally:
            await store.disconnect()

    run(whole())


def test_connecting_to_collections_that_are_there_asks_nobody_how_wide_a_vector_is() -> None:
    async def whole() -> None:
        first = await emptied(3)
        await first.disconnect()
        # Each index is asked for a second time, which a Qdrant takes as no failure.
        second = QdrantVectorStore(host=host(), port=PORT, dimensions=never_asked)
        await second.connect()
        try:
            assert await second.count() == 0
            for stated in COLLECTIONS.values():
                assert await made(text(stated["name"], "name")) == {**stated, "size": 3}
        finally:
            await second.disconnect()

    run(whole())


def test_a_listing_reads_every_page_of_a_scroll() -> None:
    # The store asks for a thousand payloads to a page, so one more annotation than that is on a second page.
    on = ResourceId("res-1")
    ids = [AnnotationId(f"ann-{number}") for number in range(1001)]

    async def whole() -> None:
        store = await emptied(2)
        try:
            for annotation_id in ids:
                quoted = AnnotationPayload(
                    annotation_id=annotation_id,
                    resource_id=on,
                    motivation="highlighting",
                    entity_types=[],
                    exact_text="some words",
                )
                await store.upsert_annotation_vector([1.0, 0.0], quoted)
            assert await store.count() == len(ids)
            assert await store.list_annotation_ids() == set(ids)
        finally:
            await store.disconnect()

    run(whole())


# ── The reader ─────────────────────────────────────────────────────────


async def collections() -> list[str]:
    """The name of every collection the Qdrant itself says it has."""
    async with qdrant() as http:
        listed = answered(await http.get("/collections"))
    return sorted(text(each["name"], "name") for each in objects(listed["collections"], "collections"))


def reader() -> QdrantVectorReader:
    """A reader of the Qdrant, not yet connected."""
    return QdrantVectorReader(host=host(), port=PORT)


def test_a_reader_that_connects_makes_no_collection() -> None:
    async def whole() -> None:
        await cleared()
        before = await collections()
        assert RESOURCES not in before
        assert ANNOTATIONS not in before
        reading = reader()
        await reading.connect()
        try:
            assert await collections() == before
        finally:
            await reading.disconnect()

    run(whole())


def test_a_search_of_a_collection_that_is_not_there_fails_saying_so_and_makes_none() -> None:
    async def whole() -> None:
        await cleared()
        before = await collections()
        reading = reader()
        await reading.connect()
        try:
            with pytest.raises(CollectionAbsent, match=r"no such collection"):
                await reading.search_resources([1.0, 0.0], FIVE)
            with pytest.raises(CollectionAbsent, match=r"no such collection"):
                await reading.search_annotations([1.0, 0.0], FIVE)
            with pytest.raises(CollectionAbsent, match=r"no such collection"):
                await reading.search_by_resource(ResourceId("res-a"), FIVE)
            assert await collections() == before
        finally:
            await reading.disconnect()

    run(whole())


def test_a_reader_finds_what_a_store_wrote() -> None:
    ahead = EmbeddingChunk(chunk_index=0, text="ahead", embedding=[1.0, 0.0])
    mostly_ahead = EmbeddingChunk(chunk_index=0, text="mostly ahead", embedding=[1.0, 0.5])
    quoted = AnnotationPayload(
        annotation_id=AnnotationId("ann-1"),
        resource_id=ResourceId("res-a"),
        motivation="highlighting",
        entity_types=[],
        exact_text="some words",
    )

    async def whole() -> None:
        store = await emptied(2)
        reading = reader()
        try:
            await store.upsert_resource_vectors(ResourceId("res-a"), [ahead], "checksum-a", [], machine_read=False)
            await store.upsert_resource_vectors(ResourceId("res-b"), [mostly_ahead], "checksum-b", [], machine_read=False)
            await store.upsert_annotation_vector([0.0, 1.0], quoted)
            await reading.connect()

            chunks = await reading.search_resources([1.0, 0.0], FIVE)
            assert [(str(each.resource_id), each.text) for each in chunks] == [("res-a", "ahead"), ("res-b", "mostly ahead")]
            assert chunks == await store.search_resources([1.0, 0.0], FIVE)

            annotations = await reading.search_annotations([0.0, 1.0], FIVE)
            assert [(each.annotation_id, each.text) for each in annotations] == [(AnnotationId("ann-1"), "some words")]
            assert annotations == await store.search_annotations([0.0, 1.0], FIVE)

            alike = await reading.search_by_resource(ResourceId("res-a"), FIVE)
            assert [(str(each.resource_id), each.text) for each in alike] == [("res-b", "mostly ahead")]
            assert alike == await store.search_by_resource(ResourceId("res-a"), FIVE)
        finally:
            await reading.disconnect()
            await store.disconnect()

    run(whole())


def test_a_search_that_fails_for_another_reason_is_raised_as_qdrant_answered_it() -> None:
    # The collections are there, as wide as two numbers. A vector of three is one the Qdrant refuses, and
    # that is no answer of a collection that is not there.
    async def whole() -> None:
        store = await emptied(2)
        reading = reader()
        try:
            await reading.connect()
            with pytest.raises(RuntimeError, match=r"Qdrant answered \d+ to POST /collections/resources/points/query"):
                await reading.search_resources([1.0, 0.0, 0.0], FIVE)
        finally:
            await reading.disconnect()
            await store.disconnect()

    run(whole())
