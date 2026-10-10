"""What no case table reaches of the plan of a text's pieces.

The check that a reply was not cut off; the cursor a piece leaves; and what a
descent tells as it goes: its caller of each count and each piece kept though
under-reported, whoever reads the service's log, and OpenTelemetry of every
call it makes (the `semiont.detection.call*` rows of
`specs/src/service-telemetry/telemetry.json`).
"""

import asyncio
import dataclasses
import logging
import re
from collections import Counter
from collections.abc import Awaitable, Callable
from typing import Final, get_args

import pytest
from aio import run, turns
from opentelemetry.sdk.metrics.export import Histogram, HistogramDataPoint, InMemoryMetricReader, Metric, NumberDataPoint, Sum
from pydantic import JsonValue
from semiont.types import UnitCursor
from semiont_inference.interface import StructuredReadError, TokenUsage
from telemetry_rows import as_the_table_writes, worker_metrics

from semiont_worker.chunking import Chunking
from semiont_worker.detection.chunk_plan import (
    ChunkCallResult,
    ChunkCursor,
    UnderReportedPiece,
    YieldCollapseError,
    assert_not_truncated,
    call_chunk_subdividing,
)
from semiont_worker.failure_class import DeterministicJobError, classify_failure
from semiont_worker.inference_call import InferenceTimeoutError
from semiont_worker.telemetry import DetectionLabel, DetectionOutcome

# A piece its size's half still cuts in two or more, and that is over the size floor: one that can descend.
CHUNK: Final = "".join(f"passage {number} lorem ipsum dolor sit amet " for number in range(200))
CHUNKING: Final = Chunking(chunk_size=1000, overlap=16)
# A piece too small to halve: half its size is under the size floor.
SMALL: Final = "a" * 400
SMALL_CHUNKING: Final = Chunking(chunk_size=8, overlap=16)

type Call = Callable[[str], Awaitable[ChunkCallResult]]


def answering(items: list[JsonValue], usage: TokenUsage | None, counted: int | None) -> Call:
    async def call(piece: str) -> ChunkCallResult:
        return ChunkCallResult(items=items, usage=usage, counted=counted)

    return call


def failing(failure: Exception) -> Call:
    async def call(piece: str) -> ChunkCallResult:
        raise failure

    return call


def failing_whole(failure: Exception, whole: str, then: ChunkCallResult) -> Call:
    """Fails for the whole piece, and answers `then` for any smaller one."""

    async def call(piece: str) -> ChunkCallResult:
        if piece == whole:
            raise failure
        return then

    return call


def failing_once(failure: Exception, then: ChunkCallResult) -> Call:
    """Fails the first time it is asked, and answers `then` after."""
    asked: list[str] = []

    async def call(piece: str) -> ChunkCallResult:
        asked.append(piece)
        if len(asked) == 1:
            raise failure
        return then

    return call


def raised_by(work: Awaitable[object]) -> Exception | None:
    """What awaiting `work` raised, or nothing where it raised nothing."""

    async def awaited() -> None:
        await work

    try:
        run(awaited())
    except Exception as failure:
        return failure
    return None


NOTHING: Final = ChunkCallResult(items=[], usage=None, counted=None)
CUT_OFF: Final = DeterministicJobError("truncated (max_tokens)")


# ── the check that a reply was not cut off ──────────────────────────────


def test_a_reply_that_was_cut_off_fails_as_one_that_cannot_succeed_again_and_says_where() -> None:
    with pytest.raises(DeterministicJobError) as cut_off:
        assert_not_truncated("max_tokens", "highlight detection", 704, 2816, 5128)
    assert type(cut_off.value) is DeterministicJobError
    assert classify_failure(cut_off.value) == "deterministic"
    said = str(cut_off.value)
    assert said.startswith("highlight detection response truncated (max_tokens)")
    # The offset of the piece, the length of the text, and the output budget the reply was cut off despite.
    assert [int(number) for number in re.findall(r"[0-9]+", said)] == [704, 2816, 5128]


@pytest.mark.parametrize("stop_reason", ["end_turn", "stop_sequence", "unknown"])
def test_a_reply_that_was_not_cut_off_is_let_through(stop_reason: str) -> None:
    assert_not_truncated(stop_reason, "highlight detection", 704, 2816, 5128)


