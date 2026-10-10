"""The Anthropic driver, against an Anthropic API this test plays over HTTP.

The driver reaches the provider through Anthropic's own library, and the
library is not replaced or patched: it sends real requests to the stand-in,
which answers the Models API, the one-token probe, and each generation, whole
or as a stream. What arrives is held exactly: in P5 the Worker service's
suite (`tests/conformance/worker-service/anthropic.test.ts`) holds the Python
worker to the same requests.
"""

import asyncio
import logging
import re

import anthropic
import pytest
from aio import hurried, run, settle, soon
from provider import HANG_UP, HOLD, Answer, Anthropic, Reply, model_info, refused, reply, saying
from spec import JsonObject

from semiont_inference.anthropic import AnthropicInferenceClient
from semiont_inference.interface import (
    InferenceLimits,
    InferenceResponse,
    ProviderStatusError,
    StructuredReadError,
    StructuredResponse,
    TokenUsage,
)

KEY = "sk-played-key"
ELEMENT: JsonObject = {"type": "object", "properties": {"exact": {"type": "string"}}, "required": ["exact"], "additionalProperties": False}
PROBE: JsonObject = {"model": "claude-x", "max_tokens": 1, "temperature": 0.7, "messages": [{"role": "user", "content": "ok"}]}
COUNTED = TokenUsage(input_tokens=10, output_tokens=5)


def driver(played: Anthropic, model: str = "claude-x") -> AnthropicInferenceClient:
    return AnthropicInferenceClient(api_key=KEY, model=model, base_url=played.origin)


def said_to(model: str, prompt: str, **rest: int | float | bool) -> JsonObject:
    """A request for plain text, as it arrives: the model, what `rest` states, and the prompt as the one message."""
    return {"model": model, **rest, "messages": [{"role": "user", "content": prompt}]}


def array_of(element: JsonObject) -> JsonObject:
    """What a structured request carries beside the rest: the caller's schema as the elements of an array, at the root."""
    return {"format": {"type": "json_schema", "schema": {"type": "array", "items": element}}}


def limits(*, context: int = 200_000, output: int = 64_000, accepts_temperature: bool = True) -> InferenceLimits:
    return InferenceLimits(
        context_tokens=context, max_output_tokens=output, output_tokens_per_hour=128_000, accepts_temperature=accepts_temperature
    )


def ours(caplog: pytest.LogCaptureFixture) -> list[logging.LogRecord]:
    return [record for record in caplog.records if record.name == "semiont_inference"]


# ── limits ──────────────────────────────────────────────────────────────


def test_it_learns_the_models_ceilings_from_the_models_api_once_and_keeps_them() -> None:
    async def scenario() -> None:
        async with Anthropic() as played:
            client = driver(played)
            assert await client.limits() == limits()
            assert await client.limits() == limits()
            # Asked once: its ceilings, and then whether it takes a temperature.
            assert [f"{asked.method} {asked.path}" for asked in played.asked] == ["GET /v1/models/claude-x", "POST /v1/messages"]
            assert played.asked[0].body == b""
            assert played.probed == [PROBE]
            # Every request carries the key it was given, and the version of the API it speaks.
            assert [asked.headers["x-api-key"] for asked in played.asked] == [KEY, KEY]
            assert [asked.headers["anthropic-version"] for asked in played.asked] == ["2023-06-01", "2023-06-01"]

    run(scenario())


