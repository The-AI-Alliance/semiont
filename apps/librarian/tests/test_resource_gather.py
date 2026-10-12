"""Gathering around a resource (`docs/protocol/LIBRARIAN.md` § Gathering around a resource), over fakes of what it reads by.

The wait for the index is stated in § The two waits. The graph around the
resource is built by the Librarian's own code: only the stores, the two waits
and the model are fakes. What the context states is read as the bus carries
it, so a member that is absent is seen to be absent.
"""

import logging
from typing import Final, final

import pytest
from aio import run
from pydantic import JsonValue
from rig import (
    FakeAnchoredText,
    FakeContent,
    FakeDegraded,
    FakeGraph,
    FakeInference,
    FakeSmelt,
    FakeVectors,
    FakeViews,
    FakeWeave,
    described,
    sent,
    view,
)
from semiont.identifiers import ResourceId
from semiont.model import written
from semiont.types import GatheredContext, GatherResourceRequest, GatherResourceRequestOptions, ResourceDescriptor, ResourceView
from semiont_graph.interface import GraphConnection
from semiont_service.content import Content
from semiont_vectors.store import SearchFilter, SearchOptions, VectorSearchResult
from spec import JsonObject, thing

from semiont_librarian.annotation_gather import Ungathered
from semiont_librarian.prompts import reference_suggestions_prompt, resource_summary_prompt
from semiont_librarian.reads import Settled
from semiont_librarian.resource_gather import gather

QUAY: Final = ResourceId("res-quay")
FERRY: Final = ResourceId("res-ferry")
TIDES: Final = ResourceId("res-tides")
COPY: Final = ResourceId("res-copy")

TEXT: Final = "A ferry leaves the quay at dawn."
CHECKSUM: Final = "sum-of-the-quay"

SETTLE: Final = 15.0
"""The settle bound a test's gather is handed, in seconds."""


def stored(resource: ResourceId, name: str, *, checksum: str | None = None, **stated: JsonValue) -> ResourceDescriptor:
    """A resource whose description says where its bytes, a plain text, are stored, and their checksum where one is given."""
    representation: JsonObject = {"mediaType": "text/plain", "storageUri": f"file://{resource}"}
    if checksum is not None:
        representation["checksum"] = checksum
    return described(resource, name=name, representations=[representation], **stated)


def options(
    *, max_resources: int = 10, include_content: bool = True, include_summary: bool = False, excluding: list[str] | None = None
) -> GatherResourceRequestOptions:
    """What a gather is asked for: content and no summary, where a test says no other."""
    return GatherResourceRequestOptions(
        depth=1,
        max_resources=max_resources,
        include_content=include_content,
        include_summary=include_summary,
        exclude_entity_types=excluding,
    )


@final
class World:
    """What one gather is handed: a fake of each thing it reads by, over the views a test states.

    The index finds nothing like the quay, and the Smelter is signalled to
    have skipped its bytes, where a test states no other: a gather then
    waits for nothing.
    """

    def __init__(self, *held: ResourceView) -> None:
        self.views: Final = FakeViews(*held)
        self.content: Final = FakeContent()
        self.anchored: Final = FakeAnchoredText()
        self.graph: Final = FakeGraph()
        self.vectors: Final = FakeVectors()
        self.weave: Final = FakeWeave()
        self.smelt: Final = FakeSmelt()
        self.inference: Final = FakeInference()
        self.degraded: Final = FakeDegraded()
        self.vectors.stated["search_by_resource"] = []
        self.smelt.settled[(QUAY, CHECKSUM)] = "skipped"

    def weave_in(self, quay: ResourceDescriptor, *connected: ResourceDescriptor) -> None:
        """Make the graph hold the quay and the resources it is connected to, with no annotation on it and nothing that cites it."""
        self.graph.resources[QUAY] = quay
        self.graph.annotations[QUAY] = []
        self.graph.referenced_by[QUAY] = []
        self.graph.connections[QUAY] = [GraphConnection(target_resource=to, annotations=[], bidirectional=False) for to in connected]

    async def gathered(self, asked: GatherResourceRequestOptions) -> GatheredContext:
        """The context gathered around the quay."""
        return await gather(
            GatherResourceRequest(resource_id=QUAY, options=asked),
            views=self.views,
            content=self.content,
            anchored=self.anchored,
            graph=self.graph,
            vectors=self.vectors,
            weave=self.weave,
            smelt=self.smelt,
            inference=self.inference,
            degraded=self.degraded,
            settle_within=SETTLE,
        )


