"""A reference search, held to `specs/src/librarian/score-cases.json`.

It is the table every Librarian runs, so that the candidates a search
answers, their scores and their reasons are stated once and not once for each
language. A case is run through `search`, and through nothing else of the
Librarian: there is no bus here. The graph, the views, the index and the
model of a case answer what the case states and nothing else, and the moment
the search is made at is the case's, handed to it: recency is counted from
it, and no clock is read.

What each source was asked is held to the case too. A source the case does
not state must not have been asked.

The request and each resource are read as the SDK's types read them, so the
table cannot state an object the bus could not carry. A member of the table
or of a case that nothing here reads fails.
"""

import asyncio
import re
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from datetime import datetime
from typing import Final, final, override

import pytest
from aio import run
from rig import FakeEmbedding, FakeInference, FakeVectors, view
from semiont.identifiers import ResourceId
from semiont.model import written
from semiont.types import Annotation, MatchSearchRequest, MatchSearchResult, Motivation, ResourceDescriptor, ResourceView
from semiont_graph.interface import EntityTypeCount, GraphConnection, ResourceListing, ResourceQuery
from semiont_vectors.store import SearchOptions, VectorSearchResult
from spec import ROOT, JsonObject, number, objects, only, read, strings, text, thing, why

from semiont_librarian.reads import GraphReads, Views
from semiont_librarian.reference_search import search

TABLE = read(ROOT / "specs/src/librarian/score-cases.json")
CASES = objects(TABLE["cases"], "cases")
ANSWERED = [case for case in CASES if "results" in case]
FAILED = [case for case in CASES if "results" not in case]

# Every member each thing the table states may have. A member that is none of these is one nothing here would read.
TABLE_MEMBERS = ("$comment", "cases")
CASE_MEMBERS = ("why", "now", "request", "resources", "graph", "views", "vectors", "model", "term", "results", "failed")
GRAPH_MEMBERS = ("byName", "byEntityType", "byId")
VECTORS_MEMBERS = ("hits", "fails")
HIT_MEMBERS = ("resourceId", "score")
MODEL_MEMBERS = ("shown", "reply", "fails")
RESULT_MEMBERS = ("id", "score", "matchReason")

HELD: Final = "held"
ABSENT: Final = "absent"
FAILS: Final = "fails"

LISTED: Final = re.compile(r'^\d+\. ".*" \(id: (.+), types: .*\)$', re.MULTILINE)
"""A candidate's line of a score prompt, and in it the candidate's id."""


def moment_of(case: JsonObject) -> datetime:
    """The moment a case's search is made at."""
    moment = datetime.fromisoformat(text(case["now"], "now"))
    assert moment.tzinfo is not None, f"{why(case)}: `now` states no offset"
    return moment


def request_of(case: JsonObject) -> MatchSearchRequest:
    return MatchSearchRequest.model_validate(case["request"])


def described_in(case: JsonObject) -> dict[str, JsonObject]:
    """Each resource a case describes, by its id, as the case words it."""
    return {text(resource["@id"], "@id"): resource for resource in objects(case["resources"], "resources")}


def graph_of(case: JsonObject) -> JsonObject:
    stated = thing(case["graph"], "graph")
    only(stated, GRAPH_MEMBERS, "a case's graph")
    return stated


def states(stated: JsonObject, member: str, what: str) -> dict[str, str]:
    """What a case states of each id a store is asked for, where it states any: `held`, `absent` or `fails`."""
    if member not in stated:
        return {}
    said = {asked: text(answer, what) for asked, answer in thing(stated[member], what).items()}
    assert set(said.values()) <= {HELD, ABSENT, FAILS}, what
    return said


# ── The sources of a case ─────────────────────────────────────────────


@final
class Unstated(Exception):
    """A source was asked what its case states no answer of."""


@final
class Fails(Exception):
    """A source fails, as its case states it does."""


