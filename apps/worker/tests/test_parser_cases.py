"""What the worker reads from a model's reply, held to `specs/src/worker/parser-cases.json`.

It is the table every worker runs, so that one reply is read into the same
items, or refused the same way, whichever language read it. A case is one
piece of work: the whole text is asked about in one call, a stand-in provider
answers, and the worker hands on what it read or is refused with a failure.
"""

import asyncio
import json
from collections.abc import Coroutine, Sequence
from dataclasses import dataclass
from typing import Annotated, Final, Literal, assert_never, final

import pytest
from pydantic import BaseModel, Field, JsonValue
from semiont.annotations import QuotedText, TextSpan
from semiont.types import TagCategory, TagSchema
from semiont_inference.interface import ElementSchema, InferenceLimits, InferenceResponse, StructuredReadError, StructuredResponse
from semiont_inference.mock import MockInferenceClient
from spec import SPEC

from semiont_worker.detection.annotation_detection import detect_assessments, detect_comments, detect_highlights, detect_tags
from semiont_worker.detection.chunk_plan import UnderReportedPiece
from semiont_worker.detection.entity_extractor import Mention, extract_entities
from semiont_worker.detection.parsers import AssessmentMatch, CommentMatch, TagMatch
from semiont_worker.failure_class import DeterministicJobError


class Stated(BaseModel, frozen=True, extra="forbid", strict=True):
    """Something the table states: a member it does not have a place for here cannot be read, and fails."""


class Reply(Stated, frozen=True):
    text: str | None = None
    elements: list[JsonValue] | None = None
    stop_reason: Annotated[str, Field(alias="stopReason")]


class Count(Stated, frozen=True):
    text: str | None = None
    fails: Literal[True] | None = None


class StatedSpan(Stated, frozen=True):
    exact: str
    start: int
    end: int
    prefix: str | None = None
    suffix: str | None = None


class StatedComment(StatedSpan, frozen=True):
    comment: str


class StatedAssessment(StatedSpan, frozen=True):
    assessment: str


class StatedTag(StatedSpan, frozen=True):
    category: str


class StatedMention(Stated, frozen=True):
    exact: str
    entity_type: Annotated[str, Field(alias="entityType")]
    prefix: str | None = None
    suffix: str | None = None


class StatedVerdict(Stated, frozen=True):
    found: int
    counted: int
    piece_chars: Annotated[int, Field(alias="pieceChars")]


class Highlights(Stated, frozen=True):
    items: list[StatedSpan]
    dropped: int


class Comments(Stated, frozen=True):
    items: list[StatedComment]
    dropped: int


class Assessments(Stated, frozen=True):
    items: list[StatedAssessment]
    dropped: int


class Tags(Stated, frozen=True):
    items: list[StatedTag]
    dropped: int


class Mentions(Stated, frozen=True):
    items: list[StatedMention]
    dropped: int
    counted: list[int]
    under_reported: Annotated[list[StatedVerdict], Field(alias="underReported")]


class Refusal(Stated, frozen=True):
    """A failure, described as `specs/src/worker/failure-class-cases.json` describes one: its name, and its stop reason where it has one."""

    name: str
    stop_reason: Annotated[str | None, Field(alias="stopReason")] = None


class Asked(Stated, frozen=True):
    """What every case states, whatever was asked for."""

    why: str
    text: str
    reply: Reply
    calls: int
    refused: Refusal | None = None


class HighlightingCase(Asked, frozen=True):
    motivation: Literal["highlighting"]
    read: Highlights | None = None


class CommentingCase(Asked, frozen=True):
    motivation: Literal["commenting"]
    read: Comments | None = None


class AssessingCase(Asked, frozen=True):
    motivation: Literal["assessing"]
    read: Assessments | None = None


class TaggingCase(Asked, frozen=True):
    motivation: Literal["tagging"]
    category: str
    read: Tags | None = None


class LinkingCase(Asked, frozen=True):
    motivation: Literal["linking"]
    entity_type: Annotated[str, Field(alias="entityType")]
    count: Count | None = None
    count_calls: Annotated[int, Field(alias="countCalls")]
    read: Mentions | None = None


type Case = Annotated[HighlightingCase | CommentingCase | AssessingCase | TaggingCase | LinkingCase, Field(discriminator="motivation")]


class Table(Stated, frozen=True):
    comment: Annotated[str, Field(alias="$comment")]
    cases: list[Case]


TABLE: Final = Table.model_validate_json((SPEC / "worker/parser-cases.json").read_bytes())

LIMITS: Final = InferenceLimits(
    # Wide enough that a case's text is a single piece, as the table says of its provider.
    context_tokens=1_000_000,
    max_output_tokens=1_000_000,
    output_tokens_per_hour=3_600_000_000,
    # Whether the model takes a temperature is no part of a reading.
    accepts_temperature=None,
)


def reply_text(reply: Reply) -> str:
    """The reply's text: stated, or the JSON of the elements the table states."""
    assert (reply.text is None) != (reply.elements is None), "the table gives a reply its text or its elements, and not both"
    return json.dumps(reply.elements) if reply.text is None else reply.text


