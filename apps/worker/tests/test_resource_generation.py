"""Asking a model for a document: the one call a generation makes, what is made of the answer, and what is refused before any call.

The model is a stand-in that answers from a list and keeps what it was asked.
What the prompt says is `test_generation_prompts.py`'s to hold. Here it is
that the prompt built is the prompt sent, with the job's own temperature and
length or the two a job that states none is given, under the bound every call
to a model has.
"""

import asyncio
from typing import Final, final

import pytest
from aio import pass_time, run, turns
from pydantic import JsonValue
from semiont.types import GenerationJobParams, SupportedMediaType
from semiont_inference.interface import ElementSchema, InferenceLimits, InferenceResponse, ProviderStatusError, StructuredResponse
from semiont_inference.mock import MockInferenceClient

from semiont_worker.chunking import estimate_tokens
from semiont_worker.failure_class import DeterministicJobError, classify_failure
from semiont_worker.generation.resource_generation import (
    GeneratedDocument,
    Repair,
    document_of,
    generate_resource_from_topic,
    generation_prompt,
    tokens_asked,
)
from semiont_worker.inference_call import INFERENCE_TIMEOUT_SECONDS, InferenceTimeoutError


def window(context_tokens: int, max_output_tokens: int) -> InferenceLimits:
    return InferenceLimits(
        context_tokens=context_tokens, max_output_tokens=max_output_tokens, output_tokens_per_hour=None, accepts_temperature=None
    )


SHARED: Final = window(8192, 8192)
"""One window for prompt and reply, as a local model has."""


def job(asked: dict[str, JsonValue]) -> GenerationJobParams:
    """A `yield` job about the resource `res-main`, asking what `asked` says."""
    resource: JsonValue = {"@context": "https://schema.org", "@id": "res-main", "name": "Main Notes", "representations": []}
    context: JsonValue = {"focus": {"kind": "resource", "resource": resource}, "graph": {"nodes": [], "edges": []}, "metadata": {}}
    return GenerationJobParams.model_validate(
        {"title": "Engines", "storageUri": "file://generated/engines.md", **asked, "context": context}
    )


def answering(text: str, stop_reason: str, limits: InferenceLimits) -> MockInferenceClient:
    return MockInferenceClient([text], stop_reasons=[stop_reason], limits=limits)


def asked_of(client: MockInferenceClient) -> list[tuple[str, int, float, ElementSchema | None]]:
    """Every call made of `client`: its prompt, its length, its temperature, and the schema of a call that asked for more than text."""
    return [(call.prompt, call.max_tokens, call.temperature, call.element_schema) for call in client.calls]


@pytest.mark.parametrize(
    ("asked", "length", "temperature"),
    [
        ({"maxTokens": 300, "temperature": 0.2}, 300, 0.2),
        # A job that states neither is given 500 tokens and a temperature of 0.7.
        ({}, 500, 0.7),
        # Nought is a length and a temperature a job can state, and neither is taken for none stated.
        ({"temperature": 0}, 500, 0),
        ({"maxTokens": 0}, 0, 0.7),
    ],
)
def test_a_generation_is_one_call_for_text_with_the_job_s_length_and_temperature(
    asked: dict[str, JsonValue], length: int, temperature: float
) -> None:
    params = job(asked)
    client = answering("# Engines\n\nThey were never built.", "end_turn", SHARED)

    generated = run(generate_resource_from_topic(params, "text/markdown", client, None))

    assert asked_of(client) == [(generation_prompt(params, "text/markdown", None), length, temperature, None)]
    assert type(client.calls[0].max_tokens) is int
    assert generated == GeneratedDocument(content="# Engines\n\nThey were never built.", truncated=False)


@pytest.mark.parametrize("media_type", ["text/markdown", "text/plain", "application/pdf"])
def test_the_prompt_sent_is_the_format_s_and_carries_a_repair_where_one_is_asked(media_type: SupportedMediaType) -> None:
    params = job({"prompt": "Keep it light."})
    repair = Repair(source="= T\n#let x = [", error="error: unclosed delimiter")
    client = answering("= T", "end_turn", SHARED)

    run(generate_resource_from_topic(params, media_type, client, repair))

    assert [call.prompt for call in client.calls] == [generation_prompt(params, media_type, repair)]


