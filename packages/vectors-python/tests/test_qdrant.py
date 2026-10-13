"""What the Qdrant store and the Qdrant reader do with no Qdrant under them.

Nothing is asked of a store that is not connected, and a store that cannot
reach its Qdrant is not connected. The same holds of a reader. Everything
else either does is done by a Qdrant, and is held against a real one by
`qdrant_live.py`. What the store asks a
Qdrant to make is held there to `specs/src/vectors/payload-cases.json`, by
what the Qdrant then says it has: the store's own constants are private to
it, and a test that read them would hold a name and not what is made.
"""

from collections.abc import Awaitable, Callable
from typing import Final

import httpx
import pytest
from aio import run
from semiont.identifiers import AnnotationId, ResourceId

from semiont_vectors.qdrant import QdrantVectorReader, QdrantVectorStore
from semiont_vectors.store import AnnotationPayload, SearchOptions, VectorReader, VectorStore

RESOURCE: Final = ResourceId("res-1")
ANNOTATION: Final = AnnotationId("ann-1")
QUOTED: Final = AnnotationPayload(
    annotation_id=ANNOTATION,
    resource_id=RESOURCE,
    motivation="highlighting",
    entity_types=[],
    exact_text="some words",
)
ONE: Final = SearchOptions(limit=1)


async def never_asked() -> int:
    raise AssertionError("a store that reached no Qdrant asks nobody how wide a vector is")


def store() -> QdrantVectorStore:
    """A store of a Qdrant that is not there: nothing listens on port 1 of this machine."""
    return QdrantVectorStore(host="127.0.0.1", port=1, dimensions=never_asked)


type Call = Callable[[VectorStore], Awaitable[object]]

CALLS: Final[dict[str, Call]] = {
    "upsert_resource_vectors": lambda held: held.upsert_resource_vectors(RESOURCE, [], "checksum", [], machine_read=False),
    "update_resource_entity_types": lambda held: held.update_resource_entity_types(RESOURCE, []),
    "upsert_annotation_vector": lambda held: held.upsert_annotation_vector([1.0, 0.0], QUOTED),
    "update_annotation_entity_types": lambda held: held.update_annotation_entity_types(ANNOTATION, []),
    "delete_resource_vectors": lambda held: held.delete_resource_vectors(RESOURCE),
    "delete_annotation_vector": lambda held: held.delete_annotation_vector(ANNOTATION),
    "delete_annotation_vectors_for_resource": lambda held: held.delete_annotation_vectors_for_resource(RESOURCE),
    "search_resources": lambda held: held.search_resources([1.0, 0.0], ONE),
    "search_annotations": lambda held: held.search_annotations([1.0, 0.0], ONE),
    "search_by_resource": lambda held: held.search_by_resource(RESOURCE, ONE),
    "count": lambda held: held.count(),
    "list_resource_stamps": lambda held: held.list_resource_stamps(),
    "get_resource_stamp": lambda held: held.get_resource_stamp(RESOURCE),
    "list_annotation_stamps": lambda held: held.list_annotation_stamps(),
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


# ── The reader ─────────────────────────────────────────────────────────


def reader() -> QdrantVectorReader:
    """A reader of a Qdrant that is not there: nothing listens on port 1 of this machine."""
    return QdrantVectorReader(host="127.0.0.1", port=1)


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
