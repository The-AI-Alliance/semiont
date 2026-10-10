"""The limits report: what a service that holds inference clients says of its models.

A report never fails and never waits on a provider: a discovery that fails,
and one that has not answered within a second and a half, each leave that
pair out, and the pairs that answered are still reported. A pair left out is
asked about again at the next report.
"""

import asyncio
import logging

import pytest
from aio import pass_time, run, soon
from provider import HOLD, Anthropic, Ollama, saying, window
from semiont.model import written
from spec import SPEC, JsonObject, read, thing

from semiont_inference.anthropic import AnthropicInferenceClient
from semiont_inference.interface import InferenceClient, InferenceLimits
from semiont_inference.limits_report import report_limits
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
    assert "/api/show returned 500" in vars(left_out)["reason"]


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
