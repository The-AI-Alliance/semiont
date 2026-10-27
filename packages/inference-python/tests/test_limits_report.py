"""The limits report: what a service that holds inference clients says of its models, and how it answers a request for it.

A report never fails and never waits on a provider: a discovery that fails,
and one that has not answered within a second and a half, each leave that
pair out, and the pairs that answered are still reported. A pair left out is
asked about again at the next report.

A request for the limits is answered with a report: once, on its operation's
result channel, with the request's correlation id, in the trace the request
was sent under. No request waits for another's report.
"""

import asyncio
import logging
from collections.abc import Mapping

import pytest
from aio import pass_time, run, soon
from provider import HOLD, Anthropic, Ollama, saying, window
from pydantic import JsonValue
from semiont import telemetry
from semiont.bus import Bus
from semiont.channel import Operation
from semiont.errors import TransportError
from semiont.identifiers import ResourceId
from semiont.model import written
from semiont.operations import LIMITS_OPERATIONS
from semiont.testing import FaultyTransport
from semiont.transport import Frame, TraceContext
from semiont.types import CommandError, InferenceLimitsRequest, InferenceLimitsResult
from spec import SPEC, JsonObject, read, thing

from semiont_inference.anthropic import AnthropicInferenceClient
from semiont_inference.interface import InferenceClient, InferenceLimits
from semiont_inference.limits_report import answer_limits_requests, report_limits
from semiont_inference.mock import MockInferenceClient
from semiont_inference.ollama import OllamaInferenceClient


def mock(limits: InferenceLimits) -> MockInferenceClient:
    return MockInferenceClient(["[]"], stop_reasons=["end_turn"], limits=limits)


def shared(context_tokens: int) -> JsonObject:
    """An Ollama model's limits, as the wire carries them."""
    return {"contextTokens": context_tokens, "maxOutputTokens": context_tokens, "acceptsTemperature": True}


MOCK = mock(InferenceLimits(context_tokens=200_000, max_output_tokens=64_000, output_tokens_per_hour=None, accepts_temperature=None))
MOCK_PAIR: JsonObject = {"provider": "mock", "model": "mock-model", "limits": {"contextTokens": 200_000, "maxOutputTokens": 64_000}}


def test_a_report_carries_every_property_the_wire_schema_declares_and_nothing_else() -> None:
    # What a driver learns of a model has one member the wire does not carry: the rate, which is for the
    # worker's own budget. The rest is the schema's, and a property added there fails here until it is reported.
    declared = set(thing(read(SPEC / "components/schemas/InferenceLimits.json")["properties"], "the schema's properties"))
    assert declared, "the schema declares nothing: this gate reads nothing"
    everything = InferenceLimits(
        context_tokens=200_000, max_output_tokens=64_000, output_tokens_per_hour=1_000_000, accepts_temperature=False
    )

    async def scenario() -> None:
        (pair,) = await report_limits([mock(everything)])
        assert set(thing(written(pair)["limits"], "the limits")) == declared
        assert written(pair) == {
            "provider": "mock",
            "model": "mock-model",
            "limits": {"contextTokens": 200_000, "maxOutputTokens": 64_000, "acceptsTemperature": False},
        }

    run(scenario())


def test_what_a_driver_does_not_claim_is_left_off_the_wire() -> None:
    # Whether a model takes a temperature may be left out: absent is no claim, and a null would be one.
    async def scenario() -> None:
        assert [written(pair) for pair in await report_limits([MOCK])] == [MOCK_PAIR]

    run(scenario())


def test_each_pair_is_reported_in_the_order_given_as_its_provider_states_it() -> None:
    async def scenario() -> None:
        async with Anthropic() as played, Ollama(4096) as ollama:
            report = await report_limits(
                [
                    AnthropicInferenceClient(api_key="k", model="claude-x", base_url=played.origin),
                    OllamaInferenceClient(model="llama3", base_url=ollama.origin),
                    MOCK,
                ]
            )
            assert [written(pair) for pair in report] == [
                {
                    "provider": "anthropic",
                    "model": "claude-x",
                    "limits": {"contextTokens": 200_000, "maxOutputTokens": 64_000, "acceptsTemperature": True},
                },
                {"provider": "ollama", "model": "llama3", "limits": shared(4096)},
                MOCK_PAIR,
            ]

    run(scenario())


def test_a_pair_is_reported_once_however_many_clients_hold_it() -> None:
    async def scenario() -> None:
        async with Ollama() as ollama:
            clients: list[InferenceClient] = [
                OllamaInferenceClient(model=model, base_url=ollama.origin) for model in ("llama3", "llama3", "gemma2", "llama3")
            ]
            assert [(pair.provider, pair.model) for pair in await report_limits(clients)] == [("ollama", "llama3"), ("ollama", "gemma2")]
            # The first client of a pair is the one asked.
            assert sorted(str(show["model"]) for show in ollama.shows) == ["gemma2", "llama3"]

    run(scenario())


