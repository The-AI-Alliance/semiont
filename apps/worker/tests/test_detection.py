"""A detection of one kind over a text: its pieces, its calls and what it hands on.

`specs/src/worker/parser-cases.json` holds the reading of one reply to one
piece. These hold what is around it, for every kind alike: what each piece's
call asks for, what is handed on as each piece is done, where the job says it
stands, and where a unit that was left partway takes up. A linking call's
count is here too. The pieces themselves are the chunk plan's, and are cut
here as it cuts them.
"""

import asyncio
import json
import logging
import re
from collections import Counter
from collections.abc import Awaitable, Callable, Coroutine, Sequence
from dataclasses import dataclass
from typing import Final, final

import pytest
from aio import pass_time, run, under_way
from counted import counted
from opentelemetry.sdk.metrics.export import InMemoryMetricReader
from pydantic import JsonValue
from semiont.annotations import QuotedText, TextSpan, reconcile
from semiont.types import TagCategory, TagSchema, UnitCursor
from semiont_inference.interface import (
    ElementSchema,
    InferenceClient,
    InferenceLimits,
    InferenceResponse,
    StructuredResponse,
    TokenUsage,
)
from semiont_inference.mock import MockInferenceClient

from semiont_worker.chunking import Chunking, Cut, chunk_text, cut_chunk, estimate_tokens
from semiont_worker.detection.annotation_detection import detect_assessments, detect_comments, detect_highlights, detect_tags
from semiont_worker.detection.chunk_plan import ChunkCursor, DetectionBudget, UnderReportedPiece, derive_detection_budget
from semiont_worker.detection.chunk_size import CallOutcome, next_chunk_size
from semiont_worker.detection.entity_extractor import ENTITY_ELEMENT_SCHEMA, Mention, extract_entities
from semiont_worker.detection.parsers import (
    ASSESSMENT_ELEMENT_SCHEMA,
    COMMENT_ELEMENT_SCHEMA,
    HIGHLIGHT_ELEMENT_SCHEMA,
    TAG_ELEMENT_SCHEMA,
    AssessmentMatch,
    CommentMatch,
    TagMatch,
)
from semiont_worker.detection.prompts import assessment_prompt, comment_prompt, count_prompt, highlight_prompt, mention_prompt, tag_prompt
from semiont_worker.failure_class import DeterministicJobError

# Sixty sentences, each naming a marker no other names: a text of several pieces, in which a span says which piece proposed it.
TEXT: Final = " ".join(f"Sentence {n} of the survey names marker {n:03d} beside the river." for n in range(1, 61))

CLAIM: Final = TagCategory(name="Claim", description="What the text asserts", examples=["What is being asserted?"])
SCHEMA: Final = TagSchema(id="argument", name="Argument", description="What a text claims", domain="rhetoric", tags=[CLAIM])

type OnActivity = Callable[[int, int], None]
type OnChunkResults = Callable[[Sequence[TextSpan | Mention], ChunkCursor, int], Awaitable[None]]
type Detect = Callable[[str, InferenceClient, OnActivity, UnitCursor | None, OnChunkResults], Coroutine[None, None, None]]


async def highlights(text: str, client: InferenceClient, on_activity: OnActivity, resume: UnitCursor | None, kept: OnChunkResults) -> None:
    await detect_highlights(
        text,
        client,
        instructions="Mark every marker.",
        density=2.0,
        source_language="de",
        on_activity=on_activity,
        resume=resume,
        on_chunk_results=kept,
    )


async def comments(text: str, client: InferenceClient, on_activity: OnActivity, resume: UnitCursor | None, kept: OnChunkResults) -> None:
    await detect_comments(
        text,
        client,
        instructions="Explain each marker.",
        tone="scholarly",
        density=4.0,
        language="fr",
        source_language="en",
        on_activity=on_activity,
        resume=resume,
        on_chunk_results=kept,
    )


async def assessments(text: str, client: InferenceClient, on_activity: OnActivity, resume: UnitCursor | None, kept: OnChunkResults) -> None:
    await detect_assessments(
        text,
        client,
        instructions="Judge each marker.",
        tone="critical",
        density=3.0,
        language="de",
        source_language="fr",
        on_activity=on_activity,
        resume=resume,
        on_chunk_results=kept,
    )


async def tags(text: str, client: InferenceClient, on_activity: OnActivity, resume: UnitCursor | None, kept: OnChunkResults) -> None:
    await detect_tags(
        text, client, schema=SCHEMA, category="Claim", source_language="en", on_activity=on_activity, resume=resume, on_chunk_results=kept
    )


def unheard(_consumed: int, _total: int) -> None:
    """Where a detection stands, told to nobody."""


def untold(_told: object) -> None:
    """A count, or a verdict, told to nobody."""


async def mentions(text: str, client: InferenceClient, on_activity: OnActivity, resume: UnitCursor | None, kept: OnChunkResults) -> None:
    await extract_entities(
        text,
        ["Marker"],
        client,
        include_descriptive_references=True,
        source_language="en",
        on_activity=on_activity,
        on_under_report=untold,
        on_counted=untold,
        resume=resume,
        on_chunk_results=kept,
    )


