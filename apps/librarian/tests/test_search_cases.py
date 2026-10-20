"""Searching resources by text, held to `specs/src/librarian/search-cases.json`.

It is the table every Librarian runs, so that what a search asks of each
store, the page it answers and what a preview is are stated once and not
once for each language. A case has one of two parts. A `search` case is run
through `search_resources`, and a `preview` case through `with_previews`.

Each store of a `search` case answers what the case states, and keeps what
it was asked. A store the case does not state fails when it is asked, and
what each store was asked is compared with what the case states it is asked:
a search that asks more, or less, fails. The graph, the record and the
embedding provider are stores of this file's own, since a case states them
resource by resource and vector by vector. The record answers a case's views.

A member of the table or of a case that nothing here reads fails.

After the table's cases comes what no case of it rests on: the reply to
`match:resources-requested`, white space about which the trimming a language
is born with disagrees, a cut that counts code points, and what a search
logs.
"""

import asyncio
import logging
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Final, final, override

import pytest
from aio import run
from pydantic import JsonValue
from rig import ADA, ADA_ID, LOVELACE, FakeContent, FakeEmbedding, FakeGraph, FakePeople, FakeRecord, FakeVectors, described, view
from semiont.identifiers import AnnotationId, ResourceId
from semiont.model import written
from semiont.types import (
    Annotation,
    MatchResourcesRequest,
    MatchResourcesResult,
    Motivation,
    ResourceDescriptor,
    ResourceView,
)
from semiont_graph.interface import EntityTypeCount, GraphConnection, ResourceListing, ResourceQuery
from semiont_service.content import Content
from semiont_vectors.embedding import EmbeddingProvider
from semiont_vectors.store import CollectionAbsent, SearchFilter, SearchOptions, VectorSearchResult
from spec import ROOT, JsonObject, number, objects, only, read, strings, text, thing, whole, why

from semiont_librarian.limit import LimitRefused
from semiont_librarian.reads import Described, GraphReads, PeopleUnread, Record
from semiont_librarian.text_search import Page, answer, search_resources, with_previews

TABLE = read(ROOT / "specs/src/librarian/search-cases.json")
CASES = objects(TABLE["cases"], "cases")
SEARCHES = [thing(case["search"], "search") | {"why": case["why"]} for case in CASES if "search" in case]
PREVIEWS = [thing(case["preview"], "preview") | {"why": case["why"]} for case in CASES if "preview" in case]

# Every member each thing the table states may have. A member that is none of these is one nothing here would read.
TABLE_MEMBERS = ("$comment", "cases")
CASE_MEMBERS = ("why", "search", "preview")
SEARCH_MEMBERS = ("why", "filters", "semanticFloor", "graph", "embedding", "index", "hydrated", "page", "fails")
PREVIEW_MEMBERS = ("why", "resources", "served", "previews")
STORE_MEMBERS = ("asked", "answers", "fails")
ASKED_OF_THE_GRAPH = ("search", "archived", "entityTypes", "offset", "limit")
ASKED_OF_THE_INDEX = ("embedding", "limit", "entityTypes")
LISTING_MEMBERS = ("resources", "total")
HIT_MEMBERS = ("id", "resourceId", "score", "text")
HYDRATED_MEMBERS = ("resource", "graph", "view")
READ_BACK_MEMBERS = ("answers", "fails")
PAGE_MEMBERS = ("resources", "total", "matchKind")
SERVED_MEMBERS = ("text", "contentType", "fails")

R1: Final = ResourceId("res-a")
R2: Final = ResourceId("res-b")

TEXT_FILE: Final[JsonObject] = {"mediaType": "text/plain", "storageUri": "file://a-text.txt", "rel": "original"}
"""A representation whose bytes are its text."""

DISTRIBUTION = "Semantic score distribution of a text search"
"""The line a search answered by meaning logs of its scores."""


# ── The stores of a case ──────────────────────────────────────────────


@final
class Unstated(Exception):
    """A store was asked what its case states no answer of."""


@final
class Fails(Exception):
    """A store fails, as its case states it does."""


def fails(store: JsonObject, what: str) -> bool:
    """Whether a store a case states fails. One that does not states what it answers."""
    only(store, STORE_MEMBERS, what)
    if "fails" in store:
        assert store["fails"] is True, what
        assert "answers" not in store, what
        return True
    assert "answers" in store, f"{what} neither answers nor fails"
    return False


