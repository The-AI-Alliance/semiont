"""How the worker plans the pieces of a text, held to `specs/src/worker/chunk-plan-cases.json`.

It is the table every worker runs, so that one text under one budget is asked
about in the same pieces, and a failed piece is asked again the same way,
whichever language planned it.
"""

import asyncio
import re
from collections.abc import Coroutine
from typing import Annotated, Final, Literal

import pytest
from pydantic import BaseModel, Field, JsonValue
from semiont.types import UnitCursor
from semiont_inference.interface import InferenceLimits, StructuredReadError, TokenUsage
from spec import SPEC

from semiont_worker.chunking import Chunking
from semiont_worker.detection.chunk_plan import (
    AdaptiveChunk,
    ChunkCallResult,
    DetectionBudget,
    SubdividedCall,
    UnderReportedPiece,
    YieldCollapseError,
    call_chunk_subdividing,
    derive_detection_budget,
    run_adaptive_chunks,
)
from semiont_worker.detection.chunk_size import CHUNK_SIZING_POLICY, CallOutcome, ChunkSizingPolicy, SizingBounds, next_chunk_size
from semiont_worker.failure_class import DeterministicJobError
from semiont_worker.inference_call import InferenceTimeoutError


class Stated(BaseModel, frozen=True, extra="forbid", strict=True):
    """Something the table states: a member it does not have a place for here cannot be read, and fails."""


class StatedLimits(Stated, frozen=True):
    context_tokens: Annotated[int, Field(alias="contextTokens")]
    max_output_tokens: Annotated[int, Field(alias="maxOutputTokens")]
    output_tokens_per_hour: Annotated[int | None, Field(alias="outputTokensPerHour")] = None


class StatedBounds(Stated, frozen=True):
    floor: int
    ceiling: int
    output_budget: Annotated[int, Field(alias="outputBudget")]


class StatedBudget(StatedBounds, frozen=True):
    size: int
    overlap: int


class StatedOutcome(Stated, frozen=True):
    size_failed: Annotated[bool, Field(alias="sizeFailed")]
    output_tokens: Annotated[int | None, Field(alias="outputTokens")] = None


class StatedVerdict(Stated, frozen=True):
    found: int
    counted: int
    piece_chars: Annotated[int, Field(alias="pieceChars")]


class StatedFailure(Stated, frozen=True):
    """A failure, described as `specs/src/worker/failure-class-cases.json` describes one, with what a yield collapse carries."""

    name: str
    stop_reason: Annotated[str | None, Field(alias="stopReason")] = None
    salvage: list[JsonValue] | None = None
    verdict: StatedVerdict | None = None


class StatedSizing(Stated, frozen=True):
    grow_below: Annotated[float, Field(alias="growBelow")]
    shrink_above: Annotated[float, Field(alias="shrinkAbove")]
    grow_factor: Annotated[float, Field(alias="growFactor")]
    shrink_factor: Annotated[float, Field(alias="shrinkFactor")]


class BudgetCase(Stated, frozen=True):
    kind: Literal["budget"]
    why: str
    limits: StatedLimits
    scaffold_tokens: Annotated[int, Field(alias="scaffoldTokens")]
    types_per_call: Annotated[int, Field(alias="typesPerCall")]
    budget: StatedBudget | None = None
    refused: StatedFailure | None = None


class StepCase(Stated, frozen=True):
    kind: Literal["step"]
    why: str
    size: int
    outcome: StatedOutcome
    bounds: StatedBounds
    next_size: Annotated[int, Field(alias="nextSize")]


class StatedPiece(Stated, frozen=True):
    at: int
    to: int
    size: int
    next: int


class Fails(Stated, frozen=True):
    fails: Literal[True]


class WalkCase(Stated, frozen=True):
    kind: Literal["walk"]
    why: str
    text: str
    budget: StatedBudget
    resume: UnitCursor | None = None
    outcomes: list[StatedOutcome | Fails]
    pieces: list[StatedPiece]
    completes: bool


class Answers(Stated, frozen=True):
    items: list[JsonValue]
    output_tokens: Annotated[int | None, Field(alias="outputTokens")] = None
    counted: int | None = None


class FailsWith(Stated, frozen=True):
    fails: StatedFailure


class StatedResult(Stated, frozen=True):
    items: list[JsonValue]
    size_failed: Annotated[bool, Field(alias="sizeFailed")]
    output_tokens: Annotated[int | None, Field(alias="outputTokens")] = None
    counted: list[int]
    under_reported: Annotated[list[StatedVerdict], Field(alias="underReported")]


