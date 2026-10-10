"""What a detection reads before it asks anything: the text its model is asked about, and how a span of it is built into an annotation.

Where the text comes from follows the resource's media type
(`semiont_worker.media_types`). A type whose bytes are its text is read and
decoded. A PDF's text is the Smelter's, asked for and never worked out here:
the Smelter is the one producer of a PDF's text, and a second reading would
give other offsets, and so annotations that are anchored nowhere a reader
sees. With the Smelter's text comes where each run of it is on a page.

How a span is anchored follows from which of the two it was: a span of a
text by its offsets, which count code points, and a span of a PDF by where
its words are on a page. A processor is handed the text and the builder, and
never sees a media type.
"""

from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Literal, assert_never, final

from semiont.annotations import TextSpan, annotation_of_span
from semiont.identifiers import ResourceId
from semiont.types import (
    Agent,
    AnchoredText,
    AnchoredTextAbsent,
    AnchoredTextAbsentKind,
    AnchoredTextAnswer,
    Annotation,
    AnnotationBodies,
    ExtractedText,
    ExtractionDeclined,
    ExtractionDeclinedDeclined,
    Motivation,
)

from semiont_worker.media_types import text_source_of
from semiont_worker.processors import BuildAnnotation
from semiont_worker.white_space import trimmed

type ReadText = Callable[[ResourceId], Awaitable[str]]
"""How a detection reads a resource's bytes as text: the client's `browse.resource_content`, on the gateway, as the worker's agent."""

type ConsultAnchoredText = Callable[[ResourceId], Awaitable[AnchoredTextAnswer]]
"""How a detection asks for the Smelter's text of a resource: the client's `browse.resource_anchored_text`."""

type Declined = ExtractionDeclinedDeclined | AnchoredTextAbsentKind | Literal["no-extractor", "empty"]
"""Why a detection has nothing to read.

The Smelter's own reasons for a PDF it declined, the three absences it can
answer with, and two only a reader can see: a media type with no text at
all, and a text with nothing in it.
"""


@final
@dataclass(frozen=True, slots=True)
class DetectionSource:
    """What a detection runs over: the text, and how a span of it is built into an annotation of its resource."""

    text: str
    build_annotation: BuildAnnotation


@final
@dataclass(frozen=True, slots=True)
class DetectionDecline:
    """Why a detection could not read a resource: a reason, by name."""

    declined: Declined


async def prepare_detection(
    media_type: str, read_text: ReadText, resource_id: ResourceId, generator: Agent, consult: ConsultAnchoredText
) -> DetectionSource | DetectionDecline:
    """The text of `resource_id` and how a span of it is built, or why there is none.

    `media_type` is the resource's. `generator` is the agent every
    annotation built says made it. A type with no text is declined as
    `no-extractor`, with nothing read. A PDF is asked of `consult`, once, and
    `read_text` is not called: whatever the Smelter answers but the text is
    the decline, by its name. Any other type is read with `read_text`, and
    `consult` is not asked. A text that is empty, or nothing but white space,
    is declined as `empty`.
    """
    source = text_source_of(media_type)
    match source:
        case "none":
            return DetectionDecline(declined="no-extractor")
        case "decode":
            return _anchored_by_offset(await read_text(resource_id), resource_id, generator)
        case "pdf-text-layer":
            answer = await consult(resource_id)
            match answer:
                case ExtractedText():
                    return _anchored_by_page(answer, resource_id, generator)
                case ExtractionDeclined():
                    return DetectionDecline(declined=answer.declined)
                case AnchoredTextAbsent():
                    return DetectionDecline(declined=answer.kind)
                case _:
                    assert_never(answer)
        case _:
            assert_never(source)


def _anchored_by_offset(text: str, resource_id: ResourceId, generator: Agent) -> DetectionSource | DetectionDecline:
    """A text, a span of which is anchored by its offsets."""
    if not trimmed(text):
        return DetectionDecline(declined="empty")

    def build(motivation: Motivation, span: TextSpan, body: AnnotationBodies | None) -> Annotation:
        return annotation_of_span(text, span, resource_id=resource_id, motivation=motivation, generator=generator, body=body)

    return DetectionSource(text=text, build_annotation=build)


def _anchored_by_page(anchored: AnchoredText, resource_id: ResourceId, generator: Agent) -> DetectionSource | DetectionDecline:
    """A PDF's text, a span of which is anchored by where its words are on a page."""
    if not trimmed(anchored.text):
        return DetectionDecline(declined="empty")

    def build(motivation: Motivation, span: TextSpan, body: AnnotationBodies | None) -> Annotation:
        return annotation_of_span(anchored, span, resource_id=resource_id, motivation=motivation, generator=generator, body=body)

    return DetectionSource(text=anchored.text, build_annotation=build)
