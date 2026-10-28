"""The in-memory store, held to the contract every store is, and to what is its own.

Its own is what the tables leave to each store, and what a store with no
database under it says for itself: that its index is its own from when it is
made, a point that scores exactly its threshold, a limit of 0, points that
score the same, a vector of zeros, vectors of two widths, two chunks of one
index, a search by a resource's own vectors that compares with every point,
and a stamp kept as it was when it was given.
"""

from collections.abc import Sequence
from typing import final, override

import pytest
from aio import run
from pydantic import JsonValue
from semiont.identifiers import ResourceId
from store_contract import StoreContract

from semiont_vectors.memory import MemoryVectorStore
from semiont_vectors.store import EmbeddingChunk, SearchOptions, VectorSearchResult, VectorStore


@final
class TestMemoryVectorStore(StoreContract):
    @override
    async def empty(self, width: int) -> VectorStore:
        # It makes no collection, and so is told no width: it holds vectors as wide as it is handed.
        store = MemoryVectorStore()
        await store.connect()
        return store


async def put(store: MemoryVectorStore, resource: str, *embeddings: Sequence[float]) -> None:
    """Give a resource one chunk for each of `embeddings`, in their order. Chunk 2 of `res-a` says `res-a 2`."""
    chunks = [EmbeddingChunk(chunk_index=at, text=f"{resource} {at}", embedding=each) for at, each in enumerate(embeddings)]
    checksum = f"checksum-of-{resource}"
    await store.upsert_resource_vectors(ResourceId(resource), chunks, checksum, [], machine_read=False, media_type="text/plain")


def resources(found: list[VectorSearchResult]) -> list[str]:
    """The resource of each result, in the results' order."""
    return [str(each.resource_id) for each in found]


def test_two_stores_hold_two_indexes() -> None:
    # It is why no deployment is configured with it: an index in one store is no other's.
    async def whole() -> None:
        one, other = MemoryVectorStore(), MemoryVectorStore()
        await put(one, "res-a", [1.0, 0.0])
        assert await one.count() == 1
        assert await other.count() == 0

    run(whole())


def test_the_index_is_the_stores_from_when_it_is_made_and_disconnecting_lets_go_of_none_of_it() -> None:
    async def whole() -> None:
        store = MemoryVectorStore()
        await put(store, "res-a", [1.0, 0.0])
        assert await store.count() == 1
        await store.connect()
        await store.disconnect()
        assert resources(await store.search_resources([1.0, 0.0], SearchOptions(limit=5))) == ["res-a"]

    run(whole())


def test_a_point_that_scores_exactly_the_threshold_is_answered() -> None:
    # The store table has no score equal to its threshold: whether such a point is answered is each store's to say.
    async def whole() -> None:
        store = MemoryVectorStore()
        await put(store, "ahead", [1.0, 0.0])
        await put(store, "across", [0.0, 1.0])
        await put(store, "behind", [-1.0, 0.0])
        found = await store.search_resources([1.0, 0.0], SearchOptions(limit=5, score_threshold=0.0))
        assert resources(found) == ["ahead", "across"]
        assert [each.score for each in found] == [1.0, 0.0]

    run(whole())


def test_a_limit_of_0_answers_nothing() -> None:
    # No case of the store table has such a limit either.
    async def whole() -> None:
        store = MemoryVectorStore()
        await put(store, "res-a", [1.0, 0.0])
        await put(store, "res-b", [1.0, 1.0])
        assert await store.search_resources([1.0, 0.0], SearchOptions(limit=0)) == []
        assert await store.search_by_resource(ResourceId("res-a"), SearchOptions(limit=0)) == []

    run(whole())