@final
class StatedGraph(GraphReads):
    """The graph of a case. `by_name` and `by_entity_type` are what each listing was asked, and `read` every id read back."""

    def __init__(self, stated: JsonObject, described: Mapping[str, JsonObject]) -> None:
        self._stated: Final = stated
        self._described: Final = described
        self._by_id: Final = states(stated, "byId", "byId")
        self.by_name: Final[list[ResourceQuery]] = []
        self.by_entity_type: Final[list[ResourceQuery]] = []
        self.read: Final[list[str]] = []

    def _description(self, resource: str) -> ResourceDescriptor:
        assert resource in self._described, f"the case names {resource}, which its resources do not describe"
        return ResourceDescriptor.model_validate(self._described[resource])

    @override
    async def list_resources(self, query: ResourceQuery) -> ResourceListing:
        # The two listings are one read, told apart by the query: the listing by name is the one asked with a
        # search term, whatever the term is.
        by_name = query.search is not None
        (self.by_name if by_name else self.by_entity_type).append(query)
        await asyncio.sleep(0)
        member = "byName" if by_name else "byEntityType"
        if member not in self._stated:
            raise Unstated(f"the graph's listing was asked, and the case states no `{member}`")
        listing = self._stated[member]
        if isinstance(listing, dict):
            only(listing, (FAILS,), member)
            raise Fails(text(listing[FAILS], "fails"))
        resources = [self._description(resource) for resource in strings(listing, member)]
        return ResourceListing(resources=resources, total=len(resources))

    @override
    async def get_resource(self, resource_id: ResourceId) -> ResourceDescriptor | None:
        self.read.append(resource_id)
        await asyncio.sleep(0)
        answer = self._by_id.get(resource_id, ABSENT)
        if answer == FAILS:
            raise Fails("the read of the graph failed")
        return self._description(resource_id) if answer == HELD else None

    @override
    async def get_resource_annotations(self, resource_id: ResourceId) -> list[Annotation]:
        raise Unstated(f"the annotations on {resource_id}")

    @override
    async def get_resource_referenced_by(self, resource_id: ResourceId, motivation: Motivation | None) -> list[Annotation]:
        raise Unstated(f"what refers to {resource_id}")

    @override
    async def get_resource_connections(self, resource_id: ResourceId) -> list[GraphConnection]:
        raise Unstated(f"the connections of {resource_id}")

    @override
    async def get_entity_type_stats(self) -> list[EntityTypeCount]:
        raise Unstated("the counts of entity types")


@final
class StatedViews(Views):
    """The views of a case. `asked` is every id a view was asked for."""

    def __init__(self, stated: Mapping[str, str], described: Mapping[str, JsonObject]) -> None:
        assert FAILS not in stated.values(), "a case states a view that fails, and no rule says what follows"
        self._stated: Final = stated
        self._described: Final = described
        self.asked: Final[list[str]] = []

    @override
    async def get(self, resource_id: ResourceId) -> ResourceView | None:
        self.asked.append(resource_id)
        await asyncio.sleep(0)
        if self._stated.get(resource_id) != HELD:
            return None
        # A view is its resource and what the Archivist keeps beside it, which a reference search does not read.
        return view(ResourceDescriptor.model_validate(self._described[resource_id]))


@final
@dataclass(frozen=True, slots=True)
class World:
    """The sources of one case: each answers what the case states, and keeps what it was asked."""

    graph: StatedGraph
    views: StatedViews
    vectors: FakeVectors
    embedding: FakeEmbedding
    inference: FakeInference


def hit_of(stated: JsonObject) -> VectorSearchResult:
    """A hit a case states, as the index answers one: a chunk of a resource. The search reads whose it is, and its score."""
    only(stated, HIT_MEMBERS, "a hit")
    resource = ResourceId(text(stated["resourceId"], "resourceId"))
    return VectorSearchResult(score=number(stated["score"], "score"), resource_id=resource, text="")


def world_of(case: JsonObject) -> World:
    described = described_in(case)
    vectors, inference = FakeVectors(), FakeInference()

    if "vectors" in case:
        index = thing(case["vectors"], "vectors")
        only(index, VECTORS_MEMBERS, "a case's vectors")
        if FAILS in index:
            assert index[FAILS] is True
            assert "hits" not in index
            vectors.failing["search_resources"] = Fails("the vector index failed")
        else:
            vectors.stated["search_resources"] = [hit_of(stated) for stated in objects(index["hits"], "hits")]
    else:
        vectors.failing["search_resources"] = Unstated("the vector index was asked, and the case states no answer of it")

    if "model" in case:
        model = thing(case["model"], "model")
        only(model, MODEL_MEMBERS, "a case's model")
        if FAILS in model:
            assert model[FAILS] is True
            assert "reply" not in model
            inference.failing = Fails("the model failed")
        else:
            inference.say(text(model["reply"], "reply"))
    else:
        inference.failing = Unstated("the model was asked, and the case states no answer of it")

    return World(
        graph=StatedGraph(graph_of(case), described),
        views=StatedViews(states(case, "views", "views"), described),
        vectors=vectors,
        embedding=FakeEmbedding(),
        inference=inference,
    )


async def searched(case: JsonObject, world: World) -> MatchSearchResult:
    """A case's search, made of the case's world at the case's moment."""
    moment = moment_of(case)
    return await search(
        request_of(case),
        graph=world.graph,
        views=world.views,
        vectors=world.vectors,
        embedding=world.embedding,
        inference=world.inference,
        now=lambda: moment,
    )


def failure_of(case: JsonObject, world: World) -> str:
    """The words a case's search fails with."""
    try:
        run(searched(case, world))
    except Exception as failure:
        return str(failure)
    raise AssertionError(f"{why(case)}: the search answered")


def candidate(described: Mapping[str, JsonObject], result: JsonObject) -> JsonObject:
    """A candidate as a reply carries it: its resource's description, with the score and the reason the case states."""
    only(result, RESULT_MEMBERS, "a result")
    return {
        **described[text(result["id"], "id")],
        "score": number(result["score"], "score"),
        "matchReason": text(result["matchReason"], "matchReason"),
    }


