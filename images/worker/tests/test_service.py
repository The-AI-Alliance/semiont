"""The service as a process: what it is started with, the order it refuses in, how its knowledge bases are worked at apart, and how it ends.

`docs/protocol/WORKER-SERVICE.md` § Configuration states each refusal, and
§ Knowledge bases what happens at each knowledge base the service serves. The
worker service's conformance suite holds a started process to their words.
Here is the order of the refusals, which says which is settled first, and
that a refusal is all the process writes; and, over two knowledge bases stood
in for (`gateways.py`), that what happens at one happens there alone: its
claims, its limits, its profile, its refusal and its trouble, and the waits
before it is started again, which the suite cannot wait out.
"""

import asyncio
import json
import logging
import os
import signal
import socket
import sys
import threading
import time
import urllib.request
from collections.abc import Callable
from pathlib import Path
from typing import Final, final

import pytest
from aio import pass_time, run, turns
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from gateways import KnowledgeBaseStoodIn, stand_in
from holding import LIMITS, Parties, answering, job
from pydantic import JsonValue
from semiont.errors import SignInError
from semiont.http import KeyCredential
from semiont.model import written
from semiont.timing import MAX_RECONNECT_MS, RECONNECT_MS
from semiont.transport import Frame
from semiont.types import WorkerHealth, WorkerKnowledgeBaseConfig
from semiont_inference.interface import ElementSchema, InferenceClient, InferenceLimits, InferenceResponse, StructuredResponse
from semiont_service.config import Refused

from semiont_worker import agent
from semiont_worker.knowledge_base import NO_KNOWLEDGE_BASE_ADMITS, KnowledgeBases, Served
from semiont_worker.log import LOG
from semiont_worker.service import boot, main

KEY: Final = rsa.generate_private_key(public_exponent=65537, key_size=2048)
PEM: Final = KEY.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()).decode()
ACCOUNT: Final = {"SEMIONT_OIDC_CLIENT_KEY": PEM}

GEMMA: Final[dict[str, JsonValue]] = {
    "engine": {"provider": "ollama", "model": "gemma2:27b"},
    "jobs": [{"jobType": "mark", "params": {"motivation": "highlighting"}}],
    "baseUrl": "http://127.0.0.1:1",
}

DOCUMENT: Final[dict[str, JsonValue]] = {
    "knowledgeBases": [
        {
            "domain": "a.example",
            "gatewayUrl": "http://127.0.0.1:1",
            "identity": {"issuer": "http://127.0.0.1:1/realms/semiont", "clientId": "semiont-worker"},
            "engines": [
                {
                    "engine": {"provider": "anthropic", "model": "claude-test"},
                    "jobs": [{"jobType": "yield"}],
                    "baseUrl": "http://127.0.0.1:1",
                    "apiKeyEnv": "FIRST_KEY",
                },
                GEMMA,
            ],
        },
        {
            "domain": "b.example",
            "gatewayUrl": "http://127.0.0.1:2",
            "identity": {"issuer": "http://127.0.0.1:2/oauth", "clientId": "worker-of-a-participant"},
            "engines": [
                {
                    "engine": {"provider": "anthropic", "model": "claude-other"},
                    "jobs": [{"jobType": "mark", "params": {"motivation": "linking"}}],
                    "baseUrl": "http://127.0.0.1:1",
                    "apiKeyEnv": "SECOND_KEY",
                },
                # The same engine as the first knowledge base's second, used there for other jobs.
                {**GEMMA, "jobs": [{"jobType": "mark", "params": {"motivation": "commenting"}}]},
                # The same model, reached elsewhere: another engine.
                {**GEMMA, "baseUrl": "http://127.0.0.1:3"},
            ],
        },
    ],
    "modelCatalogue": "/usr/share/semiont/model-catalogue.json",
    "port": 24100,
    "logLevel": "warn",
    "logFormat": "simple",
}

KEYS: Final = {"FIRST_KEY": "sk-first", "SECOND_KEY": "sk-second"}


def document_file(tmp_path: Path, document: object = DOCUMENT) -> str:
    path = tmp_path / "worker.json"
    path.write_text(json.dumps(document), encoding="utf-8")
    return str(path)


def refusal(arguments: list[str], environment: dict[str, str]) -> str:
    with pytest.raises(Refused) as refused:
        boot(arguments, environment)
    return str(refused.value)


CATALOGUE: Final[dict[str, JsonValue]] = {
    "package": "@opencode-ai/models",
    "version": "0.0.0",
    "generatedAt": "2026-10-09T00:00:00.000Z",
    "license": "MIT",
    "providers": {
        "google": {"models": {}},
        "openai": {
            "models": {
                "gpt-listed": {
                    "limit": {"context": 8192, "input": None, "output": 4096},
                    "reasoning": False,
                    "reasoning_options": None,
                    "status": None,
                    "structured_output": True,
                    "temperature": True,
                }
            }
        },
        "togetherai": {"models": {}},
    },
}
"""A model catalogue file with one model in it, OpenAI's `gpt-listed`."""


def of_one_engine(provider: str, model: str, **stated: JsonValue) -> dict[str, JsonValue]:
    """The document, of one knowledge base with one engine of this provider and model, and over that whatever a test states of it."""
    engine: dict[str, JsonValue] = {
        "engine": {"provider": provider, "model": model},
        "jobs": [{"jobType": "yield"}],
        "baseUrl": "http://127.0.0.1:1/v1",
    }
    knowledge_bases = DOCUMENT["knowledgeBases"]
    assert isinstance(knowledge_bases, list)
    first = knowledge_bases[0]
    assert isinstance(first, dict)
    return {**DOCUMENT, "knowledgeBases": [{**first, "engines": [engine]}], **stated}


# ── what it is started with ─────────────────────────────────────────────


