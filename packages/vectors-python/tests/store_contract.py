"""What every store answers, whichever index it asks: the two tables a `VectorStore` is held to.

`specs/src/vectors/store-cases.json` states histories of writes and what each
read then answers, and `specs/src/vectors/payload-cases.json` states what a
point is. Every history is run here, and so are the stored parts of the
payload table, by what a store answers after the write: the stamp, each
point's result by a search with the point's own embedding, an annotation's id
among those listed, and its motivation by a search that filters on it. The id
and the payload of a point are held with no store, by `test_payload_cases.py`.

One set of cases, run against the in-memory store (`test_memory.py`) and
against a real Qdrant (`qdrant_live.py`). Nothing here is run against a fake
of a database.

A member of a case that nothing here reads fails the case: a table that grows
a kind of write, of read or of filter is not passed over.
"""

from abc import ABC, abstractmethod
from collections.abc import Awaitable, Callable, Iterable, Iterator, Sequence
from typing import Final

import pytest
from aio import run
from pydantic import JsonValue
from semiont.identifiers import AnnotationId, ResourceId
from spec import SPEC, JsonObject, objects, read, strings, text, thing

from semiont_vectors.store import (
    AnnotationPayload,
    EmbeddingChunk,
    ResourceStamp,
    SearchFilter,
    SearchOptions,
    VectorSearchResult,
    VectorStore,
)

STORE_CASES = objects(read(SPEC / "vectors/store-cases.json")["cases"], "cases")
PAYLOAD_CASES = objects(read(SPEC / "vectors/payload-cases.json")["cases"], "cases")

SCORE_TOLERANCE = 0.000001
"""How closely a score is compared: the tables state one to six decimal places."""

# Every member each thing a table states may have. A member that is none of these is one nothing here would read.
CHUNK = ("index", "text", "embedding")
RESOURCE_PUT = ("resourceId", "chunks", "contentChecksum", "entityTypes", "machineRead")
ANNOTATION_PUT = ("annotationId", "resourceId", "motivation", "entityTypes", "text", "embedding", "machineRead")
SEARCH = ("limit", "scoreThreshold", "filter", "answers")
FILTER = ("entityTypes", "resourceId", "motivation", "excludeResourceId", "excludeEntityTypes")
RESOURCE_STORED = (*RESOURCE_PUT, "points", "stamp")
ANNOTATION_STORED = (*ANNOTATION_PUT, "point")
POINT = ("qdrantId", "payload", "result")


def histories() -> list[object]:
    """Each history of the store table, named in a test's id by why the case is there."""
    return [pytest.param(case, id=text(case["why"], "why")) for case in STORE_CASES]


def part(name: str) -> list[object]:
    """Each case of one part of the payload table, named in a test's id by why the case is there."""
    return [pytest.param(thing(case[name], name), id=text(case["why"], "why")) for case in PAYLOAD_CASES if name in case]


def only(stated: JsonObject, known: Iterable[str], what: str) -> None:
    """Fail for a member of `stated` that is none of `known`: nothing here would read it."""
    unread = sorted(set(stated) - set(known))
    assert unread == [], f"{what} states {unread}, which nothing here reads"


# ── Reading what a table states ────────────────────────────────────────


def integer(stated: JsonValue, what: str) -> int:
    """The whole number a table states."""
    assert not isinstance(stated, bool), f"{what} is not a whole number"
    assert isinstance(stated, int), f"{what} is not a whole number"
    return stated


def number(stated: JsonValue, what: str) -> float:
    """The number a table states, whole or not."""
    assert not isinstance(stated, bool), f"{what} is not a number"
    assert isinstance(stated, int | float), f"{what} is not a number"
    return float(stated)


def vector(stated: JsonValue, what: str) -> list[float]:
    """The vector a table states: a list of numbers."""
    assert isinstance(stated, list), f"{what} is not a list"
    return [number(each, what) for each in stated]


def vectors(stated: JsonValue) -> Iterator[list[float]]:
    """Every vector stated anywhere in `stated`: each member named `embedding`."""
    if isinstance(stated, dict):
        for name, value in stated.items():
            if name == "embedding":
                yield vector(value, name)
            else:
                yield from vectors(value)
    elif isinstance(stated, list):
        for value in stated:
            yield from vectors(value)


def width_of(stated: JsonValue, what: str) -> int:
    """How wide a case's vectors are. They are all as wide as each other, and a case states at least one."""
    widths = {len(each) for each in vectors(stated)}
    assert len(widths) == 1, f"{what} states vectors of {sorted(widths)} numbers: an index holds vectors of one width"
    return next(iter(widths))


