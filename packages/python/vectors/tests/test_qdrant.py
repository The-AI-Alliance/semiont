"""What the Qdrant store and the Qdrant reader do with no Qdrant under them, and the token each presents.

Nothing is asked of a store that is not connected, and a store that cannot
reach its Qdrant is not connected. The same holds of a reader. Every
request either makes carries the token it was handed, in the `api-key`
header and in no other: that is held of a stand-in that answers every
request alike (`qdrant_stand_in.py`), for every member that asks the index
something. Everything else either does is done by a Qdrant, and is held
against a real one by `qdrant_live.py`, which holds too what a Qdrant
allows each service's token and refuses it. What the store asks a
Qdrant to make is held there to `protocol/specs/src/vectors/payload-cases.json`, by
what the Qdrant then says it has: the store's own constants are private to
it, and a test that read them would hold a name and not what is made.
"""

from collections.abc import Awaitable, Callable
from typing import Final

import httpx
import pytest
from aio import run
from qdrant_stand_in import TOKEN, PlayedQdrant
from semiont.identifiers import AnnotationId, ResourceId
from semiont.identity import kb_did

from semiont_vectors.qdrant import QdrantVectorReader, QdrantVectorStore
from semiont_vectors.store import AnnotationPayload, Declined, SearchOptions, VectorReader, VectorStore

KB: Final = kb_did("example.github.io:plain-kb")
RESOURCE: Final = ResourceId("res-1")
ANNOTATION: Final = AnnotationId("ann-1")
QUOTED: Final = AnnotationPayload(
    annotation_id=ANNOTATION,
    resource_id=RESOURCE,
    motivation="highlighting",
    entity_types=[],
    exact_text="some words",
)
DECLINED: Final = Declined(content_checksum="checksum", media_type="image/png", reason="no text was read from the image")
ONE: Final = SearchOptions(limit=1)


async def never_asked() -> int:
    raise AssertionError("a store that reached no Qdrant asks nobody how wide a vector is")


async def two_wide() -> int:
    return 2


def store() -> QdrantVectorStore:
    """A store of a Qdrant that is not there: nothing listens on port 1 of this machine."""
    return QdrantVectorStore(host="127.0.0.1", port=1, kb=KB, token=TOKEN, dimensions=never_asked)


type Call = Callable[[VectorStore], Awaitable[object]]


def put(held: VectorStore) -> Awaitable[object]:
    """A put of no chunks, with everything a put takes."""
    return held.upsert_resource_vectors(RESOURCE, [], "checksum", [], machine_read=False, media_type="text/plain")


CALLS: Final[dict[str, Call]] = {
    "upsert_resource_vectors": put,
    "update_resource_entity_types": lambda held: held.update_resource_entity_types(RESOURCE, []),
    "upsert_annotation_vector": lambda held: held.upsert_annotation_vector([1.0, 0.0], QUOTED),
    "update_annotation_entity_types": lambda held: held.update_annotation_entity_types(ANNOTATION, []),
    "delete_resource_vectors": lambda held: held.delete_resource_vectors(RESOURCE),
    "delete_annotation_vector": lambda held: held.delete_annotation_vector(ANNOTATION),
    "delete_annotation_vectors_for_resource": lambda held: held.delete_annotation_vectors_for_resource(RESOURCE),
    "decline_resource": lambda held: held.decline_resource(RESOURCE, DECLINED),
    "make_anew": lambda held: held.make_anew({}),
    "search_resources": lambda held: held.search_resources([1.0, 0.0], ONE),
    "search_annotations": lambda held: held.search_annotations([1.0, 0.0], ONE),
    "search_by_resource": lambda held: held.search_by_resource(RESOURCE, ONE),
    "count": lambda held: held.count(),
    "list_resource_stamps": lambda held: held.list_resource_stamps(),
    "get_resource_stamp": lambda held: held.get_resource_stamp(RESOURCE),
    "list_annotation_stamps": lambda held: held.list_annotation_stamps(),
    "list_declined": lambda held: held.list_declined(),
    "index_stamp": lambda held: held.index_stamp(),
}
"""Every member of a store that asks its index something, each called with what it takes."""


def test_every_member_that_asks_the_index_something_is_among_those_called_here() -> None:
    # A member the protocol grows is called here too, or this fails: none is left to ask a Qdrant that was never reached.
    members = {name for name in dir(VectorStore) if not name.startswith("_")}
    assert set(CALLS) == members - {"connect", "disconnect"}


@pytest.mark.parametrize("member", sorted(CALLS))
def test_a_member_called_before_connect_says_the_store_is_not_connected(member: str) -> None:
    async def whole() -> None:
        with pytest.raises(RuntimeError, match="not connected"):
            await CALLS[member](store())

    run(whole())


def test_disconnecting_a_store_that_never_connected_lets_go_of_nothing() -> None:
    async def whole() -> None:
        never = store()
        await never.disconnect()
        with pytest.raises(RuntimeError, match="not connected"):
            await never.count()

    run(whole())


