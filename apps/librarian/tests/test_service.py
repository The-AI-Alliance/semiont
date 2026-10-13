"""The service as a process: what it is started with, the order it refuses in, and what it says when it does not start.

`docs/protocol/LIBRARIAN.md` § Settings states each refusal, § What it
answers the channels its stream names, and § Health what its health endpoint
says. Here is the order of the refusals, which says which is settled first,
that a refusal is all the process writes, and each word of one. What the
document itself is refused for is in `test_config.py`.
"""

import json
import sys
from pathlib import Path
from typing import Final

import pytest
from pydantic import JsonValue
from semiont.http import Credential
from semiont_graph.neo4j import Neo4jGraphReader
from semiont_inference.ollama import OllamaInferenceClient
from semiont_service.config import Refused
from semiont_vectors.ollama import OllamaEmbeddingProvider
from semiont_vectors.qdrant import QdrantVectorReader
from semiont_vectors.voyage import VoyageEmbeddingProvider
from test_config import DOCUMENT, MODEL, VOYAGE, written

from semiont_librarian.service import CHANNELS, boot, health, main

pytestmark = pytest.mark.usefixtures("the_log_as_it_was")

ACCOUNT: Final = {"SEMIONT_OIDC_CLIENT_ID": "semiont-librarian", "SEMIONT_OIDC_CLIENT_SECRET": "s3cret"}
PASSWORD: Final = {"NEO4J_PASSWORD": "n30"}

KEYED: Final[dict[str, JsonValue]] = {
    **DOCUMENT,
    "embedding": VOYAGE,
    "matcher": {**MODEL, "apiKeyEnv": "MATCHER_KEY"},
    "gatherer": {**MODEL, "apiKeyEnv": "GATHERER_KEY"},
}
"""A document that names a variable for every secret a Librarian can be told."""


def refusal(arguments: list[str], environment: dict[str, str]) -> str:
    with pytest.raises(Refused) as refused:
        boot(arguments, environment)
    return str(refused.value)


def without(member: str) -> dict[str, JsonValue]:
    return {name: value for name, value in DOCUMENT.items() if name != member}


def test_started_with_everything_it_boots_and_dials_nothing(tmp_path: Path) -> None:
    # Nothing listens at any address the document names: a boot that dialled one would fail here.
    started = boot(["--config", written(tmp_path)], {**ACCOUNT, **PASSWORD})
    assert started.config.gateway_url == "http://127.0.0.1:1"
    assert started.credential == Credential(
        issuer="http://127.0.0.1:1/realms/semiont", client_id="semiont-librarian", client_secret="s3cret"
    )
    # The graph is reached by what only reads it, which is made and not connected: nothing at that address was asked anything.
    assert isinstance(started.graph, Neo4jGraphReader)
    # The index is reached by what only searches it.
    assert isinstance(started.vectors, QdrantVectorReader)
    assert isinstance(started.embedding, OllamaEmbeddingProvider)
    assert isinstance(started.matcher, OllamaInferenceClient)
    assert isinstance(started.gatherer, OllamaInferenceClient)
    assert started.matcher is not started.gatherer


def test_its_stream_names_the_eight_requests_it_answers_and_the_two_signals_it_follows_and_no_reply() -> None:
    assert sorted(CHANNELS) == sorted(
        [
            "match:search-requested",
            "match:resources-requested",
            "match:limits-requested",
            "gather:requested",
            "gather:resource-requested",
            "gather:summary-requested",
            "gather:referenced-by-requested",
            "gather:limits-requested",
            "weave:applied",
            "smelt:settled",
        ]
    )
    assert len(CHANNELS) == len(set(CHANNELS))


def test_its_health_says_it_is_up_and_names_its_two_actors() -> None:
    assert health() == {"status": "ok", "actors": ["matcher", "gatherer"]}
    assert json.dumps(health()) == '{"status": "ok", "actors": ["matcher", "gatherer"]}'


def test_the_document_is_named_by_a_flag_and_never_guessed(tmp_path: Path) -> None:
    said = "The librarian's configuration document is not named: start it with --config <path>"
    environment = {**ACCOUNT, **PASSWORD}
    assert refusal([], environment) == said
    assert refusal(["--config"], environment) == said
    assert refusal(["--config", "--verbose"], environment) == said
    assert refusal(["--config="], environment) == said
    path = written(tmp_path)
    assert boot([f"--config={path}"], environment).config.port == 24104


def test_a_document_that_cannot_be_read_or_is_no_json_is_refused_by_its_path(tmp_path: Path) -> None:
    missing = str(tmp_path / "nowhere.json")
    assert refusal(["--config", missing], ACCOUNT).startswith(f"Cannot read the librarian's configuration document at {missing} (")
    path = tmp_path / "librarian.json"
    path.write_text("{ not json", encoding="utf-8")
    assert refusal(["--config", str(path)], ACCOUNT).startswith(f"{path} is not JSON: ")