def test_no_clients_are_no_pairs() -> None:
    async def scenario() -> None:
        assert await report_limits([]) == []

    run(scenario())


def test_a_pair_that_cannot_be_learned_is_left_out_and_asked_about_again_at_the_next_report(caplog: pytest.LogCaptureFixture) -> None:
    async def scenario() -> None:
        async with Ollama() as ollama:
            ollama.show = saying({"error": "down"}, status=500)
            clients: list[InferenceClient] = [MOCK, OllamaInferenceClient(model="llama3", base_url=ollama.origin)]
            # The healthy pair is still reported.
            assert [written(pair) for pair in await report_limits(clients)] == [MOCK_PAIR]

            ollama.show = window(8192)
            assert [written(pair) for pair in await report_limits(clients)] == [
                MOCK_PAIR,
                {"provider": "ollama", "model": "llama3", "limits": shared(8192)},
            ]
            assert len(ollama.shows) == 2

    caplog.set_level(logging.DEBUG, logger="semiont_inference")
    run(scenario())
    (left_out,) = [record for record in caplog.records if record.getMessage().startswith("Limits report")]
    assert (left_out.levelname, left_out.getMessage()) == ("DEBUG", "Limits report: consult failed — pair left out")
    assert vars(left_out)["pair"] == "ollama llama3"
    assert "Ollama's /api/show: refused with status 500" in vars(left_out)["reason"]


def test_a_provider_that_has_not_answered_in_a_second_and_a_half_is_left_out_and_its_answer_is_kept_when_it_comes(
    caplog: pytest.LogCaptureFixture,
) -> None:
    async def scenario() -> None:
        async with Ollama() as ollama:
            ollama.show = HOLD
            clients: list[InferenceClient] = [OllamaInferenceClient(model="llama3", base_url=ollama.origin), MOCK]
            reporting = asyncio.ensure_future(report_limits(clients))
            await soon(ollama.arrived("POST", "/api/show"))
            await pass_time(1.4, step=0.1)
            assert not reporting.done()
            await pass_time(0.2, step=0.1)
            assert [written(pair) for pair in await soon(reporting)] == [MOCK_PAIR]

            # Nothing was thrown away by not waiting: the provider's answer, when it comes, is the next report's.
            assert ollama.holding == 1
            ollama.release(window(8192))
            report: list[JsonObject] = []
            for _ in range(200):
                report = [written(pair) for pair in await report_limits(clients)]
                if len(report) == 2:
                    break
                await asyncio.sleep(0.005)
            assert report == [{"provider": "ollama", "model": "llama3", "limits": shared(8192)}, MOCK_PAIR]
            assert len(ollama.shows) == 1

    caplog.set_level(logging.DEBUG, logger="semiont_inference")
    run(scenario())
    left_out = [record for record in caplog.records if record.getMessage().startswith("Limits report")]
    assert left_out, "nothing was said of the pair left out"
    assert (left_out[0].levelname, left_out[0].getMessage()) == ("DEBUG", "Limits report: consult exceeded budget — pair left out")
    assert (vars(left_out[0])["pair"], vars(left_out[0])["budgetMs"]) == ("ollama llama3", 1500)


def test_a_report_that_is_cancelled_ends_cancelled() -> None:
    async def scenario() -> None:
        async with Ollama() as ollama:
            ollama.show = HOLD
            reporting = asyncio.ensure_future(report_limits([OllamaInferenceClient(model="llama3", base_url=ollama.origin)]))
            await soon(ollama.arrived("POST", "/api/show"))
            reporting.cancel()
            with pytest.raises(asyncio.CancelledError):
                await reporting
            assert reporting.cancelled()
            ollama.release(window(8192))
            await asyncio.sleep(0.05)

    run(scenario())


# ── answering a request ─────────────────────────────────────────────────

type LimitsOperation = Operation[InferenceLimitsRequest, InferenceLimitsResult, CommandError]


def asked(operation: LimitsOperation, correlation_id: str | None, trace: TraceContext | None = None) -> Frame:
    """A request of `operation`, as a transport delivers one: with what the gateway stamped on it."""
    return Frame(
        channel=operation.request.name, payload={"_userId": "did:web:test.local:users:asker"}, correlation_id=correlation_id, trace=trace
    )


def said(transport: FaultyTransport) -> list[tuple[str, str | None, Mapping[str, JsonValue]]]:
    """What was sent through `transport`: each frame's channel, its correlation id and its payload."""
    return [(frame.channel, frame.correlation_id, frame.payload) for frame in transport.emitted]