class DescentCase(Stated, frozen=True):
    kind: Literal["descent"]
    why: str
    piece: str
    size: int
    overlap: int
    replies: list[Answers | FailsWith]
    asked: list[tuple[int, int]]
    result: StatedResult | None = None
    raises: int | None = None


type Case = Annotated[BudgetCase | StepCase | WalkCase | DescentCase, Field(discriminator="kind")]


class Table(Stated, frozen=True):
    comment: Annotated[str, Field(alias="$comment")]
    sizing: StatedSizing
    cases: list[Case]


TABLE: Final = Table.model_validate_json((SPEC / "worker/chunk-plan-cases.json").read_bytes())
BUDGETS: Final = [case for case in TABLE.cases if isinstance(case, BudgetCase)]
STEPS: Final = [case for case in TABLE.cases if isinstance(case, StepCase)]
WALKS: Final = [case for case in TABLE.cases if isinstance(case, WalkCase)]
DESCENTS: Final = [case for case in TABLE.cases if isinstance(case, DescentCase)]

SAID: Final = "scripted by the table"


def bounds_of(stated: StatedBounds) -> SizingBounds:
    return SizingBounds(floor=stated.floor, ceiling=stated.ceiling, output_budget=stated.output_budget)


def budget_of(stated: StatedBudget) -> DetectionBudget:
    return DetectionBudget(chunking=Chunking(chunk_size=stated.size, overlap=stated.overlap), bounds=bounds_of(stated))


def outcome_of(stated: StatedOutcome) -> CallOutcome:
    return CallOutcome(size_failed=stated.size_failed, output_tokens=stated.output_tokens)


def verdict_of(stated: StatedVerdict) -> UnderReportedPiece:
    return UnderReportedPiece(found=stated.found, counted=stated.counted, piece_chars=stated.piece_chars)


def failure_of(described: StatedFailure) -> Exception:
    """The failure a case describes: the worker's or the driver's own of the kind the table names, and a plain one for `Error`."""
    if described.name != "StructuredReadError":
        assert described.stop_reason is None, f"the table gives a stop reason to {described.name}, which carries none"
    if described.name != "YieldCollapseError":
        assert described.salvage is None, f"the table gives a salvage to {described.name}, which carries none"
        assert described.verdict is None, f"the table gives a verdict to {described.name}, which carries none"
    match described.name:
        case "InferenceTimeoutError":
            return InferenceTimeoutError(SAID)
        case "DeterministicJobError":
            return DeterministicJobError(SAID)
        case "StructuredReadError":
            assert described.stop_reason is not None, "the table describes a StructuredReadError with no stop reason"
            return StructuredReadError(SAID, described.stop_reason)
        case "YieldCollapseError":
            assert described.salvage is not None, "the table describes a YieldCollapseError without its salvage"
            assert described.verdict is not None, "the table describes a YieldCollapseError without its verdict"
            return YieldCollapseError(SAID, described.salvage, verdict_of(described.verdict))
        case "Error":
            return Exception(SAID)
        case _:
            pytest.fail(f"the table describes a failure this runner cannot raise: {described.name}")


def raised_by(work: Coroutine[None, None, object]) -> Exception | None:
    """What running `work` to its end raised, or nothing where it raised nothing."""
    try:
        asyncio.run(work)
    except Exception as failure:
        return failure
    return None


def test_the_runner_found_cases_of_every_kind() -> None:
    assert len(BUDGETS) >= 10
    assert len(STEPS) >= 15
    assert len(WALKS) >= 12
    assert len(DESCENTS) >= 19
    assert len(BUDGETS) + len(STEPS) + len(WALKS) + len(DESCENTS) == len(TABLE.cases)


def test_the_table_states_the_sizing_the_worker_steps_by() -> None:
    stated = TABLE.sizing
    assert (
        ChunkSizingPolicy(
            grow_below=stated.grow_below,
            shrink_above=stated.shrink_above,
            grow_factor=stated.grow_factor,
            shrink_factor=stated.shrink_factor,
        )
        == CHUNK_SIZING_POLICY
    )


@pytest.mark.parametrize("case", BUDGETS, ids=lambda case: case.why)
def test_a_unit_opens_with_the_budget_the_table_gives(case: BudgetCase) -> None:
    limits = InferenceLimits(
        context_tokens=case.limits.context_tokens,
        max_output_tokens=case.limits.max_output_tokens,
        output_tokens_per_hour=case.limits.output_tokens_per_hour,
        # Whether the model takes a temperature is no part of a budget.
        accepts_temperature=None,
    )
    if case.refused is None:
        assert case.budget is not None, "a budget case states the budget, or the failure the window is refused with"
        assert derive_detection_budget(limits, case.scaffold_tokens, case.types_per_call) == budget_of(case.budget), case.why
        return
    assert case.budget is None, "a budget case states the budget, or the failure the window is refused with, and not both"
    # A refusal is described as the table of failure classes describes one: by the kind of failure it is.
    described = type(failure_of(case.refused))
    with pytest.raises(described) as refusal:
        derive_detection_budget(limits, case.scaffold_tokens, case.types_per_call)
    assert type(refusal.value) is described, case.why