def test_limits_it_cannot_learn_are_a_plain_error_with_no_status_and_are_not_kept() -> None:
    async def scenario() -> None:
        async with Anthropic() as played:
            played.model = saying({"type": "error", "error": {"type": "not_found_error", "message": "model: claude-unknown"}}, status=404)
            client = driver(played, "claude-unknown")
            with pytest.raises(
                RuntimeError, match=re.escape("Failed to discover model limits for 'claude-unknown' from the Models API")
            ) as unlearned:
                await client.limits()
            # A discovery that fails is not a refused generation, whatever status refused it: the library's failure is its cause.
            assert type(unlearned.value) is RuntimeError
            assert not hasattr(unlearned.value, "status")
            assert isinstance(unlearned.value.__cause__, anthropic.NotFoundError)
            assert played.probed == []

            # A later call asks again.
            played.model = model_info(max_input_tokens=1000, max_tokens=100)
            assert await client.limits() == limits(context=1000, output=100)
            assert played.retrievals == ["/v1/models/claude-unknown", "/v1/models/claude-unknown"]

    run(scenario())


def test_a_models_api_that_refuses_is_asked_three_times_in_all() -> None:
    async def scenario() -> None:
        async with Anthropic() as played:
            played.model = refused(500, "api_error", "the provider failed")
            with pytest.raises(RuntimeError, match="Failed to discover model limits for 'claude-x'"):
                await driver(played).limits()
            assert len(played.retrievals) == 3
            assert played.probed == []

    run(scenario())


def test_a_model_whose_ceilings_the_models_api_does_not_state_is_refused() -> None:
    async def scenario() -> None:
        async with Anthropic() as played:
            played.model = model_info(max_input_tokens=None, max_tokens=None)
            with pytest.raises(RuntimeError, match=re.escape("Models API reports no context/output ceilings for 'claude-x'")):
                await driver(played).limits()
            assert played.probed == []

    run(scenario())


def test_callers_that_ask_at_once_share_one_discovery() -> None:
    async def scenario() -> None:
        async with Anthropic() as played:
            played.script(reply("one"), reply("two"))
            client = driver(played)
            answers = await soon(asyncio.gather(client.generate_text("a", 100, 0), client.generate_text("b", 100, 0), client.limits()))
            assert sorted(answer.text for answer in answers if isinstance(answer, InferenceResponse)) == ["one", "two"]
            assert answers[2] == limits()
            assert len(played.retrievals) == 1
            assert played.probed == [PROBE]

    run(scenario())


# ── whether the model takes a temperature ───────────────────────────────


def test_a_model_that_refuses_a_temperature_is_sent_none_on_either_path() -> None:
    # Such a model answers 400 to any request that carries one, and the Models API does not say which models they are.
    async def scenario() -> None:
        async with Anthropic() as played:
            played.refuses_temperature = True
            played.script(reply("ok"), reply("[]"))
            client = driver(played, "claude-sonnet-5")
            assert (await client.generate_text("p", 100, 0.3)).text == "ok"
            assert (await client.generate_structured("p", 100, 0, ELEMENT)).items == []
            assert played.generations == [
                said_to("claude-sonnet-5", "p", max_tokens=100),
                {**said_to("claude-sonnet-5", "p", max_tokens=100), "output_config": array_of(ELEMENT)},
            ]

    run(scenario())


def test_a_model_that_takes_a_temperature_is_sent_the_callers() -> None:
    async def scenario() -> None:
        async with Anthropic() as played:
            played.script(reply("ok"))
            await driver(played).generate_text("p", 100, 0.3)
            assert played.generations == [said_to("claude-x", "p", max_tokens=100, temperature=0.3)]

    run(scenario())


def test_whether_the_model_takes_a_temperature_is_said_on_its_limits() -> None:
    async def scenario() -> None:
        async with Anthropic() as played:
            played.refuses_temperature = True
            assert await driver(played).limits() == limits(accepts_temperature=False)
        async with Anthropic() as played:
            assert await driver(played).limits() == limits(accepts_temperature=True)

    run(scenario())


