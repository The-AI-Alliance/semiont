"""Making a store, a reader and a provider from what a service's configuration names: the kind of each, and what it needs to be reached."""

from collections.abc import Awaitable, Callable
from typing import assert_never

from semiont.types import (
    EmbeddingConfig,
    MemoryVectorsConfig,
    OllamaEmbeddingConfig,
    QdrantVectorsConfig,
    VectorsConfig,
    VoyageEmbeddingConfig,
)

from semiont_vectors.embedding import EmbeddingProvider
from semiont_vectors.memory import MemoryVectorStore
from semiont_vectors.ollama import OllamaEmbeddingProvider
from semiont_vectors.qdrant import QdrantVectorReader, QdrantVectorStore
from semiont_vectors.store import VectorReader, VectorStore
from semiont_vectors.voyage import VoyageEmbeddingProvider

__all__ = ["create_embedding_provider", "create_vector_reader", "create_vector_store"]


def create_vector_store(config: VectorsConfig, *, dimensions: Callable[[], Awaitable[int]]) -> VectorStore:
    """The store of the vector index `config` names. Nothing is dialled: a store reaches its index when it is connected.

    `config` is the protocol's `VectorsConfig`, as a service's configuration
    document states it. `dimensions` answers how wide the embedding model's
    vectors are, and is a provider's own `dimensions`: a store that has to
    make its index asks it then, and one that finds its index made asks
    nobody. A store in memory holds vectors as wide as it is handed, and
    never asks.
    """
    match config:
        case QdrantVectorsConfig():
            return QdrantVectorStore(host=config.host, port=config.port, dimensions=dimensions)
        case MemoryVectorsConfig():
            return MemoryVectorStore()
        case _:
            assert_never(config)


def create_vector_reader(config: VectorsConfig) -> VectorReader:
    """The reader of the vector index `config` names. Nothing is dialled: a reader reaches its index when it is connected.

    `config` is the protocol's `VectorsConfig`, as a service's configuration
    document states it. A reader makes nothing in its index, so it is told
    no width. A reader in memory is an index of its own, held in the
    process, that nothing has written to: it answers every search with
    nothing.
    """
    match config:
        case QdrantVectorsConfig():
            return QdrantVectorReader(host=config.host, port=config.port)
        case MemoryVectorsConfig():
            return MemoryVectorStore()
        case _:
            assert_never(config)


def create_embedding_provider(config: EmbeddingConfig, *, api_key: str | None) -> EmbeddingProvider:
    """The provider `config` names, for the model it names. Nothing is asked of it: a provider is asked when a text is embedded.

    `config` is the protocol's `EmbeddingConfig`, as a service's
    configuration document states it. A key is never in it: the document
    names the environment variable that holds one, and whoever reads the
    environment hands the key here. It is `None` for a provider that takes
    none. Voyage takes one, and is refused without it.
    """
    match config:
        case OllamaEmbeddingConfig():
            return OllamaEmbeddingProvider(model=config.model, base_url=config.base_url)
        case VoyageEmbeddingConfig():
            if api_key is None or api_key == "":
                raise ValueError("an API key is required for the voyage provider")
            return VoyageEmbeddingProvider(model=config.model, api_key=api_key, endpoint=config.endpoint)
        case _:
            assert_never(config)
