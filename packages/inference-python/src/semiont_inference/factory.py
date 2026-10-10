"""Making a client from what a knowledge base's config names: a provider, a model, the address of the provider's API, and a key."""

from typing import Never, NoReturn

from semiont.types import ArchivistRosterRoleProvider

from semiont_inference.interface import InferenceClient

__all__ = ["create_inference_client"]


def _unsupported(provider: Never) -> NoReturn:
    # A provider the protocol names and this does not make is refused by a type checker, here: the
    # argument is then no longer one that cannot be. A caller no checker read is refused when it runs.
    raise ValueError(f"Unsupported inference provider: {provider}")


def create_inference_client(*, provider: ArchivistRosterRoleProvider, model: str, base_url: str, api_key: str | None) -> InferenceClient:
    """A client of `provider`'s `model`, reached at `base_url`.

    Every argument is stated. `provider` is one the protocol names: the
    vocabulary is the spec's, as the SDK generates it. `api_key` is `None`
    for a provider that takes no key. Anthropic takes one, and is refused
    without it.

    A driver's module is imported when its provider is asked for, and not
    before: a provider's own library is needed only by whoever asks for that
    provider. Asked for one whose library is not installed, this raises a
    `ModuleNotFoundError` that names the extra to install.
    """
    match provider:
        case "anthropic":
            if api_key is None or api_key.strip() == "":
                raise ValueError("api_key is required for the Anthropic inference client")
            from semiont_inference.anthropic import AnthropicInferenceClient

            return AnthropicInferenceClient(api_key=api_key, model=model, base_url=base_url)
        case "ollama":
            from semiont_inference.ollama import OllamaInferenceClient

            return OllamaInferenceClient(model=model, base_url=base_url)
        case _:
            _unsupported(provider)