def shown_in(prompt: str) -> list[str]:
    """The ids of the candidates a score prompt lists, in the order it numbers them."""
    return LISTED.findall(prompt)


def each_once(asked: Iterable[str]) -> list[str]:
    return sorted(set(asked))


# ── The table ─────────────────────────────────────────────────────────


def test_the_runner_found_the_table_s_cases() -> None:
    only(TABLE, TABLE_MEMBERS, "the table")
    assert len(CASES) >= 34
    assert len(ANSWERED) + len(FAILED) == len(CASES)


def test_each_case_is_told_from_the_others_by_its_why() -> None:
    assert len({why(case) for case in CASES}) == len(CASES)


def test_each_case_states_an_answer_or_a_failure_and_not_both_and_nothing_this_runner_does_not_read() -> None:
    for case in CASES:
        only(case, CASE_MEMBERS, why(case))
        assert ("results" in case) != ("failed" in case), why(case)
        moment_of(case)
        request_of(case)
        world_of(case)


def test_the_table_has_a_case_of_each_source_failing_or_not_asked_of_the_model_in_each_way_of_a_view_read_and_of_a_limit() -> None:
    def by_id(case: JsonObject) -> Iterable[str]:
        return states(graph_of(case), "byId", "byId").values()

    def of_views(case: JsonObject) -> Iterable[str]:
        return states(case, "views", "views").values()

    def index(case: JsonObject) -> JsonObject:
        return thing(case["vectors"], "vectors") if "vectors" in case else {}

    def hits(case: JsonObject) -> int:
        return len(objects(index(case)["hits"], "hits")) if "hits" in index(case) else 0

    def model(case: JsonObject) -> JsonObject:
        return thing(case["model"], "model") if "model" in case else {}

    def shown(case: JsonObject) -> int:
        return len(strings(model(case)["shown"], "shown")) if "shown" in model(case) else 0

    assert FAILED
    assert any("vectors" not in case for case in ANSWERED)
    assert any(FAILS in index(case) for case in CASES)
    assert any(hits(case) > 0 for case in CASES)
    assert any("byEntityType" in graph_of(case) for case in CASES)
    assert any(FAILS in by_id(case) for case in CASES)
    assert any(HELD in of_views(case) for case in CASES)
    assert any(ABSENT in of_views(case) for case in CASES)
    assert any("reply" in model(case) for case in CASES)
    assert any(FAILS in model(case) for case in CASES)
    assert any(shown(case) == 20 for case in CASES)
    assert any(request_of(case).use_semantic_scoring is False for case in CASES)
    assert any(request_of(case).limit is not None for case in CASES)


@pytest.mark.parametrize("case", ANSWERED, ids=why)
def test_a_reference_search_answers_the_candidates_the_table_states_and_asks_each_source_what_the_table_states(case: JsonObject) -> None:
    world = world_of(case)
    request = request_of(case)
    described = described_in(case)

    reply = written(run(searched(case, world)))

    assert sorted(reply) == ["referenceId", "response"], why(case)
    assert reply["referenceId"] == request.reference_id, why(case)
    assert reply["response"] == [candidate(described, result) for result in objects(case["results"], "results")], why(case)

    # What each source was asked.
    term = text(case["term"], "term")
    graph = graph_of(case)
    by_entity_type = [ResourceQuery(entity_types=request.context.metadata.entity_types or [], limit=50)]
    assert world.graph.by_name == [ResourceQuery(search=term, limit=20)], why(case)
    assert world.graph.by_entity_type == (by_entity_type if "byEntityType" in graph else []), why(case)
    assert each_once(world.graph.read) == sorted(states(graph, "byId", "byId")), why(case)
    assert each_once(world.views.asked) == sorted(states(case, "views", "views")), why(case)
    assert world.embedding.asked == ([term] if "vectors" in case else []), why(case)
    index_asked = [(read, options) for read, _, options in world.vectors.asked]
    assert index_asked == ([("search_resources", SearchOptions(limit=40, score_threshold=0.4))] if "vectors" in case else []), why(case)
    shown = [strings(thing(case["model"], "model")["shown"], "shown")] if "model" in case else []
    assert [shown_in(asked.prompt) for asked in world.inference.asked] == shown, why(case)


@pytest.mark.parametrize("case", FAILED, ids=why)
def test_a_reference_search_fails_with_the_words_the_table_states_and_asks_no_source_the_table_does_not_state(case: JsonObject) -> None:
    world = world_of(case)

    assert failure_of(case, world) == text(case["failed"], "failed"), why(case)

    graph = graph_of(case)
    if "byName" not in graph:
        assert world.graph.by_name == [], why(case)
    if "byEntityType" not in graph:
        assert world.graph.by_entity_type == [], why(case)
    if "byId" not in graph:
        assert world.graph.read == [], why(case)
    if "views" not in case:
        assert world.views.asked == [], why(case)
    if "vectors" not in case:
        assert world.embedding.asked == [], why(case)
        assert world.vectors.asked == [], why(case)
    if "model" not in case:
        assert world.inference.asked == [], why(case)