# ── the cursor a piece leaves ───────────────────────────────────────────


def test_a_chunk_cursor_is_where_a_units_cursor_stands_and_how_it_cuts_and_none_of_its_tallies() -> None:
    ours = {field.name: field.type for field in dataclasses.fields(ChunkCursor)}
    theirs = {name: field.annotation for name, field in UnitCursor.model_fields.items()}
    assert ours == {name: theirs[name] for name in ("next", "size")}
    # What a unit's cursor has beside them is counted by whoever makes the annotations. A member the spec
    # gives a cursor fails here until someone says whose it is.
    assert set(theirs) - set(ours) == {"found", "emitted", "errors"}


# ── what a descent tells its caller as it goes ──────────────────────────


def test_a_count_is_told_as_its_piece_is_accepted_though_a_later_piece_then_fails() -> None:
    told: list[int] = []
    broke = RuntimeError("the provider went away")
    asked: list[str] = []

    async def call(piece: str) -> ChunkCallResult:
        asked.append(piece)
        if len(asked) == 1:
            raise InferenceTimeoutError("bound")
        if len(asked) == 2:
            return ChunkCallResult(items=["x"], usage=None, counted=7)
        raise broke

    assert raised_by(call_chunk_subdividing("reference", CHUNK, CHUNKING, call, None, told.append)) is broke
    assert len(asked) == 3
    assert told == [7]


def test_a_piece_kept_though_under_reported_is_told_with_its_verdict_and_its_count() -> None:
    verdict = UnderReportedPiece(found=1, counted=4, piece_chars=400)
    under_reported: list[UnderReportedPiece] = []
    counted: list[int] = []
    collapse = YieldCollapseError("found 1 of 4 counted mentions", ["kept"], verdict)

    async def scenario() -> list[JsonValue]:
        return (
            await call_chunk_subdividing("reference", SMALL, SMALL_CHUNKING, failing(collapse), under_reported.append, counted.append)
        ).items

    assert run(scenario()) == ["kept"]
    assert (under_reported, counted) == ([verdict], [4])


def test_a_descent_nobody_listens_to_tells_nobody() -> None:
    collapse = YieldCollapseError("found 1 of 4 counted mentions", ["kept"], UnderReportedPiece(found=1, counted=4, piece_chars=400))

    async def scenario() -> list[JsonValue]:
        counted = await call_chunk_subdividing("reference", SMALL, SMALL_CHUNKING, answering(["a"], None, 3), None, None)
        collapsed = await call_chunk_subdividing("reference", SMALL, SMALL_CHUNKING, failing(collapse), None, None)
        return [*counted.items, *collapsed.items]

    assert run(scenario()) == ["a", "kept"]


# ── the log ─────────────────────────────────────────────────────────────


def warnings_of(caplog: pytest.LogCaptureFixture) -> list[logging.LogRecord]:
    return [record for record in caplog.records if record.name == "semiont_worker" and record.levelno == logging.WARNING]


def test_a_piece_that_descends_is_warned_of_with_its_length_the_level_and_the_size_it_is_cut_at_next(
    caplog: pytest.LogCaptureFixture,
) -> None:
    caplog.set_level(logging.DEBUG, logger="semiont_worker")
    assert raised_by(call_chunk_subdividing("highlight", CHUNK, CHUNKING, failing_whole(CUT_OFF, CHUNK, NOTHING), None, None)) is None
    (warned,) = warnings_of(caplog)
    assert warned.getMessage() == "Chunk call failed at a size-shaped bound — subdividing and retrying smaller"
    assert {key: vars(warned)[key] for key in ("depth", "pieceChars", "nextChunkSizeTokens", "error")} == {
        "depth": 1,
        "pieceChars": len(CHUNK),
        "nextChunkSizeTokens": 500,
        "error": "truncated (max_tokens)",
    }


def test_a_cut_off_piece_too_small_to_halve_is_warned_of_before_it_is_asked_about_once_more(caplog: pytest.LogCaptureFixture) -> None:
    caplog.set_level(logging.DEBUG, logger="semiont_worker")
    assert raised_by(call_chunk_subdividing("highlight", SMALL, SMALL_CHUNKING, failing_once(CUT_OFF, NOTHING), None, None)) is None
    (warned,) = warnings_of(caplog)
    assert warned.getMessage() == "Floor-size piece truncated — re-rolling once before giving up"
    assert {key: vars(warned)[key] for key in ("pieceChars", "error")} == {"pieceChars": 400, "error": "truncated (max_tokens)"}