@pytest.mark.parametrize(
    ("stop_reason", "truncated"), [("max_tokens", True), ("end_turn", False), ("stop_sequence", False), ("unknown", False)]
)
def test_only_a_model_cut_off_at_its_length_makes_a_document_that_is_not_whole(stop_reason: str, truncated: bool) -> None:
    client = answering("They were never", stop_reason, SHARED)

    generated = run(generate_resource_from_topic(job({}), "text/markdown", client, None))

    # Cut off or not, what the model wrote is kept.
    assert generated == GeneratedDocument(content="They were never", truncated=truncated)


def test_the_document_is_the_answer_less_its_fence_and_the_white_space_at_its_ends() -> None:
    client = answering("\n```markdown\n# Engines\n\nBody.\n```\n", "end_turn", SHARED)

    assert run(generate_resource_from_topic(job({}), "text/markdown", client, None)).content == "# Engines\n\nBody."


@pytest.mark.parametrize(
    ("answer", "document"),
    [
        ("# Engines\n\nBody.", "# Engines\n\nBody."),
        ("\n\n  # Engines\n\nBody.  \n\n", "# Engines\n\nBody."),
        ("```markdown\n# Engines\n\nBody.\n```", "# Engines\n\nBody."),
        ("```md\n# Engines\n\nBody.\n```", "# Engines\n\nBody."),
        ("```typst\n= Engines\nBody.\n```", "= Engines\nBody."),
        ("```\n# Engines\n\nBody.\n```", "# Engines\n\nBody."),
        # A fence the model never closed is taken off all the same.
        ("```markdown\n# Engines\n\nBody.", "# Engines\n\nBody."),
        # A fence inside the document is the document's.
        ("# Engines\n\n```\ncode\n```\n\nBody.", "# Engines\n\n```\ncode\n```\n\nBody."),
        ("", ""),
    ],
)
def test_a_document_is_read_out_of_an_answer(answer: str, document: str) -> None:
    assert document_of(answer) == document


def test_the_white_space_taken_off_an_answer_is_unicode_s() -> None:
    # The next line (U+0085) has the White_Space property, and JavaScript's own trim leaves it.
    assert document_of("\u0085\u2003Body.\u3000\u0085") == "Body."
    # The byte order mark (U+FEFF) does not have it, and JavaScript's own trim takes it.
    assert document_of("\ufeffBody.\ufeff") == "\ufeffBody.\ufeff"
    # Neither does a unit separator (U+001F), which Python's own strip takes.
    assert document_of("\x1fBody.\x1f") == "\x1fBody.\x1f"


# A prompt and a length that are together over the one window a model has for both.


def over_the_window_by(tokens: int, max_output_tokens_under: int) -> tuple[GenerationJobParams, MockInferenceClient, int, int]:
    """A job asking for 300 tokens, and a model whose window is `tokens` short of its prompt and that length.

    The model's ceiling on a reply is `max_output_tokens_under` under its
    window: 0 is a window shared by prompt and reply. Answers the job, the
    model, the tokens of the prompt and the window.
    """
    params = job({"maxTokens": 300})
    prompt_tokens = estimate_tokens(generation_prompt(params, "text/markdown", None))
    context_tokens = prompt_tokens + 300 - tokens
    client = answering("Body.", "end_turn", window(context_tokens, context_tokens - max_output_tokens_under))
    return params, client, prompt_tokens, context_tokens


def test_a_job_one_token_over_a_shared_window_is_refused_as_deterministic_and_the_model_is_not_asked() -> None:
    params, client, prompt_tokens, context_tokens = over_the_window_by(1, 0)

    with pytest.raises(DeterministicJobError) as refused:
        run(generate_resource_from_topic(params, "text/markdown", client, None))

    assert str(refused.value) == (
        f"The prompt (~{prompt_tokens} tokens) and the 300 tokens asked for are together over "
        f"the context window of 'mock-model' ({context_tokens} tokens)"
    )
    assert classify_failure(refused.value) == "deterministic"
    assert client.calls == []


def test_a_job_that_exactly_fills_a_shared_window_is_asked_for() -> None:
    params, client, _, _ = over_the_window_by(0, 0)

    assert run(generate_resource_from_topic(params, "text/markdown", client, None)).content == "Body."
    assert len(client.calls) == 1