@final
class StatedGraph(GraphReads):
    """The graph of a case: its listing, and what it answers for each resource read back. `listed` and `read` are what it was asked."""

    def __init__(self, listing: JsonObject | None, hydrated: Sequence[JsonObject]) -> None:
        self._listing: Final = listing
        self._read_back: Final = {text(entry["resource"], "resource"): thing(entry["graph"], "graph") for entry in hydrated}
        self.listed: Final[list[ResourceQuery]] = []
        self.read: Final[list[str]] = []

    @override
    async def list_resources(self, query: ResourceQuery) -> ResourceListing:
        self.listed.append(query)
        await asyncio.sleep(0)
        if self._listing is None:
            raise Unstated("the listing of the graph")
        if fails(self._listing, "the listing of the graph"):
            raise Fails("the listing of the graph fails")
        answers = thing(self._listing["answers"], "what the graph lists")
        only(answers, LISTING_MEMBERS, "what the graph lists")
        resources = [ResourceDescriptor.model_validate(each) for each in objects(answers["resources"], "resources")]
        return ResourceListing(resources=resources, total=whole(answers["total"], "total"))

    @override
    async def get_resource(self, resource_id: ResourceId) -> ResourceDescriptor | None:
        self.read.append(resource_id)
        await asyncio.sleep(0)
        stated = self._read_back.get(resource_id)
        if stated is None:
            raise Unstated(f"the graph, for {resource_id}")
        if fails(stated, f"the graph, for {resource_id}"):
            raise Fails(f"the graph, for {resource_id}, fails")
        return None if stated["answers"] is None else ResourceDescriptor.model_validate(stated["answers"])

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
class StatedRecord(Record):
    """The record of a case: what it answers for each resource read back that states a view. `asked` is every resource asked for."""

    def __init__(self, hydrated: Sequence[JsonObject]) -> None:
        self._views: Final = {text(entry["resource"], "resource"): thing(entry["view"], "view") for entry in hydrated if "view" in entry}
        self.asked: Final[list[str]] = []

    @override
    async def described(self, resource_id: ResourceId) -> Described | None:
        self.asked.append(resource_id)
        await asyncio.sleep(0)
        stated = self._views.get(resource_id)
        if stated is None:
            raise Unstated(f"the view of {resource_id}")
        if fails(stated, f"the view of {resource_id}"):
            raise Fails(f"the view of {resource_id} fails")
        if stated["answers"] is None:
            return None
        held = ResourceView.model_validate(stated["answers"])
        return Described(resource=held.resource, last_sequence=held.last_sequence)

    @override
    async def annotation(self, resource_id: ResourceId, annotation_id: AnnotationId) -> Annotation | None:
        raise Unstated(f"the annotation {annotation_id} of {resource_id}")


def vector_of(stated: JsonValue, what: str) -> list[float]:
    """A vector a case states."""
    assert isinstance(stated, list), f"{what} is not a list"
    return [number(each, what) for each in stated]


@final
class StatedEmbedding(EmbeddingProvider):
    """The embedding provider of a case: the one vector it answers, or that it fails. `asked` is every text it was asked to embed."""

    def __init__(self, stated: JsonObject | None) -> None:
        self._stated: Final = stated
        self.asked: Final[list[str]] = []

    @override
    async def embed_query(self, text: str) -> list[float]:
        self.asked.append(text)
        await asyncio.sleep(0)
        if self._stated is None:
            raise Unstated("the embedding")
        if fails(self._stated, "the embedding"):
            raise Fails("the embedding fails")
        return vector_of(self._stated["answers"], "what the embedding answers")

    @override
    async def embed_documents(self, texts: Sequence[str]) -> list[list[float]]:
        raise Unstated("the embedding of documents")

    @override
    async def dimensions(self) -> int:
        raise Unstated("how wide the vectors are")


def index_of(stated: JsonObject | None) -> FakeVectors:
    """The index of a case: the hits it answers, or that it fails, and a failure where the case states no index."""
    index = FakeVectors()
    if stated is None:
        index.failing["search_resources"] = Unstated("the index")
    elif fails(stated, "the index"):
        index.failing["search_resources"] = Fails("the index fails")
    else:
        hits: list[VectorSearchResult] = []
        for hit in objects(stated["answers"], "what the index answers"):
            only(hit, HIT_MEMBERS, "a hit")
            hits.append(
                VectorSearchResult(
                    score=number(hit["score"], "score"),
                    resource_id=ResourceId(text(hit["resourceId"], "resourceId")),
                    text=text(hit["text"], "text"),
                )
            )
        index.stated["search_resources"] = hits
    return index


