"""Structured generation on Anthropic: a reply that cannot be read is a failure, and never an empty result.

"We could not read the model" must not become "the model found nothing": a
reply turned into `[]` because one backslash broke the parse would discard
what the model found, and the job would complete. So what cannot be read
raises, an empty array is an answer, and a model that does not report that it
holds a reply to a schema is refused before any generation is asked for.
"""

import re

import pytest
from aio import run
from provider import Anthropic, model_info, reply
from spec import JsonObject

from semiont_inference.anthropic import AnthropicInferenceClient
from semiont_inference.interface import StructuredReadError, StructuredResponse, StructuredUnsupportedError, TokenUsage

PERSON: JsonObject = {
    "type": "object",
    "properties": {
        "exact": {"type": "string"},
        "entityType": {"type": "string"},
        "prefix": {"type": "string"},
        "suffix": {"type": "string"},
    },
    "required": ["exact", "entityType"],
    "additionalProperties": False,
}


def driver(played: Anthropic, model: str = "claude-x") -> AnthropicInferenceClient:
    return AnthropicInferenceClient(api_key="sk-played-key", model=model, base_url=played.origin)


@pytest.mark.parametrize(
    ("said", "stop_reason", "detail"),
    [
        # A backslash from OCR that was never escaped, and the reply cut off after it.
        ('[{"exact":"\\Villiam Crookes","entityType":"Person"},{"exact":"', "end_turn", "response is not valid JSON"),
        # Cut off by the budget: the same request is cut off the same way again, which the stop reason lets a worker know.
        ('[{"exact":"William Crookes","entityTy', "max_tokens", "response is not valid JSON"),
        ('{"entities": []}', "end_turn", "parsed to object, not an array"),
        # Checked before the reply is read as JSON: an answer with nothing in it is its own failure.
        ("", "max_tokens", "response is empty"),
    ],
    ids=["an invalid escape", "cut off", "not an array", "empty"],
)
def test_a_reply_that_cannot_be_read_as_the_array_raises(said: str, stop_reason: str, detail: str) -> None:
    async def scenario() -> None:
        async with Anthropic() as played:
            played.script(reply(said, stop_reason=stop_reason))
            with pytest.raises(StructuredReadError, match="could not be read") as unread:
                await driver(played).generate_structured("p", 1000, 0.3, PERSON)
            assert str(unread.value) == f"Structured response could not be read: {detail} (stop_reason: {stop_reason})"
            assert unread.value.stop_reason == stop_reason

    run(scenario())


def test_an_empty_array_is_an_answer() -> None:
    # The other half: "the model found nothing" is a result, and does not raise.
    async def scenario() -> None:
        async with Anthropic() as played:
            played.script(reply("[]"))
            answer = await driver(played).generate_structured("p", 1000, 0.3, PERSON)
            assert answer == StructuredResponse(items=[], stop_reason="end_turn", usage=TokenUsage(input_tokens=10, output_tokens=5))

    run(scenario())


def test_a_span_with_a_quote_in_it_comes_back_as_it_was_said() -> None:
    async def scenario() -> None:
        async with Anthropic() as played:
            played.script(reply('[{"exact":"the \\"best\\" café","entityType":"Place","prefix":"a"}]'))
            answer = await driver(played).generate_structured("p", 1000, 0, PERSON)
            assert answer.items == [{"exact": 'the "best" café', "entityType": "Place", "prefix": "a"}]

    run(scenario())


@pytest.mark.parametrize("structured_outputs", [False, None], ids=["says it does not", "says nothing"])
def test_a_model_that_does_not_report_that_it_answers_in_a_schema_is_refused_before_any_generation(structured_outputs: bool | None) -> None:
    # A generation the provider does not hold to the schema is what turns found entities into an empty result.
    async def scenario() -> None:
        async with Anthropic() as played:
            played.model = model_info(structured_outputs=structured_outputs)
            played.script(reply("It was never built."))
            client = driver(played, "claude-legacy")
            # The interface's own failure, so a caller classes it without reading its words.
            with pytest.raises(
                StructuredUnsupportedError, match=re.escape("Model 'claude-legacy' does not report support for strict structured outputs")
            ) as refused:
                await client.generate_structured("p", 1000, 0.3, PERSON)
            assert "capabilities.structured_outputs" in str(refused.value)
            # It learned of the model, and asked it for nothing.
            assert (len(played.retrievals), len(played.probed), played.generations) == (1, 1, [])
            # Plain text wants no schema, and is asked for all the same.
            assert (await client.generate_text("p", 300, 0.2)).text == "It was never built."

    run(scenario())


def test_the_schema_is_the_callers_under_an_array_root_with_no_tool_and_no_assistant_turn() -> None:
    async def scenario() -> None:
        async with Anthropic() as played:
            played.script(reply("[]"))
            await driver(played).generate_structured("p", 1000, 0.3, PERSON)
            assert played.generations == [
                {
                    "model": "claude-x",
                    "max_tokens": 1000,
                    "temperature": 0.3,
                    "messages": [{"role": "user", "content": "p"}],
                    "output_config": {"format": {"type": "json_schema", "schema": {"type": "array", "items": PERSON}}},
                }
            ]

    run(scenario())
