"""Making a client from what a config names: a provider, a model, an address and a key."""

import inspect
import typing
from pathlib import Path
from typing import Final

import pytest
from aio import run
from provider import Anthropic, Ollama
from refusals.a_provider_the_vocabulary_lacks import an_unknown_provider
from semiont.types import ArchivistRosterRoleProvider

from semiont_inference.anthropic import AnthropicInferenceClient
from semiont_inference.catalogue import read_catalogue
from semiont_inference.factory import CatalogueRequired, KeyRequired, create_inference_client
from semiont_inference.google import GoogleInferenceClient
from semiont_inference.llamacpp import LlamaCppInferenceClient
from semiont_inference.ollama import OllamaInferenceClient
from semiont_inference.openai import OpenAIInferenceClient
from semiont_inference.together import TogetherInferenceClient
from semiont_inference.vllm import VllmInferenceClient

CATALOGUE: Final = Path(__file__).parent / "catalogue" / "model-catalogue.json"
"""The catalogue file the repository keeps for these tests: real entries, at the version it pins."""

_HELD: Final = read_catalogue(CATALOGUE)

LISTED: Final = {
    "google": next(iter(_HELD.providers.google.models)),
    "openai": next(iter(_HELD.providers.openai.models)),
    "together": next(iter(_HELD.providers.togetherai.models)),
}
"""A model the catalogue has, for each provider whose facts are read from it."""

KEYED: Final = {"anthropic": "Anthropic", "google": "Google", "openai": "OpenAI", "together": "Together"}
"""Each provider that takes a key, with what a refusal calls it."""


def test_an_anthropic_client_is_made_for_the_model_at_the_address_with_the_key() -> None:
    async def scenario() -> None:
        async with Anthropic() as played:
            client = create_inference_client(
                provider="anthropic", model="claude-haiku-4-5-20251001", base_url=played.origin, api_key="test-key", catalogue=None
            )
            assert isinstance(client, AnthropicInferenceClient)
            assert (client.provider, client.model_id) == ("anthropic", "claude-haiku-4-5-20251001")
            await client.limits()
            assert played.retrievals == ["/v1/models/claude-haiku-4-5-20251001"]
            assert {asked.headers["authorization"] for asked in played.asked} == {"Bearer test-key"}

    run(scenario())


def test_an_ollama_client_is_made_for_the_model_at_the_address_and_takes_no_key() -> None:
    async def scenario() -> None:
        async with Ollama() as ollama:
            client = create_inference_client(provider="ollama", model="llama3.2", base_url=ollama.origin, api_key=None, catalogue=None)
            assert isinstance(client, OllamaInferenceClient)
            assert (client.provider, client.model_id) == ("ollama", "llama3.2")
            await client.limits()
            assert ollama.shows == [{"model": "llama3.2"}]
            assert "authorization" not in ollama.asked[0].headers

    run(scenario())


@pytest.mark.parametrize("api_key", [None, "", "   "], ids=["none", "empty", "white space"])
@pytest.mark.parametrize("provider", sorted(KEYED))
def test_a_provider_that_takes_a_key_is_refused_without_one_by_its_name(provider: ArchivistRosterRoleProvider, api_key: str | None) -> None:
    model = LISTED.get(provider, "claude-haiku-4-5-20251001")
    with pytest.raises(KeyRequired, match=f"^api_key is required for the {KEYED[provider]} inference client$"):
        create_inference_client(provider=provider, model=model, base_url="http://127.0.0.1:1", api_key=api_key, catalogue=CATALOGUE)


@pytest.mark.parametrize(
    ("provider", "made"),
    [("google", GoogleInferenceClient), ("openai", OpenAIInferenceClient), ("together", TogetherInferenceClient)],
)
def test_a_provider_whose_api_is_silent_is_made_with_what_the_catalogue_says_of_its_model(
    provider: ArchivistRosterRoleProvider, made: type
) -> None:
    model = LISTED[provider]
    client = create_inference_client(provider=provider, model=model, base_url="http://127.0.0.1:1", api_key="k", catalogue=CATALOGUE)
    assert isinstance(client, made)
    assert (client.provider, client.model_id) == (provider, model)