def query_of(asked: JsonObject) -> ResourceQuery:
    """What a case states the graph's listing is asked, as the listing is asked it."""
    only(asked, ASKED_OF_THE_GRAPH, "what the graph is asked")
    archived = asked.get("archived")
    assert archived is None or isinstance(archived, bool), "archived is neither left out nor a boolean"
    return ResourceQuery(
        search=text(asked["search"], "search"),
        archived=archived,
        entity_types=tuple(strings(asked["entityTypes"], "entityTypes")) if "entityTypes" in asked else (),
        offset=whole(asked["offset"], "offset"),
        limit=whole(asked["limit"], "limit"),
    )


def in_wire_words(resources: Sequence[ResourceDescriptor]) -> list[JsonObject]:
    """Resources as the wire carries them, which is how a case states them."""
    return [written(resource) for resource in resources]


# ── The table's cases ─────────────────────────────────────────────────


def test_the_table_has_a_case_of_each_of_its_two_parts_and_no_case_of_none() -> None:
    only(TABLE, TABLE_MEMBERS, "the table")
    assert SEARCHES, "the table has no `search` case"
    assert PREVIEWS, "the table has no `preview` case"
    for case in CASES:
        only(case, CASE_MEMBERS, why(case))
        assert ("search" in case) != ("preview" in case), why(case)
    for search in SEARCHES:
        only(search, SEARCH_MEMBERS, why(search))
    for preview in PREVIEWS:
        only(preview, PREVIEW_MEMBERS, why(preview))


def test_each_case_is_told_from_the_others_by_its_why() -> None:
    told = [why(case) for case in CASES]
    assert len(set(told)) == len(told)


@pytest.mark.parametrize("case", SEARCHES, ids=[why(case) for case in SEARCHES])
def test_a_search_asks_each_store_what_the_table_states_and_answers_its_page(case: JsonObject) -> None:
    hydrated = objects(case["hydrated"], "hydrated") if "hydrated" in case else []
    for entry in hydrated:
        only(entry, HYDRATED_MEMBERS, "an entry of `hydrated`")
        only(thing(entry["graph"], "graph"), READ_BACK_MEMBERS, "what the graph answers for a resource")
        if "view" in entry:
            only(thing(entry["view"], "view"), READ_BACK_MEMBERS, "what the views answer for a resource")
    listing = thing(case["graph"], "graph") if "graph" in case else None
    embedded = thing(case["embedding"], "embedding") if "embedding" in case else None
    indexed = thing(case["index"], "index") if "index" in case else None

    graph, record = StatedGraph(listing, hydrated), StatedRecord(hydrated)
    embedding, index = StatedEmbedding(embedded), index_of(indexed)
    searching = search_resources(
        MatchResourcesRequest.model_validate(case["filters"]),
        graph=graph,
        record=record,
        vectors=index,
        embedding=embedding,
        semantic_floor=number(case["semanticFloor"], "semanticFloor"),
    )

    if "fails" in case:
        assert case["fails"] is True, why(case)
        assert "page" not in case, why(case)
        with pytest.raises(Fails, match=r"the listing of the graph fails"):
            run(searching)
    else:
        stated = thing(case["page"], "page")
        only(stated, PAGE_MEMBERS, "page")
        page = run(searching)
        assert in_wire_words(page.resources) == objects(stated["resources"], "resources")
        assert page.total == whole(stated["total"], "total")
        assert page.match_kind == stated["matchKind"]

    # What each store was asked is what the case states, and a store the case does not state was asked nothing.
    assert graph.listed == ([] if listing is None else [query_of(thing(listing["asked"], "what the graph is asked"))])
    assert embedding.asked == ([] if embedded is None else [text(embedded["asked"], "what the embedding is asked")])
    if indexed is None:
        assert index.asked == []
    else:
        asked = thing(indexed["asked"], "what the index is asked")
        only(asked, ASKED_OF_THE_INDEX, "what the index is asked")
        # The index is asked with a limit and no threshold, and with no filter but the entity types the case states.
        kept_to = SearchFilter(entity_types=tuple(strings(asked["entityTypes"], "entityTypes"))) if "entityTypes" in asked else None
        options = SearchOptions(limit=whole(asked["limit"], "limit"), filter=kept_to)
        assert index.asked == [("search_resources", vector_of(asked["embedding"], "embedding"), options)]
    assert graph.read == [text(entry["resource"], "resource") for entry in hydrated]
    assert record.asked == [text(entry["resource"], "resource") for entry in hydrated if "view" in entry]


