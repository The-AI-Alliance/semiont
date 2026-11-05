"""The service as a process: what it is started with, the order it refuses in, and what it says when it does not start.

`protocol/contract/WEAVER.md` § Settings and § Boot state each refusal, and
the weaver conformance suite holds a started process to them. Here is their
order, which says which is settled first, that a refusal is all the process
writes, and what the suite does not reach: each word of a refusal, the stream
the Weaver asks its knowledge base on, and its being told to stop while it
asks.
"""

import json
import signal
import sys
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Final, Self, final

import pytest
from pydantic import JsonValue
from semiont.channels import PERSISTED_EVENT_TYPES
from semiont.http import SecretCredential, ServiceToken
from semiont.identifiers import UserId
from semiont.testing import FaultyTransport
from semiont.types import GraphConfig
from semiont.watched import Variable, Watched
from semiont_graph.memory import MemoryGraphDatabase
from semiont_service.config import Refused

from semiont_weaver import service
from semiont_weaver.service import CHANNELS, boot, main

pytestmark = pytest.mark.usefixtures("the_log_as_it_was")

ACCOUNT: Final = {"SEMIONT_OIDC_CLIENT_ID": "semiont-weaver", "SEMIONT_OIDC_CLIENT_SECRET": "s3cret"}
PASSWORD: Final = {"NEO4J_PASSWORD": "n30"}

DOCUMENT: Final[dict[str, JsonValue]] = {
    "kb": {"name": "example-kb", "domain": "example.github.io:example-kb"},
    "gatewayUrl": "http://127.0.0.1:1",
    "identity": {"issuer": "http://127.0.0.1:1/realms/semiont"},
    "graph": {"type": "neo4j", "uri": "bolt://127.0.0.1:1", "username": "neo4j", "passwordEnv": "NEO4J_PASSWORD", "database": "neo4j"},
    "archivist": {"host": "127.0.0.1", "port": 1},
    "cursorsPath": "/tmp/semiont/weaver-cursors.json",
    "port": 24102,
    "logLevel": "warn",
    "logFormat": "simple",
}


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
    assert started.credential == SecretCredential(
        issuer="http://127.0.0.1:1/realms/semiont", client_id="semiont-weaver", client_secret="s3cret"
    )
    # A store is made and not connected: nothing at that address was asked anything.
    assert not started.graph.is_connected()
    assert not isinstance(started.graph, MemoryGraphDatabase)


def test_its_stream_names_every_event_of_the_record_the_command_it_answers_and_the_replies_of_what_it_asks() -> None:
    # A follower of the record receives every event of a log it follows, so that a gap is always a miss.
    assert sorted(CHANNELS) == sorted([*PERSISTED_EVENT_TYPES, "weave:rebuild", "browse:resources-result", "browse:resources-failed"])
    assert "mark:added" in PERSISTED_EVENT_TYPES
    assert "job:completed" in PERSISTED_EVENT_TYPES


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
        **without("cursorsPath"),
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
            "  Missing required property: cursorsPath",
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


@final
class KnowledgeBaseStoodIn:
    """The knowledge base at the gateway as a test scripts it: the domain it says it is, or nothing while it is `away`.

    `done` is what the Weaver did there, in order: its sign-in, each stream it
    opened by the channels it named, each request it asked, each stream it
    closed, and its graph database reached. A Weaver that asks while the
    knowledge base is `away` is told to stop, as a supervisor tells it, the
    first time it asks.
    """

    def __init__(self, domain: str, *, away: bool = False) -> None:
        self.domain: Final = domain
        self.away: Final = away
        self.done: Final[list[str]] = []

    def refuse(self, operation: str, payload: Mapping[str, JsonValue]) -> Mapping[str, JsonValue] | None:
        self.done.append(f"asked {operation}")
        if not self.away:
            return None
        if self.done.count(f"asked {operation}") == 1:
            signal.raise_signal(signal.SIGTERM)
        return {"code": "peer-unavailable", "message": "nothing answers"}

    def answer(self, operation: str, payload: Mapping[str, JsonValue]) -> JsonValue:
        return {"name": "Whatever it is called", "domain": self.domain}