@final
@dataclass(frozen=True, slots=True)
class Kind:
    """One kind of detection, as these tests ask for it: with what the job states, so that each is seen to reach the prompt."""

    label: str
    """What its calls and its anchors are counted under."""
    whose: str
    """What a reply of its kind is called where one is refused."""
    schema: ElementSchema
    prompt: Callable[[str], str]
    """The prompt around a piece, for the job `detect` asks as."""
    proposes: Callable[[str], JsonValue]
    """An element that proposes those words, as the kind requires one."""
    handed_on: Callable[[str], TextSpan | Mention]
    """What the worker hands on of that proposal: the passage where `TEXT` has it, or the mention as written."""
    detect: Detect


def span_of(words: str) -> TextSpan:
    """Where `TEXT` has `words`, which it has once. What it has either side of them is the SDK's to say, as it is for the worker."""
    found = reconcile(TEXT, QuotedText(exact=words))
    assert found is not None
    assert TEXT.count(words) == 1
    assert (found.start, found.end, found.exact) == (TEXT.index(words), TEXT.index(words) + len(words), words)
    return found


def highlight_of(words: str) -> TextSpan:
    found = span_of(words)
    return TextSpan(start=found.start, end=found.end, exact=found.exact, prefix=found.prefix, suffix=found.suffix)


def comment_of(words: str) -> CommentMatch:
    found = span_of(words)
    return CommentMatch(
        start=found.start, end=found.end, exact=found.exact, prefix=found.prefix, suffix=found.suffix, comment=f"Of {words}."
    )


def assessment_of(words: str) -> AssessmentMatch:
    found = span_of(words)
    return AssessmentMatch(
        start=found.start, end=found.end, exact=found.exact, prefix=found.prefix, suffix=found.suffix, assessment=f"Of {words}."
    )


def tag_of(words: str) -> TagMatch:
    found = span_of(words)
    return TagMatch(start=found.start, end=found.end, exact=found.exact, prefix=found.prefix, suffix=found.suffix, category="Claim")


KINDS: Final = [
    Kind(
        "highlight",
        "highlight detection",
        HIGHLIGHT_ELEMENT_SCHEMA,
        lambda piece: highlight_prompt(piece, instructions="Mark every marker.", density=2.0, source_language="de"),
        lambda words: {"exact": words},
        highlight_of,
        highlights,
    ),
    Kind(
        "comment",
        "comment detection",
        COMMENT_ELEMENT_SCHEMA,
        lambda piece: comment_prompt(
            piece, instructions="Explain each marker.", tone="scholarly", density=4.0, language="fr", source_language="en"
        ),
        lambda words: {"exact": words, "comment": f"Of {words}."},
        comment_of,
        comments,
    ),
    Kind(
        "assessment",
        "assessment detection",
        ASSESSMENT_ELEMENT_SCHEMA,
        lambda piece: assessment_prompt(
            piece, instructions="Judge each marker.", tone="critical", density=3.0, language="de", source_language="fr"
        ),
        lambda words: {"exact": words, "assessment": f"Of {words}."},
        assessment_of,
        assessments,
    ),
    Kind(
        "tag",
        "tag detection",
        TAG_ELEMENT_SCHEMA,
        lambda piece: tag_prompt(piece, SCHEMA, CLAIM, source_language="en"),
        lambda words: {"exact": words},
        tag_of,
        tags,
    ),
    Kind(
        "reference",
        "Entity extraction",
        ENTITY_ELEMENT_SCHEMA,
        lambda piece: mention_prompt(piece, ["Marker"], include_descriptive_references=True, source_language="en"),
        lambda words: {"exact": words, "entityType": "Marker", "prefix": "names "},
        lambda words: Mention(quoted=QuotedText(exact=words, prefix="names "), entity_type="Marker"),
        mentions,
    ),
]
EVERY_KIND: Final = pytest.mark.parametrize("kind", KINDS, ids=[kind.label for kind in KINDS])
TAG: Final = KINDS[3]
REFERENCE: Final = KINDS[4]


def limits_of(kind: Kind, room: int) -> InferenceLimits:
    """A model whose one window leaves `room` tokens beside the kind's prompt: a third of it is a piece, and a text over that is cut."""
    window = estimate_tokens(kind.prompt("")) + room
    return InferenceLimits(context_tokens=window, max_output_tokens=window, output_tokens_per_hour=None, accepts_temperature=None)


def budget_of(kind: Kind, limits: InferenceLimits) -> DetectionBudget:
    """The budget the chunk plan gives a unit of this kind on that model: one family of span to a call."""
    return derive_detection_budget(limits, estimate_tokens(kind.prompt("")), 1)


def cuts_of(text: str, budget: DetectionBudget, at: int, size: int) -> list[tuple[int, Cut]]:
    """The pieces the walk cuts of `text` from `at`, at one size throughout, each with the offset it was cut from.

    The size holds from piece to piece where the provider counts no tokens,
    as the mock counts none.
    """
    cuts: list[tuple[int, Cut]] = []
    while at < len(text):
        cut = cut_chunk(text, at, Chunking(chunk_size=size, overlap=budget.chunking.overlap))
        cuts.append((at, cut))
        at = cut.next
    return cuts


