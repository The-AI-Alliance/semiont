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
from pydantic import JsonValue
from semiont.http import Credential

from semiont_worker.config import Refused
from semiont_worker.log import LOG
from semiont_worker.service import boot, main

ACCOUNT: Final = {"SEMIONT_OIDC_CLIENT_ID": "semiont-worker", "SEMIONT_OIDC_CLIENT_SECRET": "s3cret"}

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


@pytest.mark.usefixtures("unconfigured")
def test_everything_it_is_started_with_is_read_at_boot_a_client_for_each_agent_in_the_document_s_order(tmp_path: Path) -> None:
    started = boot(["--config", written(tmp_path)], {**ACCOUNT, "FIRST_KEY": "sk-first", "SECOND_KEY": "sk-second", "UNREAD": "x"})
    assert started.credential == Credential(issuer="http://127.0.0.1:1/realms/semiont", client_id="semiont-worker", client_secret="s3cret")
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
    # The account, its id before its secret, and before any key.
    assert refusal(["--config", path], {}).startswith("SEMIONT_OIDC_CLIENT_ID is not set")
    assert refusal(["--config", path], {"SEMIONT_OIDC_CLIENT_ID": "semiont-worker"}).startswith("SEMIONT_OIDC_CLIENT_SECRET is not set")
    # The keys, the first agent's first.
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
            {"SEMIONT_OIDC_CLIENT_SECRET": "s3cret"},
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
    assert "s3cret" not in captured.err


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
