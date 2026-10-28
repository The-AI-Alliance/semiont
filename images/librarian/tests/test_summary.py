"""An annotation's summary (`docs/protocol/LIBRARIAN.md` § An annotation's summary), over fakes of what it reads by."""

from typing import Final, final

import pytest
from aio import run
from rig import FakeAnchoredText, FakeContent, FakeInference, FakeRecord, described, reference, sent, tag, view
from semiont.identifiers import AnnotationId, ResourceId
from semiont.model import written
from semiont.types import Annotation, ContextualSummaryResponse, ContextualSummaryResponseContext, GatherSummaryRequest, ResourceView
from semiont_service.content import Content
from spec import JsonObject

from semiont_librarian.annotation_gather import Ungathered
from semiont_librarian.prompts import annotation_summary_prompt
from semiont_librarian.summary import summarize
from semiont_librarian.window import Unplaced

WAR: Final = ResourceId("res-war")
TREATY: Final = AnnotationId("ann-treaty")

BOOK: Final = "\U0001f4d6"
"""A character outside the basic plane: one code point, and two UTF-16 code units."""

LEAD: Final = "a" * 400 + BOOK * 300
PASSAGE: Final = "the treaty of 1804"
TAIL: Final = BOOK * 300 + "z" * 400
TEXT: Final = LEAD + PASSAGE + TAIL


def war(media_type: str = "text/plain") -> JsonObject:
    """What the description of the war says of its bytes."""
    return {"mediaType": media_type, "storageUri": "file://war", "checksum": "sum-of-the-war"}


def the_treaty() -> Annotation:
    """An annotation of the passage, by its position, which counts code points, tagged as a treaty."""
    selector: JsonObject = {"type": "TextPositionSelector", "start": len(LEAD), "end": len(LEAD) + len(PASSAGE)}
    return reference(TREATY, WAR, tag("Treaty"), target={"source": WAR, "selector": selector})


@final
class World:
    """What one summary is handed: a fake of each thing it reads by, over the record a test states."""

    def __init__(self, *held: ResourceView) -> None:
        self.record: Final = FakeRecord(*held)
        self.content: Final = FakeContent()
        self.anchored: Final = FakeAnchoredText()
        self.inference: Final = FakeInference()

    async def summarized(self) -> ContextualSummaryResponse:
        """The summary of the annotation of the treaty."""
        return await summarize(
            GatherSummaryRequest(annotation_id=TREATY, resource_id=WAR),
            record=self.record,
            content=self.content,
            anchored=self.anchored,
            inference=self.inference,
        )


def test_a_summary_answers_the_model_s_words_the_resource_s_name_the_entity_types_and_the_passage_where_it_stands() -> None:
    async def scenario() -> None:
        world = World(view(described(WAR, name="Black Hawk War", representations=[war()]), the_treaty()))
        world.content.held[WAR] = Content(TEXT.encode(), "text/plain")
        world.inference.say("He broke the treaty when he crossed the river.")

        response = await world.summarized()

        assert response.summary == "He broke the treaty when he crossed the river."
        assert written(response.relevant_fields) == {"resourceId": WAR, "resourceName": "Black Hawk War", "entityTypes": ["Treaty"]}
        # The 200 code points nearest the passage on each side: no book is cut in two.
        assert response.context == ContextualSummaryResponseContext(before=BOOK * 200, selected=PASSAGE, after=BOOK * 200)
        # The model is asked once, with the annotation-summary prompt.
        asking = annotation_summary_prompt(
            resource="Black Hawk War", before=BOOK * 200, selected=PASSAGE, after=BOOK * 200, entity_types=["Treaty"]
        )
        assert world.inference.asked == [sent(asking)]
        assert world.content.asked == [WAR]
        # The resource's view holds the annotation and the resource: it is read once.
        assert world.record.asked == [WAR]

    run(scenario())


def test_an_annotation_with_a_quote_and_no_position_is_summarized_where_the_text_has_its_words() -> None:
    async def scenario() -> None:
        quoted: JsonObject = {"source": WAR, "selector": {"type": "TextQuoteSelector", "exact": PASSAGE}}
        world = World(view(described(WAR, name="Black Hawk War", representations=[war()]), reference(TREATY, WAR, target=quoted)))
        world.content.held[WAR] = Content(TEXT.encode(), "text/plain")
        world.inference.say("He broke the treaty.")

        response = await world.summarized()

        assert response.context == ContextualSummaryResponseContext(before=BOOK * 200, selected=PASSAGE, after=BOOK * 200)

    run(scenario())


def test_an_annotation_nothing_places_in_the_text_fails_the_request_and_no_model_is_asked() -> None:
    async def scenario() -> None:
        nowhere: JsonObject = {"source": WAR, "selector": {"type": "TextQuoteSelector", "exact": "a harvest of pumpkins"}}
        world = World(view(described(WAR, name="Black Hawk War", representations=[war()]), reference(TREATY, WAR, target=nowhere)))
        world.content.held[WAR] = Content(TEXT.encode(), "text/plain")
        with pytest.raises(Unplaced, match=r"^No selector of the annotation's target places it in the text$"):
            await world.summarized()
        assert world.inference.asked == []

    run(scenario())


def test_an_annotation_whose_target_names_another_resource_fails_the_request() -> None:
    async def scenario() -> None:
        elsewhere: JsonObject = {"source": "res-peace", "selector": {"type": "TextPositionSelector", "start": 0, "end": 3}}
        world = World(view(described(WAR, name="Black Hawk War", representations=[war()]), reference(TREATY, WAR, target=elsewhere)))
        mismatch = r"Annotation target resource ID \(res-peace\) does not match expected resource ID \(res-war\)"
        with pytest.raises(Ungathered, match=mismatch):
            await world.summarized()
        assert world.content.asked == []

    run(scenario())


def test_a_resource_with_no_view_fails_the_request() -> None:
    async def scenario() -> None:
        world = World()
        with pytest.raises(Ungathered, match=r"Resource res-war not found in view storage"):
            await world.summarized()
        assert world.inference.asked == []

    run(scenario())


def test_an_annotation_the_view_does_not_hold_fails_the_request() -> None:
    async def scenario() -> None:
        world = World(view(described(WAR, name="Black Hawk War", representations=[war()]), reference("ann-another", WAR)))
        with pytest.raises(Ungathered, match=r"Annotation not found"):
            await world.summarized()
        assert world.content.asked == []
        assert world.inference.asked == []

    run(scenario())


def test_a_text_that_is_not_there_fails_the_request() -> None:
    async def scenario() -> None:
        # A PDF's text is derived, and the gateway has none for this one yet.
        world = World(view(described(WAR, name="Black Hawk War", representations=[war("application/pdf")]), the_treaty()))
        with pytest.raises(Ungathered, match=r"Resource content not found"):
            await world.summarized()
        assert world.anchored.asked == [WAR]
        assert world.inference.asked == []

    run(scenario())


def test_a_model_that_fails_fails_the_request() -> None:
    async def scenario() -> None:
        world = World(view(described(WAR, name="Black Hawk War", representations=[war()]), the_treaty()))
        world.content.held[WAR] = Content(TEXT.encode(), "text/plain")
        world.inference.failing = RuntimeError("the model is away")
        with pytest.raises(RuntimeError, match=r"the model is away"):
            await world.summarized()

    run(scenario())
