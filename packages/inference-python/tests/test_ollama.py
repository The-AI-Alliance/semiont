"""The Ollama driver, against an Ollama this test plays over HTTP.

A generation asks `/api/show` first (the model's limits), so every scenario
has both calls. What the driver sends is held exactly: in P5 the Worker
service's suite (`tests/conformance/worker-service`) holds the Python worker
to the same bodies.
"""

import asyncio
import logging
import math
import re

import httpx
import pytest
from aio import pass_time, run, settle, soon
from provider import HANG_UP, HOLD, Answer, Ollama, generated, saying, shown, window
from spec import WORKER_SERVICE_SUITE, JsonObject

from semiont_inference.interface import (
    InferenceLimits,
    InferenceResponse,
    ProviderStatusError,
    StructuredReadError,
    StructuredResponse,
    TokenUsage,
)
from semiont_inference.ollama import OllamaInferenceClient

ELEMENT: JsonObject = {"type": "object", "properties": {"exact": {"type": "string"}}, "required": ["exact"], "additionalProperties": False}
EMPTY = generated("[]")


def shared(context_tokens: int) -> InferenceLimits:
    """One window for what goes in and what comes out, as an Ollama model's is stated."""
    return InferenceLimits(
        context_tokens=context_tokens, max_output_tokens=context_tokens, output_tokens_per_hour=None, accepts_temperature=True
    )


def warnings_of(caplog: pytest.LogCaptureFixture) -> list[logging.LogRecord]:
    return [record for record in caplog.records if record.name == "semiont_inference" and record.levelno == logging.WARNING]


# ── limits ──────────────────────────────────────────────────────────────


def test_it_learns_the_models_window_from_api_show_once_and_keeps_it() -> None:
    async def scenario() -> None:
        async with Ollama() as ollama:
            client = OllamaInferenceClient(model="llama3", base_url=ollama.origin)
            # One window: there is no separate ceiling on what comes out, so the window is stated as both.
            assert await client.limits() == shared(8192)
            assert await client.limits() == shared(8192)
            assert ollama.shows == [{"model": "llama3"}]
            assert ollama.of("POST", "/api/show")[0].headers["content-type"] == "application/json"

    run(scenario())


def test_it_takes_any_context_length_when_the_model_names_no_architecture() -> None:
    async def scenario() -> None:
        async with Ollama() as ollama:
            ollama.show = shown({"qwen2.context_length": 32768})
            assert await OllamaInferenceClient(model="qwen2", base_url=ollama.origin).limits() == shared(32768)

    run(scenario())


def test_the_architectures_own_context_length_is_taken_before_any_other() -> None:
    async def scenario() -> None:
        async with Ollama() as ollama:
            ollama.show = shown({"other.context_length": 111, "general.architecture": "llama", "llama.context_length": 4096})
            assert await OllamaInferenceClient(model="llama3", base_url=ollama.origin).limits() == shared(4096)

    run(scenario())


def test_limits_the_provider_refuses_to_state_are_a_status_error_that_says_the_status_and_are_not_kept() -> None:
    async def scenario() -> None:
        async with Ollama() as ollama:
            ollama.show = saying({"error": "the model is loading"}, status=500)
            client = OllamaInferenceClient(model="llama3", base_url=ollama.origin)
            with pytest.raises(ProviderStatusError) as refused:
                await client.limits()
            # A refused discovery is classed as a refused generation is, by its status.
            assert str(refused.value) == "Failed to discover model limits: /api/show returned 500 for 'llama3'"
            assert refused.value.status == 500

            # The provider recovers, and the next call asks again.
            ollama.show = window(8192)
            assert await client.limits() == shared(8192)
            assert len(ollama.shows) == 2

    run(scenario())


@pytest.mark.parametrize(
    "said",
    [
        shown({"general.architecture": "llama"}),
        shown({"general.architecture": "llama", "llama.context_length": 0}),
        shown({"general.architecture": "llama", "llama.context_length": "8192"}),
        saying({}),
        saying([8192]),
        Answer(body=b"not JSON"),
    ],
    ids=["none", "zero", "text", "no model_info", "not an object", "not JSON"],
)
def test_a_show_that_states_no_context_length_is_refused(said: Answer) -> None:
    async def scenario() -> None:
        async with Ollama() as ollama:
            ollama.show = said
            with pytest.raises(RuntimeError, match=re.escape("/api/show reports no context length for 'llama3'")):
                await OllamaInferenceClient(model="llama3", base_url=ollama.origin).limits()

    run(scenario())