def test_a_piece_kept_though_under_reported_is_warned_of_with_what_was_kept(caplog: pytest.LogCaptureFixture) -> None:
    collapse = YieldCollapseError("found 1 of 4 counted mentions", ["kept"], UnderReportedPiece(found=1, counted=4, piece_chars=400))
    caplog.set_level(logging.DEBUG, logger="semiont_worker")
    assert raised_by(call_chunk_subdividing("reference", SMALL, SMALL_CHUNKING, failing(collapse), None, None)) is None
    (warned,) = warnings_of(caplog)
    assert warned.getMessage() == "Floor-size piece still flagged as collapsed — accepting its under-reported salvage and continuing"
    assert {key: vars(warned)[key] for key in ("pieceChars", "salvaged", "error")} == {
        "pieceChars": 400,
        "salvaged": 1,
        "error": "found 1 of 4 counted mentions",
    }


def test_nothing_is_logged_of_a_piece_that_answers_or_of_a_failure_no_smaller_piece_can_fix(caplog: pytest.LogCaptureFixture) -> None:
    caplog.set_level(logging.DEBUG, logger="semiont_worker")
    broke = RuntimeError("the provider went away")
    assert raised_by(call_chunk_subdividing("highlight", CHUNK, CHUNKING, answering(["a"], None, None), None, None)) is None
    assert raised_by(call_chunk_subdividing("highlight", CHUNK, CHUNKING, failing(broke), None, None)) is broke
    assert [record for record in caplog.records if record.name == "semiont_worker"] == []


# ── the telemetry ───────────────────────────────────────────────────────

type Kind = tuple[object, object, object, object]
"""What a call is filed under: who asked, how it ended, how many times its piece had been halved, and whether it was a second asking."""


def metric(reader: InMemoryMetricReader, name: str) -> Metric | None:
    """The metric of that name as it stands, or nothing where none has been recorded."""
    data = reader.get_metrics_data()
    if data is None:
        return None
    named = [
        found for resource in data.resource_metrics for scope in resource.scope_metrics for found in scope.metrics if found.name == name
    ]
    assert len(named) <= 1
    return named[0] if named else None


def kind_of(point: NumberDataPoint | HistogramDataPoint) -> Kind:
    attributes = point.attributes or {}
    return (attributes["detection.label"], attributes["detection.outcome"], attributes["detection.depth"], attributes["detection.reroll"])


def counted_calls(reader: InMemoryMetricReader) -> Counter[Kind]:
    """How many calls have been counted so far, by what each is filed under."""
    calls = metric(reader, "semiont.detection.calls")
    so_far: Counter[Kind] = Counter()
    if calls is None:
        return so_far
    for point in calls.data.data_points:
        assert isinstance(point, NumberDataPoint)
        so_far[kind_of(point)] += int(point.value)
    return so_far


def recorded(reader: InMemoryMetricReader, name: str, direction: str | None) -> dict[Kind, tuple[int, float]]:
    """How many values a histogram has been given so far and their sum, by what each is filed under."""
    histogram = metric(reader, name)
    so_far: dict[Kind, tuple[int, float]] = {}
    if histogram is None:
        return so_far
    for point in histogram.data.data_points:
        assert isinstance(point, HistogramDataPoint)
        if (point.attributes or {}).get("detection.direction") == direction:
            so_far[kind_of(point)] = (point.count, point.sum)
    return so_far


def calls_made_by(reader: InMemoryMetricReader, work: Awaitable[object]) -> tuple[Counter[Kind], Exception | None]:
    """The calls `work` added to the count, and what it raised."""
    before = counted_calls(reader)
    raised = raised_by(work)
    return counted_calls(reader) - before, raised


