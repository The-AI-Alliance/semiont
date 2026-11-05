"""The service as a process: what it is started with, the order it refuses in, and what it says when it does not start.

`protocol/contract/LIBRARIAN.md` § Settings states each refusal, § What it
answers the channels its stream names, and § Health what its health endpoint
says. Here is the order of the refusals, which says which is settled first,
that a refusal is all the process writes, and each word of one. What the
document itself is refused for is in `test_config.py`. So is what the
librarian conformance suite does not reach of § Boot: the stream the
Librarian asks its knowledge base on, and its being told to stop while it
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
from semiont.http import SecretCredential, ServiceToken
from semiont.identifiers import UserId
from semiont.testing import FaultyTransport
from semiont.types import GraphConfig, VectorsConfig
from semiont.watched import Variable, Watched
from semiont_graph.neo4j import Neo4jGraphReader
from semiont_inference.ollama import OllamaInferenceClient
from semiont_service.config import Refused
from semiont_vectors.ollama import OllamaEmbeddingProvider
from semiont_vectors.qdrant import QdrantVectorReader
from semiont_vectors.voyage import VoyageEmbeddingProvider
from test_config import DOCUMENT, ENGINE, VOYAGE, written

from semiont_librarian import service
from semiont_librarian.service import CHANNELS, boot, health, main

pytestmark = pytest.mark.usefixtures("the_log_as_it_was")

ACCOUNT: Final = {"SEMIONT_OIDC_CLIENT_ID": "semiont-librarian", "SEMIONT_OIDC_CLIENT_SECRET": "s3cret"}
PASSWORD: Final = {"NEO4J_PASSWORD": "n30"}
TOKEN: Final = {"QDRANT_TOKEN": "a-token"}
STARTED: Final = {**ACCOUNT, **PASSWORD, **TOKEN}
"""Everything the environment holds for a Librarian whose document names no key: its account, the graph's password and the index's token."""

KEYED: Final[dict[str, JsonValue]] = {
    **DOCUMENT,
    "embedding": VOYAGE,
    "matcher": {**ENGINE, "apiKeyEnv": "MATCHER_KEY"},
    "gatherer": {**ENGINE, "apiKeyEnv": "GATHERER_KEY"},
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
    started = boot(["--config", written(tmp_path)], STARTED)
    assert started.config.gateway_url == "http://127.0.0.1:1"
    assert started.credential == SecretCredential(
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


def test_its_stream_names_the_eight_requests_it_answers_the_two_signals_it_follows_and_the_replies_of_what_it_asks() -> None:
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
            "browse:resource-result",
            "browse:resource-failed",
            "browse:annotation-result",
            "browse:annotation-failed",
            "browse:profiles-result",
            "browse:profiles-failed",
        ]
    )
    assert len(CHANNELS) == len(set(CHANNELS))


def test_its_health_says_it_is_up_names_the_knowledge_base_it_serves_and_names_its_two_actors() -> None:
    kb = "did:web:example.github.io:plain-kb"
    assert health(kb) == {"status": "ok", "kb": kb, "actors": ["matcher", "gatherer"]}
    assert json.dumps(health(kb)) == '{"status": "ok", "kb": "did:web:example.github.io:plain-kb", "actors": ["matcher", "gatherer"]}'


def test_the_document_is_named_by_a_flag_and_never_guessed(tmp_path: Path) -> None:
    said = "The librarian's configuration document is not named: start it with --config <path>"
    environment = STARTED
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
        "kb",
        "gatewayUrl",
        "identity",
        "archivist",
        "graph",
        "vectors",
        "embedding",
        "matcher",
        "gatherer",
        "modelCatalogue",
        "gather",
        "search",
        "port",
        "logLevel",
        "logFormat",
    ],
)
def test_nothing_the_document_leaves_out_is_supplied_and_each_is_refused_by_name(tmp_path: Path, missing: str) -> None:
    path = written(tmp_path, without(missing))
    said = refusal(["--config", path], STARTED)
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
    # Then the graph database's password, the embedding provider's key, the vector index's token, the Matcher's key and the Gatherer's.
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
        "vectors.tokenEnv names QDRANT_TOKEN, which is not set in the librarian's environment"
    )
    environment["QDRANT_TOKEN"] = "a-token"
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
    anthropic: dict[str, JsonValue] = {"engine": {"provider": "anthropic", "model": "a-model"}, "baseUrl": "http://127.0.0.1:1"}
    environment = STARTED

    keyless_matcher = written(tmp_path, {**DOCUMENT, "matcher": anthropic})
    assert refusal(["--config", keyless_matcher], environment) == (
        "matcher.apiKeyEnv is not stated, and matcher.engine.provider is anthropic: api_key is required for the Anthropic inference client"
    )
    keyless_gatherer = written(tmp_path, {**DOCUMENT, "gatherer": anthropic})
    assert refusal(["--config", keyless_gatherer], environment) == (
        "gatherer.apiKeyEnv is not stated, and gatherer.engine.provider is anthropic: "
        "api_key is required for the Anthropic inference client"
    )


def test_a_model_whose_facts_are_a_catalogue_s_is_refused_by_the_member_without_them_and_a_server_a_deployment_runs_reads_none(
    tmp_path: Path,
) -> None:
    environment = {**STARTED, "OPENAI_KEY": "sk-test"}
    openai: dict[str, JsonValue] = {
        "engine": {"provider": "openai", "model": "gpt-listed"},
        "baseUrl": "http://127.0.0.1:1/v1",
        "apiKeyEnv": "OPENAI_KEY",
    }
    nowhere = tmp_path / "none.json"
    absent = refusal(["--config", written(tmp_path, {**DOCUMENT, "gatherer": openai, "modelCatalogue": str(nowhere)})], environment)
    assert absent.startswith(f"modelCatalogue names {nowhere}, which does not serve the gatherer: the model catalogue cannot be read: ")

    # The document names a catalogue file that is not there, as every document here does: nothing reads it for these.
    vllm: dict[str, JsonValue] = {"engine": {"provider": "vllm", "model": "a-model"}, "baseUrl": "http://127.0.0.1:1/v1"}
    started = boot(["--config", written(tmp_path, {**DOCUMENT, "matcher": vllm, "gatherer": vllm})], environment)
    assert (started.matcher.provider, started.gatherer.provider) == ("vllm", "vllm")


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


@final
class KnowledgeBaseStoodIn:
    """The knowledge base at the gateway as a test scripts it: the domain it says it is, or nothing while it is `away`.

    `done` is what the Librarian did there, in order: its sign-in, each stream
    it opened by the channels it named, each request it asked, each stream it
    closed, and each store reached. A Librarian that asks while the knowledge
    base is `away` is told to stop, as a supervisor tells it, the first time it
    asks.
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
    """Have `main` start a Librarian whose sign-in, streams and stores are stood in for at `knowledge_base`.

    Its graph database is reached, and its vector index refuses to be: what is
    reached after it is not this file's.
    """
    done = knowledge_base.done

    @final
    class SignedIn:
        def __init__(self, gateway: str, *, service: ServiceToken) -> None:
            self.did: Final = UserId("did:web:example.github.io:example-kb:agents:semiont-librarian")
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

        async def disconnect(self) -> None:
            return None

    @final
    class Index:
        async def connect(self) -> None:
            done.append("reached the vector index")
            raise ConnectionRefusedError("nothing listens where the vector index is stood in for")

        async def disconnect(self) -> None:
            return None

    graph, index = Graph(), Index()

    def read_graph(config: GraphConfig, *, password: str | None) -> Graph:
        return graph

    def read_index(config: VectorsConfig, *, kb: UserId, token: str | None) -> Index:
        return index

    monkeypatch.setattr(service, "AgentToken", SignedIn)
    monkeypatch.setattr(service, "HttpTransport", Stream)
    monkeypatch.setattr(service, "create_graph_reader", read_graph)
    monkeypatch.setattr(service, "create_vector_reader", read_index)
    monkeypatch.setattr(sys, "argv", ["semiont_librarian", "--config", written(tmp_path)])
    for name, value in {**STARTED, "OTEL_SDK_DISABLED": "true"}.items():
        monkeypatch.setenv(name, value)


ASKED_ON: Final = "opened browse:kb-result browse:kb-failed"
"""The stream the Librarian asks its knowledge base on: the answer's replies, and none of the requests it cannot answer yet."""


def test_it_asks_the_knowledge_base_which_it_is_on_a_stream_of_its_own_and_closes_it_before_it_reaches_either_store(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    knowledge_base = KnowledgeBaseStoodIn("example.github.io:example-kb")
    started_at(monkeypatch, tmp_path, knowledge_base)

    assert main() == 1

    assert knowledge_base.done == [
        "signed in",
        ASKED_ON,
        "asked browse:kb-requested",
        "closed",
        "reached the graph database",
        "reached the vector index",
    ]


def test_where_the_knowledge_base_says_it_is_another_it_refuses_naming_both_and_reaches_neither_store(
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


def test_told_to_stop_while_it_asks_it_exits_0_having_reached_neither_store(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    knowledge_base = KnowledgeBaseStoodIn("example.github.io:example-kb", away=True)
    started_at(monkeypatch, tmp_path, knowledge_base)

    assert main() == 0

    assert knowledge_base.done == ["signed in", ASKED_ON, "asked browse:kb-requested", "closed"]
    assert capsys.readouterr().err == ""