def test_the_model_is_probed_once_and_the_omission_is_warned_of_once(caplog: pytest.LogCaptureFixture) -> None:
    async def scenario() -> None:
        async with Anthropic() as played:
            played.refuses_temperature = True
            played.script(reply("a"), reply("b"))
            client = driver(played, "claude-sonnet-5")
            await client.generate_text("a", 100, 0.3)
            await client.generate_text("b", 100, 0.5)
            # One probe, carrying a temperature, and two generations without.
            assert played.probed == [{**PROBE, "model": "claude-sonnet-5"}]
            assert len(played.messages) == 3

    caplog.set_level(logging.DEBUG, logger="semiont_inference")
    run(scenario())
    warned = [record for record in ours(caplog) if record.levelno == logging.WARNING]
    assert [record.getMessage() for record in warned] == [
        "Model rejects `temperature`; caller-supplied values will be omitted from its requests"
    ]
    assert vars(warned[0])["model"] == "claude-sonnet-5"


@pytest.mark.parametrize(
    ("refusal", "asked"),
    [
        (refused(500, "api_error", "overloaded"), 3),
        (refused(400, "invalid_request_error", "max_tokens: must be at least 2"), 1),
    ],
    ids=["a failure of the provider", "a 400 that is not about the temperature"],
)
def test_a_probe_that_fails_for_another_reason_fails_the_discovery_and_is_not_kept(refusal: Answer, asked: int) -> None:
    async def scenario() -> None:
        async with Anthropic() as played:
            played.probes = [refusal] * asked
            played.script(reply("ok"))
            client = driver(played)
            with pytest.raises(RuntimeError, match=re.escape("Sampling-parameter probe failed for 'claude-x'")) as failed:
                await client.generate_text("p", 100, 0)
            assert type(failed.value) is RuntimeError
            assert isinstance(failed.value.__cause__, anthropic.APIStatusError)
            assert len(played.probed) == asked
            assert played.generations == []

            # The next call learns of the model again, from the start.
            assert (await client.generate_text("p", 100, 0)).text == "ok"
            assert len(played.retrievals) == 2
            assert len(played.probed) == asked + 1

    run(scenario())


# ── the request ─────────────────────────────────────────────────────────


def test_plain_text_is_one_request_of_exactly_these_members() -> None:
    async def scenario() -> None:
        async with Anthropic() as played:
            played.script(reply("hello world"))
            answer = await driver(played).generate_text("p", 100, 0)
            assert answer == InferenceResponse(text="hello world", stop_reason="end_turn", usage=COUNTED)
            # No tools, no schema, and no `stream`: the answer is asked for whole.
            assert played.generations == [said_to("claude-x", "p", max_tokens=100, temperature=0)]
            assert [asked.headers["x-api-key"] for asked in played.asked] == [KEY, KEY, KEY]

    run(scenario())


def test_a_structured_generation_asks_for_an_array_at_the_root_of_the_reply_and_no_tool() -> None:
    async def scenario() -> None:
        async with Anthropic() as played:
            played.script(reply('[{"exact":"Paris"}]'))
            answer = await driver(played).generate_structured("Extract locations", 1000, 0, ELEMENT)
            # The reply's text is the JSON: there is no tool to unwrap, and no assistant turn to begin it.
            assert played.generations == [
                {**said_to("claude-x", "Extract locations", max_tokens=1000, temperature=0), "output_config": array_of(ELEMENT)}
            ]
            assert answer == StructuredResponse(items=[{"exact": "Paris"}], stop_reason="end_turn", usage=COUNTED)

    run(scenario())


@pytest.mark.parametrize("structured", [False, True], ids=["text", "structured"])
def test_an_answer_of_more_than_21333_tokens_is_asked_for_as_a_stream_and_read_the_same(structured: bool) -> None:
    # The library refuses to wait for a whole answer it reckons could take over ten minutes
    # (the next test), so above that the driver asks for a stream and puts the answer together.
    said = '[{"exact":"A"},{"exact":"the “best” café"}]'

    async def scenario() -> None:
        async with Anthropic() as played:
            played.script(reply(said), reply(said))
            client = driver(played)
            extra: JsonObject = {"output_config": array_of(ELEMENT)} if structured else {}
            for max_tokens in (21_333, 21_334):
                if structured:
                    answer = await client.generate_structured("p", max_tokens, 0, ELEMENT)
                    assert answer == StructuredResponse(
                        items=[{"exact": "A"}, {"exact": "the “best” café"}], stop_reason="end_turn", usage=COUNTED
                    )
                else:
                    assert await client.generate_text("p", max_tokens, 0) == InferenceResponse(
                        text=said, stop_reason="end_turn", usage=COUNTED
                    )
            assert played.generations == [
                {**said_to("claude-x", "p", max_tokens=21_333, temperature=0), **extra},
                {**said_to("claude-x", "p", max_tokens=21_334, temperature=0, stream=True), **extra},
            ]

    run(scenario())


