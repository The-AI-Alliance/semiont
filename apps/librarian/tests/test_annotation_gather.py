"""Gathering around an annotation (`docs/protocol/LIBRARIAN.md` § Gathering around an annotation), over fakes of what it reads by.

The graph around the resource is built, and the lists are read off it, by
the Librarian's own code: only the stores, the provider and the model are
fakes. What the context states is read as the bus carries it, so a member
that is absent is seen to be absent.
"""

from typing import Final, final

import pytest
from aio import run
from pydantic import JsonValue
from rig import (
    FakeAnchoredText,
    FakeContent,
    FakeDegraded,
    FakeEmbedding,
    FakeGraph,
    FakeInference,
    FakeVectors,
    FakeViews,
    FakeWeave,
    Prompted,
    described,
    link,
    reference,
    tag,
    view,
)
from semiont.identifiers import AnnotationId, ResourceId
from semiont.model import written
from semiont.types import Annotation, GatherAnnotationOptions, GatherAnnotationRequest, GatheredContext, ResourceDescriptor, ResourceView
from semiont_graph.interface import EntityTypeCount, GraphConnection
from semiont_service.content import Content
from semiont_vectors.store import SearchFilter, SearchOptions, VectorSearchResult
from spec import JsonObject, thing

from semiont_librarian.annotation_gather import Ungathered, gather
from semiont_librarian.prompts import Prompt, relationship_prompt, resource_summary_prompt
from semiont_librarian.window import WindowRefused

MYTHS: Final = ResourceId("res-myths")
OLYMPUS: Final = ResourceId("res-olympus")
THEOGONY: Final = ResourceId("res-theogony")
REFERENCE: Final = AnnotationId("ann-zeus")
THUNDERER: Final = AnnotationId("ann-thunderer")

TEXT: Final = "It is told that Zeus ruled from Olympus."
START: Final = TEXT.index("Zeus")
END: Final = START + len("Zeus")

BOOK: Final = "\U0001f4d6"
"""A character outside the basic plane: one code point, and two UTF-16 code units."""


def stored(resource: ResourceId, name: str, media_type: str = "text/plain", **stated: JsonValue) -> ResourceDescriptor:
    """A resource whose description says where its bytes are stored, and what they are."""
    representation: JsonObject = {"mediaType": media_type, "storageUri": f"file://{resource}", "checksum": f"sum-of-{resource}"}
    return described(resource, name=name, representations=[representation], **stated)


def at(start: int, end: int) -> JsonObject:
    """A target that selects a span of the myths by its position."""
    return {"source": MYTHS, "selector": {"type": "TextPositionSelector", "start": start, "end": end}}


def sent(prompt: Prompt) -> Prompted:
    """A prompt, as a model that was sent it records the request."""
    return Prompted(prompt.text, prompt.max_tokens, prompt.temperature)


@final
class World:
    """What one gather is handed: a fake of each thing it reads by, over the views a test states."""

    def __init__(self, *held: ResourceView) -> None:
        self.views: Final = FakeViews(*held)
        self.content: Final = FakeContent()
        self.anchored: Final = FakeAnchoredText()
        self.graph: Final = FakeGraph()
        self.vectors: Final = FakeVectors()
        self.weave: Final = FakeWeave()
        self.embedding: Final = FakeEmbedding()
        self.inference: Final = FakeInference()
        self.degraded: Final = FakeDegraded()
        self.vectors.stated["search_annotations"] = []

    def weave_in(self, myths: ResourceDescriptor, *on_it: Annotation, connected: tuple[ResourceDescriptor, ...] = ()) -> None:
        """Make the graph hold the myths, the annotations on them and what they are connected to. Nothing cites them."""
        self.graph.resources[MYTHS] = myths
        self.graph.annotations[MYTHS] = [*on_it]
        self.graph.referenced_by[MYTHS] = []
        self.graph.connections[MYTHS] = [GraphConnection(target_resource=to, annotations=[], bidirectional=False) for to in connected]
        self.graph.entity_type_stats = [EntityTypeCount(type="Deity", count=3), EntityTypeCount(type="Place", count=1)]

    async def gathered(self, options: GatherAnnotationOptions | None = None) -> GatheredContext:
        """The context gathered around the reference to Zeus."""
        return await gather(
            GatherAnnotationRequest(annotation_id=REFERENCE, resource_id=MYTHS, options=options),
            views=self.views,
            content=self.content,
            anchored=self.anchored,
            graph=self.graph,
            vectors=self.vectors,
            weave=self.weave,
            embedding=self.embedding,
            inference=self.inference,
            degraded=self.degraded,
        )


