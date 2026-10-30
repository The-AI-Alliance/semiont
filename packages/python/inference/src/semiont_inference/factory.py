"""Making a client from what a config names: a provider, a model, the address of its API, a key, and a model catalogue."""

from functools import cache
from pathlib import Path
from typing import Never, NoReturn, final

from semiont.types import EngineProvider

from semiont_inference.catalogue import Catalogue, CatalogueFacts, CatalogueProvider, catalogue_facts, read_catalogue
from semiont_inference.interface import InferenceClient

__all__ = ["CatalogueRequired", "KeyRequired", "create_inference_client"]


@final
class KeyRequired(ValueError):
    """A provider that takes a key was named with none. Its words name the provider."""


@final
class CatalogueRequired(ValueError):
    """A provider whose API does not state a model's facts was named with no catalogue file to read them from.

    None was named, or the one named cannot be read, or it lacks the model.
    Its words say which of the three, and name the provider and the model,
    or the file.
    """


def _unsupported(provider: Never) -> NoReturn:
    # A provider the protocol names and this does not make is refused by a type checker, here: the
    # argument is then no longer one that cannot be. A caller no checker read is refused when it runs.
    raise ValueError(f"Unsupported inference provider: {provider}")


def _key(called: str, api_key: str | None) -> str:
    """The key of a provider that takes one. `called` is what the provider is called in the refusal."""
    if api_key is None or api_key.strip() == "":
        raise KeyRequired(f"api_key is required for the {called} inference client")
    return api_key


@cache
def _read(path: Path) -> Catalogue:
    """The catalogue in a file, read once however many clients are made with it."""
    return read_catalogue(path)


def _facts(path: Path | None, provider: CatalogueProvider, model: str) -> CatalogueFacts:
    """What the catalogue file at `path` says of a model, for a provider whose own API does not say."""
    if path is None:
        raise CatalogueRequired(
            f"a model catalogue is required for the provider {provider}, whose API does not state what {model} can take"
        )
    try:
        catalogue = _read(path)
    except (OSError, ValueError) as unread:
        raise CatalogueRequired(f"the model catalogue cannot be read: {unread}") from unread
    facts = catalogue_facts(catalogue, provider, model)
    if facts is None:
        raise CatalogueRequired(
            f"the model catalogue (models.dev, {catalogue.generated_at}) states nothing of the model {model} of the provider {provider}"
        )
    return facts


def create_inference_client(
    *, provider: EngineProvider, model: str, base_url: str, api_key: str | None, catalogue: Path | None
) -> InferenceClient:
    """A client of `provider`'s `model`, reached at `base_url`.

    Every argument is stated. `provider` is one the protocol names: the
    vocabulary is the spec's, as the SDK generates it.

    `api_key` is `None` for a provider that takes no key. Anthropic, Google,
    OpenAI and Together each take one, and are refused without it
    (`KeyRequired`). A llama.cpp server and a vLLM server take one where
    whoever runs the server set one, and Ollama takes none.

    `catalogue` is the path of a model catalogue file
    (`semiont_inference.catalogue`), or `None` where the caller has none.
    Google's, OpenAI's and Together's APIs do not state what a model can
    take, so a client of one of them is made with what the file says of the
    model, and is refused with no file, with one that cannot be read, and
    with one that lacks the model (`CatalogueRequired`). The file is read
    for those three alone, and once.

    A driver's module is imported when its provider is asked for, and not
    before: a provider's own library is needed only by whoever asks for that
    provider. Asked for one whose library is not installed, this raises a
    `ModuleNotFoundError` that names the extra to install.
    """
    match provider:
        case "anthropic":
            key = _key("Anthropic", api_key)
            from semiont_inference.anthropic import AnthropicInferenceClient

            return AnthropicInferenceClient(api_key=key, model=model, base_url=base_url)
        case "google":
            key, facts = _key("Google", api_key), _facts(catalogue, "google", model)
            from semiont_inference.google import GoogleInferenceClient

            return GoogleInferenceClient(api_key=key, model=model, base_url=base_url, facts=facts)
        case "llamacpp":
            from semiont_inference.llamacpp import LlamaCppInferenceClient

            return LlamaCppInferenceClient(model=model, base_url=base_url, api_key=api_key)
        case "ollama":
            from semiont_inference.ollama import OllamaInferenceClient

            return OllamaInferenceClient(model=model, base_url=base_url)
        case "openai":
            key, facts = _key("OpenAI", api_key), _facts(catalogue, "openai", model)
            from semiont_inference.openai import OpenAIInferenceClient

            return OpenAIInferenceClient(api_key=key, model=model, base_url=base_url, facts=facts)
        case "together":
            key, facts = _key("Together", api_key), _facts(catalogue, "together", model)
            from semiont_inference.together import TogetherInferenceClient

            return TogetherInferenceClient(api_key=key, model=model, base_url=base_url, facts=facts)
        case "vllm":
            from semiont_inference.vllm import VllmInferenceClient

            return VllmInferenceClient(model=model, base_url=base_url, api_key=api_key)
        case _:
            _unsupported(provider)
