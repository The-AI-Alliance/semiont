"""The mock: a client that answers from a list it was given, and keeps the calls made of it."""

import asyncio

import pytest
from aio import run
from spec import JsonObject

from semiont_inference.interface import ElementSchema, InferenceLimits, InferenceResponse, StructuredReadError, StructuredResponse
from semiont_inference.mock import MockInferenceClient

LIMITS = InferenceLimits(context_tokens=100, max_output_tokens=50, output_tokens_per_hour=None, accepts_temperature=None)


def mock(*responses: str) -> MockInferenceClient:
    return MockInferenceClient(responses, stop_reasons=["end_turn"] * len(responses), limits=LIMITS)


def recorded(client: MockInferenceClient) -> list[tuple[str, int, float, ElementSchema | None]]:
    return [(call.prompt, call.max_tokens, call.temperature, call.element_schema) for call in client.calls]


def test_it_answers_with_what_it_was_given_and_keeps_the_call() -> None:
    async def scenario() -> None:
        client = mock("Test response")
        assert await client.generate_text("Test prompt", 1000, 0.8) == InferenceResponse(
            text="Test response", stop_reason="end_turn", usage=None
        )
        assert recorded(client) == [("Test prompt", 1000, 0.8, None)]

    run(scenario())


def test_its_replies_are_taken_in_order_and_the_last_is_given_again() -> None:
    async def scenario() -> None:
        client = MockInferenceClient(["Response 1", "Response 2"], stop_reasons=["max_tokens", "end_turn"], limits=LIMITS)
        answers = [await client.generate_text(prompt, 500, 0.7) for prompt in ("First call", "Second call", "Third call")]
        assert [(answer.text, answer.stop_reason) for answer in answers] == [
            ("Response 1", "max_tokens"),
            ("Response 2", "end_turn"),
            ("Response 2", "end_turn"),
        ]
        assert [call.prompt for call in client.calls] == ["First call", "Second call", "Third call"]

    run(scenario())


def test_calls_made_at_once_are_each_answered_and_each_kept() -> None:
    async def scenario() -> None:
        client = mock("Response")
        answers = await asyncio.gather(*(client.generate_text(f"Prompt {number}", 500, 0.7) for number in (1, 2, 3)))
        assert [answer.text for answer in answers] == ["Response"] * 3
        assert sorted(call.prompt for call in client.calls) == ["Prompt 1", "Prompt 2", "Prompt 3"]

    run(scenario())


@pytest.mark.parametrize(
    ("prompt", "max_tokens", "temperature"),
    [
        ("Test", 0, 0.7),
        ("Test", 100_000, 0.7),
        ("Test", 500, 0),
        ("Test", 500, 1),
        ("", 500, 0.7),
        ("a" * 10_000, 500, 0.7),
        ("Hello\\n\\nWorld\\t\"quotes\"\\n'single'\\n${variable}\\n`backticks`", 500, 0.7),
        ("Hello 世界 🌍 emoji", 500, 0.7),
    ],
    ids=["no tokens", "many tokens", "temperature 0", "temperature 1", "no prompt", "a long prompt", "marks", "other scripts"],
)
def test_a_call_is_kept_as_it_was_made(prompt: str, max_tokens: int, temperature: float) -> None:
    async def scenario() -> None:
        client = mock("Response")
        await client.generate_text(prompt, max_tokens, temperature)
        assert recorded(client) == [(prompt, max_tokens, temperature, None)]

    run(scenario())


def test_a_structured_call_reads_its_reply_as_a_driver_does_and_keeps_the_schema_it_was_asked_with() -> None:
    element: JsonObject = {"type": "object", "properties": {"exact": {"type": "string"}}}

    async def scenario() -> None:
        client = MockInferenceClient(
            ['[{"exact":"Paris"}]', "not json", '{"entities": []}'], stop_reasons=["end_turn", "max_tokens", "end_turn"], limits=LIMITS
        )
        assert await client.generate_structured("p", 100, 0, element) == StructuredResponse(
            items=[{"exact": "Paris"}], stop_reason="end_turn", usage=None
        )
        # A reply that is not a JSON array raises as a real driver's does: a test asks for the failure by queueing the shape.
        with pytest.raises(StructuredReadError) as cut_off:
            await client.generate_structured("p", 100, 0, element)
        assert str(cut_off.value) == "Structured response could not be read: response is not valid JSON (stop_reason: max_tokens)"
        with pytest.raises(StructuredReadError) as not_an_array:
            await client.generate_structured("p", 100, 0, element)
        assert str(not_an_array.value) == "Structured response could not be read: parsed to object, not an array (stop_reason: end_turn)"
        assert recorded(client) == [("p", 100, 0, element)] * 3

    run(scenario())


def test_its_limits_are_the_ones_it_was_given() -> None:
    async def scenario() -> None:
        assert await mock("x").limits() is LIMITS

    run(scenario())


def test_reset_forgets_the_calls_and_starts_the_replies_again() -> None:
    async def scenario() -> None:
        client = mock("one", "two")
        await client.generate_text("a", 1, 0)
        client.reset()
        assert client.calls == []
        assert (await client.generate_text("b", 1, 0)).text == "one"

    run(scenario())


def test_set_responses_replaces_the_replies_and_starts_from_the_first() -> None:
    async def scenario() -> None:
        client = mock("one", "two")
        await client.generate_text("a", 1, 0)
        client.set_responses(["three", "four"], stop_reasons=["max_tokens", "end_turn"])
        answers = [await client.generate_text("b", 1, 0), await client.generate_text("c", 1, 0)]
        assert [(answer.text, answer.stop_reason) for answer in answers] == [("three", "max_tokens"), ("four", "end_turn")]
        # The calls already made are kept: replacing the replies is not a reset.
        assert [call.prompt for call in client.calls] == ["a", "b", "c"]

    run(scenario())


def test_replies_without_a_stop_reason_each_or_no_replies_at_all_are_refused() -> None:
    with pytest.raises(ValueError, match="2 responses and 1 stop reasons"):
        MockInferenceClient(["one", "two"], stop_reasons=["end_turn"], limits=LIMITS)
    with pytest.raises(ValueError, match="at least one response"):
        MockInferenceClient([], stop_reasons=[], limits=LIMITS)
    client = mock("one")
    with pytest.raises(ValueError, match="1 responses and 2 stop reasons"):
        client.set_responses(["one"], stop_reasons=["end_turn", "end_turn"])
    with pytest.raises(ValueError, match="at least one response"):
        client.set_responses([], stop_reasons=[])


def test_a_call_made_by_a_task_that_is_being_cancelled_ends_cancelled_and_is_not_kept() -> None:
    # A real driver waits on its provider, so a cancellation asked of its caller lands inside the call.
    # The mock has nothing to wait on, and gives the loop one turn so that the same is true of it.
    async def scenario() -> None:
        client = mock("fine")
        element: JsonObject = {"type": "object"}

        async def cancelled_first(structured: bool) -> object:
            task = asyncio.current_task()
            assert task is not None
            task.cancel()
            if structured:
                return await client.generate_structured("p", 100, 0, element)
            return await client.generate_text("p", 100, 0)

        for structured in (False, True):
            call = asyncio.ensure_future(cancelled_first(structured))
            with pytest.raises(asyncio.CancelledError):
                await call
            assert call.cancelled()
        assert client.calls == []
        # A task nobody cancelled is answered.
        assert (await client.generate_text("p", 100, 0)).text == "fine"

    run(scenario())
