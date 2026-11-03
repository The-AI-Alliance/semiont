"""The Qdrant store and the Qdrant reader, held against a real Qdrant: the store to the contract every store is and to what a point is.

Not collected with the package's tests, which need no database: run as
`uv run pytest tests/qdrant_live.py`, told where a Qdrant is by `QDRANT_HOST`,
whose HTTP API is asked on port 6333. A run without it fails and says why. It
is not skipped: a store nothing ran against a database is a store nothing is
known of.

Every collection of the Qdrant is deleted before each case. Point it at no
Qdrant that holds anything to keep.

The store asks a Qdrant by requests of its own making, and nothing but a
Qdrant says whether they are requests Qdrant takes, and whether it answers
them as the store reads its answers. So every history of
`protocol/specs/src/vectors/store-cases.json` is run here, through the contract. What
only a Qdrant shows is here too, read back by this module's own requests and
never through the store: that each point
`protocol/specs/src/vectors/payload-cases.json` states is kept under its `qdrantId`
with exactly its `payload`, the point that remembers a decline among them;
that the collections are as that table's `collections` states them, and are
named for their knowledge base as its `collectionsNamed` cases state; that
the stores of two knowledge bases on one Qdrant each keep to their own
collections; and that an index made anew is as wide as the provider's
vectors are then, and states its stamp in the metadata of the two
collections that are searched, where another store reads it, and states none
once the two differ.

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
from semiont.identifiers import AnnotationId, ResourceId, UserId
from spec import SPEC, JsonObject, objects, read, text, thing
from store_contract import StoreContract, decline_resource, part, put_annotation, put_resource, width_of

from semiont_vectors.qdrant import QdrantVectorReader, QdrantVectorStore
from semiont_vectors.store import (
    AnnotationPayload,
    AnnotationStamp,
    CollectionAbsent,
    Declined,
    EmbeddingChunk,
    SearchOptions,
    VectorStore,
)

PORT: Final = 6333

FIVE: Final = SearchOptions(limit=5)

TABLE: Final = read(SPEC / "vectors/payload-cases.json")
COLLECTIONS: Final = {role: thing(stated, role) for role, stated in thing(TABLE["collections"], "collections").items()}
"""What the table states of each collection: of resources' chunks, of annotations, and of what is remembered of each declined resource."""

NAMED: Final = [
    thing(case["collectionsNamed"], "collectionsNamed") for case in objects(TABLE["cases"], "cases") if "collectionsNamed" in case
]
"""Each knowledge base the table names the collections of, with their names. The first two are the knowledge bases of these cases."""

KB: Final = UserId(text(NAMED[0]["kb"], "kb"))
NAMES: Final = {word: text(name, word) for word, name in thing(NAMED[0]["names"], "names").items()}
"""The knowledge base every store and reader here is of, and the names of its collections, by their words."""

OTHER_KB: Final = UserId(text(NAMED[1]["kb"], "kb"))
OTHER_NAMES: Final = {word: text(name, word) for word, name in thing(NAMED[1]["names"], "names").items()}
"""Another knowledge base, on the same Qdrant, and the names of its collections."""

RESOURCES: Final = NAMES["resources"]
ANNOTATIONS: Final = NAMES["annotations"]
DECLINED: Final = NAMES["declined"]

STAMP: Final[JsonObject] = {"model": "a-model", "revision": 1}
OTHER_STAMP: Final[JsonObject] = {"model": "another-model", "revision": 2}
"""Two stamps an index may be made anew with. What one states is its writer's to say: a store reads nothing of it."""

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


async def collections() -> list[str]:
    """The name of every collection the Qdrant itself says it has."""
    async with qdrant() as http:
        listed = answered(await http.get("/collections"))
    return sorted(text(each["name"], "name") for each in objects(listed["collections"], "collections"))


