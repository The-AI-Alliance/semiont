"""The Librarian's document: what it refuses that no schema can state, and the secrets it reads by the names the document gives.

`docs/protocol/LIBRARIAN.md` § Settings states each refusal. A refusal names
the member as the document spells it, and what was expected of it.
"""

import json
from pathlib import Path
from typing import Final

import pytest
from pydantic import JsonValue
from semiont.timing import HELD_JOB_STALL_MS
from semiont.types import LibrarianConfig
from semiont_service.config import Refused

from semiont_librarian.config import SERVICE, api_key_of, embedding_key_of, graph_password_of, read_librarian_config

NEO4J: Final[dict[str, JsonValue]] = {
    "type": "neo4j",
    "uri": "bolt://127.0.0.1:1",
    "username": "neo4j",
    "passwordEnv": "NEO4J_PASSWORD",
    "database": "neo4j",
}
JANUSGRAPH: Final[dict[str, JsonValue]] = {"type": "janusgraph", "host": "127.0.0.1", "port": 1}
QDRANT: Final[dict[str, JsonValue]] = {"type": "qdrant", "host": "127.0.0.1", "port": 1}
OLLAMA: Final[dict[str, JsonValue]] = {"type": "ollama", "model": "nomic-embed-text", "baseUrl": "http://127.0.0.1:1"}
VOYAGE: Final[dict[str, JsonValue]] = {
    "type": "voyage",
    "model": "voyage-3",
    "endpoint": "http://127.0.0.1:1/v1/embeddings",
    "apiKeyEnv": "VOYAGE_API_KEY",
}
ENGINE: Final[dict[str, JsonValue]] = {"engine": {"provider": "ollama", "model": "a-model"}, "baseUrl": "http://127.0.0.1:1"}

DOCUMENT: Final[dict[str, JsonValue]] = {
    "gatewayUrl": "http://127.0.0.1:1",
    "identity": {"issuer": "http://127.0.0.1:1/realms/semiont"},
    "archivist": {"host": "127.0.0.1", "port": 1},
    "graph": NEO4J,
    "vectors": QDRANT,
    "embedding": OLLAMA,
    "matcher": ENGINE,
    "gatherer": ENGINE,
    "modelCatalogue": "/usr/share/semiont/model-catalogue.json",
    "gather": {"settleTimeoutMs": 15000},
    "search": {"semanticFloor": 0.6},
    "port": 24104,
    "logLevel": "warn",
    "logFormat": "simple",
}

GRAPH_WAIT_MS: Final = 875
"""The longest a gather waits for the graph, in milliseconds, as the page states it."""


def written(tmp_path: Path, document: object = DOCUMENT) -> str:
    path = tmp_path / "librarian.json"
    path.write_text(json.dumps(document), encoding="utf-8")
    return str(path)


def stating(**members: JsonValue) -> LibrarianConfig:
    """The document, with these members in place of its own."""
    return LibrarianConfig.model_validate({**DOCUMENT, **members})


def refused(tmp_path: Path, **members: JsonValue) -> str:
    """What the document is refused with, where these members are in place of its own."""
    with pytest.raises(Refused) as refusal:
        read_librarian_config(written(tmp_path, {**DOCUMENT, **members}))
    return str(refusal.value)


def test_the_service_is_called_the_librarian() -> None:
    assert SERVICE == "librarian"


def test_a_document_that_states_everything_is_read_as_it_is(tmp_path: Path) -> None:
    config = read_librarian_config(written(tmp_path))
    assert config.gateway_url == "http://127.0.0.1:1"
    assert config.gather.settle_timeout_ms == 15000
    assert config.search.semantic_floor == 0.6
    assert config.port == 24104


def test_a_graph_held_in_the_librarians_own_memory_is_refused(tmp_path: Path) -> None:
    assert refused(tmp_path, graph={"type": "memory"}) == (
        "graph.type is memory: a graph held in the librarian's own memory is not the graph the Weaver writes"
    )


def test_an_index_held_in_the_librarians_own_memory_is_refused(tmp_path: Path) -> None:
    assert refused(tmp_path, vectors={"type": "memory"}) == (
        "vectors.type is memory: an index held in the librarian's own memory is not the index the Smelter writes"
    )


