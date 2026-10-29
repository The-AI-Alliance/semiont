"""The service as a process: what it is started with, the order it refuses in, and what it says when it does not start.

`docs/protocol/WORKER-SERVICE.md` § Configuration states each refusal, and
the worker service's conformance suite holds a started process to their
words, one refusal at a time. Here is their order, which says which is
settled first, and that a refusal is all the process writes.
"""

import json
import os
import sys
from pathlib import Path
from typing import Final

import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from pydantic import JsonValue
from semiont_service.config import Refused

from semiont_worker.log import LOG
from semiont_worker.service import boot, main

KEY: Final = rsa.generate_private_key(public_exponent=65537, key_size=2048)
PEM: Final = KEY.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()).decode()
ACCOUNT: Final = {"SEMIONT_OIDC_CLIENT_ID": "semiont-worker", "SEMIONT_OIDC_CLIENT_KEY": PEM}

DOCUMENT: Final[dict[str, JsonValue]] = {
    "gatewayUrl": "http://127.0.0.1:1",
    "identity": {"issuer": "http://127.0.0.1:1/realms/semiont"},
    "agents": [
        {
            "agent": {"provider": "anthropic", "model": "claude-test"},
            "accepts": [{"jobType": "yield"}],
            "baseUrl": "http://127.0.0.1:1",
            "apiKeyEnv": "FIRST_KEY",
        },
        {
            "agent": {"provider": "ollama", "model": "gemma2:27b"},
            "accepts": [{"jobType": "mark", "params": {"motivation": "highlighting"}}],
            "baseUrl": "http://127.0.0.1:1",
        },
        {
            "agent": {"provider": "anthropic", "model": "claude-other"},
            "accepts": [{"jobType": "mark", "params": {"motivation": "linking"}}],
            "baseUrl": "http://127.0.0.1:1",
            "apiKeyEnv": "SECOND_KEY",
        },
    ],
    "modelCatalogue": "/usr/share/semiont/model-catalogue.json",
    "port": 24100,
    "logLevel": "warn",
    "logFormat": "simple",
}


def written(tmp_path: Path, document: object = DOCUMENT) -> str:
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


def of_one_agent(provider: str, model: str, **stated: JsonValue) -> dict[str, JsonValue]:
    """The document, with one agent of this provider and model at an address, and over that whatever a test states of the document."""
    agent: dict[str, JsonValue] = {
        "agent": {"provider": provider, "model": model},
        "accepts": [{"jobType": "yield"}],
        "baseUrl": "http://127.0.0.1:1/v1",
    }
    return {**DOCUMENT, "agents": [agent], **stated}


@pytest.mark.usefixtures("unconfigured")
def test_a_provider_that_takes_a_key_is_refused_by_the_member_where_its_agent_names_no_variable_for_one(tmp_path: Path) -> None:
    said = refusal(["--config", written(tmp_path, of_one_agent("anthropic", "claude-test"))], dict(ACCOUNT))
    assert said == (
        "agents[0].apiKeyEnv is not stated, and agents[0].agent.provider is anthropic: "
        "api_key is required for the Anthropic inference client"
    )


@pytest.mark.usefixtures("unconfigured")
def test_a_server_a_deployment_runs_boots_with_no_key_and_its_catalogue_is_not_read(tmp_path: Path) -> None:
    # The document names a catalogue file that is not there, as every document here does: nothing reads it.
    for provider in ("vllm", "llamacpp"):
        started = boot(["--config", written(tmp_path, of_one_agent(provider, "a-model"))], dict(ACCOUNT))
        assert [(client.provider, client.model_id) for client in started.clients] == [(provider, "a-model")]


@pytest.mark.usefixtures("unconfigured")
def test_a_provider_whose_facts_are_a_catalogue_s_boots_with_them_and_is_refused_by_the_member_without(tmp_path: Path) -> None:
    catalogue = tmp_path / "model-catalogue.json"
    catalogue.write_text(json.dumps(CATALOGUE), encoding="utf-8")
    keyed = {**ACCOUNT, "OPENAI_KEY": "sk-test"}

    def stating(model: str, **stated: JsonValue) -> str:
        document = of_one_agent("openai", model, **stated)
        agents = document["agents"]
        assert isinstance(agents, list)
        (agent,) = agents
        assert isinstance(agent, dict)
        agent["apiKeyEnv"] = "OPENAI_KEY"
        return written(tmp_path, document)

    unlisted = refusal(["--config", stating("gpt-unlisted", modelCatalogue=str(catalogue))], keyed)
    assert unlisted.startswith(f"modelCatalogue names {catalogue}, which does not serve agents[0]: ")
    assert unlisted.endswith("states nothing of the model gpt-unlisted of the provider openai")
    nowhere = tmp_path / "none.json"
    absent = refusal(["--config", stating("gpt-listed", modelCatalogue=str(nowhere))], keyed)
    assert absent.startswith(f"modelCatalogue names {nowhere}, which does not serve agents[0]: the model catalogue cannot be read: ")

    started = boot(["--config", stating("gpt-listed", modelCatalogue=str(catalogue))], keyed)
    assert [(client.provider, client.model_id) for client in started.clients] == [("openai", "gpt-listed")]