async def cleared() -> None:
    """Delete every collection, of every knowledge base, by this module's own requests: as a Qdrant whose volume was wiped is."""
    async with qdrant() as http:
        for name in await collections():
            response = await http.delete(f"/collections/{name}")
            assert response.is_success, f"deleting {name} answered {response.status_code}: {response.text}"
    assert await collections() == []


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
    store = QdrantVectorStore(host=host(), port=PORT, kb=KB, dimensions=answering(width))
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
    return {"size": vectors["size"], "distance": vectors["distance"], "indexes": indexes}


async def stated_stamp(collection: str) -> JsonValue:
    """The stamp the Qdrant itself says a collection states, in its metadata. `None` for a collection that states none."""
    async with qdrant() as http:
        info = answered(await http.get(f"/collections/{collection}"))
    metadata = thing(info["config"], "config").get("metadata")
    return metadata.get("stamp") if isinstance(metadata, dict) else None


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


@pytest.mark.parametrize("given", part("declineStored"))
def test_a_decline_is_kept_under_its_id_with_exactly_its_payload(given: JsonObject) -> None:
    point = thing(given["point"], "point")

    async def whole() -> None:
        # A decline states no vector, so the index is of any width.
        store = await emptied(2)
        try:
            await decline_resource(store, given)
            assert await points(DECLINED) == {text(point["qdrantId"], "qdrantId"): point["payload"]}
            assert await points(RESOURCES) == {}
            assert await points(ANNOTATIONS) == {}
        finally:
            await store.disconnect()

    run(whole())


def test_the_collections_are_as_the_table_states_and_as_wide_as_the_provider_says() -> None:
    async def whole() -> None:
        # No case of either table has vectors of five numbers: the width made is the width answered, and no other.
        store = await emptied(5)
        try:
            # A collection the table grows is one the store must make: this names the three it makes.
            assert sorted(COLLECTIONS) == ["annotations", "declined", "resources"]
            assert await collections() == sorted(NAMES.values())
            for word, stated in COLLECTIONS.items():
                # The table states how wide a collection is only where that is fixed: any other is as wide as the provider says.
                assert await made(NAMES[word]) == {"size": 5, **stated}
        finally:
            await store.disconnect()

    run(whole())


def test_connecting_to_collections_that_are_there_asks_nobody_how_wide_a_vector_is() -> None:
    async def whole() -> None:
        first = await emptied(3)
        await first.disconnect()
        # Each index is asked for a second time, which a Qdrant takes as no failure.
        second = QdrantVectorStore(host=host(), port=PORT, kb=KB, dimensions=never_asked)
        await second.connect()
        try:
            assert await second.count() == 0
            for word, stated in COLLECTIONS.items():
                assert await made(NAMES[word]) == {"size": 3, **stated}
        finally:
            await second.disconnect()

    run(whole())


def test_an_index_made_anew_is_as_wide_as_the_providers_vectors_are_then() -> None:
    widths = [2]

    async def dimensions() -> int:
        return widths[-1]

    of_three = EmbeddingChunk(chunk_index=0, text="of three numbers", embedding=[1.0, 0.0, 0.0])

    async def whole() -> None:
        await cleared()
        store = QdrantVectorStore(host=host(), port=PORT, kb=KB, dimensions=dimensions)
        await store.connect()
        try:
            for word, stated in COLLECTIONS.items():
                assert await made(NAMES[word]) == {"size": 2, **stated}
            # The provider's model is changed for one whose vectors are wider, and the width is asked for again.
            widths.append(3)
            await store.make_anew(STAMP)
            for word, stated in COLLECTIONS.items():
                assert await made(NAMES[word]) == {"size": 3, **stated}
            await store.upsert_resource_vectors(ResourceId("res-a"), [of_three], "sum-a", [], machine_read=False, media_type="text/plain")
            found = await store.search_resources([1.0, 0.0, 0.0], FIVE)
            assert [(str(each.resource_id), each.text) for each in found] == [("res-a", "of three numbers")]
        finally:
            await store.disconnect()

    run(whole())