@pytest.mark.parametrize("provider", sorted(LISTED))
def test_a_provider_whose_api_is_silent_is_refused_with_no_catalogue_with_one_that_lacks_its_model_and_with_one_that_is_not_there(
    provider: ArchivistRosterRoleProvider, tmp_path: Path
) -> None:
    with pytest.raises(CatalogueRequired, match=f"^a model catalogue is required for the provider {provider}, "):
        create_inference_client(provider=provider, model=LISTED[provider], base_url="http://127.0.0.1:1", api_key="k", catalogue=None)
    with pytest.raises(CatalogueRequired, match=f"states nothing of the model no-such-model of the provider {provider}$"):
        create_inference_client(provider=provider, model="no-such-model", base_url="http://127.0.0.1:1", api_key="k", catalogue=CATALOGUE)
    missing = tmp_path / "no-catalogue.json"
    with pytest.raises(CatalogueRequired, match=r"^the model catalogue cannot be read: .*no-catalogue\.json"):
        create_inference_client(provider=provider, model=LISTED[provider], base_url="http://127.0.0.1:1", api_key="k", catalogue=missing)


@pytest.mark.parametrize("provider", ["anthropic", "llamacpp", "ollama", "vllm"])
def test_a_provider_that_states_its_own_facts_never_has_the_catalogue_read(provider: ArchivistRosterRoleProvider, tmp_path: Path) -> None:
    # A file that is not there would fail a read: none is made for these four.
    missing = tmp_path / "no-catalogue.json"
    made = create_inference_client(provider=provider, model="m", base_url="http://127.0.0.1:1", api_key="k", catalogue=missing)
    assert made.provider == provider


@pytest.mark.parametrize(("provider", "made"), [("llamacpp", LlamaCppInferenceClient), ("vllm", VllmInferenceClient)])
@pytest.mark.parametrize("api_key", [None, "a-key"], ids=["no key", "a key"])
def test_a_server_a_deployment_runs_is_made_with_a_key_or_without_and_with_no_catalogue(
    provider: ArchivistRosterRoleProvider, made: type, api_key: str | None
) -> None:
    client = create_inference_client(provider=provider, model="m", base_url="http://127.0.0.1:1/v1", api_key=api_key, catalogue=None)
    assert isinstance(client, made)
    assert (client.provider, client.model_id) == (provider, "m")


def test_a_provider_it_does_not_know_is_refused_when_run_as_it_is_by_both_checkers() -> None:
    with pytest.raises(ValueError, match="Unsupported inference provider: mistral"):
        an_unknown_provider("http://127.0.0.1:1")


def test_every_provider_the_protocol_names_makes_a_client_that_says_it_is_that_provider() -> None:
    # The factory's vocabulary is the spec's, as the SDK generates it: a provider added there is one the factory must make.
    signature = inspect.signature(create_inference_client)
    assert signature.parameters["provider"].annotation is ArchivistRosterRoleProvider
    (stated, *_) = typing.get_args(ArchivistRosterRoleProvider.__value__)
    named = typing.get_args(stated)
    assert sorted(named) == ["anthropic", "google", "llamacpp", "ollama", "openai", "together", "vllm"]
    for provider in named:
        model = LISTED.get(provider, "m")
        made = create_inference_client(provider=provider, model=model, base_url="http://127.0.0.1:1", api_key="k", catalogue=CATALOGUE)
        assert made.provider == provider


def test_every_argument_is_stated_by_name_and_none_has_a_default() -> None:
    parameters = inspect.signature(create_inference_client).parameters
    assert list(parameters) == ["provider", "model", "base_url", "api_key", "catalogue"]
    for name, parameter in parameters.items():
        assert parameter.kind is inspect.Parameter.KEYWORD_ONLY, f"{name} can be given by position"
        assert parameter.default is inspect.Parameter.empty, f"{name} has a default"


def test_a_model_is_taken_as_it_is_named() -> None:
    client = create_inference_client(
        provider="anthropic", model="  claude-haiku-4-5-20251001  ", base_url="http://127.0.0.1:1", api_key="test-key", catalogue=None
    )
    assert client.model_id == "  claude-haiku-4-5-20251001  "


def test_each_call_makes_a_client_of_its_own() -> None:
    def made() -> object:
        return create_inference_client(
            provider="anthropic", model="claude-haiku-4-5-20251001", base_url="http://127.0.0.1:1", api_key="test-key", catalogue=None
        )

    assert made() is not made()