@pytest.mark.usefixtures("unconfigured")
def test_everything_it_is_started_with_is_read_at_boot_a_client_for_each_agent_in_the_document_s_order(tmp_path: Path) -> None:
    started = boot(["--config", written(tmp_path)], {**ACCOUNT, "FIRST_KEY": "sk-first", "SECOND_KEY": "sk-second", "UNREAD": "x"})
    assert (started.credential.issuer, started.credential.client_id) == ("http://127.0.0.1:1/realms/semiont", "semiont-worker")
    assert started.credential.private_key.private_numbers() == KEY.private_numbers()
    assert [(client.provider, client.model_id) for client in started.clients] == [
        ("anthropic", "claude-test"),
        ("ollama", "gemma2:27b"),
        ("anthropic", "claude-other"),
    ]
    assert started.config.port == 24100


@pytest.mark.usefixtures("unconfigured")
def test_the_document_is_refused_before_the_account_the_account_before_a_key_and_the_keys_in_the_order_of_their_agents(
    tmp_path: Path,
) -> None:
    keys = {"FIRST_KEY": "sk-first", "SECOND_KEY": "sk-second"}
    path = written(tmp_path)
    # Nothing it needs is there: the first thing said is that no document is named.
    assert refusal([], {}) == "The worker's configuration document is not named: start it with --config <path>"
    # A document that is refused, with no account either: the document is said.
    broken = written(tmp_path / "..", {**DOCUMENT, "port": "24100"})
    assert refusal(["--config", broken], {}).startswith(f"{broken} is not a worker configuration document (WorkerConfig):")
    # The account, its id before its own key, and before any provider's key. A secret is no account of a worker's.
    assert refusal(["--config", path], {}).startswith("SEMIONT_OIDC_CLIENT_ID is not set")
    assert refusal(["--config", path], {"SEMIONT_OIDC_CLIENT_ID": "semiont-worker"}).startswith("SEMIONT_OIDC_CLIENT_KEY is not set")
    secret = {"SEMIONT_OIDC_CLIENT_ID": "semiont-worker", "SEMIONT_OIDC_CLIENT_SECRET": "s3cret"}
    assert refusal(["--config", path], secret).startswith("SEMIONT_OIDC_CLIENT_KEY is not set")
    # The providers' keys, the first agent's first.
    assert refusal(["--config", path], ACCOUNT).startswith("agents[0].apiKeyEnv names a variable")
    assert refusal(["--config", path], {**ACCOUNT, "FIRST_KEY": "sk-first"}).startswith("agents[2].apiKeyEnv names a variable")
    assert boot(["--config", path], {**ACCOUNT, **keys}).config.log_level == "warn"


@pytest.mark.usefixtures("unconfigured")
def test_from_boot_on_the_log_is_written_as_the_document_says(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    boot(["--config", written(tmp_path)], {**ACCOUNT, "FIRST_KEY": "sk-first", "SECOND_KEY": "sk-second"})
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
            {"SEMIONT_OIDC_CLIENT_KEY": PEM},
            "[fatal] SEMIONT_OIDC_CLIENT_ID is not set in the worker's environment: a worker signs in as a service account\n",
        ),
        (["--config", "<document>"], ACCOUNT, "[fatal] agents[0].apiKeyEnv names a variable that is not set in the worker's environment\n"),
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
    document = written(tmp_path)
    monkeypatch.setattr(sys, "argv", ["semiont_worker", *(document if argument == "<document>" else argument for argument in arguments)])
    monkeypatch.setattr(os, "environ", environment)
    assert main() == 1
    captured = capsys.readouterr()
    assert captured.err == said
    assert captured.out == ""
    assert PEM not in captured.err


@pytest.mark.usefixtures("unconfigured")
def test_a_document_the_schema_refuses_is_said_with_each_reason_on_a_line_of_its_own(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    lacking = {name: value for name, value in DOCUMENT.items() if name not in ("port", "identity")}
    document = written(tmp_path, lacking)
    monkeypatch.setattr(sys, "argv", ["semiont_worker", f"--config={document}"])
    monkeypatch.setattr(os, "environ", dict(ACCOUNT))
    assert main() == 1
    head, *reasons = capsys.readouterr().err.splitlines()
    assert head == f"[fatal] {document} is not a worker configuration document (WorkerConfig):"
    assert sorted(reasons) == ["  Missing required property: identity", "  Missing required property: port"]
