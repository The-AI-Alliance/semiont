"""A service's configuration document, and what its environment holds beside it.

§ Configuration of each service's page of `docs/protocol` states each
refusal, and that service's conformance suite holds the words of each to a
started process. Here is what a suite cannot reach: that the schema is held
as it is written, and that a refusal repeats nothing the document held. The
document read here is the Worker's, as an example: it is read as the shape it
is asked for, and refused in the words of the service it is read for.
"""

import json
from pathlib import Path
from typing import Final

import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec, rsa
from pydantic import JsonValue
from semiont.http import SecretCredential
from semiont.types import WeaverConfig, WorkerConfig

from semiont_service.config import Refused, config_path_of, key_account_of, read_config, service_account_of, set_in

DOCUMENT: Final[dict[str, JsonValue]] = {
    "gatewayUrl": "http://gateway:4000",
    "identity": {"issuer": "http://issuer:8080/realms/semiont"},
    "engines": [
        {
            "engine": {"provider": "anthropic", "model": "claude-test"},
            "jobs": [{"jobType": "mark", "params": {"motivation": "highlighting"}}, {"jobType": "yield"}],
            "baseUrl": "https://api.anthropic.com",
            "apiKeyEnv": "ANTHROPIC_API_KEY",
        },
        {"engine": {"provider": "ollama", "model": "gemma2:27b"}, "jobs": [{"jobType": "yield"}], "baseUrl": "http://ollama:11434"},
    ],
    "modelCatalogue": "/usr/share/semiont/model-catalogue.json",
    "port": 24100,
    "logLevel": "info",
    "logFormat": "json",
}


DOCUMENT_ENGINE: Final[dict[str, JsonValue]] = {
    "engine": {"provider": "ollama", "model": "m"},
    "jobs": [{"jobType": "yield"}],
    "baseUrl": "http://ollama",
}


def written(tmp_path: Path, document: object) -> str:
    """The path of a file holding `document`: as JSON, or as it is where it is text."""
    path = tmp_path / "worker.json"
    path.write_text(document if isinstance(document, str) else json.dumps(document), encoding="utf-8")
    return str(path)


def changed(**members: JsonValue) -> dict[str, JsonValue]:
    return {**DOCUMENT, **members}


def read(path: str) -> WorkerConfig:
    return read_config("worker", WorkerConfig, path)


def refusal_of(tmp_path: Path, document: object) -> str:
    with pytest.raises(Refused) as refused:
        read(written(tmp_path, document))
    return str(refused.value)


# ── where the document is ───────────────────────────────────────────────


def test_the_path_is_what_follows_the_flag_or_is_joined_to_it() -> None:
    assert config_path_of("worker", ["--config", "/etc/semiont/worker.json"]) == "/etc/semiont/worker.json"
    assert config_path_of("worker", ["--config=/etc/semiont/worker.json"]) == "/etc/semiont/worker.json"
    assert config_path_of("worker", ["--verbose", "--config", "worker.json", "--more"]) == "worker.json"


@pytest.mark.parametrize("arguments", [[], ["--config"], ["--config="], ["--config", ""], ["--config", "--other"], ["worker.json"]])
def test_a_path_that_is_not_named_is_refused_and_never_guessed(arguments: list[str]) -> None:
    with pytest.raises(Refused) as refused:
        config_path_of("worker", arguments)
    assert str(refused.value) == "The worker's configuration document is not named: start it with --config <path>"


def test_a_flag_with_no_path_does_not_hide_one_named_after_it() -> None:
    assert config_path_of("worker", ["--config=", "--config", "worker.json"]) == "worker.json"


# ── reading the document ────────────────────────────────────────────────


def test_the_document_is_read_as_the_protocol_s_shape(tmp_path: Path) -> None:
    config = read(written(tmp_path, DOCUMENT))
    assert config == WorkerConfig.model_validate(DOCUMENT)
    assert (config.gateway_url, config.port, config.log_level, config.log_format) == ("http://gateway:4000", 24100, "info", "json")
    assert [(entry.engine.provider, entry.engine.model, entry.api_key_env) for entry in config.engines] == [
        ("anthropic", "claude-test", "ANTHROPIC_API_KEY"),
        ("ollama", "gemma2:27b", None),
    ]