def test_points_that_score_the_same_are_answered_in_the_order_they_were_written() -> None:
    async def whole() -> None:
        store = MemoryVectorStore()
        await put(store, "res-b", [2.0, 0.0])
        await put(store, "res-a", [1.0, 0.0])
        assert resources(await store.search_resources([1.0, 0.0], SearchOptions(limit=5))) == ["res-b", "res-a"]
        # A resource put again is written last.
        await put(store, "res-b", [2.0, 0.0])
        assert resources(await store.search_resources([1.0, 0.0], SearchOptions(limit=5))) == ["res-a", "res-b"]

    run(whole())


def test_a_vector_of_zeros_scores_0_against_everything() -> None:
    # It points no way, so there is no angle to it. No case of either table has one.
    async def whole() -> None:
        store = MemoryVectorStore()
        await put(store, "somewhere", [1.0, 0.0])
        await put(store, "nowhere", [0.0, 0.0])
        found = await store.search_resources([1.0, 0.0], SearchOptions(limit=5))
        assert [(str(each.resource_id), each.score) for each in found] == [("somewhere", 1.0), ("nowhere", 0.0)]
        from_nowhere = await store.search_resources([0.0, 0.0], SearchOptions(limit=5))
        assert [each.score for each in from_nowhere] == [0.0, 0.0]

    run(whole())


def test_vectors_of_two_widths_are_not_compared() -> None:
    # The store is told no width, so it is a search that finds the two do not agree.
    async def whole() -> None:
        store = MemoryVectorStore()
        await put(store, "res-a", [1.0, 0.0])
        with pytest.raises(ValueError, match="a vector of 3 numbers cannot be compared with one of 2"):
            await store.search_resources([1.0, 0.0, 0.0], SearchOptions(limit=5))

    run(whole())


def test_two_chunks_of_one_index_are_one_point_the_later() -> None:
    # A point is kept under its key, and a chunk's key is its resource's id and its index.
    async def whole() -> None:
        store = MemoryVectorStore()
        chunks = [
            EmbeddingChunk(chunk_index=0, text="the earlier", embedding=[1.0, 0.0]),
            EmbeddingChunk(chunk_index=0, text="the later", embedding=[0.0, 1.0]),
        ]
        await store.upsert_resource_vectors(ResourceId("res-a"), chunks, "checksum-a", [], machine_read=False, media_type="text/plain")
        assert await store.count() == 1
        (found,) = await store.search_resources([1.0, 0.0], SearchOptions(limit=5))
        assert found.text == "the later"

    run(whole())


def test_the_index_keeps_a_vector_as_it_was_when_it_was_written() -> None:
    async def whole() -> None:
        store = MemoryVectorStore()
        embedding = [1.0, 0.0]
        await put(store, "res-a", embedding)
        embedding.reverse()
        (found,) = await store.search_resources([1.0, 0.0], SearchOptions(limit=5))
        assert found.score == 1.0

    run(whole())


def test_the_index_keeps_its_stamp_as_it_was_when_it_was_given() -> None:
    async def whole() -> None:
        store = MemoryVectorStore()
        reads: list[JsonValue] = ["text"]
        await store.make_anew({"reads": reads})
        reads.append("pdf")
        assert await store.index_stamp() == {"reads": ["text"]}

    run(whole())


def test_a_search_by_a_resources_vectors_compares_with_every_point_of_every_other_resource() -> None:
    # Every search of that kind in the store table finds resources of one or two chunks. Here one resource has more
    # chunks than the search is to answer results, each nearer than the other resource's one, and the other is found.
    async def whole() -> None:
        store = MemoryVectorStore()
        await put(store, "searched-by", [1.0, 0.0])
        nine = [[1.0, 0.0]] * 9
        await put(store, "of-many-chunks", *nine)
        await put(store, "of-one-chunk", [1.0, 1.0])
        found = await store.search_by_resource(ResourceId("searched-by"), SearchOptions(limit=2))
        assert resources(found) == ["of-many-chunks", "of-one-chunk"]
        # Of the nine chunks, which score the same, the one written first is the one answered.
        assert found[0].text == "of-many-chunks 0"

    run(whole())