def a_world_of_the_myths(*body: JsonValue) -> World:
    """A world whose record, bytes and graph hold the myths, with the reference to Zeus on them, its body as given."""
    myths = stored(MYTHS, "Greek Myths")
    zeus = reference(REFERENCE, MYTHS, *body, target=at(START, END))
    world = World(view(myths, zeus))
    world.content.held[MYTHS] = Content(TEXT.encode(), "text/plain")
    world.weave_in(myths, zeus)
    return world


def test_a_gather_answers_the_selection_the_graph_the_frequencies_the_relationship_and_what_is_like_the_selection() -> None:
    async def scenario() -> None:
        myths = stored(MYTHS, "Greek Myths")
        zeus = reference(REFERENCE, MYTHS, tag("Deity"), target=at(START, END))
        world = World(view(myths, zeus), view(described(THEOGONY, name="Theogony")))
        world.content.held[MYTHS] = Content(TEXT.encode(), "text/plain")
        world.weave_in(myths, zeus, connected=(described(OLYMPUS, name="Mount Olympus"),))
        world.vectors.stated["search_annotations"] = [
            VectorSearchResult(score=0.9, resource_id=THEOGONY, text="the thunderer", annotation_id=THUNDERER, entity_types=("Deity",)),
            # A match whose resource has no view names nothing, and is left out.
            VectorSearchResult(score=0.8, resource_id=ResourceId("res-gone"), text="lost words"),
        ]
        world.inference.say("The passage names a god.")

        context = await world.gathered()

        said = written(context)
        focus = thing(said["focus"], "focus")
        assert focus["kind"] == "annotation"
        assert thing(focus["annotation"], "annotation")["id"] == REFERENCE
        assert thing(focus["sourceResource"], "sourceResource")["@id"] == MYTHS
        assert focus["selected"] == {"before": TEXT[:START], "text": "Zeus", "after": TEXT[END:]}
        assert "targetResource" not in focus
        assert "targetContext" not in focus
        assert context.graph.nodes[0].id == MYTHS
        assert OLYMPUS in [node.id for node in context.graph.nodes]
        metadata: JsonObject = {
            "resourceType": "document",
            "entityTypes": ["Deity"],
            "entityTypeFrequencies": {"Deity": 3, "Place": 1},
        }
        assert said["metadata"] == metadata
        assert said["inferredRelationshipSummary"] == "The passage names a god."
        thunderer: JsonObject = {
            "text": "the thunderer",
            "resourceId": THEOGONY,
            "resourceName": "Theogony",
            "annotationId": THUNDERER,
            "score": 0.9,
            "entityTypes": ["Deity"],
        }
        assert said["semanticContext"] == {"similar": [thunderer]}

        # The model is asked once, for the relationship sentence, made from the passage and the lists read off the graph.
        relating = relationship_prompt(
            passage="Zeus", connected=["Mount Olympus"], cited_by=[], sibling_entity_types=[], entity_types=["Deity"]
        )
        assert world.inference.asked == [sent(relating)]
        # The selection is embedded once, and the index asked for ten annotations of other resources that score 0.5 or more.
        assert world.embedding.asked == ["Zeus"]
        asked = [(search, options) for search, _, options in world.vectors.asked]
        like_the_selection = SearchOptions(limit=10, score_threshold=0.5, filter=SearchFilter(exclude_resource_id=MYTHS))
        assert asked == [("search_annotations", like_the_selection)]
        assert world.degraded.noted == []

    run(scenario())


@pytest.mark.parametrize("window", [99, 5001])
def test_a_window_less_than_100_or_more_than_5000_fails_the_gather_and_nothing_is_read(window: int) -> None:
    async def scenario() -> None:
        world = a_world_of_the_myths()
        with pytest.raises(WindowRefused, match=r"contextWindow must be between 100 and 5000"):
            await world.gathered(GatherAnnotationOptions(context_window=window))
        assert world.views.asked == []
        assert world.content.asked == []
        assert world.graph.asked == []
        assert world.inference.asked == []

    run(scenario())