@pytest.mark.parametrize("case", PREVIEWS, ids=[why(case) for case in PREVIEWS])
def test_each_resource_is_given_the_preview_the_table_states_and_only_what_has_one_is_read(case: JsonObject) -> None:
    stated = objects(case["resources"], "resources")
    resources = [ResourceDescriptor.model_validate(each) for each in stated]
    previews = strings(case["previews"], "previews")
    served = thing(case["served"], "served")
    content = FakeContent()
    for served_id, bytes_of in served.items():
        answer_of = thing(bytes_of, f"what is served for {served_id}")
        only(answer_of, SERVED_MEMBERS, f"what is served for {served_id}")
        # A read the case states as failing is of a resource the store holds no bytes of, which it refuses.
        if "fails" in answer_of:
            assert answer_of["fails"] is True, why(case)
            continue
        held = text(answer_of["text"], "text").encode()
        content.held[ResourceId(served_id)] = Content(data=held, content_type=text(answer_of["contentType"], "contentType"))

    previewed = run(with_previews(resources, content=content))

    assert len(previews) == len(stated), why(case)
    assert in_wire_words(previewed) == [{**each, "content": preview} for each, preview in zip(stated, previews, strict=True)]
    # Each resource `served` names is read once, in the order of the resources, and no other is read.
    assert content.asked == [resource.id for resource in resources if resource.id in served]


# ── What no case of the table rests on ────────────────────────────────


@final
@dataclass(frozen=True, slots=True)
class Stores:
    """The stores a search is handed: each a fake of the rig, holding what a test puts in it."""

    graph: FakeGraph
    record: FakeRecord
    vectors: FakeVectors
    embedding: FakeEmbedding
    content: FakeContent
    people: FakePeople


def stores(*held: ResourceView, lists: ResourceListing) -> Stores:
    """Stores whose graph answers every listing with `lists`, whose record holds `held`, and in which Ada has a profile."""
    graph = FakeGraph()
    graph.listing = lambda _: lists
    return Stores(graph, FakeRecord(*held), FakeVectors(), FakeEmbedding(), FakeContent(), FakePeople(LOVELACE))


def nothing_listed() -> ResourceListing:
    """What a graph lists for a text it matches nothing by."""
    return ResourceListing(resources=[], total=0)


def page_of(request: MatchResourcesRequest, at: Stores, *, floor: float = 0.5) -> Page:
    """The page a search answers from `at`."""
    return run(
        search_resources(request, graph=at.graph, record=at.record, vectors=at.vectors, embedding=at.embedding, semantic_floor=floor)
    )


def reply_to(request: MatchResourcesRequest, at: Stores) -> MatchResourcesResult:
    """The reply to a request, answered from `at`."""
    return run(
        answer(
            request,
            graph=at.graph,
            record=at.record,
            vectors=at.vectors,
            embedding=at.embedding,
            semantic_floor=0.5,
            content=at.content,
            people=at.people,
        )
    )


def lines(caplog: pytest.LogCaptureFixture, level: int) -> list[dict[str, object]]:
    """What the Librarian logged at one level, each line with its facts."""
    return [dict(vars(record)) for record in caplog.records if record.name == "semiont_librarian" and record.levelno == level]


def test_the_reply_to_a_lexical_search_has_previews_the_offset_and_the_limit_and_its_people_named() -> None:
    found = described(R1, representations=[TEXT_FILE], wasAttributedTo=[ADA])
    at = stores(lists=ResourceListing(resources=[found], total=7))
    at.content.held[R1] = Content(data=b"Black Hawk was a Sauk leader.", content_type="text/plain")

    response = reply_to(MatchResourcesRequest(search=" hawk "), at).response

    assert (response.total, response.offset, response.limit, response.match_kind) == (7, 0, 50, "lexical")
    (resource,) = in_wire_words(response.resources)
    assert resource["content"] == "Black Hawk was a Sauk leader."
    assert resource["wasAttributedTo"] == [{**ADA, "name": "Ada Lovelace"}]
    assert at.graph.asked_of("list_resources") == [ResourceQuery(search="hawk", offset=0, limit=50)]
    assert at.content.asked == [R1]
    assert at.people.asked == [[ADA_ID]]
    assert at.embedding.asked == []
    assert at.vectors.asked == []


