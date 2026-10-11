"""What of the worker's configuration is the Worker's own: each agent's key.

`docs/protocol/WORKER-SERVICE.md` § Configuration states each refusal, and
the worker service's conformance suite holds the words of each to a started
process. How the document is found, read and refused is every Python
service's, and is held where it is stated
(`packages/service-python/tests/test_config.py`). Here is what the document
names and the environment holds: an agent's key, and that a refusal never
repeats what the document gave as its variable's name.
"""

from typing import Final

import pytest
from pydantic import JsonValue
from semiont.types import WorkerConfig
from semiont_service.config import Refused

from semiont_worker.config import api_key_of

DOCUMENT_AGENT: Final[dict[str, JsonValue]] = {
    "agent": {"provider": "ollama", "model": "m"},
    "accepts": [{"jobType": "yield"}],
    "baseUrl": "http://ollama",
}

DOCUMENT: Final[dict[str, JsonValue]] = {
    "gatewayUrl": "http://gateway:4000",
    "identity": {"issuer": "http://issuer:8080/realms/semiont"},
    "agents": [
        {
            "agent": {"provider": "anthropic", "model": "claude-test"},
            "accepts": [{"jobType": "mark", "params": {"motivation": "highlighting"}}, {"jobType": "yield"}],
            "baseUrl": "https://api.anthropic.com",
            "apiKeyEnv": "ANTHROPIC_API_KEY",
        },
        DOCUMENT_AGENT,
    ],
    "port": 24100,
    "logLevel": "info",
    "logFormat": "json",
}

SECRET: Final = "sk-conformance-0123456789abcdef"


def config() -> WorkerConfig:
    return WorkerConfig.model_validate(DOCUMENT)


def test_an_agent_s_key_is_the_value_of_the_variable_the_document_names() -> None:
    assert api_key_of(config(), 0, {"ANTHROPIC_API_KEY": "sk-held", "OTHER": "x"}) == "sk-held"


def test_an_agent_whose_provider_takes_no_key_has_none() -> None:
    assert api_key_of(config(), 1, {"ANTHROPIC_API_KEY": "sk-held"}) is None


@pytest.mark.parametrize("environment", [{}, {"ANTHROPIC_API_KEY": ""}])
def test_a_variable_that_is_not_set_or_is_set_to_nothing_is_refused_by_the_member_that_named_it(environment: dict[str, str]) -> None:
    with pytest.raises(Refused) as refused:
        api_key_of(config(), 0, environment)
    assert str(refused.value) == "agents[0].apiKeyEnv names a variable that is not set in the worker's environment"


def test_the_refusal_never_repeats_what_the_document_gave_as_the_variable_s_name() -> None:
    named = WorkerConfig.model_validate({**DOCUMENT, "agents": [{**DOCUMENT_AGENT, "apiKeyEnv": SECRET}]})
    with pytest.raises(Refused) as refused:
        api_key_of(named, 0, {})
    assert SECRET not in str(refused.value)