def test_callers_that_ask_at_once_share_one_request_for_the_limits() -> None:
    async def scenario() -> None:
        async with Ollama() as ollama:
            ollama.show = HOLD
            client = OllamaInferenceClient(model="llama3", base_url=ollama.origin)
            first, second = asyncio.ensure_future(client.limits()), asyncio.ensure_future(client.limits())
            await soon(ollama.arrived("POST", "/api/show"))
            await settle()
            assert ollama.holding == 1
            ollama.release(window(4096))
            assert list(await soon(asyncio.gather(first, second))) == [shared(4096), shared(4096)]
            assert len(ollama.shows) == 1

    run(scenario())


def test_a_caller_cancelled_while_the_limits_are_being_learned_leaves_at_once_and_the_others_still_get_them() -> None:
    async def scenario() -> None:
        async with Ollama() as ollama:
            ollama.show = HOLD
            ollama.script(EMPTY)
            client = OllamaInferenceClient(model="llama3", base_url=ollama.origin)
            leaving = asyncio.ensure_future(client.generate_text("p", 100, 0))
            staying = asyncio.ensure_future(client.limits())
            await soon(ollama.arrived("POST", "/api/show"))
            leaving.cancel()
            with pytest.raises(asyncio.CancelledError):
                await leaving
            assert leaving.cancelled()
            # What is learned once for every caller is not one caller's to end: the request is still open.
            await settle()
            assert not ollama.closed_by_client.is_set()
            ollama.release(window(4096))
            assert await soon(staying) == shared(4096)
            assert len(ollama.shows) == 1
            assert ollama.generations == []

    run(scenario())


def test_the_request_for_the_limits_gives_up_after_five_minutes() -> None:
    async def scenario() -> None:
        async with Ollama() as ollama:
            ollama.show = HOLD
            asking = asyncio.ensure_future(OllamaInferenceClient(model="llama3", base_url=ollama.origin).limits())
            await soon(ollama.arrived("POST", "/api/show"))
            await pass_time(290, step=29)
            assert not asking.done()
            await pass_time(20, step=5)
            with pytest.raises(httpx.ReadTimeout):
                await soon(asking)

    run(scenario())


# ── the request ─────────────────────────────────────────────────────────


def test_a_generation_is_one_post_of_exactly_these_members() -> None:
    async def scenario() -> None:
        async with Ollama() as ollama:
            ollama.script(generated("hello"))
            # Slashes at the end of the address are not part of it.
            client = OllamaInferenceClient(model="llama3", base_url=ollama.origin + "//")
            assert await client.generate_text("p", 100, 0.3) == InferenceResponse(text="hello", stop_reason="end_turn", usage=None)
            # No `format`: a plain generation is not held to a schema. One token of prompt, a hundred of answer, and the allowance.
            assert ollama.generations == [
                {
                    "model": "llama3",
                    "prompt": "p",
                    "stream": False,
                    "think": False,
                    "options": {"num_predict": 100, "num_ctx": 166, "temperature": 0.3},
                }
            ]
            assert ollama.of("POST", "/api/generate")[0].headers["content-type"] == "application/json"
            assert [f"{asked.method} {asked.path}" for asked in ollama.asked] == ["POST /api/show", "POST /api/generate"]

    run(scenario())


def test_a_structured_generation_sends_the_callers_schema_as_the_elements_of_an_array() -> None:
    async def scenario() -> None:
        async with Ollama() as ollama:
            ollama.script(generated('[{"exact":"Paris"}]'))
            client = OllamaInferenceClient(model="llama3", base_url=ollama.origin)
            answer = await client.generate_structured("p", 100, 0, ELEMENT)
            assert answer == StructuredResponse(items=[{"exact": "Paris"}], stop_reason="end_turn", usage=None)
            assert ollama.generations == [
                {
                    "model": "llama3",
                    "prompt": "p",
                    "stream": False,
                    "think": False,
                    "options": {"num_predict": 100, "num_ctx": 166, "temperature": 0},
                    "format": {"type": "array", "items": ELEMENT},
                }
            ]

    run(scenario())


