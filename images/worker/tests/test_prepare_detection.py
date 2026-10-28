"""What a detection reads before it asks anything: the resource's text, how a span of it is built into an annotation, or why there is none.

`docs/protocol/WORKER-SERVICE.md` § What a job reads and § Declines state
it. The two reads are stood in for by what answers them in the service: a
resource's bytes as text, and the Smelter's text of a PDF with where each
run of it is on a page. What is built is built for real, by the SDK's
builder, so that what follows the media type is seen: a text is anchored by
offsets, and a PDF by rectangles.
"""

from typing import Final, final

import pytest
from aio import run
from semiont.annotations import SpanRefusedError, TextSpan, target_selector
from semiont.identifiers import ResourceId
from semiont.types import (
    Agent,
    AgentSoftware,
    AnchoredTextAbsent,
    AnchoredTextAbsentKind,
    AnchoredTextAnswer,
    Annotation,
    ExtractedText,
    ExtractionDeclined,
    ExtractionDeclinedDeclined,
    FragmentSelector,
    PdfTextItem,
    Selector,
    TextPositionSelector,
    TextQuoteSelector,
)

from semiont_worker.detection.prepare_detection import DetectionDecline, DetectionSource, prepare_detection

RESOURCE: Final = ResourceId("res-prep")
GENERATOR: Final[Agent] = AgentSoftware(
    type="Software", id="did:web:test.local:agents:test:test", name="test", provider="test", model="test"
)

PDF_TEXT: Final = "alpha beta\ngamma delta"
PDF_ITEMS: Final = [
    PdfTextItem(start=0, end=5, page=1, x=72, y=720, width=40, height=12),
    PdfTextItem(start=6, end=10, page=1, x=118, y=720, width=34, height=12),
    PdfTextItem(start=11, end=16, page=1, x=72, y=700, width=45, height=12),
    PdfTextItem(start=17, end=22, page=1, x=125, y=700, width=42, height=12),
]
EXTRACTED: Final = ExtractedText(kind="extracted", text=PDF_TEXT, items=PDF_ITEMS, method="pdf-text-layer")


@final
class Reads:
    """The read of a resource's bytes as text, serving `text`."""

    def __init__(self, text: str) -> None:
        self.asked: list[ResourceId] = []
        self._text: Final = text

    async def __call__(self, resource_id: ResourceId) -> str:
        self.asked.append(resource_id)
        return self._text


@final
class Consult:
    """The read of the Smelter's text of a resource, answering `answer`."""

    def __init__(self, answer: AnchoredTextAnswer) -> None:
        self.asked: list[ResourceId] = []
        self._answer: Final = answer

    async def __call__(self, resource_id: ResourceId) -> AnchoredTextAnswer:
        self.asked.append(resource_id)
        return self._answer


def prepared(media_type: str, reads: Reads, consult: Consult) -> DetectionSource | DetectionDecline:
    return run(prepare_detection(media_type, reads, RESOURCE, GENERATOR, consult))


def source_of(prepared_: DetectionSource | DetectionDecline) -> DetectionSource:
    assert isinstance(prepared_, DetectionSource), f"the resource was declined: {prepared_}"
    return prepared_


def selectors(annotation: Annotation) -> list[Selector]:
    selector = target_selector(annotation.target)
    assert isinstance(selector, list)
    return selector


def highlight(source: DetectionSource, start: int, end: int, exact: str) -> Annotation:
    return source.build_annotation("highlighting", TextSpan(start=start, end=end, exact=exact), None)


# ── J2: `decode`, the text is the resource's bytes, read and decoded ────


@pytest.mark.parametrize("media_type", ["text/markdown", "text/plain; charset=utf-8", "application/json", "text/x-obscure-notation"])
def test_a_text_is_read_from_the_resource_s_bytes_and_a_span_of_it_is_anchored_by_its_offsets(media_type: str) -> None:
    reads, consult = Reads("alpha beta gamma"), Consult(EXTRACTED)

    source = source_of(prepared(media_type, reads, consult))

    # The Smelter publishes no text of such a type: it is not asked.
    assert (reads.asked, consult.asked) == ([RESOURCE], [])
    assert source.text == "alpha beta gamma"
    annotation = highlight(source, 0, 5, "alpha")
    assert (annotation.motivation, annotation.generator, annotation.body) == ("highlighting", GENERATOR, None)
    assert selectors(annotation) == [
        TextPositionSelector(type="TextPositionSelector", start=0, end=5),
        # The words alone: a span's context is what whoever found it states, and this one states none.
        TextQuoteSelector(type="TextQuoteSelector", exact="alpha"),
    ]
    with pytest.raises(SpanRefusedError) as refused:
        highlight(source, 0, 3, "zzz")
    assert refused.value.code == "exact-mismatch"


def test_a_span_after_a_character_outside_the_basic_multilingual_plane_is_anchored_at_a_count_of_code_points() -> None:
    # The emoji is one code point: `Ada Lovelace` is from 2 to 14, where a count of UTF-16 code units would say 3 to 15.
    source = source_of(prepared("text/markdown", Reads("\U0001f600 Ada Lovelace wrote the first algorithm."), Consult(EXTRACTED)))

    assert selectors(highlight(source, 2, 14, "Ada Lovelace"))[0] == TextPositionSelector(type="TextPositionSelector", start=2, end=14)
    with pytest.raises(SpanRefusedError) as refused:
        highlight(source, 3, 15, "Ada Lovelace")
    assert refused.value.code == "exact-mismatch"