@pytest.mark.parametrize("window", [100, 5000])
def test_a_window_of_100_and_one_of_5000_are_gathered(window: int) -> None:
    async def scenario() -> None:
        world = a_world_of_the_myths()
        focus = thing(written(await world.gathered(GatherAnnotationOptions(context_window=window)))["focus"], "focus")
        assert focus["selected"] == {"before": TEXT[:START], "text": "Zeus", "after": TEXT[END:]}

    run(scenario())


def test_a_resource_with_no_view_fails_the_gather() -> None:
    async def scenario() -> None:
        world = World()
        with pytest.raises(Ungathered, match=r"Source resource not found"):
            await world.gathered()

    run(scenario())


def test_an_annotation_the_view_does_not_hold_fails_the_gather() -> None:
    async def scenario() -> None:
        myths = stored(MYTHS, "Greek Myths")
        world = World(view(myths, reference("ann-another", MYTHS)))
        with pytest.raises(Ungathered, match=r"Annotation not found in view"):
            await world.gathered()

    run(scenario())


def test_an_annotation_whose_target_names_another_resource_fails_the_gather() -> None:
    async def scenario() -> None:
        myths = stored(MYTHS, "Greek Myths")
        world = World(view(myths, reference(REFERENCE, OLYMPUS)))
        with pytest.raises(Ungathered, match=r"res-olympus\) does not match expected resource ID \(res-myths\)"):
            await world.gathered()

    run(scenario())


def test_a_resource_with_no_stored_bytes_fails_a_gather_that_asks_for_the_selection() -> None:
    async def scenario() -> None:
        myths = described(MYTHS, name="Greek Myths")
        zeus = reference(REFERENCE, MYTHS, target=at(START, END))
        world = World(view(myths, zeus))
        world.weave_in(myths, zeus)
        with pytest.raises(Ungathered, match=r"Source content not found"):
            await world.gathered()
        assert world.content.asked == []

    run(scenario())


def test_without_the_source_context_no_text_is_read_and_no_model_and_no_provider_is_asked() -> None:
    async def scenario() -> None:
        world = a_world_of_the_myths(tag("Deity"))
        world.inference.say("A sentence nobody asked for.")

        said = written(await world.gathered(GatherAnnotationOptions(include_source_context=False)))

        assert "selected" not in thing(said["focus"], "focus")
        assert "inferredRelationshipSummary" not in said
        assert "semanticContext" not in said
        assert world.content.asked == []
        assert world.inference.asked == []
        assert world.embedding.asked == []
        assert world.vectors.asked == []
        # The graph and the frequencies are gathered all the same.
        assert thing(said["graph"], "graph")["nodes"] != []
        assert thing(said["metadata"], "metadata")["entityTypeFrequencies"] == {"Deity": 3, "Place": 1}

    run(scenario())


def test_a_text_that_is_not_there_yet_gives_no_selection_and_the_gather_goes_on() -> None:
    async def scenario() -> None:
        # A PDF's text is derived, and the gateway has none for this one yet.
        myths = stored(MYTHS, "Greek Myths", media_type="application/pdf")
        zeus = reference(REFERENCE, MYTHS, target=at(START, END))
        world = World(view(myths, zeus))
        world.weave_in(myths, zeus)

        said = written(await world.gathered())

        assert "selected" not in thing(said["focus"], "focus")
        assert world.anchored.asked == [MYTHS]
        assert world.content.asked == []
        assert world.inference.asked == []
        assert world.embedding.asked == []

    run(scenario())


