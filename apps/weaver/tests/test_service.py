"""The service as a process: what it is started with, the order it refuses in, and what it says when it does not start.

`docs/protocol/WEAVER.md` § Settings states each refusal, and the weaver
conformance suite holds a started process to them. Here is their order, which
says which is settled first, that a refusal is all the process writes, and
what the suite does not reach: each word of a refusal.
"""

import json
import logging
import sys
from collections.abc import Generator
from pathlib import Path
from typing import Final

import pytest
from pydantic import JsonValue
from semiont.http import Credential
from semiont_graph.memory import MemoryGraphDatabase

from semiont_weaver.config import Refused
from semiont_weaver.log import LOG
from semiont_weaver.service import CHANNELS, boot, main

ACCOUNT: Final = {"SEMIONT_OIDC_CLIENT_ID": "semiont-weaver", "SEMIONT_OIDC_CLIENT_SECRET": "s3cret"}
PASSWORD: Final = {"NEO4J_PASSWORD": "n30"}

DOCUMENT: Final[dict[str, JsonValue]] = {
    "gatewayUrl": "http://127.0.0.1:1",
    "identity": {"issuer": "http://127.0.0.1:1/realms/semiont"},
    "graph": {"type": "neo4j", "uri": "bolt://127.0.0.1:1", "username": "neo4j", "passwordEnv": "NEO4J_PASSWORD", "database": "neo4j"},
    "checkpointPath": "/tmp/semiont/weaver-checkpoint.json",
    "port": 24102,
    "logLevel": "warn",
    "logFormat": "simple",
}


@pytest.fixture(autouse=True)
def the_log_as_it_was() -> Generator[None]:
    """A process's logging is configured once, by the service as it boots. A test that boots it puts it back."""
    everything = logging.getLogger()
    handlers, level, own = list(everything.handlers), everything.level, LOG.level
    yield
    everything.handlers[:] = handlers
    everything.setLevel(level)
    LOG.setLevel(own)
    logging.captureWarnings(False)


def written(tmp_path: Path, document: object = DOCUMENT) -> str:
    path = tmp_path / "weaver.json"
    path.write_text(json.dumps(document), encoding="utf-8")
    return str(path)


def refusal(arguments: list[str], environment: dict[str, str]) -> str:
    with pytest.raises(Refused) as refused:
        boot(arguments, environment)
    return str(refused.value)


def without(member: str) -> dict[str, JsonValue]:
    return {name: value for name, value in DOCUMENT.items() if name != member}


def test_started_with_everything_it_boots_and_dials_nothing(tmp_path: Path) -> None:
    started = boot(["--config", written(tmp_path)], {**ACCOUNT, **PASSWORD})
    assert started.config.gateway_url == "http://127.0.0.1:1"
    assert started.credential == Credential(issuer="http://127.0.0.1:1/realms/semiont", client_id="semiont-weaver", client_secret="s3cret")
    # A store is made and not connected: nothing at that address was asked anything.
    assert not started.graph.is_connected()
    assert not isinstance(started.graph, MemoryGraphDatabase)


def test_its_stream_names_what_it_follows_the_command_it_answers_and_the_replies_of_what_it_asks() -> None:
    assert sorted(CHANNELS) == sorted(
        [
            "yield:created",
            "mark:archived",
            "mark:unarchived",
            "mark:added",
            "mark:removed",
            "mark:body-updated",
            "mark:entity-tag-added",
            "mark:entity-tag-removed",
            "frame:entity-type-added",
            "weave:rebuild",
            "browse:resources-result",
            "browse:resources-failed",
            "browse:events-result",
            "browse:events-failed",
            "browse:annotations-result",
            "browse:annotations-failed",
        ]
    )


def test_the_document_is_named_by_a_flag_and_never_guessed(tmp_path: Path) -> None:
    said = "The weaver's configuration document is not named: start it with --config <path>"
    assert refusal([], {**ACCOUNT, **PASSWORD}) == said
    assert refusal(["--config"], {**ACCOUNT, **PASSWORD}) == said
    assert refusal(["--config", "--verbose"], {**ACCOUNT, **PASSWORD}) == said
    assert refusal(["--config="], {**ACCOUNT, **PASSWORD}) == said
    path = written(tmp_path)
    assert boot([f"--config={path}"], {**ACCOUNT, **PASSWORD}).config.port == 24102