def test_the_library_refuses_a_whole_answer_exactly_where_this_driver_starts_to_stream() -> None:
    # The driver's ceiling is the library's own rule (128,000 tokens an hour, ten minutes), written a second
    # time. This asks the library itself, so a release that moves its rule fails here.
    async def scenario() -> None:
        async with Anthropic() as played:
            played.script(reply("ok"))
            async with anthropic.AsyncAnthropic(api_key=KEY, base_url=played.origin, max_retries=0) as library:
                await library.messages.create(model="claude-x", max_tokens=21_333, messages=[{"role": "user", "content": "p"}])
                with pytest.raises(ValueError, match="Streaming is required"):
                    await library.messages.create(model="claude-x", max_tokens=21_334, messages=[{"role": "user", "content": "p"}])
            assert played.generations == [said_to("claude-x", "p", max_tokens=21_333)]
        async with Anthropic() as played:
            per_hour = (await driver(played).limits()).output_tokens_per_hour
            # Ten minutes at the rate the driver states is where a whole answer ends and a stream begins.
            assert per_hour == 128_000
            assert per_hour // 6 == 21_333

    run(scenario())


# ── what comes back ─────────────────────────────────────────────────────


def test_the_tokens_are_answered_on_the_text_path_as_on_the_structured_one() -> None:
    async def scenario() -> None:
        async with Anthropic() as played:
            counted: JsonObject = {"input_tokens": 412, "output_tokens": 57}
            played.script(reply("[]", usage=counted), reply("[]", usage=counted), reply("[]", usage=counted))
            client = driver(played)
            usage = TokenUsage(input_tokens=412, output_tokens=57)
            assert await client.generate_text("p", 100, 0) == InferenceResponse(text="[]", stop_reason="end_turn", usage=usage)
            assert await client.generate_structured("p", 100, 0, ELEMENT) == StructuredResponse(
                items=[], stop_reason="end_turn", usage=usage
            )
            # And on a streamed answer, whose counts arrive in two events.
            assert await client.generate_text("p", 64_000, 0) == InferenceResponse(text="[]", stop_reason="end_turn", usage=usage)

    run(scenario())


@pytest.mark.parametrize("usage", [{}, {"input_tokens": 412}, {"output_tokens": 57}], ids=["neither", "read alone", "written alone"])
def test_no_tokens_are_answered_where_the_provider_did_not_count_both_on_either_path(usage: JsonObject) -> None:
    async def scenario() -> None:
        async with Anthropic() as played:
            played.script(reply("[]", usage=usage), reply("[]", usage=usage))
            client = driver(played)
            # Not known is not nothing: a zero would say the call cost nothing.
            assert await client.generate_text("p", 100, 0) == InferenceResponse(text="[]", stop_reason="end_turn", usage=None)
            assert await client.generate_structured("p", 100, 0, ELEMENT) == StructuredResponse(
                items=[], stop_reason="end_turn", usage=None
            )

    run(scenario())


