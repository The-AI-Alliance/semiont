"""A provider the protocol does not name is not one a client can be made for."""

from semiont_inference.factory import create_inference_client
from semiont_inference.interface import InferenceClient


def an_unknown_provider(base_url: str) -> InferenceClient:
    return create_inference_client(provider="openai", model="gpt-4", base_url=base_url, api_key="test")  # type: ignore[arg-type]  # pyright: ignore[reportArgumentType]