@final
class StandIn:
    """The table's stand-in provider.

    Calls for items go to the inference package's own mock, which reads a
    reply's text as every provider does. A count call is answered here, and
    the provider verifies yield exactly when the case scripts a count.
    """

    def __init__(self, reply: Reply, count: Count | None) -> None:
        if count is not None:
            assert (count.text is None) != (count.fails is None), "the table scripts a count's text or its failure, and not both"
        self._items: Final = MockInferenceClient([reply_text(reply)], stop_reasons=[reply.stop_reason], limits=LIMITS)
        self._count: Final = count
        self.provider: Final = self._items.provider
        self.model_id: Final = self._items.model_id
        self.max_concurrency: Final = self._items.max_concurrency
        self.verify_detection_yield: Final = count is not None
        self.count_calls = 0

    @property
    def calls(self) -> int:
        """How many times the model was asked for items."""
        return len(self._items.calls)

    async def limits(self) -> InferenceLimits:
        return await self._items.limits()

    async def generate_text(self, prompt: str, max_tokens: int, temperature: float) -> InferenceResponse:
        self.count_calls += 1
        if self._count is None or self._count.text is None:
            raise Exception("the scripted count call fails")
        return InferenceResponse(text=self._count.text, stop_reason="end_turn", usage=None)

    async def generate_structured(
        self, prompt: str, max_tokens: int, temperature: float, element_schema: ElementSchema
    ) -> StructuredResponse:
        return await self._items.generate_structured(prompt, max_tokens, temperature, element_schema)


def unheard(_consumed: int, _total: int) -> None:
    """Where a reading stands is not the table's to hold."""


@final
@dataclass(frozen=True, slots=True)
class HandedOn:
    """What the worker handed on of a case's one piece."""

    items: Sequence[TextSpan | Mention]
    dropped: int
    counted: Sequence[int] | None
    """The count of each piece whose items were accepted: of a linking call, and of no other."""
    under_reported: Sequence[UnderReportedPiece] | None
    """The verdict of each piece kept though a count said more was there: of a linking call, and of no other."""


def one_piece[P](pieces: list[P]) -> P:
    """What a case's one piece handed on. The limits make the text a single piece; more or fewer is a fault of the case."""
    assert len(pieces) == 1, f"the text was read in {len(pieces)} pieces, where a case is one"
    return pieces[0]


def schema_of(category: str) -> TagSchema:
    """A schema whose one category is the case's: a tagging call is for a category of a schema, and only the prompt reads the rest."""
    return TagSchema(
        id="case-schema",
        name="Case schema",
        description="The schema a table case tags against.",
        domain="general",
        tags=[TagCategory(name=category, description="The category a table case tags for.", examples=[])],
    )


def span_of(stated: StatedSpan) -> TextSpan:
    return TextSpan(start=stated.start, end=stated.end, exact=stated.exact, prefix=stated.prefix, suffix=stated.suffix)


def comment_of(stated: StatedComment) -> CommentMatch:
    return CommentMatch(
        start=stated.start, end=stated.end, exact=stated.exact, prefix=stated.prefix, suffix=stated.suffix, comment=stated.comment
    )


def assessment_of(stated: StatedAssessment) -> AssessmentMatch:
    return AssessmentMatch(
        start=stated.start, end=stated.end, exact=stated.exact, prefix=stated.prefix, suffix=stated.suffix, assessment=stated.assessment
    )


def tag_of(stated: StatedTag) -> TagMatch:
    return TagMatch(
        start=stated.start, end=stated.end, exact=stated.exact, prefix=stated.prefix, suffix=stated.suffix, category=stated.category
    )


def mention_of(stated: StatedMention) -> Mention:
    return Mention(quoted=QuotedText(exact=stated.exact, prefix=stated.prefix, suffix=stated.suffix), entity_type=stated.entity_type)


def verdict_of(stated: StatedVerdict) -> UnderReportedPiece:
    return UnderReportedPiece(found=stated.found, counted=stated.counted, piece_chars=stated.piece_chars)


async def highlights_read(case: HighlightingCase, client: StandIn) -> HandedOn:
    pieces: list[HandedOn] = []

    async def on_chunk_results(matches: list[TextSpan], _cursor: object, dropped: int) -> None:
        pieces.append(HandedOn(items=matches, dropped=dropped, counted=None, under_reported=None))

    await detect_highlights(
        case.text,
        client,
        instructions=None,
        density=None,
        source_language=None,
        on_activity=unheard,
        resume=None,
        on_chunk_results=on_chunk_results,
    )
    return one_piece(pieces)


async def comments_read(case: CommentingCase, client: StandIn) -> HandedOn:
    pieces: list[HandedOn] = []

    async def on_chunk_results(matches: list[CommentMatch], _cursor: object, dropped: int) -> None:
        pieces.append(HandedOn(items=matches, dropped=dropped, counted=None, under_reported=None))

    await detect_comments(
        case.text,
        client,
        instructions=None,
        tone=None,
        density=None,
        language=None,
        source_language=None,
        on_activity=unheard,
        resume=None,
        on_chunk_results=on_chunk_results,
    )
    return one_piece(pieces)