def test_a_store_that_connects_to_an_index_another_made_anew_reads_the_stamp_it_was_given() -> None:
    async def whole() -> None:
        first = await emptied(2)
        try:
            assert await first.index_stamp() is None
            await first.make_anew(STAMP)
        finally:
            await first.disconnect()
        # The stamp is in the metadata of each collection that is searched, and the declined states none.
        assert await stated_stamp(RESOURCES) == STAMP
        assert await stated_stamp(ANNOTATIONS) == STAMP
        assert await stated_stamp(DECLINED) is None
        second = QdrantVectorStore(host=host(), port=PORT, kb=KB, dimensions=never_asked)
        await second.connect()
        try:
            assert await second.index_stamp() == STAMP
        finally:
            await second.disconnect()

    run(whole())


def test_an_index_whose_two_collections_state_different_stamps_states_none() -> None:
    async def whole() -> None:
        store = await emptied(2)
        try:
            await store.make_anew(STAMP)
            assert await store.index_stamp() == STAMP
            # By this module's own request, as nothing of the store's does: one collection is given another stamp.
            async with qdrant() as http:
                changed = await http.patch(f"/collections/{ANNOTATIONS}", json={"metadata": {"stamp": OTHER_STAMP}})
            assert changed.is_success, f"changing the metadata of {ANNOTATIONS} answered {changed.status_code}: {changed.text}"
            assert await stated_stamp(RESOURCES) == STAMP
            assert await stated_stamp(ANNOTATIONS) == OTHER_STAMP
            assert await store.index_stamp() is None
        finally:
            await store.disconnect()

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
            assert await store.list_annotation_stamps() == dict.fromkeys(ids, AnnotationStamp(resource_id=on, entity_types=()))
        finally:
            await store.disconnect()

    run(whole())


# ── Knowledge bases ────────────────────────────────────────────────────


@pytest.mark.parametrize("given", part("collectionsNamed"))
def test_a_knowledge_bases_collections_are_named_as_the_table_states(given: JsonObject) -> None:
    names = thing(given["names"], "names")

    async def whole() -> None:
        await cleared()
        store = QdrantVectorStore(host=host(), port=PORT, kb=UserId(text(given["kb"], "kb")), dimensions=answering(2))
        await store.connect()
        try:
            assert await collections() == sorted(text(name, "name") for name in names.values())
        finally:
            await store.disconnect()

    run(whole())


def test_the_stores_of_two_knowledge_bases_on_one_qdrant_each_keep_to_their_own_collections() -> None:
    # One resource of the same id in both. The second is made anew at another width and with another stamp, writes,
    # deletes and lists; the first is as it was, and none of either's points answers the other.
    shared = ResourceId("res-1")
    unread = ResourceId("res-2")
    quoted = AnnotationPayload(
        annotation_id=AnnotationId("ann-1"),
        resource_id=shared,
        motivation="highlighting",
        entity_types=[],
        exact_text="some words",
    )
    firsts = EmbeddingChunk(chunk_index=0, text="the first's", embedding=[1.0, 0.0])
    seconds = EmbeddingChunk(chunk_index=0, text="the second's", embedding=[1.0, 0.0, 0.0])

    async def whole() -> None:
        await cleared()
        first = QdrantVectorStore(host=host(), port=PORT, kb=KB, dimensions=answering(2))
        second = QdrantVectorStore(host=host(), port=PORT, kb=OTHER_KB, dimensions=answering(3))
        await first.connect()
        await second.connect()
        try:
            await first.make_anew(STAMP)
            await first.upsert_resource_vectors(shared, [firsts], "sum-1", ["Person"], machine_read=False, media_type="text/plain")
            await first.upsert_annotation_vector([0.0, 1.0], quoted)
            await first.decline_resource(unread, Declined(content_checksum="sum-2", media_type="image/png", reason="no text in it"))
            listed = (
                await first.count(),
                await first.list_resource_stamps(),
                await first.list_annotation_stamps(),
                await first.list_declined(),
            )
            found = await first.search_resources([1.0, 0.0], FIVE)
            assert [each.text for each in found] == ["the first's"]

            await second.make_anew(OTHER_STAMP)
            await second.upsert_resource_vectors(shared, [seconds], "sum-x", [], machine_read=False, media_type="text/plain")
            await second.upsert_annotation_vector([0.0, 1.0, 0.0], quoted)
            await second.decline_resource(unread, Declined(content_checksum="sum-y", media_type="image/png", reason="unreadable"))
            assert await second.count() == 2
            assert [each.text for each in await second.search_resources([1.0, 0.0, 0.0], FIVE)] == ["the second's"]
            await second.delete_resource_vectors(shared)
            await second.delete_annotation_vectors_for_resource(shared)
            assert await second.count() == 0
            assert await second.list_resource_stamps() == {}
            assert await second.list_annotation_stamps() == {}
            assert await second.list_declined() == {unread: Declined(content_checksum="sum-y", media_type="image/png", reason="unreadable")}
            assert await second.search_resources([1.0, 0.0, 0.0], FIVE) == []
            assert await second.index_stamp() == OTHER_STAMP

            assert (
                await first.count(),
                await first.list_resource_stamps(),
                await first.list_annotation_stamps(),
                await first.list_declined(),
            ) == listed
            assert await first.search_resources([1.0, 0.0], FIVE) == found
            assert await first.index_stamp() == STAMP
            # A reader of the first knowledge base reads its collections alone, as its store does.
            reading = reader()
            await reading.connect()
            try:
                assert await reading.search_resources([1.0, 0.0], FIVE) == found
                assert await reading.get_resource_stamp(shared) == (await first.list_resource_stamps())[shared]
            finally:
                await reading.disconnect()
            for word, stated in COLLECTIONS.items():
                assert await made(NAMES[word]) == {"size": 2, **stated}
                assert await made(OTHER_NAMES[word]) == {"size": 3, **stated}
        finally:
            await second.disconnect()
            await first.disconnect()

    run(whole())


