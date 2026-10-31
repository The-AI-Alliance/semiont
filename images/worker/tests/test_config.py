"""What of the worker's configuration is the Worker's own: that it serves a knowledge base once, and each engine's key.

`docs/protocol/WORKER-SERVICE.md` § Configuration states each refusal, and
the worker service's conformance suite holds the words of each to a started
process. How the document is found, read and refused is every Python
service's, and is held where it is stated
(`packages/python/service/tests/test_config.py`). Here is what the document
names and the environment holds: a document of several knowledge bases, which
it refuses where two name one domain, an engine's key, and that a refusal
never repeats what the document gave as its variable's name or a domain.
"""

from typing import Final

import pytest
from pydantic import JsonValue
from semiont.types import WorkerConfig
from semiont_service.config import Refused

from semiont_worker.config import api_key_of, served_once

DOCUMENT_ENGINE: Final[dict[str, JsonValue]] = {
    "engine": {"provider": "ollama", "model": "m"},
    "jobs": [{"jobType": "yield"}],
    "baseUrl": "http://ollama",
}

FIRST: Final[dict[str, JsonValue]] = {
    "domain": "first.example",
    "gatewayUrl": "http://gateway:4000",
    "identity": {"issuer": "http://issuer:8080/realms/semiont", "clientId": "semiont-worker"},
    "engines": [
        {
            "engine": {"provider": "anthropic", "model": "claude-test"},
            "jobs": [{"jobType": "mark", "params": {"motivation": "highlighting"}}, {"jobType": "yield"}],
            "baseUrl": "https://api.anthropic.com",
            "apiKeyEnv": "ANTHROPIC_API_KEY",
        },
        DOCUMENT_ENGINE,
    ],
}

SECOND: Final[dict[str, JsonValue]] = {
    "domain": "second.example",
    "gatewayUrl": "https://second.example",
    "identity": {"issuer": "https://second.example/oauth", "clientId": "worker-of-a-participant"},
    "engines": [
        {
            "engine": {"provider": "anthropic", "model": "claude-other"},
            "jobs": [{"jobType": "mark", "params": {"motivation": "linking"}}],
            "baseUrl": "https://api.anthropic.com",
            "apiKeyEnv": "SECOND_KEY",
        }
    ],
}

DOCUMENT: Final[dict[str, JsonValue]] = {
    "knowledgeBases": [FIRST, SECOND],
    "modelCatalogue": "/usr/share/semiont/model-catalogue.json",
    "port": 24100,
    "logLevel": "info",
    "logFormat": "json",
}

SECRET: Final = "sk-conformance-0123456789abcdef"


def config(**members: JsonValue) -> WorkerConfig:
    return WorkerConfig.model_validate({**DOCUMENT, **members})


def test_a_document_names_each_knowledge_base_with_its_gateway_its_account_and_the_engines_it_is_offered() -> None:
    read = config()
    served_once(read)
    assert [
        (each.domain, each.gateway_url, each.identity.issuer, each.identity.client_id, [entry.engine.model for entry in each.engines])
        for each in read.knowledge_bases
    ] == [
        ("first.example", "http://gateway:4000", "http://issuer:8080/realms/semiont", "semiont-worker", ["claude-test", "m"]),
        ("second.example", "https://second.example", "https://second.example/oauth", "worker-of-a-participant", ["claude-other"]),
    ]


def test_two_knowledge_bases_that_name_one_domain_are_refused_by_their_places_and_the_domain_is_not_said() -> None:
    third = {**SECOND, "domain": "third.example"}
    cases: list[tuple[list[JsonValue], str]] = [
        ([FIRST, {**SECOND, "domain": "first.example"}], "knowledgeBases[1].domain is the domain of knowledgeBases[0]"),
        ([FIRST, third, {**FIRST, "gatewayUrl": "http://elsewhere"}], "knowledgeBases[2].domain is the domain of knowledgeBases[0]"),
        ([FIRST, third, {**SECOND, "domain": "third.example"}], "knowledgeBases[2].domain is the domain of knowledgeBases[1]"),
    ]
    for knowledge_bases, said in cases:
        with pytest.raises(Refused) as refused:
            served_once(config(knowledgeBases=knowledge_bases))
        assert str(refused.value) == f"{said}: a worker serves a knowledge base once"
        assert "example" not in str(refused.value)


def test_an_engine_s_key_is_the_value_of_the_variable_the_document_names_for_it_at_its_knowledge_base() -> None:
    environment = {"ANTHROPIC_API_KEY": "sk-held", "SECOND_KEY": "sk-second", "OTHER": "x"}
    assert api_key_of(config(), 0, 0, environment) == "sk-held"
    assert api_key_of(config(), 1, 0, environment) == "sk-second"


def test_an_engine_whose_provider_takes_no_key_has_none() -> None:
    assert api_key_of(config(), 0, 1, {"ANTHROPIC_API_KEY": "sk-held"}) is None


@pytest.mark.parametrize("environment", [{}, {"SECOND_KEY": ""}])
def test_a_variable_that_is_not_set_or_is_set_to_nothing_is_refused_by_the_member_that_named_it(environment: dict[str, str]) -> None:
    with pytest.raises(Refused) as refused:
        api_key_of(config(), 1, 0, environment)
    assert str(refused.value) == "knowledgeBases[1].engines[0].apiKeyEnv names a variable that is not set in the worker's environment"


def test_the_refusal_never_repeats_what_the_document_gave_as_the_variable_s_name() -> None:
    named = config(knowledgeBases=[{**FIRST, "engines": [{**DOCUMENT_ENGINE, "apiKeyEnv": SECRET}]}])
    with pytest.raises(Refused) as refused:
        api_key_of(named, 0, 0, {})
    assert SECRET not in str(refused.value)