def last_marker(piece: str) -> str:
    """The last marker a piece names."""
    markers: list[str] = re.findall(r"marker [0-9]{3}", piece)
    return markers[-1]


def answering(replies: Sequence[Sequence[JsonValue]], limits: InferenceLimits) -> MockInferenceClient:
    """A provider that answers each call for items with the next of `replies`, as a model that finished."""
    return MockInferenceClient([json.dumps(reply) for reply in replies], stop_reasons=["end_turn"] * len(replies), limits=limits)


@final
class Kept:
    """What a detection handed on, piece by piece."""

    def __init__(self) -> None:
        self.pieces: list[tuple[list[TextSpan | Mention], ChunkCursor, int]] = []

    async def __call__(self, items: Sequence[TextSpan | Mention], cursor: ChunkCursor, dropped: int) -> None:
        self.pieces.append(([*items], cursor, dropped))


async def unkept(_items: Sequence[TextSpan | Mention], _cursor: ChunkCursor, _dropped: int) -> None:
    """What a detection handed on, kept by nobody."""


# ── what each piece's call asks for ─────────────────────────────────────


@EVERY_KIND
def test_each_piece_is_asked_about_in_the_jobs_prompt_within_the_budget_and_at_no_temperature(kind: Kind) -> None:
    limits = limits_of(kind, 600)
    budget = budget_of(kind, limits)
    cuts = cuts_of(TEXT, budget, 0, budget.chunking.chunk_size)
    assert len(cuts) >= 4, "the text is one of several pieces"
    client = answering([[]], limits)

    run(kind.detect(TEXT, client, unheard, None, unkept))

    assert [call.prompt for call in client.calls] == [kind.prompt(cut.piece) for _, cut in cuts]
    # The most a call may answer is the budget's, a detection's temperature is 0, and the answer is to be an array of the kind's element.
    assert {(call.max_tokens, call.temperature, json.dumps(call.element_schema)) for call in client.calls} == {
        (budget.bounds.output_budget, 0, json.dumps(kind.schema))
    }


# ── what is handed on ───────────────────────────────────────────────────


@EVERY_KIND
def test_what_a_piece_gave_is_handed_on_as_the_piece_is_done_with_where_the_walk_then_stands(kind: Kind) -> None:
    limits = limits_of(kind, 600)
    budget = budget_of(kind, limits)
    size = budget.chunking.chunk_size
    cuts = cuts_of(TEXT, budget, 0, size)
    # Each piece proposes the last marker it names, and one the text does not hold.
    proposed = [last_marker(cut.piece) for _, cut in cuts]
    assert len(set(proposed)) == len(proposed) >= 4
    client = answering([[kind.proposes(marker), kind.proposes("marker 999")] for marker in proposed], limits)
    kept = Kept()

    run(kind.detect(TEXT, client, unheard, None, kept))

    # A passage is anchored in the whole text, whichever piece proposed it, and one the text does not hold is counted
    # as dropped. A mention is anchored afterwards, so one the text does not hold is handed on like any other.
    nowhere: list[TextSpan | Mention] = []
    if kind is REFERENCE:
        nowhere = [Mention(quoted=QuotedText(exact="marker 999", prefix="names "), entity_type="Marker")]
    assert kept.pieces == [
        ([kind.handed_on(marker), *nowhere], ChunkCursor(next=cut.next, size=size), 0 if nowhere else 1)
        for marker, (_, cut) in zip(proposed, cuts, strict=True)
    ]
    assert kept.pieces[-1][1].next == len(TEXT)


@EVERY_KIND
def test_handing_on_is_awaited_and_a_failure_there_stops_the_walk_before_the_next_piece_is_asked_about(kind: Kind) -> None:
    limits = limits_of(kind, 600)
    client = answering([[]], limits)
    refused = RuntimeError("the record refused the batch")
    handed = 0

    async def refusing(_items: Sequence[TextSpan | Mention], _cursor: ChunkCursor, _dropped: int) -> None:
        nonlocal handed
        handed += 1
        # A turn of the loop: were it not awaited, the next piece would have been asked about by now.
        await asyncio.sleep(0)
        raise refused

    async def scenario() -> None:
        with pytest.raises(RuntimeError) as raised:
            await kind.detect(TEXT, client, unheard, None, refusing)
        assert raised.value is refused

    run(scenario())
    assert (handed, len(client.calls)) == (1, 1)


# ── where the job says it stands ────────────────────────────────────────


@EVERY_KIND
def test_a_job_says_where_it_stands_at_each_boundary_between_pieces_and_nothing_after_the_last(kind: Kind) -> None:
    limits = limits_of(kind, 600)
    budget = budget_of(kind, limits)
    cuts = cuts_of(TEXT, budget, 0, budget.chunking.chunk_size)
    stood: list[tuple[int, int]] = []

    run(kind.detect(TEXT, answering([[]], limits), lambda consumed, total: stood.append((consumed, total)), None, unkept))

    assert stood == [(cut.next, len(TEXT)) for _, cut in cuts[:-1]]