def test_a_path_that_names_no_file_is_refused_saying_where_it_looked_and_who_writes_the_document(tmp_path: Path) -> None:
    absent = str(tmp_path / "absent.json")
    with pytest.raises(Refused) as refused:
        read(absent)
    said = str(refused.value)
    assert said.startswith(f"Cannot read the worker's configuration document at {absent} (")
    assert said.endswith("). The launcher writes it; a worker started another way is given one (WorkerConfig in specs/).")


def test_what_is_not_json_is_refused_as_that_naming_the_file(tmp_path: Path) -> None:
    # A knowledge base's own config is TOML, and is not the worker's document.
    said = refusal_of(tmp_path, '[workers]\ndefault = "ollama"\n')
    path = str(tmp_path / "worker.json")
    assert said.startswith(f"{path} is not JSON: ")
    assert len(said) > len(f"{path} is not JSON: ")
    assert "ollama" not in said


def test_bytes_that_are_no_text_are_refused_as_not_json(tmp_path: Path) -> None:
    path = tmp_path / "worker.json"
    path.write_bytes(b"\xff\xfe\x00{")
    with pytest.raises(Refused) as refused:
        read(str(path))
    assert str(refused.value).startswith(f"{path} is not JSON: ")


@pytest.mark.parametrize(
    ("member", "document"),
    [
        ("gatewayUrl", {name: value for name, value in DOCUMENT.items() if name != "gatewayUrl"}),
        ("port", {name: value for name, value in DOCUMENT.items() if name != "port"}),
        ("issuer", changed(identity={})),
        ("jobs", changed(engines=[{"engine": {"provider": "ollama", "model": "m"}, "baseUrl": "http://ollama"}])),
        ("model", changed(engines=[{"engine": {"provider": "ollama"}, "jobs": [{"jobType": "yield"}], "baseUrl": "http://ollama"}])),
    ],
)
def test_a_member_the_document_lacks_is_named_on_a_line_of_its_own(tmp_path: Path, member: str, document: dict[str, JsonValue]) -> None:
    head, *reasons = refusal_of(tmp_path, document).split("\n")
    assert head == f"{tmp_path / 'worker.json'} is not a worker configuration document (WorkerConfig):"
    assert f"  Missing required property: {member}" in reasons
    assert all(reason.startswith("  ") for reason in reasons)


def test_every_reason_is_said_and_not_the_first_alone(tmp_path: Path) -> None:
    lacking = {name: value for name, value in DOCUMENT.items() if name not in ("port", "logLevel")}
    reasons = refusal_of(tmp_path, {**lacking, "dispatcherUrl": "http://dispatcher"}).split("\n")[1:]
    assert sorted(reasons) == [
        "  Missing required property: logLevel",
        "  Missing required property: port",
        "  root: unknown property dispatcherUrl",
    ]


def test_a_member_is_known_by_the_name_the_document_gives_it_and_by_no_other(tmp_path: Path) -> None:
    # The SDK's shapes are built in Python by Python's names. A document is held to the wire's.
    renamed = {("gateway_url" if name == "gatewayUrl" else name): value for name, value in DOCUMENT.items()}
    reasons = refusal_of(tmp_path, renamed).split("\n")[1:]
    assert reasons == ["  Missing required property: gatewayUrl"]


@pytest.mark.parametrize(
    ("document", "member"),
    [
        (changed(port="24100"), "port"),
        (changed(port=24100.5), "port"),
        (changed(port=True), "port"),
        (changed(port=0), "port"),
        (changed(port=70000), "port"),
        (changed(gatewayUrl=""), "gatewayUrl"),
        (changed(gatewayUrl=4000), "gatewayUrl"),
        (changed(logLevel="verbose"), "logLevel"),
        (changed(logFormat="pretty"), "logFormat"),
        (changed(engines=[]), "engines"),
        (changed(engines={}), "engines"),
        (changed(identity="http://issuer"), "identity"),
    ],
)
def test_a_value_that_is_not_the_kind_the_schema_states_is_refused_naming_its_member(
    tmp_path: Path, document: dict[str, JsonValue], member: str
) -> None:
    reasons = refusal_of(tmp_path, document).split("\n")[1:]
    assert len(reasons) == 1
    assert reasons[0].startswith(f"  {member}: ")


