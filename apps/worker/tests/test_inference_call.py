"""The bound on a call to a model: ten minutes, a report every fifteen seconds while it is awaited, and a span around it.

Unbounded, one request that never settles would hold its agent for good. These
hold the bound: a call that never answers becomes an ordinary failure of its
job, one that answers is passed through untouched, a model's own failure is
not taken for the bound's, and a caller's cancellation is not either. The
clock is the test's, and is moved: nothing here waits.
"""

import asyncio
import logging
from collections.abc import Awaitable, Callable
from typing import Final, final

import pytest
from aio import pass_time, run, under_way
from opentelemetry import trace
from opentelemetry.sdk.trace import ReadableSpan
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter
from opentelemetry.trace import SpanKind, StatusCode
from semiont_inference.interface import ElementSchema, InferenceLimits, InferenceResponse, StructuredResponse
from semiont_inference.mock import MockInferenceClient
from telemetry_rows import as_the_table_writes, worker_spans

from semiont_worker.inference_call import (
    INFERENCE_HEARTBEAT_SECONDS,
    INFERENCE_TIMEOUT_SECONDS,
    InferenceTimeoutError,
    bounded_generate_structured,
    bounded_generate_text,
)

ELEMENT: Final[ElementSchema] = {"type": "object"}
ANSWERED_TEXT: Final = InferenceResponse(text="ok", stop_reason="end_turn", usage=None)
ANSWERED_ITEMS: Final = StructuredResponse(items=[], stop_reason="end_turn", usage=None)
LIMITS: Final = InferenceLimits(context_tokens=8192, max_output_tokens=8192, output_tokens_per_hour=None, accepts_temperature=None)


async def at_once() -> None:
    return


async def never() -> None:
    await asyncio.Event().wait()


def failing_with(failure: Exception) -> Callable[[], Awaitable[None]]:
    async def fail() -> None:
        raise failure

    return fail


@final
class Asked:
    """A client whose every generation first waits on what the test gives it, and keeps how it went.

    Its provider is one the telemetry table lists.
    """

    def __init__(self, before: Callable[[], Awaitable[None]]) -> None:
        self.provider: Final = "ollama"
        self.model_id: Final = "bound-model"
        self.max_concurrency: Final = 1
        self.verify_detection_yield: Final = False
        self.cancelled = 0
        self.asked_inside: list[str] = []
        self._before = before

    async def limits(self) -> InferenceLimits:
        raise AssertionError("the bound asks for no limits")

    async def generate_text(self, prompt: str, max_tokens: int, temperature: float) -> InferenceResponse:
        await self._held()
        return ANSWERED_TEXT

    async def generate_structured(
        self, prompt: str, max_tokens: int, temperature: float, element_schema: ElementSchema
    ) -> StructuredResponse:
        await self._held()
        return ANSWERED_ITEMS

    async def _held(self) -> None:
        current = trace.get_current_span()
        self.asked_inside.append(current.name if isinstance(current, ReadableSpan) else "")
        try:
            await self._before()
        except asyncio.CancelledError:
            self.cancelled += 1
            raise


type Bounded = Callable[[Asked, Callable[[], None] | None], Awaitable[InferenceResponse | StructuredResponse]]


def text(client: Asked, on_heartbeat: Callable[[], None] | None) -> Awaitable[InferenceResponse]:
    return bounded_generate_text(client, "p", 100, 0.1, on_heartbeat)


def structured(client: Asked, on_heartbeat: Callable[[], None] | None) -> Awaitable[StructuredResponse]:
    return bounded_generate_structured(client, "p", 100, 0.1, ELEMENT, on_heartbeat)


BOTH: Final = pytest.mark.parametrize("bounded", [text, structured], ids=["text", "structured"])


def warnings_of(caplog: pytest.LogCaptureFixture) -> list[logging.LogRecord]:
    return [record for record in caplog.records if record.name == "semiont_worker" and record.levelno == logging.WARNING]


# ── the answer ──────────────────────────────────────────────────────────


def test_an_answer_in_time_is_passed_through_as_it_is_and_the_model_is_asked_what_the_caller_asked() -> None:
    async def scenario() -> None:
        client = MockInferenceClient(["hello", '[{"exact": "a"}]'], stop_reasons=["end_turn", "end_turn"], limits=LIMITS)
        assert await bounded_generate_text(client, "say", 100, 0.1, None) == InferenceResponse(
            text="hello", stop_reason="end_turn", usage=None
        )
        assert await bounded_generate_structured(client, "list", 4242, 0, ELEMENT, None) == StructuredResponse(
            items=[{"exact": "a"}], stop_reason="end_turn", usage=None
        )
        assert [(call.prompt, call.max_tokens, call.temperature, call.element_schema) for call in client.calls] == [
            ("say", 100, 0.1, None),
            ("list", 4242, 0, ELEMENT),
        ]

    run(scenario())


