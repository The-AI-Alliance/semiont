"""A store, a reader and a provider, made from what a configuration document names.

The document's two parts are the protocol's `VectorsConfig` and
`EmbeddingConfig`. Each case here states one as a document does, reads it
through the SDK's model of it, and is handed the store, the reader or the
provider of the kind it names. What each then does is held by its own
tests: here, only that the right one is made, of what the document states
and of the secret it was handed, and that making one dials nothing. A
secret is never in the document, which names the variable that holds it,
and one the kind takes is refused where none is handed.
"""

import pytest
from aio import run
from provider import KEY, Ollama, Voyage
from pydantic import JsonValue, TypeAdapter
from qdrant_stand_in import TOKEN, PlayedQdrant
from semiont.identity import kb_did
from semiont.types import EmbeddingConfig, VectorsConfig

from semiont_vectors.factory import create_embedding_provider, create_vector_reader, create_vector_store
from semiont_vectors.memory import MemoryVectorStore
from semiont_vectors.ollama import OllamaEmbeddingProvider
from semiont_vectors.qdrant import QdrantVectorReader, QdrantVectorStore
from semiont_vectors.store import SearchOptions
from semiont_vectors.voyage import VoyageEmbeddingProvider

_VECTORS = TypeAdapter[VectorsConfig](VectorsConfig)
_EMBEDDING = TypeAdapter[EmbeddingConfig](EmbeddingConfig)

KB = kb_did("example.github.io:plain-kb")
"""The knowledge base whose index each store and reader here is."""

QDRANT: JsonValue = {"type": "qdrant", "host": "127.0.0.1", "port": 1, "tokenEnv": "QDRANT_TOKEN"}
"""A Qdrant as a document states one, at an address nothing listens at. The token is what the variable it names holds."""


def vectors(stated: JsonValue) -> VectorsConfig:
    return _VECTORS.validate_python(stated)


def embedding(stated: JsonValue) -> EmbeddingConfig:
    return _EMBEDDING.validate_python(stated)


async def never_asked() -> int:
    raise AssertionError("making a store asks nobody how wide a vector is")


def test_a_qdrant_is_made_of_the_host_and_the_port_the_document_states_and_nothing_is_dialled() -> None:
    # No server listens at this address: a store that dialled when it was made would fail here.
    store = create_vector_store(vectors(QDRANT), kb=KB, token=TOKEN, dimensions=never_asked)
    assert isinstance(store, QdrantVectorStore)


def test_a_qdrant_store_asks_the_address_the_document_states_with_the_token_it_was_handed() -> None:
    async def scenario() -> None:
        async with PlayedQdrant() as qdrant:
            stated = vectors({"type": "qdrant", "host": "127.0.0.1", "port": qdrant.port, "tokenEnv": "QDRANT_TOKEN"})
            store = create_vector_store(stated, kb=KB, token=TOKEN, dimensions=never_asked)
            await store.connect()
            await store.disconnect()
            assert qdrant.asked
            assert {asked.headers.get("api-key") for asked in qdrant.asked} == {TOKEN}

    run(scenario())


@pytest.mark.parametrize("token", [None, ""])
def test_a_qdrant_store_is_refused_without_a_token(token: str | None) -> None:
    with pytest.raises(ValueError, match="a token is required for the qdrant store"):
        create_vector_store(vectors(QDRANT), kb=KB, token=token, dimensions=never_asked)


def test_an_index_in_memory_is_made_for_the_kind_memory_and_takes_no_token() -> None:
    store = create_vector_store(vectors({"type": "memory"}), kb=KB, token=None, dimensions=never_asked)
    assert isinstance(store, MemoryVectorStore)


def test_an_ollama_is_asked_for_the_model_at_the_address_the_document_states() -> None:
    async def scenario() -> None:
        async with Ollama() as ollama:
            stated = embedding({"type": "ollama", "model": "a-model", "baseUrl": ollama.origin})
            provider = create_embedding_provider(stated, api_key=None)
            assert isinstance(provider, OllamaEmbeddingProvider)
            await provider.embed_query("a")
            (asked,) = ollama.asked
            assert asked.json() == {"model": "a-model", "input": ["a"]}

    run(scenario())


def test_voyage_is_asked_for_the_model_at_the_address_the_document_states_with_the_key_it_was_handed() -> None:
    async def scenario() -> None:
        async with Voyage() as voyage:
            stated = embedding({"type": "voyage", "model": "a-model", "endpoint": voyage.endpoint, "apiKeyEnv": "VOYAGE_API_KEY"})
            provider = create_embedding_provider(stated, api_key=KEY)
            assert isinstance(provider, VoyageEmbeddingProvider)
            await provider.embed_query("a")
            (asked,) = voyage.asked
            assert asked.json() == {"model": "a-model", "input": ["a"], "input_type": "query"}
            assert asked.headers["authorization"] == f"Bearer {KEY}"

    run(scenario())


@pytest.mark.parametrize("key", [None, ""])
def test_voyage_is_refused_without_a_key(key: str | None) -> None:
    stated = embedding({"type": "voyage", "model": "a-model", "endpoint": "http://127.0.0.1:1", "apiKeyEnv": "VOYAGE_API_KEY"})
    with pytest.raises(ValueError, match="an API key is required for the voyage provider"):
        create_embedding_provider(stated, api_key=key)


def test_a_qdrant_reader_is_made_of_the_host_and_the_port_the_document_states_and_nothing_is_dialled() -> None:
    # No server listens at this address: a reader that dialled when it was made would fail here.
    made = create_vector_reader(vectors(QDRANT), kb=KB, token=TOKEN)
    assert isinstance(made, QdrantVectorReader)


def test_a_qdrant_reader_asks_the_address_the_document_states_with_the_token_it_was_handed() -> None:
    async def scenario() -> None:
        async with PlayedQdrant() as qdrant:
            stated = vectors({"type": "qdrant", "host": "127.0.0.1", "port": qdrant.port, "tokenEnv": "QDRANT_TOKEN"})
            made = create_vector_reader(stated, kb=KB, token=TOKEN)
            await made.connect()
            await made.disconnect()
            assert [(asked.method, asked.path, asked.headers.get("api-key")) for asked in qdrant.asked] == [("GET", "/collections", TOKEN)]

    run(scenario())


@pytest.mark.parametrize("token", [None, ""])
def test_a_qdrant_reader_is_refused_without_a_token(token: str | None) -> None:
    with pytest.raises(ValueError, match="a token is required for the qdrant reader"):
        create_vector_reader(vectors(QDRANT), kb=KB, token=token)


def test_a_reader_of_the_kind_memory_is_an_index_in_memory_that_holds_nothing_and_takes_no_token() -> None:
    async def scenario() -> None:
        made = create_vector_reader(vectors({"type": "memory"}), kb=KB, token=None)
        assert isinstance(made, MemoryVectorStore)
        await made.connect()
        assert await made.search_resources([1.0, 0.0], SearchOptions(limit=5)) == []
        await made.disconnect()

    run(scenario())