def test_a_member_inside_an_engine_is_named_by_its_place_in_the_document(tmp_path: Path) -> None:
    second: dict[str, JsonValue] = {**DOCUMENT_ENGINE, "jobs": [], "apiKey": "hunter2-not-a-name"}
    reasons = refusal_of(tmp_path, changed(engines=[DOCUMENT_ENGINE, second])).split("\n")[1:]
    assert sorted(reason.split(": ", 1)[0] for reason in reasons) == ["  engines[1]", "  engines[1].jobs"]
    assert "  engines[1]: unknown property apiKey" in reasons


SECRET: Final = "sk-conformance-0123456789abcdef"


@pytest.mark.parametrize(
    "document",
    [
        # A key written where a member the schema does not have was invented for it.
        changed(engines=[{**DOCUMENT_ENGINE, "apiKey": SECRET}]),
        # A value of every wrong kind, each of them the secret.
        changed(port=SECRET),
        changed(logLevel=SECRET),
        changed(logFormat=SECRET),
        changed(identity=SECRET),
        changed(engines=SECRET),
        changed(engines=[SECRET]),
        changed(engines=[{"engine": {"provider": SECRET, "model": "m"}, "jobs": [{"jobType": "yield"}], "baseUrl": "http://ollama"}]),
        changed(engines=[{"engine": {"provider": "ollama", "model": "m"}, "jobs": [{"jobType": SECRET}], "baseUrl": "http://ollama"}]),
        changed(
            engines=[
                {
                    "engine": {"provider": "ollama", "model": "m"},
                    "jobs": [{"jobType": "mark", "params": {"motivation": SECRET}}],
                    "baseUrl": "http://ollama",
                }
            ]
        ),
        {SECRET: SECRET, **DOCUMENT},
    ],
)
def test_no_refusal_repeats_a_value_the_document_held(tmp_path: Path, document: dict[str, JsonValue]) -> None:
    said = refusal_of(tmp_path, document)
    held_only_as_a_members_name = said.replace(f"unknown property {SECRET}", "")
    assert SECRET not in held_only_as_a_members_name


def test_a_filter_that_states_no_job_type_the_protocol_has_is_refused_by_what_was_expected(tmp_path: Path) -> None:
    engine: dict[str, JsonValue] = {**DOCUMENT_ENGINE, "jobs": [{"jobType": "smelt"}]}
    (reason,) = refusal_of(tmp_path, changed(engines=[engine])).split("\n")[1:]
    assert reason.startswith("  engines[0].jobs[0]: ")
    assert "smelt" not in reason


# ── read for another service, and as another shape ──────────────────────


def test_a_refusal_is_worded_for_the_service_and_the_shape_the_document_was_read_as(tmp_path: Path) -> None:
    with pytest.raises(Refused) as unnamed:
        config_path_of("weaver", [])
    assert str(unnamed.value) == "The weaver's configuration document is not named: start it with --config <path>"

    absent = str(tmp_path / "absent.json")
    with pytest.raises(Refused) as unread:
        read_config("weaver", WeaverConfig, absent)
    assert str(unread.value).startswith(f"Cannot read the weaver's configuration document at {absent} (")
    assert str(unread.value).endswith("). The launcher writes it; a weaver started another way is given one (WeaverConfig in specs/).")

    # The Worker's document is no Weaver's.
    path = written(tmp_path, DOCUMENT)
    with pytest.raises(Refused) as refused:
        read_config("weaver", WeaverConfig, path)
    assert str(refused.value).split("\n")[0] == f"{path} is not a weaver configuration document (WeaverConfig):"


# ── what the environment holds beside the document ──────────────────────

ISSUER: Final = "http://issuer:8080/realms/semiont"


def test_the_service_account_is_the_two_variables_every_service_signs_in_with() -> None:
    environment = {"SEMIONT_OIDC_CLIENT_ID": "semiont-worker", "SEMIONT_OIDC_CLIENT_SECRET": "s3cret"}
    assert service_account_of("worker", ISSUER, environment) == SecretCredential(
        issuer="http://issuer:8080/realms/semiont", client_id="semiont-worker", client_secret="s3cret"
    )


