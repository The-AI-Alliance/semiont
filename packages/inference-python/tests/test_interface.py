"""What the interface states: the client a driver is, what it answers, and the failures it raises."""

import dataclasses

import pytest
from spec import SPEC, objects, read, text

from semiont_inference import interface
from semiont_inference.anthropic import AnthropicInferenceClient
from semiont_inference.catalogue import CatalogueFacts, CatalogueLimit
from semiont_inference.google import GoogleInferenceClient
from semiont_inference.interface import (
    InferenceClient,
    InferenceLimits,
    InferenceResponse,
    ProviderStatusError,
    ProviderWithheldError,
    StructuredReadError,
    StructuredResponse,
    StructuredUnsupportedError,
    TokenUsage,
)
from semiont_inference.llamacpp import LlamaCppInferenceClient
from semiont_inference.mock import MockInferenceClient
from semiont_inference.ollama import OllamaInferenceClient
from semiont_inference.openai import OpenAIInferenceClient
from semiont_inference.together import TogetherInferenceClient
from semiont_inference.vllm import VllmInferenceClient

LIMITS = InferenceLimits(context_tokens=100, max_output_tokens=50, output_tokens_per_hour=None, accepts_temperature=None)

# A model's facts, as whoever makes a driver whose provider is silent hands them to it.
FACTS = CatalogueFacts(
    limit=CatalogueLimit(context=100, input=None, output=50),
    reasoning=False,
    reasoning_options=None,
    status=None,
    structured_output=None,
    temperature=None,
)


def every_driver() -> list[InferenceClient]:
    """One of each driver, as the client the interface states: both type checkers hold each to the protocol here."""
    return [
        AnthropicInferenceClient(api_key="key", model="claude-x", base_url="http://127.0.0.1:1"),
        GoogleInferenceClient(api_key="key", model="gemini-x", base_url="http://127.0.0.1:1", facts=FACTS),
        LlamaCppInferenceClient(model="local-x", base_url="http://127.0.0.1:1/v1", api_key=None),
        OllamaInferenceClient(model="llama3", base_url="http://127.0.0.1:1"),
        OpenAIInferenceClient(api_key="key", model="gpt-x", base_url="http://127.0.0.1:1/v1", facts=FACTS),
        TogetherInferenceClient(api_key="key", model="acme/Model-X", base_url="http://127.0.0.1:1/v1", facts=FACTS),
        VllmInferenceClient(model="served-x", base_url="http://127.0.0.1:1/v1", api_key=None),
        MockInferenceClient(["[]"], stop_reasons=["end_turn"], limits=LIMITS),
    ]


def test_a_client_has_the_members_the_design_lists_and_no_others() -> None:
    stated = {name for name in vars(InferenceClient) if not name.startswith("_")}
    assert stated == {"provider", "model_id", "max_concurrency", "verify_detection_yield", "limits", "generate_text", "generate_structured"}
    for driver in every_driver():
        assert stated <= set(dir(driver)), f"{type(driver).__name__} lacks {stated - set(dir(driver))}"


def test_each_driver_says_who_it_is_and_how_it_is_to_be_used() -> None:
    # A hosted provider has room for independent calls at once, and so has a vLLM, which decodes them together.
    # One local model has none, and the slots of a llama.cpp server share the one window it states.
    assert [(driver.provider, driver.model_id, driver.max_concurrency) for driver in every_driver()] == [
        ("anthropic", "claude-x", 4),
        ("google", "gemini-x", 4),
        ("llamacpp", "local-x", 1),
        ("ollama", "llama3", 1),
        ("openai", "gpt-x", 4),
        ("together", "acme/Model-X", 4),
        ("vllm", "served-x", 4),
        ("mock", "mock-model", 1),
    ]
    # Every real provider's detections are count-verified. The mock's are not: a count call takes a reply off its list.
    assert [driver.verify_detection_yield for driver in every_driver()] == [True, True, True, True, True, True, True, False]