def a_world_of_the_quay(**stated: JsonValue) -> World:
    """A world whose record, bytes and graph hold the quay, connected to nothing."""
    quay = stored(QUAY, "The quay", checksum=CHECKSUM, **stated)
    world = World(view(quay))
    world.content.held[QUAY] = Content(TEXT.encode(), "text/plain")
    world.weave_in(quay)
    return world


def test_a_resource_with_no_view_fails_the_gather() -> None:
    async def scenario() -> None:
        world = World()
        with pytest.raises(Ungathered, match=r"Resource not found"):
            await world.gathered(options())

    run(scenario())


def test_a_gather_answers_the_resource_its_text_the_graph_and_the_texts_of_what_it_is_connected_to() -> None:
    async def scenario() -> None:
        quay = stored(QUAY, "The quay", checksum=CHECKSUM)
        ferry, tides = stored(FERRY, "The ferry"), stored(TIDES, "The tides")
        # A resource of the graph that has no view is passed by.
        gone = described("res-gone", name="Gone")
        world = World(view(quay), view(ferry), view(tides))
        world.content.held[QUAY] = Content(TEXT.encode(), "text/plain")
        world.content.held[FERRY] = Content(b"It sails at dawn.", "text/plain")
        # A text with nothing in it is not held among the related texts.
        world.content.held[TIDES] = Content(b"", "text/plain")
        world.weave_in(quay, ferry, gone, tides)

        context = await world.gathered(options(include_summary=False))

        said = written(context)
        focus = thing(said["focus"], "focus")
        assert focus["kind"] == "resource"
        assert thing(focus["resource"], "resource")["@id"] == QUAY
        assert focus["content"] == {"main": TEXT, "related": {FERRY: "It sails at dawn."}}
        assert "summary" not in focus
        assert "suggestedReferences" not in focus
        assert context.graph.nodes[0].id == QUAY
        assert said["metadata"] == {"resourceType": "document"}
        assert "semanticContext" not in said
        assert world.content.asked == [QUAY, FERRY, TIDES]
        # Where no summary is asked for, the model is asked nothing.
        assert world.inference.asked == []
        # What is like the resource is asked of its own vectors: as many as `maxResources`, at 0.5 or more, with no filter.
        assert world.vectors.asked == [("search_by_resource", QUAY, SearchOptions(limit=10, score_threshold=0.5))]

    run(scenario())


def test_the_related_resources_are_the_first_of_the_graph_s_one_fewer_than_max_resources() -> None:
    async def scenario() -> None:
        quay = stored(QUAY, "The quay", checksum=CHECKSUM)
        ferry, tides = stored(FERRY, "The ferry"), stored(TIDES, "The tides")
        world = World(view(quay), view(ferry), view(tides))
        for resource in (QUAY, FERRY, TIDES):
            world.content.held[resource] = Content(f"The text of {resource}.".encode(), "text/plain")
        world.weave_in(quay, ferry, tides)

        focus = thing(written(await world.gathered(options(max_resources=2)))["focus"], "focus")

        assert thing(focus["content"], "content")["related"] == {FERRY: "The text of res-ferry."}
        assert world.content.asked == [QUAY, FERRY]

    run(scenario())