def resource(stated: JsonObject) -> ResourceId:
    """The resource a write or a read names."""
    return ResourceId(text(stated["resourceId"], "resourceId"))


def machine_read(stated: JsonObject) -> bool:
    """What a put says of how its text was read. A put that does not state `machineRead` says it was not read from pixels."""
    if "machineRead" not in stated:
        return False
    said = stated["machineRead"]
    assert isinstance(said, bool), "machineRead is neither true nor false"
    return said


def chunk(stated: JsonObject) -> EmbeddingChunk:
    """One chunk a put states."""
    only(stated, CHUNK, "a chunk")
    return EmbeddingChunk(
        chunk_index=integer(stated["index"], "index"),
        text=text(stated["text"], "text"),
        embedding=vector(stated["embedding"], "embedding"),
    )


def chunks(stated: JsonObject) -> list[EmbeddingChunk]:
    """The chunks a put states, in its order."""
    return [chunk(each) for each in objects(stated["chunks"], "chunks")]


def annotation(stated: JsonObject) -> AnnotationPayload:
    """What a put states of an annotation: everything but the vector."""
    return AnnotationPayload(
        annotation_id=AnnotationId(text(stated["annotationId"], "annotationId")),
        resource_id=resource(stated),
        motivation=text(stated["motivation"], "motivation"),
        entity_types=strings(stated["entityTypes"], "entityTypes"),
        exact_text=text(stated["text"], "text"),
        machine_read=machine_read(stated),
    )


def listed(stated: JsonObject, member: str) -> Sequence[str]:
    """The entity types a filter lists under `member`. A filter that leaves the member out lists none."""
    return strings(stated[member], member) if member in stated else ()


def named(stated: JsonObject, member: str) -> ResourceId | None:
    """The resource a filter names under `member`, or `None` for a filter that leaves the member out."""
    return ResourceId(text(stated[member], member)) if member in stated else None


def search_filter(stated: JsonObject) -> SearchFilter:
    """The filter a search states. An empty list it states is handed to the store as one."""
    only(stated, FILTER, "a filter")
    return SearchFilter(
        entity_types=listed(stated, "entityTypes"),
        exclude_entity_types=listed(stated, "excludeEntityTypes"),
        resource_id=named(stated, "resourceId"),
        exclude_resource_id=named(stated, "excludeResourceId"),
        motivation=text(stated["motivation"], "motivation") if "motivation" in stated else None,
    )


def options(stated: JsonObject) -> SearchOptions:
    """How much a search answers, and of what: its `limit`, and its `scoreThreshold` and `filter` where it states them."""
    return SearchOptions(
        limit=integer(stated["limit"], "limit"),
        score_threshold=number(stated["scoreThreshold"], "scoreThreshold") if "scoreThreshold" in stated else None,
        filter=search_filter(thing(stated["filter"], "filter")) if "filter" in stated else None,
    )


# ── Writing what a store answers as a table states it ──────────────────


def written_result(found: VectorSearchResult) -> JsonObject:
    """A result as a table states one, without its score, which is compared apart."""
    stated: JsonObject = {"resourceId": str(found.resource_id), "text": found.text}
    if found.annotation_id is not None:
        stated["annotationId"] = str(found.annotation_id)
    if found.entity_types is not None:
        types: list[JsonValue] = [*found.entity_types]
        stated["entityTypes"] = types
    if found.machine_read:
        stated["machineRead"] = True
    return stated


def written_stamp(stamp: ResourceStamp) -> JsonObject:
    """A stamp as a table states one: no checksum where there is none, and the mark only where it is set."""
    types: list[JsonValue] = [*stamp.entity_types]
    stated: JsonObject = {"entityTypes": types}
    if stamp.content_checksum is not None:
        stated["contentChecksum"] = stamp.content_checksum
    if stamp.machine_read:
        stated["machineRead"] = True
    return stated


def same_results(answered: Sequence[VectorSearchResult], stated: JsonValue, what: str) -> None:
    """Hold what a search answered to the results a table states, in the table's order.

    A score is held within the tolerance, and everything else exactly.
    """
    expected = objects(stated, what)
    unscored = [{member: value for member, value in wanted.items() if member != "score"} for wanted in expected]
    assert [written_result(found) for found in answered] == unscored, what
    for at, (found, wanted) in enumerate(zip(answered, expected, strict=True)):
        score = number(wanted["score"], "score")
        assert abs(found.score - score) <= SCORE_TOLERANCE, f"{what}: result {at} scores {found.score}, not {score}"