# The next line (U+0085) has the White_Space property, and JavaScript's own trim leaves it.
@pytest.mark.parametrize("text", ["", "   \n  ", " \n\t\n   \n", "\u0085\u2003\u3000"])
def test_a_text_that_is_empty_or_nothing_but_white_space_is_declined_as_empty(text: str) -> None:
    # N1.
    assert prepared("text/markdown", Reads(text), Consult(EXTRACTED)) == DetectionDecline(declined="empty")


def test_white_space_is_unicode_s_a_text_of_a_byte_order_mark_or_of_a_separator_python_calls_space_is_a_text() -> None:
    # The byte order mark (U+FEFF) does not have the property, and JavaScript's own trim takes it. Neither does a unit
    # separator (U+001F), which Python's own strip takes.
    for text in (" \ufeff ", "\x1f"):
        assert source_of(prepared("text/markdown", Reads(text), Consult(EXTRACTED))).text == text


# ── J2: `pdf-text-layer`, the text is the Smelter's, and no bytes are read ──


def test_a_pdf_s_text_is_the_smelter_s_no_bytes_are_read_and_a_span_of_it_is_anchored_by_where_it_is_on_a_page() -> None:
    reads, consult = Reads("alpha beta gamma"), Consult(EXTRACTED)

    source = source_of(prepared("application/pdf", reads, consult))

    assert (reads.asked, consult.asked) == ([], [RESOURCE])
    assert source.text == PDF_TEXT
    annotation = highlight(source, 0, 5, "alpha")
    # D10: a rectangle for the line it is on, and its quote. No offset.
    assert selectors(annotation) == [
        FragmentSelector(type="FragmentSelector", conforms_to="http://tools.ietf.org/rfc/rfc3778", value="page=1&viewrect=72,720,40,12"),
        TextQuoteSelector(type="TextQuoteSelector", exact="alpha"),
    ]
    assert (annotation.motivation, annotation.generator) == ("highlighting", GENERATOR)


def test_a_pdf_s_runs_and_a_span_after_a_character_outside_the_basic_multilingual_plane_count_code_points() -> None:
    # `beta` is the run from 8 to 12: the emoji before it is one code point.
    text = "\U0001f600 alpha beta\ngamma delta"
    items = [
        PdfTextItem(start=0, end=1, page=1, x=60, y=720, width=10, height=12),
        PdfTextItem(start=2, end=7, page=1, x=72, y=720, width=40, height=12),
        PdfTextItem(start=8, end=12, page=1, x=118, y=720, width=34, height=12),
        PdfTextItem(start=13, end=18, page=1, x=72, y=700, width=45, height=12),
        PdfTextItem(start=19, end=24, page=1, x=125, y=700, width=42, height=12),
    ]
    extracted = ExtractedText(kind="extracted", text=text, items=items, method="pdf-text-layer")

    source = source_of(prepared("application/pdf", Reads(""), Consult(extracted)))

    fragments = [selector.value for selector in selectors(highlight(source, 8, 12, "beta")) if isinstance(selector, FragmentSelector)]
    assert fragments == ["page=1&viewrect=118,720,34,12"]


def test_a_pdf_whose_text_is_nothing_but_white_space_is_declined_as_empty() -> None:
    # N1.
    blank = ExtractedText(kind="extracted", text="  \u0085 ", items=[], method="pdf-text-layer")
    assert prepared("application/pdf", Reads("alpha"), Consult(blank)) == DetectionDecline(declined="empty")


@pytest.mark.parametrize("reason", ["encrypted", "corrupt", "no-text-layer", "too-large"])
def test_a_pdf_the_smelter_declined_is_declined_with_the_smelter_s_reason(reason: ExtractionDeclinedDeclined) -> None:
    # N2.
    reads, consult = Reads("alpha"), Consult(ExtractionDeclined(kind="declined", declined=reason))
    assert prepared("application/pdf", reads, consult) == DetectionDecline(declined=reason)
    assert reads.asked == []


@pytest.mark.parametrize("kind", ["not-yet", "no-map", "unknown"])
def test_a_pdf_the_smelter_has_no_text_of_is_declined_by_the_name_of_the_absence_and_asked_about_once(
    kind: AnchoredTextAbsentKind,
) -> None:
    # N4 and N5: `not-yet` is for a later attempt to find, and the other two will not change. Nothing is read in its place.
    reads, consult = Reads("alpha"), Consult(AnchoredTextAbsent(kind=kind))
    assert prepared("application/pdf", reads, consult) == DetectionDecline(declined=kind)
    assert (reads.asked, consult.asked) == ([], [RESOURCE])


# ── J2: `none`, the job is not done ─────────────────────────────────────


@pytest.mark.parametrize("media_type", ["application/zip", "image/png", "application/x-obscure", ""])
def test_a_type_with_no_text_is_declined_as_having_no_extractor_and_nothing_is_read(media_type: str) -> None:
    # N3: no bytes are read.
    reads, consult = Reads("alpha"), Consult(EXTRACTED)
    assert prepared(media_type, reads, consult) == DetectionDecline(declined="no-extractor")
    assert (reads.asked, consult.asked) == ([], [])