def test_a_linked_resource_is_the_target_with_the_start_of_its_text_and_a_summary_of_it() -> None:
    async def scenario() -> None:
        myths = stored(MYTHS, "Greek Myths")
        zeus = reference(REFERENCE, MYTHS, link(THEOGONY), target=at(START, END))
        theogony = stored(THEOGONY, "Theogony", entityTypes=["Poem"])
        world = World(view(myths, zeus), view(theogony))
        world.content.held[MYTHS] = Content(TEXT.encode(), "text/plain")
        world.content.held[THEOGONY] = Content((BOOK * 250).encode(), "text/plain")
        world.weave_in(myths, zeus, connected=(theogony,))
        world.inference.say("A poem of how the gods were born.", "The passage links to the poem.")

        said = written(await world.gathered(GatherAnnotationOptions(context_window=100)))

        focus = thing(said["focus"], "focus")
        assert thing(focus["targetResource"], "targetResource")["@id"] == THEOGONY
        # Twice the window, counted in code points: no book is cut in two.
        assert focus["targetContext"] == {"content": BOOK * 200, "summary": "A poem of how the gods were born."}
        assert said["inferredRelationshipSummary"] == "The passage links to the poem."
        # The summary is asked for first, of the whole text, and then the relationship sentence.
        summarizing = resource_summary_prompt(name="Theogony", content=BOOK * 250, entity_types=["Poem"])
        assert world.inference.asked[0] == sent(summarizing)
        assert len(world.inference.asked) == 2
        assert world.content.asked == [MYTHS, THEOGONY]

    run(scenario())


def test_without_the_target_context_the_linked_resource_is_stated_and_its_text_is_not_read() -> None:
    async def scenario() -> None:
        myths = stored(MYTHS, "Greek Myths")
        zeus = reference(REFERENCE, MYTHS, link(THEOGONY), target=at(START, END))
        theogony = stored(THEOGONY, "Theogony")
        world = World(view(myths, zeus), view(theogony))
        world.content.held[MYTHS] = Content(TEXT.encode(), "text/plain")
        world.weave_in(myths, zeus, connected=(theogony,))

        said = written(await world.gathered(GatherAnnotationOptions(include_target_context=False)))

        focus = thing(said["focus"], "focus")
        assert thing(focus["targetResource"], "targetResource")["@id"] == THEOGONY
        assert "targetContext" not in focus
        assert world.content.asked == [MYTHS]
        # A model that answers the empty text has given no sentence.
        assert len(world.inference.asked) == 1
        assert "inferredRelationshipSummary" not in said

    run(scenario())


def test_a_link_to_a_resource_with_no_view_gives_no_target() -> None:
    async def scenario() -> None:
        world = a_world_of_the_myths(link(THEOGONY))

        focus = thing(written(await world.gathered())["focus"], "focus")

        assert "targetResource" not in focus
        assert "targetContext" not in focus
        assert world.views.asked[:2] == [MYTHS, THEOGONY]

    run(scenario())


def test_a_model_that_fails_on_the_relationship_sentence_leaves_the_context_without_it() -> None:
    async def scenario() -> None:
        world = a_world_of_the_myths()
        world.inference.failing = RuntimeError("the model is away")

        said = written(await world.gathered())

        assert "inferredRelationshipSummary" not in said
        assert thing(said["focus"], "focus")["selected"] == {"before": TEXT[:START], "text": "Zeus", "after": TEXT[END:]}
        # What is like the selection is still looked for.
        assert world.embedding.asked == ["Zeus"]

    run(scenario())


@pytest.mark.parametrize("failing", ["embedding", "index"])
def test_an_embedding_or_an_index_that_fails_leaves_the_context_without_what_is_like_the_selection(failing: str) -> None:
    async def scenario() -> None:
        world = a_world_of_the_myths()
        world.vectors.stated["search_annotations"] = [VectorSearchResult(score=0.9, resource_id=MYTHS, text="Zeus")]
        if failing == "embedding":
            world.embedding.failing = RuntimeError("the provider is away")
        else:
            world.vectors.failing["search_annotations"] = RuntimeError("the index is away")
        world.inference.say("The passage names a god.")

        said = written(await world.gathered())

        assert "semanticContext" not in said
        assert said["inferredRelationshipSummary"] == "The passage names a god."

    run(scenario())


def test_a_selection_nothing_is_like_states_no_semantic_context() -> None:
    async def scenario() -> None:
        world = a_world_of_the_myths()
        assert "semanticContext" not in written(await world.gathered())
        assert world.embedding.asked == ["Zeus"]

    run(scenario())