# ── The writes of a history ────────────────────────────────────────────


async def put_resource(store: VectorStore, stated: JsonObject) -> None:
    """Do the put a table states.

    `resourceId`, `chunks` (each `index`, `text`, `embedding`), `contentChecksum`,
    `entityTypes`, and `machineRead` where stated.
    """
    await store.upsert_resource_vectors(
        resource(stated),
        chunks(stated),
        text(stated["contentChecksum"], "contentChecksum"),
        strings(stated["entityTypes"], "entityTypes"),
        machine_read=machine_read(stated),
    )


async def put_annotation(store: VectorStore, stated: JsonObject) -> None:
    """Do the put of an annotation a table states.

    `annotationId`, `resourceId`, `motivation`, `entityTypes`, `text`, `embedding`, and
    `machineRead` where stated.
    """
    await store.upsert_annotation_vector(vector(stated["embedding"], "embedding"), annotation(stated))


async def rewrite_entity_types(store: VectorStore, stated: JsonObject) -> None:
    await store.update_resource_entity_types(resource(stated), strings(stated["entityTypes"], "entityTypes"))


async def delete_resource(store: VectorStore, stated: JsonObject) -> None:
    await store.delete_resource_vectors(resource(stated))


async def delete_annotation(store: VectorStore, stated: JsonObject) -> None:
    await store.delete_annotation_vector(AnnotationId(text(stated["annotationId"], "annotationId")))


async def delete_annotations_of_resource(store: VectorStore, stated: JsonObject) -> None:
    await store.delete_annotation_vectors_for_resource(resource(stated))


type Write = Callable[[VectorStore, JsonObject], Awaitable[None]]

WRITES: Final[dict[str, tuple[tuple[str, ...], Write]]] = {
    "resourcePut": (RESOURCE_PUT, put_resource),
    "entityTypesRewritten": (("resourceId", "entityTypes"), rewrite_entity_types),
    "annotationPut": (ANNOTATION_PUT, put_annotation),
    "resourceDeleted": (("resourceId",), delete_resource),
    "annotationDeleted": (("annotationId",), delete_annotation),
    "annotationsOfResourceDeleted": (("resourceId",), delete_annotations_of_resource),
}
"""Each kind of write a history states: the members it may have, and how it is done."""


async def write(store: VectorStore, stated: JsonObject) -> None:
    """Do one write of a history. A kind nothing here does fails, and so does a member nothing here reads."""
    kind = text(stated["write"], "write")
    assert kind in WRITES, f"{kind} is a write nothing here does"
    members, do = WRITES[kind]
    only(stated, ("write", *members), kind)
    await do(store, stated)


# ── The reads of a history ─────────────────────────────────────────────


async def resources_searched(store: VectorStore, stated: JsonObject, what: str) -> None:
    found = await store.search_resources(vector(stated["embedding"], "embedding"), options(stated))
    same_results(found, stated["answers"], what)


async def annotations_searched(store: VectorStore, stated: JsonObject, what: str) -> None:
    found = await store.search_annotations(vector(stated["embedding"], "embedding"), options(stated))
    same_results(found, stated["answers"], what)


async def searched_by_resource(store: VectorStore, stated: JsonObject, what: str) -> None:
    found = await store.search_by_resource(resource(stated), options(stated))
    same_results(found, stated["answers"], what)


async def counted(store: VectorStore, stated: JsonObject, what: str) -> None:
    assert await store.count() == stated["answers"], what


async def stamps_listed(store: VectorStore, stated: JsonObject, what: str) -> None:
    stamps = await store.list_resource_stamps()
    answered: JsonObject = {str(of): written_stamp(stamp) for of, stamp in stamps.items()}
    assert answered == stated["answers"], what


async def stamp_read(store: VectorStore, stated: JsonObject, what: str) -> None:
    found = await store.get_resource_stamp(resource(stated))
    if "answers" in stated:
        assert found is not None, what
        assert written_stamp(found) == stated["answers"], what
    else:
        # A read that states no answer is of a resource with no points.
        assert found is None, what


async def annotation_ids_listed(store: VectorStore, stated: JsonObject, what: str) -> None:
    ids = await store.list_annotation_ids()
    assert sorted(str(each) for each in ids) == sorted(strings(stated["answers"], "answers")), what


type Read = Callable[[VectorStore, JsonObject, str], Awaitable[None]]