def test_it_sends_what_the_worker_services_suite_holds_a_highlighting_job_to() -> None:
    # The suite states the request of its highlighting case and the window its stand-in reports. Both are read
    # from it, so a change there is seen here: what the Python driver sends for that prompt is what it pins.
    case = (WORKER_SERVICE_SUITE / "highlighting.test.ts").read_text(encoding="utf-8")
    pinned = re.search(r"^const REQUEST = \{ num_predict: (\d+), num_ctx: (\d+), temperature: (\d+) \};$", case, re.MULTILINE)
    assert pinned is not None, "the suite no longer states its highlighting request as it did"
    num_predict, num_ctx, temperature = (int(number) for number in pinned.groups())
    reported = re.search(
        r"^export const CONTEXT_LENGTH = (\d+);$", (WORKER_SERVICE_SUITE / "support.ts").read_text(encoding="utf-8"), re.MULTILINE
    )
    assert reported is not None, "the suite no longer states the window its stand-in reports as it did"
    prompt = (WORKER_SERVICE_SUITE / "prompts/highlighting.txt").read_text(encoding="utf-8").removesuffix("\n")
    assert (num_predict, num_ctx, temperature) == (5284, 5785, 0)

    async def scenario() -> None:
        async with Ollama(int(reported.group(1))) as ollama:
            ollama.script(EMPTY)
            await OllamaInferenceClient(model="llama3", base_url=ollama.origin).generate_structured(
                prompt, num_predict, temperature, ELEMENT
            )
            assert ollama.generations == [
                {
                    "model": "llama3",
                    "prompt": prompt,
                    "stream": False,
                    "think": False,
                    "options": {"num_predict": num_predict, "num_ctx": num_ctx, "temperature": temperature},
                    "format": {"type": "array", "items": ELEMENT},
                }
            ]

    run(scenario())


@pytest.mark.parametrize(
    ("prompt", "max_tokens", "num_ctx"),
    [
        # 1000 tokens of prompt and 500 of answer, a fifth of the prompt again, and 64 for the model's template.
        ("x" * 4000, 500, 1764),
        # A token is four code points, rounded up: 4001 code points are 1001 tokens, and a fifth of that rounds up to 201.
        ("x" * 4001, 500, 1766),
        # An empty prompt is no tokens.
        ("", 500, 564),
        # Code points, not UTF-16 units: eight emoji are eight code points, two tokens.
        ("\U0001f600" * 8, 100, 167),
        # Never above the model's window: 6000 + 2000 + 1200 + 64 is over 8192.
        ("x" * 24000, 2000, 8192),
        # The prompt and the answer may fill the window exactly.
        ("x" * 24768, 2000, 8192),
    ],
    ids=["a round prompt", "a prompt one over", "no prompt", "emoji", "capped at the window", "the window filled"],
)
def test_num_ctx_covers_the_prompt_and_the_answer_and_is_never_above_the_window(prompt: str, max_tokens: int, num_ctx: int) -> None:
    async def scenario() -> None:
        async with Ollama() as ollama:
            ollama.script(generated("ok"))
            await OllamaInferenceClient(model="llama3", base_url=ollama.origin).generate_text(prompt, max_tokens, 0)
            # `num_predict` is the caller's budget. Without a `num_ctx` Ollama takes the model's default window and clips what is over it.
            assert ollama.generations[0]["options"] == {"num_predict": max_tokens, "num_ctx": num_ctx, "temperature": 0}

    tokens = math.ceil(len(prompt) / 4)
    assert num_ctx == min(8192, tokens + max_tokens + math.ceil(tokens * 0.2) + 64)
    run(scenario())


def test_a_prompt_and_answer_over_the_window_are_refused_and_nothing_is_asked_of_the_model() -> None:
    async def scenario() -> None:
        async with Ollama(2048) as ollama:
            client = OllamaInferenceClient(model="llama3", base_url=ollama.origin)
            with pytest.raises(
                ValueError, match=re.escape("Prompt (~10000 tokens) + output budget (500) exceed the 'llama3' context window (2048 tokens)")
            ):
                await client.generate_text("x" * 40_000, 500, 0.3)
            # One token over is over.
            with pytest.raises(ValueError, match="exceed"):
                await client.generate_text("x" * 6196, 500, 0.3)
            assert ollama.generations == []

    run(scenario())