@pytest.mark.parametrize("variable", ["SEMIONT_OIDC_CLIENT_ID", "SEMIONT_OIDC_CLIENT_SECRET"])
@pytest.mark.parametrize("left", ["unset", "empty"])
def test_either_variable_of_the_account_unset_or_empty_is_refused_by_name_and_the_secret_is_not_said(variable: str, left: str) -> None:
    environment = {"SEMIONT_OIDC_CLIENT_ID": "semiont-worker", "SEMIONT_OIDC_CLIENT_SECRET": "s3cret"}
    if left == "unset":
        del environment[variable]
    else:
        environment[variable] = ""
    with pytest.raises(Refused) as refused:
        service_account_of("worker", ISSUER, environment)
    assert str(refused.value) == f"{variable} is not set in the worker's environment: a worker signs in as a service account"
    assert "s3cret" not in str(refused.value)


def _pem(key: rsa.RSAPrivateKey | ec.EllipticCurvePrivateKey, encryption: serialization.KeySerializationEncryption | None = None) -> str:
    return key.private_bytes(
        serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, encryption or serialization.NoEncryption()
    ).decode()


_KEY: Final = rsa.generate_private_key(public_exponent=65537, key_size=2048)


def test_a_key_account_is_the_client_id_and_the_rsa_key_its_variable_holds() -> None:
    environment = {"SEMIONT_OIDC_CLIENT_ID": "semiont-worker", "SEMIONT_OIDC_CLIENT_KEY": _pem(_KEY)}
    credential = key_account_of("worker", ISSUER, environment)
    assert (credential.issuer, credential.client_id) == (ISSUER, "semiont-worker")
    assert credential.private_key.private_numbers() == _KEY.private_numbers()
    assert _pem(_KEY) not in repr(credential)


@pytest.mark.parametrize("variable", ["SEMIONT_OIDC_CLIENT_ID", "SEMIONT_OIDC_CLIENT_KEY"])
@pytest.mark.parametrize("left", ["unset", "empty"])
def test_either_variable_of_a_key_account_unset_or_empty_is_refused_by_name(variable: str, left: str) -> None:
    environment = {"SEMIONT_OIDC_CLIENT_ID": "semiont-worker", "SEMIONT_OIDC_CLIENT_KEY": _pem(_KEY)}
    if left == "unset":
        del environment[variable]
    else:
        environment[variable] = ""
    with pytest.raises(Refused) as refused:
        key_account_of("worker", ISSUER, environment)
    assert str(refused.value) == f"{variable} is not set in the worker's environment: a worker signs in as a service account"


def test_a_secret_is_no_key_account() -> None:
    with pytest.raises(Refused, match=r"^SEMIONT_OIDC_CLIENT_KEY is not set in the worker's environment"):
        key_account_of("worker", ISSUER, {"SEMIONT_OIDC_CLIENT_ID": "semiont-worker", "SEMIONT_OIDC_CLIENT_SECRET": "s3cret"})


@pytest.mark.parametrize(
    ("held", "saying"),
    [
        ("not a key at all", "is not an unencrypted PEM private key"),
        (_pem(_KEY, serialization.BestAvailableEncryption(b"a passphrase")), "is not an unencrypted PEM private key"),
        (_pem(ec.generate_private_key(ec.SECP256R1())), "is not an RSA key: a worker signs its assertions with RS256"),
    ],
    ids=["not PEM", "encrypted", "not RSA"],
)
def test_a_key_that_is_not_an_unencrypted_rsa_key_is_refused_and_never_said(held: str, saying: str) -> None:
    with pytest.raises(Refused) as refused:
        key_account_of("worker", ISSUER, {"SEMIONT_OIDC_CLIENT_ID": "semiont-worker", "SEMIONT_OIDC_CLIENT_KEY": held})
    assert str(refused.value) == f"SEMIONT_OIDC_CLIENT_KEY in the worker's environment {saying}"
    assert held not in str(refused.value)
    assert refused.value.__cause__ is None


def test_a_variable_set_to_nothing_is_one_that_is_not_set() -> None:
    assert set_in({"A": "", "B": "b"}, "A") is None
    assert set_in({"A": "", "B": "b"}, "B") == "b"
    assert set_in({}, "A") is None