@pytest.mark.usefixtures("unconfigured")
def test_a_provider_that_takes_a_key_is_refused_by_the_member_where_its_engine_names_no_variable_for_one(tmp_path: Path) -> None:
    said = refusal(["--config", document_file(tmp_path, of_one_engine("anthropic", "claude-test"))], dict(ACCOUNT))
    assert said == (
        "knowledgeBases[0].engines[0].apiKeyEnv is not stated, and knowledgeBases[0].engines[0].engine.provider is anthropic: "
        "api_key is required for the Anthropic inference client"
    )


@pytest.mark.usefixtures("unconfigured")
def test_a_server_a_deployment_runs_boots_with_no_key_and_its_catalogue_is_not_read(tmp_path: Path) -> None:
    # The document names a catalogue file that is not there, as every document here does: nothing reads it.
    for provider in ("vllm", "llamacpp"):
        started = boot(["--config", document_file(tmp_path, of_one_engine(provider, "a-model"))], dict(ACCOUNT))
        (served,) = started.knowledge_bases
        assert [(client.provider, client.model_id) for client in served.clients] == [(provider, "a-model")]


@pytest.mark.usefixtures("unconfigured")
def test_a_provider_whose_facts_are_a_catalogue_s_boots_with_them_and_is_refused_by_the_member_without(tmp_path: Path) -> None:
    catalogue = tmp_path / "model-catalogue.json"
    catalogue.write_text(json.dumps(CATALOGUE), encoding="utf-8")
    keyed = {**ACCOUNT, "OPENAI_KEY": "sk-test"}

    def stating(model: str, **stated: JsonValue) -> str:
        document = of_one_engine("openai", model, **stated)
        knowledge_bases = document["knowledgeBases"]
        assert isinstance(knowledge_bases, list)
        (knowledge_base,) = knowledge_bases
        assert isinstance(knowledge_base, dict)
        engines = knowledge_base["engines"]
        assert isinstance(engines, list)
        (engine,) = engines
        assert isinstance(engine, dict)
        engine["apiKeyEnv"] = "OPENAI_KEY"
        return document_file(tmp_path, document)

    unlisted = refusal(["--config", stating("gpt-unlisted", modelCatalogue=str(catalogue))], keyed)
    assert unlisted.startswith(f"modelCatalogue names {catalogue}, which does not serve knowledgeBases[0].engines[0]: ")
    assert unlisted.endswith("states nothing of the model gpt-unlisted of the provider openai")
    nowhere = tmp_path / "none.json"
    absent = refusal(["--config", stating("gpt-listed", modelCatalogue=str(nowhere))], keyed)
    assert absent.startswith(
        f"modelCatalogue names {nowhere}, which does not serve knowledgeBases[0].engines[0]: the model catalogue cannot be read: "
    )

    started = boot(["--config", stating("gpt-listed", modelCatalogue=str(catalogue))], keyed)
    (served,) = started.knowledge_bases
    assert [(client.provider, client.model_id) for client in served.clients] == [("openai", "gpt-listed")]


@pytest.mark.usefixtures("unconfigured")
def test_everything_it_is_started_with_is_read_at_boot_an_account_at_each_knowledge_base_and_a_client_of_each_distinct_engine(
    tmp_path: Path,
) -> None:
    started = boot(["--config", document_file(tmp_path)], {**ACCOUNT, **KEYS, "SEMIONT_OIDC_CLIENT_ID": "unread", "UNREAD": "x"})
    first, second = started.knowledge_bases
    # The account at each is the client its entry names at the issuer its entry names, proven by the one key.
    assert (first.credential.issuer, first.credential.client_id) == ("http://127.0.0.1:1/realms/semiont", "semiont-worker")
    assert (second.credential.issuer, second.credential.client_id) == ("http://127.0.0.1:2/oauth", "worker-of-a-participant")
    for served in started.knowledge_bases:
        assert served.credential.private_key.private_numbers() == KEY.private_numbers()
    # A client for each engine, in each entry's order.
    assert [(client.provider, client.model_id) for client in first.clients] == [("anthropic", "claude-test"), ("ollama", "gemma2:27b")]
    assert [(client.provider, client.model_id) for client in second.clients] == [
        ("anthropic", "claude-other"),
        ("ollama", "gemma2:27b"),
        ("ollama", "gemma2:27b"),
    ]
    # Two knowledge bases that name one engine share its client; the same model reached elsewhere is another engine.
    assert second.clients[1] is first.clients[1]
    assert second.clients[2] is not first.clients[1]
    assert started.config.port == 24100


@pytest.mark.usefixtures("unconfigured")
def test_the_document_is_refused_before_the_key_the_key_before_a_provider_s_and_those_in_the_order_of_their_engines(
    tmp_path: Path,
) -> None:
    path = document_file(tmp_path)
    # Nothing it needs is there: the first thing said is that no document is named.
    assert refusal([], {}) == "The worker's configuration document is not named: start it with --config <path>"
    # A document that is refused, with no key either: the document is said.
    broken = document_file(tmp_path / "..", {**DOCUMENT, "port": "24100"})
    assert refusal(["--config", broken], {}).startswith(f"{broken} is not a worker configuration document (WorkerConfig):")
    # A document that names one knowledge base twice, with no key either: it is the document's to say first.
    knowledge_bases = DOCUMENT["knowledgeBases"]
    assert isinstance(knowledge_bases, list)
    twice = document_file(tmp_path / "..", {**DOCUMENT, "knowledgeBases": [*knowledge_bases, knowledge_bases[0]]})
    assert refusal(["--config", twice], {}) == (
        "knowledgeBases[2].domain is the domain of knowledgeBases[0]: a worker serves a knowledge base once"
    )
    # The key, before any provider's key. A secret, or a client id, is no key.
    assert refusal(["--config", path], {}).startswith("SEMIONT_OIDC_CLIENT_KEY is not set")
    accounts = {"SEMIONT_OIDC_CLIENT_ID": "semiont-worker", "SEMIONT_OIDC_CLIENT_SECRET": "s3cret"}
    assert refusal(["--config", path], accounts).startswith("SEMIONT_OIDC_CLIENT_KEY is not set")
    # The providers' keys, the first knowledge base's first engine's first.
    assert refusal(["--config", path], ACCOUNT).startswith("knowledgeBases[0].engines[0].apiKeyEnv names a variable")
    assert refusal(["--config", path], {**ACCOUNT, "FIRST_KEY": "sk-first"}).startswith(
        "knowledgeBases[1].engines[0].apiKeyEnv names a variable"
    )
    assert boot(["--config", path], {**ACCOUNT, **KEYS}).config.log_level == "warn"