@pytest.mark.parametrize(
    ("stop_reason", "answered"),
    [("end_turn", "end_turn"), ("max_tokens", "max_tokens"), ("stop_sequence", "stop_sequence"), (None, "unknown")],
)
def test_why_the_model_stopped_is_the_providers_word_for_it(stop_reason: str | None, answered: str) -> None:
    async def scenario() -> None:
        async with Anthropic() as played:
            played.script(reply("text", stop_reason=stop_reason), reply("[]", stop_reason=stop_reason))
            client = driver(played)
            assert (await client.generate_text("p", 100, 0)).stop_reason == answered
            assert (await client.generate_structured("p", 100, 0, ELEMENT)).stop_reason == answered

    run(scenario())


EMPTY_TEXT: JsonObject = {"type": "text", "text": ""}
THINKING: JsonObject = {"type": "thinking", "thinking": "Let me work through the text first.", "signature": "sig_played"}


@pytest.mark.parametrize("structured", [False, True], ids=["text", "structured"])
@pytest.mark.parametrize("content", [[EMPTY_TEXT], [THINKING]], ids=["an empty text block", "a thinking block alone"])
def test_a_reply_with_nothing_in_it_is_a_failure_that_carries_the_stop_reason(
    structured: bool, content: list[JsonObject], caplog: pytest.LogCaptureFixture
) -> None:
    # A model that reasons before it answers can spend the whole budget first. Cut off before its
    # first character is still cut off: the failure says so, and is not an empty text or an unreadable one.
    async def scenario() -> None:
        async with Anthropic() as played:
            played.script(Reply(content=content, stop_reason="max_tokens", usage={"input_tokens": 10, "output_tokens": 100}))
            client = driver(played)

            async def generation() -> object:
                if structured:
                    return await client.generate_structured("p", 100, 0, ELEMENT)
                return await client.generate_text("p", 100, 0)

            with pytest.raises(StructuredReadError) as empty:
                await generation()
            assert (empty.value.stop_reason, str(empty.value)) == (
                "max_tokens",
                "Structured response could not be read: response is empty (stop_reason: max_tokens)",
            )

    caplog.set_level(logging.DEBUG, logger="semiont_inference")
    run(scenario())
    (error,) = [record for record in ours(caplog) if record.levelno == logging.ERROR]
    assert error.getMessage() == "Empty response from Anthropic"
    assert {key: vars(error)[key] for key in ("model", "stopReason", "contentTypes")} == {
        "model": "claude-x",
        "stopReason": "max_tokens",
        "contentTypes": [block["type"] for block in content],
    }


def test_a_reply_with_nothing_in_it_and_no_stop_reason_fails_with_the_stop_reason_unknown() -> None:
    async def scenario() -> None:
        async with Anthropic() as played:
            played.script(Reply(content=[], stop_reason=None, usage={"input_tokens": 10, "output_tokens": 0}))
            with pytest.raises(StructuredReadError) as empty:
                await driver(played).generate_text("p", 100, 0)
            assert empty.value.stop_reason == "unknown"

    run(scenario())


def test_a_call_logs_what_typescripts_does_at_the_same_levels(caplog: pytest.LogCaptureFixture) -> None:
    async def scenario() -> None:
        async with Anthropic() as played:
            played.script(reply("hello"), reply('[{"exact":"A"}]'), reply("not an array"))
            client = driver(played)
            await client.generate_text("prompt", 100, 0.2)
            await client.generate_structured("prompt", 100, 0.2, ELEMENT)
            with pytest.raises(StructuredReadError):
                await client.generate_structured("prompt", 100, 0.2, ELEMENT)

    caplog.set_level(logging.DEBUG, logger="semiont_inference")
    run(scenario())
    records = ours(caplog)
    assert [(record.levelname, record.getMessage()) for record in records] == [
        ("DEBUG", "Generating text with inference client"),
        ("INFO", "Text generation completed"),
        ("DEBUG", "Generating structured output with inference client"),
        ("INFO", "Structured generation completed"),
        ("DEBUG", "Generating structured output with inference client"),
        ("ERROR", "Structured response could not be read"),
    ]
    asked, completed, _, structured, _, unread = records
    assert {key: vars(asked)[key] for key in ("model", "promptLength", "maxTokens", "temperature")} == {
        "model": "claude-x",
        "promptLength": 6,
        "maxTokens": 100,
        "temperature": 0.2,
    }
    # The provider's id of the request, for telling one attempt from another in its logs and in ours.
    assert {key: vars(completed)[key] for key in ("model", "textLength", "stopReason", "requestId")} == {
        "model": "claude-x",
        "textLength": 5,
        "stopReason": "end_turn",
        "requestId": "req_played_2",
    }
    assert {key: vars(structured)[key] for key in ("model", "items", "stopReason", "requestId")} == {
        "model": "claude-x",
        "items": 1,
        "stopReason": "end_turn",
        "requestId": "req_played_3",
    }
    assert {key: vars(unread)[key] for key in ("model", "textLength", "stopReason")} == {
        "model": "claude-x",
        "textLength": 12,
        "stopReason": "end_turn",
    }


