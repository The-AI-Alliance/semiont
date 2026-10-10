"""What the interface states: the client a driver is, what it answers, and the two failures it raises."""

import dataclasses

import pytest
from spec import SPEC, objects, read, text

from semiont_inference import interface
from semiont_inference.anthropic import AnthropicInferenceClient
from semiont_inference.interface import (
    InferenceClient,
    InferenceLimits,
    InferenceResponse,
    ProviderStatusError,
    StructuredReadError,
    StructuredResponse,
    TokenUsage,
)
from semiont_inference.mock import MockInferenceClient
from semiont_inference.ollama import OllamaInferenceClient

LIMITS = InferenceLimits(context_tokens=100, max_output_tokens=50, output_tokens_per_hour=None, accepts_temperature=None)


def every_driver() -> list[InferenceClient]:
    """One of each driver, as the client the interface states: both type checkers hold each to the protocol here."""
    return [
        AnthropicInferenceClient(api_key="key", model="claude-x", base_url="http://127.0.0.1:1"),
        OllamaInferenceClient(model="llama3", base_url="http://127.0.0.1:1"),
        MockInferenceClient(["[]"], stop_reasons=["end_turn"], limits=LIMITS),
    ]


def test_a_client_has_the_members_the_design_lists_and_no_others() -> None:
    stated = {name for name in vars(InferenceClient) if not name.startswith("_")}
    assert stated == {"provider", "model_id", "max_concurrency", "verify_detection_yield", "limits", "generate_text", "generate_structured"}
    for driver in every_driver():
        assert stated <= set(dir(driver)), f"{type(driver).__name__} lacks {stated - set(dir(driver))}"


def test_each_driver_says_who_it_is_and_how_it_is_to_be_used() -> None:
    anthropic, ollama, mock = every_driver()
    # A hosted provider has room for independent calls at once; one local model has none.
    assert (anthropic.provider, anthropic.model_id, anthropic.max_concurrency) == ("anthropic", "claude-x", 4)
    assert (ollama.provider, ollama.model_id, ollama.max_concurrency) == ("ollama", "llama3", 1)
    assert (mock.provider, mock.model_id, mock.max_concurrency) == ("mock", "mock-model", 1)
    # Every real provider's detections are count-verified. The mock's are not: a count call takes a reply off its list.
    assert [driver.verify_detection_yield for driver in (anthropic, ollama, mock)] == [True, True, False]


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


def test_a_refusal_carries_the_status_as_a_number() -> None:
    error = ProviderStatusError("Ollama API error (503): loading", 503)
    assert str(error) == "Ollama API error (503): loading"
    assert error.status == 503


def test_the_failures_the_failure_class_table_names_of_a_driver_are_the_two_declared_here() -> None:
    # A worker classifies a failure by this table (P4 runs it). Of the names it uses, those that are
    # not the worker's own are a driver's: each is declared here, and is built from what a case states.
    cases = objects(read(SPEC / "worker/failure-class-cases.json")["cases"], "the cases")
    described = [case["failure"] for case in cases]
    named = {text(failure["name"], "a name") for failure in described if isinstance(failure, dict) and "name" in failure}
    of_the_worker = {"DeterministicJobError", "YieldCollapseError", "InferenceTimeoutError"}
    assert named - of_the_worker == {"ProviderStatusError", "StructuredReadError"}
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
    assert built >= 2