def test_without_content_no_text_is_read_and_the_focus_states_no_content() -> None:
    async def scenario() -> None:
        world = a_world_of_the_quay()

        said = written(await world.gathered(options(include_content=False)))

        assert "content" not in thing(said["focus"], "focus")
        assert world.content.asked == []
        assert thing(said["graph"], "graph")["nodes"] != []

    run(scenario())


def test_a_text_with_nothing_in_it_is_no_main_content_and_the_focus_still_states_content() -> None:
    async def scenario() -> None:
        world = a_world_of_the_quay()
        world.content.held[QUAY] = Content(b"", "text/plain")

        focus = thing(written(await world.gathered(options(include_summary=True)))["focus"], "focus")

        assert focus["content"] == {"related": {}}
        # There is no text to summarize, so the model is asked nothing.
        assert world.inference.asked == []

    run(scenario())


def test_a_summary_and_suggestions_are_asked_of_the_model_when_the_request_asks_for_them() -> None:
    async def scenario() -> None:
        world = a_world_of_the_quay(entityTypes=["Place", "Harbour"])
        world.inference.say("A quay a ferry leaves from.", "- Read the timetable\n- Map the crossing")

        focus = thing(written(await world.gathered(options(include_summary=True)))["focus"], "focus")

        assert focus["summary"] == "A quay a ferry leaves from."
        assert focus["suggestedReferences"] == ["Read the timetable", "Map the crossing"]
        # The summary first, of the text; then the suggestions, of the resource's name and its first entity type.
        summarizing = resource_summary_prompt(name="The quay", content=TEXT, entity_types=["Place", "Harbour"])
        suggesting = reference_suggestions_prompt(title="The quay", entity_type="Place")
        assert world.inference.asked == [sent(summarizing), sent(suggesting)]
        assert world.degraded.noted == []

    run(scenario())


def test_a_model_that_fails_leaves_the_context_with_neither_and_the_gather_is_counted_and_answered() -> None:
    async def scenario() -> None:
        world = a_world_of_the_quay()
        world.inference.failing = RuntimeError("the model is away")

        focus = thing(written(await world.gathered(options(include_summary=True)))["focus"], "focus")

        assert "summary" not in focus
        assert "suggestedReferences" not in focus
        assert thing(focus["content"], "content")["main"] == TEXT
        assert world.degraded.noted == ["suggestions"]

    run(scenario())


def test_what_is_like_the_resource_is_named_by_its_view_and_states_the_entity_types_excluded() -> None:
    async def scenario() -> None:
        world = a_world_of_the_quay()
        world.views.held[COPY] = view(described(COPY, name="The quay, copied"))
        world.vectors.stated["search_by_resource"] = [
            VectorSearchResult(score=0.97, resource_id=COPY, text=TEXT),
            # A match whose resource has no view names nothing, and is left out.
            VectorSearchResult(score=0.7, resource_id=ResourceId("res-gone"), text="lost words"),
        ]

        said = written(await world.gathered(options(max_resources=4, excluding=["Question"])))

        copied: JsonObject = {"text": TEXT, "resourceId": COPY, "resourceName": "The quay, copied", "score": 0.97}
        assert said["semanticContext"] == {"similar": [copied], "excludedEntityTypes": ["Question"]}
        without_questions = SearchOptions(limit=4, score_threshold=0.5, filter=SearchFilter(exclude_entity_types=["Question"]))
        assert world.vectors.asked == [("search_by_resource", QUAY, without_questions)]
        # Something was found, so nothing is waited for.
        assert world.smelt.asked == []
        assert world.degraded.noted == []

    run(scenario())


def test_matches_with_no_entity_types_excluded_state_none_excluded() -> None:
    async def scenario() -> None:
        world = a_world_of_the_quay()
        world.views.held[COPY] = view(described(COPY, name="The quay, copied"))
        of_a_place = VectorSearchResult(score=0.97, resource_id=COPY, text=TEXT, entity_types=("Place",))
        world.vectors.stated["search_by_resource"] = [of_a_place]

        said = written(await world.gathered(options()))

        copied: JsonObject = {
            "text": TEXT,
            "resourceId": COPY,
            "resourceName": "The quay, copied",
            "score": 0.97,
            "entityTypes": ["Place"],
        }
        assert said["semanticContext"] == {"similar": [copied]}

    run(scenario())


