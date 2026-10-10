"""Making a client from what a config names: a provider, a model, an address and a key."""

import inspect
import typing

import pytest
from aio import run
from provider import Anthropic, Ollama
from refusals.a_provider_the_vocabulary_lacks import an_unknown_provider
from semiont.types import ArchivistRosterRoleProvider

from semiont_inference.anthropic import AnthropicInferenceClient
from semiont_inference.factory import create_inference_client
from semiont_inference.ollama import OllamaInferenceClient


def test_an_anthropic_client_is_made_for_the_model_at_the_address_with_the_key() -> None:
    async def scenario() -> None:
        async with Anthropic() as played:
            client = create_inference_client(
                provider="anthropic", model="claude-haiku-4-5-20251001", base_url=played.origin, api_key="test-key"
            )
            assert isinstance(client, AnthropicInferenceClient)
            assert (client.provider, client.model_id) == ("anthropic", "claude-haiku-4-5-20251001")
            await client.limits()
            assert played.retrievals == ["/v1/models/claude-haiku-4-5-20251001"]
            assert {asked.headers["x-api-key"] for asked in played.asked} == {"test-key"}

    run(scenario())


def test_an_ollama_client_is_made_for_the_model_at_the_address_and_takes_no_key() -> None:
    async def scenario() -> None:
        async with Ollama() as ollama:
            client = create_inference_client(provider="ollama", model="llama3.2", base_url=ollama.origin, api_key=None)
            assert isinstance(client, OllamaInferenceClient)
            assert (client.provider, client.model_id) == ("ollama", "llama3.2")
            await client.limits()
            assert ollama.shows == [{"model": "llama3.2"}]
            assert "authorization" not in ollama.asked[0].headers

    run(scenario())


@pytest.mark.parametrize("api_key", [None, "", "   "], ids=["none", "empty", "white space"])
def test_anthropic_without_a_key_is_refused(api_key: str | None) -> None:
    with pytest.raises(ValueError, match="api_key is required for the Anthropic inference client"):
        create_inference_client(provider="anthropic", model="claude-haiku-4-5-20251001", base_url="http://127.0.0.1:1", api_key=api_key)


def test_a_provider_it_does_not_know_is_refused_when_run_as_it_is_by_both_checkers() -> None:
    with pytest.raises(ValueError, match="Unsupported inference provider: openai"):
        an_unknown_provider("http://127.0.0.1:1")


def test_every_provider_the_protocol_names_makes_a_client_that_says_it_is_that_provider() -> None:
    # The factory's vocabulary is the spec's, as the SDK generates it: a provider added there is one the factory must make.
    signature = inspect.signature(create_inference_client)
    assert signature.parameters["provider"].annotation is ArchivistRosterRoleProvider
    (stated, *_) = typing.get_args(ArchivistRosterRoleProvider.__value__)
    named = typing.get_args(stated)
    assert len(named) >= 2
    for provider in named:
        assert create_inference_client(provider=provider, model="m", base_url="http://127.0.0.1:1", api_key="k").provider == provider


def test_every_argument_is_stated_by_name_and_none_has_a_default() -> None:
    parameters = inspect.signature(create_inference_client).parameters
    assert list(parameters) == ["provider", "model", "base_url", "api_key"]
    for name, parameter in parameters.items():
        assert parameter.kind is inspect.Parameter.KEYWORD_ONLY, f"{name} can be given by position"
        assert parameter.default is inspect.Parameter.empty, f"{name} has a default"


def test_a_model_is_taken_as_it_is_named() -> None:
    client = create_inference_client(
        provider="anthropic", model="  claude-haiku-4-5-20251001  ", base_url="http://127.0.0.1:1", api_key="test-key"
    )
    assert client.model_id == "  claude-haiku-4-5-20251001  "


def test_each_call_makes_a_client_of_its_own() -> None:
    def made() -> object:
        return create_inference_client(
            provider="anthropic", model="claude-haiku-4-5-20251001", base_url="http://127.0.0.1:1", api_key="test-key"
        )

    assert made() is not made()