def test_a_store_that_cannot_reach_its_qdrant_raises_and_is_not_connected() -> None:
    async def whole() -> None:
        unreached = store()
        with pytest.raises(httpx.ConnectError):
            await unreached.connect()
        with pytest.raises(RuntimeError, match="not connected"):
            await unreached.count()

    run(whole())


def presented_the_token(played: PlayedQdrant) -> None:
    """Fail unless every request the stand-in was asked carried the token in its `api-key` header, and none in `authorization`."""
    assert played.asked, "nothing was asked"
    for asked in played.asked:
        assert asked.headers.get("api-key") == TOKEN, f"{asked.method} {asked.path} carries no token"
        assert "authorization" not in asked.headers, f"{asked.method} {asked.path} carries an authorization header"


@pytest.mark.parametrize("member", sorted(CALLS))
def test_every_request_of_a_store_presents_its_token(member: str) -> None:
    async def whole() -> None:
        async with PlayedQdrant() as played:
            held = QdrantVectorStore(host="127.0.0.1", port=played.port, kb=KB, token=TOKEN, dimensions=two_wide)
            await held.connect()
            try:
                connecting = len(played.asked)
                await CALLS[member](held)
                assert len(played.asked) > connecting, f"{member} asked the index nothing"
            finally:
                await held.disconnect()
            presented_the_token(played)

    run(whole())


def test_a_store_whose_token_the_qdrant_refuses_raises_saying_what_it_answered_and_is_not_connected() -> None:
    async def whole() -> None:
        async with PlayedQdrant() as played:
            refused = QdrantVectorStore(host="127.0.0.1", port=played.port, kb=KB, token="another-token", dimensions=never_asked)
            with pytest.raises(RuntimeError, match=r"Qdrant answered 401 to GET /collections/\S+: Must provide an API key"):
                await refused.connect()
            with pytest.raises(RuntimeError, match="not connected"):
                await refused.count()

    run(whole())


# ── The reader ─────────────────────────────────────────────────────────


def reader() -> QdrantVectorReader:
    """A reader of a Qdrant that is not there: nothing listens on port 1 of this machine."""
    return QdrantVectorReader(host="127.0.0.1", port=1, kb=KB, token=TOKEN)


type Read = Callable[[VectorReader], Awaitable[object]]

READS: Final[dict[str, Read]] = {
    "search_resources": lambda held: held.search_resources([1.0, 0.0], ONE),
    "search_annotations": lambda held: held.search_annotations([1.0, 0.0], ONE),
    "search_by_resource": lambda held: held.search_by_resource(RESOURCE, ONE),
    "get_resource_stamp": lambda held: held.get_resource_stamp(RESOURCE),
}
"""Every member of a reader that asks its index something, each called with what it takes."""


def test_every_member_of_a_reader_that_asks_the_index_something_is_among_those_called_here() -> None:
    members = {name for name in dir(VectorReader) if not name.startswith("_")}
    assert set(READS) == members - {"connect", "disconnect"}
    # A store is a reader too: what a reader is asked, a store is asked.
    assert set(READS) <= set(CALLS)


@pytest.mark.parametrize("member", sorted(READS))
def test_a_read_before_connect_says_the_reader_is_not_connected(member: str) -> None:
    async def whole() -> None:
        with pytest.raises(RuntimeError, match="not connected"):
            await READS[member](reader())

    run(whole())


def test_disconnecting_a_reader_that_never_connected_lets_go_of_nothing() -> None:
    async def whole() -> None:
        never = reader()
        await never.disconnect()
        with pytest.raises(RuntimeError, match="not connected"):
            await never.search_resources([1.0, 0.0], ONE)

    run(whole())


def test_a_reader_that_cannot_reach_its_qdrant_raises_and_is_not_connected() -> None:
    async def whole() -> None:
        unreached = reader()
        with pytest.raises(httpx.ConnectError):
            await unreached.connect()
        with pytest.raises(RuntimeError, match="not connected"):
            await unreached.search_resources([1.0, 0.0], ONE)

    run(whole())


@pytest.mark.parametrize("member", sorted(READS))
def test_every_request_of_a_reader_presents_its_token(member: str) -> None:
    async def whole() -> None:
        async with PlayedQdrant() as played:
            held = QdrantVectorReader(host="127.0.0.1", port=played.port, kb=KB, token=TOKEN)
            await held.connect()
            try:
                connecting = len(played.asked)
                await READS[member](held)
                assert len(played.asked) > connecting, f"{member} asked the index nothing"
            finally:
                await held.disconnect()
            presented_the_token(played)

    run(whole())


def test_a_reader_whose_token_the_qdrant_refuses_raises_saying_what_it_answered_and_is_not_connected() -> None:
    async def whole() -> None:
        async with PlayedQdrant() as played:
            refused = QdrantVectorReader(host="127.0.0.1", port=played.port, kb=KB, token="another-token")
            with pytest.raises(RuntimeError, match=r"Qdrant answered 401 to GET /collections: Must provide an API key"):
                await refused.connect()
            with pytest.raises(RuntimeError, match="not connected"):
                await refused.search_resources([1.0, 0.0], ONE)

    run(whole())