# ── The reader ─────────────────────────────────────────────────────────


def reader() -> QdrantVectorReader:
    """A reader of the knowledge base's index in the Qdrant, not yet connected."""
    return QdrantVectorReader(host=host(), port=PORT, kb=KB)


def test_a_reader_that_connects_makes_no_collection() -> None:
    async def whole() -> None:
        await cleared()
        before = await collections()
        assert RESOURCES not in before
        assert ANNOTATIONS not in before
        assert DECLINED not in before
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
            with pytest.raises(CollectionAbsent, match=r"no such collection"):
                await reading.get_resource_stamp(ResourceId("res-a"))
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
            await store.upsert_resource_vectors(ResourceId("res-a"), [ahead], "checksum-a", [], machine_read=False, media_type="text/plain")
            await store.upsert_resource_vectors(
                ResourceId("res-b"), [mostly_ahead], "checksum-b", [], machine_read=False, media_type="text/plain"
            )
            await store.upsert_annotation_vector([0.0, 1.0], quoted)
            await reading.connect()

            chunks = await reading.search_resources([1.0, 0.0], FIVE)
            assert [(str(each.resource_id), each.text) for each in chunks] == [("res-a", "ahead"), ("res-b", "mostly ahead")]
            assert chunks == await store.search_resources([1.0, 0.0], FIVE)

            annotations = await reading.search_annotations([0.0, 1.0], FIVE)
            assert [(each.annotation_id, each.text) for each in annotations] == [(AnnotationId("ann-1"), "some words")]
            assert annotations == await store.search_annotations([0.0, 1.0], FIVE)

            # A reader is answered a resource's stamp as the store is, and none for a resource with no points.
            stamp = await reading.get_resource_stamp(ResourceId("res-a"))
            assert stamp is not None
            assert stamp.content_checksum == "checksum-a"
            assert stamp == await store.get_resource_stamp(ResourceId("res-a"))
            assert await reading.get_resource_stamp(ResourceId("res-none")) is None

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
            with pytest.raises(RuntimeError, match=rf"Qdrant answered \d+ to POST /collections/{RESOURCES}/points/query"):
                await reading.search_resources([1.0, 0.0, 0.0], FIVE)
        finally:
            await reading.disconnect()
            await store.disconnect()

    run(whole())
