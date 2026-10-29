"""The service as a process: what it is started with, the order it refuses in, and what it says when it does not start.

`docs/protocol/SMELTER.md` § Settings states each refusal, and the smelter
conformance suite holds a started process to them. Here is their order, which
says which is settled first, that a refusal is all the process writes, and
what the suite does not reach: each word of a refusal.
"""

import json
import sys
from pathlib import Path
from typing import Final

import pytest
from pydantic import JsonValue
from semiont.channels import PERSISTED_EVENT_TYPES
from semiont.http import SecretCredential
from semiont_service.config import Refused
from semiont_vectors.ollama import OllamaEmbeddingProvider
from semiont_vectors.qdrant import QdrantVectorStore
from semiont_vectors.voyage import VoyageEmbeddingProvider

from semiont_smelter.service import CHANNELS, boot, main

pytestmark = pytest.mark.usefixtures("the_log_as_it_was")

ACCOUNT: Final = {"SEMIONT_OIDC_CLIENT_ID": "semiont-smelter", "SEMIONT_OIDC_CLIENT_SECRET": "s3cret"}

OLLAMA: Final[dict[str, JsonValue]] = {"type": "ollama", "model": "nomic-embed-text", "baseUrl": "http://127.0.0.1:1"}
VOYAGE: Final[dict[str, JsonValue]] = {
    "type": "voyage",
    "model": "voyage-3",
    "endpoint": "http://127.0.0.1:1/v1/embeddings",
    "apiKeyEnv": "VOYAGE_API_KEY",
}
QDRANT: Final[dict[str, JsonValue]] = {"type": "qdrant", "host": "127.0.0.1", "port": 1}

DOCUMENT: Final[dict[str, JsonValue]] = {
    "gatewayUrl": "http://127.0.0.1:1",
    "identity": {"issuer": "http://127.0.0.1:1/realms/semiont"},
    "archivist": {"host": "127.0.0.1", "port": 1},
    "embedding": OLLAMA,
    "vectors": QDRANT,
    "chunking": {"chunkSize": 512, "overlap": 64},
    "pdfsAtOnce": 1,
    "cursorsPath": "/tmp/semiont/smelter-cursors.json",
    "port": 24101,
    "logLevel": "warn",
    "logFormat": "simple",
}


def written(tmp_path: Path, document: object = DOCUMENT) -> str:
    path = tmp_path / "smelter.json"
    path.write_text(json.dumps(document), encoding="utf-8")
    return str(path)


def refusal(arguments: list[str], environment: dict[str, str]) -> str:
    with pytest.raises(Refused) as refused:
        boot(arguments, environment)
    return str(refused.value)


def without(member: str) -> dict[str, JsonValue]:
    return {name: value for name, value in DOCUMENT.items() if name != member}


def lacking(part: dict[str, JsonValue], member: str) -> dict[str, JsonValue]:
    return {name: value for name, value in part.items() if name != member}


def test_started_with_everything_it_boots_and_dials_nothing(tmp_path: Path) -> None:
    # Nothing listens at any address the document names: a boot that dialled one would fail here.
    started = boot(["--config", written(tmp_path)], ACCOUNT)
    assert started.config.gateway_url == "http://127.0.0.1:1"
    assert started.credential == SecretCredential(
        issuer="http://127.0.0.1:1/realms/semiont", client_id="semiont-smelter", client_secret="s3cret"
    )
    assert isinstance(started.provider, OllamaEmbeddingProvider)
    assert isinstance(started.index, QdrantVectorStore)


def test_its_stream_names_every_event_of_the_record_the_command_it_answers_and_the_replies_of_what_it_asks() -> None:
    # Every event of the record, as every follower of it receives them: a gap in a resource's sequence numbers is then
    # always an event it missed, and never one of a kind it does nothing with.
    named = (
        *PERSISTED_EVENT_TYPES,
        "smelt:rebuild-anchors",
        "browse:resources-result",
        "browse:resources-failed",
        "browse:resource-result",
        "browse:resource-failed",
    )
    assert named == CHANNELS
    assert len(CHANNELS) == len(set(CHANNELS))


def test_the_document_is_named_by_a_flag_and_never_guessed(tmp_path: Path) -> None:
    said = "The smelter's configuration document is not named: start it with --config <path>"
    assert refusal([], ACCOUNT) == said
    assert refusal(["--config"], ACCOUNT) == said
    assert refusal(["--config", "--verbose"], ACCOUNT) == said
    assert refusal(["--config="], ACCOUNT) == said
    path = written(tmp_path)
    assert boot([f"--config={path}"], ACCOUNT).config.port == 24101


def test_a_document_that_cannot_be_read_or_is_no_json_is_refused_by_its_path(tmp_path: Path) -> None:
    missing = str(tmp_path / "nowhere.json")
    assert refusal(["--config", missing], ACCOUNT).startswith(f"Cannot read the smelter's configuration document at {missing} (")
    path = tmp_path / "smelter.json"
    path.write_text("{ not json", encoding="utf-8")
    assert refusal(["--config", str(path)], ACCOUNT).startswith(f"{path} is not JSON: ")