def test_a_document_that_cannot_be_read_or_is_no_json_is_refused_by_its_path(tmp_path: Path) -> None:
    missing = str(tmp_path / "nowhere.json")
    assert refusal(["--config", missing], {**ACCOUNT, **PASSWORD}).startswith(
        f"Cannot read the weaver's configuration document at {missing} ("
    )
    path = tmp_path / "weaver.json"
    path.write_text("{ not json", encoding="utf-8")
    assert refusal(["--config", str(path)], {**ACCOUNT, **PASSWORD}).startswith(f"{path} is not JSON: ")


def test_a_document_that_is_not_the_schemas_is_refused_naming_each_member_and_no_value(tmp_path: Path) -> None:
    document: dict[str, JsonValue] = {
        **without("checkpointPath"),
        "port": "24102",
        "graph": {"type": "neo4j", "uri": "bolt://127.0.0.1:1", "username": "neo4j", "password": "hunter2", "database": "neo4j"},
        "extra": 1,
    }
    path = written(tmp_path, document)
    said = refusal(["--config", path], {**ACCOUNT, **PASSWORD})
    assert said.splitlines()[0] == f"{path} is not a weaver configuration document (WeaverConfig):"
    assert sorted(said.splitlines()[1:]) == sorted(
        [
            "  Missing required property: passwordEnv",
            "  graph.neo4j: unknown property password",
            "  Missing required property: checkpointPath",
            "  port: Input should be a valid integer",
            "  root: unknown property extra",
        ]
    )
    # A password written where its variable's name belongs is never said back.
    assert "hunter2" not in said


def test_a_kind_of_graph_database_the_schema_does_not_name_is_refused_without_saying_what_was_written(tmp_path: Path) -> None:
    path = written(tmp_path, {**DOCUMENT, "graph": {"type": "hunter2"}})
    said = refusal(["--config", path], {**ACCOUNT, **PASSWORD})
    assert said.splitlines()[1:] == ["  graph: is not what the schema states (union_tag_invalid)"]
    assert "hunter2" not in said


def test_a_graph_held_in_the_weavers_own_memory_is_refused(tmp_path: Path) -> None:
    path = written(tmp_path, {**DOCUMENT, "graph": {"type": "memory"}})
    assert refusal(["--config", path], {**ACCOUNT, **PASSWORD}) == (
        "graph.type is memory: a graph held in the weaver's own memory could not be shared with a reader of the graph"
    )


def test_the_document_is_settled_before_the_account_and_the_account_before_the_password(tmp_path: Path) -> None:
    assert refusal(["--config", written(tmp_path, without("graph"))], {}).endswith("  Missing required property: graph")
    path = written(tmp_path)
    assert refusal(["--config", path], {}) == (
        "SEMIONT_OIDC_CLIENT_ID is not set in the weaver's environment: a weaver signs in as a service account"
    )
    assert refusal(["--config", path], {"SEMIONT_OIDC_CLIENT_ID": "semiont-weaver", "SEMIONT_OIDC_CLIENT_SECRET": ""}) == (
        "SEMIONT_OIDC_CLIENT_SECRET is not set in the weaver's environment: a weaver signs in as a service account"
    )
    assert refusal(["--config", path], ACCOUNT) == "graph.passwordEnv names NEO4J_PASSWORD, which is not set in the weaver's environment"
    renamed = written(tmp_path, {**DOCUMENT, "graph": {**DOCUMENT_GRAPH, "passwordEnv": "SOMEBODY_ELSES"}})
    assert refusal(["--config", renamed], {**ACCOUNT, **PASSWORD}) == (
        "graph.passwordEnv names SOMEBODY_ELSES, which is not set in the weaver's environment"
    )
    assert boot(["--config", renamed], {**ACCOUNT, "SOMEBODY_ELSES": "n30"}).config.port == 24102


DOCUMENT_GRAPH: Final[dict[str, JsonValue]] = {
    "type": "neo4j",
    "uri": "bolt://127.0.0.1:1",
    "username": "neo4j",
    "passwordEnv": "NEO4J_PASSWORD",
    "database": "neo4j",
}


def test_a_refusal_is_one_line_on_stderr_and_status_1_and_nothing_on_stdout(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setattr(sys, "argv", ["semiont_weaver", "--config", written(tmp_path)])
    for name in (*ACCOUNT, *PASSWORD):
        monkeypatch.delenv(name, raising=False)

    assert main() == 1

    said = capsys.readouterr()
    assert said.out == ""
    assert said.err == "[fatal] SEMIONT_OIDC_CLIENT_ID is not set in the weaver's environment: a weaver signs in as a service account\n"