def test_a_job_over_the_window_of_a_model_with_a_ceiling_of_its_own_is_asked_for_and_left_to_the_provider_to_refuse() -> None:
    params, client, _, _ = over_the_window_by(200, 1)

    assert run(generate_resource_from_topic(params, "text/markdown", client, None)).content == "Body."
    assert len(client.calls) == 1


# A length is a JSON number, and the SDK's params hold one as a float.


def test_a_whole_length_is_asked_for_as_the_whole_number_it_is() -> None:
    asked = tokens_asked(job({"maxTokens": 21333}))

    assert (asked, type(asked)) == (21333, int)


def test_a_length_that_is_no_whole_number_is_refused_as_deterministic_and_the_model_is_not_asked() -> None:
    params = job({"maxTokens": 300.5})
    client = answering("Body.", "end_turn", SHARED)

    with pytest.raises(DeterministicJobError, match=r"300\.5") as refused:
        run(generate_resource_from_topic(params, "text/markdown", client, None))

    assert classify_failure(refused.value) == "deterministic"
    assert client.calls == []


@final
class Unlearned:
    """A client whose model's limits cannot be learned, and that keeps how often it was asked for anything else."""

    def __init__(self, failure: Exception) -> None:
        self.provider: Final = "ollama"
        self.model_id: Final = "unlearned-model"
        self.max_concurrency: Final = 1
        self.verify_detection_yield: Final = False
        self.generations = 0
        self._failure: Final = failure

    async def limits(self) -> InferenceLimits:
        raise self._failure

    async def generate_text(self, prompt: str, max_tokens: int, temperature: float) -> InferenceResponse:
        self.generations += 1
        raise AssertionError("a generation was asked for")

    async def generate_structured(
        self, prompt: str, max_tokens: int, temperature: float, element_schema: ElementSchema
    ) -> StructuredResponse:
        self.generations += 1
        raise AssertionError("a generation was asked for")


def test_a_model_whose_limits_cannot_be_learned_is_not_asked_and_the_failure_is_the_provider_s_own() -> None:
    failure = ProviderStatusError("the limits of 'unlearned-model': refused with status 401", 401)
    client = Unlearned(failure)

    with pytest.raises(ProviderStatusError) as raised:
        run(generate_resource_from_topic(job({}), "text/markdown", client, None))

    assert raised.value is failure
    assert client.generations == 0


@final
class Silent:
    """A client whose model never answers, and that keeps whether its call was ended."""

    def __init__(self) -> None:
        self.provider: Final = "ollama"
        self.model_id: Final = "silent-model"
        self.max_concurrency: Final = 1
        self.verify_detection_yield: Final = False
        self.ended = 0

    async def limits(self) -> InferenceLimits:
        return SHARED

    async def generate_text(self, prompt: str, max_tokens: int, temperature: float) -> InferenceResponse:
        try:
            await asyncio.Event().wait()
        except asyncio.CancelledError:
            self.ended += 1
            raise
        raise AssertionError("an event nobody sets was set")

    async def generate_structured(
        self, prompt: str, max_tokens: int, temperature: float, element_schema: ElementSchema
    ) -> StructuredResponse:
        raise AssertionError("a generation of text asks for no array")


def test_a_generation_is_under_the_bound_every_call_to_a_model_has() -> None:
    client = Silent()

    async def scenario() -> None:
        generating = asyncio.ensure_future(generate_resource_from_topic(job({}), "text/markdown", client, None))
        # The call is made, and its bound begins, before the clock is moved.
        await turns()
        await pass_time(INFERENCE_TIMEOUT_SECONDS - 1, step=60)
        assert not generating.done()
        await pass_time(1, step=1)
        with pytest.raises(InferenceTimeoutError):
            await generating

    run(scenario())
    assert client.ended == 1


def test_a_generation_is_ended_by_the_cancellation_of_the_task_that_awaits_it() -> None:
    client = Silent()

    async def scenario() -> None:
        generating = asyncio.ensure_future(generate_resource_from_topic(job({}), "text/markdown", client, None))
        await turns()
        generating.cancel()
        with pytest.raises(asyncio.CancelledError):
            await generating

    run(scenario())
    assert client.ended == 1