def test_a_document_that_is_not_the_schemas_is_refused_naming_each_member_and_no_value(tmp_path: Path) -> None:
    document: dict[str, JsonValue] = {
        **without("pdfsAtOnce"),
        "port": "24101",
        "embedding": {"type": "voyage", "model": "voyage-3", "endpoint": "http://127.0.0.1:1/v1/embeddings", "apiKey": "hunter2"},
        "extra": 1,
    }
    path = written(tmp_path, document)
    said = refusal(["--config", path], ACCOUNT)
    assert said.splitlines()[0] == f"{path} is not a smelter configuration document (SmelterConfig):"
    assert sorted(said.splitlines()[1:]) == sorted(
        [
            "  Missing required property: apiKeyEnv",
            "  embedding.voyage: unknown property apiKey",
            "  Missing required property: pdfsAtOnce",
            "  port: Input should be a valid integer",
            "  root: unknown property extra",
        ]
    )
    # A key written where its variable's name belongs is never said back.
    assert "hunter2" not in said


@pytest.mark.parametrize(
    ("document", "missing"),
    [
        (without("gatewayUrl"), "gatewayUrl"),
        ({**DOCUMENT, "identity": {}}, "issuer"),
        (without("archivist"), "archivist"),
        ({**DOCUMENT, "vectors": lacking(QDRANT, "host")}, "host"),
        ({**DOCUMENT, "vectors": lacking(QDRANT, "port")}, "port"),
        ({**DOCUMENT, "embedding": lacking(OLLAMA, "model")}, "model"),
        ({**DOCUMENT, "embedding": lacking(OLLAMA, "baseUrl")}, "baseUrl"),
        ({**DOCUMENT, "chunking": {"chunkSize": 512}}, "overlap"),
        (without("chunking"), "chunking"),
        (without("cursorsPath"), "cursorsPath"),
    ],
    ids=["gatewayUrl", "issuer", "archivist", "host", "port", "model", "baseUrl", "overlap", "chunking", "cursorsPath"],
)
def test_nothing_the_document_leaves_out_is_supplied_and_each_is_refused_by_name(
    tmp_path: Path, document: dict[str, JsonValue], missing: str
) -> None:
    said = refusal(["--config", written(tmp_path, document)], ACCOUNT)
    assert said.splitlines()[1:] == [f"  Missing required property: {missing}"]


def test_an_embedding_provider_or_an_index_of_no_stated_kind_is_refused_without_saying_what_was_written(tmp_path: Path) -> None:
    untold = written(tmp_path, {**DOCUMENT, "embedding": lacking(OLLAMA, "type")})
    assert refusal(["--config", untold], ACCOUNT).splitlines()[1:] == ["  embedding: Unable to extract tag using discriminator 'type'"]
    for part in ("embedding", "vectors"):
        said = refusal(["--config", written(tmp_path, {**DOCUMENT, part: {"type": "hunter2"}})], ACCOUNT)
        assert said.splitlines()[1:] == [f"  {part}: is not what the schema states (union_tag_invalid)"]
        assert "hunter2" not in said


def test_an_index_held_in_the_smelters_own_memory_is_refused(tmp_path: Path) -> None:
    path = written(tmp_path, {**DOCUMENT, "vectors": {"type": "memory"}})
    assert refusal(["--config", path], ACCOUNT) == (
        "vectors.type is memory: an index held in the smelter's own memory could not be searched by anything else"
    )


def test_the_document_is_settled_before_the_account_and_the_account_before_the_providers_key(tmp_path: Path) -> None:
    assert refusal(["--config", written(tmp_path, without("vectors"))], {}).endswith("  Missing required property: vectors")
    keyed = written(tmp_path, {**DOCUMENT, "embedding": VOYAGE})
    assert refusal(["--config", keyed], {}) == (
        "SEMIONT_OIDC_CLIENT_ID is not set in the smelter's environment: a smelter signs in as a service account"
    )
    assert refusal(["--config", keyed], {"SEMIONT_OIDC_CLIENT_ID": "semiont-smelter", "SEMIONT_OIDC_CLIENT_SECRET": ""}) == (
        "SEMIONT_OIDC_CLIENT_SECRET is not set in the smelter's environment: a smelter signs in as a service account"
    )
    assert refusal(["--config", keyed], ACCOUNT) == (
        "embedding.apiKeyEnv names VOYAGE_API_KEY, which is not set in the smelter's environment"
    )
    assert refusal(["--config", keyed], {**ACCOUNT, "VOYAGE_API_KEY": ""}) == (
        "embedding.apiKeyEnv names VOYAGE_API_KEY, which is not set in the smelter's environment"
    )
    started = boot(["--config", keyed], {**ACCOUNT, "VOYAGE_API_KEY": "a-key"})
    assert isinstance(started.provider, VoyageEmbeddingProvider)


def test_a_provider_that_takes_no_key_is_asked_for_none(tmp_path: Path) -> None:
    # An Ollama's part of the document names no variable, and none is read for it.
    assert isinstance(boot(["--config", written(tmp_path)], ACCOUNT).provider, OllamaEmbeddingProvider)


def test_a_refusal_is_one_line_on_stderr_and_status_1_and_nothing_on_stdout(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setattr(sys, "argv", ["semiont_smelter", "--config", written(tmp_path)])
    for name in ACCOUNT:
        monkeypatch.delenv(name, raising=False)

    assert main() == 1

    said = capsys.readouterr()
    assert said.out == ""
    unset = "SEMIONT_OIDC_CLIENT_ID is not set in the smelter's environment"
    assert said.err == f"[fatal] {unset}: a smelter signs in as a service account\n"