def test_the_reply_states_the_offset_and_the_limit_the_request_stated() -> None:
    at = stores(lists=ResourceListing(resources=[], total=3))
    request = MatchResourcesRequest(search="hawk", archived=True, entity_type="Person", offset=20, limit=10)
    response = reply_to(request, at).response
    assert (response.total, response.offset, response.limit, response.match_kind) == (3, 20, 10, "lexical")
    assert response.resources == []
    asked = ResourceQuery(search="hawk", archived=True, entity_types=("Person",), offset=20, limit=10)
    assert at.graph.asked_of("list_resources") == [asked]


@pytest.mark.parametrize("limit", [0, -1], ids=["none", "fewer than none"])
def test_a_limit_below_1_is_refused_and_no_store_is_asked(limit: int) -> None:
    at = stores(lists=nothing_listed())

    # Stated as a caller that does not hold its request to the schema states it: the schema refuses such a limit too.
    with pytest.raises(LimitRefused, match=r"^limit must be at least 1$"):
        reply_to(MatchResourcesRequest.model_construct(search="hawk", limit=limit), at)

    assert at.graph.asked == []
    assert at.embedding.asked == []
    assert at.vectors.asked == []


def test_an_index_with_no_such_collection_fails_a_search_that_no_name_matches() -> None:
    at = stores(lists=nothing_listed())
    at.vectors.failing["search_resources"] = CollectionAbsent("Qdrant has no such collection: no store has made it yet")

    with pytest.raises(CollectionAbsent, match=r"no such collection"):
        reply_to(MatchResourcesRequest(search="ouranos"), at)


def test_the_reply_to_a_semantic_search_keeps_each_passage_and_reads_no_bytes_and_its_people_are_named() -> None:
    at = stores(lists=nothing_listed())
    at.graph.resources[R1] = described(R1, representations=[TEXT_FILE], wasAttributedTo=[ADA])
    at.content.held[R1] = Content(data=b"The whole text of the resource.", content_type="text/plain")
    at.vectors.stated["search_resources"] = [VectorSearchResult(score=0.75, resource_id=R1, text="the passage that matched")]

    response = reply_to(MatchResourcesRequest(search="ouranos"), at).response

    assert (response.total, response.offset, response.limit, response.match_kind) == (1, 0, 50, "semantic")
    (resource,) = in_wire_words(response.resources)
    assert resource["content"] == "the passage that matched"
    assert resource["wasAttributedTo"] == [{**ADA, "name": "Ada Lovelace"}]
    assert at.content.asked == []
    assert at.embedding.asked == ["ouranos"]
    assert at.people.asked == [[ADA_ID]]


def test_a_reply_is_sent_with_no_one_named_where_its_people_cannot_be_read(caplog: pytest.LogCaptureFixture) -> None:
    at = stores(lists=ResourceListing(resources=[described(R1, wasAttributedTo=[ADA])], total=1))
    at.people.failing = PeopleUnread("the Archivist did not answer")
    with caplog.at_level(logging.WARNING, logger="semiont_librarian"):
        response = reply_to(MatchResourcesRequest(search="hawk"), at).response
    (resource,) = in_wire_words(response.resources)
    assert resource["wasAttributedTo"] == [ADA]
    assert len(lines(caplog, logging.WARNING)) == 1


def test_a_graph_that_fails_to_list_fails_the_request_and_no_one_is_asked_after() -> None:
    at = stores(lists=nothing_listed())
    at.graph.failing["list_resources"] = Fails("the graph is away")
    with pytest.raises(Fails, match=r"the graph is away"):
        reply_to(MatchResourcesRequest(search="hawk"), at)
    assert at.people.asked == []
    assert at.embedding.asked == []


# No case of the table rests on a character about which the trimming a language is born with disagrees. These do. The
# next line (U+0085) and the ideographic space (U+3000) have Unicode's White_Space property. The byte order mark
# (U+FEFF) and the unit separator (U+001F) do not have it.


@pytest.mark.parametrize(
    "blank", ["\u0085", "\u3000\u0085", "\t\n \u00a0"], ids=["the next line", "an ideographic space and the next line", "a tab and others"]
)
def test_a_text_of_unicode_s_white_space_alone_finds_nothing_and_no_store_is_asked(blank: str) -> None:
    at = stores(lists=ResourceListing(resources=[described(R1)], total=1))
    assert page_of(MatchResourcesRequest(search=blank), at) == Page(resources=[], total=0, match_kind="lexical")
    assert at.graph.asked == []
    assert at.embedding.asked == []
    assert at.vectors.asked == []


