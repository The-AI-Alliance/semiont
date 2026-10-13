"""A reference search, where `specs/src/librarian/score-cases.json` holds none of it.

The table states what a search answers (`test_score_cases.py`). Here is what
no case of it rests on: the half a score is rounded at, a date that is no
date, a frequency below 0, a limit below 0, which item of a body the model is
shown, what is logged when a candidate is described from its view, a provider
and a listing by entity type that fail, the characters a blank term is made
of, and a description that has more members than the protocol names. The rules are those of
`docs/protocol/LIBRARIAN.md` § Reference search and § The score.
"""

import logging
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Final, final

import pytest
from aio import run
from pydantic import JsonValue
from rig import ADA, LOVELACE, FakeEmbedding, FakeGraph, FakeInference, FakePeople, FakeVectors, FakeViews, described, tag, view
from semiont.identifiers import ResourceId
from semiont.model import written
from semiont.types import MatchSearchRequest, MatchSearchResult, ResourceDescriptor
from semiont_graph.interface import ResourceListing, ResourceQuery
from semiont_vectors.store import CollectionAbsent, VectorSearchResult
from spec import JsonObject, objects

from semiont_librarian.limit import LimitRefused
from semiont_librarian.reference_search import search
from semiont_librarian.score import rounded, score_of
from semiont_librarian.views import GraphViews

NOW: Final = datetime(2026, 3, 31, tzinfo=UTC)
"""The moment every search here is made at."""

MADE: Final = "2025-06-01T00:00:00.000Z"
"""When every resource here was made: long enough before `NOW` that recency adds nothing."""

MAIN: Final = "res-main"
ROCK: Final = ResourceId("res-rock")
FORT: Final = ResourceId("res-fort")


def request(
    selected: str = "Black Hawk",
    *,
    neighbours: tuple[str, ...] = (),
    entity_types: tuple[str, ...] = (),
    scored_by_a_model: bool = False,
    motivation: str = "linking",
    body: JsonValue = None,
) -> MatchSearchRequest:
    """A request to search for a reference on `MAIN` that selects `selected`, with no model asked unless `scored_by_a_model`.

    The context's graph connects `MAIN` to each of `neighbours`, one way.
    The annotation has `motivation`, and `body` where one is given.
    """
    nodes = [{"id": resource, "type": "resource", "label": resource} for resource in (MAIN, *neighbours)]
    edges = [{"source": MAIN, "target": resource, "type": "link"} for resource in neighbours]
    metadata = {"entityTypes": [*entity_types]} if entity_types else {}
    return MatchSearchRequest.model_validate(
        {
            "resourceId": MAIN,
            "referenceId": "ann-ref",
            "useSemanticScoring": scored_by_a_model,
            "context": {
                "focus": {
                    "kind": "annotation",
                    "annotation": {
                        "@context": "http://www.w3.org/ns/anno.jsonld",
                        "type": "Annotation",
                        "id": "ann-ref",
                        "motivation": motivation,
                        "target": {"source": MAIN},
                        "created": MADE,
                        **({} if body is None else {"body": body}),
                    },
                    "sourceResource": {"@context": "https://schema.org/", "@id": MAIN, "name": "Sauk history", "representations": []},
                    "selected": {"text": selected},
                },
                "graph": {"nodes": nodes, "edges": edges},
                "metadata": metadata,
            },
        }
    )


@final
@dataclass(frozen=True, slots=True)
class World:
    """What a search is handed: a fake of each source.

    The graph lists nothing, by name or by entity type, and the index
    answers no hits, until a test states otherwise.
    """

    graph: FakeGraph = field(default_factory=FakeGraph)
    views: FakeViews = field(default_factory=FakeViews)
    vectors: FakeVectors = field(default_factory=FakeVectors)
    embedding: FakeEmbedding = field(default_factory=FakeEmbedding)
    inference: FakeInference = field(default_factory=FakeInference)
    people: FakePeople = field(default_factory=FakePeople)

    def __post_init__(self) -> None:
        self.graph.listing = lambda query: ResourceListing(resources=[], total=0)
        self.vectors.stated["search_resources"] = []

    async def search(self, asked: MatchSearchRequest) -> MatchSearchResult:
        return await search(
            asked,
            graph=self.graph,
            views=self.views,
            vectors=self.vectors,
            embedding=self.embedding,
            inference=self.inference,
            people=self.people,
            now=lambda: NOW,
        )