def test_a_call_that_answers_is_counted_once_as_first_asked_with_its_proposals_and_what_the_provider_counted(
    metric_reader: InMemoryMetricReader,
) -> None:
    kind: Kind = ("highlight", "success", 0, False)
    readings = [
        ("semiont.detection.call.items", None),
        ("semiont.detection.call.tokens", "input"),
        ("semiont.detection.call.tokens", "output"),
        ("semiont.detection.call.duration", None),
    ]

    def so_far() -> list[tuple[int, float]]:
        return [recorded(metric_reader, name, direction).get(kind, (0, 0.0)) for name, direction in readings]

    before = so_far()
    answer = answering(["a", "b"], TokenUsage(input_tokens=1200, output_tokens=340), None)
    made, raised = calls_made_by(metric_reader, call_chunk_subdividing("highlight", CHUNK, CHUNKING, answer, None, None))
    assert raised is None
    assert made == Counter({kind: 1})
    items, read, written, timed = [(now[0] - was[0], now[1] - was[1]) for was, now in zip(before, so_far(), strict=True)]
    # One value more of each: its two proposals, and the tokens the provider said it read and wrote.
    assert (items, read, written) == ((1, 2), (1, 1200), (1, 340))
    # How long it took is measured: one value more, and no less than nothing.
    assert timed[0] == 1
    assert timed[1] >= 0


def test_a_call_its_provider_did_not_count_adds_no_tokens(metric_reader: InMemoryMetricReader) -> None:
    kind: Kind = ("assessment", "success", 0, False)
    before = {direction: recorded(metric_reader, "semiont.detection.call.tokens", direction).get(kind) for direction in ("input", "output")}
    made, _ = calls_made_by(metric_reader, call_chunk_subdividing("assessment", CHUNK, CHUNKING, answering(["a"], None, None), None, None))
    assert made == Counter({kind: 1})
    assert {
        direction: recorded(metric_reader, "semiont.detection.call.tokens", direction).get(kind) for direction in ("input", "output")
    } == before


def test_the_call_that_failed_and_each_smaller_one_asked_in_its_place_are_counted(metric_reader: InMemoryMetricReader) -> None:
    asked: list[str] = []

    async def call(piece: str) -> ChunkCallResult:
        asked.append(piece)
        if piece == CHUNK:
            raise CUT_OFF
        return ChunkCallResult(items=["x"], usage=None, counted=None)

    made, raised = calls_made_by(metric_reader, call_chunk_subdividing("reference", CHUNK, CHUNKING, call, None, None))
    assert raised is None
    assert len(asked) > 2
    # The call paid for and thrown away is in the count, beside the ones that replaced it one level down.
    assert made == Counter({("reference", "truncated", 0, False): 1, ("reference", "success", 1, False): len(asked) - 1})


def test_the_second_asking_of_a_piece_too_small_to_halve_is_marked_as_one(metric_reader: InMemoryMetricReader) -> None:
    again = ChunkCallResult(items=["ok"], usage=None, counted=None)
    made, raised = calls_made_by(
        metric_reader, call_chunk_subdividing("tag", SMALL, SMALL_CHUNKING, failing_once(CUT_OFF, again), None, None)
    )
    assert raised is None
    assert made == Counter({("tag", "truncated", 0, False): 1, ("tag", "success", 0, True): 1})


def test_a_collapse_is_counted_as_one_and_not_as_a_cut_off_reply_though_the_piece_is_kept(metric_reader: InMemoryMetricReader) -> None:
    collapse = YieldCollapseError("found 3 of 50 counted mentions", [], UnderReportedPiece(found=3, counted=50, piece_chars=400))
    made, raised = calls_made_by(metric_reader, call_chunk_subdividing("reference", SMALL, SMALL_CHUNKING, failing(collapse), None, None))
    assert raised is None
    assert made == Counter({("reference", "collapsed", 0, False): 1})


def test_a_call_that_ran_out_of_time_is_counted_as_that_at_each_level_it_was_asked_at(metric_reader: InMemoryMetricReader) -> None:
    out_of_time = InferenceTimeoutError("bound")
    made, raised = calls_made_by(metric_reader, call_chunk_subdividing("comment", CHUNK, CHUNKING, failing(out_of_time), None, None))
    assert raised is out_of_time
    assert made == Counter({("comment", "timeout", depth, False): 1 for depth in (0, 1, 2)})


