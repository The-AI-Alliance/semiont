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
    link,
    reference,
    sent,
    view,
)
from semiont.identifiers import ResourceId
from semiont.model import written
from semiont.types import (
    Annotation,
    GatheredContext,
    GatherResourceRequest,
    GatherResourceRequestOptions,
    ResourceDescriptor,
    ResourceView,
)
from semiont_graph.interface import GraphConnection
from semiont_service.content import Content
from semiont_vectors.store import CollectionAbsent, ResourceStamp, SearchFilter, SearchOptions, VectorSearchResult
from spec import JsonObject, objects, thing

from semiont_librarian.annotation_gather import Ungathered
from semiont_librarian.knowledge_graph import RESOURCE_CEILING, DepthRefused
from semiont_librarian.prompts import reference_suggestions_prompt, resource_summary_prompt
from semiont_librarian.reads import Settled
from semiont_librarian.replies import SUGGESTION_ELEMENT
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
    *,
    depth: int = 1,
    max_resources: int = 10,
    include_content: bool = True,
    include_summary: bool = False,
    excluding: list[str] | None = None,
) -> GatherResourceRequestOptions:
    """What a gather is asked for: the graph one link out, content and no summary, where a test says no other."""
    return GatherResourceRequestOptions(
        depth=depth,
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


@pytest.mark.parametrize("depth", [0, 4])
def test_a_depth_less_than_1_or_more_than_3_fails_the_gather_and_nothing_is_read(depth: int) -> None:
    async def scenario() -> None:
        world = a_world_of_the_quay()
        # Stated as a caller that does not hold its request to the schema states it: the schema refuses such a depth too.
        asked = GatherResourceRequestOptions.model_construct(depth=depth, max_resources=10, include_content=True, include_summary=False)

        with pytest.raises(DepthRefused, match=r"depth must be between 1 and 3"):
            await world.gathered(asked)

        assert world.views.asked == []
        assert world.content.asked == []
        assert world.graph.asked == []
        assert world.vectors.asked == []

    run(scenario())


def a_world_of_a_crossing() -> World:
    """A world in which the quay links to the ferry, the ferry links to the tides, and each of the three has a text."""
    quay = stored(QUAY, "The quay", checksum=CHECKSUM)
    ferry, tides = stored(FERRY, "The ferry"), stored(TIDES, "The tides")
    world = World(view(quay), view(ferry), view(tides))
    for resource in (QUAY, FERRY, TIDES):
        world.content.held[resource] = Content(f"The text of {resource}.".encode(), "text/plain")
    world.weave_in(quay, ferry)
    world.graph.connections[FERRY] = [GraphConnection(target_resource=tides, annotations=[], bidirectional=False)]
    world.graph.referenced_by[FERRY] = []
    world.graph.connections[TIDES] = []
    world.graph.referenced_by[TIDES] = []
    return world


def test_the_graph_reaches_as_many_links_out_as_the_depth_and_the_texts_read_are_those_of_the_resources_it_reaches() -> None:
    async def scenario() -> None:
        near = a_world_of_a_crossing()
        one_out = await near.gathered(options(depth=1))
        assert [node.id for node in one_out.graph.nodes] == [QUAY, FERRY]
        assert thing(thing(written(one_out)["focus"], "focus")["content"], "content")["related"] == {FERRY: "The text of res-ferry."}
        assert near.graph.asked_of("get_resource_connections") == [QUAY]

        far = a_world_of_a_crossing()
        two_out = await far.gathered(options(depth=2))
        assert [node.id for node in two_out.graph.nodes] == [QUAY, FERRY, TIDES]
        assert thing(written(two_out)["graph"], "graph")["edges"] == [
            {"source": QUAY, "target": FERRY, "type": "link", "bidirectional": False},
            {"source": FERRY, "target": TIDES, "type": "link", "bidirectional": False},
        ]
        related = thing(thing(written(two_out)["focus"], "focus")["content"], "content")["related"]
        assert related == {FERRY: "The text of res-ferry.", TIDES: "The text of res-tides."}
        assert far.content.asked == [QUAY, FERRY, TIDES]
        # The ferry, one link out, is asked what it links to and what cites it. The tides, two links out, are asked nothing.
        assert far.graph.asked_of("get_resource_connections") == [QUAY, FERRY]
        assert far.graph.asked_of("get_resource_referenced_by") == [(QUAY, None), (FERRY, None)]
        assert "truncated" not in thing(written(two_out)["graph"], "graph")

    run(scenario())


def test_max_resources_reads_the_texts_of_the_nearest_resources_and_leaves_the_graph_whole() -> None:
    async def scenario() -> None:
        world = a_world_of_a_crossing()

        context = await world.gathered(options(depth=2, max_resources=2))

        # Two at most, the quay and one other: the ferry, one link out, and not the tides, two links out.
        assert thing(thing(written(context)["focus"], "focus")["content"], "content")["related"] == {FERRY: "The text of res-ferry."}
        assert world.content.asked == [QUAY, FERRY]
        assert [node.id for node in context.graph.nodes] == [QUAY, FERRY, TIDES]

    run(scenario())


def test_a_graph_the_ceiling_cut_says_so_in_the_context() -> None:
    async def scenario() -> None:
        quay = stored(QUAY, "The quay", checksum=CHECKSUM)
        ferry = stored(FERRY, "The ferry")
        world = World(view(quay))
        world.weave_in(quay, ferry)
        # The ferry links to as many resources as a graph holds: two more than there is room for.
        beyond = [described(f"res-buoy-{number:03d}") for number in range(RESOURCE_CEILING)]
        world.graph.connections[FERRY] = [GraphConnection(target_resource=to, annotations=[], bidirectional=False) for to in beyond]
        world.graph.referenced_by[FERRY] = []

        said = written(await world.gathered(options(depth=2, include_content=False)))

        graph = thing(said["graph"], "graph")
        assert graph["truncated"] is True
        kept = [each.id for each in beyond[: RESOURCE_CEILING - 2]]
        assert [node["id"] for node in objects(graph["nodes"], "nodes")] == [QUAY, FERRY, *kept]

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
        suggested = '[{"suggestion": "Read the timetable"}, {"suggestion": "Map the crossing"}]'
        world.inference.say("A quay a ferry leaves from.", suggested)

        focus = thing(written(await world.gathered(options(include_summary=True)))["focus"], "focus")

        assert focus["summary"] == "A quay a ferry leaves from."
        assert focus["suggestedReferences"] == ["Read the timetable", "Map the crossing"]
        # The summary is asked for as text, and the suggestions as elements held to the suggestion's schema.
        assert world.inference.schemas == [SUGGESTION_ELEMENT]
        # The summary first, of the text; then the suggestions, of the resource's name and its first entity type.
        summarizing = resource_summary_prompt(name="The quay", content=TEXT, entity_types=["Place", "Harbour"])
        suggesting = reference_suggestions_prompt(title="The quay", entity_type="Place")
        assert world.inference.asked == [sent(summarizing), sent(suggesting)]
        assert world.degraded.noted == []

    run(scenario())


def test_a_reply_with_no_suggestion_leaves_the_summary_and_states_no_suggestions() -> None:
    async def scenario() -> None:
        world = a_world_of_the_quay()
        world.inference.say("A quay a ferry leaves from.", "[]")

        focus = thing(written(await world.gathered(options(include_summary=True)))["focus"], "focus")

        assert focus["summary"] == "A quay a ferry leaves from."
        assert "suggestedReferences" not in focus
        assert world.degraded.noted == []

    run(scenario())


def test_suggestions_that_are_no_array_are_a_model_that_failed_and_the_context_has_neither() -> None:
    async def scenario() -> None:
        world = a_world_of_the_quay()
        world.inference.say("A quay a ferry leaves from.", "- Read the timetable\n- Map the crossing")

        focus = thing(written(await world.gathered(options(include_summary=True)))["focus"], "focus")

        assert "summary" not in focus
        assert "suggestedReferences" not in focus
        assert world.degraded.noted == ["suggestions"]

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


@pytest.mark.parametrize("read", ["search_by_resource", "get_resource_stamp"])
def test_an_index_that_fails_leaves_the_context_without_similar_passages_and_is_counted_and_nothing_waits(read: str) -> None:
    async def scenario() -> None:
        world = a_world_of_the_quay()
        world.vectors.failing[read] = RuntimeError("the index is away")

        said = written(await world.gathered(options()))

        assert "semanticContext" not in said
        assert thing(thing(said["focus"], "focus")["content"], "content")["main"] == TEXT
        assert world.smelt.asked == []
        assert world.degraded.noted == ["vectors"]

    run(scenario())


def test_an_index_with_no_such_collection_fails_the_gather() -> None:
    async def scenario() -> None:
        world = a_world_of_the_quay()
        world.vectors.failing["search_by_resource"] = CollectionAbsent("Qdrant has no such collection: no store has made it yet")
        with pytest.raises(CollectionAbsent, match=r"no such collection"):
            await world.gathered(options())
        assert world.degraded.noted == []

    run(scenario())


def test_a_resource_the_index_holds_the_bytes_of_and_that_nothing_is_like_is_answered_with_no_wait() -> None:
    async def scenario() -> None:
        world = a_world_of_the_quay()
        # The Librarian keeps no decision of the quay's bytes: one it was started after, or has forgotten.
        del world.smelt.settled[(QUAY, CHECKSUM)]
        world.vectors.stamps[QUAY] = ResourceStamp(content_checksum=CHECKSUM, entity_types=(), media_type="text/markdown")

        said = written(await world.gathered(options()))

        assert "semanticContext" not in said
        assert world.vectors.stamps_asked == [QUAY]
        assert world.smelt.asked == []
        assert len(world.vectors.asked) == 1
        assert world.degraded.noted == []

    run(scenario())


def test_a_resource_the_index_holds_other_bytes_of_is_waited_for() -> None:
    async def scenario() -> None:
        world = a_world_of_the_quay()
        world.vectors.stamps[QUAY] = ResourceStamp(content_checksum="sum-of-what-the-quay-was", entity_types=(), media_type="text/markdown")

        await world.gathered(options())

        assert world.vectors.stamps_asked == [QUAY]
        assert world.smelt.asked == [(QUAY, CHECKSUM, SETTLE)]

    run(scenario())


def test_a_resource_whose_media_type_has_no_text_is_not_waited_for_and_the_index_is_not_asked_what_it_holds() -> None:
    async def scenario() -> None:
        chart = described(QUAY, name="A chart of the quay", representations=[{"mediaType": "image/png", "checksum": CHECKSUM}])
        world = World(view(chart))
        world.weave_in(chart)
        del world.smelt.settled[(QUAY, CHECKSUM)]

        said = written(await world.gathered(options()))

        assert "semanticContext" not in said
        assert world.vectors.stamps_asked == []
        assert world.smelt.asked == []
        assert world.degraded.noted == []

    run(scenario())


def test_the_language_of_a_context_is_the_one_the_resource_s_representation_states() -> None:
    async def scenario() -> None:
        german: JsonObject = {"mediaType": "text/plain", "storageUri": f"file://{QUAY}", "checksum": CHECKSUM, "language": "de"}
        quay = described(QUAY, name="Der Kai", representations=[german])
        world = World(view(quay))
        world.content.held[QUAY] = Content(TEXT.encode(), "text/plain")
        world.weave_in(quay)

        assert written(await world.gathered(options()))["metadata"] == {"resourceType": "document", "language": "de"}

        # A resource that states none has none stated of it.
        plain = a_world_of_the_quay()
        assert written(await plain.gathered(options()))["metadata"] == {"resourceType": "document"}

    run(scenario())


def test_a_summary_asked_for_without_content_is_made_of_the_text_and_the_focus_states_no_content() -> None:
    async def scenario() -> None:
        world = a_world_of_the_quay()
        world.inference.say("A quay a ferry leaves from.", '[{"suggestion": "Read the timetable"}]')

        focus = thing(written(await world.gathered(options(include_content=False, include_summary=True)))["focus"], "focus")

        assert focus["summary"] == "A quay a ferry leaves from."
        assert focus["suggestedReferences"] == ["Read the timetable"]
        assert "content" not in focus
        assert world.content.asked == [QUAY]
        assert world.inference.asked[0] == sent(resource_summary_prompt(name="The quay", content=TEXT, entity_types=[]))

    run(scenario())


def test_a_related_resource_whose_view_cannot_be_read_is_left_out_and_the_others_are_read() -> None:
    async def scenario() -> None:
        quay = stored(QUAY, "The quay", checksum=CHECKSUM)
        ferry, tides = stored(FERRY, "The ferry"), stored(TIDES, "The tides")
        world = World(view(quay), view(ferry), view(tides))
        world.views.unread.add(FERRY)
        world.content.held[QUAY] = Content(TEXT.encode(), "text/plain")
        world.content.held[TIDES] = Content(b"High water at noon.", "text/plain")
        world.weave_in(quay, ferry, tides)

        context = await world.gathered(options())

        related = thing(thing(written(context)["focus"], "focus")["content"], "content")["related"]
        assert related == {TIDES: "High water at noon."}
        # The graph is whole: the ferry is a node of it, as the graph database described it.
        assert [node.id for node in context.graph.nodes] == [QUAY, FERRY, TIDES]

    run(scenario())


def cites(annotation: str, on: ResourceId) -> Annotation:
    """An annotation on a resource that links to the quay."""
    return reference(annotation, on, link(QUAY))


def test_a_citing_resource_that_is_a_node_already_is_not_read_again_and_one_whose_view_cannot_be_read_is_named_by_its_id() -> None:
    async def scenario() -> None:
        quay = stored(QUAY, "The quay", checksum=CHECKSUM)
        ferry, tides = stored(FERRY, "The ferry"), stored(TIDES, "The tides")
        world = World(view(quay), view(ferry), view(tides))
        world.views.unread.add(TIDES)
        world.content.held[QUAY] = Content(TEXT.encode(), "text/plain")
        # The quay links to the ferry, and the ferry and the tides each cite the quay.
        world.weave_in(quay, ferry)
        world.graph.referenced_by[QUAY] = [cites("ann-from-the-ferry", FERRY), cites("ann-from-the-tides", TIDES)]

        context = await world.gathered(options(include_content=False))

        labels = {node.id: node.label for node in context.graph.nodes if node.id in (FERRY, TIDES)}
        assert labels == {FERRY: "The ferry", TIDES: TIDES}
        # The ferry's view is read once, as a related resource. The tides' is asked for as a citing resource, and again as a related one.
        assert world.views.asked == [QUAY, TIDES, FERRY, TIDES]

    run(scenario())