def hit(resource: ResourceId, score: float) -> VectorSearchResult:
    """A hit of the vector index: a chunk of a resource, and its score."""
    return VectorSearchResult(score=score, resource_id=resource, text="")


def answered(reply: MatchSearchResult) -> list[tuple[str, float | None, str | None]]:
    """A reply's candidates, each as its id, its score and its reason."""
    return [(each.id, each.score, each.match_reason) for each in reply.response]


def graph_lag(caplog: pytest.LogCaptureFixture) -> list[tuple[str, object]]:
    """Each line the Librarian logged, for information, of a candidate described from its view: its words, and how many it counts."""
    return [
        (record.getMessage(), vars(record)["count"])
        for record in caplog.records
        if record.name == "semiont_librarian" and record.levelno == logging.INFO and record.getMessage().startswith("[graph lag]")
    ]


# ── The score ─────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("score", "to_two_decimals"),
    [(0.125, 0.13), (0.375, 0.38), (2.5, 2.5), (31.249, 31.25), (31.244, 31.24), (0.0, 0.0)],
    ids=["a half Python's own rounding sends down", "a half it sends up", "one decimal", "above a half", "below a half", "nothing"],
)
def test_a_score_is_rounded_to_two_decimals_and_a_half_goes_up(score: float, to_two_decimals: float) -> None:
    assert rounded(score) == to_two_decimals


def test_python_s_own_rounding_sends_a_half_to_the_even_digit_which_is_why_a_score_is_not_rounded_by_it() -> None:
    assert round(0.125, 2) == 0.12
    assert rounded(0.125) == 0.13


def scored(candidate: ResourceDescriptor, entity_types: tuple[str, ...], frequencies: dict[str, int]) -> tuple[float, str]:
    """The score and the reason of a candidate found by name alone, for the term `Black Hawk`, at `NOW`."""
    score = score_of(
        candidate,
        term="Black Hawk",
        entity_types=entity_types,
        entity_type_frequencies=frequencies,
        views=GraphViews(connections=(), cited_by=(), sibling_entity_types=()),
        sources={"name"},
        vector_score=None,
        moment=NOW,
    )
    return score.points, score.reason


def test_recency_adds_nothing_to_a_resource_whose_date_is_no_date() -> None:
    # A description's `dateCreated` is a date by its schema, which a reader of JSON does not hold it to.
    assert scored(described(ROCK, dateCreated="last spring"), (), {}) == (0.0, "candidate")


def test_an_entity_type_whose_stated_frequency_is_below_0_counts_as_seen_once() -> None:
    person = described(ROCK, dateCreated=MADE, entityTypes=["Person"])

    assert scored(person, ("Person",), {"Person": -3}) == (35.0, "entity types: Person")


# ── Reference search ──────────────────────────────────────────────────


@pytest.mark.parametrize("limit", [0, -1], ids=["none", "fewer than none"])
def test_a_limit_below_1_is_refused_and_no_source_is_asked(limit: int) -> None:
    world = World()
    # Stated as a caller that does not hold its request to the schema states it: the schema refuses such a limit too.
    asked = request().model_copy(update={"limit": limit})

    with pytest.raises(LimitRefused, match=r"^limit must be at least 1$"):
        run(world.search(asked))

    assert world.graph.asked == []
    assert world.embedding.asked == []
    assert world.vectors.asked == []


def says(value: str, purpose: str) -> JsonObject:
    """A body item that says `value`, for `purpose`."""
    return {"type": "TextualBody", "value": value, "purpose": purpose}


