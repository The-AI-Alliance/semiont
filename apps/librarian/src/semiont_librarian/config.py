"""What of the Librarian's configuration is the Librarian's own: its name, what it refuses, and the secrets its document names.

The document is the protocol's `LibrarianConfig`. It is found, read and
refused as every Python service's is (`semiont_service.config`), and so is
the service's account. A secret is never in the document. The document names
the variable that holds the graph database's password, the one that holds an
embedding provider's key and the one that holds each actor's key, and the
environment is read for each here. `docs/protocol/LIBRARIAN.md` § Settings
states each refusal.
"""

from collections.abc import Mapping
from typing import Final, Literal

from semiont.timing import HELD_JOB_STALL_MS
from semiont.types import (
    LibrarianConfig,
    LibrarianModelConfig,
    MemoryGraphConfig,
    MemoryVectorsConfig,
    Neo4jGraphConfig,
    VoyageEmbeddingConfig,
)
from semiont_service.config import Refused, read_config, set_in

from semiont_librarian.knowledge_graph import GRAPH_WAIT_BUDGET

__all__ = ["SERVICE", "Actor", "api_key_of", "embedding_key_of", "graph_password_of", "read_librarian_config"]

SERVICE: Final = "librarian"
"""What the service is called among a knowledge base's services, as its image and its container are named."""

type Actor = Literal["matcher", "gatherer"]
"""One of the two that ask a model: the Matcher, in a reference search, and the Gatherer, in a gather and a summary."""

_GRAPH_WAIT_MS: Final = round(GRAPH_WAIT_BUDGET * 1000)
"""The longest a gather waits for the graph, in milliseconds, as the document states a bound."""


def read_librarian_config(path: str) -> LibrarianConfig:
    """The document at `path`: read, and held to its schema before it is believed.

    A graph and a vector index held in one process's memory are kinds the
    schema has, and a Librarian refuses each: it reads what another service
    writes, and neither could be shared with that service.

    The settle bound is refused where a gather that waited it out, after the
    longest wait for the graph, would not have answered before a held job is
    called stalled (`heldJobStallMs` of the client timing table): whoever
    holds a job and asks for a gather would be ended in place of being
    answered with less.
    """
    config = read_config(SERVICE, LibrarianConfig, path)
    if isinstance(config.graph, MemoryGraphConfig):
        raise Refused("graph.type is memory: a graph held in the librarian's own memory is not the graph the Weaver writes")
    if isinstance(config.vectors, MemoryVectorsConfig):
        raise Refused("vectors.type is memory: an index held in the librarian's own memory is not the index the Smelter writes")
    if config.gather.settle_timeout_ms + _GRAPH_WAIT_MS >= HELD_JOB_STALL_MS:
        raise Refused(
            f"gather.settleTimeoutMs must be less than {HELD_JOB_STALL_MS - _GRAPH_WAIT_MS}: with the {_GRAPH_WAIT_MS} milliseconds "
            f"a gather can wait for the graph, it is to end before a held job is called stalled (heldJobStallMs, {HELD_JOB_STALL_MS})"
        )
    return config


def graph_password_of(config: LibrarianConfig, environment: Mapping[str, str]) -> str | None:
    """The graph database's password, read from the variable the document names for it. Nothing for a database that takes none.

    The refusal names the variable. A variable's name is no secret, and is
    what an operator has to set.
    """
    graph = config.graph
    if not isinstance(graph, Neo4jGraphConfig):
        return None
    password = set_in(environment, graph.password_env)
    if password is None:
        raise Refused(f"graph.passwordEnv names {graph.password_env}, which is not set in the librarian's environment")
    return password


def embedding_key_of(config: LibrarianConfig, environment: Mapping[str, str]) -> str | None:
    """The embedding provider's key, read from the variable the document names for it. Nothing for a provider that takes none."""
    embedding = config.embedding
    if not isinstance(embedding, VoyageEmbeddingConfig):
        return None
    key = set_in(environment, embedding.api_key_env)
    if key is None:
        raise Refused(f"embedding.apiKeyEnv names {embedding.api_key_env}, which is not set in the librarian's environment")
    return key


def api_key_of(actor: Actor, model: LibrarianModelConfig, environment: Mapping[str, str]) -> str | None:
    """The key of an actor's model, read from the variable the document names for it. `model` is the actor's part of the document.

    An actor whose provider takes no key names no variable and has none.
    """
    name = model.api_key_env
    if name is None:
        return None
    key = set_in(environment, name)
    if key is None:
        raise Refused(f"{actor}.apiKeyEnv names {name}, which is not set in the librarian's environment")
    return key