async def assessments_read(case: AssessingCase, client: StandIn) -> HandedOn:
    pieces: list[HandedOn] = []

    async def on_chunk_results(matches: list[AssessmentMatch], _cursor: object, dropped: int) -> None:
        pieces.append(HandedOn(items=matches, dropped=dropped, counted=None, under_reported=None))

    await detect_assessments(
        case.text,
        client,
        instructions=None,
        tone=None,
        density=None,
        language=None,
        source_language=None,
        on_activity=unheard,
        resume=None,
        on_chunk_results=on_chunk_results,
    )
    return one_piece(pieces)


async def tags_read(case: TaggingCase, client: StandIn) -> HandedOn:
    pieces: list[HandedOn] = []

    async def on_chunk_results(matches: list[TagMatch], _cursor: object, dropped: int) -> None:
        pieces.append(HandedOn(items=matches, dropped=dropped, counted=None, under_reported=None))

    await detect_tags(
        case.text,
        client,
        schema=schema_of(case.category),
        category=case.category,
        source_language=None,
        on_activity=unheard,
        resume=None,
        on_chunk_results=on_chunk_results,
    )
    return one_piece(pieces)


async def mentions_read(case: LinkingCase, client: StandIn) -> HandedOn:
    pieces: list[tuple[list[Mention], int]] = []
    counted: list[int] = []
    under_reported: list[UnderReportedPiece] = []

    async def on_chunk_results(mentions: list[Mention], _cursor: object, dropped: int) -> None:
        pieces.append((mentions, dropped))

    await extract_entities(
        case.text,
        [case.entity_type],
        client,
        include_descriptive_references=False,
        source_language=None,
        on_activity=unheard,
        on_under_report=under_reported.append,
        on_counted=counted.append,
        resume=None,
        on_chunk_results=on_chunk_results,
    )
    mentions, dropped = one_piece(pieces)
    return HandedOn(items=mentions, dropped=dropped, counted=counted, under_reported=under_reported)


def described(failure: Exception) -> Refusal:
    """A failure as the table describes one: its name, and its stop reason where it has one. Any other is no refusal, and is raised."""
    if isinstance(failure, StructuredReadError):
        return Refusal.model_validate({"name": "StructuredReadError", "stopReason": failure.stop_reason})
    if type(failure) is DeterministicJobError:
        return Refusal.model_validate({"name": "DeterministicJobError"})
    raise failure


def outcome_of(reading: Coroutine[None, None, HandedOn]) -> HandedOn | Refusal:
    """What a reading handed on, or the failure it was refused with, as the table describes one."""
    try:
        return asyncio.run(reading)
    except Exception as failure:
        return described(failure)


def test_the_runner_found_cases_of_every_motivation() -> None:
    cases = TABLE.cases
    assert sum(isinstance(case, HighlightingCase) for case in cases) >= 8
    assert sum(isinstance(case, CommentingCase) for case in cases) >= 4
    assert sum(isinstance(case, AssessingCase) for case in cases) >= 4
    assert sum(isinstance(case, TaggingCase) for case in cases) >= 3
    assert sum(isinstance(case, LinkingCase) for case in cases) >= 18
    assert len(cases) >= 37


@pytest.mark.parametrize("case", TABLE.cases, ids=lambda case: f"{case.motivation}: {case.why}")
def test_a_reply_is_read_or_refused_as_the_table_says(case: Case) -> None:
    assert (case.read is None) != (case.refused is None), (
        "a case states what was read, or the failure the reply was refused with, and not both"
    )
    client = StandIn(case.reply, case.count if isinstance(case, LinkingCase) else None)

    read: HandedOn | None
    match case:
        case HighlightingCase():
            read = None if case.read is None else HandedOn([span_of(item) for item in case.read.items], case.read.dropped, None, None)
            outcome = outcome_of(highlights_read(case, client))
        case CommentingCase():
            read = None if case.read is None else HandedOn([comment_of(item) for item in case.read.items], case.read.dropped, None, None)
            outcome = outcome_of(comments_read(case, client))
        case AssessingCase():
            read = None if case.read is None else HandedOn([assessment_of(item) for item in case.read.items], case.read.dropped, None, None)
            outcome = outcome_of(assessments_read(case, client))
        case TaggingCase():
            read = None if case.read is None else HandedOn([tag_of(item) for item in case.read.items], case.read.dropped, None, None)
            outcome = outcome_of(tags_read(case, client))
        case LinkingCase():
            read = (
                None
                if case.read is None
                else HandedOn(
                    [mention_of(item) for item in case.read.items],
                    case.read.dropped,
                    case.read.counted,
                    [verdict_of(verdict) for verdict in case.read.under_reported],
                )
            )
            outcome = outcome_of(mentions_read(case, client))
        case _:
            assert_never(case)

    assert outcome == (case.refused if read is None else read), case.why
    assert client.calls == case.calls, case.why
    # Only a linking call counts, and only of a provider that verifies yield.
    assert client.count_calls == (case.count_calls if isinstance(case, LinkingCase) else 0), case.why