def test_the_people_of_a_reply_are_named_as_the_projection_holds_them_and_it_is_read_once() -> None:
    world = World(people=FakePeople(LOVELACE))
    world.graph.resources[ROCK] = described(ROCK, dateCreated=MADE, wasAttributedTo=[ADA])

    reply = run(world.search(request(neighbours=(ROCK,))))

    (candidate,) = objects(written(reply)["response"], "response")
    assert candidate["wasAttributedTo"] == [{**ADA, "name": "Ada Lovelace"}]
    assert world.people.reads == 1


def body_line(prompt: str) -> list[str]:
    """The line of a score prompt that says what the annotation says, where it has one."""
    return [line for line in prompt.splitlines() if line.startswith(("Comment: ", "Assessment: "))]


@pytest.mark.parametrize(
    ("motivation", "body", "line"),
    [
        ("commenting", [tag("Person"), says("He led the band.", "commenting")], ["Comment: He led the band."]),
        ("assessing", [tag("Person"), says("The date is wrong.", "assessing")], ["Assessment: The date is wrong."]),
        ("commenting", says("He led the band.", "commenting"), ["Comment: He led the band."]),
        ("commenting", [tag("Person")], []),
        ("commenting", {"type": "TextualBody", "value": "He led the band."}, []),
    ],
    ids=["a comment after a tag", "an assessment after a tag", "a body that is one item", "a tag alone", "an item that states no purpose"],
)
def test_the_model_is_shown_the_first_item_of_a_body_whose_purpose_is_commenting_or_assessing(
    motivation: str, body: JsonValue, line: list[str]
) -> None:
    world = World()
    world.graph.resources[ROCK] = described(ROCK, dateCreated=MADE)

    run(world.search(request(neighbours=(ROCK,), scored_by_a_model=True, motivation=motivation, body=body)))

    assert [body_line(asked.prompt) for asked in world.inference.asked] == [line]


def test_a_neighbour_described_from_its_view_is_logged_with_how_many_were(caplog: pytest.LogCaptureFixture) -> None:
    # Two neighbours: the graph holds one, and only the views hold the other.
    world = World()
    world.graph.resources[ROCK] = described(ROCK, dateCreated=MADE)
    world.graph.resources[FORT] = None
    world.views.held[FORT] = view(described(FORT, dateCreated=MADE))

    with caplog.at_level(logging.INFO, logger="semiont_librarian"):
        reply = run(world.search(request(neighbours=(ROCK, FORT))))

    assert answered(reply) == [(ROCK, 10.0, "connected"), (FORT, 10.0, "connected")]
    assert graph_lag(caplog) == [("[graph lag] neighborhood candidates hydrated from view", 1)]


def test_a_vector_hit_described_from_its_view_is_logged_with_how_many_were(caplog: pytest.LogCaptureFixture) -> None:
    world = World()
    world.graph.resources[ROCK] = None
    world.graph.resources[FORT] = None
    world.views.held[ROCK] = view(described(ROCK, dateCreated=MADE))
    world.views.held[FORT] = view(described(FORT, dateCreated=MADE))
    world.vectors.stated["search_resources"] = [hit(ROCK, 0.8), hit(FORT, 0.6)]

    with caplog.at_level(logging.INFO, logger="semiont_librarian"):
        reply = run(world.search(request()))

    assert answered(reply) == [(ROCK, 20.0, "semantic similarity"), (FORT, 15.0, "semantic similarity")]
    assert graph_lag(caplog) == [("[graph lag] semantic candidates hydrated from view", 2)]


def test_a_candidate_whose_view_cannot_be_read_is_left_out_and_the_search_is_answered_with_the_others() -> None:
    # Neither the graph nor a view that can be read holds the rock: the fort is a candidate all the same.
    world = World()
    world.graph.resources[ROCK] = None
    world.graph.resources[FORT] = described(FORT, dateCreated=MADE)
    world.views.held[ROCK] = view(described(ROCK, dateCreated=MADE))
    world.views.unread.add(ROCK)
    world.vectors.stated["search_resources"] = [hit(ROCK, 0.8)]

    reply = run(world.search(request(neighbours=(ROCK, FORT))))

    assert answered(reply) == [(FORT, 10.0, "connected")]