def started_at(monkeypatch: pytest.MonkeyPatch, tmp_path: Path, knowledge_base: KnowledgeBaseStoodIn) -> None:
    """Have `main` start a Weaver whose sign-in, streams and graph database are stood in for at `knowledge_base`.

    Its graph database refuses to be connected to: what is reached after it is
    not this file's.
    """
    done = knowledge_base.done

    @final
    class SignedIn:
        def __init__(self, gateway: str, *, service: ServiceToken) -> None:
            self.did: Final = UserId("did:web:example.github.io:example-kb:agents:semiont-weaver")
            self.token: Final[Watched[str | None]] = Variable[str | None]("issued")

        async def refresh(self) -> str | None:
            return None

        async def __aenter__(self) -> Self:
            done.append("signed in")
            return self

        async def __aexit__(self, *_: object) -> None:
            return None

    @final
    class Stream:
        def __init__(self, gateway: str, *, token: object, refresher: object, channels: Sequence[str]) -> None:
            self._channels: Final = channels
            self._transport: Final = FaultyTransport(make_response=knowledge_base.answer)
            self._transport.refuse_when(knowledge_base.refuse)

        async def __aenter__(self) -> FaultyTransport:
            done.append(f"opened {' '.join(self._channels)}")
            return self._transport

        async def __aexit__(self, *_: object) -> None:
            done.append("closed")
            await self._transport.close()

    @final
    class Graph:
        async def connect(self) -> None:
            done.append("reached the graph database")
            raise ConnectionRefusedError("nothing listens where the graph database is stood in for")

    graph = Graph()

    def made(config: GraphConfig, *, password: str | None) -> Graph:
        return graph

    monkeypatch.setattr(service, "AgentToken", SignedIn)
    monkeypatch.setattr(service, "HttpTransport", Stream)
    monkeypatch.setattr(service, "create_graph_database", made)
    monkeypatch.setattr(sys, "argv", ["semiont_weaver", "--config", written(tmp_path)])
    for name, value in {**ACCOUNT, **PASSWORD, "OTEL_SDK_DISABLED": "true"}.items():
        monkeypatch.setenv(name, value)


ASKED_ON: Final = "opened browse:kb-result browse:kb-failed"
"""The stream the Weaver asks its knowledge base on: the answer's replies, and not `weave:rebuild`, which it cannot answer yet."""


def test_it_asks_the_knowledge_base_which_it_is_on_a_stream_of_its_own_and_closes_it_before_it_reaches_its_graph(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    knowledge_base = KnowledgeBaseStoodIn("example.github.io:example-kb")
    started_at(monkeypatch, tmp_path, knowledge_base)

    assert main() == 1

    assert knowledge_base.done == ["signed in", ASKED_ON, "asked browse:kb-requested", "closed", "reached the graph database"]


def test_where_the_knowledge_base_says_it_is_another_it_refuses_naming_both_and_reaches_no_graph(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    knowledge_base = KnowledgeBaseStoodIn("example.github.io:other-kb")
    started_at(monkeypatch, tmp_path, knowledge_base)

    assert main() == 1

    assert knowledge_base.done == ["signed in", ASKED_ON, "asked browse:kb-requested", "closed"]
    assert capsys.readouterr().err == (
        "[fatal] The knowledge base at the gateway is did:web:example.github.io:other-kb, "
        "and the document names did:web:example.github.io:example-kb\n"
    )


def test_told_to_stop_while_it_asks_it_exits_0_having_reached_no_graph(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    knowledge_base = KnowledgeBaseStoodIn("example.github.io:example-kb", away=True)
    started_at(monkeypatch, tmp_path, knowledge_base)

    assert main() == 0

    assert knowledge_base.done == ["signed in", ASKED_ON, "asked browse:kb-requested", "closed"]
    assert capsys.readouterr().err == ""