@final
class Holding:
    """A provider that answers nothing found, and holds its answer to one call until the test lets it go."""

    def __init__(self, limits: InferenceLimits, held: int) -> None:
        self.provider: Final = "ollama"
        self.model_id: Final = "held-model"
        self.max_concurrency: Final = 1
        self.verify_detection_yield: Final = False
        self.asked = 0
        self.let_go: Final = asyncio.Event()
        self._limits: Final = limits
        self._held: Final = held

    async def limits(self) -> InferenceLimits:
        return self._limits

    async def generate_text(self, prompt: str, max_tokens: int, temperature: float) -> InferenceResponse:
        raise AssertionError("a provider that does not verify yield is asked for no count")

    async def generate_structured(
        self, prompt: str, max_tokens: int, temperature: float, element_schema: ElementSchema
    ) -> StructuredResponse:
        self.asked += 1
        if self.asked == self._held:
            await self.let_go.wait()
        return StructuredResponse(items=[], stop_reason="end_turn", usage=None)


@EVERY_KIND
def test_while_a_call_is_awaited_the_job_says_every_fifteen_seconds_that_it_stands_where_the_piece_began(kind: Kind) -> None:
    limits = limits_of(kind, 600)
    budget = budget_of(kind, limits)
    cuts = cuts_of(TEXT, budget, 0, budget.chunking.chunk_size)
    (first_at, first), (second_at, _) = cuts[0], cuts[1]
    assert (first_at, second_at) == (0, first.next)

    async def scenario() -> None:
        client = Holding(limits, held=2)
        stood: list[tuple[int, int]] = []
        detecting = await under_way(kind.detect(TEXT, client, lambda consumed, total: stood.append((consumed, total)), None, unkept))
        # The first piece was answered at once, and its boundary said. The second is with the model.
        assert (client.asked, stood) == (2, [(first.next, len(TEXT))])
        await pass_time(50, step=5)
        assert stood[1:] == [(second_at, len(TEXT))] * 3
        client.let_go.set()
        await detecting
        # Once answered, the call says no more: what follows is the boundaries.
        assert stood[4:] == [(cut.next, len(TEXT)) for _, cut in cuts[1:-1]]

    run(scenario())


# ── what a piece cost ───────────────────────────────────────────────────


@final
class Costing:
    """A provider that answers nothing found, and counts each answer at as many tokens as it is told to."""

    def __init__(self, limits: InferenceLimits, written: int) -> None:
        self.provider: Final = "ollama"
        self.model_id: Final = "costing-model"
        self.max_concurrency: Final = 1
        self.verify_detection_yield: Final = False
        self.prompts: list[str] = []
        self._limits: Final = limits
        self._written: Final = written

    async def limits(self) -> InferenceLimits:
        return self._limits

    async def generate_text(self, prompt: str, max_tokens: int, temperature: float) -> InferenceResponse:
        raise AssertionError("a provider that does not verify yield is asked for no count")

    async def generate_structured(
        self, prompt: str, max_tokens: int, temperature: float, element_schema: ElementSchema
    ) -> StructuredResponse:
        self.prompts.append(prompt)
        return StructuredResponse(items=[], stop_reason="end_turn", usage=TokenUsage(input_tokens=len(prompt), output_tokens=self._written))


@EVERY_KIND
def test_what_the_provider_counted_of_a_piece_sizes_the_next(kind: Kind) -> None:
    limits = limits_of(kind, 900)
    budget = budget_of(kind, limits)
    # Every answer fills the output budget, so each piece is cut smaller than the last, down to the floor.
    client = Costing(limits, budget.bounds.output_budget)
    filled = CallOutcome(size_failed=False, output_tokens=budget.bounds.output_budget)
    cuts: list[tuple[Cut, int]] = []
    at, size = 0, budget.chunking.chunk_size
    while at < len(TEXT):
        cut = cut_chunk(TEXT, at, Chunking(chunk_size=size, overlap=budget.chunking.overlap))
        cuts.append((cut, size))
        at, size = cut.next, next_chunk_size(filled, size, budget.bounds)
    sizes = [size for _, size in cuts]
    assert sizes[0] > sizes[1] > sizes[2] >= budget.bounds.floor
    kept = Kept()

    run(kind.detect(TEXT, client, unheard, None, kept))

    assert client.prompts == [kind.prompt(cut.piece) for cut, _ in cuts]
    assert [cursor for _, cursor, _ in kept.pieces] == [ChunkCursor(next=cut.next, size=size) for cut, size in cuts]


# ── a unit taken up again ───────────────────────────────────────────────