READS: Final[dict[str, tuple[tuple[str, ...], Read]]] = {
    "resourcesSearched": (("embedding", *SEARCH), resources_searched),
    "annotationsSearched": (("embedding", *SEARCH), annotations_searched),
    "searchedByResource": (("resourceId", *SEARCH), searched_by_resource),
    "counted": (("answers",), counted),
    "stampsListed": (("answers",), stamps_listed),
    "stampRead": (("resourceId", "answers"), stamp_read),
    "annotationIdsListed": (("answers",), annotation_ids_listed),
}
"""Each kind of read a history states: the members it may have, and how the store is held to what it answers."""


async def answer(store: VectorStore, stated: JsonObject, what: str) -> None:
    """Make one read of a history, and hold the store to what the table says it answers."""
    kind = text(stated["read"], "read")
    assert kind in READS, f"{kind} is a read nothing here makes"
    members, make = READS[kind]
    only(stated, ("read", *members), kind)
    await make(store, stated, f"{what}, {kind}")


type Scenario = Callable[[VectorStore], Awaitable[None]]


class StoreContract(ABC):
    """Every store is held to both tables through this: a subclass says how to make an empty one."""

    @abstractmethod
    async def empty(self, width: int) -> VectorStore:
        """A store that holds nothing, connected, for vectors of `width` numbers. The contract disconnects it."""

    def held(self, width: int, scenario: Scenario) -> None:
        """Run `scenario` against a store that holds nothing, and disconnect the store whatever comes of it."""

        async def whole() -> None:
            store = await self.empty(width)
            try:
                await scenario(store)
            finally:
                await store.disconnect()

        run(whole())

    def test_the_tables_state_every_kind_of_write_and_read_and_both_stored_parts(self) -> None:
        # A kind nothing here does fails the history that states it. This holds the other way: nothing here goes unrun.
        writes = {text(given["write"], "write") for case in STORE_CASES for given in objects(case["writes"], "writes")}
        reads = {text(given["read"], "read") for case in STORE_CASES for given in objects(case["reads"], "reads")}
        assert writes == set(WRITES)
        assert reads == set(READS)
        assert part("resourceStored") != []
        assert part("annotationStored") != []

    @pytest.mark.parametrize("case", histories())
    def test_a_history_of_writes_and_what_each_read_then_answers(self, case: JsonObject) -> None:
        only(case, ("why", "writes", "reads"), "a history")

        async def scenario(store: VectorStore) -> None:
            for given in objects(case["writes"], "writes"):
                await write(store, given)
            for at, given in enumerate(objects(case["reads"], "reads")):
                await answer(store, given, f"read {at}")

        self.held(width_of(case, "a history"), scenario)

    @pytest.mark.parametrize("given", part("resourceStored"))
    def test_a_resources_chunks_stored_are_answered_as_the_payload_table_states(self, given: JsonObject) -> None:
        only(given, RESOURCE_STORED, "resourceStored")
        resource_id = resource(given)
        points = objects(given["points"], "points")

        async def scenario(store: VectorStore) -> None:
            await put_resource(store, given)

            assert await store.count() == len(points)
            stamp = await store.get_resource_stamp(resource_id)
            assert stamp is not None
            assert written_stamp(stamp) == given["stamp"]
            assert await store.list_resource_stamps() == {resource_id: stamp}
            # One point for each chunk, in the chunks' order, and each found by a search with its own embedding.
            for stored, point in zip(chunks(given), points, strict=True):
                only(point, POINT, "a point")
                found = await store.search_resources(stored.embedding, SearchOptions(limit=1))
                same_results(found, [point["result"]], f"the point of chunk {stored.chunk_index}")

        self.held(width_of(given, "resourceStored"), scenario)

    @pytest.mark.parametrize("given", part("annotationStored"))
    def test_an_annotation_stored_is_answered_as_the_payload_table_states(self, given: JsonObject) -> None:
        only(given, ANNOTATION_STORED, "annotationStored")
        point = thing(given["point"], "point")
        only(point, POINT, "the point")
        stated = annotation(given)

        async def scenario(store: VectorStore) -> None:
            await put_annotation(store, given)

            assert await store.list_annotation_ids() == {stated.annotation_id}
            # A result does not say an annotation's motivation: a search that filters on it shows it was kept.
            of_its_motivation = SearchOptions(limit=1, filter=SearchFilter(motivation=stated.motivation))
            found = await store.search_annotations(vector(given["embedding"], "embedding"), of_its_motivation)
            same_results(found, [point["result"]], "the annotation's point")

        self.held(width_of(given, "annotationStored"), scenario)