def test_a_settle_bound_that_with_the_wait_for_the_graph_is_not_under_the_held_job_stall_is_refused(tmp_path: Path) -> None:
    least_refused = HELD_JOB_STALL_MS - GRAPH_WAIT_MS
    said = (
        f"gather.settleTimeoutMs must be less than {least_refused}: with the 875 milliseconds "
        f"a gather can wait for the graph, it is to end before a held job is called stalled (heldJobStallMs, {HELD_JOB_STALL_MS})"
    )
    assert refused(tmp_path, gather={"settleTimeoutMs": least_refused}) == said
    assert refused(tmp_path, gather={"settleTimeoutMs": HELD_JOB_STALL_MS * 2}) == said
    # One millisecond less, and a gather that waited out both has answered before the stall.
    kept = read_librarian_config(written(tmp_path, {**DOCUMENT, "gather": {"settleTimeoutMs": least_refused - 1}}))
    assert kept.gather.settle_timeout_ms == least_refused - 1


def test_a_settle_bound_that_is_no_number_above_zero_is_refused_by_the_schema(tmp_path: Path) -> None:
    for stated in (0, -1):
        said = refused(tmp_path, gather={"settleTimeoutMs": stated})
        assert said.splitlines()[1:] == ["  gather.settleTimeoutMs: Input should be greater than or equal to 1"]
    assert refused(tmp_path, gather={}).splitlines()[1:] == ["  Missing required property: settleTimeoutMs"]


def test_the_graph_databases_password_is_read_from_the_variable_the_document_names() -> None:
    assert graph_password_of(stating(), {"NEO4J_PASSWORD": "n30"}) == "n30"
    unset: list[dict[str, str]] = [{}, {"NEO4J_PASSWORD": ""}]
    for environment in unset:
        with pytest.raises(Refused) as refusal:
            graph_password_of(stating(), environment)
        assert str(refusal.value) == "graph.passwordEnv names NEO4J_PASSWORD, which is not set in the librarian's environment"
    # A database that takes no password names no variable, and none is read for it.
    assert graph_password_of(stating(graph=JANUSGRAPH), {}) is None


def test_the_embedding_providers_key_is_read_from_the_variable_the_document_names() -> None:
    assert embedding_key_of(stating(embedding=VOYAGE), {"VOYAGE_API_KEY": "a-key"}) == "a-key"
    with pytest.raises(Refused) as refusal:
        embedding_key_of(stating(embedding=VOYAGE), {})
    assert str(refusal.value) == "embedding.apiKeyEnv names VOYAGE_API_KEY, which is not set in the librarian's environment"
    # An Ollama's part of the document names no variable, and none is read for it.
    assert embedding_key_of(stating(), {}) is None


def test_each_actors_key_is_read_from_the_variable_its_part_of_the_document_names() -> None:
    keyed = stating(matcher={**ENGINE, "apiKeyEnv": "MATCHER_KEY"}, gatherer={**ENGINE, "apiKeyEnv": "GATHERER_KEY"})
    environment = {"MATCHER_KEY": "m-key", "GATHERER_KEY": "g-key"}
    assert api_key_of("matcher", keyed.matcher, environment) == "m-key"
    assert api_key_of("gatherer", keyed.gatherer, environment) == "g-key"
    with pytest.raises(Refused) as refusal:
        api_key_of("matcher", keyed.matcher, {"GATHERER_KEY": "g-key"})
    assert str(refusal.value) == "matcher.apiKeyEnv names MATCHER_KEY, which is not set in the librarian's environment"
    with pytest.raises(Refused) as refusal:
        api_key_of("gatherer", keyed.gatherer, {"MATCHER_KEY": "m-key", "GATHERER_KEY": ""})
    assert str(refusal.value) == "gatherer.apiKeyEnv names GATHERER_KEY, which is not set in the librarian's environment"
    # An actor whose provider takes no key names no variable, and none is read for it.
    assert api_key_of("matcher", stating().matcher, {}) is None