@EVERY_KIND
def test_a_unit_left_partway_is_taken_up_where_its_cursor_stands_and_one_at_the_end_asks_nothing(kind: Kind) -> None:
    limits = limits_of(kind, 900)
    budget = budget_of(kind, limits)
    opened_at = budget.chunking.chunk_size
    left = cuts_of(TEXT, budget, 0, opened_at)[1][1].next
    # The attempt that wrote the cursor died, so its size is stepped as a size failure steps one.
    size = next_chunk_size(CallOutcome(size_failed=True, output_tokens=None), opened_at, budget.bounds)
    assert budget.bounds.floor < size < opened_at
    cuts = cuts_of(TEXT, budget, left, size)
    client = answering([[]], limits)
    kept = Kept()
    stood: list[tuple[int, int]] = []

    run(
        kind.detect(
            TEXT,
            client,
            lambda consumed, total: stood.append((consumed, total)),
            UnitCursor(next=left, size=opened_at, found=7, emitted=5, errors=2),
            kept,
        )
    )

    assert [call.prompt for call in client.calls] == [kind.prompt(cut.piece) for _, cut in cuts]
    assert [cursor for _, cursor, _ in kept.pieces] == [ChunkCursor(next=cut.next, size=size) for _, cut in cuts]
    assert stood == [(cut.next, len(TEXT)) for _, cut in cuts[:-1]]

    client = answering([[]], limits)
    kept = Kept()
    stood = []
    ended = UnitCursor(next=len(TEXT), size=opened_at, found=7, emitted=5, errors=2)
    run(kind.detect(TEXT, client, lambda consumed, total: stood.append((consumed, total)), ended, kept))
    assert (client.calls, kept.pieces, stood) == ([], [], [])


# ── a reply that is refused ─────────────────────────────────────────────


@EVERY_KIND
def test_a_reply_that_was_cut_off_is_refused_in_words_that_say_whose_it_was_and_where_its_piece_began(kind: Kind) -> None:
    limits = limits_of(kind, 600)
    budget = budget_of(kind, limits)
    # A text of one piece too small to halve: it is asked about once more, and the second cut-off reply is the job's failure.
    text = TEXT[:300]
    client = MockInferenceClient(["[]"], stop_reasons=["max_tokens"], limits=limits)

    async def scenario() -> None:
        with pytest.raises(DeterministicJobError) as refused:
            await kind.detect(text, client, unheard, None, unkept)
        assert type(refused.value) is DeterministicJobError
        assert str(refused.value).startswith(
            f"{kind.whose} response truncated (max_tokens) on the piece at offset 0 of a text of 300 code points"
        )
        assert f"the derived output budget of {budget.bounds.output_budget} tokens" in str(refused.value)

    run(scenario())
    assert len(client.calls) == 2


# ── what is told to OpenTelemetry ───────────────────────────────────────


def calls_counted(reader: InMemoryMetricReader) -> Counter[tuple[object, ...]]:
    """How many generations of a mark job have been counted so far, by everything each is filed under."""
    return counted(reader, "semiont.detection.calls", "detection.label", "detection.outcome", "detection.depth", "detection.reroll")


@EVERY_KIND
def test_a_kinds_calls_are_counted_as_that_kinds(kind: Kind, metric_reader: InMemoryMetricReader) -> None:
    limits = limits_of(kind, 600)
    budget = budget_of(kind, limits)
    pieces = len(cuts_of(TEXT, budget, 0, budget.chunking.chunk_size))
    before = calls_counted(metric_reader)
    run(kind.detect(TEXT, answering([[]], limits), unheard, None, unkept))
    assert calls_counted(metric_reader) - before == Counter({(kind.label, "success", 0, False): pieces})


# ── tagging ─────────────────────────────────────────────────────────────


def test_a_category_its_schema_does_not_have_is_refused_before_anything_is_asked_of_the_model() -> None:
    client = answering([[]], limits_of(TAG, 600))

    async def scenario() -> None:
        with pytest.raises(ValueError, match='Invalid category "Rule" for schema argument'):
            await detect_tags(
                TEXT,
                client,
                schema=SCHEMA,
                category="Rule",
                source_language=None,
                on_activity=unheard,
                resume=None,
                on_chunk_results=unkept,
            )

    run(scenario())
    assert client.calls == []


# ── linking: the count ──────────────────────────────────────────────────


@final
class Counting:
    """A provider that verifies yield: it answers each call for items from the mock it is given, and each count from a list of its own."""

    def __init__(self, items: MockInferenceClient, counts: Sequence[str | Exception]) -> None:
        self.provider: Final = items.provider
        self.model_id: Final = items.model_id
        self.max_concurrency: Final = items.max_concurrency
        self.verify_detection_yield: Final = True
        self.counts_asked: list[tuple[str, int, float]] = []
        self._items: Final = items
        self._counts: Final = counts

    async def limits(self) -> InferenceLimits:
        return await self._items.limits()

    async def generate_text(self, prompt: str, max_tokens: int, temperature: float) -> InferenceResponse:
        self.counts_asked.append((prompt, max_tokens, temperature))
        answer = self._counts[min(len(self.counts_asked), len(self._counts)) - 1]
        if isinstance(answer, Exception):
            raise answer
        return InferenceResponse(text=answer, stop_reason="end_turn", usage=None)

    async def generate_structured(
        self, prompt: str, max_tokens: int, temperature: float, element_schema: ElementSchema
    ) -> StructuredResponse:
        return await self._items.generate_structured(prompt, max_tokens, temperature, element_schema)