def test_what_a_driver_answers_is_named_in_snake_case_and_cannot_be_changed() -> None:
    assert {
        kind.__name__: [made.name for made in dataclasses.fields(kind)] for kind in (TokenUsage, InferenceResponse, StructuredResponse)
    } == {
        "TokenUsage": ["input_tokens", "output_tokens"],
        "InferenceResponse": ["text", "stop_reason", "usage"],
        "StructuredResponse": ["items", "stop_reason", "usage"],
    }
    assert [made.name for made in dataclasses.fields(InferenceLimits)] == [
        "context_tokens",
        "max_output_tokens",
        "output_tokens_per_hour",
        "accepts_temperature",
    ]
    answers = (
        TokenUsage(input_tokens=1, output_tokens=2),
        InferenceResponse(text="t", stop_reason="end_turn", usage=None),
        StructuredResponse(items=[], stop_reason="end_turn", usage=None),
        LIMITS,
    )
    for answer in answers:
        first = dataclasses.fields(answer)[0].name
        with pytest.raises(dataclasses.FrozenInstanceError):
            setattr(answer, first, None)
        assert not hasattr(answer, "__dict__"), f"{type(answer).__name__} has no slots"


def test_no_field_of_an_answer_has_a_default() -> None:
    for kind in (TokenUsage, InferenceResponse, StructuredResponse, InferenceLimits):
        for made in dataclasses.fields(kind):
            assert made.default is dataclasses.MISSING, f"{kind.__name__}.{made.name} has a default"
            assert made.default_factory is dataclasses.MISSING, f"{kind.__name__}.{made.name} has a default"


def test_a_reply_that_cannot_be_read_says_why_and_carries_the_stop_reason() -> None:
    error = StructuredReadError("response is not valid JSON", "max_tokens")
    assert str(error) == "Structured response could not be read: response is not valid JSON (stop_reason: max_tokens)"
    assert error.stop_reason == "max_tokens"


def test_a_structured_generation_a_model_is_not_known_to_hold_to_a_schema_is_refused_in_its_drivers_words_and_carries_nothing_else() -> (
    None
):
    error = StructuredUnsupportedError("Model 'claude-legacy' does not report support for strict structured outputs")
    assert str(error) == "Model 'claude-legacy' does not report support for strict structured outputs"
    # Whoever catches it holds the client, which says its model: the failure states no member of its own.
    assert vars(error) == {}


def test_a_refusal_carries_the_status_as_a_number() -> None:
    error = ProviderStatusError("Ollama API error (503): loading", 503)
    assert str(error) == "Ollama API error (503): loading"
    assert error.status == 503


def test_an_answer_withheld_carries_the_providers_word_for_what_it_did() -> None:
    error = ProviderWithheldError("refusal (cyber): This request could enable cyber harm.", "refusal")
    assert str(error) == "The provider withheld its answer: refusal (cyber): This request could enable cyber harm."
    assert error.reason == "refusal"


def test_the_failures_the_failure_class_table_names_of_a_driver_are_the_ones_declared_here() -> None:
    # A worker classifies a failure by this table (P4 runs it). Of the names it uses, those that are
    # not the worker's own are a driver's: each is declared here, and is built from what a case states.
    cases = objects(read(SPEC / "worker/failure-class-cases.json")["cases"], "the cases")
    described = [case["failure"] for case in cases]
    named = {text(failure["name"], "a name") for failure in described if isinstance(failure, dict) and "name" in failure}
    of_the_worker = {"DeterministicJobError", "YieldCollapseError", "InferenceTimeoutError"}
    assert named - of_the_worker == {"ProviderStatusError", "ProviderWithheldError", "StructuredReadError", "StructuredUnsupportedError"}
    assert {name for name in interface.__all__ if name.endswith("Error")} == named - of_the_worker

    built = 0
    for failure in described:
        if not isinstance(failure, dict):
            continue
        if failure.get("name") == "ProviderStatusError":
            status = failure["status"]
            assert isinstance(status, int)
            assert ProviderStatusError("refused", status).status == status
            built += 1
        if failure.get("name") == "StructuredReadError":
            stop_reason = failure["stopReason"]
            assert isinstance(stop_reason, str)
            assert StructuredReadError("response is not valid JSON", stop_reason).stop_reason == stop_reason
            built += 1
        if failure.get("name") == "ProviderWithheldError":
            assert ProviderWithheldError("refusal", "refusal").reason == "refusal"
            built += 1
        if failure.get("name") == "StructuredUnsupportedError":
            assert str(StructuredUnsupportedError("Model 'm' is not known to hold a reply to a JSON Schema")).startswith("Model 'm'")
            built += 1
    assert built >= 4