def test_an_index_with_nothing_of_the_resource_is_asked_again_once_the_smelter_has_indexed_its_bytes() -> None:
    async def scenario() -> None:
        world = a_world_of_the_quay()
        world.views.held[COPY] = view(described(COPY, name="The quay, copied"))
        world.smelt.settled[(QUAY, CHECKSUM)] = "indexed"

        def indexed() -> None:
            world.vectors.stated["search_by_resource"] = [VectorSearchResult(score=0.97, resource_id=COPY, text=TEXT)]

        world.smelt.then = indexed

        said = written(await world.gathered(options()))

        assert world.smelt.asked == [(QUAY, CHECKSUM, SETTLE)]
        assert [search for search, _, _ in world.vectors.asked] == ["search_by_resource", "search_by_resource"]
        assert thing(said["semanticContext"], "semanticContext")["similar"] != []
        assert world.degraded.noted == []

    run(scenario())


@pytest.mark.parametrize("decision", ["skipped", "inert"])
def test_a_resource_the_smelter_skipped_and_a_wait_that_was_let_go_are_answered_without_asking_again(decision: Settled) -> None:
    async def scenario() -> None:
        world = a_world_of_the_quay()
        world.smelt.settled[(QUAY, CHECKSUM)] = decision

        said = written(await world.gathered(options()))

        assert "semanticContext" not in said
        assert world.smelt.asked == [(QUAY, CHECKSUM, SETTLE)]
        assert len(world.vectors.asked) == 1
        assert world.degraded.noted == []

    run(scenario())


def test_an_index_that_does_not_settle_within_the_bound_is_logged_and_counted_and_the_gather_is_answered(
    caplog: pytest.LogCaptureFixture,
) -> None:
    async def scenario() -> GatheredContext:
        world = a_world_of_the_quay()
        del world.smelt.settled[(QUAY, CHECKSUM)]
        context = await world.gathered(options())
        assert world.degraded.noted == ["vectors"]
        assert len(world.vectors.asked) == 1
        return context

    with caplog.at_level(logging.WARNING, logger="semiont_librarian"):
        context = run(scenario())

    assert "semanticContext" not in written(context)
    assert context.graph.nodes[0].id == QUAY
    # The line says the gather is degraded, and which resource's.
    warned = [record for record in caplog.records if "degraded" in record.getMessage().lower()]
    assert [record.__dict__["resourceId"] for record in warned] == [QUAY]
    assert [record.levelno for record in warned] == [logging.WARNING]


def test_a_resource_whose_description_states_no_checksum_is_not_waited_for() -> None:
    async def scenario() -> None:
        quay = stored(QUAY, "The quay")
        world = World(view(quay))
        world.content.held[QUAY] = Content(TEXT.encode(), "text/plain")
        world.weave_in(quay)

        said = written(await world.gathered(options()))

        assert "semanticContext" not in said
        assert world.smelt.asked == []
        assert world.degraded.noted == []

    run(scenario())


def test_a_wait_that_fails_in_any_way_but_running_out_fails_the_gather() -> None:
    async def scenario() -> None:
        world = a_world_of_the_quay()
        world.smelt.failing = RuntimeError("the fold is broken")
        with pytest.raises(RuntimeError, match=r"the fold is broken"):
            await world.gathered(options())
        assert world.degraded.noted == []

    run(scenario())


def test_an_index_that_fails_fails_the_gather() -> None:
    async def scenario() -> None:
        world = a_world_of_the_quay()
        world.vectors.failing["search_by_resource"] = RuntimeError("the index is away")
        with pytest.raises(RuntimeError, match=r"the index is away"):
            await world.gathered(options())

    run(scenario())
