"""A store and a provider, made from what a configuration document names.

The document's two parts are the protocol's `VectorsConfig` and
`EmbeddingConfig`. Each case here states one as a document does, reads it
through the SDK's model of it, and is handed the store or the provider of
the kind it names. What a store and a provider then do is held by their own
tests: here, only that the right one is made, of what the document states,
and that making one dials nothing.
"""

import pytest
from aio import run
from provider import KEY, Ollama, Voyage
from pydantic import JsonValue, TypeAdapter
from semiont.types import EmbeddingConfig, VectorsConfig

from semiont_vectors.factory import create_embedding_provider, create_vector_store
from semiont_vectors.memory import MemoryVectorStore
from semiont_vectors.ollama import OllamaEmbeddingProvider
from semiont_vectors.qdrant import QdrantVectorStore
from semiont_vectors.voyage import VoyageEmbeddingProvider

_VECTORS = TypeAdapter[VectorsConfig](VectorsConfig)
_EMBEDDING = TypeAdapter[EmbeddingConfig](EmbeddingConfig)


def vectors(stated: JsonValue) -> VectorsConfig:
    return _VECTORS.validate_python(stated)


def embedding(stated: JsonValue) -> EmbeddingConfig:
    return _EMBEDDING.validate_python(stated)


async def never_asked() -> int:
    raise AssertionError("making a store asks nobody how wide a vector is")


def test_a_qdrant_is_made_of_the_host_and_the_port_the_document_states_and_nothing_is_dialled() -> None:
    # No server listens at this address: a store that dialled when it was made would fail here.
    store = create_vector_store(vectors({"type": "qdrant", "host": "127.0.0.1", "port": 1}), dimensions=never_asked)
    assert isinstance(store, QdrantVectorStore)


def test_an_index_in_memory_is_made_for_the_kind_memory() -> None:
    store = create_vector_store(vectors({"type": "memory"}), dimensions=never_asked)
    assert isinstance(store, MemoryVectorStore)


def test_an_ollama_is_asked_for_the_model_at_the_address_the_document_states() -> None:
    async def scenario() -> None:
        async with Ollama() as ollama:
            stated = embedding({"type": "ollama", "model": "a-model", "baseUrl": ollama.origin})
            provider = create_embedding_provider(stated, api_key=None)
            assert isinstance(provider, OllamaEmbeddingProvider)
            await provider.embed("a")
            (asked,) = ollama.asked
            assert asked.json() == {"model": "a-model", "input": ["a"]}

    run(scenario())


def test_voyage_is_asked_for_the_model_at_the_address_the_document_states_with_the_key_it_was_handed() -> None:
    async def scenario() -> None:
        async with Voyage() as voyage:
            stated = embedding({"type": "voyage", "model": "a-model", "endpoint": voyage.endpoint, "apiKeyEnv": "VOYAGE_API_KEY"})
            provider = create_embedding_provider(stated, api_key=KEY)
            assert isinstance(provider, VoyageEmbeddingProvider)
            await provider.embed("a")
            (asked,) = voyage.asked
            assert asked.json() == {"model": "a-model", "input": ["a"]}
            assert asked.headers["authorization"] == f"Bearer {KEY}"

    run(scenario())


@pytest.mark.parametrize("key", [None, ""])
def test_voyage_is_refused_without_a_key(key: str | None) -> None:
    stated = embedding({"type": "voyage", "model": "a-model", "endpoint": "http://127.0.0.1:1", "apiKeyEnv": "VOYAGE_API_KEY"})
    with pytest.raises(ValueError, match="an API key is required for the voyage provider"):
        create_embedding_provider(stated, api_key=key)