@pytest.mark.parametrize("mark", ["\ufeff", "\x1f"], ids=["the byte order mark", "a unit separator"])
def test_a_character_that_is_not_unicode_s_white_space_is_searched_for(mark: str) -> None:
    at = stores(lists=ResourceListing(resources=[], total=2))
    page_of(MatchResourcesRequest(search=f" {mark}hawk{mark}\u0085"), at)
    assert at.graph.asked_of("list_resources") == [ResourceQuery(search=f"{mark}hawk{mark}", offset=0, limit=50)]
    # A text of such a character alone is a text, and is searched for.
    page_of(MatchResourcesRequest(search=mark), at)
    assert at.graph.asked_of("list_resources")[1:] == [ResourceQuery(search=mark, offset=0, limit=50)]


def test_a_preview_is_cut_at_code_points_and_splits_no_character() -> None:
    # Each book is one code point and two UTF-16 code units: a cut at 200 code units would be 100 books.
    content = FakeContent()
    content.held[R1] = Content(data=("\U0001f4da" * 250).encode(), content_type="text/plain")
    (previewed,) = in_wire_words(run(with_previews([described(R1, representations=[TEXT_FILE])], content=content)))
    assert previewed["content"] == "\U0001f4da" * 200


def test_a_search_answered_by_meaning_logs_how_the_scores_fell_about_the_floor(caplog: pytest.LogCaptureFixture) -> None:
    at = stores(lists=nothing_listed())
    at.graph.resources[R1] = described(R1)
    at.vectors.stated["search_resources"] = [
        VectorSearchResult(score=0.875, resource_id=R1, text="the best chunk of a"),
        VectorSearchResult(score=0.75, resource_id=R1, text="another chunk of a"),
        VectorSearchResult(score=0.25, resource_id=R2, text="the only chunk of b"),
    ]
    with caplog.at_level(logging.DEBUG, logger="semiont_librarian"):
        page = page_of(MatchResourcesRequest(search="ouranos"), at)
    assert (page.total, page.match_kind) == (1, "semantic")
    (said,) = [line for line in lines(caplog, logging.DEBUG) if line["msg"] == DISTRIBUTION]
    facts = ("chunkHits", "resources", "aboveFloor", "belowFloor", "topScore", "bottomScore", "floor")
    assert {fact: said[fact] for fact in facts} == {
        "chunkHits": 3,
        "resources": 2,
        "aboveFloor": 1,
        "belowFloor": 1,
        "topScore": 0.875,
        "bottomScore": 0.25,
        "floor": 0.5,
    }
    assert lines(caplog, logging.WARNING) == []


def test_a_search_that_could_not_be_answered_by_meaning_says_why_in_a_warning(caplog: pytest.LogCaptureFixture) -> None:
    at = stores(lists=nothing_listed())
    at.embedding.failing = Fails("the provider is away")
    with caplog.at_level(logging.WARNING, logger="semiont_librarian"):
        page = page_of(MatchResourcesRequest(search="ouranos"), at)
    assert page == Page(resources=[], total=0, match_kind="lexical")
    (said,) = lines(caplog, logging.WARNING)
    assert said["reason"] == "the provider is away"
    assert at.vectors.asked == []


def test_a_resource_read_from_its_view_is_on_the_page_as_the_view_holds_it_and_how_many_were_is_logged(
    caplog: pytest.LogCaptureFixture,
) -> None:
    at = stores(view(described(R1, name="As the view holds it")), lists=nothing_listed())
    at.graph.resources[R1] = None
    at.vectors.stated["search_resources"] = [VectorSearchResult(score=0.75, resource_id=R1, text="a passage of a")]
    with caplog.at_level(logging.INFO, logger="semiont_librarian"):
        (resource,) = in_wire_words(page_of(MatchResourcesRequest(search="ouranos"), at).resources)
    assert (resource["name"], resource["content"]) == ("As the view holds it", "a passage of a")
    assert at.record.asked == [R1]
    lagged = [(said["msg"], said["count"]) for said in lines(caplog, logging.INFO)]
    assert lagged == [("[graph lag] text search hits hydrated from view", 1)]