@pytest.mark.parametrize(
    "failure",
    [RuntimeError("the provider went away"), StructuredReadError("not an array", "stop_sequence")],
    ids=["a plain failure", "an unreadable reply no smaller piece can fix"],
)
def test_any_other_failure_is_counted_as_an_error(failure: Exception, metric_reader: InMemoryMetricReader) -> None:
    made, raised = calls_made_by(metric_reader, call_chunk_subdividing("assessment", CHUNK, CHUNKING, failing(failure), None, None))
    assert raised is failure
    assert made == Counter({("assessment", "error", 0, False): 1})


def test_a_call_its_caller_cancelled_is_counted_as_an_error_and_the_cancellation_passes(metric_reader: InMemoryMetricReader) -> None:
    async def never(piece: str) -> ChunkCallResult:
        await asyncio.Event().wait()
        return NOTHING

    async def scenario() -> None:
        descent = asyncio.ensure_future(call_chunk_subdividing("tag", CHUNK, CHUNKING, never, None, None))
        await turns()
        descent.cancel()
        with pytest.raises(asyncio.CancelledError):
            await descent

    before = counted_calls(metric_reader)
    run(scenario())
    assert counted_calls(metric_reader) - before == Counter({("tag", "error", 0, False): 1})


def test_what_a_descent_records_is_what_the_table_lists(metric_reader: InMemoryMetricReader) -> None:
    listed = worker_metrics("semiont.detection.call")
    assert sorted(listed) == [
        "semiont.detection.call.duration",
        "semiont.detection.call.items",
        "semiont.detection.call.tokens",
        "semiont.detection.calls",
    ]

    # A call of every label, ended every way, a second asking among them, and one its provider counted.
    counted = ChunkCallResult(items=["a"], usage=TokenUsage(input_tokens=9, output_tokens=3), counted=None)
    collapse = YieldCollapseError("found 0 of 9 counted mentions", [], UnderReportedPiece(found=0, counted=9, piece_chars=400))
    for work in (
        call_chunk_subdividing("highlight", SMALL, SMALL_CHUNKING, answering(["a"], counted.usage, None), None, None),
        call_chunk_subdividing("comment", SMALL, SMALL_CHUNKING, failing_once(CUT_OFF, counted), None, None),
        call_chunk_subdividing("assessment", SMALL, SMALL_CHUNKING, failing(InferenceTimeoutError("bound")), None, None),
        call_chunk_subdividing("tag", SMALL, SMALL_CHUNKING, failing(RuntimeError("away")), None, None),
        call_chunk_subdividing("reference", SMALL, SMALL_CHUNKING, failing(collapse), None, None),
    ):
        raised_by(work)

    for name, row in listed.items():
        recorded_as = metric(metric_reader, name)
        assert recorded_as is not None, f"no {name} was recorded"
        match row.instrument:
            case "counter":
                assert isinstance(recorded_as.data, Sum), f"{name} is not a counter"
                assert recorded_as.data.is_monotonic, f"{name} is not a counter"
            case "histogram":
                assert isinstance(recorded_as.data, Histogram), f"{name} is not a histogram"
            case other:
                pytest.fail(f"{name} is listed as a {other}, which this test does not know how to hold")
        keys = {attribute.key for attribute in row.attributes}
        points = recorded_as.data.data_points
        for point in points:
            assert set(point.attributes or {}) == keys, f"{name} carries {set(point.attributes or {})}; the table lists {keys}"
        for attribute in row.attributes:
            if attribute.values is not None:
                seen = {as_the_table_writes((point.attributes or {})[attribute.key]) for point in points}
                assert seen <= set(attribute.values), f"{name}: {attribute.key} was {seen}"
                # Every call is counted, timed and its proposals recorded, so each of those has been filed under
                # every value. Tokens are an answered call's alone, and only the direction has every value there.
                if name != "semiont.detection.call.tokens" or attribute.key == "detection.direction":
                    assert seen == set(attribute.values), f"{name}: {attribute.key} was only ever {seen}"
    duration = metric(metric_reader, "semiont.detection.call.duration")
    assert duration is not None
    assert duration.unit == "ms"

    # And the two vocabularies the worker types its calls by are the table's.
    values = {attribute.key: attribute.values for attribute in listed["semiont.detection.calls"].attributes}
    assert sorted(get_args(DetectionLabel.__value__)) == sorted(values["detection.label"] or [])
    assert sorted(get_args(DetectionOutcome.__value__)) == sorted(values["detection.outcome"] or [])