def test_a_window_refused_says_what_it_was_and_what_it_left() -> None:
    limits = InferenceLimits(context_tokens=694, max_output_tokens=694, output_tokens_per_hour=None, accepts_temperature=None)
    with pytest.raises(DeterministicJobError, match="window too small") as refusal:
        derive_detection_budget(limits, 500, 1)
    # The window, the prompt around the text, what the two leave the text, and what it must have more than.
    assert [int(number) for number in re.findall(r"[0-9]+", str(refusal.value))] == [694, 500, 64, 64]


@pytest.mark.parametrize("case", STEPS, ids=lambda case: case.why)
def test_the_next_piece_is_the_size_the_table_gives(case: StepCase) -> None:
    assert next_chunk_size(outcome_of(case.outcome), case.size, bounds_of(case.bounds)) == case.next_size, case.why


@pytest.mark.parametrize("case", WALKS, ids=lambda case: case.why)
def test_a_text_is_walked_in_the_pieces_the_table_gives(case: WalkCase) -> None:
    handed: list[AdaptiveChunk] = []
    failure = Exception("the piece fails, as the table scripts")

    async def on_chunk(chunk: AdaptiveChunk) -> CallOutcome:
        answered = len(handed)
        handed.append(chunk)
        assert answered < len(case.outcomes), "the walk cut more pieces than the table scripts outcomes for"
        scripted = case.outcomes[answered]
        if isinstance(scripted, Fails):
            raise failure
        return outcome_of(scripted)

    stopped_by = raised_by(run_adaptive_chunks(case.text, budget_of(case.budget), on_chunk, case.resume))
    assert stopped_by is (None if case.completes else failure), case.why

    # The table's positions are offsets: they count the text's code points, as a string's own indices do.
    assert handed == [
        AdaptiveChunk(piece=case.text[piece.at : piece.to], size=piece.size, at=piece.at, next=piece.next, total_chars=len(case.text))
        for piece in case.pieces
    ], case.why
    assert len(handed) == len(case.outcomes), case.why


@pytest.mark.parametrize("case", DESCENTS, ids=lambda case: case.why)
def test_a_piece_is_asked_about_and_descended_into_as_the_table_says(case: DescentCase) -> None:
    failures = [failure_of(reply.fails) if isinstance(reply, FailsWith) else None for reply in case.replies]
    asked: list[str] = []

    async def call(piece: str) -> ChunkCallResult:
        made = len(asked)
        asked.append(piece)
        assert made < len(case.replies), "the descent made more calls than the table scripts replies for"
        reply, failure = case.replies[made], failures[made]
        if failure is not None:
            raise failure
        assert isinstance(reply, Answers)
        # What the provider counted of what it was sent is not scripted: nothing in a plan reads it.
        usage = None if reply.output_tokens is None else TokenUsage(input_tokens=0, output_tokens=reply.output_tokens)
        return ChunkCallResult(items=reply.items, usage=usage, counted=reply.counted)

    counted: list[int] = []
    under_reported: list[UnderReportedPiece] = []
    # A descent of the table is no kind of job's more than another's: the label is only what telemetry files its calls under.
    descent = call_chunk_subdividing(
        "highlight", case.piece, Chunking(chunk_size=case.size, overlap=case.overlap), call, under_reported.append, counted.append
    )
    if case.raises is None:
        assert case.result is not None, "a descent case states its result, or the reply whose failure it raises"
        assert asyncio.run(descent) == SubdividedCall(
            items=case.result.items,
            outcome=CallOutcome(size_failed=case.result.size_failed, output_tokens=case.result.output_tokens),
        ), case.why
        # What the descent told as it went: the count of each piece it accepted, and the verdict of each it kept though under-reported.
        assert counted == case.result.counted, case.why
        assert under_reported == [verdict_of(verdict) for verdict in case.result.under_reported], case.why
    else:
        assert case.result is None, "a descent case states its result, or the reply whose failure it raises, and not both"
        raised = failures[case.raises]
        assert raised is not None, "the table says the descent raises a reply that scripts no failure"
        assert raised_by(descent) is raised, case.why

    # A span of the piece is two offsets: they count its code points.
    assert asked == [case.piece[start:end] for start, end in case.asked], case.why
    assert len(asked) == len(case.replies), case.why