# ── the bound ───────────────────────────────────────────────────────────


@BOTH
def test_a_call_not_answered_in_ten_minutes_is_ended_and_fails_as_the_bound_s_own_failure(bounded: Bounded) -> None:
    async def scenario() -> None:
        client = Asked(never)
        call = await under_way(bounded(client, None))
        await pass_time(INFERENCE_TIMEOUT_SECONDS - 1, step=INFERENCE_TIMEOUT_SECONDS - 1)
        assert not call.done()
        assert client.cancelled == 0
        await pass_time(2, step=2)
        with pytest.raises(InferenceTimeoutError, match=r"timed out after 10 minutes \(ollama:bound-model\)"):
            await call
        # Ended, and not left: the request to the provider was torn down by cancelling what awaited it.
        assert client.cancelled == 1

    run(scenario())


@BOTH
def test_a_model_s_own_failure_is_raised_as_it_was(bounded: Bounded) -> None:
    async def scenario() -> None:
        # The second is a timeout of the provider's own, long before the bound: it is not taken for the bound's.
        for failure in (RuntimeError("model exploded"), TimeoutError("the provider gave up")):
            with pytest.raises(type(failure)) as raised:
                await bounded(Asked(failing_with(failure)), None)
            assert raised.value is failure

    run(scenario())


@BOTH
def test_a_caller_s_cancellation_ends_the_call_and_reaches_the_caller_as_it_is(bounded: Bounded) -> None:
    async def scenario() -> None:
        client = Asked(never)
        beats: list[float] = []
        call = await under_way(bounded(client, lambda: beats.append(0)))
        call.cancel()
        with pytest.raises(asyncio.CancelledError):
            await call
        assert client.cancelled == 1
        # And nothing reports of it afterwards.
        await pass_time(60, step=INFERENCE_HEARTBEAT_SECONDS)
        assert beats == []

    run(scenario())


# ── the report while a call is awaited ──────────────────────────────────


@BOTH
def test_a_call_that_is_awaited_reports_every_fifteen_seconds(bounded: Bounded) -> None:
    async def scenario() -> None:
        loop = asyncio.get_running_loop()
        began = loop.time()
        beats: list[float] = []
        call = await under_way(bounded(Asked(never), lambda: beats.append(round(loop.time() - began))))
        # Two minutes of one call: well inside the bound, and far past any reader's patience with silence.
        await pass_time(120, step=5)
        assert beats == [15, 30, 45, 60, 75, 90, 105, 120]
        call.cancel()
        await asyncio.gather(call, return_exceptions=True)

    run(scenario())


@BOTH
def test_a_call_answered_within_the_interval_reports_nothing(bounded: Bounded) -> None:
    async def scenario() -> None:
        beats: list[int] = []
        await bounded(Asked(at_once), lambda: beats.append(0))
        await pass_time(60, step=INFERENCE_HEARTBEAT_SECONDS)
        assert beats == []

    run(scenario())


@BOTH
def test_the_reports_stop_once_the_call_is_answered(bounded: Bounded) -> None:
    async def scenario() -> None:
        answered = asyncio.Event()

        async def until_told() -> None:
            await answered.wait()

        beats: list[int] = []
        call = await under_way(bounded(Asked(until_told), lambda: beats.append(0)))
        await pass_time(60, step=INFERENCE_HEARTBEAT_SECONDS)
        assert len(beats) == 4
        answered.set()
        await call
        await pass_time(120, step=INFERENCE_HEARTBEAT_SECONDS)
        assert len(beats) == 4

    run(scenario())


@BOTH
def test_the_reports_stop_once_the_bound_has_ended_the_call(bounded: Bounded) -> None:
    async def scenario() -> None:
        beats: list[int] = []
        call = await under_way(bounded(Asked(never), lambda: beats.append(0)))
        await pass_time(INFERENCE_TIMEOUT_SECONDS + 1, step=INFERENCE_HEARTBEAT_SECONDS)
        with pytest.raises(InferenceTimeoutError):
            await call
        made = len(beats)
        assert made >= INFERENCE_TIMEOUT_SECONDS // INFERENCE_HEARTBEAT_SECONDS - 1
        await pass_time(120, step=INFERENCE_HEARTBEAT_SECONDS)
        assert len(beats) == made

    run(scenario())