def test_a_streamed_answer_is_logged_with_the_id_of_its_request(caplog: pytest.LogCaptureFixture) -> None:
    async def scenario() -> None:
        async with Anthropic() as played:
            played.script(reply("hello"))
            await driver(played).generate_text("prompt", 64_000, 0)

    caplog.set_level(logging.INFO, logger="semiont_inference")
    run(scenario())
    assert [vars(record)["requestId"] for record in ours(caplog) if record.getMessage() == "Text generation completed"] == ["req_played_2"]


# ── failures ────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("status", "kind", "asked"),
    [
        (429, "rate_limit_error", 3),
        (500, "api_error", 3),
        (529, "overloaded_error", 3),
        (400, "invalid_request_error", 1),
        (404, "not_found_error", 1),
    ],
)
def test_a_refused_generation_is_a_provider_status_error_with_the_librarys_failure_as_its_cause(status: int, kind: str, asked: int) -> None:
    async def scenario() -> None:
        async with Anthropic() as played:
            played.script(*[refused(status, kind, "what the provider said")] * asked)
            with pytest.raises(ProviderStatusError) as failed:
                await driver(played).generate_text("p", 100, 0)
            cause = failed.value.__cause__
            assert isinstance(cause, anthropic.APIStatusError)
            # What the library said of it, with the status and the provider's own words in it.
            assert (failed.value.status, str(failed.value)) == (status, cause.message)
            assert str(status) in str(failed.value)
            assert "what the provider said" in str(failed.value)
            # The retries are this driver's choice of two: a refusal the library retries is asked three times in all, and any other once.
            assert played.generations == [said_to("claude-x", "p", max_tokens=100, temperature=0)] * asked

    run(scenario())


def test_a_refusal_followed_by_an_answer_is_an_answer() -> None:
    async def scenario() -> None:
        async with Anthropic() as played:
            played.script(refused(429, "rate_limit_error", "the account is over its rate"), reply("[]"))
            assert (await driver(played).generate_structured("p", 100, 0, ELEMENT)).items == []
            assert len(played.generations) == 2

    run(scenario())


def test_the_library_waits_as_long_as_the_provider_says_before_it_asks_again_and_otherwise_a_little_longer_each_time() -> None:
    # The waits are the library's, and the Worker service's suite holds a worker to them: with nothing said,
    # at least 0.375 s and then at least 0.75 s (half a second, then a second, each less up to a quarter).
    def unsaid(status: int) -> Answer:
        return saying({"type": "error", "error": {"type": "overloaded_error", "message": "overloaded"}}, status=status)

    async def scenario() -> None:
        async with Anthropic() as played:
            slow_down: JsonObject = {"type": "error", "error": {"type": "rate_limit_error", "message": "slow down"}}
            said = saying(slow_down, status=429, headers={"retry-after": "2"})
            played.script(unsaid(529), unsaid(500), reply("first"), said, reply("second"))
            client = driver(played)
            await client.limits()
            assert (await hurried(client.generate_text("p", 100, 0))).text == "first"
            assert (await hurried(client.generate_text("p", 100, 0))).text == "second"
            at = [asked.at for asked in played.messages if asked.json().get("max_tokens") != 1]
            first, second, told = at[1] - at[0], at[2] - at[1], at[4] - at[3]
            # Each is held from below, which is what a worker is held to. The loop's clock is moved a quarter of a
            # second at a time here, however long a step really takes, so from above only a wait of the wrong size is refused.
            assert 0.375 <= first < 2, first
            assert 0.75 <= second < 2, second
            assert 2.0 <= told < 4, told

    run(scenario())