def test_the_temperature_is_always_sent() -> None:
    async def scenario() -> None:
        async with Ollama() as ollama:
            ollama.script(generated("ok"), EMPTY)
            client = OllamaInferenceClient(model="llama3", base_url=ollama.origin)
            assert (await client.limits()).accepts_temperature is True
            await client.generate_text("p", 100, 0.3)
            await client.generate_structured("p", 100, 0.9, ELEMENT)
            assert [generation["options"] for generation in ollama.generations] == [
                {"num_predict": 100, "num_ctx": 166, "temperature": 0.3},
                {"num_predict": 100, "num_ctx": 166, "temperature": 0.9},
            ]

    run(scenario())


# ── what comes back ─────────────────────────────────────────────────────


def test_the_tokens_are_answered_when_the_provider_counted_both_and_not_otherwise() -> None:
    async def scenario() -> None:
        async with Ollama() as ollama:
            ollama.script(
                generated("[]", prompt_eval_count=412, eval_count=57),
                generated("[]", prompt_eval_count=412, eval_count=57),
                generated("[]", prompt_eval_count=412),
                generated("[]", eval_count=57),
                generated("[]"),
            )
            client = OllamaInferenceClient(model="llama3", base_url=ollama.origin)
            counted = TokenUsage(input_tokens=412, output_tokens=57)
            assert await client.generate_text("p", 100, 0) == InferenceResponse(text="[]", stop_reason="end_turn", usage=counted)
            assert await client.generate_structured("p", 100, 0, ELEMENT) == StructuredResponse(
                items=[], stop_reason="end_turn", usage=counted
            )
            # One count is not a usage: what is not known is not made up.
            assert (await client.generate_text("p", 100, 0)).usage is None
            assert (await client.generate_structured("p", 100, 0, ELEMENT)).usage is None
            assert (await client.generate_text("p", 100, 0)).usage is None

    run(scenario())


@pytest.mark.parametrize(
    ("done_reason", "stop_reason"),
    [("stop", "end_turn"), ("length", "max_tokens"), ("load", "load"), (None, "unknown"), ("", "unknown")],
)
def test_why_the_model_stopped_is_said_in_the_interfaces_words(done_reason: str | None, stop_reason: str) -> None:
    async def scenario() -> None:
        async with Ollama() as ollama:
            ollama.script(generated("text", done_reason=done_reason))
            answer = await OllamaInferenceClient(model="llama3", base_url=ollama.origin).generate_text("p", 100, 0)
            assert answer.stop_reason == stop_reason

    run(scenario())


def test_an_unreadable_reply_with_no_done_reason_fails_with_the_stop_reason_unknown() -> None:
    # A shape gemma4:26b produces. `unknown` is what a worker reads to leave the failure unclassified.
    async def scenario() -> None:
        async with Ollama() as ollama:
            ollama.script(generated('entity: Cedar County ("the Society' * 200, done_reason=None))
            with pytest.raises(StructuredReadError) as unread:
                await OllamaInferenceClient(model="gemma4:26b", base_url=ollama.origin).generate_structured("p", 100, 0, {"type": "object"})
            assert unread.value.stop_reason == "unknown"
            assert str(unread.value) == "Structured response could not be read: response is not valid JSON (stop_reason: unknown)"
            assert unread.value.__cause__ is not None

    run(scenario())


def test_a_reply_cut_off_by_the_budget_fails_with_the_stop_reason_max_tokens() -> None:
    async def scenario() -> None:
        async with Ollama() as ollama:
            ollama.script(generated('[{"exact":"Par', done_reason="length"))
            with pytest.raises(StructuredReadError) as unread:
                await OllamaInferenceClient(model="gemma4:26b", base_url=ollama.origin).generate_structured("p", 100, 0, {"type": "object"})
            assert unread.value.stop_reason == "max_tokens"

    run(scenario())