@pytest.mark.usefixtures("unconfigured")
def test_from_boot_on_the_log_is_written_as_the_document_says(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    boot(["--config", document_file(tmp_path)], {**ACCOUNT, **KEYS})
    LOG.info("not written: the document says warnings and errors")
    LOG.warning("written")
    captured = capsys.readouterr()
    assert captured.err == ""
    (line,) = captured.out.splitlines()
    assert line.endswith(" [WARN] [worker] written")


@pytest.mark.usefixtures("unconfigured")
@pytest.mark.parametrize(
    ("arguments", "environment", "said"),
    [
        ([], ACCOUNT, "[fatal] The worker's configuration document is not named: start it with --config <path>\n"),
        (["--config"], ACCOUNT, "[fatal] The worker's configuration document is not named: start it with --config <path>\n"),
        (
            ["--config", "<document>"],
            {"SEMIONT_OIDC_CLIENT_ID": "semiont-worker"},
            "[fatal] SEMIONT_OIDC_CLIENT_KEY is not set in the worker's environment: a worker signs in as a service account\n",
        ),
        (
            ["--config", "<document>"],
            ACCOUNT,
            "[fatal] knowledgeBases[0].engines[0].apiKeyEnv names a variable that is not set in the worker's environment\n",
        ),
        (
            ["--config", "<twice>"],
            ACCOUNT,
            "[fatal] knowledgeBases[2].domain is the domain of knowledgeBases[0]: a worker serves a knowledge base once\n",
        ),
    ],
)
def test_a_service_that_does_not_start_says_why_once_on_stderr_and_exits_with_status_1(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
    arguments: list[str],
    environment: dict[str, str],
    said: str,
) -> None:
    document = document_file(tmp_path)
    knowledge_bases = DOCUMENT["knowledgeBases"]
    assert isinstance(knowledge_bases, list)
    twice = document_file(tmp_path / "..", {**DOCUMENT, "knowledgeBases": [*knowledge_bases, knowledge_bases[0]]})
    named = {"<document>": document, "<twice>": twice}
    monkeypatch.setattr(sys, "argv", ["semiont_worker", *(named.get(argument, argument) for argument in arguments)])
    monkeypatch.setattr(os, "environ", environment)
    assert main() == 1
    captured = capsys.readouterr()
    assert captured.err == said
    assert captured.out == ""
    assert PEM not in captured.err
    assert "example" not in captured.err


@pytest.mark.usefixtures("unconfigured")
def test_a_document_the_schema_refuses_is_said_with_each_reason_on_a_line_of_its_own(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    lacking = {name: value for name, value in DOCUMENT.items() if name not in ("port", "knowledgeBases")}
    document = document_file(tmp_path, lacking)
    monkeypatch.setattr(sys, "argv", ["semiont_worker", f"--config={document}"])
    monkeypatch.setattr(os, "environ", dict(ACCOUNT))
    assert main() == 1
    head, *reasons = capsys.readouterr().err.splitlines()
    assert head == f"[fatal] {document} is not a worker configuration document (WorkerConfig):"
    assert sorted(reasons) == ["  Missing required property: knowledgeBases", "  Missing required property: port"]


# ── the knowledge bases, each apart ─────────────────────────────────────

A_GATEWAY: Final = "http://a.test"
B_GATEWAY: Final = "http://b.test"
A_DID: Final = "did:web:a.example:agents:worker-at-a"
B_DID: Final = "did:web:b.example:agents:worker-at-b"


@final
class OfModel:
    """A client of one model that is asked nothing but its limits."""

    def __init__(self, model: str) -> None:
        self.provider: Final = "ollama"
        self.model_id: Final = model
        self.max_concurrency: Final = 1
        self.verify_detection_yield: Final = False

    async def limits(self) -> InferenceLimits:
        return LIMITS

    async def generate_text(self, prompt: str, max_tokens: int, temperature: float) -> InferenceResponse:
        raise AssertionError("a model asked for its limits alone is asked for nothing else")

    async def generate_structured(
        self, prompt: str, max_tokens: int, temperature: float, element_schema: ElementSchema
    ) -> StructuredResponse:
        raise AssertionError("a model asked for its limits alone is asked for nothing else")


def served_at(domain: str, gateway: str, client_id: str, *engines: tuple[str, InferenceClient]) -> Served:
    """A knowledge base as the service is started for it, offered an engine for each motivation of `engines`, each with its client."""
    entry = WorkerKnowledgeBaseConfig.model_validate(
        {
            "domain": domain,
            "gatewayUrl": gateway,
            "identity": {"issuer": f"{gateway}/oauth", "clientId": client_id},
            "engines": [
                {
                    "engine": {"provider": client.provider, "model": client.model_id},
                    "jobs": [{"jobType": "mark", "params": {"motivation": motivation}}],
                    "baseUrl": "http://127.0.0.1:1",
                }
                for motivation, client in engines
            ],
        }
    )
    credential = KeyCredential(issuer=entry.identity.issuer, client_id=client_id, private_key=KEY)
    return Served(entry=entry, credential=credential, clients=tuple(client for _, client in engines))


def a_and_b() -> list[Served]:
    """Two knowledge bases, each offered one engine for highlighting, which answers one highlight."""
    return [
        served_at("a.example", A_GATEWAY, "worker-at-a", ("highlighting", answering('[{"exact": "the first program"}]'))),
        served_at("b.example", B_GATEWAY, "worker-at-b", ("highlighting", answering('[{"exact": "the first program"}]'))),
    ]


type Life = Callable[[Parties, int], None]


def holding_nothing(parties: Parties, life: int) -> None:
    """A knowledge base that is what its entry says, and has no job to hand out."""


def with_a_job(job_id: str) -> Life:
    """A knowledge base that is what its entry says, whose first stream has one highlighting job to hand out, about its one resource."""

    def scripted(parties: Parties, life: int) -> None:
        parties.text_resource()
        if life == 0:
            parties.queue.append(job(job_id, "mark", {"motivation": "highlighting"}))

    return scripted


def answering_as(domain: str | None) -> Life:
    """A knowledge base that answers which it is with `domain`, or with `browse:kb-failed` where it is `None`."""

    def scripted(parties: Parties, life: int) -> None:
        parties.domain = domain

    return scripted


async def settled() -> None:
    """Give the loop turns enough for a knowledge base to be confirmed, or for its work to end and its next life to begin."""
    for _ in range(10):
        await turns()


def records(caplog: pytest.LogCaptureFixture, message: str) -> list[logging.LogRecord]:
    return [record for record in caplog.records if record.name == "semiont_worker" and record.getMessage() == message]


def said_of(caplog: pytest.LogCaptureFixture, message: str, *facts: str) -> list[tuple[str | int, ...]]:
    """The level, and each of `facts`, of every line the service logged with `message`, in order."""
    return [(record.levelname, *(vars(record)[fact] for fact in facts)) for record in records(caplog, message)]


CONFIRMED: Final = "Knowledge base confirmed"
REFUSED: Final = "Knowledge base refused the worker"
TROUBLE: Final = "Knowledge base in trouble \N{EM DASH} starting it again"


def states(knowledge_bases: KnowledgeBases) -> list[list[str]]:
    """Each knowledge base's domain and state, as the health endpoint says them."""
    return [[each.domain, each.state] for each in knowledge_bases.health().knowledge_bases]


def completed(parties: Parties) -> list[JsonValue]:
    return [completion["jobId"] for completion in parties.sent("job:complete")]


def test_each_knowledge_base_s_engines_claim_and_settle_on_its_own_stream_as_the_agent_it_is_there_named_by_its_client_id(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    a = KnowledgeBaseStoodIn(A_GATEWAY, "a.example", A_DID, each_life=with_a_job("job-a"))
    b = KnowledgeBaseStoodIn(B_GATEWAY, "b.example", B_DID, each_life=with_a_job("job-b"))
    stand_in(monkeypatch, a, b)
    caplog.set_level(logging.INFO, logger="semiont_worker")

    async def scenario() -> None:
        knowledge_bases = KnowledgeBases(a_and_b())
        stop = asyncio.Event()
        working = asyncio.ensure_future(knowledge_bases.work(stop))
        await settled()
        for at, job_id, did, name in ((a, "job-a", A_DID, "worker-at-a"), (b, "job-b", B_DID, "worker-at-b")):
            parties = at.parties
            # Each job is claimed and settled on its own knowledge base's stream, and what it made names the agent by its DID there.
            assert completed(parties) == [job_id]
            ((_, annotations),) = parties.commits
            assert [annotation["generator"] for annotation in annotations if isinstance(annotation, dict)] == [
                {"@type": "Software", "@id": did, "provider": "ollama", "model": "mock-model"}
            ]
            # Asked which it is, then told what the agent is called there, before anything is claimed.
            assert [frame.channel for frame in parties.frames()][:3] == ["browse:kb-requested", "principal:profile", "job:claim"]
            assert parties.sent("principal:profile") == [{"name": name}]
            assert at.sign_ins == 1
        assert said_of(caplog, CONFIRMED, "domain", "did") == [("INFO", "a.example", A_DID), ("INFO", "b.example", B_DID)]
        stop.set()
        assert await asyncio.wait_for(working, 5) == 0

    run(scenario())


def test_each_knowledge_base_s_limits_are_answered_on_its_own_stream_with_its_own_engines(monkeypatch: pytest.MonkeyPatch) -> None:
    a = KnowledgeBaseStoodIn(A_GATEWAY, "a.example", A_DID, each_life=holding_nothing)
    b = KnowledgeBaseStoodIn(B_GATEWAY, "b.example", B_DID, each_life=holding_nothing)
    stand_in(monkeypatch, a, b)

    async def scenario() -> None:
        knowledge_bases = KnowledgeBases(
            [
                served_at("a.example", A_GATEWAY, "worker-at-a", ("highlighting", OfModel("model-a1")), ("linking", OfModel("model-a2"))),
                served_at("b.example", B_GATEWAY, "worker-at-b", ("highlighting", OfModel("model-b"))),
            ]
        )
        stop = asyncio.Event()
        working = asyncio.ensure_future(knowledge_bases.work(stop))
        await settled()
        for at, correlation_id in ((a, "limits-of-a"), (b, "limits-of-b")):
            at.parties.transport.deliver(Frame(channel="job:limits-requested", payload={}, correlation_id=correlation_id))
        for _ in range(5):
            await turns()
        for at, correlation_id, models in ((a, "limits-of-a", ["model-a1", "model-a2"]), (b, "limits-of-b", ["model-b"])):
            (answer,) = [frame for frame in at.parties.frames() if frame.channel == "job:limits-result"]
            assert answer.correlation_id == correlation_id
            response = answer.payload["response"]
            assert isinstance(response, dict)
            limits = response["limits"]
            assert isinstance(limits, list)
            assert [each["engine"] for each in limits if isinstance(each, dict)] == [
                {"provider": "ollama", "model": model} for model in models
            ]
        stop.set()
        assert await asyncio.wait_for(working, 5) == 0

    run(scenario())


def test_health_says_each_knowledge_base_in_the_document_s_order_its_did_and_engines_while_it_works_and_answers_once_one_is_confirmed(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    a = KnowledgeBaseStoodIn(A_GATEWAY, "a.example", A_DID, each_life=holding_nothing)
    b = KnowledgeBaseStoodIn(B_GATEWAY, "b.example", B_DID, each_life=holding_nothing)
    # The first knowledge base's issuer does not answer, twice.
    a.refusing.extend([SignInError("exchange", "Client-credentials grant got no answer")] * 2)
    b.refusing.append(SignInError("exchange", "Client-credentials grant got no answer"))
    stand_in(monkeypatch, a, b)

    async def scenario() -> None:
        knowledge_bases = KnowledgeBases(a_and_b())
        stop = asyncio.Event()
        working = asyncio.ensure_future(knowledge_bases.work(stop))
        confirmed = asyncio.ensure_future(knowledge_bases.confirmed())
        await turns()
        # Until one is confirmed, none is working, and the health endpoint does not answer.
        assert written(knowledge_bases.health()) == {
            "status": "ok",
            "knowledgeBases": [{"domain": "a.example", "state": "starting"}, {"domain": "b.example", "state": "starting"}],
        }
        assert not confirmed.done()
        await pass_time(RECONNECT_MS / 1000 + 1, step=1)
        await settled()
        assert confirmed.done()
        assert states(knowledge_bases) == [["a.example", "starting"], ["b.example", "working"]]
        await pass_time(2 * RECONNECT_MS / 1000, step=1)
        await settled()
        # Each engine says what a worker says of itself (WORKER-CONTRACT V1): it has been handed nothing.
        engine: dict[str, JsonValue] = {
            "engine": {"provider": "ollama", "model": "mock-model"},
            "jobs": [{"jobType": "mark", "params": {"motivation": "highlighting"}}],
            "lastQueuedEventAt": None,
            "lastClaimAt": None,
            "lastFinishedAt": None,
            "lastActivityAt": None,
            "activeJob": None,
            "jobsCompleted": 0,
        }
        assert written(knowledge_bases.health()) == {
            "status": "ok",
            "knowledgeBases": [
                {"domain": "a.example", "state": "working", "did": A_DID, "engines": [engine]},
                {"domain": "b.example", "state": "working", "did": B_DID, "engines": [engine]},
            ],
        }
        stop.set()
        assert await asyncio.wait_for(working, 5) == 0

    run(scenario())


@pytest.mark.parametrize(
    "refusing",
    ["another domain", "browse:kb-failed", "a refused grant"],
)
def test_a_knowledge_base_that_refuses_the_worker_is_said_once_and_left_refused_while_the_other_keeps_working(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture, refusing: str
) -> None:
    a = KnowledgeBaseStoodIn(
        A_GATEWAY,
        "a.example",
        A_DID,
        each_life={"another domain": answering_as("elsewhere.example"), "browse:kb-failed": answering_as(None)}.get(
            refusing, holding_nothing
        ),
    )
    if refusing == "a refused grant":
        a.refusing.append(SignInError("exchange", "Client-credentials grant for worker-at-a failed (HTTP 401)", status=401))
    b = KnowledgeBaseStoodIn(B_GATEWAY, "b.example", B_DID, each_life=with_a_job("job-b"))
    stand_in(monkeypatch, a, b)
    caplog.set_level(logging.INFO, logger="semiont_worker")

    async def scenario() -> None:
        knowledge_bases = KnowledgeBases(a_and_b())
        stop = asyncio.Event()
        working = asyncio.ensure_future(knowledge_bases.work(stop))
        await settled()
        assert states(knowledge_bases) == [["a.example", "refused"], ["b.example", "working"]]
        assert completed(b.parties) == ["job-b"]
        # Asked which it is, the knowledge base that answered otherwise is told nothing more, no name and no claim; its stream is closed.
        for parties in a.lives:
            assert [frame.channel for frame in parties.frames()] == ["browse:kb-requested"]
            assert parties.transport.state.value == "closed"
        # It stays refused: the service does not sign in there again.
        await pass_time(MAX_RECONNECT_MS * 3 / 1000, step=5)
        assert a.sign_ins == 1
        assert b.sign_ins == 1
        assert not working.done()
        stop.set()
        assert await asyncio.wait_for(working, 5) == 0

    run(scenario())
    ((level, domain, reason),) = said_of(caplog, REFUSED, "domain", "reason")
    assert (level, domain) == ("ERROR", "a.example")
    assert isinstance(reason, str)
    assert reason.startswith(
        {
            "another domain": "it answered browse:kb-requested as elsewhere.example",
            "browse:kb-failed": "it answered browse:kb-requested with browse:kb-failed",
            "a refused grant": "Client-credentials grant for worker-at-a failed (HTTP 401)",
        }[refusing]
    )
    assert said_of(caplog, TROUBLE) == []
    assert said_of(caplog, CONFIRMED, "domain") == [("INFO", "b.example")]


def test_a_claim_refused_as_unauthorized_refuses_that_knowledge_base_alone(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    def unauthorized(parties: Parties, life: int) -> None:
        parties.claim_refused = {"code": "unauthorized", "message": "This agent is not a worker"}

    a = KnowledgeBaseStoodIn(A_GATEWAY, "a.example", A_DID, each_life=unauthorized)
    b = KnowledgeBaseStoodIn(B_GATEWAY, "b.example", B_DID, each_life=with_a_job("job-b"))
    stand_in(monkeypatch, a, b)
    caplog.set_level(logging.INFO, logger="semiont_worker")

    async def scenario() -> None:
        knowledge_bases = KnowledgeBases(a_and_b())
        stop = asyncio.Event()
        working = asyncio.ensure_future(knowledge_bases.work(stop))
        await settled()
        assert states(knowledge_bases) == [["a.example", "refused"], ["b.example", "working"]]
        assert completed(b.parties) == ["job-b"]
        await pass_time(MAX_RECONNECT_MS * 3 / 1000, step=5)
        # No later claim there changes a grant that is gone: it claimed once, signed in once, and its stream is closed.
        assert (a.sign_ins, a.parties.claims) == (1, 1)
        assert a.parties.transport.state.value == "closed"
        stop.set()
        assert await asyncio.wait_for(working, 5) == 0

    run(scenario())
    assert said_of(caplog, REFUSED, "domain", "reason") == [
        ("ERROR", "a.example", "a claim there was refused as unauthorized: this worker's grant there is gone")
    ]


def test_one_knowledge_base_s_stream_ending_starts_that_one_again_alone_after_the_sdk_s_wait(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    a = KnowledgeBaseStoodIn(A_GATEWAY, "a.example", A_DID, each_life=holding_nothing)
    b = KnowledgeBaseStoodIn(B_GATEWAY, "b.example", B_DID, each_life=holding_nothing)
    stand_in(monkeypatch, a, b)
    caplog.set_level(logging.INFO, logger="semiont_worker")

    async def scenario() -> None:
        knowledge_bases = KnowledgeBases(a_and_b())
        stop = asyncio.Event()
        working = asyncio.ensure_future(knowledge_bases.work(stop))
        await settled()
        for _ in range(2):
            # The first knowledge base's stream ends.
            await a.parties.transport.close()
            await settled()
            assert states(knowledge_bases) == [["a.example", "starting"], ["b.example", "working"]]
            lives = len(a.lives)
            await pass_time(RECONNECT_MS / 1000 - 1, step=1)
            assert len(a.lives) == lives
            await pass_time(2, step=1)
            await settled()
            # Started again, signed in afresh, and confirmed again: its next trouble waits as long as its first.
            assert len(a.lives) == lives + 1
            assert states(knowledge_bases) == [["a.example", "working"], ["b.example", "working"]]
            assert a.parties.sent("principal:profile") == [{"name": "worker-at-a"}]
        # The other kept its one sign-in and its one stream throughout.
        assert (b.sign_ins, len(b.lives)) == (1, 1)
        assert b.parties.transport.state.value == "open"
        stop.set()
        assert await asyncio.wait_for(working, 5) == 0

    run(scenario())
    assert a.sign_ins == 3
    ended = "the stream there ended: nothing more can be claimed"
    assert said_of(caplog, TROUBLE, "domain", "error", "waitMs") == [
        ("WARNING", "a.example", ended, RECONNECT_MS),
        ("WARNING", "a.example", ended, RECONNECT_MS),
    ]
    assert [domain for _, domain in said_of(caplog, CONFIRMED, "domain")] == ["a.example", "b.example", "a.example", "a.example"]


def test_each_further_start_of_a_knowledge_base_in_trouble_waits_twice_the_one_before_up_to_the_sdk_s_ceiling(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    a = KnowledgeBaseStoodIn(A_GATEWAY, "a.example", A_DID, each_life=holding_nothing)
    b = KnowledgeBaseStoodIn(B_GATEWAY, "b.example", B_DID, each_life=holding_nothing)
    # Its issuer does not answer six times in a row, and then does.
    a.refusing.extend([SignInError("exchange", "Client-credentials grant got no answer")] * 6)
    stand_in(monkeypatch, a, b)
    caplog.set_level(logging.INFO, logger="semiont_worker")
    waits = [5000, 10000, 20000, 40000, 60000, 60000]
    assert (waits[0], waits[-1]) == (RECONNECT_MS, MAX_RECONNECT_MS)

    async def scenario() -> None:
        knowledge_bases = KnowledgeBases(a_and_b())
        stop = asyncio.Event()
        working = asyncio.ensure_future(knowledge_bases.work(stop))
        await turns()
        for nth, wait_ms in enumerate(waits, start=1):
            assert a.sign_ins == nth
            await pass_time(wait_ms / 1000 - 1, step=1)
            assert a.sign_ins == nth
            await pass_time(1, step=1)
        assert a.sign_ins == len(waits) + 1
        assert states(knowledge_bases) == [["a.example", "working"], ["b.example", "working"]]
        assert b.sign_ins == 1
        stop.set()
        assert await asyncio.wait_for(working, 5) == 0

    run(scenario())
    assert [wait for _, wait in said_of(caplog, TROUBLE, "waitMs")] == waits
    assert {error for _, error in said_of(caplog, TROUBLE, "error")} == {"Client-credentials grant got no answer"}


def test_a_held_job_that_stalls_starts_its_knowledge_base_again_failing_the_job_first_and_the_other_keeps_working(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    a = KnowledgeBaseStoodIn(A_GATEWAY, "a.example", A_DID, each_life=with_a_job("job-a"))
    b = KnowledgeBaseStoodIn(B_GATEWAY, "b.example", B_DID, each_life=holding_nothing)
    stand_in(monkeypatch, a, b)
    caplog.set_level(logging.INFO, logger="semiont_worker")
    wedged = asyncio.Event()

    async def run_job(*_: object, **__: object) -> None:
        # A job that is begun and never shows activity again.
        await wedged.wait()

    monkeypatch.setattr(agent, "run_job", run_job)

    async def scenario() -> None:
        knowledge_bases = KnowledgeBases(a_and_b())
        stop = asyncio.Event()
        working = asyncio.ensure_future(knowledge_bases.work(stop))
        await settled()
        first = a.parties
        await pass_time(1020, step=60)
        await settled()
        # The job was failed while its stream carried messages; then the knowledge base was started again.
        assert [failed["jobId"] for failed in first.sent("job:fail")] == ["job-a"]
        assert first.transport.state.value == "closed"
        await pass_time(RECONNECT_MS / 1000, step=1)
        await settled()
        assert len(a.lives) == 2
        assert states(knowledge_bases) == [["a.example", "working"], ["b.example", "working"]]
        assert (b.sign_ins, len(b.lives)) == (1, 1)
        stop.set()
        assert await asyncio.wait_for(working, 5) == 0

    run(scenario())
    ((level, domain, error, wait_ms),) = said_of(caplog, TROUBLE, "domain", "error", "waitMs")
    assert (level, domain, wait_ms) == ("WARNING", "a.example", RECONNECT_MS)
    assert isinstance(error, str)
    assert error.startswith("the job job-a (mark), held since ")


def test_told_to_stop_every_knowledge_base_fails_the_job_it_holds_first_claims_no_other_and_the_status_is_0(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    a = KnowledgeBaseStoodIn(A_GATEWAY, "a.example", A_DID, each_life=with_a_job("job-a"))
    b = KnowledgeBaseStoodIn(B_GATEWAY, "b.example", B_DID, each_life=with_a_job("job-b"))
    # A third, in trouble, waits to start again when the service is told to stop.
    c = KnowledgeBaseStoodIn("http://c.test", "c.example", "did:web:c.example:agents:worker-at-c", each_life=holding_nothing)
    c.refusing.append(SignInError("exchange", "Client-credentials grant got no answer"))
    stand_in(monkeypatch, a, b, c)
    wedged = asyncio.Event()

    async def run_job(*_: object, **__: object) -> None:
        await wedged.wait()

    monkeypatch.setattr(agent, "run_job", run_job)

    async def scenario() -> None:
        knowledge_bases = KnowledgeBases(
            [*a_and_b(), served_at("c.example", "http://c.test", "worker-at-c", ("highlighting", answering("[]")))]
        )
        stop = asyncio.Event()
        working = asyncio.ensure_future(knowledge_bases.work(stop))
        await settled()
        stop.set()
        assert await asyncio.wait_for(working, 5) == 0
        for at, job_id in ((a, "job-a"), (b, "job-b")):
            assert [failed["jobId"] for failed in at.parties.sent("job:fail")] == [job_id]
            assert at.parties.claims == 1
        assert c.sign_ins == 1

    run(scenario())


def test_every_knowledge_base_refused_with_none_confirmed_first_is_a_refusal_to_start(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    a = KnowledgeBaseStoodIn(A_GATEWAY, "a.example", A_DID, each_life=answering_as("elsewhere.example"))
    b = KnowledgeBaseStoodIn(B_GATEWAY, "b.example", B_DID, each_life=answering_as(None))
    stand_in(monkeypatch, a, b)
    caplog.set_level(logging.INFO, logger="semiont_worker")

    async def scenario() -> None:
        with pytest.raises(Refused) as refused:
            await asyncio.wait_for(KnowledgeBases(a_and_b()).work(asyncio.Event()), 5)
        assert str(refused.value) == NO_KNOWLEDGE_BASE_ADMITS

    run(scenario())
    assert [domain for _, domain in said_of(caplog, REFUSED, "domain")] == ["a.example", "b.example"]


def test_every_knowledge_base_refused_after_one_was_confirmed_is_status_1(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    def unauthorized(parties: Parties, life: int) -> None:
        parties.claim_refused = {"code": "unauthorized", "message": "This agent is not a worker"}

    a = KnowledgeBaseStoodIn(A_GATEWAY, "a.example", A_DID, each_life=unauthorized)
    b = KnowledgeBaseStoodIn(B_GATEWAY, "b.example", B_DID, each_life=answering_as("elsewhere.example"))
    stand_in(monkeypatch, a, b)
    caplog.set_level(logging.INFO, logger="semiont_worker")

    async def scenario() -> None:
        assert await asyncio.wait_for(KnowledgeBases(a_and_b()).work(asyncio.Event()), 5) == 1

    run(scenario())
    assert sorted(domain for _, domain in said_of(caplog, REFUSED, "domain")) == ["a.example", "b.example"]


def free_port() -> int:
    """A port nothing listens on now."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.bind(("", 0))
        port: int = probe.getsockname()[1]
    return port


def started_document(tmp_path: Path, *gateways: str) -> str:
    """A document of a knowledge base at each of `gateways`, `http://<name>.test`, each offered one engine, logging every line as JSON.

    Each knowledge base's domain is `<name>.example`, and the agent's client there `worker-at-<name>`.
    """
    names = [gateway.removeprefix("http://").removesuffix(".test") for gateway in gateways]
    return document_file(
        tmp_path,
        {
            "knowledgeBases": [
                {
                    "domain": f"{name}.example",
                    "gatewayUrl": gateway,
                    "identity": {"issuer": f"{gateway}/oauth", "clientId": f"worker-at-{name}"},
                    "engines": [GEMMA],
                }
                for name, gateway in zip(names, gateways, strict=True)
            ],
            "modelCatalogue": "/usr/share/semiont/model-catalogue.json",
            "port": free_port(),
            "logLevel": "info",
            "logFormat": "json",
        },
    )


def answered_health(port: int, until: Callable[[WorkerHealth], bool]) -> str:
    """The body `GET /health` on `port` answers once it answers one that `until` holds of; then the process is told to stop.

    Asked from a thread of its own while the service runs in this one, again
    and again: refused until a knowledge base is confirmed, and then answered
    afresh each time. After twenty seconds the service is told to stop, and
    the test fails. A service that ended of itself is told nothing.
    """
    answered: list[str] = []
    ended = threading.Event()

    def ask() -> None:
        deadline = time.monotonic() + 20
        try:
            while time.monotonic() < deadline and not ended.is_set():
                try:
                    with urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=1) as response:
                        body = response.read().decode("utf-8")
                except OSError:
                    time.sleep(0.05)
                    continue
                if until(WorkerHealth.model_validate_json(body)):
                    answered.append(body)
                    return
                time.sleep(0.05)
        finally:
            if not ended.is_set():
                os.kill(os.getpid(), signal.SIGTERM)

    asking = threading.Thread(target=ask)
    asking.start()
    try:
        status = main()
    finally:
        ended.set()
        # The service's handler is gone with its loop: a signal sent as it ended stops nothing, and ends no test run.
        before = signal.signal(signal.SIGTERM, signal.SIG_IGN)
        asking.join()
        signal.signal(signal.SIGTERM, before)
    assert status == 0
    assert answered, "the health endpoint never answered what was waited for"
    return answered[0]


@pytest.mark.usefixtures("unconfigured")
def test_the_health_endpoint_answers_a_worker_health_with_each_knowledge_base_in_its_state_and_only_a_working_one_s_agent_and_engines(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    c_gateway = "http://c.test"
    in_trouble = KnowledgeBaseStoodIn(c_gateway, "c.example", "did:web:c.example:agents:worker-at-c", each_life=holding_nothing)
    in_trouble.refusing.extend([SignInError("exchange", "Client-credentials grant got no answer")] * 100)
    stand_in(
        monkeypatch,
        KnowledgeBaseStoodIn(A_GATEWAY, "a.example", A_DID, each_life=answering_as("elsewhere.example")),
        KnowledgeBaseStoodIn(B_GATEWAY, "b.example", B_DID, each_life=holding_nothing),
        in_trouble,
    )
    document = started_document(tmp_path, A_GATEWAY, B_GATEWAY, c_gateway)
    read: JsonValue = json.loads(Path(document).read_text(encoding="utf-8"))
    assert isinstance(read, dict)
    port = read["port"]
    assert isinstance(port, int)
    monkeypatch.setattr(sys, "argv", ["semiont_worker", "--config", document])
    monkeypatch.setattr(os, "environ", dict(ACCOUNT))
    every_state = [("a.example", "refused"), ("b.example", "working"), ("c.example", "starting")]
    body = answered_health(port, lambda health: [(each.domain, each.state) for each in health.knowledge_bases] == every_state)

    # The body is a `WorkerHealth`, and says it as the wire does: a knowledge base that is not working has no agent and
    # no engines, and an engine's instants and job are there when they are null.
    assert written(WorkerHealth.model_validate_json(body)) == json.loads(body)
    assert json.loads(body) == {
        "status": "ok",
        "knowledgeBases": [
            {"domain": "a.example", "state": "refused"},
            {
                "domain": "b.example",
                "state": "working",
                "did": B_DID,
                "engines": [
                    {
                        "engine": {"provider": "ollama", "model": "gemma2:27b"},
                        "jobs": [{"jobType": "mark", "params": {"motivation": "highlighting"}}],
                        "lastQueuedEventAt": None,
                        "lastClaimAt": None,
                        "lastFinishedAt": None,
                        "lastActivityAt": None,
                        "activeJob": None,
                        "jobsCompleted": 0,
                    }
                ],
            },
            {"domain": "c.example", "state": "starting"},
        ],
    }


def logged_lines(out: str) -> list[dict[str, JsonValue]]:
    lines: list[dict[str, JsonValue]] = []
    for line in out.splitlines():
        read: JsonValue = json.loads(line)
        assert isinstance(read, dict)
        lines.append(read)
    return lines


@pytest.mark.usefixtures("unconfigured")
def test_a_service_every_knowledge_base_of_which_refused_it_none_confirmed_says_so_on_stderr_after_each_refusal_in_its_log(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    stand_in(
        monkeypatch,
        KnowledgeBaseStoodIn(A_GATEWAY, "a.example", A_DID, each_life=answering_as("elsewhere.example")),
        KnowledgeBaseStoodIn(B_GATEWAY, "b.example", B_DID, each_life=answering_as(None)),
    )
    monkeypatch.setattr(sys, "argv", ["semiont_worker", "--config", started_document(tmp_path, A_GATEWAY, B_GATEWAY)])
    monkeypatch.setattr(os, "environ", dict(ACCOUNT))
    assert main() == 1
    captured = capsys.readouterr()
    assert captured.err == f"[fatal] {NO_KNOWLEDGE_BASE_ADMITS}\n"
    refusals = [line for line in logged_lines(captured.out) if line["message"] == REFUSED]
    assert sorted((line["level"], line["domain"]) for line in refusals) == [("error", "a.example"), ("error", "b.example")]
    assert PEM not in captured.out


@pytest.mark.usefixtures("unconfigured")
def test_a_service_every_knowledge_base_of_which_refused_it_one_confirmed_first_exits_1_saying_nothing_on_stderr(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    def unauthorized(parties: Parties, life: int) -> None:
        parties.claim_refused = {"code": "unauthorized", "message": "This agent is not a worker"}

    stand_in(
        monkeypatch,
        KnowledgeBaseStoodIn(A_GATEWAY, "a.example", A_DID, each_life=unauthorized),
        KnowledgeBaseStoodIn(B_GATEWAY, "b.example", B_DID, each_life=answering_as("elsewhere.example")),
    )
    monkeypatch.setattr(sys, "argv", ["semiont_worker", "--config", started_document(tmp_path, A_GATEWAY, B_GATEWAY)])
    monkeypatch.setattr(os, "environ", dict(ACCOUNT))
    assert main() == 1
    captured = capsys.readouterr()
    assert captured.err == ""
    said = logged_lines(captured.out)
    assert [(line["level"], line["domain"], line["did"]) for line in said if line["message"] == CONFIRMED] == [("info", "a.example", A_DID)]
    assert sorted((line["level"], line["domain"]) for line in said if line["message"] == REFUSED) == [
        ("error", "a.example"),
        ("error", "b.example"),
    ]