@BOTH
def test_a_report_that_fails_does_not_take_down_the_call_it_reports_on(bounded: Bounded) -> None:
    async def scenario() -> None:
        answered = asyncio.Event()

        async def until_told() -> None:
            await answered.wait()

        tried: list[int] = []

        def bus_is_down() -> None:
            tried.append(0)
            raise RuntimeError("bus is down")

        call = await under_way(bounded(Asked(until_told), bus_is_down))
        await pass_time(60, step=INFERENCE_HEARTBEAT_SECONDS)
        # Each report failed, and the next was still made.
        assert len(tried) == 4
        answered.set()
        assert await call in (ANSWERED_TEXT, ANSWERED_ITEMS)

    run(scenario())


# ── the span ────────────────────────────────────────────────────────────


def test_each_call_is_a_span_the_table_lists_of_its_kind_and_with_its_attributes(exported_spans: InMemorySpanExporter) -> None:
    listed = worker_spans("inference:")
    assert sorted(listed) == ["inference:structured", "inference:text"]

    async def scenario() -> list[Asked]:
        clients = [Asked(at_once), Asked(at_once)]
        await bounded_generate_text(clients[0], "p", 100, 0.1, None)
        await bounded_generate_structured(clients[1], "p", 4242, 0.1, ELEMENT, None)
        return clients

    exported_spans.clear()
    clients = run(scenario())
    spans = exported_spans.get_finished_spans()
    assert [span.name for span in spans] == ["inference:text", "inference:structured"]
    # The provider is asked inside the span: what a driver records of the request is a part of it.
    assert [client.asked_inside for client in clients] == [["inference:text"], ["inference:structured"]]
    assert [dict(span.attributes or {}) for span in spans] == [
        {"inference.provider": "ollama", "inference.model": "bound-model", "inference.max_tokens": 100},
        {"inference.provider": "ollama", "inference.model": "bound-model", "inference.max_tokens": 4242},
    ]
    for span in spans:
        row = listed[span.name]
        assert span.kind == {"internal": SpanKind.INTERNAL}[row.kind]
        assert set(span.attributes or {}) == {attribute.key for attribute in row.attributes}
        for attribute in row.attributes:
            if attribute.values is not None:
                assert as_the_table_writes((span.attributes or {})[attribute.key]) in attribute.values
        assert span.status.status_code is StatusCode.UNSET


@BOTH
def test_a_failure_is_recorded_on_the_span_of_the_call_it_ended(bounded: Bounded, exported_spans: InMemorySpanExporter) -> None:
    async def a_model_that_fails() -> None:
        with pytest.raises(RuntimeError):
            await bounded(Asked(failing_with(RuntimeError("model exploded"))), None)

    async def a_model_that_never_answers() -> None:
        call = await under_way(bounded(Asked(never), None))
        await pass_time(INFERENCE_TIMEOUT_SECONDS + 1, step=INFERENCE_TIMEOUT_SECONDS + 1)
        with pytest.raises(InferenceTimeoutError):
            await call

    for scenario, failure in ((a_model_that_fails, "RuntimeError"), (a_model_that_never_answers, "InferenceTimeoutError")):
        exported_spans.clear()
        run(scenario())
        (span,) = exported_spans.get_finished_spans()
        assert span.status.status_code is StatusCode.ERROR
        (recorded,) = [event for event in span.events if event.name == "exception"]
        assert str((recorded.attributes or {})["exception.type"]).endswith(failure)


# ── the log ─────────────────────────────────────────────────────────────


@BOTH
def test_the_bound_ending_a_call_is_logged_once_with_what_it_ended_and_its_bound(
    bounded: Bounded, caplog: pytest.LogCaptureFixture
) -> None:
    async def scenario() -> None:
        call = await under_way(bounded(Asked(never), None))
        await pass_time(INFERENCE_TIMEOUT_SECONDS + 1, step=INFERENCE_TIMEOUT_SECONDS + 1)
        with pytest.raises(InferenceTimeoutError):
            await call

    caplog.set_level(logging.DEBUG, logger="semiont_worker")
    run(scenario())
    (warned,) = warnings_of(caplog)
    assert warned.getMessage() == "Aborting in-flight inference call at the timeout bound"
    assert {key: vars(warned)[key] for key in ("provider", "model", "label", "boundMs")} == {
        "provider": "ollama",
        "model": "bound-model",
        "label": "ollama:bound-model",
        "boundMs": 600_000,
    }


@BOTH
def test_nothing_is_logged_of_a_call_answered_in_time_or_of_one_its_caller_cancelled(
    bounded: Bounded, caplog: pytest.LogCaptureFixture
) -> None:
    async def scenario() -> None:
        await bounded(Asked(at_once), None)
        call = await under_way(bounded(Asked(never), None))
        call.cancel()
        await asyncio.gather(call, return_exceptions=True)

    caplog.set_level(logging.DEBUG, logger="semiont_worker")
    run(scenario())
    assert [record for record in caplog.records if record.name == "semiont_worker"] == []