@pytest.mark.parametrize(
    "missing",
    [
        "gatewayUrl",
        "identity",
        "archivist",
        "stateHome",
        "kbName",
        "graph",
        "vectors",
        "embedding",
        "matcher",
        "gatherer",
        "gather",
        "search",
        "port",
        "logLevel",
        "logFormat",
    ],
)
def test_nothing_the_document_leaves_out_is_supplied_and_each_is_refused_by_name(tmp_path: Path, missing: str) -> None:
    path = written(tmp_path, without(missing))
    said = refusal(["--config", path], {**ACCOUNT, **PASSWORD})
    assert said.splitlines() == [
        f"{path} is not a librarian configuration document (LibrarianConfig):",
        f"  Missing required property: {missing}",
    ]


def test_a_store_held_in_the_librarians_own_memory_and_a_settle_bound_past_the_stall_are_refused_before_the_account(
    tmp_path: Path,
) -> None:
    in_memory = written(tmp_path, {**DOCUMENT, "graph": {"type": "memory"}})
    assert refusal(["--config", in_memory], {}).startswith("graph.type is memory: ")
    in_memory = written(tmp_path, {**DOCUMENT, "vectors": {"type": "memory"}})
    assert refusal(["--config", in_memory], {}).startswith("vectors.type is memory: ")
    too_long = written(tmp_path, {**DOCUMENT, "gather": {"settleTimeoutMs": 900_000}})
    assert refusal(["--config", too_long], {}).startswith("gather.settleTimeoutMs must be less than ")


def test_the_document_is_settled_before_the_account_and_the_account_before_each_secret_the_document_names(tmp_path: Path) -> None:
    assert refusal(["--config", written(tmp_path, without("vectors"))], {}).endswith("  Missing required property: vectors")
    keyed = written(tmp_path, KEYED)
    assert refusal(["--config", keyed], {}) == (
        "SEMIONT_OIDC_CLIENT_ID is not set in the librarian's environment: a librarian signs in as a service account"
    )
    assert refusal(["--config", keyed], {"SEMIONT_OIDC_CLIENT_ID": "semiont-librarian", "SEMIONT_OIDC_CLIENT_SECRET": ""}) == (
        "SEMIONT_OIDC_CLIENT_SECRET is not set in the librarian's environment: a librarian signs in as a service account"
    )
    # Then the graph database's password, the embedding provider's key, the Matcher's and the Gatherer's.
    environment = dict(ACCOUNT)
    assert refusal(["--config", keyed], environment) == (
        "graph.passwordEnv names NEO4J_PASSWORD, which is not set in the librarian's environment"
    )
    environment["NEO4J_PASSWORD"] = "n30"
    assert refusal(["--config", keyed], environment) == (
        "embedding.apiKeyEnv names VOYAGE_API_KEY, which is not set in the librarian's environment"
    )
    environment["VOYAGE_API_KEY"] = "v-key"
    assert refusal(["--config", keyed], environment) == (
        "matcher.apiKeyEnv names MATCHER_KEY, which is not set in the librarian's environment"
    )
    environment["MATCHER_KEY"] = "m-key"
    assert refusal(["--config", keyed], environment) == (
        "gatherer.apiKeyEnv names GATHERER_KEY, which is not set in the librarian's environment"
    )
    environment["GATHERER_KEY"] = "g-key"
    started = boot(["--config", keyed], environment)
    assert isinstance(started.embedding, VoyageEmbeddingProvider)


def test_a_provider_that_takes_a_key_is_refused_by_the_member_where_the_document_names_no_variable_for_one(tmp_path: Path) -> None:
    anthropic: dict[str, JsonValue] = {"agent": {"provider": "anthropic", "model": "a-model"}, "baseUrl": "http://127.0.0.1:1"}
    environment = {**ACCOUNT, **PASSWORD}

    keyless_matcher = written(tmp_path, {**DOCUMENT, "matcher": anthropic})
    assert refusal(["--config", keyless_matcher], environment) == (
        "matcher.apiKeyEnv is not stated, and matcher.agent.provider is anthropic: api_key is required for the Anthropic inference client"
    )
    keyless_gatherer = written(tmp_path, {**DOCUMENT, "gatherer": anthropic})
    assert refusal(["--config", keyless_gatherer], environment) == (
        "gatherer.apiKeyEnv is not stated, and gatherer.agent.provider is anthropic: api_key is required for the Anthropic inference client"
    )


def test_a_refusal_is_one_line_on_stderr_and_status_1_and_nothing_on_stdout(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setattr(sys, "argv", ["semiont_librarian", "--config", written(tmp_path)])
    for name in ACCOUNT:
        monkeypatch.delenv(name, raising=False)

    assert main() == 1

    said = capsys.readouterr()
    assert said.out == ""
    unset = "SEMIONT_OIDC_CLIENT_ID is not set in the librarian's environment"
    assert said.err == f"[fatal] {unset}: a librarian signs in as a service account\n"