async def turns() -> None:
    """Give the loop turns enough for what was delivered to be read and answered."""
    for _ in range(20):
        await asyncio.sleep(0)


@pytest.mark.parametrize("operation", LIMITS_OPERATIONS, ids=lambda operation: operation.request.name)
def test_a_request_is_answered_once_on_its_operations_result_channel_with_its_correlation_id(operation: LimitsOperation) -> None:
    async def scenario() -> None:
        transport = FaultyTransport()
        answering = asyncio.ensure_future(answer_limits_requests(Bus(transport), operation, [MOCK]))
        await turns()
        # Nothing is said until something is asked.
        assert said(transport) == []

        transport.deliver(asked(operation, "request-1"))
        await turns()
        assert said(transport) == [(operation.result.name, "request-1", {"response": {"limits": [MOCK_PAIR]}})]

        # Each request is answered, with its own correlation id.
        transport.deliver(asked(operation, "request-2"))
        await turns()
        assert [(channel, correlation_id) for channel, correlation_id, _ in said(transport)] == [
            (operation.result.name, "request-1"),
            (operation.result.name, "request-2"),
        ]

        answering.cancel()
        await asyncio.gather(answering, return_exceptions=True)
        assert answering.cancelled()

    run(scenario())


def test_only_the_operation_named_is_answered() -> None:
    gather, job, _ = LIMITS_OPERATIONS

    async def scenario() -> None:
        transport = FaultyTransport()
        answering = asyncio.ensure_future(answer_limits_requests(Bus(transport), job, [MOCK]))
        await turns()
        transport.deliver(asked(gather, "another-services"))
        await turns()
        assert said(transport) == []
        answering.cancel()
        await asyncio.gather(answering, return_exceptions=True)

    run(scenario())


def test_a_pair_that_cannot_be_learned_is_left_out_of_the_answer_and_the_request_is_still_answered() -> None:
    _, job, _ = LIMITS_OPERATIONS

    async def scenario() -> None:
        async with Ollama() as ollama:
            ollama.show = saying({"error": "down"}, status=500)
            transport = FaultyTransport()
            clients: list[InferenceClient] = [OllamaInferenceClient(model="llama3", base_url=ollama.origin), MOCK]
            answering = asyncio.ensure_future(answer_limits_requests(Bus(transport), job, clients))
            await turns()
            transport.deliver(asked(job, "request-1"))
            for _ in range(200):
                if transport.emitted:
                    break
                await asyncio.sleep(0.005)
            assert said(transport) == [(job.result.name, "request-1", {"response": {"limits": [MOCK_PAIR]}})]
            answering.cancel()
            await asyncio.gather(answering, return_exceptions=True)

    run(scenario())


def test_no_request_waits_for_the_report_of_another() -> None:
    _, job, _ = LIMITS_OPERATIONS

    async def scenario() -> None:
        async with Ollama() as ollama:
            ollama.show = HOLD
            transport = FaultyTransport()
            clients: list[InferenceClient] = [OllamaInferenceClient(model="llama3", base_url=ollama.origin), MOCK]
            answering = asyncio.ensure_future(answer_limits_requests(Bus(transport), job, clients))
            await turns()
            transport.deliver(asked(job, "request-1"))
            transport.deliver(asked(job, "request-2"))
            await soon(ollama.arrived("POST", "/api/show"))
            await pass_time(1.4, step=0.1)
            assert said(transport) == []
            # A second and a half after they were asked, both are answered: the second did not wait out the first's report and then its own.
            await pass_time(0.2, step=0.1)
            answered = {(channel, correlation_id) for channel, correlation_id, _ in said(transport)}
            assert answered == {(job.result.name, "request-1"), (job.result.name, "request-2")}
            assert all(payload == {"response": {"limits": [MOCK_PAIR]}} for _, _, payload in said(transport))
            answering.cancel()
            await asyncio.gather(answering, return_exceptions=True)
            ollama.release(window(8192))
            await asyncio.sleep(0.05)

    run(scenario())