def test_an_empty_reply_is_a_failure_that_carries_the_stop_reason_on_either_path() -> None:
    # A thinking model can spend the whole budget on hidden reasoning before the first character of its answer.
    async def scenario() -> None:
        async with Ollama() as ollama:
            ollama.script(
                generated("", done_reason="length"), generated("", done_reason=None), saying({"done": True, "done_reason": "stop"})
            )
            client = OllamaInferenceClient(model="gpt-oss:120b-cloud", base_url=ollama.origin)
            with pytest.raises(StructuredReadError) as cut_off:
                await client.generate_structured("p", 100, 0, {"type": "object"})
            assert (cut_off.value.stop_reason, str(cut_off.value)) == (
                "max_tokens",
                "Structured response could not be read: response is empty (stop_reason: max_tokens)",
            )
            with pytest.raises(StructuredReadError) as broken:
                await client.generate_text("p", 100, 0)
            assert broken.value.stop_reason == "unknown"
            with pytest.raises(StructuredReadError) as absent:
                await client.generate_text("p", 100, 0)
            assert absent.value.stop_reason == "end_turn"

    run(scenario())


@pytest.mark.parametrize(
    ("response", "detail"),
    [
        ('{"entities": []}', "parsed to object, not an array"),
        ('"Paris"', "parsed to string, not an array"),
        ("12", "parsed to number, not an array"),
        ("true", "parsed to boolean, not an array"),
        ("null", "parsed to null, not an array"),
        ("[NaN]", "response is not valid JSON"),
        ("I found three passages.", "response is not valid JSON"),
    ],
)
def test_a_reply_that_is_not_a_json_array_could_not_be_read(response: str, detail: str) -> None:
    async def scenario() -> None:
        async with Ollama() as ollama:
            ollama.script(generated(response))
            with pytest.raises(StructuredReadError) as unread:
                await OllamaInferenceClient(model="llama3", base_url=ollama.origin).generate_structured("p", 100, 0, {"type": "object"})
            assert str(unread.value) == f"Structured response could not be read: {detail} (stop_reason: end_turn)"

    run(scenario())


@pytest.mark.parametrize("said", [Answer(body=b"<html>busy</html>"), saying(["hello"])], ids=["not JSON", "not an object"])
def test_an_answer_that_is_not_a_json_object_could_not_be_read(said: Answer) -> None:
    async def scenario() -> None:
        async with Ollama() as ollama:
            ollama.script(said)
            with pytest.raises(StructuredReadError) as unread:
                await OllamaInferenceClient(model="llama3", base_url=ollama.origin).generate_text("p", 100, 0)
            assert unread.value.stop_reason == "unknown"

    run(scenario())


def test_hidden_thinking_is_warned_of_once_for_the_call_with_its_size(caplog: pytest.LogCaptureFixture) -> None:
    # A cloud model ignores `think: false`: the reasoning happens, is billed, and is counted among the tokens written.
    async def scenario() -> None:
        async with Ollama() as ollama:
            ollama.script(generated("[]", thinking="x" * 500))
            await OllamaInferenceClient(model="gpt-oss:120b-cloud", base_url=ollama.origin).generate_structured(
                "p", 100, 0, {"type": "object"}
            )

    caplog.set_level(logging.DEBUG, logger="semiont_inference")
    run(scenario())
    (warned,) = warnings_of(caplog)
    assert re.search("thinking", warned.getMessage(), re.IGNORECASE)
    assert (vars(warned)["model"], vars(warned)["thinkingChars"]) == ("gpt-oss:120b-cloud", 500)