def test_nothing_is_logged_of_the_graph_being_behind_when_it_holds_every_candidate(caplog: pytest.LogCaptureFixture) -> None:
    world = World()
    world.graph.resources[ROCK] = described(ROCK, dateCreated=MADE)
    world.graph.resources[FORT] = described(FORT, dateCreated=MADE)
    world.vectors.stated["search_resources"] = [hit(FORT, 0.6)]

    with caplog.at_level(logging.INFO, logger="semiont_librarian"):
        run(world.search(request(neighbours=(ROCK,))))

    assert graph_lag(caplog) == []


def test_an_index_with_no_such_collection_fails_the_search() -> None:
    world = World()
    world.graph.resources[ROCK] = described(ROCK, dateCreated=MADE)
    world.vectors.failing["search_resources"] = CollectionAbsent("Qdrant has no such collection: no store has made it yet")

    with pytest.raises(CollectionAbsent, match=r"no such collection"):
        run(world.search(request(neighbours=(ROCK,))))


def test_an_embedding_that_fails_has_answered_no_hits_and_the_search_goes_on_with_the_other_sources() -> None:
    world = World()
    world.graph.resources[ROCK] = described(ROCK, dateCreated=MADE)
    world.embedding.failing = RuntimeError("the provider is not reachable")
    world.vectors.stated["search_resources"] = [hit(FORT, 0.9)]

    reply = run(world.search(request(neighbours=(ROCK,))))

    assert answered(reply) == [(ROCK, 10.0, "connected")]
    assert world.embedding.asked == ["Black Hawk"]
    assert world.vectors.asked == []


def test_a_listing_by_entity_type_that_fails_fails_the_search_with_the_failure_s_words() -> None:
    world = World()

    def listing(query: ResourceQuery) -> ResourceListing:
        if query.search is None:
            raise RuntimeError("the graph is not reachable")
        return ResourceListing(resources=[], total=0)

    world.graph.listing = listing

    with pytest.raises(RuntimeError, match=r"^the graph is not reachable$"):
        run(world.search(request(entity_types=("Person",))))


# The next line (U+0085) and the ideographic space (U+3000) have Unicode's White_Space property. The byte order
# mark (U+FEFF) and the unit separator (U+001F) do not have it, though a language's own trimming may drop either.
@pytest.mark.parametrize(
    ("selected", "is_blank"),
    [("\u0085", True), ("\u3000\t\u0085", True), ("\ufeff", False), ("\x1f", False)],
    ids=["the next line", "an ideographic space, a tab and the next line", "the byte order mark", "a unit separator"],
)
def test_a_term_is_blank_when_it_is_unicode_s_white_space_alone_and_the_index_is_asked_of_any_other(selected: str, is_blank: bool) -> None:
    world = World()

    run(world.search(request(selected)))

    # The listing by name is asked with the term, whatever the term is.
    assert world.graph.asked_of("list_resources") == [ResourceQuery(search=selected, limit=20)]
    assert world.embedding.asked == ([] if is_blank else [selected])
    assert len(world.vectors.asked) == (0 if is_blank else 1)


def test_a_candidate_carries_every_member_of_its_description_and_says_nothing_its_description_did_not() -> None:
    # A description may have members the protocol does not name. Each is answered as it was read.
    stated: JsonObject = {
        "@context": "https://schema.org/",
        "@id": ROCK,
        "name": "Rock Island",
        "representations": [{"mediaType": "text/markdown", "checksum": "sha256:res-rock", "rel": "original"}],
        "dateCreated": MADE,
        "ex:surveyed": {"by": "Lee", "year": 1837},
    }
    world = World()
    world.graph.listing = lambda query: ResourceListing(resources=[ResourceDescriptor.model_validate(stated)], total=1)

    reply = run(world.search(request()))

    assert written(reply) == {"referenceId": "ann-ref", "response": [{**stated, "score": 0.0, "matchReason": "candidate"}]}