def test_an_answer_is_sent_in_the_trace_its_request_was_sent_under(monkeypatch: pytest.MonkeyPatch) -> None:
    _, job, _ = LIMITS_OPERATIONS
    sent_under = TraceContext(traceparent="00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01")

    async def scenario() -> None:
        transport = FaultyTransport()
        traces: list[TraceContext | None] = []
        emit = transport.emit

        async def emit_and_note_the_trace(
            channel: str, payload: Mapping[str, JsonValue], *, scope: ResourceId | None = None, correlation_id: str | None = None
        ) -> int | None:
            traces.append(telemetry.active())
            return await emit(channel, payload, scope=scope, correlation_id=correlation_id)

        monkeypatch.setattr(transport, "emit", emit_and_note_the_trace)
        answering = asyncio.ensure_future(answer_limits_requests(Bus(transport), job, [MOCK]))
        await turns()
        transport.deliver(asked(job, "traced", sent_under))
        transport.deliver(asked(job, "untraced"))
        await turns()
        assert [correlation_id for _, correlation_id, _ in said(transport)] == ["traced", "untraced"]
        assert traces == [sent_under, None]
        answering.cancel()
        await asyncio.gather(answering, return_exceptions=True)

    run(scenario())


def test_an_answer_that_cannot_be_sent_is_said_on_the_failure_channel_and_in_the_log(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    _, job, _ = LIMITS_OPERATIONS

    async def scenario() -> None:
        transport = FaultyTransport()
        emit = transport.emit

        async def refusing_the_result(
            channel: str, payload: Mapping[str, JsonValue], *, scope: ResourceId | None = None, correlation_id: str | None = None
        ) -> int | None:
            if channel == job.result.name:
                raise TransportError.of_status("/bus/emit 503: not now", 503, None)
            return await emit(channel, payload, scope=scope, correlation_id=correlation_id)

        monkeypatch.setattr(transport, "emit", refusing_the_result)
        answering = asyncio.ensure_future(answer_limits_requests(Bus(transport), job, [MOCK]))
        await turns()
        transport.deliver(asked(job, "request-1"))
        await turns()
        assert said(transport) == [(job.failure.name, "request-1", {"message": "/bus/emit 503: not now"})]
        # It goes on answering.
        monkeypatch.setattr(transport, "emit", emit)
        transport.deliver(asked(job, "request-2"))
        await turns()
        assert said(transport)[-1] == (job.result.name, "request-2", {"response": {"limits": [MOCK_PAIR]}})
        answering.cancel()
        await asyncio.gather(answering, return_exceptions=True)

    caplog.set_level(logging.DEBUG, logger="semiont_inference")
    run(scenario())
    (failed,) = [record for record in caplog.records if record.getMessage() == "Limits report failed"]
    assert failed.levelname == "ERROR"
    assert (vars(failed)["operation"], vars(failed)["error"]) == (job.request.name, "/bus/emit 503: not now")


def test_a_failure_that_cannot_be_sent_either_ends_nothing(monkeypatch: pytest.MonkeyPatch) -> None:
    _, job, _ = LIMITS_OPERATIONS

    async def scenario() -> None:
        transport = FaultyTransport()
        emit = transport.emit

        async def refusing_everything(
            channel: str, payload: Mapping[str, JsonValue], *, scope: ResourceId | None = None, correlation_id: str | None = None
        ) -> int | None:
            raise TransportError.without_response("/bus/emit got no answer")

        monkeypatch.setattr(transport, "emit", refusing_everything)
        answering = asyncio.ensure_future(answer_limits_requests(Bus(transport), job, [MOCK]))
        await turns()
        transport.deliver(asked(job, "request-1"))
        await turns()
        assert not answering.done()
        # The next request is answered once the gateway takes an emit again.
        monkeypatch.setattr(transport, "emit", emit)
        transport.deliver(asked(job, "request-2"))
        await turns()
        assert said(transport) == [(job.result.name, "request-2", {"response": {"limits": [MOCK_PAIR]}})]
        answering.cancel()
        await asyncio.gather(answering, return_exceptions=True)

    run(scenario())


def test_answering_ends_when_the_buss_frames_end() -> None:
    _, job, _ = LIMITS_OPERATIONS

    async def scenario() -> None:
        transport = FaultyTransport()
        answering = asyncio.ensure_future(answer_limits_requests(Bus(transport), job, [MOCK]))
        await turns()
        await transport.close()
        await soon(answering)

    run(scenario())


def test_answering_that_is_cancelled_ends_the_reports_it_was_making() -> None:
    _, job, _ = LIMITS_OPERATIONS

    async def scenario() -> None:
        async with Ollama() as ollama:
            ollama.show = HOLD
            transport = FaultyTransport()
            answering = asyncio.ensure_future(
                answer_limits_requests(Bus(transport), job, [OllamaInferenceClient(model="llama3", base_url=ollama.origin)])
            )
            await turns()
            transport.deliver(asked(job, "request-1"))
            await soon(ollama.arrived("POST", "/api/show"))
            answering.cancel()
            with pytest.raises(asyncio.CancelledError):
                await answering
            # Nothing is said once it has ended, whatever the provider then answers.
            ollama.release(window(8192))
            await asyncio.sleep(0.05)
            assert said(transport) == []

    run(scenario())