def test_a_call_logs_what_typescripts_does_at_the_same_levels(caplog: pytest.LogCaptureFixture) -> None:
    async def scenario() -> None:
        async with Ollama() as ollama:
            ollama.script(generated("hello"), saying({"error": "busy"}, status=503), generated(""), generated("not an array"))
            client = OllamaInferenceClient(model="llama3", base_url=ollama.origin)
            await client.generate_text("prompt", 100, 0)
            with pytest.raises(ProviderStatusError):
                await client.generate_text("prompt", 100, 0)
            with pytest.raises(StructuredReadError):
                await client.generate_text("prompt", 100, 0)
            with pytest.raises(StructuredReadError):
                await client.generate_structured("prompt", 100, 0, ELEMENT)

    caplog.set_level(logging.DEBUG, logger="semiont_inference")
    run(scenario())
    ours = [record for record in caplog.records if record.name == "semiont_inference"]
    assert warnings_of(caplog) == []
    assert [(record.levelname, record.getMessage()) for record in ours] == [
        ("DEBUG", "Generating text with Ollama"),
        ("INFO", "Text generation completed"),
        ("DEBUG", "Generating text with Ollama"),
        ("ERROR", "Ollama API error"),
        ("DEBUG", "Generating text with Ollama"),
        ("ERROR", "Empty response from Ollama"),
        ("DEBUG", "Generating text with Ollama"),
        ("INFO", "Text generation completed"),
        ("ERROR", "Structured response could not be read"),
    ]
    asked, completed, _, refused = ours[:4]
    assert {key: vars(asked)[key] for key in ("model", "promptLength", "maxTokens", "temperature", "structured")} == {
        "model": "llama3",
        "promptLength": 6,
        "maxTokens": 100,
        "temperature": 0,
        "structured": False,
    }
    assert {key: vars(completed)[key] for key in ("model", "textLength", "stopReason")} == {
        "model": "llama3",
        "textLength": 5,
        "stopReason": "end_turn",
    }
    assert {key: vars(refused)[key] for key in ("model", "status", "body")} == {
        "model": "llama3",
        "status": 503,
        "body": '{"error":"busy"}',
    }
    assert vars(ours[6])["structured"] is True


# ── failures ────────────────────────────────────────────────────────────


@pytest.mark.parametrize("status", [400, 429, 500, 503])
def test_a_refused_generation_is_a_provider_status_error_that_says_what_the_provider_said(status: int) -> None:
    async def scenario() -> None:
        async with Ollama() as ollama:
            ollama.script(Answer(status=status, body=b"error body"))
            with pytest.raises(ProviderStatusError) as refused:
                await OllamaInferenceClient(model="llama3", base_url=ollama.origin).generate_text("p", 100, 0)
            assert (refused.value.status, str(refused.value)) == (status, f"Ollama API error ({status}): error body")
            # Asked once: a refusal is not asked again by the driver.
            assert len(ollama.generations) == 1

    run(scenario())


def test_a_connection_that_ends_unanswered_is_passed_on_as_it_came() -> None:
    async def scenario() -> None:
        async with Ollama() as ollama:
            ollama.script(HANG_UP)
            with pytest.raises(httpx.TransportError) as ended:
                await OllamaInferenceClient(model="llama3", base_url=ollama.origin).generate_text("p", 100, 0)
            assert not hasattr(ended.value, "status")
            assert len(ollama.generations) == 1

    run(scenario())


# ── cancelling, and how long a call may take ────────────────────────────


@pytest.mark.parametrize("structured", [False, True], ids=["text", "structured"])
def test_cancelling_a_generation_ends_its_task_cancelled_and_closes_the_connection(structured: bool) -> None:
    async def scenario() -> None:
        async with Ollama() as ollama:
            ollama.script(HOLD)
            client = OllamaInferenceClient(model="llama3", base_url=ollama.origin)

            async def generation() -> object:
                if structured:
                    return await client.generate_structured("p", 100, 0, ELEMENT)
                return await client.generate_text("p", 100, 0)

            call = asyncio.ensure_future(generation())
            await soon(ollama.arrived("POST", "/api/generate"))
            await settle()
            assert not call.done()
            call.cancel()
            with pytest.raises(asyncio.CancelledError):
                await call
            assert call.cancelled()
            # The provider sees the request torn down: nothing goes on generating for a caller that left.
            await soon(ollama.closed_by_client.wait())
            assert len(ollama.generations) == 1

    run(scenario())


def test_a_generation_waits_as_long_as_its_caller_does() -> None:
    # Ollama sends nothing, not a header, until the whole answer is made. Any bound of the transport
    # would be a ceiling on a generation's length that the caller never chose.
    async def scenario() -> None:
        async with Ollama() as ollama:
            ollama.script(HOLD)
            call = asyncio.ensure_future(OllamaInferenceClient(model="llama3", base_url=ollama.origin).generate_text("p", 100, 0))
            await soon(ollama.arrived("POST", "/api/generate"))
            await pass_time(6 * 3600, step=600)
            assert not call.done()
            ollama.release(generated("at last"))
            assert (await soon(call)).text == "at last"

    run(scenario())