def test_a_connection_that_ends_unanswered_is_asked_three_times_and_then_passed_on_as_the_library_reports_it() -> None:
    async def scenario() -> None:
        async with Anthropic() as played:
            played.script(HANG_UP, HANG_UP, HANG_UP)
            client = driver(played)
            await client.limits()
            with pytest.raises(anthropic.APIConnectionError) as ended:
                await hurried(client.generate_text("p", 100, 0))
            # It carries no status: it is the library's failure, and none of those the interface declares.
            assert not hasattr(ended.value, "status")
            assert len(played.generations) == 3

    run(scenario())


def test_a_failure_the_provider_reports_inside_a_stream_it_had_begun_carries_no_refusing_status_and_is_passed_on() -> None:
    # The library builds this failure from the response the stream opened with, whose status is 200.
    # That is no status the provider refused the generation with, so the failure is not read as one.
    overloaded = b'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n\n'

    async def scenario() -> None:
        async with Anthropic() as played:
            played.script(Answer(headers={"content-type": "text/event-stream"}, body=overloaded))
            with pytest.raises(anthropic.APIStatusError) as failed:
                await driver(played).generate_text("p", 64_000, 0)
            assert failed.value.status_code == 200
            assert len(played.generations) == 1

    run(scenario())


# ── cancelling ──────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("structured", "max_tokens"),
    [(False, 100), (True, 100), (True, 64_000)],
    ids=["text", "structured", "streamed"],
)
def test_cancelling_a_generation_ends_its_task_cancelled_and_closes_the_connection(structured: bool, max_tokens: int) -> None:
    async def scenario() -> None:
        async with Anthropic() as played:
            played.script(HOLD)
            client = driver(played)
            await client.limits()

            async def generation() -> object:
                if structured:
                    return await client.generate_structured("p", max_tokens, 0, ELEMENT)
                return await client.generate_text("p", max_tokens, 0)

            call = asyncio.ensure_future(generation())
            await soon(played.arrived("POST", "/v1/messages", 2))
            await settle()
            assert not call.done()
            call.cancel()
            # The cancellation reaches the caller as it is: the library has no abort of its own to report in its place.
            with pytest.raises(asyncio.CancelledError):
                await call
            assert call.cancelled()
            # The provider sees the request torn down, and the library does not ask again for a caller that left.
            await soon(played.closed_by_client.wait())
            await settle()
            assert len(played.generations) == 1

    run(scenario())


def test_a_caller_cancelled_while_the_model_is_being_learned_of_leaves_at_once_and_the_others_still_learn() -> None:
    async def scenario() -> None:
        async with Anthropic() as played:
            played.probes = [HOLD]
            client = driver(played)
            leaving = asyncio.ensure_future(client.generate_text("p", 100, 0))
            staying = asyncio.ensure_future(client.limits())
            await soon(played.arrived("POST", "/v1/messages"))
            leaving.cancel()
            with pytest.raises(asyncio.CancelledError):
                await leaving
            assert leaving.cancelled()
            await settle()
            assert not played.closed_by_client.is_set()
            played.release(
                saying({"type": "message", "role": "assistant", "content": [{"type": "text", "text": "ok"}], "stop_reason": "max_tokens"})
            )
            assert await soon(staying) == limits()
            assert (len(played.retrievals), len(played.probed), played.generations) == (1, 1, [])

    run(scenario())