async def extraction(
    text: str,
    client: InferenceClient,
    entity_types: Sequence[str],
    *,
    counted: list[int],
    under_reported: list[UnderReportedPiece],
    kept: OnChunkResults,
) -> None:
    await extract_entities(
        text,
        entity_types,
        client,
        include_descriptive_references=False,
        source_language=None,
        on_activity=unheard,
        on_under_report=under_reported.append,
        on_counted=counted.append,
        resume=None,
        on_chunk_results=kept,
    )


def names_only(piece: str, entity_types: Sequence[str]) -> str:
    return mention_prompt(piece, entity_types, include_descriptive_references=False, source_language=None)


def one_piece_of(text: str, limits: InferenceLimits) -> str:
    """The one piece a linking call for `Marker` cuts of a short `text` on that model: the text, less the white space at its ends."""
    budget = derive_detection_budget(limits, estimate_tokens(names_only("", ["Marker"])), 1)
    ((_, cut),) = cuts_of(text, budget, 0, budget.chunking.chunk_size)
    return cut.piece


TIMES: Final = chr(0xD7)
"""The multiplication sign."""


def test_each_piece_of_a_provider_that_verifies_yield_is_counted_after_it_is_read_in_sixteen_tokens_and_at_no_temperature() -> None:
    scaffold = estimate_tokens(names_only("", ["Marker"]))
    limits = InferenceLimits(
        context_tokens=scaffold + 600, max_output_tokens=scaffold + 600, output_tokens_per_hour=None, accepts_temperature=None
    )
    budget = derive_detection_budget(limits, scaffold, 1)
    cuts = cuts_of(TEXT, budget, 0, budget.chunking.chunk_size)
    client = Counting(answering([[{"exact": "marker 001", "entityType": "Marker"}]], limits), ["1"])
    counted: list[int] = []
    under_reported: list[UnderReportedPiece] = []

    run(extraction(TEXT, client, ["Marker"], counted=counted, under_reported=under_reported, kept=unkept))

    assert client.counts_asked == [(count_prompt(cut.piece, ["Marker"]), 16, 0) for _, cut in cuts]
    assert (counted, under_reported) == ([1] * len(cuts), [])


def test_a_call_for_several_entity_types_asks_and_counts_them_together_in_pieces_sized_for_as_many() -> None:
    types = ["Marker", "River"]
    scaffold = estimate_tokens(names_only("", types))
    limits = InferenceLimits(
        context_tokens=scaffold + 900, max_output_tokens=scaffold + 900, output_tokens_per_hour=None, accepts_temperature=None
    )
    # A reply repeats each span of the text for each type asked for, so the text a call may carry is that many times smaller.
    budget = derive_detection_budget(limits, scaffold, 2)
    assert budget.chunking.chunk_size < derive_detection_budget(limits, scaffold, 1).chunking.chunk_size
    cuts = cuts_of(TEXT, budget, 0, budget.chunking.chunk_size)
    reply: list[JsonValue] = [
        {"exact": "marker 001", "entityType": "Marker"},
        {"exact": "the river", "entityType": "River"},
        {"exact": "the survey", "entityType": "Survey"},
    ]
    items = answering([reply], limits)
    client = Counting(items, ["3"])
    kept = Kept()

    run(extraction(TEXT, client, types, counted=[], under_reported=[], kept=kept))

    assert [call.prompt for call in items.calls] == [names_only(cut.piece, types) for _, cut in cuts]
    assert [prompt for prompt, _, _ in client.counts_asked] == [count_prompt(cut.piece, types) for _, cut in cuts]
    # Either type asked for is an item. One that was not is none, and is counted as dropped.
    assert {
        (tuple(mention.entity_type for mention in handed if isinstance(mention, Mention)), dropped) for handed, _, dropped in kept.pieces
    } == {(("Marker", "River"), 1)}


def test_what_a_reply_found_is_every_element_it_has_whether_or_not_each_is_a_mention_of_the_type() -> None:
    limits = limits_of(REFERENCE, 600)
    text = TEXT[:300]
    piece = one_piece_of(text, limits)
    reply: list[JsonValue] = [{"exact": "marker 001", "entityType": "Marker"}, {"exact": 7}, {"exact": "marker 002", "entityType": "River"}]

    def read(count: str) -> tuple[list[int], list[UnderReportedPiece], int]:
        client = Counting(answering([reply], limits), [count])
        counted: list[int] = []
        under_reported: list[UnderReportedPiece] = []
        kept = Kept()
        run(extraction(text, client, ["Marker"], counted=counted, under_reported=under_reported, kept=kept))
        ((handed, _, dropped),) = kept.pieces
        assert handed == [Mention(quoted=QuotedText(exact="marker 001"), entity_type="Marker")]
        return counted, under_reported, dropped

    # Three elements: twice three is not less than six, and is less than seven.
    assert read("6") == ([6], [], 1)
    assert read("7") == ([7], [UnderReportedPiece(found=3, counted=7, piece_chars=len(piece))], 1)


def test_a_count_ends_before_the_first_comma_group_that_is_not_of_three_digits_and_no_more() -> None:
    # `specs/src/worker/parser-cases.json` holds `1,2345` as 1. It has no case of the last line here: groups before the one that ends it.
    limits = limits_of(REFERENCE, 600)
    found: list[JsonValue] = [{"exact": "marker 001", "entityType": "Marker"}]

    def read(count: str) -> tuple[list[int], int]:
        counted: list[int] = []
        under_reported: list[UnderReportedPiece] = []
        run(
            extraction(
                TEXT[:300],
                Counting(answering([found], limits), [count]),
                ["Marker"],
                counted=counted,
                under_reported=under_reported,
                kept=unkept,
            )
        )
        return counted, len(under_reported)

    assert read("1,234") == ([1234], 1)
    assert read("1,2345") == ([1], 0)
    # The groups that are of three digits and no more are still the number's: it ends before the one that is not.
    assert read("12,345,6789 or so") == ([12345], 1)


def test_a_reply_that_found_under_half_the_count_of_a_piece_that_can_be_cut_smaller_is_asked_again_in_smaller_pieces() -> None:
    scaffold = estimate_tokens(names_only("", ["Marker"]))
    limits = InferenceLimits(
        context_tokens=scaffold + 1200, max_output_tokens=scaffold + 1200, output_tokens_per_hour=None, accepts_temperature=None
    )
    budget = derive_detection_budget(limits, scaffold, 1)
    size, overlap = budget.chunking.chunk_size, budget.chunking.overlap
    assert size // 2 > budget.bounds.floor
    # The first piece of the long text, as a text of its own: one piece of the walk, and one that halves.
    text = cut_chunk(TEXT, 0, Chunking(chunk_size=size, overlap=overlap)).piece
    assert [cut.piece for _, cut in cuts_of(text, budget, 0, size)] == [text]
    halves = chunk_text(text, Chunking(chunk_size=size // 2, overlap=overlap))
    assert len(halves) >= 2
    items = answering([[{"exact": "marker 001", "entityType": "Marker"}]], limits)
    # The whole piece is counted at ten, of which one was found. Each smaller piece is counted at one.
    client = Counting(items, ["10", "1"])
    counted: list[int] = []
    under_reported: list[UnderReportedPiece] = []
    kept = Kept()

    run(extraction(text, client, ["Marker"], counted=counted, under_reported=under_reported, kept=kept))

    assert [call.prompt for call in items.calls] == [names_only(asked, ["Marker"]) for asked in (text, *halves)]
    assert [prompt for prompt, _, _ in client.counts_asked] == [count_prompt(asked, ["Marker"]) for asked in (text, *halves)]
    # The piece that descended tells no count: its smaller pieces' stand in its place. Nothing was kept under-reported.
    assert (counted, under_reported) == ([1] * len(halves), [])
    # And what it found is not kept: what the smaller pieces found is the piece's.
    mention = Mention(quoted=QuotedText(exact="marker 001"), entity_type="Marker")
    assert kept.pieces == [([mention] * len(halves), ChunkCursor(next=len(text), size=size), 0)]


def test_a_collapse_kept_says_what_was_found_and_counted_over_how_long_a_piece_and_what_was_found_is_handed_on(
    caplog: pytest.LogCaptureFixture,
) -> None:
    caplog.set_level(logging.DEBUG, logger="semiont_worker")
    limits = limits_of(REFERENCE, 600)
    # A character outside the Basic Multilingual Plane is one code point of a piece's length, and two UTF-16 code units.
    text = chr(0x1F600) + " " + TEXT[:298]
    piece = one_piece_of(text, limits)
    assert len(piece.encode("utf-16-le")) // 2 == len(piece) + 1
    client = Counting(answering([[{"exact": "marker 001", "entityType": "Marker"}]], limits), ["9"])
    counted: list[int] = []
    under_reported: list[UnderReportedPiece] = []
    kept = Kept()

    run(extraction(text, client, ["Marker"], counted=counted, under_reported=under_reported, kept=kept))

    assert (counted, under_reported) == ([9], [UnderReportedPiece(found=1, counted=9, piece_chars=len(piece))])
    ((handed, _, dropped),) = kept.pieces
    assert (handed, dropped) == ([Mention(quoted=QuotedText(exact="marker 001"), entity_type="Marker")], 0)
    # The piece is too small to halve, so the descent keeps it, and says why in the words of the failure it was handed.
    (warned,) = said(caplog, "Floor-size piece still flagged as collapsed — accepting its under-reported salvage and continuing")
    assert vars(warned)["error"] == (
        f"Extraction found 1 entities where a count call reports ~9 mentions (band {TIMES}2) on a chunk of {len(piece)} code points "
        "— silent yield collapse: deterministic — a same-size retry returns the identical under-report."
    )


# ── linking: what is said ───────────────────────────────────────────────


def said(caplog: pytest.LogCaptureFixture, message: str) -> list[logging.LogRecord]:
    return [record for record in caplog.records if record.name == "semiont_worker" and record.getMessage() == message]


def test_an_extraction_says_what_it_opens_with_and_what_each_reply_carried(caplog: pytest.LogCaptureFixture) -> None:
    caplog.set_level(logging.DEBUG, logger="semiont_worker")
    limits = limits_of(REFERENCE, 600)
    budget = budget_of(REFERENCE, limits)
    size = budget.chunking.chunk_size
    cuts = cuts_of(TEXT, budget, 0, size)

    run(REFERENCE.detect(TEXT, answering([[REFERENCE.proposes("marker 001"), None]], limits), unheard, None, unkept))

    (sending,) = said(caplog, "Sending entity extraction request")
    assert sending.levelno == logging.DEBUG
    opening = ("entityTypes", "chars", "openingChunkSizeTokens", "ceilingChunkSizeTokens", "outputBudget")
    assert {key: vars(sending)[key] for key in opening} == {
        "entityTypes": "Marker",
        "chars": len(TEXT),
        "openingChunkSizeTokens": size,
        "ceilingChunkSizeTokens": budget.bounds.ceiling,
        "outputBudget": budget.bounds.output_budget,
    }
    got = said(caplog, "Got entity extraction response")
    carried = ("at", "totalChars", "chunkSizeTokens", "pieceChars", "items")
    assert [{key: vars(record)[key] for key in carried} for record in got] == [
        {"at": at, "totalChars": len(TEXT), "chunkSizeTokens": size, "pieceChars": len(cut.piece), "items": 2} for at, cut in cuts
    ]
    assert {record.levelno for record in got} == {logging.DEBUG}


def test_an_element_that_is_no_mention_is_whispered_of_and_a_mention_of_another_type_is_warned_of(caplog: pytest.LogCaptureFixture) -> None:
    caplog.set_level(logging.DEBUG, logger="semiont_worker")
    limits = limits_of(REFERENCE, 600)
    reply: list[JsonValue] = [{"exact": "marker 001"}, {"exact": "the river", "entityType": "River"}]

    run(extraction(TEXT[:300], answering([reply], limits), ["Marker"], counted=[], under_reported=[], kept=unkept))

    (malformed,) = said(caplog, "Dropped malformed LLM entity")
    assert (malformed.levelno, vars(malformed)["entity"]) == (logging.DEBUG, {"exact": "marker 001"})
    (other,) = said(caplog, "Mention dropped — not of an entity type that was asked for")
    assert (other.levelno, vars(other)["text"], vars(other)["entityType"]) == (logging.WARNING, "the river", "River")


def test_a_count_that_fails_or_answers_no_number_is_warned_of_and_checks_nothing(caplog: pytest.LogCaptureFixture) -> None:
    caplog.set_level(logging.DEBUG, logger="semiont_worker")
    limits = limits_of(REFERENCE, 600)
    text = TEXT[:300]
    piece = one_piece_of(text, limits)

    for count in (RuntimeError("the provider went away"), "I cannot count them."):
        counted: list[int] = []
        under_reported: list[UnderReportedPiece] = []
        run(
            extraction(
                text, Counting(answering([[]], limits), [count]), ["Marker"], counted=counted, under_reported=under_reported, kept=unkept
            )
        )
        assert (counted, under_reported) == ([], [])

    (failed,) = said(caplog, "Count-verifier call failed — yield check skipped for this chunk")
    assert (failed.levelno, vars(failed)["pieceChars"], vars(failed)["error"]) == (logging.WARNING, len(piece), "the provider went away")
    (no_number,) = said(caplog, "Count-verifier answer carried no number — yield check skipped for this chunk")
    assert (no_number.levelno, vars(no_number)["pieceChars"]) == (logging.WARNING, len(piece))


def test_a_count_its_caller_cancels_is_no_count_that_failed_the_cancellation_passes() -> None:
    limits = limits_of(REFERENCE, 600)

    @final
    class Waiting:
        """A provider that verifies yield, and never answers a count."""

        def __init__(self) -> None:
            self.provider: Final = "ollama"
            self.model_id: Final = "waiting-model"
            self.max_concurrency: Final = 1
            self.verify_detection_yield: Final = True
            self.counting: Final = asyncio.Event()

        async def limits(self) -> InferenceLimits:
            return limits

        async def generate_text(self, prompt: str, max_tokens: int, temperature: float) -> InferenceResponse:
            self.counting.set()
            await asyncio.Event().wait()
            raise AssertionError("a count that is never answered")

        async def generate_structured(
            self, prompt: str, max_tokens: int, temperature: float, element_schema: ElementSchema
        ) -> StructuredResponse:
            return StructuredResponse(items=[], stop_reason="end_turn", usage=None)

    async def scenario() -> None:
        client = Waiting()
        kept = Kept()
        extracting = await under_way(extraction(TEXT[:300], client, ["Marker"], counted=[], under_reported=[], kept=kept))
        assert client.counting.is_set()
        extracting.cancel()
        with pytest.raises(asyncio.CancelledError):
            await extracting
        assert kept.pieces == []

    run(scenario())
